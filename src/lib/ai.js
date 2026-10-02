import { safeJson } from './util.js';

// 1B 모델은 한국어 + JSON 구조 출력이 불안정하므로 기본 모델을 8B로 올리고,
// 실패 시 순서대로 다음 모델을 시도합니다.
const DEFAULT_MODELS = [
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3.2-3b-instruct'
];

function modelChain(env) {
  const list = [];
  if (env.AI_MODEL) list.push(env.AI_MODEL);
  for (const m of DEFAULT_MODELS) if (!list.includes(m)) list.push(m);
  // 1B는 구조화 출력이 자주 깨지므로 체인에서 제외
  return list.filter(m => !/llama-3\.2-1b/i.test(m) || list.length === 1);
}

// 잘린 JSON(토큰 한도 초과)도 최대한 복구합니다.
function repairJson(s) {
  let out = '', stack = [], inStr = false, esc = false;
  for (const ch of s) {
    out += ch;
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, '');
  while (stack.length) out += stack.pop();
  return out;
}

export function extractJson(text) {
  if (text && typeof text === 'object') return text;
  if (typeof text !== 'string') return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  if (start < 0) return null;
  const end = candidate.lastIndexOf('}');
  candidate = end > start ? candidate.slice(start, end + 1) : candidate.slice(start);
  let parsed = safeJson(candidate, null);
  if (!parsed || typeof parsed !== 'object') parsed = safeJson(repairJson(candidate), null);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

function pickText(out) {
  if (out == null) return null;
  if (typeof out === 'string') return out;
  const r = out.response ?? out.result?.response ?? out.choices?.[0]?.message?.content ?? out.output_text;
  return r ?? null;
}

/**
 * Workers AI로 JSON을 생성합니다.
 * 반환: { ...json, _ai: { ok, model, error } }  (실패 시 fallback + _ai.ok=false)
 * @param schemaHint  모델에게 보여줄 JSON 키 구조 설명 (예: {"abstract":"string",...})
 */
export async function aiJson(env, system, user, fallback, opts = {}) {
  if (!env.AI) return { ...fallback, _ai: { ok: false, error: 'AI binding 없음 (wrangler.jsonc의 "ai" 바인딩 확인)' } };
  const schemaHint = opts.schemaHint || '';
  const errors = [];
  for (const model of modelChain(env)) {
    try {
      const out = await env.AI.run(model, {
        messages: [
          { role: 'system', content: `${system}\n\nReturn ONLY one valid JSON object. No markdown, no commentary.${schemaHint ? `\nThe JSON object MUST have exactly this shape:\n${schemaHint}` : ''}` },
          { role: 'user', content: user }
        ],
        max_tokens: opts.maxTokens || 1800,
        temperature: 0.15
      });
      const parsed = extractJson(pickText(out));
      if (parsed) {
        if (opts.required && !opts.required.some(k => parsed[k] != null && parsed[k] !== '')) {
          errors.push(`${model}: 필수 키 누락`);
          continue;
        }
        return { ...fallback, ...parsed, _ai: { ok: true, model } };
      }
      errors.push(`${model}: JSON 파싱 실패`);
    } catch (e) {
      errors.push(`${model}: ${String(e?.message || e).slice(0, 200)}`);
      // 429는 대개 계정/계정+모델 단위 제한이다. 즉시 다른 모델을 연속 호출하면
      // 같은 제한 창에서 요청만 늘어나므로, REST 래퍼의 제한적 재시도 후 바로 규칙 기반으로 전환한다.
      if (Number(e?.status) === 429 || e?.code === 'AI_RATE_LIMITED' || /\b429\b/.test(String(e?.message || ''))) break;
    }
  }
  return { ...fallback, _ai: { ok: false, error: errors.join(' | ') } };
}
