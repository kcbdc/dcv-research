import {preflightD1,runnerCredentials,safeDiagnostic,RunnerError} from './lib/runner-diagnostics.mjs';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createD1Rest} from './lib/d1-rest.mjs';
import {acquireRunner,heartbeatRunner,releaseRunner} from './lib/actions-runtime.mjs';
import {scheduleAll,processJobs} from '../src/lib/orchestrator.js';
import {scheduleLab} from '../src/lib/lab.js';
export async function runActions(env,{seconds=210,maxJobs=36,maxCalls=420}={}){
 const token=await acquireRunner(env);if(!token)return {status:'runner_already_active',jobs:0};
 const started=Date.now();let completed=0,failures=0,primaryError=null;
 try{
  // Set-level scheduling; one claimed job at a time. The same immutable protocol/seed engine runs here.
  await heartbeatRunner(env,token);
  const initial=await scheduleAll(env,{process:false});
  const first=Array.isArray(initial)?initial:[];
  completed+=first.length;failures+=first.filter(r=>!r.ok).length;
  while(Date.now()-started<seconds*1000&&completed<maxJobs&&(typeof env.DB.remaining==='number'?env.DB.remaining>=60:env.DB.calls<maxCalls-80)){
   await heartbeatRunner(env,token);
   const results=await processJobs(env);if(!results.length)break;
   completed+=results.filter(r=>!r.deferred).length;failures+=results.filter(r=>!r.ok&&!r.deferred).length;if(results.some(r=>r.deferred)){env.RUNNER_BUDGET_DEFERRED=true;break;}
  }
  if(typeof env.DB.remaining==='number'&&env.DB.remaining<60)env.RUNNER_BUDGET_DEFERRED=true;
  if(!env.RUNNER_BUDGET_DEFERRED&&env.AI&&Date.now()-started<(seconds-50)*1000&&env.DB.calls<maxCalls-100){await heartbeatRunner(env,token);const lab=await scheduleLab(env);if(lab.error)failures++;}
  let progress=null;
  if(typeof env.DB.remaining!=='number'||env.DB.remaining>0){
   const result=await env.DB.batch([
    env.DB.prepare(`SELECT j.type,j.phase,j.status,COUNT(*) n FROM jobs j WHERE j.status IN ('queued','running','failed') GROUP BY j.type,j.phase,j.status`),
    env.DB.prepare(`SELECT c.status,COUNT(*) n FROM design_candidates c JOIN projects p ON p.id=c.project_id WHERE c.research_cycle=p.research_cycle GROUP BY c.status`),
    env.DB.prepare(`SELECT COUNT(*) n FROM design_candidates c JOIN projects p ON p.id=c.project_id
      WHERE c.research_cycle=p.research_cycle AND c.status='pending'
        AND NOT EXISTS(SELECT 1 FROM simulation_runs r WHERE r.candidate_id=c.id AND r.phase='exploration')
        AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.project_id=c.project_id AND j.type='compute_candidate'
          AND json_extract(j.payload_json,'$.candidate_id')=c.id AND j.status IN ('queued','running'))`)
   ]);progress={jobs:result[0].results||[],candidates:result[1].results||[],stranded_candidates:Number(result[2].results?.[0]?.n||0)};
  }
  const pending=progress?.jobs.some(j=>j.status==='queued'||j.status==='running');
  return {status:failures?'completed_with_job_errors':env.RUNNER_BUDGET_DEFERRED?'budget_deferred':pending?'work_remaining':'completed',jobs:completed,failures,progress,d1_api_calls:env.DB.calls,elapsed_seconds:Math.round((Date.now()-started)/1000)};
 }catch(error){if(error.message==='runner_api_budget_exhausted')return {status:'budget_deferred',jobs:completed,failures,d1_api_calls:env.DB.calls};primaryError=error;error.stage||='processing_jobs';throw error;}finally{try{if(env.DB.withControl)await env.DB.withControl(()=>releaseRunner(env,token,completed-failures));else await releaseRunner(env,token,completed-failures);}catch(error){if(primaryError)console.error(JSON.stringify({...safeDiagnostic(error),stage:'release_runner_lease'}));else{error.stage='release_runner_lease';throw error;}}}
}
async function main(){
 let stage='load_configuration';try{
 const cfg=JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
 stage='validate_secrets';
 const credentials=runnerCredentials(process.env,cfg.d1_databases[0].database_id);
 const {accountId:CF_ACCOUNT_ID,aiToken:CF_AI_API_TOKEN}=credentials;
 const DB=createD1Rest({...credentials,intervalMs:Number(process.env.D1_REST_INTERVAL_MS||450),maxCalls:Number(process.env.D1_REST_MAX_CALLS||420)});
 stage='preflight_d1';await preflightD1(DB);console.log('D1 preflight OK: connection and required tables verified.');
 const env={...cfg.vars,DB,COMPUTE_EXECUTOR:'hybrid',EXTERNAL_RUNTIME:'github-actions',MAX_JOBS_PER_TICK:String(process.env.MAX_JOBS_PER_TICK||4),RUNNER_CODE_REVISION:process.env.GITHUB_SHA||'local',ECOS_API_KEY:process.env.ECOS_API_KEY,OPENFISCAL_API_KEY:process.env.OPENFISCAL_API_KEY,BOJO_API_KEY:process.env.BOJO_API_KEY,FDIC_API_KEY:process.env.FDIC_API_KEY};
 env.RUNNER_JOB_OBSERVER=(type,stage,error)=>console.log(JSON.stringify({stage,job_type:type,d1_api_calls:DB.calls,...(error?{diagnostic:safeDiagnostic(error)}:{})}));
 if(CF_AI_API_TOKEN)env.AI={run:async(model,input)=>{
  const url=`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${model}`;
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  let lastError=null;
  for(let attempt=0;attempt<3;attempt++){
   const r=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${CF_AI_API_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(55000)});
   let j=null;try{j=await r.json();}catch{}
   if(r.ok&&j?.success!==false)return j?.result;
   const retryAfterRaw=r.headers.get('retry-after');
   const retryAfterSeconds=retryAfterRaw&&/^\d+(?:\.\d+)?$/.test(retryAfterRaw)?Number(retryAfterRaw):null;
   const retryAfterMs=retryAfterSeconds!=null?Math.ceil(retryAfterSeconds*1000):Math.min(1500*(2**attempt),6000);
   const cfErrors=[...(Array.isArray(j?.errors)?j.errors:[]),...(Array.isArray(j?.result?.errors)?j.result.errors:[])];
   const cfCode=cfErrors.map(e=>Number(e?.code)).find(Number.isFinite);
   const cfMessage=cfErrors.map(e=>String(e?.message||'')).filter(Boolean).join(' | ');
   const contextExceeded=cfCode===5021||/context window|context.*limit|maximum.*tokens|exceeded.*tokens/i.test(cfMessage);
   const error=new Error(contextExceeded?`Workers AI context limit exceeded (5021): ${cfMessage||'request exceeds model context window'}`:`Workers AI REST failed (${r.status})${cfMessage?`: ${cfMessage.slice(0,180)}`:''}`);
   error.status=r.status;error.cfCode=cfCode;error.code=contextExceeded?'AI_CONTEXT_LIMIT':r.status===429?'AI_RATE_LIMITED':'AI_REST_FAILED';error.retryAfterMs=retryAfterMs;
   lastError=error;
   // 5021은 요청 크기 문제라 재시도로 해결되지 않는다. 상위 aiJson이 규칙 기반 fallback으로 전환한다.
   if(contextExceeded)throw error;
   // 429/5xx는 같은 모델에서만 제한적으로 재시도한다. 모델 전환으로 계정 단위 rate limit을 증폭하지 않는다.
   if(attempt<2&&(r.status===429||r.status>=500)){await sleep(Math.min(retryAfterMs,8000));continue;}
   throw error;
  }
  throw lastError||new Error('Workers AI REST failed');
 }};
 stage='acquire_and_process_jobs';const result=await runActions(env);console.log(JSON.stringify(result));if(result.failures)process.exitCode=1;
 }catch(error){error.stage||=stage;throw error;}
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(error=>{console.error('Actions runner failed: '+JSON.stringify(safeDiagnostic(error)));process.exitCode=1;});
