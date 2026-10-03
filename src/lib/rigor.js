import { one, all, run, audit } from './db.js';
import { latestDefinition } from './define.js';
import { empiricalReadiness, loadEmpiricalCalibration } from './empirical.js';
import { nowIso, uid, stableStringify, sha256Hex, safeJson } from './util.js';
import { cached, bust } from './memo.js';

export async function buildProtocol(env,projectId){
  const def=await latestDefinition(env,projectId); if(!def) throw new Error('definition_missing');
  const empirical=await empiricalReadiness(env,projectId), cal=await loadEmpiricalCalibration(env,projectId);
  const design=def.content.design||{}, constraints=def.content.constraints||{}, validation=def.content.validation||{};
  const p=await one(env.DB,`SELECT research_cycle FROM projects WHERE id=?`,[projectId]); const cycle=Number(p?.research_cycle||1);
  const candidates=await all(env.DB,`SELECT sigma,tau,alpha,authority_k,delay_d,recovery_w,adjust_m,estimator,base_id,pair_seed_key,candidate_role FROM design_candidates WHERE project_id=? AND research_cycle=? ORDER BY sigma,tau,alpha,authority_k,delay_d,recovery_w,adjust_m,estimator`,[projectId,cycle]);
  const actualPlan=candidates.map(c=>[Number(c.sigma),Number(c.tau),Number(c.alpha),Number(c.authority_k),Number(c.delay_d),Number(c.recovery_w),Number(c.adjust_m),String(c.estimator),c.base_id||null,c.pair_seed_key||null,c.candidate_role||'exploratory']);
  return {
    schema:'DCV-PROTOCOL-1.2',engine_version:'DCV-CDRS-v3',confidence_method:def.content.benchmark?.confidence_method||'residual_common_v1',noninferiority:def.content.benchmark?.noninferiority||null,human_protocol:validation.human_protocol||'legacy' , project_id:projectId, research_cycle:cycle, definition_version:def.version,
    research_question:def.content.research_question,
    design_space:design,
    actual_candidate_plan:{count:actualPlan.length,tuples:actualPlan},
    constraints,
    estimators:design.estimators||[],
    statistical_plan:{
      exploration:'adaptive boundary search; not confirmatory',
      confirmation:'independent deterministic seed family',
      multiplicity_method:validation.multiplicity_method||'bonferroni',
      familywise_confidence:Number(validation.familywise_confidence||constraints.confidence||.95),
      family_size:Number(design.max_candidates||128),
      constraint_family:['loss_exceed_rate','fp_rate','fn_rate','review_burden','recovery_time'],
      unresolved_rule:'UNRESOLVED is not INFEASIBLE',
      selection_rule:'robust feasibility first; minimax regret second'
    },
    empirical_anchor:{
      readiness:empirical.status,panel_n:empirical.complete_rows,target_n:empirical.target_rows,verified_n:empirical.verified_rows,
      profile:cal.profile?.version,coefficients:cal.coeff,
      loss_proxy:cal.loss?{c_fp:cal.loss.c_fp,c_fn:cal.loss.c_fn,c_fp_low:cal.loss.c_fp_low,c_fp_high:cal.loss.c_fp_high,c_fn_low:cal.loss.c_fn_low,c_fn_high:cal.loss.c_fn_high,normalization:cal.loss.normalization,identification_status:cal.loss.identification_status}:null,
      loss_identification:cal.loss?.identification_status||'UNKNOWN'
    },
    claim_scope:{
      supports:['conditional delegation-region identification under explicit constraints','comparative robustness across declared scenarios','ordinal candidate selection within the model'],
      does_not_support:['causal effect of delegation','externally calibrated absolute crisis probability','universally optimal public-payment threshold','directly identified social welfare cost of FP/FN']
    }
  };
}

export async function ensureFrozenProtocol(env,projectId){
  const protocol=await buildProtocol(env,projectId), hash=await sha256Hex(stableStringify(protocol));
  const p=await one(env.DB,`SELECT research_cycle FROM projects WHERE id=?`,[projectId]); const cycle=Number(p?.research_cycle||1);
  const latest=await one(env.DB,`SELECT * FROM research_protocols WHERE project_id=? AND research_cycle=? ORDER BY version DESC LIMIT 1`,[projectId,cycle]);
  if(latest){
    if(latest.protocol_hash===hash) return {...latest,protocol:safeJson(latest.protocol_json,{})};
    // 해시가 달라졌을 때만, 그리고 COUNT(*) 대신 존재 여부(LIMIT 1)만 확인한다.
    const started=await one(env.DB,`SELECT 1 x FROM simulation_runs WHERE project_id=? AND research_cycle=? LIMIT 1`,[projectId,cycle]);
    if(started) throw new Error('protocol_drift_after_simulation_start');
  }
  const id=uid('protocol'),ts=nowIso();
  // UNIQUE(project_id,version) spans every research cycle. Allocate within the INSERT to avoid races.
  const inserted=await one(env.DB,`INSERT INTO research_protocols(id,project_id,version,definition_version,status,protocol_json,protocol_hash,frozen_at,created_at,research_cycle) SELECT ?,?,COALESCE(MAX(version),0)+1,?,?,?,?,?,?,? FROM research_protocols WHERE project_id=? RETURNING version`,[id,projectId,protocol.definition_version,'FROZEN',JSON.stringify(protocol),hash,ts,ts,cycle,projectId]);
  const version=Number(inserted.version);
  bust(env,projectId);
  await audit(env,projectId,'agent','protocol.frozen','research_protocol',id,{version,hash,definition_version:protocol.definition_version});
  return {id,project_id:projectId,version,definition_version:protocol.definition_version,status:'FROZEN',protocol_json:JSON.stringify(protocol),protocol_hash:hash,frozen_at:ts,protocol};
}

// 무결성 검증(buildProtocol: 후보 128행 + 에폭 패널 + 보정계수 재조회)은 compute_candidate 1건마다 수행되어
// 작업당 수백 행을 읽었다. 같은 isolate 에서 같은 protocol_hash 를 검증한 지 INTEGRITY_TTL_MS 이내이면 재검증을 건너뛴다.
// 동결된 해시 자체는 매번 1행(해시 컬럼만)으로 확인하므로 새 프로토콜 버전이 생기면 즉시 재검증된다.
const INTEGRITY_TTL_MS=10*60*1000;
export async function assertProtocolIntegrity(env,projectId,context={}){
  const cycle=context.cycle==null?Number((await one(env.DB,`SELECT research_cycle FROM projects WHERE id=?`,[projectId]))?.research_cycle||1):Number(context.cycle||1);
  const head=await cached(env,projectId,`integrity-head:${cycle}`,()=>one(env.DB,`SELECT protocol_hash FROM research_protocols WHERE project_id=? AND research_cycle=? ORDER BY version DESC LIMIT 1`,[projectId,cycle]),INTEGRITY_TTL_MS);
  if(!head) return ensureFrozenProtocol(env,projectId);
  const ok=await cached(env,projectId,`integrity:${head.protocol_hash}`,async()=>{
    const latest=await one(env.DB,`SELECT * FROM research_protocols WHERE project_id=? AND research_cycle=? ORDER BY version DESC LIMIT 1`,[projectId,cycle]);
    const current=await buildProtocol(env,projectId), hash=await sha256Hex(stableStringify(current));
    if(hash!==latest.protocol_hash) throw new Error('protocol_integrity_failure');
    return {...latest,protocol:safeJson(latest.protocol_json,{})};
  },INTEGRITY_TTL_MS);
  return ok;
}

export async function latestProtocol(env,projectId){
  const p=await one(env.DB,`SELECT research_cycle FROM projects WHERE id=?`,[projectId]); const cycle=Number(p?.research_cycle||1);
  const r=await one(env.DB,`SELECT * FROM research_protocols WHERE project_id=? AND research_cycle=? ORDER BY version DESC LIMIT 1`,[projectId,cycle]);
  return r?{...r,protocol:safeJson(r.protocol_json,{})}:null;
}

export async function recordRigorCheck(env,projectId,checkType,status,result){
  const id=uid('rigor'); await run(env.DB,`INSERT INTO rigor_checks(id,project_id,check_type,status,result_json,created_at) VALUES(?,?,?,?,?,?)`,[id,projectId,checkType,status,JSON.stringify(result),nowIso()]);
  await audit(env,projectId,'agent',`rigor.${checkType}`,'rigor_check',id,{status,...result}); return {id,status,...result};
}
