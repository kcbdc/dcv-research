import { one, run, audit, enqueueOnce } from './db.js';
import { nowIso, uid } from './util.js';
import { bust } from './memo.js';

const STAGES=['define','measure','compute','validate','recompute','approved','report'];
export function impactForEvidence(kind){
  const k=String(kind||'').toUpperCase();
  if(k==='HUMAN_TRIAL'||k==='HUMAN_REVIEW'||k==='REVERIFICATION_REVIEW') return 'validate';
  if(k==='RAW_OBSERVATION'||k==='EXTERNAL_DATA'||k==='EMPIRICAL_EPISODE') return 'measure';
  if(k==='SCENARIO'||k==='BENCHMARK_UPDATE') return 'compute';
  if(k==='DESIGN_CHANGE'||k==='CONSTRAINT_CHANGE'||k==='RQ_CHANGE') return 'define';
  return 'validate';
}
function earlierStage(a,b){
  const ia=STAGES.indexOf(a),ib=STAGES.indexOf(b); if(ia<0)return b;if(ib<0)return a;return ia<=ib?a:b;
}
async function snapshot(env,p,reason,nextRevision,nextCycle){
  const counts=await one(env.DB,`SELECT COUNT(*) candidates,
    (SELECT COUNT(*) FROM simulation_runs WHERE project_id=?) runs,
    (SELECT COUNT(*) FROM validations WHERE project_id=?) validations,
    (SELECT COUNT(*) FROM approvals WHERE project_id=?) approvals,
    (SELECT COUNT(*) FROM reports WHERE project_id=?) reports
    FROM design_candidates WHERE project_id=? AND research_cycle=?`,[p.id,p.id,p.id,p.id,p.id,p.research_cycle]);
  const snap={project_status:p.status,current_stage:p.current_stage,research_cycle:Number(p.research_cycle||1),evidence_revision:Number(p.evidence_revision||0),counts};
  await run(env.DB,`INSERT INTO evidence_snapshots(id,project_id,research_cycle,evidence_revision,reason,snapshot_json,created_at) VALUES(?,?,?,?,?,?,?)`,[uid('snapshot'),p.id,Number(p.research_cycle||1),nextRevision,reason,JSON.stringify(snap),nowIso()]);
}
export async function registerEvidence(env,projectId,{kind,impact_from=null,source='user',detail={},force_new_cycle=false,config_update=null}={}){
  const p=await one(env.DB,`SELECT * FROM projects WHERE id=?`,[projectId]);if(!p)throw new Error('project_not_found');
  const impact=impact_from||impactForEvidence(kind);
  const started=await one(env.DB,`SELECT 1 x FROM design_candidates WHERE project_id=? AND research_cycle=? LIMIT 1`,[projectId,Number(p.research_cycle||1)]);
  const fullCycle=!!started && (force_new_cycle||['define','measure','compute'].includes(impact));
  const nextRevision=Number(p.evidence_revision||0)+1,nextCycle=Number(p.research_cycle||1)+(fullCycle?1:0),ts=nowIso();
  if(fullCycle) await snapshot(env,p,`${kind}:${impact}`,nextRevision,nextCycle);
  // Use the pipeline's *current* progress plus the new impact. Do not keep an old
  // revalidation_from forever: once DEFINE/MEASURE/COMPUTE have already been replayed, a new
  // human observation should reopen VALIDATE onward, not rewind the project to DEFINE again.
  const from=earlierStage(p.current_stage||impact,impact);
  await env.DB.batch([
    ...(config_update?[env.DB.prepare('UPDATE project_config SET design_json=?,benchmark_json=?,validation_json=? WHERE project_id=?').bind(JSON.stringify(config_update.design),JSON.stringify(config_update.benchmark),JSON.stringify(config_update.validation),projectId)]:[]),
    env.DB.prepare(`UPDATE projects SET evidence_revision=?,research_cycle=?,revalidation_from=?,approval_stale=1,last_evidence_at=?,status='revalidating',current_stage=?,reviewer_hold_marker=NULL,candidate_count=CASE WHEN ? THEN 0 ELSE candidate_count END,updated_at=? WHERE id=?`).bind(nextRevision,nextCycle,from,ts,from,fullCycle?1:0,ts,projectId),
    env.DB.prepare(`UPDATE approvals SET stale_at=COALESCE(stale_at,?),stale_reason=COALESCE(stale_reason,?) WHERE project_id=? AND stale_at IS NULL`).bind(ts,`${kind}:${impact}`,projectId),
    env.DB.prepare(`UPDATE reports SET stale_at=COALESCE(stale_at,?),stale_reason=COALESCE(stale_reason,?) WHERE project_id=? AND stale_at IS NULL`).bind(ts,`${kind}:${impact}`,projectId),
    env.DB.prepare(`INSERT INTO evidence_events(id,project_id,evidence_revision,research_cycle,evidence_kind,impact_from,source,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).bind(uid('evidence'),projectId,nextRevision,nextCycle,String(kind||'UNKNOWN'),impact,String(source||''),JSON.stringify(detail||{}),ts)
  ]);
  if(fullCycle){
    await run(env.DB,`UPDATE jobs SET status='failed',last_error='superseded_by_evidence_revision',updated_at=? WHERE project_id=? AND status IN ('queued','running') AND type IN ('seed_candidates','compute_candidate','validate_project','fit_reviewer','recompute_project','finalize_recompute','approve_project','generate_report')`,[ts,projectId]);
  }
  // Validation-layer evidence must resume through the orchestrator rather than jumping
  // directly to G4.  The old path enqueued fit_reviewer for every HUMAN_TRIAL even when
  // current-cycle G3 robust validation was stale/incomplete, which could produce the
  // impossible UI state G3=WAIT, G4=PASS and leave G5 with no robust candidates to recompute.
  // advance_project enforces G1 -> G2 -> G3 -> G4 -> G5 ordering and coalesces bursts of
  // human observations into one downstream refresh.
  if(impact==='validate') await enqueueOnce(env,projectId,'advance_project',{},58,1);
  else if(impact==='measure') await enqueueOnce(env,projectId,'measure_project',{},30,1);
  else if(impact==='compute') await enqueueOnce(env,projectId,'seed_candidates',{},35,1);
  else await enqueueOnce(env,projectId,'define_project',{},10,1);
  bust(env,projectId);
  await audit(env,projectId,'agent','evidence.registered','project',projectId,{kind,impact,source,nextRevision,nextCycle,fullCycle,detail});
  return{evidence_revision:nextRevision,research_cycle:nextCycle,impact_from:impact,full_cycle:fullCycle};
}

export async function approvalGates(env,projectId){
  const p=await one(env.DB,`SELECT * FROM projects WHERE id=?`,[projectId]);if(!p)return null;
  const cycle=Number(p.research_cycle||1),rev=Number(p.evidence_revision||0);
  const protocol=await one(env.DB,`SELECT id,protocol_hash FROM research_protocols WHERE project_id=? AND research_cycle=? ORDER BY version DESC LIMIT 1`,[projectId,cycle]);
  const compute=await one(env.DB,`SELECT 1 x FROM design_candidates WHERE project_id=? AND research_cycle=? AND status='confirmed_feasible' LIMIT 1`,[projectId,cycle]);
  const robust=await one(env.DB,`SELECT 1 x FROM validations v JOIN design_candidates c ON c.id=v.candidate_id WHERE v.project_id=? AND c.research_cycle=? AND v.validation_type='robust' AND v.status='CONFIRM' LIMIT 1`,[projectId,cycle]);
  const reviewer=await one(env.DB,`SELECT 1 x FROM reviewer_models WHERE project_id=? AND research_cycle=? AND evidence_revision=? LIMIT 1`,[projectId,cycle,rev]);
  const recompute=await one(env.DB,`SELECT 1 x FROM validations v JOIN design_candidates c ON c.id=v.candidate_id WHERE v.project_id=? AND c.research_cycle=? AND v.evidence_revision=? AND v.validation_type='human_recompute' AND v.status='CONFIRM' LIMIT 1`,[projectId,cycle,rev]);
  const signoff=await one(env.DB,`SELECT 1 x FROM approvals WHERE project_id=? AND research_cycle=? AND evidence_revision=? AND decision='SCIENTIFICALLY_APPROVED' AND stale_at IS NULL LIMIT 1`,[projectId,cycle,rev]);

  // Gate status is dependency-ordered.  Persisted downstream artifacts may still exist from a
  // prior/stale path, but they cannot make a later gate PASS while a prerequisite gate is WAIT.
  const g1=!!protocol;
  const g2=g1&&!!compute;
  const g3=g2&&!!robust;
  const g4=g3&&!!reviewer;
  const g5=g4&&!!recompute;
  const g6=g5&&!!signoff;
  const gates=[
    {id:'G1',name:'Protocol Frozen',status:g1?'PASS':'WAIT'},
    {id:'G2',name:'Compute Confirmed',status:g2?'PASS':'WAIT'},
    {id:'G3',name:'Robust Validation',status:g3?'PASS':'WAIT'},
    {id:'G4',name:'Human Validation',status:g4?'PASS':'WAIT'},
    {id:'G5',name:'Recompute Confirmed',status:g5?'PASS':'WAIT'},
    {id:'G6',name:'Scientific Sign-off',status:g6?'PASS':'WAIT'}
  ];

  // For the UI, report the next unresolved checkpoint rather than a stale historical origin.
  // This prevents messages such as "DEFINE부터 재검증" after G1/G2 have already passed.
  let revalidationFrom=null;
  if(p.approval_stale){
    if(!g1) revalidationFrom='define';
    else if(!g2) revalidationFrom='compute';
    else if(!g3) revalidationFrom='validate';
    else if(!g4) revalidationFrom='validate';
    else if(!g5) revalidationFrom='recompute';
    else if(!g6) revalidationFrom='approved';
  }
  return{research_cycle:cycle,evidence_revision:rev,stale:!!p.approval_stale,revalidation_from:revalidationFrom,gates,passed:gates.filter(g=>g.status==='PASS').length,total:gates.length};
}

