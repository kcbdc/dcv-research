import { claimJobs, finishJob, enqueue, enqueueOnce, enqueueMany, pruneJobs, wakeDueJobs, all, one, run, audit } from './db.js';
import { ensureFrozenProtocol } from './rigor.js';
import { defineProject } from './define.js';
import { collectProject } from './collectors.js';
import { measureProject } from './measure.js';
import { seedCandidates, computeCandidate, enqueueRobustValidation } from './compute.js';
import { validateProject } from './validate.js';
import { fitReviewerModel } from './reviewer.js';
import { enqueueRecompute, finalizeRecompute } from './recompute.js';
import { approveProject } from './approve.js';
import { generateReport } from './report.js';
import { compareStudy } from './crosscase.js';
import { refitEmpiricalCalibration, seedBundledEmpiricalPanel } from './empirical.js';
import { approvalGates, registerEvidence } from './evidence.js';

// phase 컬럼(마이그레이션 0007)과 (project_id,type,status,phase) 인덱스로 존재 여부만 확인한다.
// 이전: 해당 프로젝트의 queued/running 행을 전부 읽어 JS 에서 payload_json 을 파싱.
async function jobExists(env,projectId,type,phase=null){
  const r=phase
    ? await one(env.DB,`SELECT 1 x FROM jobs WHERE project_id=? AND type=? AND status IN ('queued','running') AND phase=? LIMIT 1`,[projectId,type,phase])
    : await one(env.DB,`SELECT 1 x FROM jobs WHERE project_id=? AND type=? AND status IN ('queued','running') LIMIT 1`,[projectId,type]);
  return !!r;
}

// 모든 자동 단계를 마친 프로젝트 상태. 이 상태에서는 Cron 이 15분마다 advance 를 돌려도 읽을 것이 없다.
const TERMINAL_STATUSES = new Set(['complete','report_ready']);
const INITIAL_CHECKPOINT_EVALUATED = 100;
const FOLLOWUP_COMPUTE_BATCH = 20;

async function setStage(env,p,stage){
  if(p.current_stage===stage) return;   // 같은 값이면 쓰기 생략
  p.current_stage=stage;
  await run(env.DB,`UPDATE projects SET current_stage=?,updated_at=datetime('now') WHERE id=?`,[stage,p.id]);
}

export async function advanceProject(env,projectId){
  const p=await one(env.DB,`SELECT * FROM projects WHERE id=?`,[projectId]);
  if(!p||!p.auto_run) return {status:'disabled'};
  // 보고서까지 끝난 프로젝트: 이후 단계 점검 쿼리(전체 스캔 포함)를 전부 생략
  if(TERMINAL_STATUSES.has(p.status)) {
    const pending=await one(env.DB,`SELECT 1 x FROM design_candidates WHERE project_id=? AND research_cycle=? AND status='pending' LIMIT 1`,[projectId,Number(p.research_cycle||1)]);
    if(!pending)return {stage:'complete'};
    await run(env.DB,`UPDATE projects SET status='running',reviewer_hold_marker=NULL WHERE id=?`,[projectId]);
    p.reviewer_hold_marker=null;
  }

  // 인간 검토자 표본을 기다리는 중(마지막 fit_reviewer 가 HOLD 였고 그 뒤 새 관측이 없음)이면,
  // 앞 단계(후보/시뮬레이션/검증) 점검을 반복할 필요가 없다. 마커는 모든 앞 단계가 끝난 뒤에만 기록된다.
  if(p.reviewer_hold_marker!==null && p.reviewer_hold_marker!==undefined){
    const model=await one(env.DB,`SELECT 1 x FROM reviewer_models WHERE project_id=? AND research_cycle=? AND evidence_revision=? UNION ALL SELECT 1 x FROM design_candidates WHERE project_id=? AND research_cycle=? AND status='pending' LIMIT 1`,[projectId,Number(p.research_cycle||1),Number(p.evidence_revision||0),projectId,Number(p.research_cycle||1)]);
    if(!model){
      const latest=await one(env.DB,`SELECT created_at FROM reviewer_observations WHERE project_id=? ORDER BY created_at DESC LIMIT 1`,[projectId]);
      if((latest?.created_at??'')===p.reviewer_hold_marker) return {stage:'human_review',waiting:'no_new_reviewer_observations'};
    }
  }

  const cycle=Number(p.research_cycle||1),rev=Number(p.evidence_revision||0);
  // D1 read guard: expensive candidate/run aggregates are unnecessary while a downstream batch is still in flight.
  // One indexed jobs lookup replaces repeated 128-row candidate scans on every Cron tick during compute/robust/recompute.
  const busy=await one(env.DB,`SELECT type,phase FROM jobs WHERE project_id=? AND status IN ('queued','running') AND type IN ('compute_candidate','validate_project','recompute_project','finalize_recompute') LIMIT 1`,[projectId]);
  if(busy){
    const ph=String(busy.phase||''); const stage=busy.type==='compute_candidate'?(ph==='historical'||ph==='stress'?'validate':ph==='recompute'?'recompute':'compute'):busy.type==='validate_project'?'validate':'recompute';
    await setStage(env,p,stage); return {stage,waiting:'jobs_in_flight',job_type:busy.type,phase:ph||null};
  }
  const cand=await one(env.DB,`SELECT COUNT(*) total,SUM(CASE WHEN status='confirmed_feasible' THEN 1 ELSE 0 END) feasible,SUM(CASE WHEN status IN ('pending','unresolved','provisionally_feasible') THEN 1 ELSE 0 END) active,SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending FROM design_candidates WHERE project_id=? AND research_cycle=?`,[projectId,cycle]);
  const total=Number(cand?.total||0), feasible=Number(cand?.feasible||0), active=Number(cand?.active||0), pending=Number(cand?.pending||0), evaluated=Math.max(0,total-pending);
  if(!total){
    const inFlight=await one(env.DB,`SELECT COUNT(*) n FROM jobs WHERE project_id=? AND type IN ('seed_empirical_panel','define_project','collect_project','refit_empirical','measure_project','seed_candidates') AND status IN ('queued','running')`,[projectId]);
    if(Number(inFlight?.n||0)>0){ await setStage(env,p,'measure'); return {stage:'waiting',reason:'setup_jobs_in_flight'}; }
    const doneDefine=await one(env.DB,`SELECT 1 x FROM jobs WHERE project_id=? AND type='define_project' AND status='done' LIMIT 1`,[projectId]);
    if(doneDefine){ await enqueue(env,projectId,'measure_project',{},30); await setStage(env,p,'measure'); return {stage:'measure',resumed:true}; }
    if(!(await jobExists(env,projectId,'define_project'))) await enqueue(env,projectId,'define_project',{},10);
    await setStage(env,p,'define');
    return {stage:'define'};
  }

  // active 후보가 남아 있으면 아직 탐색 중이므로 'unfinished' 작업 조회 없이 바로 반환(조회 1회 절약)
  if(active>0){
    // Partial-progress checkpoint: do not hold the whole research/report pipeline for the last
    // unevaluated candidates. Once 100 candidates have a non-pending decision, write an interim
    // report snapshot first. Thereafter compute only 20 new pending candidates, then refresh the
    // interim report again. Final validation/approval still runs only after the candidate search
    // itself is complete, so this accelerates visibility without weakening final gates.
    if(total>INITIAL_CHECKPOINT_EVALUATED && pending>0 && evaluated>=INITIAL_CHECKPOINT_EVALUATED){
      const latestCheckpoint=await one(env.DB,`SELECT CAST(json_extract(data_json,'$.summary.evaluated_candidates') AS INTEGER) n
        FROM reports WHERE project_id=? AND research_cycle=? AND evidence_revision=? AND stale_at IS NULL
          AND kind='paper_summary_checkpoint' ORDER BY created_at DESC LIMIT 1`,[projectId,cycle,rev]);
      const last=Number(latestCheckpoint?.n||0);
      const checkpointDue=last<INITIAL_CHECKPOINT_EVALUATED || evaluated>=last+FOLLOWUP_COMPUTE_BATCH || pending===0;
      if(checkpointDue){
        const queuedReport=await enqueueOnce(env,projectId,'generate_report',{checkpoint:true,evaluated_candidates:evaluated,pending_candidates:pending},38);
        await setStage(env,p,'report');
        return {stage:'checkpoint_report',evaluated,pending,total,queued_report:!!queuedReport,next_batch:FOLLOWUP_COMPUTE_BATCH};
      }
    }

    // v0.7.6 exhausted-job recovery:
    // 이전 구현은 같은 후보의 compute_candidate 실패 이력이 3건 이상이면 그 후보를 영구히 제외했다.
    // 버그/인프라 장애를 수정해 새 코드를 배포해도 design_candidates.status='pending'은 그대로라
    // UI가 UNEVALUATED 108 같은 값에서 멈추는 교착이 발생할 수 있었다.
    // 새 코드 revision마다 가장 최근의 exhausted exploration job을 딱 한 번만 되살린다.
    // 같은 revision에서 다시 max_attempts를 소진하면 _recovery_revision 표식 때문에 또 되살리지 않아
    // 결정론적 오류의 무한 재시도는 방지한다.
    const recoveryRevision=String(env.RUNNER_CODE_REVISION||'unknown');
    const recoveryTs=new Date().toISOString();
    const recovered=await run(env.DB,`UPDATE jobs SET status='queued',attempts=0,locked_at=NULL,run_after=?,updated_at=?,
      last_error='auto_recovered_after_code_revision',
      payload_json=json_set(COALESCE(payload_json,'{}'),'$._recovery_revision',?)
      WHERE id IN (
        SELECT f.id FROM jobs f JOIN design_candidates c ON c.project_id=f.project_id
          AND c.id=json_extract(f.payload_json,'$.candidate_id')
        WHERE c.project_id=? AND c.research_cycle=? AND c.status='pending'
          AND f.type='compute_candidate' AND f.status='failed'
          AND COALESCE(json_extract(f.payload_json,'$.phase'),'exploration')='exploration'
          AND COALESCE(json_extract(f.payload_json,'$._recovery_revision'),'')<>?
          AND NOT EXISTS(SELECT 1 FROM simulation_runs r WHERE r.candidate_id=c.id AND r.phase='exploration')
          AND NOT EXISTS(SELECT 1 FROM jobs q WHERE q.project_id=c.project_id AND q.type='compute_candidate'
            AND json_extract(q.payload_json,'$.candidate_id')=c.id AND q.status IN ('queued','running'))
          AND f.id=(SELECT f2.id FROM jobs f2 WHERE f2.project_id=f.project_id AND f2.type='compute_candidate'
            AND f2.status='failed' AND json_extract(f2.payload_json,'$.candidate_id')=c.id
            AND COALESCE(json_extract(f2.payload_json,'$.phase'),'exploration')='exploration'
            ORDER BY f2.updated_at DESC,f2.created_at DESC LIMIT 1)
        LIMIT 20
      )`,[recoveryTs,recoveryTs,recoveryRevision,projectId,cycle,recoveryRevision]);
    const recoveredCount=Number(recovered?.meta?.changes||0);

    // 과거 실패 횟수 자체는 더 이상 영구 차단 근거로 사용하지 않는다. 현재 코드 revision에서
    // 이미 한 번 자동복구 후 다시 exhausted 된 후보만 막는다. 새 후보/실패 없는 후보는 즉시 enqueue한다.
    const missing=await all(env.DB,`SELECT c.id FROM design_candidates c WHERE c.project_id=? AND c.research_cycle=? AND c.status='pending'
      AND NOT EXISTS(SELECT 1 FROM simulation_runs r WHERE r.candidate_id=c.id AND r.phase='exploration')
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.project_id=c.project_id AND j.type='compute_candidate' AND json_extract(j.payload_json,'$.candidate_id')=c.id AND j.status IN ('queued','running'))
      AND NOT EXISTS(SELECT 1 FROM jobs f WHERE f.project_id=c.project_id AND f.type='compute_candidate'
        AND json_extract(f.payload_json,'$.candidate_id')=c.id AND f.status='failed'
        AND json_extract(f.payload_json,'$._recovery_revision')=?)
      LIMIT 20`,[projectId,cycle,recoveryRevision]);
    if(recoveredCount||missing.length)await ensureFrozenProtocol(env,projectId);
    const queued=await enqueueMany(env,projectId,'compute_candidate',missing.map(c=>({candidate_id:c.id,phase:'exploration',cycle:0})),40);
    await setStage(env,p,'compute');
    return {stage:'cdrs_boundary_search',active,pending,evaluated,recovered:recoveredCount,queued,total,batch_size:FOLLOWUP_COMPUTE_BATCH,waiting:recoveredCount?'recovered_exhausted_or_missing_jobs':queued?'processing_next_20_candidate_batch':'current_revision_failures_require_inspection'};
  }
  const unfinished=await jobExists(env,projectId,'compute_candidate','exploration')||await jobExists(env,projectId,'compute_candidate','refinement')||await jobExists(env,projectId,'compute_candidate','confirmation');
  if(unfinished){ await setStage(env,p,'compute'); return {stage:'cdrs_boundary_search',active,queued:1,total}; }
  if(feasible===0){ await setStage(env,p,'compute'); return {stage:'hold',reason:'no_statistically_confirmed_feasible_candidates'}; }

  // 이전: simulation_runs 를 phase 별로 3번, validations 를 3번 — 모두 project_id 인덱스가 없어 전체 스캔.
  // 이후: 커버링 인덱스로 GROUP BY 1회씩.
  const runAgg=await all(env.DB,`SELECT r.phase,COUNT(DISTINCT r.candidate_id) n FROM simulation_runs r JOIN design_candidates c ON c.id=r.candidate_id WHERE r.project_id=? AND c.research_cycle=? AND r.phase IN ('historical','stress') GROUP BY r.phase`,[projectId,cycle]);
  const rn=Object.fromEntries(runAgg.map(r=>[r.phase,Number(r.n||0)]));
  const recomputeNow=await one(env.DB,`SELECT COUNT(DISTINCT r.candidate_id) n FROM simulation_runs r JOIN design_candidates c ON c.id=r.candidate_id WHERE r.project_id=? AND c.research_cycle=? AND r.phase='recompute' AND r.evidence_revision=?`,[projectId,cycle,rev]);
  rn.recompute=Number(recomputeNow?.n||0);
  if((rn.historical||0)<feasible || (rn.stress||0)<feasible){
    if(!(await jobExists(env,projectId,'compute_candidate','historical')) && !(await jobExists(env,projectId,'compute_candidate','stress'))) await enqueueRobustValidation(env,projectId);
    await setStage(env,p,'validate');
    return {stage:'robust'};
  }

  const valAgg=await all(env.DB,`SELECT v.validation_type t,v.status s,COUNT(*) c,COUNT(DISTINCT v.candidate_id) d FROM validations v LEFT JOIN design_candidates dc ON dc.id=v.candidate_id WHERE v.project_id=? AND dc.research_cycle=? AND (v.validation_type='robust' OR (v.validation_type='human_recompute' AND v.evidence_revision=?)) GROUP BY v.validation_type,v.status`,[projectId,cycle,rev]);
  const robustRows=valAgg.filter(v=>v.t==='robust').reduce((a,v)=>a+Number(v.c||0),0);
  const robustConfirmed=Number(valAgg.find(v=>v.t==='robust'&&v.s==='CONFIRM')?.d||0);
  const humanRows=valAgg.filter(v=>v.t==='human_recompute').reduce((a,v)=>a+Number(v.c||0),0);
  if(robustRows<total){
    if(!(await jobExists(env,projectId,'validate_project'))) await enqueue(env,projectId,'validate_project',{},55);
    await setStage(env,p,'validate');
    return {stage:'validate'};
  }

  // Never advance to human fitting when G3 has no confirmed robust candidate.
  // Older builds could fit a reviewer model directly from HUMAN_TRIAL evidence and display
  // G4 PASS while G3 was WAIT; G5 then had zero candidates to recompute and stalled.
  if(robustConfirmed===0){
    await setStage(env,p,'validate');
    return {stage:'hold',reason:'no_robust_confirmed_candidates',gate:'G3'};
  }

  const reviewer=await one(env.DB,`SELECT id FROM reviewer_models WHERE project_id=? AND research_cycle=? AND evidence_revision=? ORDER BY version DESC LIMIT 1`,[projectId,cycle,rev]);
  if(!reviewer){
    // 이전: 표본 게이트(참가자 30명, 정답/오답 각 60건)를 통과할 때까지 fit_reviewer ↔ advance_project 가
    //       (HOLD → 900초 뒤 advance → fit_reviewer ...) 무한 반복하며 매번 reviewer_observations 를 읽었다.
    // 이후: 마지막 HOLD 이후 새 관측이 없으면 대기. 새 관측은 POST /reviewer-observations 가 advance 를 깨운다.
    const latestObs=await one(env.DB,`SELECT created_at FROM reviewer_observations WHERE project_id=? ORDER BY created_at DESC LIMIT 1`,[projectId]);
    const marker=latestObs?.created_at??'';
    if(p.reviewer_hold_marker!==null && p.reviewer_hold_marker!==undefined && p.reviewer_hold_marker===marker){
      await setStage(env,p,'validate');
      return {stage:'human_review',waiting:'no_new_reviewer_observations'};
    }
    if(!(await jobExists(env,projectId,'fit_reviewer'))) await enqueue(env,projectId,'fit_reviewer',{},60);
    await setStage(env,p,'validate');
    return {stage:'human_review'};
  }

  if((rn.recompute||0)<robustConfirmed){
    if(!(await jobExists(env,projectId,'recompute_project'))) await enqueue(env,projectId,'recompute_project',{},65);
    await setStage(env,p,'recompute');
    return {stage:'recompute'};
  }

  if(humanRows<robustConfirmed){
    if(!(await jobExists(env,projectId,'finalize_recompute'))) await enqueue(env,projectId,'finalize_recompute',{},80);
    await setStage(env,p,'recompute');
    return {stage:'recompute_finalize'};
  }

  const approval=await one(env.DB,`SELECT id FROM approvals WHERE project_id=? AND research_cycle=? AND evidence_revision=? AND stale_at IS NULL ORDER BY created_at DESC LIMIT 1`,[projectId,cycle,rev]);
  if(!approval){
    if(!(await jobExists(env,projectId,'approve_project'))) await enqueue(env,projectId,'approve_project',{},90);
    await setStage(env,p,'approved');
    return {stage:'approve'};
  }

  const report=await one(env.DB,`SELECT id FROM reports WHERE project_id=? AND research_cycle=? AND evidence_revision=? AND stale_at IS NULL AND kind='paper_summary' ORDER BY created_at DESC LIMIT 1`,[projectId,cycle,rev]);
  if(!report){
    if(!(await jobExists(env,projectId,'generate_report'))) await enqueue(env,projectId,'generate_report',{},95);
    await setStage(env,p,'report');
    return {stage:'report'};
  }
  await run(env.DB,`UPDATE projects SET approval_stale=0,revalidation_from=NULL WHERE id=?`,[projectId]);
  return {stage:'complete',gates:await approvalGates(env,projectId)};
}

async function execute(env,job){
  const payload=JSON.parse(job.payload_json||'{}'); const id=job.project_id;
  switch(job.type){
    case 'seed_empirical_panel': return seedBundledEmpiricalPanel(env,id);
    case 'define_project': { const r=await defineProject(env,id); if(r.status==='CONFIRM') await enqueue(env,id,'collect_project',{},20); return r; }
    case 'collect_project': { const r=await collectProject(env,id,{dueOnly:!!payload.refresh}); if(Number(r.inserted||0)+Number(r.empiricalRows||0)>0) await registerEvidence(env,id,{kind:Number(r.empiricalRows||0)>0?'EMPIRICAL_EPISODE':'EXTERNAL_DATA',source:'scheduled_collector',detail:{inserted:r.inserted,empiricalRows:r.empiricalRows}}); if(Number(r.empiricalRows||0)>0) await enqueueOnce(env,id,'refit_empirical',{},22);
      // 주기 갱신(refresh)에서 새로 들어온 행이 없으면 측정 → 후보 재시드 연쇄를 건너뛴다. 최초 실행은 항상 진행.
      if(!(payload.refresh && Number(r.inserted||0)===0 && Number(r.empiricalRows||0)===0)) await enqueue(env,id,'measure_project',{},30);
      return r; }
    case 'measure_project': { const r=await measureProject(env,id); await enqueue(env,id,'seed_candidates',{},35); return r; }
    case 'seed_candidates': return seedCandidates(env,id);
    case 'refit_empirical': { const r=await refitEmpiricalCalibration(env,id,{promote:true}); await enqueueOnce(env,id,'advance_project',{},98,5); return r; }
    case 'compute_candidate': { const r=await computeCandidate(env,id,payload.candidate_id,payload.phase,payload.cycle||0); await enqueueOnce(env,id,'advance_project',{},98,5); return r; }
    case 'advance_project': return advanceProject(env,id);
    case 'validate_project': { const r=await validateProject(env,id); await enqueueOnce(env,id,'advance_project',{},98,5); return r; }
    case 'fit_reviewer': return fitReviewerModel(env,id);   // HOLD 시 자기 재예약(900초 폴링) 제거: 새 관측이 오면 API 가 advance 를 깨운다
    case 'recompute_project': { const r=await enqueueRecompute(env,id); if(Number(r?.queued||0)===0) await enqueueOnce(env,id,'advance_project',{},98,1); return r; }
    case 'finalize_recompute': { const r=await finalizeRecompute(env,id); await enqueueOnce(env,id,'advance_project',{},98,5); return r; }
    case 'approve_project': return approveProject(env,id);
    case 'generate_report': { const r=await generateReport(env,id,{checkpoint:!!payload.checkpoint}); if(payload.checkpoint) await enqueueOnce(env,id,'advance_project',{},98,1); return r; }
    case 'compare_study': return compareStudy(env,payload.study_id);
    default: throw new Error(`unknown_job:${job.type}`);
  }
}

export async function processJobs(env){
  if(env.COMPUTE_EXECUTOR==='github-actions'&&env.EXTERNAL_RUNTIME!=='github-actions')return [{status:'waiting_for_github_actions'}];
  const jobs=await claimJobs(env,Number(env.MAX_JOBS_PER_TICK||4)); const results=[];
  for(const job of jobs){ env.RUNNER_JOB_OBSERVER?.(job.type,'job_started');try{ const out=await execute(env,job); await finishJob(env,job);env.RUNNER_JOB_OBSERVER?.(job.type,'job_completed'); results.push({id:job.id,type:job.type,ok:true,out}); } catch(e){ if(e.message==='runner_api_budget_exhausted'&&env.DB.withControl){await env.DB.withControl(()=>run(env.DB,`UPDATE jobs SET status='queued',locked_at=NULL,attempts=MAX(0,attempts-1),run_after=?,updated_at=?,last_error='deferred_api_budget' WHERE id=?`,[new Date().toISOString(),new Date().toISOString(),job.id]));results.push({id:job.id,type:job.type,ok:null,deferred:true});break;} env.RUNNER_JOB_OBSERVER?.(job.type,'job_failed',e);await finishJob(env,job,e); results.push({id:job.id,type:job.type,ok:false,error:String(e)}); } }
  return results;
}

export async function processFastLane(env,{rounds=3}={}){
  const out=[];
  // Worker fast-path intentionally runs a short chain in one scheduled/request event.
  // Newly-enqueued heavy jobs remain queued for GitHub; shared transition jobs can be
  // consumed immediately by whichever runtime is already active.
  for(let i=0;i<Math.max(1,Math.min(4,Number(rounds)||1));i++){
    const batch=await processJobs(env);
    if(!Array.isArray(batch)||!batch.length)break;
    out.push(...batch);
    if(batch.some(x=>x?.ok===false))break;
  }
  return out;
}

export async function scheduleAll(env,{process=true}={}){
  if(env.COMPUTE_EXECUTOR==='github-actions'&&env.EXTERNAL_RUNTIME!=='github-actions')return {transport:'github-actions',status:'waiting_for_runner'};
  // v0.7.5 starvation repair: a queued advance_project from older builds may still have
  // priority 5. Demote it before selecting projects so GitHub can claim compute_candidate
  // first even when the existing advance job causes the project to be omitted below.
  await run(env.DB,`UPDATE jobs SET priority=90,updated_at=? WHERE type='advance_project' AND status='queued' AND priority<90
    AND EXISTS(SELECT 1 FROM projects p JOIN design_candidates c ON c.project_id=p.id AND c.research_cycle=p.research_cycle
      WHERE p.id=jobs.project_id AND c.status='pending')`,[new Date().toISOString()]);
  // Deployment-safe batching: older builds may already have queued up to 100 exploration jobs.
  // Keep only the oldest 20 queued exploration jobs per project; candidates behind them remain
  // pending and will be re-enqueued by advanceProject after the next checkpoint report.
  await run(env.DB,`DELETE FROM jobs WHERE id IN (
    SELECT id FROM (
      SELECT j.id,ROW_NUMBER() OVER(PARTITION BY j.project_id ORDER BY j.created_at,j.id) rn
      FROM jobs j JOIN projects p ON p.id=j.project_id
      WHERE j.type='compute_candidate' AND j.status='queued' AND COALESCE(j.phase,json_extract(j.payload_json,'$.phase'),'exploration')='exploration'
        AND EXISTS(SELECT 1 FROM design_candidates c WHERE c.project_id=j.project_id AND c.research_cycle=p.research_cycle AND c.status='pending')
    ) WHERE rn>20
  )`);
  // 완료된 프로젝트는 대상에서 제외(이전: 모든 auto_run 프로젝트에 15분마다 advance + 데이터소스 집계)
  // Two indexed EXISTS probes inside ONE bounded set query replace N per-project reads.
  const ps=await all(env.DB,`SELECT p.id,
    EXISTS(SELECT 1 FROM design_candidates c WHERE c.project_id=p.id AND c.research_cycle=p.research_cycle AND c.status='pending') pending_compute,
    EXISTS(SELECT 1 FROM data_sources s WHERE s.project_id=p.id AND s.enabled=1 AND (s.last_fetched_at IS NULL OR datetime(s.last_fetched_at, '+' || s.cadence_minutes || ' minutes')<=datetime('now'))) due,
    EXISTS(SELECT 1 FROM jobs j WHERE j.project_id=p.id AND j.type='collect_project' AND j.status IN ('queued','running')) collecting
    FROM projects p WHERE p.auto_run=1 AND (p.status NOT IN ('complete','report_ready') OR EXISTS(SELECT 1 FROM design_candidates c WHERE c.project_id=p.id AND c.research_cycle=p.research_cycle AND c.status='pending'))
    AND (NOT EXISTS(SELECT 1 FROM jobs a WHERE a.project_id=p.id AND a.type='advance_project' AND a.status IN ('queued','running'))
      OR (NOT EXISTS(SELECT 1 FROM jobs b WHERE b.project_id=p.id AND b.type='collect_project' AND b.status IN ('queued','running'))
        AND EXISTS(SELECT 1 FROM data_sources d WHERE d.project_id=p.id AND d.enabled=1 AND (d.last_fetched_at IS NULL OR datetime(d.last_fetched_at, '+' || d.cadence_minutes || ' minutes')<=datetime('now')))))
    ORDER BY p.updated_at,p.id LIMIT 4`);
  for(const p of ps){
    await enqueueOnce(env,p.id,'advance_project',{},p.pending_compute?90:99);
    if(p.due&&!p.collecting&&!p.pending_compute)await enqueueOnce(env,p.id,'collect_project',{refresh:true},25);
  }
  // Progress reports are available before human/sign-off gates pass; coalesce pending work.
  let missingReports;
  try{missingReports=await all(env.DB,`SELECT p.id FROM projects p
    LEFT JOIN project_cycle_stats pcs ON pcs.project_id=p.id AND pcs.research_cycle=p.research_cycle
    WHERE p.auto_run=1
    AND EXISTS(SELECT 1 FROM definitions d WHERE d.project_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM reports r WHERE r.project_id=p.id AND r.research_cycle=p.research_cycle AND r.evidence_revision=p.evidence_revision AND r.stale_at IS NULL
      AND r.created_at>=COALESCE(pcs.latest_simulation_at,r.created_at))
    AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.project_id=p.id AND j.type='generate_report' AND j.status IN ('queued','running'))
    ORDER BY p.updated_at,p.id LIMIT 4`);}catch(_){
    // Compatibility only until migration 0022 is applied. This old path is intentionally
    // isolated so production switches to the O(1) cycle summary immediately after migration.
    missingReports=await all(env.DB,`SELECT p.id FROM projects p WHERE p.auto_run=1
      AND EXISTS(SELECT 1 FROM definitions d WHERE d.project_id=p.id)
      AND NOT EXISTS(SELECT 1 FROM reports r WHERE r.project_id=p.id AND r.research_cycle=p.research_cycle AND r.evidence_revision=p.evidence_revision AND r.stale_at IS NULL
        AND r.created_at>=COALESCE((SELECT MAX(sr.created_at) FROM simulation_runs sr JOIN design_candidates dc ON dc.id=sr.candidate_id WHERE sr.project_id=p.id AND dc.research_cycle=p.research_cycle),r.created_at))
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.project_id=p.id AND j.type='generate_report' AND j.status IN ('queued','running'))
      ORDER BY p.updated_at,p.id LIMIT 4`);
  }
  for(const p of missingReports)await enqueueOnce(env,p.id,'generate_report',{},105);
  // 끝난 job 정리는 하루 4회(UTC 0/6/12/18시 첫 Cron)만 — 전용 인덱스를 두면 매 job 상태 변경마다 쓰기가 늘어난다.
  { const t=new Date(); if(t.getUTCHours()%6===0 && t.getUTCMinutes()<15){ try{ await pruneJobs(env); }catch(_){} } }
  if(env.CDRS_QUEUE){ const woke=await wakeDueJobs(env); return {scheduled:ps.length,woke,transport:'cloudflare-queue'}; }
  return process?processJobs(env):{scheduled:ps.length,transport:env.COMPUTE_EXECUTOR==='hybrid'?'hybrid-fast-path':'github-actions'};
}
