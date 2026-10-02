import {applyRedesign} from './lib/redesign.js';
import {createHumanTrial,recordHumanTrial} from './lib/human_trials.js';
import { json, nowIso, uid, safeJson } from './lib/util.js';
import { requireAdmin } from './lib/auth.js';
import { all, one, run, enqueue, enqueueOnce, audit } from './lib/db.js';
import { bust } from './lib/memo.js';
import { processJobs, processFastLane, scheduleAll, advanceProject } from './lib/orchestrator.js';
import { dispatchGithubActionsIfNeeded, githubRunnerStatus } from './lib/github_dispatch.js';
import { generateReport, upgradeStoredReport } from './lib/report.js';
import { buildThesisData, exportCsv, EXPORT_NAMES } from './lib/thesis.js';
import { aiJson } from './lib/ai.js';
import { empiricalReadiness, ensureEmpiricalProfile, importEmpiricalEpisodes, refitEmpiricalCalibration, loadEmpiricalCalibration, seedBundledEmpiricalPanel } from './lib/empirical.js';
import { scientificSignoff } from './lib/approve.js';
import { latestProtocol } from './lib/rigor.js';
import { registerEvidence, approvalGates } from './lib/evidence.js';
import { SOURCE_PRESETS } from './lib/source_presets.js';
import { resolveFdicLinks, confirmFdicLink, fdicStatus, enableFdicConnectors, buildFdicReverificationRankings, getFdicReverificationRankings, getFdicReverificationWorkbench, saveFdicReverificationReview, attachFdicReviewEvidenceRevision } from './lib/fdic.js';
import { OFFICIAL_CONNECTORS, enableOfficialConnector, officialSourceStatus } from './lib/official_sources.js';
import { getValidationMatrix, refreshValidationMatrix } from './lib/validation_matrix.js';
import {labApi,scheduleLab} from './lib/lab.js';

async function bodyJson(request){ try{return await request.json();}catch{return {};} }
function pathParts(url){ return new URL(url).pathname.split('/').filter(Boolean); }

// Hybrid self-heal: heavy compute normally belongs to GitHub Actions. If queued work sits
// untouched while no external runner lease is active, first retry workflow dispatch. When
// dispatch is unavailable, or the same heavy job remains stranded for a long grace period,
// allow exactly one compute_candidate to run on the Worker. This breaks the queued/0-attempt
// deadlock without turning the Worker into the normal heavy executor.
export async function recoverHybridStall(env,{reason='self_heal'}={}){
  if(String(env.COMPUTE_EXECUTOR||'')!=='hybrid') return {status:'not_hybrid'};
  const status=await githubRunnerStatus(env);
  if(!status.heavy_due) return {status:'no_heavy_work',runner:status};
  if(status.runner_active) return {status:'runner_active',runner:status};
  const dispatch=await dispatchGithubActionsIfNeeded(env,{reason});
  const oldestMs=status.oldest_heavy_job?Date.parse(status.oldest_heavy_job):NaN;
  const ageSeconds=Number.isFinite(oldestMs)?Math.max(0,Math.floor((Date.now()-oldestMs)/1000)):0;
  const hardFailure=['not_configured','dispatch_failed','dispatch_network_error'].includes(dispatch?.status);
  // Give a successful/cooldown dispatch time to acquire the runner lease. If it still has not
  // started after 8 minutes, fall back regardless: a scheduled workflow/dispatch can be disabled
  // independently of the application, and queued jobs must not remain permanently unevaluated.
  const emergency=ageSeconds>=90&&hardFailure || ageSeconds>=480;
  if(!emergency) return {status:'dispatch_pending',dispatch,age_seconds:ageSeconds,runner:status};
  const fallbackEnv=Object.assign(Object.create(env),{
    EMERGENCY_WORKER_COMPUTE:'1',
    MAX_JOBS_PER_TICK:'1'
  });
  const results=await processFastLane(fallbackEnv,{rounds:1});
  return {status:'worker_emergency',dispatch,age_seconds:ageSeconds,results,runner:status};
}

async function tableColumns(db, table){
  try{return new Set((await all(db,`PRAGMA table_info(${table})`)).map(x=>x.name));}catch{return new Set();}
}
async function storageIntegrity(env,pcols=null,knownProjectCount=null){
  pcols=pcols||await tableColumns(env.DB,'projects');
  let projectCount=knownProjectCount==null?0:Number(knownProjectCount),lineage=null;
  if(knownProjectCount==null)try{projectCount=Number((await one(env.DB,`SELECT COUNT(*) n FROM projects`))?.n||0);}catch{}
  try{lineage=(await one(env.DB,`SELECT value FROM platform_meta WHERE key='storage_lineage_id'`))?.value||null;}catch{}
  return {project_count:projectCount,storage_lineage_id:lineage,projects_columns:[...pcols],schema:{candidate_count:pcols.has('candidate_count'),research_cycle:pcols.has('research_cycle'),evidence_revision:pcols.has('evidence_revision')}};
}
async function compatibleProjectList(env,pcols=null){
  pcols=pcols||await tableColumns(env.DB,'projects');
  if(!pcols.has('id')) return [];
  const rows=await all(env.DB,`SELECT * FROM projects ORDER BY created_at DESC`);
  const ccounts={};
  if(!pcols.has('candidate_count')){
    try{for(const r of await all(env.DB,`SELECT project_id,COUNT(*) n FROM design_candidates GROUP BY project_id`))ccounts[r.project_id]=Number(r.n||0);}catch{}
  }
  const acounts={};
  try{
    const acols=await tableColumns(env.DB,'approvals');
    let ar=[];
    if(acols.has('research_cycle')&&acols.has('evidence_revision')&&acols.has('stale_at')&&pcols.has('research_cycle')&&pcols.has('evidence_revision')){
      ar=await all(env.DB,`SELECT a.project_id,COUNT(*) n FROM approvals a JOIN projects p ON p.id=a.project_id WHERE a.research_cycle=p.research_cycle AND a.evidence_revision=p.evidence_revision AND a.stale_at IS NULL GROUP BY a.project_id`);
    }else ar=await all(env.DB,`SELECT project_id,COUNT(*) n FROM approvals GROUP BY project_id`);
    for(const r of ar)acounts[r.project_id]=Number(r.n||0);
  }catch{}
  return rows.map(r=>({...r,candidate_count:pcols.has('candidate_count')?Number(r.candidate_count||0):Number(ccounts[r.id]||0),reviewer_obs_count:pcols.has('reviewer_obs_count')?Number(r.reviewer_obs_count||0):Number(r.reviewer_obs_count||0),research_cycle:pcols.has('research_cycle')?Number(r.research_cycle||1):1,evidence_revision:pcols.has('evidence_revision')?Number(r.evidence_revision||0):0,approval_count:Number(acounts[r.id]||0)}));
}

async function api(request,env,ctx=null){
  const url=new URL(request.url), parts=pathParts(request.url), method=request.method.toUpperCase();
  if(url.pathname==='/api/health') return json({ok:true,app:env.APP_NAME||'DCV Research Platform',time:nowIso()});
  const auth=requireAdmin(request,env); if(auth) return auth;

  if(url.pathname==='/api/source-presets' && method==='GET') return json({presets:SOURCE_PRESETS,official_connectors:Object.values(OFFICIAL_CONNECTORS)});
  if(url.pathname==='/api/system/integrity' && method==='GET') return json(await storageIntegrity(env));

  if(url.pathname==='/api/projects' && method==='GET'){
    const pcols=await tableColumns(env.DB,'projects'),rows=await compatibleProjectList(env,pcols);
    return json({projects:rows,integrity:await storageIntegrity(env,pcols,rows.length)});
  }
  if(url.pathname==='/api/projects' && method==='POST'){
    const b=await bodyJson(request), id=uid('project'), now=nowIso();
    const design=b.design||{sigma:[0.03,0.05,0.10],tau:[0,1,2],alpha:[0.15,0.35,0.55,0.75],K:[0,1,2,3],d:[0,1,2,4],W:[0.05,0.12,0.22],m:[0.08,0.15,0.25],estimators:['ema','kalman','changepoint','adaptive'],max_candidates:128};
    const constraints=b.constraints||{loss_max:0.18,loss_exceed_max:0.10,fp_max:0.08,fn_max:0.10,review_burden_max:0.70,recovery_time_max:4.0,confidence:0.95};
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO projects(id,name,description,status,current_stage,auto_run,auto_approve,created_at,updated_at) VALUES(?,?,?,'draft','define',1,1,?,?)`).bind(id,b.name||'DCV 연구 프로젝트',b.description||'',now,now),
      env.DB.prepare(`INSERT INTO project_config(project_id,research_question,design_json,constraints_json,benchmark_json,validation_json) VALUES(?,?,?,?,?,?)`).bind(id,b.research_question||'잡음과 승인 지연 하에서 알고리즘 위임 가능 영역은 어떻게 변화하는가?',JSON.stringify(design),JSON.stringify(constraints),JSON.stringify(b.benchmark||{}),JSON.stringify(b.validation||{}))
    ]);
    await audit(env,id,'user','project.created','project',id,b);
    await enqueue(env,id,'seed_empirical_panel',{},5);
    await enqueue(env,id,'define_project',{},10);
    return json({id,status:'queued',empirical_panel:'bundled_n81'},201);
  }

  if(parts[0]==='api' && parts[1]==='projects' && parts[2]){
    const projectId=parts[2];
    if(parts[3]==='redesign'&&method==='POST'){try{return json(await applyRedesign(env,projectId,await bodyJson(request)),201);}catch(e){return json({error:e.message},400);}}
    if(parts[3]==='reviewer-trials'&&method==='POST'){try{return json(await createHumanTrial(env,projectId,(await bodyJson(request)).participant_hash),201);}catch(e){return json({error:e.message},400);}}
    if(parts[3]==='lab'){
      try{return await labApi(request,env,projectId,parts);}
      catch(e){return json({error:String(e.message||e)},/project_not_found/.test(String(e))?404:400);}
    }
    if(parts.length===3 && method==='GET'){
      const p=await one(env.DB,`SELECT * FROM projects WHERE id=?`,[projectId]); if(!p)return json({error:'not_found'},404);
      if(ctx&&String(env.COMPUTE_EXECUTOR||'')==='hybrid') ctx.waitUntil(recoverHybridStall(env,{reason:'project_detail_poll'}).catch(()=>null));
      const def=await one(env.DB,`SELECT status,version,gate_json,content_json,ai_note,created_at FROM definitions WHERE project_id=? ORDER BY version DESC LIMIT 1`,[projectId]);
      const meas=await one(env.DB,`SELECT metrics_json,quality_json,measured_at FROM measurements WHERE project_id=? ORDER BY measured_at DESC LIMIT 1`,[projectId]);
      const cycle=Number(p.research_cycle||1),rev=Number(p.evidence_revision||0);
      const counts=await one(env.DB,`SELECT COUNT(*) total,SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) unevaluated,SUM(CASE WHEN status='confirmed_feasible' THEN 1 ELSE 0 END) feasible,SUM(CASE WHEN status IN ('infeasible','confirmation_failed') THEN 1 ELSE 0 END) infeasible,SUM(CASE WHEN evidence_status='UNRESOLVED' THEN 1 ELSE 0 END) unresolved,AVG(boundary_score) avg_boundary,MIN(max_regret) min_regret,MAX(CASE WHEN max_regret IS NOT NULL THEN updated_at END) regret_updated_at FROM design_candidates WHERE project_id=? AND research_cycle=?`,[projectId,cycle]);
      let regretMeta={basis:'Historical + Stress (Adversarial + BIS + ECB)',scenario_count:0,historical_scenarios:0,stress_scenarios:0,adversarial_scenarios:0,bis_scenarios:0,ecb_scenarios:0,last_updated_at:counts?.regret_updated_at||null,human_included:false};
      if(counts?.min_regret!=null){
        const rc=await one(env.DB,`SELECT id FROM design_candidates WHERE project_id=? AND research_cycle=? AND max_regret IS NOT NULL ORDER BY max_regret ASC,id LIMIT 1`,[projectId,cycle]);
        if(rc?.id){
          const rr=await all(env.DB,`SELECT phase,result_json,created_at FROM simulation_runs WHERE project_id=? AND candidate_id=? AND phase IN ('historical','stress') ORDER BY created_at DESC LIMIT 20`,[projectId,rc.id]);
          const latest={}; for(const r of rr) if(!latest[r.phase]) latest[r.phase]=r;
          const hs=safeJson(latest.historical?.result_json,{}).scenario_scores||{}, ss=safeJson(latest.stress?.result_json,{}).scenario_scores||{};
          const sk=Object.keys(ss), hk=Object.keys(hs); const bis=sk.filter(k=>k.startsWith('official_bis_')).length,ecb=sk.filter(k=>k.startsWith('official_ecb_')).length;
          regretMeta={...regretMeta,scenario_count:hk.length+sk.length,historical_scenarios:hk.length,stress_scenarios:sk.length,adversarial_scenarios:Math.max(0,sk.length-bis-ecb),bis_scenarios:bis,ecb_scenarios:ecb,last_updated_at:[counts?.regret_updated_at,latest.historical?.created_at,latest.stress?.created_at].filter(Boolean).sort().pop()||null};
        }
      }
      regretMeta.evidence_available=regretMeta.scenario_count>0;if(!regretMeta.evidence_available)counts.min_regret=null;
      const app=await one(env.DB,`SELECT * FROM approvals WHERE project_id=? AND research_cycle=? AND evidence_revision=? AND stale_at IS NULL ORDER BY created_at DESC LIMIT 1`,[projectId,cycle,rev]);
      const staleApproval=await one(env.DB,`SELECT * FROM approvals WHERE project_id=? AND stale_at IS NOT NULL ORDER BY stale_at DESC LIMIT 1`,[projectId]);
      const reviewer=await one(env.DB,`SELECT model_json,version,created_at FROM reviewer_models WHERE project_id=? AND research_cycle=? AND evidence_revision=? ORDER BY version DESC LIMIT 1`,[projectId,cycle,rev]);
      const jobs=await all(env.DB,`SELECT type,status,attempts,last_error,created_at,updated_at FROM jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 20`,[projectId]);
      const runs=await one(env.DB,`SELECT COUNT(*) total,SUM(CASE WHEN r.phase='exploration' THEN 1 ELSE 0 END) exploration,SUM(CASE WHEN r.phase='refinement' THEN 1 ELSE 0 END) refinement,SUM(CASE WHEN r.phase='confirmation' THEN 1 ELSE 0 END) confirmation,SUM(CASE WHEN r.phase IN ('historical','stress') THEN 1 ELSE 0 END) robust FROM simulation_runs r JOIN design_candidates c ON c.id=r.candidate_id WHERE r.project_id=? AND c.research_cycle=?`,[projectId,cycle]);
      const scenarios=await one(env.DB,`SELECT COUNT(*) total,SUM(CASE WHEN scenario_type='historical' THEN 1 ELSE 0 END) historical,SUM(CASE WHEN scenario_type='adversarial' THEN 1 ELSE 0 END) adversarial FROM scenarios WHERE project_id=?`,[projectId]);
      const empirical=await empiricalReadiness(env,projectId);
      const protocol=await latestProtocol(env,projectId);
      const gates=await approvalGates(env,projectId);
      const humanProtocol=safeJson(def?.content_json,{}).validation?.human_protocol||null;
      const human=await one(env.DB,`SELECT COUNT(*) observations, COUNT(DISTINCT NULLIF(participant_hash,'anonymous')) participants,
        COUNT(DISTINCT CASE WHEN (? IS NULL OR (trial_id IS NOT NULL AND json_extract(context_json,'$.protocol')=? AND json_extract(context_json,'$.cycle')=?)) THEN NULLIF(participant_hash,'anonymous') END) eligible_participants
        FROM reviewer_observations WHERE project_id=?`,[humanProtocol,humanProtocol,cycle,projectId]);
      return json({project:p,definition:def?{...def,gate:safeJson(def.gate_json,{}),content:safeJson(def.content_json,{}),ai:safeJson(def.ai_note,{})}:null,measurement:meas?{...meas,metrics:safeJson(meas.metrics_json,{}),quality:safeJson(meas.quality_json,{})}:null,candidates:{...counts,regret_meta:regretMeta},approval:app?{...app,basis:safeJson(app.basis_json,{})}:null,stale_approval:staleApproval?{...staleApproval,basis:safeJson(staleApproval.basis_json,{})}:null,approval_gates:gates,reviewer:reviewer?{...reviewer,model:safeJson(reviewer.model_json,{})}:null,jobs,runs,scenarios,human_reviews:Number(human?.observations||0),human_participants:Number(human?.participants||0),human_eligible_participants:Number(human?.eligible_participants||0),empirical,protocol});
    }
    if(parts[3]==='run' && method==='POST'){ await run(env.DB,`UPDATE projects SET reviewer_hold_marker=NULL WHERE id=?`,[projectId]); if(env.COMPUTE_EXECUTOR==='github-actions'){await enqueueOnce(env,projectId,'advance_project',{},98);return json({status:'queued',transport:'github-actions'});} const r=await advanceProject(env,projectId); const recovery=env.COMPUTE_EXECUTOR==='hybrid'?await recoverHybridStall(env,{reason:'manual_project_run'}):null; return json({advance:r,recovery,transport:env.COMPUTE_EXECUTOR==='hybrid'?'hybrid-self-heal':env.CDRS_QUEUE?'cloudflare-queue':'d1-fallback'}); }
    if(parts[3]==='sources' && method==='GET'){ return json({sources:await all(env.DB,`SELECT * FROM data_sources WHERE project_id=? ORDER BY created_at DESC`,[projectId])}); }
    if(parts[3]==='official-sources' && parts[4]==='status' && method==='GET'){ return json(await officialSourceStatus(env,projectId)); }
    if(parts[3]==='official-sources' && parts[4]==='enable' && method==='POST'){ const b=await bodyJson(request); const ids=Array.isArray(b.connector_ids)?b.connector_ids:[b.connector_id].filter(Boolean); const out=[]; for(const id of ids) out.push({connector_id:id,...await enableOfficialConnector(env,projectId,id,(b.configs||{})[id]||b.config||{})}); return json({enabled:out,status:await officialSourceStatus(env,projectId)},201); }
    if(parts[3]==='official-sources' && parts[4]==='collect' && method==='POST'){ await enqueueOnce(env,projectId,'collect_project',{refresh:true,official_manual:true},20,1); return json({status:'queued'}); }
    if(parts[3]==='fdic' && parts[4]==='status' && method==='GET'){ return json(await fdicStatus(env,projectId)); }
    if(parts[3]==='fdic' && parts[4]==='enable' && method==='POST'){ const enabled=await enableFdicConnectors(env,projectId); const links=await resolveFdicLinks(env,projectId,{autoConfirm:true,maxEpisodes:81}); await enqueueOnce(env,projectId,'collect_project',{refresh:true,fdic_manual:true},20,1); return json({status:'enabled',...enabled,links}); }
    if(parts[3]==='fdic' && parts[4]==='resolve' && method==='POST'){ const b=await bodyJson(request); return json(await resolveFdicLinks(env,projectId,{autoConfirm:b.auto_confirm!==false,maxEpisodes:Number(b.max_episodes||81)})); }
    if(parts[3]==='fdic' && parts[4]==='link' && method==='POST'){ const b=await bodyJson(request); const r=await confirmFdicLink(env,projectId,b); return json(r,201); }
    if(parts[3]==='fdic' && parts[4]==='collect' && method==='POST'){ await enqueueOnce(env,projectId,'collect_project',{refresh:true,fdic_manual:true},20); return json({status:'queued'}); }
    if(parts[3]==='fdic' && parts[4]==='reverification' && method==='POST'){ return json(await buildFdicReverificationRankings(env,projectId)); }
    if(parts[3]==='fdic' && parts[4]==='reverification' && method==='GET'){ return json(await getFdicReverificationRankings(env,projectId,{limit:Number(url.searchParams.get('limit')||81)})); }
    if(parts[3]==='fdic' && parts[4]==='workbench' && parts[5] && method==='GET'){ try{return json(await getFdicReverificationWorkbench(env,projectId,parts[5]));}catch(e){return json({error:String(e.message||e)},404);} }
    if(parts[3]==='fdic' && parts[4]==='workbench' && parts[5] && method==='POST'){ const b=await bodyJson(request); try{const saved=await saveFdicReverificationReview(env,projectId,parts[5],b); let ev=null; if(saved.needs_evidence_registration){ ev=await registerEvidence(env,projectId,{kind:'REVERIFICATION_REVIEW',impact_from:'validate',source:'fdic_workbench',detail:{episode_id:parts[5],review_status:saved.review_status,recommended_action:saved.recommended_action,cause_code:b.cause_code||''}}); await attachFdicReviewEvidenceRevision(env,projectId,parts[5],ev.evidence_revision); } return json({...saved,revalidation:ev});}catch(e){return json({error:String(e.message||e)},400);} }
    if(parts[3]==='sources' && method==='POST'){
      const b=await bodyJson(request), id=uid('source');
      await run(env.DB,`INSERT INTO data_sources(id,project_id,name,kind,url,method,headers_json,mapping_json,enabled,cadence_minutes,created_at,connector_id,case_layer,data_role,config_json,last_record_count) VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,0)`,[id,projectId,b.name||'External Source',b.kind||'json',b.url,b.method||'GET',JSON.stringify(b.headers||{}),JSON.stringify(b.mapping||{}),Number(b.cadence_minutes||60),nowIso(),b.connector_id||null,b.case_layer||'A',b.data_role||null,JSON.stringify(b.config||{})]);
      await audit(env,projectId,'user','source.created','data_source',id,b); return json({id},201);
    }
    if(parts[3]==='observations' && method==='POST'){
      const b=await bodyJson(request), rows=Array.isArray(b)?b:(b.rows||[b]), stmts=[];
      for(const r of rows.slice(0,1000)) stmts.push(env.DB.prepare(`INSERT INTO raw_observations(id,project_id,source_id,observed_at,ingested_at,key,value_num,value_text,payload_json,quality_json) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(uid('obs'),projectId,null,r.observed_at||nowIso(),nowIso(),r.key||'signal',Number.isFinite(Number(r.value))?Number(r.value):null,Number.isFinite(Number(r.value))?null:String(r.value??''),JSON.stringify(r),JSON.stringify({manual:true})));
      if(stmts.length) await env.DB.batch(stmts); const ev=stmts.length?await registerEvidence(env,projectId,{kind:'RAW_OBSERVATION',source:'manual_api',detail:{inserted:stmts.length}}):null; return json({inserted:stmts.length,revalidation:ev});
    }
    if(parts[3]==='reviewer-observations' && method==='POST'){
      const b=await bodyJson(request);if(b.trial_id){try{const saved=await recordHumanTrial(env,projectId,b);const ev=await registerEvidence(env,projectId,{kind:'HUMAN_TRIAL',source:'calibrated_task_v2',detail:{observation_id:saved.id}});return json({...saved,revalidation:ev},201);}catch(e){return json({error:e.message},400);}} const id=uid('review');
      await env.DB.batch([   // 관측 INSERT + 프로젝트 카운터 증가를 한 batch(원자적)로
        env.DB.prepare(`INSERT INTO reviewer_observations(id,project_id,participant_hash,ai_confidence,ai_correct,human_accept,response_ms,recovered,recovery_ms,context_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(id,projectId,String(b.participant_hash||'anon'),Number(b.ai_confidence),b.ai_correct?1:0,b.human_accept?1:0,Number(b.response_ms||0),b.recovered?1:0,b.recovery_ms==null?null:Number(b.recovery_ms),JSON.stringify(b.context||{}),nowIso()),
        env.DB.prepare(`UPDATE projects SET reviewer_obs_count=reviewer_obs_count+1 WHERE id=?`).bind(projectId)
      ]);
      const ev=await registerEvidence(env,projectId,{kind:'HUMAN_TRIAL',source:'reviewer_ui',detail:{observation_id:id}}); return json({id,revalidation:ev},201);
    }
    if(parts[3]==='validation-matrix' && method==='GET'){ return json(await getValidationMatrix(env,projectId)); }
    if(parts[3]==='validation-matrix' && method==='POST'){ return json(await refreshValidationMatrix(env,projectId)); }
    if(parts[3]==='scenarios' && method==='GET'){ return json({scenarios:await all(env.DB,`SELECT * FROM scenarios WHERE project_id=? ORDER BY scenario_type,name`,[projectId])}); }
    if(parts[3]==='scenarios' && method==='POST'){
      const b=await bodyJson(request), rows=Array.isArray(b)?b:(b.rows||[b]), stmts=[];
      for(const r of rows.slice(0,500)) stmts.push(env.DB.prepare(`INSERT INTO scenarios(id,project_id,name,scenario_type,severity,volatility,delay_multiplier,loss_multiplier,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(uid('scenario'),projectId,r.name||'scenario',r.scenario_type||'historical',Number(r.severity||1),Number(r.volatility||1),Number(r.delay_multiplier||1),Number(r.loss_multiplier||1),JSON.stringify(r.metadata||{}),nowIso()));
      if(stmts.length) await env.DB.batch(stmts); bust(env,projectId); const ev=stmts.length?await registerEvidence(env,projectId,{kind:'SCENARIO',source:'manual_api',detail:{inserted:stmts.length}}):null; return json({inserted:stmts.length,revalidation:ev},201);
    }
    if(parts[3]==='empirical' && parts.length===4 && method==='GET'){
      const readiness=await empiricalReadiness(env,projectId),cal=await loadEmpiricalCalibration(env,projectId);
      const params=await all(env.DB,`SELECT parameter_key,value_num,low_num,high_num,unit,parameter_role,provenance_type,source_note FROM empirical_parameters WHERE project_id=? ORDER BY parameter_role,parameter_key`,[projectId]);
      return json({readiness,profile:cal.profile,parameters:params,coefficients:cal.coeff,local_refit:cal.local_refit});
    }
    if(parts[3]==='empirical' && parts[4]==='seed' && method==='POST'){
      const profile=await ensureEmpiricalProfile(env,projectId); return json({profile,readiness:await empiricalReadiness(env,projectId)});
    }
    if(parts[3]==='empirical' && parts[4]==='seed-panel' && method==='POST'){
      const result=await seedBundledEmpiricalPanel(env,projectId); const ev=await registerEvidence(env,projectId,{kind:'EMPIRICAL_EPISODE',source:'bundled_panel_manual',detail:{rows:result.rows}}); await enqueueOnce(env,projectId,'measure_project',{},30,2); return json({...result,revalidation:ev},201);
    }
    if(parts[3]==='empirical' && parts[4]==='episodes' && method==='POST'){
      const b=await bodyJson(request),rows=Array.isArray(b)?b:(b.rows||[]),result=await importEmpiricalEpisodes(env,projectId,rows); const ev=result.inserted?await registerEvidence(env,projectId,{kind:'EMPIRICAL_EPISODE',source:'manual_import',detail:{inserted:result.inserted}}):null; await enqueueOnce(env,projectId,'refit_empirical',{},22); return json({...result,revalidation:ev},201);
    }
    if(parts[3]==='empirical' && parts[4]==='refit' && method==='POST'){
      const b=await bodyJson(request); return json(await refitEmpiricalCalibration(env,projectId,{promote:!!b.promote}));
    }
    if(parts[3]==='candidates' && method==='GET'){
      const p=await one(env.DB,`SELECT research_cycle,evidence_revision FROM projects WHERE id=?`,[projectId]); const rows=await all(env.DB,`SELECT c.*, (SELECT status FROM validations v WHERE v.candidate_id=c.id AND v.validation_type='human_recompute' AND v.evidence_revision=? ORDER BY created_at DESC LIMIT 1) final_status FROM design_candidates c WHERE project_id=? AND research_cycle=? ORDER BY sigma,authority_k,delay_d LIMIT 500`,[Number(p?.evidence_revision||0),projectId,Number(p?.research_cycle||1)]); return json({candidates:rows});
    }
    if(parts[3]==='protocol' && method==='GET'){ const p=await latestProtocol(env,projectId); return p?json(p):json({error:'protocol_not_frozen'},404); }
    if(parts[3]==='scientific-signoff' && method==='POST'){ const b=await bodyJson(request); return json(await scientificSignoff(env,projectId,{reviewer_name:b.reviewer_name||'PI',rationale:b.rationale||''})); }
    if(parts[3]==='report' && method==='GET'){
      const p=await one(env.DB,`SELECT research_cycle,evidence_revision FROM projects WHERE id=?`,[projectId]); let r=await one(env.DB,`SELECT * FROM reports WHERE project_id=? AND research_cycle=? AND evidence_revision=? AND stale_at IS NULL ORDER BY created_at DESC LIMIT 1`,[projectId,Number(p?.research_cycle||1),Number(p?.evidence_revision||0)]); const stale=!r; if(!r)r=await one(env.DB,`SELECT * FROM reports WHERE project_id=? ORDER BY created_at DESC LIMIT 1`,[projectId]); if(r&&!stale){ try{ r=await upgradeStoredReport(env,projectId,r); }catch(e){ /* 구버전 보고서는 그대로 반환 */ } } const liveHuman=await one(env.DB,`SELECT COUNT(*) observations, COUNT(DISTINCT NULLIF(participant_hash,'anonymous')) participants,
        COUNT(DISTINCT CASE WHEN ((SELECT json_extract(content_json,'$.validation.human_protocol') FROM definitions WHERE project_id=? ORDER BY version DESC LIMIT 1) IS NULL OR
        (trial_id IS NOT NULL AND json_extract(context_json,'$.protocol')=(SELECT json_extract(content_json,'$.validation.human_protocol') FROM definitions WHERE project_id=? ORDER BY version DESC LIMIT 1) AND json_extract(context_json,'$.cycle')=?)) THEN NULLIF(participant_hash,'anonymous') END) eligible_participants
        FROM reviewer_observations WHERE project_id=?`,[projectId,projectId,Number(p?.research_cycle||1),projectId]);
      const liveNotice=`> 현재 저장된 인간실험: 누적 참가자 ${Number(liveHuman?.participants||0)}명 / 관측 ${Number(liveHuman?.observations||0)}건, 현재 규약·주기 대상 ${Number(liveHuman?.eligible_participants||0)}명.\n> 아래 본문은 보고서 작성 당시의 증거 스냅샷(Cycle ${r?.research_cycle||'-'} · Evidence r${r?.evidence_revision??'-'})입니다.${stale?' 이전 증거 스냅샷 보고서입니다. 최신 보고서는 Actions 실행 후 갱신됩니다.':''} 현재 인원으로 본문의 통계값을 대체하지 않습니다.\n\n`;
      return r?json({...r,stale,live_human:liveHuman,current_cycle:Number(p?.research_cycle||1),current_revision:Number(p?.evidence_revision||0),content_markdown:liveNotice+r.content_markdown,data:safeJson(r.data_json,{})}):json({error:'report_not_ready'},404);
    }
    if(parts[3]==='report' && method==='POST'){ if(['github-actions','hybrid'].includes(env.COMPUTE_EXECUTOR)){await enqueueOnce(env,projectId,'generate_report',{},95);return json({status:'queued',transport:'github-actions'},202);} return json(await generateReport(env,projectId)); }
    if(parts[3]==='thesis' && method==='GET'){ try{ return json(await buildThesisData(env,projectId)); }catch(e){ return json({error:String(e.message||e)},e.message==='project_not_found'?404:500); } }
    if(parts[3]==='export' && parts[4] && method==='GET'){
      const name=parts[4].replace(/\.csv$/,'');
      if(!EXPORT_NAMES.includes(name)) return json({error:'unknown_export',available:EXPORT_NAMES},404);
      const body=await exportCsv(env,projectId,name);
      return new Response(body,{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="${name}.csv"`}});
    }
    if(parts[3]==='evidence' && method==='GET'){ return json({events:await all(env.DB,`SELECT * FROM evidence_events WHERE project_id=? ORDER BY evidence_revision DESC LIMIT 100`,[projectId]),gates:await approvalGates(env,projectId)}); }
    if(parts[3]==='audit' && method==='GET'){ return json({audit:await all(env.DB,`SELECT * FROM audit_log WHERE project_id=? ORDER BY created_at DESC LIMIT 300`,[projectId])}); }
  }

  if(url.pathname==='/api/runner/status' && method==='GET') return json(await githubRunnerStatus(env));
  if(url.pathname==='/api/runner/dispatch' && method==='POST') return json(await dispatchGithubActionsIfNeeded(env,{force:false,reason:'manual_api'}));
  if(url.pathname==='/api/runner/recover' && method==='POST') return json(await recoverHybridStall(env,{reason:'manual_recover'}));

  if(url.pathname==='/api/ai/test' && method==='GET'){
    const r=await aiJson(env,'You are a test assistant.','Say hello in Korean.',{ok:false},{schemaHint:'{"ok":true,"message":"string"}',maxTokens:100});
    return json({binding:!!env.AI,configured_model:env.AI_MODEL||null,result:r});
  }
  if(url.pathname==='/api/jobs/process' && method==='POST') return json({results:await processJobs(env)});
  if(url.pathname==='/api/schedule' && method==='POST'){ const scheduled=await scheduleAll(env,{process:false}); const fast=env.COMPUTE_EXECUTOR==='hybrid'?await processFastLane(env,{rounds:3}):await processJobs(env); const recovery=env.COMPUTE_EXECUTOR==='hybrid'?await recoverHybridStall(env,{reason:'api_schedule'}):null; return json({scheduled,fast,recovery}); }

  if(url.pathname==='/api/studies' && method==='POST'){
    const b=await bodyJson(request), id=uid('study'); await run(env.DB,`INSERT INTO study_groups(id,name,created_at) VALUES(?,?,?)`,[id,b.name||'DCV Study',nowIso()]); return json({id},201);
  }
  if(parts[0]==='api'&&parts[1]==='studies'&&parts[2]&&parts[3]==='cases'&&method==='POST'){
    const b=await bodyJson(request); await run(env.DB,`INSERT OR REPLACE INTO study_cases(study_id,project_id,case_role) VALUES(?,?,?)`,[parts[2],b.project_id,b.case_role||'replication']); return json({ok:true});
  }
  if(parts[0]==='api'&&parts[1]==='studies'&&parts[2]&&parts[3]==='compare'&&method==='POST'){
    await enqueue(env,null,'compare_study',{study_id:parts[2]},90); return json({status:'queued'});
  }

  return json({error:'not_found'},404);
}

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(url.pathname.startsWith('/api/')) return api(request,env,ctx);
    return env.ASSETS.fetch(request);
  },
  async scheduled(controller,env,ctx){ ctx.waitUntil((async()=>{ await scheduleAll(env,{process:false}); await processFastLane(env,{rounds:3}); await recoverHybridStall(env,{reason:'worker_cron'}); await scheduleLab(env); })()); },
  async queue(batch,env,ctx){
    for(const message of batch.messages){
      try{ const out=await processJobs(env); if(!out.length&&String(env.COMPUTE_EXECUTOR||'')==='hybrid')await recoverHybridStall(env,{reason:'queue_wake'}); message.ack(); }
      catch(e){ message.retry(); }
    }
  }
};
