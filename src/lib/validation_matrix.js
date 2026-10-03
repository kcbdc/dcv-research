import { all, one } from './db.js';
import { nowIso, uid, safeJson } from './util.js';

const DIMS=['Synthetic','Historical','Adversarial','BIS','ECB','Human'];
const classStatus=v=>v==='FEASIBLE'?'PASS':v==='INFEASIBLE'?'FAIL':v==='UNRESOLVED'?'HOLD':'NA';
const validationStatus=v=>v==='CONFIRM'?'PASS':v==='REJECT'?'FAIL':v==='HOLD'?'HOLD':'NA';
function overall(row){
  const xs=DIMS.map(k=>row[k.toLowerCase()+'_status']).filter(x=>x&&x!=='NA');
  if(xs.includes('FAIL'))return 'FAIL';
  if(xs.includes('HOLD'))return 'HOLD';
  if(xs.length===DIMS.length&&xs.every(x=>x==='PASS'))return 'PASS';
  if(xs.length)return 'PARTIAL';
  return 'NA';
}
function latestByCandidate(rows){const m=new Map();for(const r of rows)if(!m.has(`${r.candidate_id}|${r.phase}`))m.set(`${r.candidate_id}|${r.phase}`,r);return m;}
export async function refreshValidationMatrix(env,projectId){
  const p=await one(env.DB,`SELECT research_cycle,evidence_revision FROM projects WHERE id=?`,[projectId]);
  if(!p)throw new Error('project_not_found');
  const cycle=Number(p.research_cycle||1),rev=Number(p.evidence_revision||0);
  const cands=await all(env.DB,`SELECT id FROM design_candidates WHERE project_id=? AND research_cycle=? ORDER BY id`,[projectId,cycle]);
  if(!cands.length)return {rows:0,cycle,revision:rev};
  const runs=await all(env.DB,`SELECT r.candidate_id,r.phase,r.result_json FROM simulation_runs r WHERE r.project_id=? AND r.research_cycle=? AND r.phase IN ('confirmation','historical','stress') ORDER BY r.created_at DESC`,[projectId,cycle]);
  const runMap=latestByCandidate(runs);
  const humans=await all(env.DB,`SELECT candidate_id,status,result_json FROM validations WHERE project_id=? AND evidence_revision=? AND validation_type='human_recompute' ORDER BY created_at DESC`,[projectId,rev]);
  const humanMap=new Map();for(const h of humans)if(!humanMap.has(h.candidate_id))humanMap.set(h.candidate_id,h);
  const ts=nowIso(),stmts=[];let pass=0,fail=0,hold=0,partial=0;
  for(const c of cands){
    const conf=safeJson(runMap.get(`${c.id}|confirmation`)?.result_json,{}),hist=safeJson(runMap.get(`${c.id}|historical`)?.result_json,{}),stress=safeJson(runMap.get(`${c.id}|stress`)?.result_json,{}),h=humanMap.get(c.id);
    const groups=stress.validation_groups||{};
    const row={
      synthetic_status:classStatus(conf.validation_groups?.Synthetic?.classification||conf.classification),
      historical_status:classStatus(hist.validation_groups?.Historical?.classification||hist.classification),
      adversarial_status:classStatus(groups.Adversarial?.classification),
      bis_status:classStatus(groups.BIS?.classification),
      ecb_status:classStatus(groups.ECB?.classification),
      human_status:h?validationStatus(h.status):'NA'
    };
    row.overall_status=overall(row);
    if(row.overall_status==='PASS')pass++;else if(row.overall_status==='FAIL')fail++;else if(row.overall_status==='HOLD')hold++;else partial++;
    const detail={synthetic:conf.validation_groups?.Synthetic||null,historical:hist.validation_groups?.Historical||null,adversarial:groups.Adversarial||null,bis:groups.BIS||null,ecb:groups.ECB||null,human:h?{status:h.status,result:safeJson(h.result_json,{})}:null};
    stmts.push(env.DB.prepare(`INSERT INTO candidate_validation_matrix(id,project_id,candidate_id,research_cycle,evidence_revision,synthetic_status,historical_status,adversarial_status,bis_status,ecb_status,human_status,overall_status,detail_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,candidate_id,research_cycle,evidence_revision) DO UPDATE SET synthetic_status=excluded.synthetic_status,historical_status=excluded.historical_status,adversarial_status=excluded.adversarial_status,bis_status=excluded.bis_status,ecb_status=excluded.ecb_status,human_status=excluded.human_status,overall_status=excluded.overall_status,detail_json=excluded.detail_json,updated_at=excluded.updated_at`).bind(uid('vmat'),projectId,c.id,cycle,rev,row.synthetic_status,row.historical_status,row.adversarial_status,row.bis_status,row.ecb_status,row.human_status,row.overall_status,JSON.stringify(detail),ts));
  }
  for(let i=0;i<stmts.length;i+=50)await env.DB.batch(stmts.slice(i,i+50));
  return {rows:cands.length,pass,fail,hold,partial,cycle,revision:rev};
}
async function matrixRows(env,projectId,cycle,rev){
  return all(env.DB,`SELECT m.*,c.estimator,c.sigma,c.alpha,c.authority_k,c.delay_d,c.max_regret,c.status candidate_status FROM candidate_validation_matrix m JOIN design_candidates c ON c.id=m.candidate_id WHERE m.project_id=? AND m.research_cycle=? AND m.evidence_revision=? ORDER BY CASE m.overall_status WHEN 'PASS' THEN 1 WHEN 'PARTIAL' THEN 2 WHEN 'HOLD' THEN 3 WHEN 'FAIL' THEN 4 ELSE 5 END, COALESCE(c.max_regret,999999),c.authority_k DESC,c.sigma`,[projectId,cycle,rev]);
}
export async function getValidationMatrix(env,projectId){
  const p=await one(env.DB,`SELECT name,research_cycle,evidence_revision FROM projects WHERE id=?`,[projectId]);if(!p)throw new Error('project_not_found');
  const currentCycle=Number(p.research_cycle||1),currentRev=Number(p.evidence_revision||0);
  let cycle=currentCycle,rev=currentRev,rows=await matrixRows(env,projectId,cycle,rev),stale=false,snapshotUpdatedAt=null;
  if(!rows.length){
    const snap=await one(env.DB,`SELECT research_cycle,evidence_revision,MAX(updated_at) updated_at FROM candidate_validation_matrix WHERE project_id=? AND (research_cycle<? OR (research_cycle=? AND evidence_revision<?)) GROUP BY research_cycle,evidence_revision ORDER BY research_cycle DESC,evidence_revision DESC LIMIT 1`,[projectId,currentCycle,currentCycle,currentRev]);
    if(snap){ cycle=Number(snap.research_cycle||1);rev=Number(snap.evidence_revision||0);snapshotUpdatedAt=snap.updated_at||null;rows=await matrixRows(env,projectId,cycle,rev);stale=rows.length>0; }
  }
  if(!snapshotUpdatedAt&&rows.length)snapshotUpdatedAt=rows.reduce((m,r)=>String(r.updated_at||'')>String(m||'')?r.updated_at:m,null);
  const summary={total:rows.length,PASS:0,PARTIAL:0,HOLD:0,FAIL:0,NA:0,dimensions:{}};
  for(const k of DIMS)summary.dimensions[k]={PASS:0,HOLD:0,FAIL:0,NA:0};
  for(const r of rows){summary[r.overall_status]=(summary[r.overall_status]||0)+1;for(const k of DIMS){const s=r[k.toLowerCase()+'_status']||'NA';summary.dimensions[k][s]=(summary.dimensions[k][s]||0)+1;}}
  return {project_id:projectId,project_name:p.name||projectId,cycle,revision:rev,current_cycle:currentCycle,current_revision:currentRev,stale,stale_reason:stale?'CURRENT_REVISION_REVALIDATION_PENDING':null,snapshot_updated_at:snapshotUpdatedAt,served_at:nowIso(),generated_at:snapshotUpdatedAt||nowIso(),basis:stale?'LAST_KNOWN_VALID_SNAPSHOT':'CURRENT_PROJECT_ONLY',dimensions:DIMS,summary,rows:rows.map(r=>({...r,detail:safeJson(r.detail_json,{})}))};
}
