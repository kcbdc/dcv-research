import { all, one, run, audit, enqueue } from './db.js';
import { nowIso, uid, mulberry32, quantile, safeJson } from './util.js';
import { latestDefinition } from './define.js';
import { bust } from './memo.js';

function metrics(rows){
  const correct=rows.filter(r=>Number(r.ai_correct)===1), wrong=rows.filter(r=>Number(r.ai_correct)===0);
  const n=Math.max(1,rows.length), wc=Math.max(1,wrong.length), cc=Math.max(1,correct.length);
  const correctAccept=correct.filter(r=>Number(r.human_accept)===1).length/cc;
  const correctOverride=wrong.filter(r=>Number(r.human_accept)===0).length/wc;
  const falseAccept=wrong.filter(r=>Number(r.human_accept)===1).length/wc;
  const unnecessaryOverride=correct.filter(r=>Number(r.human_accept)===0).length/cc;
  const meanDelay=rows.reduce((a,r)=>a+Number(r.response_ms||0),0)/n/1000;
  const recovered=wrong.filter(r=>Number(r.recovered)===1), recoveryTime=recovered.length?recovered.reduce((a,r)=>a+Number(r.recovery_ms||0),0)/recovered.length/1000:null;
  const arr=(correct.filter(r=>Number(r.human_accept)===1).length+wrong.filter(r=>Number(r.human_accept)===0).length)/n;
  return {n:rows.length,correct_n:correct.length,wrong_n:wrong.length,appropriate_reliance_rate:arr,correct_accept_rate:correctAccept,correct_override_rate:correctOverride,false_accept_rate:falseAccept,unnecessary_override_rate:unnecessaryOverride,mean_delay:meanDelay,error_recovery_time:recoveryTime};
}
function clusterBootstrap(rows,B=300,seed=20260930){
  const groups=new Map(); for(const r of rows){const k=String(r.participant_hash||'anon');if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
  const ids=[...groups.keys()]; if(ids.length<2)return{status:'HOLD',participants:ids.length,B:0};
  const rng=mulberry32(seed), draws=[];
  for(let b=0;b<B;b++){
    const sample=[];for(let i=0;i<ids.length;i++){const id=ids[Math.floor(rng()*ids.length)];sample.push(...groups.get(id));}
    draws.push(metrics(sample));
  }
  const interval=k=>{const xs=draws.map(x=>Number(x[k])).filter(Number.isFinite);return{lo:quantile(xs,.025),median:quantile(xs,.5),hi:quantile(xs,.975)};};
  return {status:'CONFIRM',participants:ids.length,B,seed,ci95:{appropriate_reliance_rate:interval('appropriate_reliance_rate'),false_accept_rate:interval('false_accept_rate'),correct_override_rate:interval('correct_override_rate'),unnecessary_override_rate:interval('unnecessary_override_rate'),mean_delay:interval('mean_delay')}};
}

export function clusterBootstrapGrouped(rows,B=300){
 const groups=new Map();for(const r of rows){const id=r.ph||'anon',g=groups.get(id)||{n:0,appropriate:0,wrong_n:0,acc_w:0,correct_n:0,right_override:0,rt:0};for(const k of Object.keys(g))g[k]+=Number(r[k]||0);groups.set(id,g);}
 const gs=[...groups.values()];if(gs.length<2)return {status:'HOLD',B:0,participants:gs.length};
 const rng=mulberry32(20261002),draws=[];
 for(let b=0;b<B;b++){const s={n:0,appropriate:0,wrong_n:0,acc_w:0,correct_n:0,right_override:0,rt:0};for(let i=0;i<gs.length;i++){const g=gs[Math.floor(rng()*gs.length)];for(const k of Object.keys(s))s[k]+=g[k];}draws.push({appropriate_reliance_rate:s.appropriate/s.n,false_accept_rate:s.wrong_n?s.acc_w/s.wrong_n:null,correct_override_rate:s.wrong_n?1-s.acc_w/s.wrong_n:null,unnecessary_override_rate:s.correct_n?s.right_override/s.correct_n:null,mean_delay:s.rt/s.n/1000});}
 const ci95={};for(const k of Object.keys(draws[0])){const values=draws.map(d=>d[k]).filter(v=>v!=null&&Number.isFinite(v));ci95[k]={lo:quantile(values,.025),hi:quantile(values,.975)};}
 return {status:'DESCRIPTIVE_ONLY',B,participants:gs.length,ci95,scope:'Participant-resampled descriptive intervals; sample-size gates and design validity are separate'};
}

export async function fitReviewerModel(env,projectId){
  let rows=await all(env.DB,`SELECT * FROM reviewer_observations WHERE project_id=? ORDER BY created_at DESC LIMIT 10000`,[projectId]);
  const p=await one(env.DB,`SELECT research_cycle,evidence_revision FROM projects WHERE id=?`,[projectId]);
  const def=await latestDefinition(env,projectId),v=def?.content?.validation||{};
  const lastObserved=rows[0]?.created_at??'';
  const countBy=new Map(),cap=Math.max(1,Math.min(30,Number(v.max_trials_per_participant||30)));
  rows=rows.reverse().filter(r=>{const rp=safeJson(r.context_json).protocol||null;if(v.human_protocol&&rp&&rp!==v.human_protocol)return false;const id=r.participant_hash||'anon',n=countBy.get(id)||0;countBy.set(id,n+1);return id!=='anon'&&n<cap;});
  const minParticipants=Number(v.min_human_participants||30),minCorrect=Number(v.min_human_correct_trials||60),minWrong=Number(v.min_human_wrong_trials||60),B=Math.max(300,Math.min(1000,Number(v.cluster_bootstrap_n||300)));
  const participantN=new Set(rows.map(r=>String(r.participant_hash||'anon'))).size,correctN=rows.filter(r=>Number(r.ai_correct)===1).length,wrongN=rows.filter(r=>Number(r.ai_correct)===0).length;
  const gate={participants:{observed:participantN,required:minParticipants,pass:participantN>=minParticipants},correct_trials:{observed:correctN,required:minCorrect,pass:correctN>=minCorrect},wrong_trials:{observed:wrongN,required:minWrong,pass:wrongN>=minWrong}};
  const diagnosticCluster=clusterBootstrap(rows,B,20260930);
  if(!Object.values(gate).every(x=>x.pass)){
    // 새 관측이 들어오기 전에는 같은 판정이 반복되므로, 마지막으로 본 관측 시각을 기록해 advanceProject 가 재시도하지 않게 한다.
    await run(env.DB,`UPDATE projects SET reviewer_hold_marker=? WHERE id=?`,[lastObserved,projectId]);
    await audit(env,projectId,'agent','reviewer.fit.hold','project',projectId,{n:rows.length,gate,reason:'human_validation_sample_gate',cluster_bootstrap:diagnosticCluster});
    return {status:'HOLD',n:rows.length,participants:participantN,gate,cluster_bootstrap:diagnosticCluster};
  }
  const point=metrics(rows),cluster=clusterBootstrap(rows,B,20260930),legacyUntagged=rows.filter(r=>!safeJson(r.context_json).protocol).length,model={...point,participants:participantN,human_protocol:v.human_protocol||null,legacy_untagged_trials:legacyUntagged,last_observed_at:lastObserved,cluster_bootstrap:cluster,sample_gate:gate,unit_of_inference:'participant-cluster bootstrap; repeated trials are not treated as independent participants'};
  const ver=await one(env.DB,`SELECT COALESCE(MAX(version),0) v FROM reviewer_models WHERE project_id=?`,[projectId]);
  const id=uid('reviewermodel'); await run(env.DB,`INSERT INTO reviewer_models(id,project_id,version,model_json,created_at,research_cycle,evidence_revision) VALUES(?,?,?,?,?,?,?)`,[id,projectId,(ver?.v||0)+1,JSON.stringify(model),nowIso(),Number(p?.research_cycle||1),Number(p?.evidence_revision||0)]);
  bust(env,projectId,'reviewer:latest');
  await audit(env,projectId,'agent','reviewer.fit.complete','reviewer_model',id,model);
  await enqueue(env,projectId,'recompute_project',{},65);
  return {status:'CONFIRM',id,model};
}

export const __test={metrics,clusterBootstrap};
