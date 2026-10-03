// 논문 삽입용 그림 생성기 (순수 함수: thesis JSON → SVG 문자열). 브라우저와 Node 테스트에서 공용.
// 흰 배경·검정 글자·색각 이상 친화 팔레트(Okabe-Ito)·흑백 인쇄에서도 구분되도록 마커 모양/수치 라벨 병기.
const FONT = `'Noto Sans KR','Malgun Gothic','Apple SD Gothic Neo','Nanum Gothic',Arial,sans-serif`;
const C = { ok: '#009E73', warn: '#E69F00', bad: '#D55E00', blue: '#0072B2', sky: '#56B4E9', ink: '#111', grid: '#d9d9d9', mute: '#555' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EST = { ema: 'EMA', kalman: 'Kalman', changepoint: 'Change-point', adaptive: 'Adaptive' };
const estName = e => EST[e] || e;
const fx = (v, d = 2) => Number(v).toFixed(d).replace(/\.?0+$/, '') || '0';
const regretFx = v => { const n=Number(v); if(!Number.isFinite(n)) return '대기'; if(n===0) return '0'; const a=Math.abs(n); if(a<1e-4) return n.toExponential(2); if(a<1e-2) return n.toFixed(6).replace(/0+$/,'').replace(/\.$/,''); return n.toFixed(4).replace(/0+$/,'').replace(/\.$/,''); }; 
const pct = v => `${Math.round(v * 100)}%`;

export function figureCatalog(t) {
  t=t||{};
  const cand=t.candidates||{}, reviewer=t.reviewer||{}, empirical=t.empirical||{}, vm=t.validation_matrix||{}, sf=t.survival_funnel||{};
  const figs = [
    { n: 10, label: 'M0', file: 'figM0_full_research_blueprint', title: '박사논문 연구모형 전체 설계도: Define–Compute–Validate와 CDRS·인간 검토·실증 보정' },
    { n: 11, label: 'M1', file: 'figM1_research_model', title: '박사논문 연구모형: 데이터–결정 사슬과 위임 가능 영역 D의 정의' },
    { n: 12, label: 'M2', file: 'figM2_dcv_design', title: '연구설계: Define–Compute–Validate–Confirm 단계, 게이트, 논문 3편의 대응 및 현재 프로젝트 진행 상태' },
    { n: 13, label: 'M3', file: 'figM3_region_concept', title: '위임 가능 영역 개념도 (모식도): 이상적 검토자 영역과 실제 검토자 영역' }
  ];
  if ((cand.cells||[]).length) figs.push({ n: 1, file: 'fig1_feasible_region_heatmap', title: 'σ×α 평면의 위임 가능 후보 비율 (셀 내 CONFIRMED / 전체 후보)' });
  if ((cand.estimators||[]).length) figs.push({ n: 2, file: 'fig2_estimator_feasibility', title: '추정기별 위임 가능 비율과 95% Wilson 신뢰구간' });
  if ((cand.finalists||[]).length) figs.push({ n: 3, file: 'fig3_regret_ranking', title: '강건 후보의 Minimax Regret 순위 (낮을수록 우수)' });
  if ((reviewer.by_confidence||[]).length) figs.push({ n: 4, file: 'fig4_reviewer_reliance', title: 'AI 신뢰도별 인간 검토자 수용률 (AI 정답/오답 구분, 95% CI)' });
  if (Number(empirical?.panel?.n||0)) figs.push({ n: 5, file: 'fig5_episode_panel', title: '위기 사례 패널: 최대 유출률 대비 심각도 (파산 여부 구분)' });
  figs.push({ n: 6, file: 'fig6_external_validation_matrix', title: '후보별 External Validation Matrix (Historical · Synthetic · Adversarial · BIS · ECB · Human)' });
  figs.push({ n: 7, file: 'fig7_delegation_evidence_funnel', title: 'Delegation Evidence Funnel: 현재 프로젝트 실제 검증결과에 따른 후보 생존 흐름' });
  return figs;
}

function wrap(w, h, body, desc) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="${FONT}" role="img" aria-label="${esc(desc)}"><title>${esc(desc)}</title><rect width="${w}" height="${h}" fill="#fff"/>${body}</svg>`;
}
const text = (x, y, s, o = {}) => `<text x="${x}" y="${y}" font-size="${o.size || 13}" fill="${o.fill || C.ink}" text-anchor="${o.anchor || 'start'}"${o.weight ? ` font-weight="${o.weight}"` : ''}${o.rot ? ` transform="rotate(${o.rot} ${x} ${y})"` : ''}>${esc(s)}</text>`;
function niceTicks(lo, hi, n = 5) {
  if (hi <= lo) hi = lo + 1; const step0 = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(step0)), k = step0 / mag, step = (k < 1.5 ? 1 : k < 3 ? 2 : k < 7 ? 5 : 10) * mag;
  const a = Math.floor(lo / step) * step, out = []; for (let v = a; v <= hi + step * 0.5; v += step) out.push(Math.round(v / step) * step); return out;
}
const legendRow = (x, y, items) => items.map((it, i) => `<g transform="translate(${x + i * (it.w || 150)},${y})">${it.mark}${text(18, 4, it.label, { size: 12 })}</g>`).join('');

export function figHeatmap(t) {
  const cells = t.candidates.cells, W = 720, H = 540, m = { l: 84, r: 118, t: 30, b: 74 };
  const xs = [...new Set(cells.map(c => c.sigma))].sort((a, b) => a - b), ys = [...new Set(cells.map(c => c.alpha))].sort((a, b) => b - a);
  const cw = (W - m.l - m.r) / xs.length, ch = (H - m.t - m.b) / ys.length, map = new Map(cells.map(c => [`${c.sigma}|${c.alpha}`, c]));
  const shade = s => { const k = Math.max(0, Math.min(1, s)); const r = Math.round(247 - k * (247 - 8)), g = Math.round(251 - k * (251 - 81)), b = Math.round(255 - k * (255 - 156)); return `rgb(${r},${g},${b})`; };
  let body = '';
  ys.forEach((y, j) => xs.forEach((x, i) => {
    const c = map.get(`${x}|${y}`), px = m.l + i * cw, py = m.t + j * ch, s = c ? c.share : null;
    body += `<rect x="${px}" y="${py}" width="${cw}" height="${ch}" fill="${c ? shade(s) : '#f2f2f2'}" stroke="#fff" stroke-width="2"/>`;
    if (c) body += text(px + cw / 2, py + ch / 2 - 2, pct(s), { anchor: 'middle', size: 15, weight: 700, fill: s > 0.55 ? '#fff' : C.ink }) + text(px + cw / 2, py + ch / 2 + 15, `${c.confirmed}/${c.total}`, { anchor: 'middle', size: 11, fill: s > 0.55 ? '#fff' : C.mute });
  }));
  xs.forEach((x, i) => { body += text(m.l + i * cw + cw / 2, H - m.b + 20, fx(x), { anchor: 'middle' }); });
  ys.forEach((y, j) => { body += text(m.l - 10, m.t + j * ch + ch / 2 + 4, fx(y), { anchor: 'end' }); });
  body += text(m.l + (W - m.l - m.r) / 2, H - 26, 'σ (정보오차)', { anchor: 'middle', size: 14, weight: 700 }) + text(24, m.t + (H - m.t - m.b) / 2, 'α (정보처리 강도)', { anchor: 'middle', size: 14, weight: 700, rot: -90 });
  const bx = W - m.r + 30, bh = H - m.t - m.b;
  for (let i = 0; i < 40; i++) body += `<rect x="${bx}" y="${m.t + bh * i / 40}" width="18" height="${bh / 40 + 0.5}" fill="${shade(1 - i / 39)}"/>`;
  body += `<rect x="${bx}" y="${m.t}" width="18" height="${bh}" fill="none" stroke="${C.ink}" stroke-width=".8"/>` + text(bx + 26, m.t + 10, '100%', { size: 11 }) + text(bx + 26, m.t + bh, '0%', { size: 11 }) + text(bx, m.t - 10, 'CONFIRMED', { size: 11 }) + text(bx, H - 26, `N=${t.candidates.total}`, { size: 11, fill: C.mute });
  return wrap(W, H, body, '시그마-알파 평면의 위임 가능 후보 비율 히트맵');
}

export function figEstimators(t) {
  const es = t.candidates.estimators, W = 720, H = 480, m = { l: 78, r: 30, t: 30, b: 78 }, pw = W - m.l - m.r, ph = H - m.t - m.b, bw = Math.min(90, pw / es.length * 0.55);
  const Y = v => m.t + ph * (1 - v);
  let body = '';
  for (let v = 0; v <= 1.0001; v += 0.2) body += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${C.grid}"/>` + text(m.l - 10, Y(v) + 4, pct(v), { anchor: 'end' });
  es.forEach((e, i) => {
    const cx = m.l + pw * (i + 0.5) / es.length, y = Y(e.share || 0);
    body += `<rect x="${cx - bw / 2}" y="${y}" width="${bw}" height="${m.t + ph - y}" fill="${C.blue}" opacity=".85"/><line x1="${cx}" x2="${cx}" y1="${Y(e.lo ?? e.share)}" y2="${Y(e.hi ?? e.share)}" stroke="${C.ink}" stroke-width="1.6"/><line x1="${cx - 7}" x2="${cx + 7}" y1="${Y(e.lo ?? e.share)}" y2="${Y(e.lo ?? e.share)}" stroke="${C.ink}" stroke-width="1.6"/><line x1="${cx - 7}" x2="${cx + 7}" y1="${Y(e.hi ?? e.share)}" y2="${Y(e.hi ?? e.share)}" stroke="${C.ink}" stroke-width="1.6"/>`;
    body += text(cx, Math.min(Y(e.hi ?? e.share) - 8, y - 8), pct(e.share || 0), { anchor: 'middle', size: 13, weight: 700 }) + text(cx, m.t + ph + 22, estName(e.estimator), { anchor: 'middle', size: 14 }) + text(cx, m.t + ph + 40, `${e.confirmed}/${e.total}`, { anchor: 'middle', size: 11, fill: C.mute });
  });
  body += `<line x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${m.t + ph}" stroke="${C.ink}"/><line x1="${m.l}" x2="${W - m.r}" y1="${m.t + ph}" y2="${m.t + ph}" stroke="${C.ink}"/>` + text(22, m.t + ph / 2, '위임 가능(CONFIRMED) 비율', { anchor: 'middle', size: 14, weight: 700, rot: -90 }) + text(m.l + pw / 2, H - 14, '추정기 (오차막대: 95% Wilson CI)', { anchor: 'middle', size: 13 });
  return wrap(W, H, body, '추정기별 위임 가능 비율');
}

export function figRegret(t) {
  const all = t.candidates.finalists || [], fs = all.filter(f => f.max_regret!=null && f.max_regret!=='' && Number.isFinite(Number(f.max_regret))), sel = t.selected?.id;
  if(!fs.length) return wrap(860,240,text(430,96,'Minimax Regret 계산 대기',{anchor:'middle',size:18,weight:700})+text(430,128,'Historical + Stress 시나리오가 2개 이상 비교 가능한 후보에 대해 완료되면 순위를 표시합니다.',{anchor:'middle',size:12,fill:C.mute}),'강건 후보의 Minimax Regret 순위');
  const rowH = 34, W = 860, m = { l: 300, r: 92, t: 24, b: 84 }, H = m.t + m.b + fs.length * rowH;
  const maxValue=Math.max(...fs.map(f=>Math.max(0,Number(f.max_regret))),0), scaleMax=Math.max(maxValue,1e-9)*1.15, ticks = niceTicks(0, scaleMax, 5), X = v => m.l + (W - m.l - m.r) * Number(v) / scaleMax;
  let body = ticks.map(v => `<line x1="${X(v)}" x2="${X(v)}" y1="${m.t}" y2="${H - m.b}" stroke="${C.grid}"/>${text(X(v), H - m.b + 18, regretFx(v), { anchor: 'middle', size: 10.5 })}`).join('');
  fs.forEach((f, i) => {
    const y = m.t + i * rowH, isSel = f.id === sel, val=Math.max(0,Number(f.max_regret)), w = X(val) - m.l;
    body += text(m.l - 10, y + rowH / 2 + 4, `#${i + 1} ${estName(f.estimator)} σ=${fx(f.sigma)} α=${fx(f.alpha)} K=${f.K} d=${f.d}`, { anchor: 'end', size: 12, weight: isSel ? 700 : 400 }) + `<rect x="${m.l}" y="${y + 6}" width="${Math.max(val===0?2:1, w)}" height="${rowH - 12}" fill="${isSel ? C.ok : C.sky}"/>` + text(m.l + Math.max(w,2) + 6, y + rowH / 2 + 4, regretFx(val), { size: 11 });
  });
  if(maxValue===0) body+=text(m.l,H-48,'모든 비교 가능 후보의 regret이 0으로 동률입니다.',{size:11,fill:C.mute});
  body += `<line x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${H - m.b}" stroke="${C.ink}"/>` + text(m.l + (W - m.l - m.r) / 2, H - 14, 'Maximum regret', { anchor: 'middle', size: 13, weight: 700 }) + (sel ? legendRow(m.l, H - 34, [{ mark: `<rect width="12" height="12" y="-6" fill="${C.ok}"/>`, label: '최종 선택 후보', w: 140 }]) : '');
  return wrap(W, H, body, '강건 후보의 Minimax Regret 순위');
}

export function figExternalValidationMatrix(t) {
  const vm=t.validation_matrix||t.simulation?.validation_matrix||{rows:[],stages:[],summary:[]};
  const rows=vm.rows||[],stages=vm.stages||[];
  if(!rows.length||!stages.length)return wrap(720,200,text(360,100,'검증 결과 미수집 · 후보 연산 및 외부 검증 대기',{anchor:'middle',size:16,weight:700}),'후보별 external validation matrix');
  const rowH=rows.length>90?12:rows.length>50?15:20,W=1080,m={l:300,r:110,t:82,b:94},colW=(W-m.l-m.r)/stages.length,H=m.t+m.b+rows.length*rowH;
  const fill={PASS:C.ok,FAIL:C.bad,HOLD:C.warn,MISSING:'#d9d9d9'},glyph={PASS:'✓',FAIL:'×',HOLD:'△',MISSING:'–'};
  let body=text(m.l,28,'External Validation Matrix',{size:17,weight:700})+text(m.l,49,'Historical · Synthetic · Adversarial · BIS · ECB · Human 검증층의 후보별 생존 상태',{size:11.5,fill:C.mute});
  stages.forEach((st,i)=>{body+=`<rect x="${m.l+i*colW}" y="${m.t-31}" width="${colW}" height="27" fill="#fafafa" stroke="${C.grid}"/>`+text(m.l+i*colW+colW/2,m.t-12,st.label,{anchor:'middle',size:11.5,weight:700});});
  body+=`<rect x="${W-m.r+9}" y="${m.t-31}" width="76" height="27" fill="#fafafa" stroke="${C.grid}"/>`+text(W-m.r+47,m.t-12,'Overall',{anchor:'middle',size:11.5,weight:700});
  rows.forEach((r,j)=>{const y=m.t+j*rowH,lab=`${estName(r.estimator)} σ=${fx(r.sigma)} α=${fx(r.alpha)} K=${r.K??'-'} d=${fx(r.d??0)}`;if(rowH>=15||j%4===0)body+=text(m.l-8,y+rowH*.72,lab,{anchor:'end',size:rowH>=20?10.5:8.5,weight:r.overall_code==='PASS'?700:400,fill:r.overall_code==='FAIL'?C.bad:C.ink});stages.forEach((st,i)=>{const code=r.statuses?.[st.key]?.code||'MISSING',x=m.l+i*colW;body+=`<rect x="${x}" y="${y}" width="${colW}" height="${Math.max(7,rowH-2)}" fill="${fill[code]||fill.MISSING}" stroke="#fff"/>`;if(rowH>=18)body+=text(x+colW/2,y+rowH*.72,glyph[code]||'–',{anchor:'middle',size:11,weight:700,fill:code==='PASS'||code==='FAIL'?'#fff':C.ink});});const oc=r.overall_code||'MISSING';body+=`<rect x="${W-m.r+9}" y="${y}" width="76" height="${Math.max(7,rowH-2)}" fill="${fill[oc]||fill.MISSING}" stroke="#fff"/>`;});
  const summaryLine=(vm.summary||[]).map(x=>`${x.stage} ${x.PASS||0}/${x.observed||0}`).join('   ·   ');body+=text(m.l,H-51,`PASS / 관측 후보: ${summaryLine}`,{size:10.5,fill:C.mute});
  body+=legendRow(m.l,H-21,[{mark:`<rect width="12" height="12" y="-6" fill="${fill.PASS}"/>`,label:'PASS',w:85},{mark:`<rect width="12" height="12" y="-6" fill="${fill.HOLD}"/>`,label:'HOLD',w:85},{mark:`<rect width="12" height="12" y="-6" fill="${fill.FAIL}"/>`,label:'FAIL',w:85},{mark:`<rect width="12" height="12" y="-6" fill="${fill.MISSING}"/>`,label:'N/A',w:110},{mark:'',label:`N=${rows.length} candidates`,w:150}]);
  return wrap(W,H,body,'후보별 external validation matrix');
}

export function figDelegationEvidenceFunnel(t) {
  const f=t.survival_funnel||{stages:[]},stages=(f.stages||[]);
  if(stages.length<2)return wrap(760,220,text(380,110,'생존율 미산출 · 실제 검증 결과 대기',{anchor:'middle',size:16,weight:700}),'Delegation evidence funnel');
  const W=1080,cx=465,top=108,stepH=68,gap=10,maxW=760,minW=165,initial=Math.max(1,Number(f.initial_candidates||stages[0]?.survivors||1));
  const lastBottom=top+(stages.length-1)*(stepH+gap)+stepH;
  const footerTop=lastBottom+34,footerH=96,H=footerTop+footerH;
  const widthFor=n=>Math.max(minW,maxW*Math.sqrt(Math.max(0,Number(n))/initial));
  const cols=['#0072B2','#56B4E9','#009E73','#E69F00','#6a3d9a','#D55E00','#555'];
  const projectName=f.project_name||t.project?.name||'Current project',cycle=f.research_cycle??t.project?.research_cycle??'-',rev=f.evidence_revision??t.project?.evidence_revision??'-';
  let body=text(cx,25,'Delegation Evidence Funnel · Current Project Result',{anchor:'middle',size:18,weight:700})
    +text(cx,47,`${projectName} · Cycle ${cycle} · Evidence r${rev}`,{anchor:'middle',size:11.5,weight:700,fill:C.blue})
    +text(cx,66,'Synthetic → Historical → Adversarial → BIS → ECB → Human · actual current-project counts only',{anchor:'middle',size:10.8,fill:C.mute});
  stages.forEach((st,i)=>{
    const y=top+i*(stepH+gap),w=widthFor(st.survivors),next=stages[i+1],w2=next?widthFor(next.survivors):w,x=cx-w/2,yn=y+stepH;
    const fill=st.unavailable?'#ececec':cols[Math.min(i,cols.length-1)];
    if(i<stages.length-1){const nx=cx-w2/2;body+=`<path d="M ${x} ${y} L ${x+w} ${y} L ${nx+w2} ${yn} L ${nx} ${yn} Z" fill="${fill}" fill-opacity="${st.unavailable?.58:.88}" stroke="#fff" stroke-width="2"/>`;}
    else body+=`<rect x="${x}" y="${y}" width="${w}" height="${stepH}" rx="7" fill="${fill}" fill-opacity="${st.unavailable?.58:.88}" stroke="#fff" stroke-width="2"/>`;
    const label=st.key==='baseline'?'Candidate pool':st.stage, rate=initial?Number(st.survivors)/initial:0;
    body+=text(cx,y+27,label,{anchor:'middle',size:14,weight:700,fill:st.unavailable?C.ink:'#fff'})+text(cx,y+49,st.unavailable?`${st.total} unverified · PASS unavailable`:`${st.survivors} survivors · ${pct(rate)}`,{anchor:'middle',size:12,weight:700,fill:st.unavailable?C.mute:'#fff'});
    if(i>0){const right=x+w+16;body+=text(right,y+24,st.unavailable?'N/A · gate unavailable':`eliminated ${st.eliminated||0}`,{size:11.5,fill:st.unavailable?C.mute:C.bad,weight:700});body+=text(right,y+43,st.unavailable?`awaiting actual validation`:`pending ${st.pending||0}`,{size:11,fill:C.mute});}
  });
  body+=`<line x1="90" x2="990" y1="${footerTop-16}" y2="${footerTop-16}" stroke="${C.grid}"/>`;
  body+=text(cx,footerTop,`Final strict survivors: ${f.final_survivors??0} / ${f.initial_candidates??0} (${pct(Number(f.final_rate||0))})`,{anchor:'middle',size:14,weight:700});
  body+=text(cx,footerTop+25,'Strict cumulative PASS: HOLD와 candidate-level N/A는 생존으로 계산하지 않습니다.',{anchor:'middle',size:10.5,fill:C.mute});
  body+=text(cx,footerTop+43,'전체 층이 미검증이면 최종 생존은 0이며, 층별 이월 수는 통과 증거가 아닙니다.',{anchor:'middle',size:10.5,fill:C.mute});
  body+=text(cx,footerTop+66,`Source snapshot: current project · Cycle ${cycle} · Evidence r${rev} · ${f.generated_at||t.generated_at||'-'}`,{anchor:'middle',size:9.7,fill:C.mute});
  return wrap(W,H,body,'검증층을 통과하며 축소되는 위임 후보 생존 퍼널');
}

export function figReviewer(t) {
  const bc = t.reviewer.by_confidence, W = 720, H = 500, m = { l: 78, r: 30, t: 58, b: 84 }, pw = W - m.l - m.r, ph = H - m.t - m.b, Y = v => m.t + ph * (1 - v), gw = pw / bc.length, bw = Math.min(56, gw * 0.3);
  let body = '';
  for (let v = 0; v <= 1.0001; v += 0.2) body += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${C.grid}"/>` + text(m.l - 10, Y(v) + 4, pct(v), { anchor: 'end' });
  const bar = (cx, o, color) => { if (!o.n) return text(cx, Y(0) - 6, 'n=0', { anchor: 'middle', size: 11, fill: C.mute }); return `<rect x="${cx - bw / 2}" y="${Y(o.p)}" width="${bw}" height="${Math.max(1, Y(0) - Y(o.p))}" fill="${color}"/><line x1="${cx}" x2="${cx}" y1="${Y(o.lo)}" y2="${Y(o.hi)}" stroke="${C.ink}" stroke-width="1.5"/><line x1="${cx - 6}" x2="${cx + 6}" y1="${Y(o.lo)}" y2="${Y(o.lo)}" stroke="${C.ink}" stroke-width="1.5"/><line x1="${cx - 6}" x2="${cx + 6}" y1="${Y(o.hi)}" y2="${Y(o.hi)}" stroke="${C.ink}" stroke-width="1.5"/>${text(cx, Y(o.hi) - 6, pct(o.p), { anchor: 'middle', size: 12, weight: 700 })}`; };
  bc.forEach((g, i) => {
    const cx = m.l + gw * (i + 0.5);
    body += bar(cx - bw * 0.6, g.accept_when_correct, C.ok) + bar(cx + bw * 0.6, g.accept_when_wrong, C.bad) + text(cx, m.t + ph + 22, `AI 신뢰도 ${pct(g.confidence)}`, { anchor: 'middle', size: 13 }) + text(cx, m.t + ph + 40, `정답 ${g.correct_n} · 오답 ${g.wrong_n}`, { anchor: 'middle', size: 11, fill: C.mute });
  });
  body += `<line x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${m.t + ph}" stroke="${C.ink}"/><line x1="${m.l}" x2="${W - m.r}" y1="${m.t + ph}" y2="${m.t + ph}" stroke="${C.ink}"/>` + text(22, m.t + ph / 2, 'AI 권고 수용률', { anchor: 'middle', size: 14, weight: 700, rot: -90 }) + legendRow(m.l, 18, [{ mark: `<rect width="12" height="12" y="-6" fill="${C.ok}"/>`, label: 'AI 정답일 때 수용', w: 170 }, { mark: `<rect width="12" height="12" y="-6" fill="${C.bad}"/>`, label: 'AI 오답일 때 수용', w: 220 }]) + text(m.l + pw / 2, H - 14, `N=${t.reviewer.n}, 참가자 ${t.reviewer.participants}명 (오차막대: 95% Wilson CI)`, { anchor: 'middle', size: 12, fill: C.mute });
  return wrap(W, H, body, 'AI 신뢰도별 인간 검토자 수용률');
}

export function figEpisodes(t) {
  const eps = t.empirical.panel.episodes, W = 720, H = 540, m = { l: 78, r: 30, t: 44, b: 70 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
  const xmax = Math.max(...eps.map(e => e.peak_outflow ?? 0), 0.05) * 1.08, xt = niceTicks(0, xmax, 6), X = v => m.l + pw * v / xt[xt.length - 1], Y = v => m.t + ph * (1 - v);
  let body = xt.map(v => `<line x1="${X(v)}" x2="${X(v)}" y1="${m.t}" y2="${m.t + ph}" stroke="${C.grid}"/>${text(X(v), m.t + ph + 20, pct(v), { anchor: 'middle', size: 11 })}`).join('');
  for (let v = 0; v <= 1.0001; v += 0.2) body += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${C.grid}"/>` + text(m.l - 10, Y(v) + 4, fx(v, 1), { anchor: 'end' });
  for (const e of eps) {
    const x = X(e.peak_outflow ?? 0), y = Y(e.severity ?? 0);
    body += Number(e.failed) === 1 ? `<circle cx="${x}" cy="${y}" r="5" fill="${C.bad}" fill-opacity=".8" stroke="#fff" stroke-width=".8"/>` : `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="${C.blue}" stroke-width="1.8"/>`;
  }
  body += `<line x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${m.t + ph}" stroke="${C.ink}"/><line x1="${m.l}" x2="${W - m.r}" y1="${m.t + ph}" y2="${m.t + ph}" stroke="${C.ink}"/>` + text(22, m.t + ph / 2, '심각도', { anchor: 'middle', size: 14, weight: 700, rot: -90 }) + text(m.l + pw / 2, H - 22, '최대 유출률 (peak outflow)', { anchor: 'middle', size: 14, weight: 700 }) + legendRow(m.l, 22, [{ mark: `<circle r="5" cy="0" fill="${C.bad}" fill-opacity=".8"/>`, label: '파산', w: 90 }, { mark: `<circle r="5" cy="0" fill="none" stroke="${C.blue}" stroke-width="1.8"/>`, label: '비파산', w: 100 }]) + text(W - m.r, 22, `N=${eps.length}`, { anchor: 'end', size: 12, fill: C.mute });
  return wrap(W, H, body, '위기 사례 패널 최대 유출률 대비 심각도');
}


/* ---------- 연구모형·연구설계 그림 (개념도: 데이터가 없어도 항상 생성, 제약값·진행상태는 프로젝트 자료 반영) ---------- */
// 텍스트 안의 X_{sub} 를 tspan 아래첨자로 변환 (baseline-shift 미지원 렌더러 대비 dy 사용)
const SUBMAP = { a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ', 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉' };
function rich(s) {          // X_{sub}: 유니코드 아래첨자가 있으면 그대로, 없으면 dy 이동 tspan(시작 정렬 텍스트에서만 사용)
  const parts = String(s ?? '').split(/(_\{[^}]*\})/); let shifted = false, out = '';
  for (const p of parts) {
    if (/^_\{/.test(p)) { const sub = p.slice(2, -1); if ([...sub].every(ch => SUBMAP[ch])) { out += esc([...sub].map(ch => SUBMAP[ch]).join('')); shifted = false; } else { out += `<tspan dy="3" font-size="0.72em">${esc(sub)}</tspan>`; shifted = true; } }
    else if (p) { out += shifted ? `<tspan dy="-3">${esc(p)}</tspan>` : esc(p); shifted = false; }
  }
  return out;
}
const rtext = (x, y, s, o = {}) => `<text x="${x}" y="${y}" font-size="${o.size || 13}" fill="${o.fill || C.ink}" text-anchor="${o.anchor || 'start'}"${o.weight ? ` font-weight="${o.weight}"` : ''}${o.italic ? ' font-style="italic"' : ''}>${rich(s)}</text>`;
const box = (x, y, w, h, o = {}) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.rx ?? 8}" fill="${o.fill || '#fff'}" stroke="${o.stroke || C.ink}" stroke-width="${o.sw || 1.4}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}/>`;
const arrow = (x1, y1, x2, y2, o = {}) => { const a = Math.atan2(y2 - y1, x2 - x1), L = 9, w = .42, p1 = [x2 - L * Math.cos(a - w), y2 - L * Math.sin(a - w)], p2 = [x2 - L * Math.cos(a + w), y2 - L * Math.sin(a + w)]; return `<line x1="${x1}" y1="${y1}" x2="${x2 - 6 * Math.cos(a)}" y2="${y2 - 6 * Math.sin(a)}" stroke="${o.stroke || C.ink}" stroke-width="${o.sw || 1.6}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}/><polygon points="${x2},${y2} ${p1[0]},${p1[1]} ${p2[0]},${p2[1]}" fill="${o.stroke || C.ink}"/>`; };
const num = v => (v == null || !Number.isFinite(Number(v))) ? '-' : String(Number(v));

export function figFullBlueprint(t) {
  const W=1120,H=1778,pad=24,gap=16,blue='#0d5f87',blue2='#1383a8',teal='#1aa6a6',orange='#f39a2e',cream='#fff7e5',lite='#edf8fc',pink='#fff0ec',green='#e9f8f2'; let b='';
  const title=(x,y,w,no,txt)=>{ b+=box(x,y,w,42,{rx:10,fill:blue,stroke:blue}); b+=rtext(x+14,y+27,`${no}  ${txt}`,{size:18,weight:700,fill:'#fff'}); };
  const txts=(x,y,arr,o={})=>arr.forEach((v,i)=>{b+=rtext(x,y+i*(o.leading||21),v,{size:o.size||13,weight:o.weight||400,fill:o.fill||C.ink,anchor:o.anchor||'start'});});
  // header
  b+=rtext(W/2,44,'박사논문 연구모형 전체 설계도',{size:34,weight:800,anchor:'middle',fill:'#12395b'});
  b+=rtext(W/2,74,'잡음과 승인 지연 하 공공 지급결제 의사결정의 알고리즘 위임 가능 영역 설계',{size:15,weight:700,anchor:'middle',fill:C.mute});
  b+=box(86,92,W-172,44,{rx:18,fill:cream,stroke:'#e7bb69'}); b+=rtext(W/2,120,'핵심 질문: 어떤 조건에서, 어느 범위까지, 어떤 복구장치를 전제로 알고리즘에 집행권한을 위임할 수 있는가?',{size:14,weight:700,anchor:'middle'});
  // section 1 left
  const x1=24,w1=382,y1=154; title(x1,y1,w1,'1','연구의 핵심 아이디어'); b+=box(x1,y1+50,w1,300,{fill:'#fff',stroke:'#a8d4e6'});
  txts(x1+18,y1+80,['알고리즘 성능 순위를 비교하는 연구가 아니라,','데이터 품질·정보처리·권한·인간·복구가','결합된 시스템에서 위임 가능 영역 D의','경계를 설계·탐색·검증하는 연구이다.'],{size:13.2,leading:22});
  const sx=[x1+28,x1+145,x1+262], cols=[C.blue,C.ok,C.warn], labs=[['Define','1편: 개념·설계'],['Compute','2편: 계산·강건탐색'],['Validate','3편: 사례·인간검증']];
  labs.forEach((a,i)=>{b+=box(sx[i],y1+220,94,62,{fill:i===0?'#e8f3fb':i===1?'#e9f8f2':'#fff4dc',stroke:cols[i]}); b+=rtext(sx[i]+47,y1+246,a[0],{size:14,weight:700,anchor:'middle',fill:cols[i]}); b+=rtext(sx[i]+47,y1+266,a[1],{size:10.5,anchor:'middle'}); if(i<2)b+=arrow(sx[i]+94,y1+251,sx[i+1]-6,y1+251,{stroke:'#4d7890'});});
  // section 2 right large
  const x2=x1+w1+gap,w2=W-x2-pad; title(x2,y1,w2,'2','전체 연구모형: 데이터–결정 사슬'); b+=box(x2,y1+50,w2,614,{fill:'#fff',stroke:'#9cc8db'});
  const fbx=x2+56, fw=w2-112; b+=box(fbx,y1+70,fw,50,{fill:'#eef6fa',stroke:blue2}); b+=rtext(fbx+fw/2,y1+92,'환경 불확실성',{size:14,weight:700,anchor:'middle'}); b+=rtext(fbx+fw/2,y1+111,'확률적 충격 · 위기유형 · 계수 불확실성 · 상황변화',{size:11.5,anchor:'middle'});
  const chain=[['① 데이터 품질','정보오차 σ · 시차 τ · 누락 · 이상치','#e8f3fb'],['② 정보 처리','EMA(α) · Kalman · 변화점 · Adaptive','#e9f8f2'],['③ 알고리즘 판단','지급 · 지급정지 · 추가검토 + Confidence','#eef0ff'],['④ 위임 권한 K','K0 인간전결 · K1 승인 · K2 조건부 자동 · K3 광범위 자동','#fff4dc']];
  chain.forEach((r,i)=>{const yy=y1+138+i*72;b+=box(fbx,yy,fw,56,{fill:r[2],stroke:i===3?orange:blue2});b+=rtext(fbx+14,yy+22,r[0],{size:13.5,weight:700});b+=rtext(fbx+14,yy+43,r[1],{size:11.5});if(i<3)b+=arrow(fbx+fw/2,yy+56,fbx+fw/2,yy+72,{stroke:'#557d90'});});
  const yy5=y1+438,hh=(fw-20)/2;b+=box(fbx,yy5,hh,58,{fill:'#fff4dc',stroke:orange})+rtext(fbx+12,yy5+22,'⑤ 인간 검토·승인',{size:13,weight:700})+rtext(fbx+12,yy5+43,'승인 지연 d · 편향 · 오류수정',{size:11});
  b+=box(fbx+hh+20,yy5,hh,58,{fill:'#e9f8f2',stroke:teal})+rtext(fbx+hh+32,yy5+22,'⑤ 자동 집행',{size:13,weight:700})+rtext(fbx+hh+32,yy5+43,'즉시 또는 제한적 실행',{size:11});
  b+=box(fbx,yy5+76,fw,58,{fill:pink,stroke:C.bad})+rtext(fbx+14,yy5+98,'⑥ 실제 결과',{size:13,weight:700})+rtext(fbx+14,yy5+119,'손실 L · FP 정지 오판 · FN 정지 누락 · 검토부담 B · 복구시간 T_R',{size:11});
  b+=box(fbx,yy5+152,fw,58,{fill:'#e8f3fb',stroke:blue2})+rtext(fbx+14,yy5+174,'⑦ 복구 규칙',{size:13,weight:700})+rtext(fbx+14,yy5+195,'여유폭 W · 재조정 기준 m · rollback · 재검토 → Feedback Loop',{size:11});
  // section 3 left middle
  const y3=y1+366; title(x1,y3,w1,'3','수학적 정의와 경험적 손실 보정'); b+=box(x1,y3+50,w1,520,{fill:'#fff',stroke:'#a8d4e6'});
  b+=box(x1+16,y3+72,w1-32,64,{fill:cream,stroke:'#e9c77b'}); b+=rtext(x1+30,y3+96,'설계벡터',{size:12,weight:700,fill:blue}); b+=rtext(x1+w1/2,y3+124,'x = (σ, τ, α, K, d, W, m, E)',{size:15,weight:700,anchor:'middle',fill:'#d97520'});
  b+=box(x1+16,y3+160,w1-32,104,{fill:green,stroke:C.ok}); b+=rtext(x1+30,y3+186,'위임 가능 영역 D',{size:12,weight:700,fill:C.ok}); b+=rtext(x1+w1/2,y3+222,'D = { x : P[g_j(x,S) ≤ c_j] ≥ 1−ε_j, ∀j }',{size:12.5,weight:700,anchor:'middle'}); b+=rtext(x1+w1/2,y3+249,'UNRESOLVED ≠ INFEASIBLE',{size:11.5,weight:700,anchor:'middle',fill:C.bad});
  const lc=t.empirical?.loss_calibration||{}; b+=box(x1+16,y3+290,w1-32,260,{fill:'#f7fbfd',stroke:'#c5d8e1'}); txts(x1+34,y3+336,['경험적 손실계수 (n='+ (lc.n||0) +')',`FP 정지 오판: c_FP=${fx(lc.c_fp??0,4)}`,`FN 정지 누락: c_FN=${fx(lc.c_fn??0,4)}`,`q95 손실 정규화: ${fx(lc.normalization??0,4)}`],{size:13,leading:54,weight:600});
  // section 4 right mid table
  const y4=y1+680; title(x2,y4,w2,'4','제1편 · 제2편 · 제3편 구성'); b+=box(x2,y4+50,w2,206,{fill:'#fff',stroke:'#9cc8db'});
  const colsX=[x2+12,x2+68,x2+260,x2+492], widths=[52,190,228,w2-504]; ['편','핵심 질문','방법','산출물'].forEach((h,i)=>{b+=box(colsX[i],y4+62,widths[i],34,{rx:0,fill:'#dfeff6',stroke:'#95b7c7'});b+=rtext(colsX[i]+widths[i]/2,y4+84,h,{size:11.5,weight:700,anchor:'middle'});});
  const rr=[['1편','무엇을 위임 가능하다고 정의?','데이터–결정 사슬·K 정의','개념 틀·명제'],['2편','어떤 조건에서 경계가 형성·붕괴?','교차실험·CDRS·Minimax Regret','위임 가능 영역 지도'],['3편','사례·인간이 달라도 유지?','2차 사례·인간 실험·재계산','일반화·현실 검증']]; rr.forEach((r,j)=>r.forEach((v,i)=>{b+=box(colsX[i],y4+96+j*42,widths[i],42,{rx:0,fill:'#fff',stroke:'#c5d8e1'});b+=rtext(colsX[i]+8,y4+121+j*42,v,{size:i===0?12:10.5,weight:i===0?700:400});}));
  b+=rtext(x2+w2/2,y4+238,'논리 구조: Define  →  Compute  →  Validate  →  Re-compute  →  Confirm',{size:12.5,weight:700,anchor:'middle',fill:blue});
  // section 5 left lower
  const y5=y4+256+16; title(x1,y5,530,'5','제2편 계산 절차와 강건 탐색 (CDRS)'); b+=box(x1,y5+50,530,346,{fill:'#fff',stroke:'#9cc8db'});
  const steps=['후보 설계 X 생성','Exploration simulation','명백한 infeasible 제거','경계 후보 탐색','경계부 simulation budget 집중','독립 seed confirmation','Robust scenario 검증','Delegation Feasible Region 도출','Minimax Regret 대표 정책 선택'];
  steps.forEach((st,i)=>{const yy=y5+72+i*28;b+=`<circle cx="${x1+38}" cy="${yy}" r="10" fill="${teal}"/>`+rtext(x1+38,yy+4,String(i+1),{size:10.5,weight:700,fill:'#fff',anchor:'middle'})+box(x1+60,yy-12,235,24,{rx:6,fill:'#f6fbfd',stroke:'#b8d8e5'})+rtext(x1+70,yy+4,st,{size:10.4});});
  b+=box(x1+318,y5+72,188,128,{fill:'#eef7fb',stroke:blue2})+rtext(x1+332,y5+96,'시나리오 집합 S',{size:13,weight:700,fill:blue})+rtext(x1+332,y5+120,'Historical: 81개 위기 사례',{size:11})+rtext(x1+332,y5+142,'Synthetic: Monte Carlo',{size:11})+rtext(x1+332,y5+164,'Adversarial: ±40% 27조합',{size:11})+rtext(x1+332,y5+190,'Safety first, regret second',{size:11,weight:700,fill:C.bad});
  // mini region plot
  b+=box(x1+318,y5+214,188,118,{fill:'#fbfbfb',stroke:'#c5d8e1'}); b+=`<path d="M ${x1+334} ${y5+302} Q ${x1+385} ${y5+238} ${x1+480} ${y5+228} L ${x1+490} ${y5+316} L ${x1+334} ${y5+316} Z" fill="#a9e0d1" opacity=".8"/><path d="M ${x1+334} ${y5+286} Q ${x1+400} ${y5+251} ${x1+490} ${y5+268}" fill="none" stroke="${C.bad}" stroke-dasharray="5 4"/>`; b+=rtext(x1+348,y5+356,'위임 가능 영역 / 경계 / 금지 영역',{size:10.5});
  // section 6 right lower
  const x6=x1+546,w6=W-x6-pad; title(x6,y5,w6,'6','제3편 인간 검토자 실험'); b+=box(x6,y5+50,w6,346,{fill:'#fff',stroke:'#9cc8db'});
  txts(x6+18,y5+80,['실험요인: AI Confidence(저/중/고) × AI 정오(정답/오답)','× 시간압박 또는 승인 지연(낮음/높음)'],{size:12,leading:22});
  b+=rtext(x6+18,y5+136,'핵심 행동지표',{size:13,weight:700,fill:blue}); txts(x6+30,y5+158,['Primary 1: Appropriate Reliance Rate (ARR)','Primary 2: Error Recovery Time (ERT)','Secondary: AI 오답 수용률 / 불필요 개입률','Operational: Review Burden'],{size:11.5,leading:20});
  const mx=x6+18,my=y5+246,mw=(w6-46)/2,mh=36; [['AI 정답·수용','적절한 의존',green],['AI 정답·개입','과소 의존',cream],['AI 오류·수용','과잉 의존',pink],['AI 오류·개입','적절한 개입',green]].forEach((r,i)=>{const xx=mx+(i%2)*(mw+10),yy=my+Math.floor(i/2)*(mh+8);b+=box(xx,yy,mw,mh,{fill:r[2],stroke:'#a8c7d5'})+rtext(xx+mw/2,yy+15,r[0],{size:10.5,anchor:'middle',weight:700})+rtext(xx+mw/2,yy+30,r[1],{size:10.5,anchor:'middle'});});
  b+=rtext(x6+w6/2,y5+368,'Ideal Reviewer Region  ⟶  Empirical Reviewer Region',{size:11.5,weight:700,anchor:'middle',fill:blue});
  // section 7 bottom
  const y7=y5+396+16; title(pad,y7,W-2*pad,'7','핵심 연구명제와 기대 기여'); b+=box(pad,y7+50,W-2*pad,146,{fill:'#fff',stroke:'#9cc8db'});
  txts(pad+18,y7+82,['P1  정보오차 ↑ → 위임 가능 영역 축소','P2  데이터 품질·정보처리·권한·지연 사이 교호작용','P3  복구 여유폭 ↔ 재조정 빈도·손실 노출 trade-off','P4  인간 검토자의 편향·오류·지연 → 경계 재조정'],{size:11.7,leading:25,weight:600});
  txts(W/2+20,y7+82,['이론  데이터–결정 사슬과 위임 가능 영역 개념화','방법  제약기반 강건 탐색·확인 절차','실증  81개 위기 사례 + 인간 검토자 검증','실무  증거 기반 위임 설계 기준'],{size:11.7,leading:25,weight:600});
  b+=box(78,H-48,W-156,32,{rx:12,fill:'#103f63',stroke:'#103f63'})+rtext(W/2,H-27,'결론: 알고리즘 위임은 AI 정확도의 문제가 아니라 정보–처리–권한–인간–복구가 결합된 시스템 설계 문제이다.',{size:13.2,weight:700,anchor:'middle',fill:'#fff'});
  return wrap(W,H,b,'박사논문 연구모형 전체 설계도');
}

export function figResearchModel(t) {
  const W = 960, H = 830, cx = 330, bx = 80, bw = 500; let b = '';
  const layer = (y, h, no, title, sub, fill, stroke) => { b += box(bx, y, bw, h, { fill, stroke }) + rtext(bx + 14, y + 22, `${no} ${title}`, { size: 14, weight: 700 }) + rtext(bx + 14, y + 42, sub, { size: 12, fill: '#333' }); };
  b += rtext(bx, 24, '데이터–결정 사슬 (Data–Decision Chain)', { size: 15, weight: 700 });
  // 환경
  b += box(bx, 40, bw, 54, { fill: '#f2f2f2', stroke: C.mute, dash: '5 3' }) + rtext(cx, 62, '환경 불확실성  s ∈ S', { size: 14, weight: 700, anchor: 'middle' }) + rtext(cx, 82, '확률적 충격 · 위기유형 · 계수 불확실성 · 상황변화 (Historical ∪ Synthetic ∪ Adversarial)', { size: 11.5, anchor: 'middle', fill: '#333' });
  const ys = [118, 204, 290, 376];
  layer(ys[0], 66, '①', '데이터 품질', '정보오차 σ │ 시차 τ │ 누락·이상치 │ 변화속도', '#e8f3fb', C.blue);
  layer(ys[1], 66, '②', '정보 처리  E', 'EMA(α) │ Kalman │ 변화점 탐지 │ 적응형 추정기', '#e8f3fb', C.blue);
  layer(ys[2], 66, '③', '알고리즘 판단', '지급 · 지급정지 · 한도조정 · 추가검토 + 신뢰도(confidence)', '#e8f3fb', C.blue);
  layer(ys[3], 66, '④', '위임 권한  K', 'K0 인간전결 │ K1 AI추천+승인 │ K2 일정범위 자동 │ K3 광범위 자동', '#fff4dc', C.warn);
  [0, 1, 2].forEach(i => { b += arrow(cx, ys[i] + 66, cx, ys[i + 1], {}); }); b += arrow(cx, 94, cx, ys[0], {});
  // ⑤ 분기
  const y5 = 474, hw = 240;
  b += box(bx, y5, hw, 64, { fill: '#fff4dc', stroke: C.warn }) + rtext(bx + 12, y5 + 22, '⑤ 인간 검토·승인', { size: 13.5, weight: 700 }) + rtext(bx + 12, y5 + 42, '승인 지연 d · 인간 편향 · 오류수정', { size: 11.5, fill: '#333' });
  b += box(bx + bw - hw, y5, hw, 64, { fill: '#fff4dc', stroke: C.warn }) + rtext(bx + bw - hw + 12, y5 + 22, '⑤ 자동 집행', { size: 13.5, weight: 700 }) + rtext(bx + bw - hw + 12, y5 + 42, '즉시 또는 제한적 실행 (K≥2)', { size: 11.5, fill: '#333' });
  b += arrow(cx - 80, ys[3] + 66, bx + hw / 2, y5) + arrow(cx + 80, ys[3] + 66, bx + bw - hw / 2, y5);
  const y6 = 574; layer(y6, 66, '⑥', '실제 결과', '손실 L │ 정지 오판 FP(정상지급 차단) │ 정지 누락 FN(부정지급·유출) │ 검토부담 B │ 복구시간 T_{R}', '#fde9e0', C.bad);
  b += arrow(bx + hw / 2, y5 + 64, bx + hw / 2 + 30, y6) + arrow(bx + bw - hw / 2, y5 + 64, bx + bw - hw / 2 - 30, y6);
  const y7 = 676; layer(y7, 66, '⑦', '복구 규칙', '여유폭 W │ 재조정 기준 m │ rollback │ 재검토', '#e3f5ee', C.ok);
  b += arrow(cx, y6 + 66, cx, y7);
  // 피드백 루프
  b += `<path d="M ${bx} ${y7 + 33} L 44 ${y7 + 33} L 44 ${ys[0] + 33} L ${bx - 3} ${ys[0] + 33}" fill="none" stroke="${C.ok}" stroke-width="1.8" stroke-dasharray="6 4"/><polygon points="${bx},${ys[0] + 33} ${bx - 9},${ys[0] + 28} ${bx - 9},${ys[0] + 38}" fill="${C.ok}"/>` + rtext(36, (y7 + ys[0]) / 2 + 40, 'Feedback Loop: 데이터 · 추정 · 권한 보정', { size: 11.5, fill: C.ok, weight: 700, anchor: 'middle' }).replace('<text ', `<text transform="rotate(-90 36 ${(y7 + ys[0]) / 2 + 40})" `);
  // 우측: 제약 → D
  const rx = 640, rw = 290, cs = t.constraints || {};
  b += box(rx, 118, rw, 268, { fill: '#fff', stroke: C.ink }) + rtext(rx + 14, 142, '제약조건  g_{j}(x,s) ≤ c_{j}', { size: 14, weight: 700 });
  const rows = [['평균 손실', `L ≤ ${num(cs.loss_max)}`], ['손실 초과', `P(L>L_{max}) ≤ ${num(cs.loss_exceed_max)}`], ['정지 오판(FP)', `FP ≤ ${num(cs.fp_max)}`], ['정지 누락(FN)', `FN ≤ ${num(cs.fn_max)}`], ['검토부담', `B ≤ ${num(cs.review_burden_max)}`], ['복구시간', `T_{R} ≤ ${num(cs.recovery_time_max)}`]];
  rows.forEach((r, i) => { b += rtext(rx + 14, 172 + i * 28, r[0], { size: 12.5, fill: '#333' }) + rtext(rx + 130, 172 + i * 28, r[1], { size: 12.5, weight: 600 }); });
  b += rtext(rx + 14, 356, `신뢰수준 ${num(cs.confidence)} · 신뢰구간 상·하한으로 판정`, { size: 11.5, fill: C.mute });
  b += `<path d="M ${bx + bw} ${y6 + 33} L 612 ${y6 + 33} L 612 330 L ${rx - 4} 330" fill="none" stroke="${C.bad}" stroke-width="1.6" stroke-dasharray="6 4"/><polygon points="${rx},330 ${rx - 9},325 ${rx - 9},335" fill="${C.bad}"/>` + rtext(618, 322, '결과 평가', { size: 11, fill: C.bad, weight: 700 });
  b += arrow(rx + rw / 2, 386, rx + rw / 2, 440);
  b += box(rx, 440, rw, 190, { fill: '#e3f5ee', stroke: C.ok, sw: 2.2 }) + rtext(rx + rw / 2, 468, '위임 가능 영역  D', { size: 16, weight: 700, anchor: 'middle' }) + rtext(rx + rw / 2, 494, 'x = (σ, τ, α, K, d, W, m, E)', { size: 13, anchor: 'middle' }) + rtext(rx + rw / 2, 520, 'P[ g_{j}(x,S) ≤ c_{j} ] ≥ 1 − ε_{j}, ∀j', { size: 13, anchor: 'middle' }) + rtext(rx + rw / 2, 552, 'FEASIBLE · UNRESOLVED · INFEASIBLE', { size: 11.5, anchor: 'middle', fill: '#333' }) + rtext(rx + rw / 2, 574, 'Safety first → Minimax Regret second', { size: 12, anchor: 'middle', weight: 700, fill: C.ok }) + rtext(rx + rw / 2, 600, 'UNRESOLVED ≠ INFEASIBLE', { size: 11.5, anchor: 'middle', fill: C.bad, weight: 700 });
  b += rtext(rx + rw / 2, 668, '핵심 질문', { size: 12, anchor: 'middle', fill: C.mute }) + rtext(rx + rw / 2, 692, 'Where can authority', { size: 14, anchor: 'middle', weight: 700 }) + rtext(rx + rw / 2, 712, 'safely be delegated?', { size: 14, anchor: 'middle', weight: 700 });
  b += rtext(W / 2, H - 14, 'Noise → Estimation → Decision → Delegation → Execution → Recovery', { size: 12.5, anchor: 'middle', fill: C.mute });
  return wrap(W, H, b, '박사논문 연구모형: 데이터 결정 사슬과 위임 가능 영역');
}

export function figDcvDesign(t) {
  const W = 1040, H = 474, bw = 158, gap = 48, x0 = 32, y0 = 92, bh = 150; let b = '';
  const ap = t.approval, cands = t.candidates || { total: 0, by_class: {} }, rv = t.reviewer || { n: 0 }, vals = t.simulation?.validations || [];
  const nVal = vals.reduce((a, v) => a + (Number(v.n) || 0), 0);
  const stages = [
    { k: 'DEFINE', sub: 'RQ1 · 제1편', lines: ['연구문제·변수·제약 정의', '위임수준 K0–K3', '복구규칙 W·m'], gate: 'Gate D0–D6', col: C.blue, fill: '#e8f3fb', st: `정의 v${t.definition?.version ?? '-'}` },
    { k: 'COMPUTE', sub: 'RQ2 · 제2편', lines: ['CDRS 경계 탐색', '탐색/확인 시드 분리', 'Historical·Synthetic·Stress'], gate: 'Gate C1–C8', col: C.ok, fill: '#e3f5ee', st: `후보 ${cands.total} · 확정 ${cands.by_class?.confirmed || 0}` },
    { k: 'VALIDATE', sub: 'RQ3 · 제3편', lines: ['독립표본 · 두 번째 사례', '인간 검토자 실험', 'ARR · ERT · FAR'], gate: 'Gate V1–V6', col: C.warn, fill: '#fff4dc', st: `검증 ${nVal}건 · 검토 ${rv.n}건` },
    { k: 'RE-COMPUTE', sub: '인간 행동 재투입', lines: ['검토자 모형 교체', 'Perfect → Empirical', 'D(ideal) vs D(human)'], gate: 'CI 재판정', col: C.bad, fill: '#fde9e0', st: rv.n ? (t.reviewer.model_version != null ? `검토자 모형 v${t.reviewer.model_version}` : '검토자 모형 적용') : '검토자 모형 없음' },
    { k: 'CONFIRM', sub: '최종 확정', lines: ['D* 확정', 'Boundary / Prohibited 구분', 'Evidence Level A–D'], gate: 'Approve', col: '#6a3d9a', fill: '#f1e9f7', st: ap ? `${String(ap.decision).replace('_DELEGATION', '')} · Level ${ap.evidence_level}` : '미확정' }
  ];
  b += rtext(x0, 26, 'DCV-C 연구설계 (Define → Compute → Validate → Re-compute → Confirm)', { size: 15, weight: 700 });
  stages.forEach((s, i) => {
    const x = x0 + i * (bw + gap);
    b += box(x, y0, bw, bh, { fill: s.fill, stroke: s.col, sw: 2 }) + rtext(x + bw / 2, y0 + 26, s.k, { size: 15, weight: 700, anchor: 'middle', fill: s.col }) + rtext(x + bw / 2, y0 + 46, s.sub, { size: 11.5, anchor: 'middle', fill: '#333', weight: 600 });
    s.lines.forEach((l, j) => { b += rtext(x + bw / 2, y0 + 76 + j * 22, l, { size: 11.5, anchor: 'middle' }); });
    if (i < stages.length - 1) b += arrow(x + bw, y0 + bh / 2, x + bw + gap, y0 + bh / 2);
    // 게이트
    b += box(x + 14, y0 + bh + 26, bw - 28, 30, { rx: 15, fill: '#fff', stroke: s.col }) + rtext(x + bw / 2, y0 + bh + 46, s.gate, { size: 12.5, anchor: 'middle', weight: 700, fill: s.col }) + `<line x1="${x + bw / 2}" y1="${y0 + bh}" x2="${x + bw / 2}" y2="${y0 + bh + 26}" stroke="${s.col}" stroke-width="1.4"/>`;
    // 현재 상태
    b += box(x, 350, bw, 44, { rx: 6, fill: '#fafafa', stroke: C.grid }) + rtext(x + bw / 2, 368, '현재 프로젝트', { size: 10.5, anchor: 'middle', fill: C.mute }) + rtext(x + bw / 2, 385, s.st, { size: 11.5, anchor: 'middle', weight: 700 });
  });
  b += rtext(x0, y0 + bh + 84, '게이트 판정:', { size: 12.5, weight: 700 }) + rtext(x0 + 88, y0 + bh + 84, 'CONFIRM(다음 단계) │ REVISE(수정 후 재평가) │ HOLD(근거 부족, 보류) │ REJECT(후보·설계 제거)', { size: 12.5 });
  // 피드백 (인간행동 → Compute)
  const xv = x0 + 3 * (bw + gap) + bw / 2, xc = x0 + 1 * (bw + gap) + bw / 2;
  b += `<path d="M ${xv} ${y0} L ${xv} ${y0 - 26} L ${xc} ${y0 - 26} L ${xc} ${y0 - 2}" fill="none" stroke="${C.bad}" stroke-width="1.6" stroke-dasharray="6 4"/><polygon points="${xc},${y0} ${xc - 5},${y0 - 9} ${xc + 5},${y0 - 9}" fill="${C.bad}"/>` + rtext((xv + xc) / 2, y0 - 34, '폐쇄 루프: 실제 인간 행동(ARR·정정개입률·지연)을 Compute 모형에 재투입', { size: 11.5, anchor: 'middle', fill: C.bad, weight: 700 });
  b += rtext(W / 2, 424, '논문 1편 = Define (정식화) · 논문 2편 = Compute (계산·경계 검증) · 논문 3편 = Validate (외적 타당성·인간 행동)', { size: 12.5, anchor: 'middle', weight: 700 });
  b += rtext(W / 2, 448, '세 편은 동일한 수학적 객체 D (위임 가능 영역)를 공유: 제1편 정의 → 제2편 계산 → 제3편 재계산', { size: 12, anchor: 'middle', fill: C.mute });
  return wrap(W, H, b, 'DCV-C 연구설계와 게이트, 논문 3편의 대응');
}

export function figRegionConcept() {
  const W = 760, H = 520, m = { l: 96, r: 40, t: 50, b: 84 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
  const X = v => m.l + pw * v, Y = k => m.t + ph * (1 - k / 3.4);
  // 경계: σ 구간별 위임 가능한 최대 K (계단형)
  const ideal = [3, 3, 2, 2, 1, 0], human = [2, 2, 1, 1, 0, 0], n = ideal.length, sw = 1 / n;
  const stair = arr => { let d = `M ${X(0)} ${Y(arr[0] + .4)}`; arr.forEach((k, i) => { d += ` L ${X((i + 1) * sw)} ${Y(k + .4)}`; if (i < n - 1) d += ` L ${X((i + 1) * sw)} ${Y(arr[i + 1] + .4)}`; }); return d; };
  let b = '';
  b += `<rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="#fde9e0"/>`;
  const fill = (arr, col, op) => { let d = `M ${X(0)} ${Y(0)}`; arr.forEach((k, i) => { d += ` L ${X(i * sw)} ${Y(k + .4)} L ${X((i + 1) * sw)} ${Y(k + .4)}`; }); d += ` L ${X(1)} ${Y(0)} Z`; return `<path d="${d}" fill="${col}" fill-opacity="${op}"/>`; };
  b += fill(ideal, C.ok, .28) + fill(human, C.ok, .42);
  for (let k = 0; k <= 3; k++) b += `<line x1="${m.l}" x2="${m.l + pw}" y1="${Y(k)}" y2="${Y(k)}" stroke="${C.grid}"/>` + rtext(m.l - 12, Y(k) + 4, `K${k}`, { anchor: 'end', size: 13 });
  b += `<path d="${stair(ideal)}" fill="none" stroke="${C.ok}" stroke-width="2.6"/><path d="${stair(human)}" fill="none" stroke="${C.blue}" stroke-width="2.6" stroke-dasharray="7 4"/>`;
  b += `<line x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${m.t + ph}" stroke="${C.ink}"/><line x1="${m.l}" x2="${m.l + pw}" y1="${m.t + ph}" y2="${m.t + ph}" stroke="${C.ink}"/>`;
  b += rtext(m.l + pw / 2, H - 46, 'σ (정보오차)  →  커질수록 위임 가능 권한 K*(σ) 하락', { anchor: 'middle', size: 13.5, weight: 700 }) + rtext(28, m.t + ph / 2, '위임 권한 K', { anchor: 'middle', size: 13.5, weight: 700 }).replace('<text ', `<text transform="rotate(-90 28 ${m.t + ph / 2})" `);
  b += rtext(X(.04), Y(1.0), 'D(human): 실제 검토자 영역', { size: 12.5, weight: 700, fill: '#fff' }) + rtext(X(.04), Y(2.9), 'D(ideal): 이상적 검토자 영역', { size: 12.5, weight: 700, fill: '#00694e' }) + rtext(X(.62), Y(3.05), 'INFEASIBLE (금지 영역)', { size: 12.5, weight: 700, fill: C.bad });
  b += arrow(X(.50), Y(2.62), X(.60), Y(2.62), { stroke: C.mute }) + rtext(X(.615), Y(2.62) + 4, 'α, d, W 조정 → 경계 이동', { size: 11.5, fill: C.mute });
  b += legendRow(m.l, H - 18, [{ mark: `<line x1="0" x2="14" y1="0" y2="0" stroke="${C.ok}" stroke-width="2.6"/>`, label: '이상적 검토자 영역 경계', w: 150 }, { mark: `<line x1="0" x2="14" y1="0" y2="0" stroke="${C.blue}" stroke-width="2.6" stroke-dasharray="5 3"/>`, label: '실제 검토자 영역 경계 (P4: 변화 여부 검증 대상)', w: 330 }, { mark: `<rect width="12" height="12" y="-6" fill="#fde9e0"/>`, label: '제약 위반', w: 100 }]);
  b += rtext(W - m.r, 30, '※ 모식도: 실제 계산 결과가 아님', { size: 11.5, anchor: 'end', fill: C.mute });
  return wrap(W, H, b, '위임 가능 영역 개념도: 이상적 검토자와 실제 검토자');
}

const BUILDERS = { 1: figHeatmap, 2: figEstimators, 3: figRegret, 4: figReviewer, 5: figEpisodes, 6: figExternalValidationMatrix, 7: figDelegationEvidenceFunnel, 10: figFullBlueprint, 11: figResearchModel, 12: figDcvDesign, 13: figRegionConcept };
function figureErrorSvg(g,error){
  const W=1120,H=260,msg=`${g.label||g.n} figure temporarily unavailable`;
  return wrap(W,H,`<rect x="24" y="24" width="${W-48}" height="${H-48}" rx="10" fill="#f8fafc" stroke="#cbd5e1"/><text x="56" y="96" font-size="24" font-weight="700" fill="#17385e">${esc(msg)}</text><text x="56" y="136" font-size="15" fill="#64748b">${esc(g.title||'')}</text><text x="56" y="174" font-size="13" fill="#94a3b8">${esc(String(error?.message||error||'render_error').slice(0,140))}</text>`,msg);
}
export function buildFigures(t) {
  const out=[];
  for(const g of figureCatalog(t)){
    try{
      const builder=BUILDERS[g.n];
      if(!builder) throw new Error(`builder_missing_${g.n}`);
      const svg=builder(t||{}),m=/viewBox="0 0 (\d+) (\d+)"/.exec(svg||'');
      if(!m) throw new Error(`invalid_svg_${g.n}`);
      out.push({...g,svg,width:+m[1],height:+m[2],render_status:'ok'});
    }catch(error){
      const svg=figureErrorSvg(g,error),m=/viewBox="0 0 (\d+) (\d+)"/.exec(svg);
      out.push({...g,svg,width:+m[1],height:+m[2],render_status:'fallback',render_error:String(error?.message||error)});
    }
  }
  return out;
}
