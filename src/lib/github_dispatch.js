import { nowIso, uid } from './util.js';

const HEAVY_EXCLUSIONS = [
  'measure_project','seed_candidates',
  'advance_project','recompute_project','finalize_recompute','approve_project'
];
const HEAVY_EXCLUSION_SQL = HEAVY_EXCLUSIONS.map(x=>`'${x}'`).join(',');
const DISPATCH_LEASE_ID = 'github-dispatch';
const RUNNER_LEASE_ID = 'research';

function cfg(env){
  return {
    token:String(env.GITHUB_ACTIONS_TOKEN||'').trim(),
    owner:String(env.GITHUB_OWNER||'').trim(),
    repo:String(env.GITHUB_REPO||'').trim(),
    workflow:String(env.GITHUB_WORKFLOW||'dcv-research.yml').trim(),
    ref:String(env.GITHUB_REF||'main').trim(),
    cooldownSeconds:Math.max(60,Number(env.GITHUB_DISPATCH_COOLDOWN_SECONDS||180)||180)
  };
}

async function first(env,sql,binds=[]){ return env.DB.prepare(sql).bind(...binds).first(); }
async function run(env,sql,binds=[]){ return env.DB.prepare(sql).bind(...binds).run(); }

export async function githubRunnerStatus(env){
  const c=cfg(env), now=nowIso();
  const heavy=await first(env,`SELECT COUNT(*) n,MIN(created_at) oldest FROM jobs WHERE status='queued' AND run_after<=? AND type NOT IN (${HEAVY_EXCLUSION_SQL})`,[now]);
  const runner=await first(env,`SELECT lease_until,last_completed_at,jobs_completed FROM external_runner_leases WHERE id=?`,[RUNNER_LEASE_ID]);
  const dispatch=await first(env,`SELECT lease_until,updated_at FROM external_runner_leases WHERE id=?`,[DISPATCH_LEASE_ID]);
  return {
    configured:!!(c.token&&c.owner&&c.repo&&c.workflow&&c.ref),
    owner:c.owner||null,repo:c.repo||null,workflow:c.workflow||null,ref:c.ref||null,
    heavy_due:Number(heavy?.n||0),oldest_heavy_job:heavy?.oldest||null,
    runner_active:!!(runner?.lease_until&&runner.lease_until>now),runner_lease_until:runner?.lease_until||null,
    last_completed_at:runner?.last_completed_at||null,jobs_completed:Number(runner?.jobs_completed||0),
    dispatch_cooldown_active:!!(dispatch?.lease_until&&dispatch.lease_until>now),dispatch_cooldown_until:dispatch?.lease_until||null,
    dispatch_updated_at:dispatch?.updated_at||null
  };
}

export async function dispatchGithubActionsIfNeeded(env,{force=false,reason='heavy_queue'}={}){
  if(String(env.COMPUTE_EXECUTOR||'')!=='hybrid') return {status:'not_hybrid'};
  if(env.EXTERNAL_RUNTIME==='github-actions') return {status:'already_in_github_actions'};
  const c=cfg(env);
  if(!(c.token&&c.owner&&c.repo&&c.workflow&&c.ref)) return {status:'not_configured'};
  const now=nowIso();
  if(!force){
    const heavy=await first(env,`SELECT COUNT(*) n,MIN(created_at) oldest FROM jobs WHERE status='queued' AND run_after<=? AND type NOT IN (${HEAVY_EXCLUSION_SQL})`,[now]);
    if(Number(heavy?.n||0)===0) return {status:'no_heavy_work'};
    const active=await first(env,`SELECT lease_until FROM external_runner_leases WHERE id=?`,[RUNNER_LEASE_ID]);
    if(active?.lease_until&&active.lease_until>now) return {status:'runner_active',lease_until:active.lease_until};
  }
  const token=uid('dispatch');
  const until=new Date(Date.now()+c.cooldownSeconds*1000).toISOString();
  const lock=await run(env,`INSERT INTO external_runner_leases(id,token,lease_until,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until,updated_at=excluded.updated_at
    WHERE external_runner_leases.lease_until<?`,[DISPATCH_LEASE_ID,token,until,now,now]);
  if(!Number(lock.meta?.changes||0)) return {status:'dispatch_cooldown'};
  const f=env.GITHUB_FETCH||fetch;
  const url=`https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/actions/workflows/${encodeURIComponent(c.workflow)}/dispatches`;
  let response;
  try{
    response=await f(url,{method:'POST',headers:{
      authorization:`Bearer ${c.token}`,
      accept:'application/vnd.github+json',
      'content-type':'application/json',
      'user-agent':'dcv-research-platform',
      'x-github-api-version':'2022-11-28'
    },body:JSON.stringify({ref:c.ref,inputs:{}})});
  }catch(error){
    await run(env,`UPDATE external_runner_leases SET lease_until=?,updated_at=? WHERE id=? AND token=?`,[nowIso(),nowIso(),DISPATCH_LEASE_ID,token]);
    return {status:'dispatch_network_error',error:String(error?.message||error).slice(0,300)};
  }
  if(response.status===204){
    return {status:'dispatched',reason,cooldown_until:until};
  }
  const body=await response.text().catch(()=>'');
  await run(env,`UPDATE external_runner_leases SET lease_until=?,updated_at=? WHERE id=? AND token=?`,[nowIso(),nowIso(),DISPATCH_LEASE_ID,token]);
  return {status:'dispatch_failed',http_status:response.status,error:body.slice(0,500)};
}
