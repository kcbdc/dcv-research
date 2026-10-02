import { safeJson } from './util.js';

// 1B 모델은 한국어 + JSON 구조 출력이 불안정하므로 기본 모델을 8B로 올리고,
// 실패 시 순서대로 다음 모델을 시도합니다.


const DEFAULT_CONTEXT_LIMIT = 24000;
const DEFAULT_CONTEXT_RESERVE = 1000;
const MIN_OUTPUT_TOKENS = 384;

// Workers AI의 5021(context window exceeded)을 요청 전에 피하기 위한 보수적 추정치입니다.
// 영문/숫자는 약 4자=1 token, 한글 등 비ASCII 문자는 약 1.5자=1 token으로 계산하고
// 메시지 framing 오버헤드를 별도로 더합니다. 실제 tokenizer보다 약간 넉넉하게 잡는 것이 목적입니다.
export function estimateTokens(text = '') {
  let ascii = 0, nonAscii = 0;
  for (const ch of String(text)) (ch.codePointAt(0) <= 0x7f ? ascii++ : nonAscii++);
  return Math.ceil(ascii / 4 + nonAscii / 1.5);
}

function messageTokens(systemText, userText) {
  return estimateTokens(systemText) + estimateTokens(userText) + 96;
}

function compactToTokenBudget(text, tokenBudget) {
  const src = String(text ?? '');
  if (tokenBudget <= 0) return '';
  if (estimateTokens(src) <= tokenBudget) return src;

  // JSON/구조화 사실의 앞부분(메타/정의)과 뒷부분(결론/검증)을 모두 보존합니다.
  const marker = '\n\n...[context compacted to fit Workers AI limit]...\n\n';
  const markerTokens = estimateTokens(marker);
  const contentBudget = Math.max(1, tokenBudget - markerTokens);
  const headBudget = Math.ceil(contentBudget * 0.62);
  const tailBudget = contentBudget - headBudget;

  const chars = Array.from(src);
  let head = '', headTokens = 0;
  for (const ch of chars) {
    const t = estimateTokens(ch);
    if (headTokens + t > headBudget) break;
    head += ch; headTokens += t;
  }
  let tail = '', tailTokens = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i], t = estimateTokens(ch);
    if (tailTokens + t > tailBudget) break;
    tail = ch + tail; tailTokens += t;
  }
  return head + marker + tail;
}

function contextSafeRequest(env, systemText, userText, requestedMaxTokens, opts = {}) {
  const contextLimit = Math.max(2048, Number(opts.contextLimit || env.AI_CONTEXT_LIMIT || DEFAULT_CONTEXT_LIMIT));
  const reserve = Math.max(256, Number(opts.contextReserve || env.AI_CONTEXT_RESERVE || DEFAULT_CONTEXT_RESERVE));
  const minOutput = Math.max(128, Number(opts.minOutputTokens || MIN_OUTPUT_TOKENS));
  const requested = Math.max(minOutput, Number(requestedMaxTokens || 1800));

  let user = String(userText ?? '');
  let inputTokens = messageTokens(systemText, user);
  let available = contextLimit - reserve - inputTokens;
  let compacted = false;

  // 입력 자체가 너무 길 때만 축약합니다. 출력 여유가 조금이라도 있으면 우선 max_tokens만 줄입니다.
  if (available < minOutput) {
    const systemTokens = estimateTokens(systemText) + 96;
    const userBudget = Math.max(256, contextLimit - reserve - minOutput - systemTokens);
    const next = compactToTokenBudget(user, userBudget);
    compacted = next !== user;
    user = next;
    inputTokens = messageTokens(systemText, user);
    available = contextLimit - reserve - inputTokens;
  }

  if (available < 128) {
    return { ok: false, reason: `AI 입력이 컨텍스트 한도(${contextLimit})에 너무 가까워 안전한 출력 공간을 확보할 수 없음`, contextLimit, inputTokens, compacted };
  }

  return {
    ok: true,
    user,
    maxTokens: Math.max(128, Math.min(requested, Math.floor(available))),
    contextLimit,
    inputTokens,
    compacted
  };
}

function isContextLimitError(error) {
  const msg = String(error?.message || error || '');
  return error?.code === 'AI_CONTEXT_LIMIT' || Number(error?.cfCode) === 5021 || /(?:\b5021\b|context window|context.*limit|maximum.*tokens|exceeded.*tokens)/i.test(msg);
}
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
  const systemText = `${system}

Return ONLY one valid JSON object. No markdown, no commentary.${schemaHint ? `
The JSON object MUST have exactly this shape:
${schemaHint}` : ''}`;
  const prepared = contextSafeRequest(env, systemText, user, opts.maxTokens || 1800, opts);
  if (!prepared.ok) {
    return { ...fallback, _ai: { ok: false, error: prepared.reason, code: 'AI_CONTEXT_LIMIT_PREVENTED', input_tokens_estimate: prepared.inputTokens, context_limit: prepared.contextLimit } };
  }

  for (const model of modelChain(env)) {
    try {
      const out = await env.AI.run(model, {
        messages: [
          { role: 'system', content: systemText },
          { role: 'user', content: prepared.user }
        ],
        max_tokens: prepared.maxTokens,
        temperature: 0.15
      });
      const parsed = extractJson(pickText(out));
      if (parsed) {
        if (opts.required && !opts.required.some(k => parsed[k] != null && parsed[k] !== '')) {
          errors.push(`${model}: 필수 키 누락`);
          continue;
        }
        return { ...fallback, ...parsed, _ai: { ok: true, model, max_tokens: prepared.maxTokens, input_tokens_estimate: prepared.inputTokens, context_compacted: prepared.compacted } };
      }
      errors.push(`${model}: JSON 파싱 실패`);
    } catch (e) {
      errors.push(`${model}: ${String(e?.message || e).slice(0, 240)}`);
      // 5021은 같은 프롬프트로 모델만 바꿔도 반복될 가능성이 높다. 사전 예산 계산을 통과했는데도
      // 실제 tokenizer가 더 크게 계산한 경우이므로 즉시 규칙 기반으로 전환한다.
      if (isContextLimitError(e)) break;
      // 429는 대개 계정/계정+모델 단위 제한이다. 즉시 다른 모델을 연속 호출하면
      // 같은 제한 창에서 요청만 늘어나므로, REST 래퍼의 제한적 재시도 후 바로 규칙 기반으로 전환한다.
      if (Number(e?.status) === 429 || e?.code === 'AI_RATE_LIMITED' || /\b429\b/.test(String(e?.message || ''))) break;
    }
  }
  return { ...fallback, _ai: { ok: false, error: errors.join(' | '), max_tokens: prepared.maxTokens, input_tokens_estimate: prepared.inputTokens, context_compacted: prepared.compacted } };
}
