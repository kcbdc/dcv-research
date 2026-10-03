import { one, run, audit } from './db.js';
import { aiJson } from './ai.js';
import { nowIso, uid } from './util.js';
import { buildThesisData } from './thesis.js';
import { figureCatalog } from '../../public/figures.js';
import { buildModelSection, MODEL_MARKER } from '../../public/model.js';

const f = (v, d = 3) => (v == null || v === '' || !Number.isFinite(Number(v))) ? '-' : Number(v).toFixed(d);
const pct = (v, d = 1) => (v == null || !Number.isFinite(Number(v))) ? '-' : `${(Number(v) * 100).toFixed(d)}%`;
const cip = o => (!o || !o.n) ? '-' : `${pct(o.p)} [${pct(o.lo)}, ${pct(o.hi)}] (${o.k}/${o.n})`;
const cleanTex = s => String(s ?? '').replace(/\\\((.*?)\\\)/g, '$1').replace(/\\sigma/g, 'σ').replace(/\\alpha/g, 'α').replace(/\\tau/g, 'τ').replace(/\\delta/g, 'δ').replace(/\\([A-Za-z]+)/g, '$1');
const cell = v => String(v ?? '-').replace(/\|/g, '/').replace(/\n/g, ' ');
const mdTable = (head, rows) => `| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|\n${rows.map(r => `| ${r.map(cell).join(' | ')} |`).join('\n')}`;
const arr = v => Array.isArray(v) ? v.map(x => typeof x === 'string' ? x : JSON.stringify(x)).filter(Boolean) : (v ? [String(v)] : []);
const EST = { ema: 'EMA', kalman: 'Kalman', changepoint: 'Change-point', adaptive: 'Adaptive' };
const estName = e => EST[e] || e;

export function checklist(t) {
  const items = [], rv = t.reviewer, pn = t.empirical.panel, c = t.candidates, lc=t.empirical.loss_calibration;
  const minP=Number(t.definition.content?.validation?.min_human_participants||30);
  if (rv.participants < minP) items.push(`현재 인간실험 규약의 참가자가 ${rv.participants}명으로 사전 기준 ${minP}명에 미달합니다${rv.cumulative_participants!=null?`(누적 ${rv.cumulative_participants}명)`:''}. 반복 trial 수가 많아도 참가자 수를 대체하지 못합니다.`);
  if (!rv.cluster_bootstrap?.B) items.push('반복측정 인간실험의 참가자-군집 bootstrap 불확실성 추정이 아직 없습니다.');
  if (pn.n && pn.estimated / pn.n > 0.5) items.push(`위기 사례 ${pn.n}건 중 reconstructed 자료가 ${pn.estimated}건(${pct(pn.estimated / pn.n, 0)})입니다. 결과는 이 재구성 규칙에 조건부임을 본문과 표에 유지하십시오.`);
  if (t.empirical.readiness !== 'FULL_EPISODE_PANEL') items.push(`실증 패널이 완전하지 않습니다(${t.empirical.complete_rows}/${t.empirical.target_rows}).`);
  if(c.by_class.unevaluated)items.push(`미평가 후보 ${c.by_class.unevaluated}개: 연산 완료 전 진행 보고서이며 최종 연구결과가 아닙니다.`);
  if (!c.by_class.confirmed) items.push(c.by_class.unevaluated===c.total && c.total>0?'모든 후보가 미평가입니다. CONFIRMED 0은 제약 위반의 결과가 아니라 계산 대기 상태입니다. Actions의 compute_candidate 실행 및 저장 결과를 확인해야 합니다.':'CONFIRMED 후보가 없습니다. 계산된 후보의 제약별 판정과 미평가·보류 수를 먼저 확인하십시오.');
  if (!t.reproducibility.protocol?.hash) items.push('확증 분석 전에 동결된 연구 프로토콜 해시가 없습니다.');
  if (lc?.identification_status==='PROXY_ONLY') items.push('FP/FN 비용은 직접 관측된 사회적 비용이 아니라 peak-outflow 기반 경험적 proxy입니다. 직접 비용 추정치로 표현하지 마십시오.');
  if (t.approval?.decision==='COMPUTATIONALLY_CONFIRMED') items.push('플랫폼의 자동 판정은 계산적 확인(COMPUTATIONALLY_CONFIRMED)입니다. 최종 학술적 승인에는 PI/심사자 수동 sign-off가 필요합니다.');
  items.push('위임 가능 영역은 명시된 제약·시나리오·설계공간에 조건부인 결과입니다. 인과효과나 보편적 정책 임계값으로 확대 해석하지 마십시오.');
  items.push('AI가 작성한 문장(요약·논의)은 초안입니다. 수치는 표와 D1 실행기록을 기준으로 직접 대조하십시오.');
  return items;
}

function factsForNarrative(t) {
  const c = t.candidates, b = t.selected || {}, rv = t.reviewer;
  return {
    research_question: cleanTex(t.definition.research_question),
    candidates_total: c.total, by_class: c.by_class,
    best_estimator_by_share: [...c.estimators].sort((a, b2) => (b2.share ?? 0) - (a.share ?? 0))[0]?.estimator ?? null,
    estimator_shares: c.estimators.map(e => ({ estimator: e.estimator, share: e.share })),
    decision: t.approval?.decision ?? null, evidence_level: t.approval?.evidence_level ?? null,
    selected: t.selected ? { estimator: b.estimator, sigma: b.sigma, tau: b.tau, alpha: b.alpha, K: b.K, d: b.d, W: b.W, m: b.m, max_regret: b.max_regret, boundary_score: b.boundary_score } : null,
    constraints: t.constraints,
    reviewer: { n: rv.n, participants: rv.participants, arr: rv.arr.p, false_accept: rv.false_accept.p, correct_override: rv.correct_override.p },
    empirical: { rows: t.empirical.panel.n, verified: t.empirical.panel.verified, estimated: t.empirical.panel.estimated, readiness: t.empirical.readiness }
  };
}

function fallbackNarrative(t) {
  const c = t.candidates, b = t.selected, rv = t.reviewer, top = [...c.estimators].sort((a, x) => (x.share ?? 0) - (a.share ?? 0))[0];
  const decision = t.approval?.decision || '미확정';
  const abstract = `본 보고서는 ${cleanTex(t.project.name)}에 대한 CDRS 실행 결과를 요약한다. 설계 후보 ${c.total}개 중 ${c.by_class.confirmed || 0}개(${pct(c.total ? (c.by_class.confirmed || 0) / c.total : 0)})가 모든 제약을 통과해 위임 가능으로 확인되었고, 최종 판정은 ${decision}(Evidence Level ${t.approval?.evidence_level ?? '-'})이다.${b ? ` 선택된 설계는 추정기 ${estName(b.estimator)}, σ=${b.sigma}, α=${b.alpha}, K=${b.K}, d=${b.d}이며 Minimax Regret은 ${f(b.max_regret, 4)}이다.` : ''}${rv.n ? ` 인간 검토자 ${rv.n}건(참가자 ${rv.participants}명)에서 적정 의존율은 ${pct(rv.arr.p)}로 추정되었다.` : ''}`;
  const discussion = [
    top?.share > 0 ? `추정기별로는 ${estName(top.estimator)}의 위임 가능 비율이 ${pct(top.share)}로 가장 높았다(표 6). 다만 후보 수가 추정기마다 제한적이므로 신뢰구간의 폭을 함께 고려해야 한다.` : '',
    `현재 τ 수준은 ${[...new Set(c.list.map(x=>x.tau))].join(', ')}, d 수준은 ${[...new Set(c.list.map(x=>x.d))].join(', ')}이다. 한 수준뿐이면 해당 지연의 효과와 상호작용은 식별할 수 없다. K0/K1은 정의상 전량 검토이므로 B 상한이 1 미만일 때의 탈락은 실증 발견이 아니다. 추정기별 주변 비율은 신뢰도 정의와 base 공변량 차이에 조건부이며, 동일 환경의 신뢰도 절제 결과와 교정오차를 함께 확인해야 한다.`,
    `σ와 α의 상호작용은 그림 1과 표 5에 나타난 바와 같이 정보오차가 커질수록 위임 가능 비율이 어떻게 달라지는지를 보여 준다.`,
    rv.n ? `인간 관측의 표본은 ${rv.participants}명으로, 30명 기준 ${rv.participants>=30?'충족':'미달'}이다. 기록에서 AI 오답 수용률은 AI 오답 수용률은 ${pct(rv.false_accept.p)}, 정정 개입률은 ${pct(rv.correct_override.p)}였다. 이 비율을 시뮬레이션에 실제 반영했는지는 현재 revision의 검토자 모델과 재계산 기록으로 확인해야 하며 관측 수만으로 반영을 주장하지 않는다.` : `누적 참가자 ${rv.cumulative_participants||0}명, 기록 ${rv.cumulative_trials||0}건은 보존되어 있다. 현재 인간실험 규약에 적합한 관측이 없어 인간 행동 보정은 대기 중이다.`
  ].filter(Boolean).join(' ');
  return { abstract, discussion, implications: [['COMPUTATIONALLY_CONFIRMED','SCIENTIFICALLY_APPROVED'].includes(decision) ? '제시된 제약과 검증 프로토콜 하에서 위임이 가능한 설계 영역이 존재함을 보였다.' : '현재 증거만으로는 위임 가능 영역을 확정하기 어렵다.', '설계 변수(σ, α, K, d)를 함께 조정해야 위임 경계를 설명할 수 있다.'], next_steps: ['실제 손실함수와 사례별 모수 보정으로 계산 엔진 교체', '검토자 표본 확대와 참가자 간 이질성 분석', '경계 근처 후보의 반복 시드 검증'] };
}

export function buildMarkdown(t, ai, sourceNote) {
  const c = t.candidates, b = t.selected, rv = t.reviewer, pn = t.empirical.panel, figs = figureCatalog(t), figLine = n => { const g = figs.find(x => x.n === n); return g ? `\n![그림 ${g.label || n}. ${g.title}](figures/${g.file}.png)\n\n*그림 ${g.label || n}. ${g.title}*\n` : ''; };
  const L = [];
  L.push(`# ${cleanTex(t.project.name)}`, '', `> 자동 생성 연구 보고서 · DCV Research Platform v${t.app_version} · 생성 ${t.generated_at} · 프로젝트 ${t.project.id}`, '');
  L.push('## 0. 요약', '', ai.abstract, '');
  L.push('## 논문 사용 전 점검 사항', '', ...checklist(t).map(x => `- ${x}`), '');
  L.push(...buildModelSection(t, { figLine, estName, clean: cleanTex }));

  L.push('## 2. 연구 질문과 설계', '', '### 2.1 연구 질문', '', cleanTex(t.definition.research_question) || '-', '');
  const d = t.design, dimRows = [['σ (정보오차)', d.sigma], ['τ (처리 지연)', d.tau], ['α (정보처리 강도)', d.alpha], ['K (위임 권한)', d.K], ['d (승인 지연)', d.d], ['W (복구규칙)', d.W], ['m (조정)', d.m], ['추정기', (d.estimators || []).map(estName)]].map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : '-']);
  L.push('### 2.2 설계공간', '', '**표 1. 후보 설계공간**', '', mdTable(['변수', '수준'], dimRows), '', `탐색 후보 수 상한: ${d.max_candidates ?? '-'}. 후보는 설계공간에서 결정적 시드(${t.reproducibility.design_seed})로 추출한 풀에서 maximin(최대 최소거리) 기준으로 선택했다.`, '');
  const cs = t.constraints;
  L.push('### 2.3 제약조건', '', '**표 2. 위임 가능 판정 제약조건**', '', mdTable(['제약', '값'], [['평균 손실 상한', cs.loss_max], ['손실 초과율 상한', cs.loss_exceed_max], ['정지 오판(FP: 정상지급 차단) 상한', cs.fp_max], ['정지 누락(FN: 부정지급·유출) 상한', cs.fn_max], ['검토 부담 상한', cs.review_burden_max], ['복구시간 상한', cs.recovery_time_max], ['신뢰수준', cs.confidence]]), '');
  const rp=t.reproducibility.protocol, inf=t.selected?.inference;
  L.push('### 2.4 확증 분석 프로토콜과 다중비교 통제', '', rp?`확증 계산 시작 전에 연구 프로토콜 v${rp.version}을 동결하였다. SHA-256: \`${rp.hash}\` (동결 ${rp.frozen_at}). 정의·설계공간·제약·통계적 판정규칙이 변경되면 기존 시뮬레이션을 그대로 재사용하지 않는다.`:'동결된 연구 프로토콜이 없습니다.', '', inf?`확증/강건 단계는 ${inf.method} 보정을 사용한다. family size=${inf.family_size}, 동시 검정 수=${inf.simultaneous_tests}, 임계 z=${f(inf.z_critical,3)}로 후보 탐색에 따른 선택 편향을 보수적으로 통제한다.`:'확증 단계의 다중비교 정보가 아직 없습니다.', '');

  L.push('## 3. 실증 보정 데이터', '');
  if (pn.n) {
    const ds = pn.descriptives, row = (k, n) => [n, f(ds[k]?.mean), f(ds[k]?.median), f(ds[k]?.min), f(ds[k]?.max)];
    L.push(`위기 사례 패널은 ${pn.year_min}~${pn.year_max}년 ${pn.n}건이며, 검증(verified) ${pn.verified}건, 추정(estimated) ${pn.estimated}건이다. 파산 사례 비율은 ${cip(pn.failed)}이다.`, '', '**표 3. 위기 사례 패널 기술통계**', '', mdTable(['변수', '평균', '중앙값', '최소', '최대'], [row('peak_outflow', '최대 유출률'), row('concentration', '예금 집중도'), row('digital_adoption', '디지털 이용도'), row('severity', '심각도')]), '', figLine(5));
  } else L.push('사례 패널이 아직 가져와지지 않았습니다.', '');
  if (t.empirical.parameters.length) L.push('**부록 표 A1. 실증 모수**', '', mdTable(['모수', '값', '하한', '상한', '역할', '출처 구분'], t.empirical.parameters.map(p => [p.parameter_key, f(p.value_num, 4), f(p.low_num, 4), f(p.high_num, 4), p.parameter_role, p.provenance_type])), '');
  const lc=t.empirical.loss_calibration; if(lc?.n) L.push(`### 3.2 ${lc.n}개 사례 기반 손실 proxy 보정`, '', `FP와 FN의 의미는 엔진 기준으로 통일한다. **FP는 정지 오판(정상지급 차단)**, **FN은 정지 누락(부정지급·유출 미차단)**이다. 다만 위기 패널은 실제 지급정지의 사회적·재정적 비용을 관측하지 않으므로 c_FP와 c_FN은 **직접 식별된 비용계수가 아니라 peak outflow로 경험적으로 고정한 proxy**다.`, '', '**표 3A. 경험적 손실함수 보정값**', '', mdTable(['항목','값','보정 근거'], [['패널',`${lc.n}건 (실패 ${lc.failures}, 비실패 ${lc.nonfailures})`,'위기 사례 패널'],['c_FP',f(lc.c_fp,6),`비실패 사례 평균 peak outflow proxy [${f(lc.c_fp_low,4)}, ${f(lc.c_fp_high,4)}]`],['c_FN',f(lc.c_fn,6),`실패 사례 평균 peak outflow proxy [${f(lc.c_fn_low,4)}, ${f(lc.c_fn_high,4)}]`],['q75',f(lc.q75_outflow,6),'peak outflow 75백분위'],['q95',f(lc.q95_outflow,6),'목적함수 손실 정규화 기준'],['검토비용 c_R',f(lc.review_cost,6),'c_FP / T'],['재조정비용 c_A',f(lc.adjustment_cost,6),'c_FN / T']]), '', `보정 상태: **${lc.status}** · 식별 상태: **${lc.identification_status||'-'}** · provenance: ${lc.provenance}. proxy 범위는 강건성 시나리오에서 별도로 변동시키며, 직접 비용 추정으로 해석하지 않는다. 횡단면 81개 사례로 식별할 수 없는 복구 EWMA 계수 등은 설계 파라미터로 유지한다.`, '');


  const cu=t.empirical.calibration_uncertainty;
  if(cu?.B) L.push('### 3.3 보정계수 불확실성 전파', '', `verified/estimated 층을 유지한 ${cu.B}회 bootstrap과 reconstructed episode의 문서화된 측정오차(peak outflow ±0.05, severity ±0.10)를 함께 반영했다. θ₂ bootstrap 5–95% 범위는 ${f(cu.theta2?.p05,4)}–${f(cu.theta2?.p95,4)}, 양(+)의 비율은 ${pct(cu.theta2?.positive_share)}이다. 대표 draw는 stress scenario에 투입해 보정오차가 위임 경계까지 전파되도록 했다.`, '');
  const fd=t.empirical.fdic;
  if(fd){
    L.push('### 3.4 FDIC 원자료 연결 및 독립 검증 공변량', '', `FDIC CERT 연결은 확정 ${fd.links?.confirmed||0}건, 검토대기 ${fd.links?.pending||0}건이다. Financials는 ${fd.financials?.rows||0}행/${fd.financials?.episodes||0}개 episode, SOD는 ${fd.sod?.rows||0}행/${fd.sod?.episodes||0}개 episode를 저장했고, state-market HHI 검증지표는 ${fd.market_metrics?.rows||0}건이다.`, '', '**표 3B. FDIC 연결 커버리지**', '', mdTable(['계층','행/건','episode','기간/비고'], [['CERT linkage',fd.links?.total||0,fd.links?.confirmed||0,'confirmed만 자동수집'],['Financials',fd.financials?.rows||0,fd.financials?.episodes||0,`${fd.financials?.first_date||'-'} ~ ${fd.financials?.last_date||'-'}`],['SOD',fd.sod?.rows||0,fd.sod?.episodes||0,`${fd.sod?.first_year||'-'} ~ ${fd.sod?.last_year||'-'}`],['SOD state HHI',fd.market_metrics?.rows||0,fd.market_metrics?.episodes||0,'FDIC-SOD-STATE-HHI-v1']]), '', '> FDIC 파생 Financials/SOD 값은 **독립 검증 공변량**으로 저장하며 기존 위기 패널의 concentration 또는 peak_outflow를 자동 대체하지 않는다. SOD state HHI는 시장 정의가 다른 별도 지표이므로, 원 논문의 C와 동일 변수로 간주하지 않는다.', '');
    const rr=fd.reverification, rrows=rr?.rows||[];
    if(rrows.length)L.push('### 3.5 미국 사례 FDIC discrepancy 및 재검증 우선순위', '', `FDIC-REVERIFY-v1은 패널 concentration과 FDIC state-market HHI의 절대 차이, 패널 peak_outflow와 FDIC Financials의 최대 분기 peak-to-trough 예금 drawdown 차이를 각각 표본 내 percentile로 변환한 뒤 가용 차원의 평균을 discrepancy score로 사용한다. reconstructed 여부는 점수 가중치가 아니라 동률 우선순위와 해석 근거로만 사용한다. 따라서 이 표는 **원자료 재검증 작업의 우선순위**이며 통계적 이상치 검정이나 자동 데이터 교체 규칙이 아니다.`, '', '**표 3C. FDIC 재검증 우선순위 상위 10건**', '', mdTable(['순위','Episode','연도','자료','우선순위','Score','C','FDIC HHI','|ΔC|','Peak outflow','FDIC drawdown','|ΔD|'], rrows.slice(0,10).map(x=>[x.rank_num??'-',x.episode_name,x.year,x.provenance_type,x.priority_level,f(x.discrepancy_score,3),f(x.original_concentration,3),f(x.fdic_hhi,3),f(x.concentration_gap,3),f(x.original_peak_outflow,3),f(x.fdic_peak_drawdown,3),f(x.deposit_gap,3)])), '', '> 비교 정의가 서로 완전히 같지 않으므로 큰 discrepancy는 “오류 확정”이 아니라 **원자료 재검증 필요 신호**로만 해석한다. concentration 비교는 시장 정의 차이, deposit dynamics 비교는 측정기간 차이를 포함한다.', '');
    const wbr=fd.reviews?.rows||[],wbs=fd.reviews?.summary||{};
    if(wbr.length)L.push('### 3.6 Episode Reverification Workbench 검토결과', '', `Workbench에서는 CRITICAL/HIGH episode를 대상으로 원 논문 값, FDIC Financials/SOD 원자료, discrepancy 원인 후보와 인간 검토 체크리스트를 함께 검토한다. 현재 검토 ${wbs.total||0}건 중 RESOLVED ${wbs.resolved||0}건, IN_REVIEW ${wbs.in_review||0}건, ESCALATED ${wbs.escalated||0}건이다. 완료된 검토는 증거 revision에 기록되며 원 패널 값을 자동 대체하지 않는다.`, '', '**표 3D. Workbench 검토 현황**', '', mdTable(['Episode','연도','우선순위','검토상태','원인','권고조치','Evidence'], wbr.slice(0,20).map(x=>[x.episode_name,x.year,x.priority_level,x.review_status,x.cause_code||'-',x.recommended_action||'-',x.evidence_revision?`r${x.evidence_revision}`:'-'])), '');
  }
  const os=t.empirical.official_sources; if(os?.sources?.length){ const rows=os.sources.map(x=>[x.case_layer,x.connector_id,x.data_role||'-',x.last_status||'not fetched',x.coverage?.rows||0,`${x.coverage?.first_period||'-'} ~ ${x.coverage?.last_period||'-'}`]); L.push('### 3.7 공식 외부데이터 계층 (Case A / Case B)', '', 'Case A는 BIS CPMI·ECB·ECOS를 이용해 지급결제 디지털화, 은행 복원력, 한국 거시·지급결제 환경을 보강한다. Case B는 열린재정·e나라도움을 별도 계층으로 유지하여 국고금·보조금 지급정지 연구의 외적 검증 기반으로 사용한다. 새/변경 관측만 Evidence Revision을 발생시키며, 각 소스의 정의가 기존 논문 변수를 자동 대체하지 않는다.', '', '**표 3E. 공식 외부데이터 연결현황**', '', mdTable(['Case','Connector','역할','상태','관측행','기간'],rows), '');
    const maps=os.mappings||[]; if(maps.length){const mr=maps.map(x=>[x.mapping_key,x.method_version,x.period??'-',r4(x.value_num),x.mapping_key==='D_CPMI'?'CDRS D 외부검증/스트레스':x.mapping_key==='R_ECB'?'Resilience→θ 외부검증/스트레스':'외부검증']);L.push('**표 3F. CDRS 외부검증 매핑**','',mdTable(['Mapping','방법','기준기간','값','CDRS 사용'],mr),'','BIS의 D_CPMI는 원 패널의 digital_adoption을 덮어쓰지 않고 stress 단계에서 대체 D 시나리오로 사용한다. ECB의 R_ECB는 LCR 100%와 CET1 4.5%의 규제 최소기준 대비 headroom을 이용해 산출하고, 사전에 선언된 θ 범위 안의 대체 resilience 시나리오로만 사용한다. 두 매핑 모두 level-only/component-only/equal-weight 민감도 시나리오를 함께 실행하여 단일 가중치 선택에 결론이 의존하는지 확인한다.','');}
    L.push('> 열린재정·e나라도움 공개 API는 재정·보조사업의 집행환경 및 사업현황을 제공하는 외부 공변량 계층이다. 공개자료만으로 개별 부정수급 여부나 지급정지 정답 라벨을 확보했다고 해석하지 않는다.', ''); }

  L.push('## 4. 시뮬레이션 결과', '', '### 4.1 실행 개요', '', '**표 4. 단계별 시뮬레이션 실행량**', '', mdTable(['단계', '실행 수', '에피소드 수', '결정 수'], t.simulation.phases.map(p => [p.phase, p.runs, p.episodes, p.decisions])), '');
  L.push('### 4.2 위임 가능 영역', '', `설계 후보 ${c.total}개 중 CONFIRMED ${c.by_class.confirmed || 0}개(${pct(c.total ? (c.by_class.confirmed || 0) / c.total : 0)}), UNEVALUATED ${c.by_class.unevaluated || 0}개, BOUNDARY ${c.by_class.boundary || 0}개, INFEASIBLE ${c.by_class.infeasible || 0}개${c.by_class.provisional ? `, 잠정 ${c.by_class.provisional}개` : ''}로 분류되었다.`, figLine(1));
  const lv = (k, n) => c.dims[k].map(e => [n, e.level, e.total, e.confirmed, cip(e)]);
  L.push('### 4.3 설계 변수별 위임 가능 비율', '', '**표 5. 변수 수준별 CONFIRMED 비율 (95% Wilson 구간)**', '', mdTable(['변수', '수준', '후보 수', 'CONFIRMED', '비율 [95% CI]'], [...lv('sigma', 'σ'), ...lv('tau', 'τ'), ...lv('alpha', 'α'), ...lv('K', 'K'), ...lv('d', 'd'), ...lv('W', 'W'), ...lv('m', 'm')]), '', '> 주의: 수준별 비율은 다른 변수를 통제하지 않은 주변(marginal) 비율이며 인과효과가 아니다.', '');
  L.push('### 4.4 추정기 비교', '', '**표 6. 추정기별 성능 (K2/K3 후보 평균; K0/K1 점검 기준선 제외)**', '', mdTable(['추정기', '후보 수', 'CONFIRMED', '비율 [95% CI]', '평균 손실', 'FP(정지 오판)', 'FN(정지 누락)', '검토부담', '복구시간'], c.estimators.map(e => [estName(e.estimator), e.total, e.confirmed, cip(e), f(e.loss_mean), f(e.fp_rate), f(e.fn_rate), f(e.review_burden), f(e.recovery_time)])), '', figLine(2));
  L.push('### 4.5 최종 후보군과 Minimax Regret', '', c.finalists.length ? `안전 제약을 통과한 후보 중 최대 후회가 가장 작은 상위 ${c.finalists.length}개를 표 7에 제시한다. 여기서 Minimax Regret은 Historical + Stress(Adversarial + BIS + ECB) 시나리오의 정규화 목적함수 기준이며 Human Recompute 결과는 이 regret 값 자체에 포함되지 않는다.` : 'CONFIRMED 후보가 없어 순위를 제시할 수 없다.', '');
  if (c.finalists.length) L.push('**표 7. 강건 후보 순위 (Minimax Regret 오름차순)**', '', mdTable(['순위', '추정기', 'σ', 'τ', 'α', 'K', 'd', 'W', 'm', 'Max Regret', 'Boundary'], c.finalists.map((x, i) => [i + 1, estName(x.estimator), x.sigma, x.tau, x.alpha, x.K, x.d, x.W, x.m, f(x.max_regret, 4), f(x.boundary_score)])), '', figLine(3));
  if (b) { const ph = Object.entries(b.by_phase); if (ph.length) L.push('### 4.6 선택 후보의 단계별 성능', '', '**표 8. 선택 후보 성능 (단계별)**', '', mdTable(['단계', 'n', '평균 손실', '손실 초과율', 'FP(정지 오판)', 'FN(정지 누락)', '검토부담', '복구시간', 'Regret'], ph.map(([k, v]) => [k, v.n, f(v.loss_mean, 4), f(v.loss_exceed_rate, 4), f(v.fp_rate, 4), f(v.fn_rate, 4), f(v.review_burden, 3), f(v.recovery_time, 3), f(v.regret, 4)])), ''); }

  if(t.simulation.constraint_diagnostics?.length)L.push('### 4.7 실제 활성 제약 (K2/K3 최신 주 실행)', '', mdTable(['제약','평가 수','통과','경계','위반'],t.simulation.constraint_diagnostics.map(q=>[q.metric,q.n,q.pass,q.boundary,q.fail])), '', 'K0/K1은 전량 검토 점검 기준선으로 분리한다. 제약 위반 0건은 안전의 일반적 증명이 아니며 선언한 상한과 표본 크기에 조건부이다.', '');
  L.push('## 5. 강건성 검증', '', `실제 실행에 저장된 고유 시나리오 키 ${t.simulation.scenarios?.total ?? 0}개(역사적 ${t.simulation.scenarios?.historical ?? 0}, 적대적 ${t.simulation.scenarios?.adversarial ?? 0}, BIS ${t.simulation.scenarios?.bis??0}, ECB ${t.simulation.scenarios?.ecb??0})를 집계했다. 등록 scenarios 테이블의 행 수와 실행 에피소드 수는 다른 단위다. 과거 실행에 시나리오 메타데이터가 없으면 이 집계는 불완전하며 실행량은 표 4를 확인해야 한다.`, '', '**표 9. 검증 결과 집계**', '', mdTable(['검증 유형', '판정', '건수'], t.simulation.validations.map(v => [v.validation_type, v.status, v.n])), '');
  L.push(`Human 집계는 현재 Evidence r${t.project.evidence_revision||0}의 후보 ${t.simulation.validation_revision_counts?.current_human||0}개 판정을 사용한다. 다른 revision의 human_recompute 기록 ${t.simulation.validation_revision_counts?.other_revision_human||0}건은 재검증 전까지 N/A에서 제외하지 않는다. 전체 validations CSV는 revision을 포함한다.`, '');
  const vm=t.validation_matrix; if(vm?.summary?.length){L.push('### 5.1 External Validation Matrix', '', '**생성 시점:** G3 Robust Validation 완료 후 Matrix/Funnel이 생성되며, G5 Recompute Confirmed 완료 시 Human 열까지 현재 Evidence Revision 기준으로 확정된다. G6 Scientific Sign-off는 추가 통계검증이 아니라 사람의 최종 학술 승인이다.', '', '각 후보가 Historical / Synthetic / Adversarial / BIS / ECB / Human 중 어느 검증층을 통과·보류·탈락했는지를 외부 검증 매트릭스로 요약한다. Synthetic은 독립 confirmation, Historical은 81개 패널, Adversarial은 비공식 stress 하위집합, BIS·ECB는 공식 외부검증 stress 하위집합, Human은 현재 evidence revision의 human recompute 결과를 사용한다.', '', '**표 9A. 검증층별 생존 현황 요약**', '', mdTable(['검증층','PASS','HOLD','FAIL','N/A','Coverage','PASS/관측'], vm.summary.map(x=>[x.stage,x.PASS,x.HOLD,x.FAIL,x.MISSING,pct(x.coverage),pct(x.survival_rate)])), '', '**표 9B. 대표 후보 External Validation Matrix (상위 20행)**', '', mdTable(['후보','Historical','Synthetic','Adversarial','BIS','ECB','Human','Score'], vm.rows.slice(0,20).map(r=>[r.label,r.statuses?.historical?.label||'-',r.statuses?.synthetic?.label||'-',r.statuses?.adversarial?.label||'-',r.statuses?.bis?.label||'-',r.statuses?.ecb?.label||'-',r.statuses?.human?.label||'-',`${r.survived_count}/${r.available_count||0}`])), '', figLine(6), '> 해석: PASS는 해당 검증층에서 살아남은 경우, HOLD는 경계/보류, FAIL은 탈락, N/A는 해당 층 판정자료가 아직 없음을 뜻한다. 전체 후보행은 validation_matrix.csv에 저장한다.', '');}
  const sf=t.survival_funnel; if(sf?.stages?.length){L.push('### 5.2 Delegation Evidence Funnel', '', 'Figure 7과 표 9C의 모든 후보 수는 **현재 프로젝트의 현재 Research Cycle / Evidence Revision에서 실제 계산된 candidate_validation_matrix만으로 산출**하며, 설명용 예시 숫자를 삽입하지 않는다. External Validation Matrix의 후보별 판정을 순차 게이트로 재구성하여, 현재 후보군이 Synthetic → Historical → Adversarial → BIS → ECB → Human 검증을 거치며 얼마나 축소되는지 표시한다. 이 퍼널은 **strict cumulative PASS** 기준이며, 이전 단계까지 모두 PASS한 후보만 다음 단계의 생존 후보로 계산한다. HOLD와 candidate-level N/A는 확정 생존으로 계산하지 않는다. 단, 특정 검증층 전체가 아직 N/A이면 그 층은 미검증으로 표시하고 직전 생존수를 그대로 이월한다.', '', `**표 9C. 현재 프로젝트 실제 검증결과의 누적 생존 후보 — ${t.project.name} · Cycle ${t.project.research_cycle} · Evidence r${t.project.evidence_revision}**`, '', mdTable(['단계','입력 후보','생존','탈락','보류/N/A','전체 대비 생존율','상태'], sf.stages.map(x=>[x.stage,x.total,x.survivors,x.eliminated||0,x.pending||0,pct(x.survival_rate),x.unavailable?'N/A layer':'evaluated'])), '', figLine(7), `> **현재 프로젝트 실제 계산결과:** ${t.project.name} · Cycle ${t.project.research_cycle} · Evidence r${t.project.evidence_revision} · 생성 ${sf.generated_at||t.generated_at}. 최종 strict survivor는 ${sf.final_survivors}/${sf.initial_candidates} (${pct(sf.final_rate)})이다. 이 수치는 예시가 아니라 해당 snapshot의 실제 계산값이다. 개별 후보의 실패·보류 위치는 Figure 6 External Validation Matrix에서 확인한다.`, '');}

  L.push('## 6. 인간 검토자 보정', '');
  if (rv.n) {
    L.push(`누적 참가자 ${rv.cumulative_participants||rv.participants}명 / 기록 ${rv.cumulative_trials||rv.n}건. 현재 인간실험 규약 분석: 검토자 관측 ${rv.n}건(참가자 ${rv.participants}명), 평균 응답시간 ${f(rv.mean_rt_ms / 1000, 2)}초. 반복 trial을 독립 참가자로 간주하지 않고 참가자 단위 cluster bootstrap 기록은 ${rv.cluster_bootstrap?.B||0}회이다. 0회이면 적용된 구간이 없으며 아래 Wilson 구간은 trial 수준의 기술통계다.`, '', '**표 10. 인간 검토자 행동 모수 (95% Wilson 구간)**', '', mdTable(['지표', '추정치 [95% CI]'], [['적정 의존율 (ARR)', cip(rv.arr)], ['AI 오답 수용률', cip(rv.false_accept)], ['정정 개입률 (AI 오답 개입)', cip(rv.correct_override)], ['불필요 개입률 (AI 정답 개입)', cip(rv.unnecessary_override)]]), '', '**표 11. AI 신뢰도별 수용률**', '', mdTable(['AI 신뢰도', 'n', '실제 정답률', '정답 시 수용', '오답 시 수용', '평균 응답시간(ms)'], rv.by_confidence.map(x => [x.confidence, x.n, pct(x.n?x.correct_n/x.n:null), cip(x.accept_when_correct), cip(x.accept_when_wrong), f(x.mean_rt_ms, 0)])), '', figLine(4));
  } else L.push(`현재 분석 대상 검토자 관측이 없습니다. 누적 참가자 ${rv.cumulative_participants||0}명 / 관측 ${rv.cumulative_trials||0}건은 보존되어 있습니다. 현재 인간실험 규약에 부합하지 않는 ${rv.excluded_trials||0}건은 분석에서 제외됩니다.`, '');

  if(rv.n)L.push(`참가자별 관측 수: 최소 ${Math.min(...(rv.participant_distribution||[0]))}, 최대 ${Math.max(...(rv.participant_distribution||[0]))}; 최다 참가자 비중 ${pct(Math.max(...(rv.participant_distribution||[0]))/rv.n)}. 인간 과제 프로토콜: ${rv.protocol||'legacy'}. 통제 과제 신뢰도는 설계상 정답확률이며 실제 AI 성능 추정과 구분한다.`, '', '**참가자 cluster bootstrap 구간 (기술통계)**', '', mdTable(['모수','하한','상한'],Object.entries(rv.cluster_bootstrap?.ci95||{}).map(([k,q])=>[k,f(q.lo),f(q.hi)])), '');
  L.push('## 7. 최종 판정', '', t.approval ? `- 판정: **${t.approval.decision}** (Evidence Level ${t.approval.evidence_level}, ${t.approval.automatic ? '계산 자동판정' : '사람의 학술 승인'}, ${t.approval.created_at})` : '- 판정: 미확정', b ? `- 선택 후보: 추정기 ${estName(b.estimator)}, σ=${b.sigma}, τ=${b.tau}, α=${b.alpha}, K=${b.K}, d=${b.d}, W=${b.W}, m=${b.m}\n- Minimax Regret ${f(b.max_regret, 4)}, Boundary Score ${f(b.boundary_score)}` : '', t.approval?.basis?.selection_rule ? `- 선택 규칙: ${t.approval.basis.selection_rule}` : '', '');


  L.push('## 7A. 주장 범위(Claim Scope Matrix)', '', mdTable(['주장','상태','해석'], [
    ['명시된 제약 하 위임 가능 영역 존재','지원 가능','독립 확인·강건 시나리오·다중비교 보정에 조건부'],
    ['후보 간 상대적 강건성/Minimax Regret','지원 가능','선언된 시나리오 집합 안의 비교 결과'],
    ['절대적 위기확률 또는 실제 지급손실 예측','지원하지 않음','현재 모형은 외부 확률예측 모형이 아님'],
    ['FP/FN의 직접 사회적 비용','지원하지 않음','peak-outflow 기반 proxy만 사용'],
    ['위임의 인과효과','지원하지 않음','관측·시뮬레이션 설계로 인과식별하지 않음'],
    ['보편적 최적 임계값','지원하지 않음','사례·제약·시나리오에 조건부']
  ]), '');
  L.push('## 8. 논의', '', '**본문은 저장된 데이터에 근거한 규칙 기반 분석이며 AI 반복 문장을 사용하지 않는다.**', '', ai.discussion, '', '## 9. 한계 및 타당성 위협', '', ...arr(ai.limitations).map(x => `- ${x}`), '', '## 10. 시사점과 후속 연구', '', ...arr(ai.implications).map(x => `- ${x}`), '', '**후속 연구**', '', ...arr(ai.next_steps).map(x => `- ${x}`), '');

  L.push('## 부록 B. 재현성 정보', '', mdTable(['항목', '값'], [['플랫폼 버전', t.app_version], ['프로젝트 ID', t.project.id], ['설계 시드', t.reproducibility.design_seed], ['정의 버전', t.definition.version], ['동결 프로토콜 SHA-256', t.reproducibility.protocol?.hash || '-'], ['프로토콜 동결시각', t.reproducibility.protocol?.frozen_at || '-'], ['실증 프로파일', t.empirical.profile], ['검토자 모델 버전', rv.model_version], ['감사 로그', `${t.reproducibility.audit.n}건 (${t.reproducibility.audit.first_at || '-'} ~ ${t.reproducibility.audit.last_at || '-'})`], ['작업 집계', t.reproducibility.jobs.map(j => `${j.type}:${j.status}=${j.n}`).join('; ') || '-']]), '', '---', `요약·논의 생성 방식: ${sourceNote}`, '본 보고서의 표와 그림은 D1에 저장된 실행 기록에서 계산되었습니다. 문장형 요약은 초안이므로 표의 수치와 대조하십시오.', '');
  return L.join('\n');
}

export async function generateReport(env, projectId) {
  const t = await buildThesisData(env, projectId), base = fallbackNarrative(t);
  base.limitations = [...(rvLimit(t)), '시뮬레이션 기반 결과이며 실제 제도 환경으로의 일반화에는 추가 검증이 필요하다.'];
  const ai = await aiJson(env,
    '당신은 박사 논문 연구 보고 보조자입니다. 제공된 구조화 사실만 사용하여 한국어 학술 문체로 작성하십시오. 사실에 없는 수치·사례·인용을 만들지 마십시오. 인과 표현을 피하고 한계를 명시하십시오.',
    JSON.stringify(factsForNarrative(t)), base,
    { schemaHint: '{"abstract":"4~5문장 요약(string)","discussion":"3~5문장 논의(string)","limitations":["한계 3~5개(string)"],"implications":["시사점 2~3개(string)"],"next_steps":["후속 연구 2~4개(string)"]}', required: ['abstract'], maxTokens: 2200 });
  const used = ai._ai?.ok === true, pick = (k, fb) => used && (Array.isArray(ai[k]) ? ai[k].length : ai[k]) ? ai[k] : fb;
  const merged = { abstract: base.abstract, discussion: base.discussion, limitations: base.limitations, implications: base.implications, next_steps: base.next_steps };
  const note = used ? `Workers AI (${ai._ai.model})` : `규칙 기반 (AI 호출 실패: ${ai._ai?.error || '알 수 없음'})`;
  const md = buildMarkdown(t, merged, note), id = uid('report'), p = await one(env.DB, `SELECT name FROM projects WHERE id=?`, [projectId]);
  const proj=await one(env.DB,`SELECT research_cycle,evidence_revision FROM projects WHERE id=?`,[projectId]);
  const snapshotCycle=Number(t.project.research_cycle||1),snapshotRevision=Number(t.project.evidence_revision||0);
  const scopeChanged=Number(proj?.research_cycle||1)!==snapshotCycle||Number(proj?.evidence_revision||0)!==snapshotRevision;
  await run(env.DB, `INSERT INTO reports(id,project_id,kind,title,content_markdown,data_json,created_at,research_cycle,evidence_revision) VALUES(?,?,?,?,?,?,?,?,?)`, [id, projectId, 'paper_summary', `${p?.name || 'DCV'} 연구결과`, md, JSON.stringify({ ai_meta: ai._ai, narrative: merged, checklist: checklist(t), figures: figureCatalog(t), summary: { decision: t.approval?.decision, candidates: t.candidates.total, confirmed: t.candidates.by_class.confirmed, reviewer_n: t.reviewer.n } }), nowIso(),snapshotCycle,snapshotRevision]);
  if(scopeChanged){await run(env.DB,`UPDATE reports SET stale_at=? WHERE id=?`,[nowIso(),id]);return {id,draft:true,stale:true,content_markdown:md,markdown:md};}
  const incomplete=(t.candidates.by_class.unevaluated||0)>0 || !t.candidates.total || !['COMPUTATIONALLY_CONFIRMED','SCIENTIFICALLY_APPROVED'].includes(t.approval?.decision);
  const signed=await one(env.DB, `SELECT id FROM approvals WHERE project_id=? AND research_cycle=? AND evidence_revision=? AND stale_at IS NULL AND decision='SCIENTIFICALLY_APPROVED' ORDER BY created_at DESC LIMIT 1`, [projectId,Number(proj?.research_cycle||1),Number(proj?.evidence_revision||0)]);
  await run(env.DB, `UPDATE projects SET current_stage=?,status=?,updated_at=? WHERE id=?`, [incomplete?'compute':signed?'complete':'scientific_review',incomplete?'running':signed?'complete':'report_ready',nowIso(), projectId]);
  await audit(env, projectId, 'agent', 'report.generated', 'report', id, { approval: t.approval?.decision, ai: ai._ai });
  return { id, draft:incomplete, markdown: md, content_markdown: md, thesis: t, ai };
}

function rvLimit(t) {
  const L = [], rv = t.reviewer, pn = t.empirical.panel, lc=t.empirical.loss_calibration;
  if(rv.n) L.push(`인간 검토 결과는 ${rv.n}개 trial, ${rv.participants}명 참가자에 기반한다. 반복측정 의존성은 참가자 cluster bootstrap으로 보정하지만 표본의 대표성 문제는 별개로 남는다.`); else L.push(`누적 참가자 ${rv.cumulative_participants||0}명의 기록은 보존되어 있으나 현재 인간실험 규약의 분석 대상은 ${rv.participants}명이다.`);
  if (pn.n) L.push(`위기 사례 ${pn.n}건 중 ${pn.estimated}건은 reconstructed 자료로, 계수 정밀도와 외적 타당성은 재구성 규칙에 조건부이다.`);
  if(lc?.identification_status==='PROXY_ONLY') L.push('FP/FN 손실계수는 직접 관측 비용이 아니라 peak-outflow 기반 proxy이며, proxy 범위 민감도는 검증하지만 경제적 후생비용으로 해석할 수 없다.');
  L.push('후보 수준별 비율은 주변 비율이며 변수 간 상호작용과 인과효과를 직접 식별하지 못한다.');
  L.push('절대적 위기확률 예측이 아니라 명시된 제약과 시나리오 집합 하의 상대적 위임경계 및 설계 비교가 검증 목표이다.');
  return L;
}

// 이전 버전(연구모형 절이 없는)으로 저장된 보고서를 열 때, 저장된 요약·논의 문장은 그대로 두고
// 현재 D1 집계로 본문을 다시 조립한다(AI 호출 없음). 이미 연구모형 절이 있으면 그대로 돌려준다.
export async function upgradeStoredReport(env, projectId, row) {
  if (!row) return row;
  const oldMd=String(row.content_markdown||'');
  const current=oldMd.includes(MODEL_MARKER)&&oldMd.includes('그림 M0.')&&oldMd.includes('주장 범위(Claim Scope Matrix)')&&!/오수용\(FP\)|미탐\(FN\)|기본 0\.45, 1\.4|용어 주의/.test(oldMd);
  if(current) return row;
  const data = JSON.parse(row.data_json || '{}'), nar = data.narrative;
  if (!nar || !nar.abstract) return row;
  const t = await buildThesisData(env, projectId), note = data.ai_meta?.ok ? `Workers AI (${data.ai_meta.model})` : '규칙 기반 (저장된 요약 재사용)';
  const md = buildMarkdown(t, nar, note + ' · 연구모형 절 자동 추가');
  await run(env.DB, `UPDATE reports SET content_markdown=? WHERE id=?`, [md, row.id]);
  return { ...row, content_markdown: md };
}
