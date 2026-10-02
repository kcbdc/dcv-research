import { nowIso, uid } from './util.js';

export async function one(db, sql, binds = []) { return db.prepare(sql).bind(...binds).first(); }
export async function all(db, sql, binds = []) { const r = await db.prepare(sql).bind(...binds).all(); return r.results || []; }
export async function run(db, sql, binds = []) { return db.prepare(sql).bind(...binds).run(); }

export async function audit(env, projectId, actor, action, entityType=null, entityId=null, detail={}) {
  await run(env.DB, `INSERT INTO audit_log(id,project_id,actor,action,entity_type,entity_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?)`,
    [uid('audit'), projectId, actor, action, entityType, entityId, JSON.stringify(detail), nowIso()]);
}

const MAX_QUEUE_DELAY = 43200;   // Cloudflare Queues delaySeconds 상한(12시간)

// Hybrid executor lanes. Keep the Worker lane deliberately small because the Free plan
// has a tight CPU budget; heavy statistical work remains on GitHub Actions.
export const WORKER_LIGHT_JOB_TYPES = Object.freeze(['advance_project','approve_project']);
const WORKER_LIGHT_SET = new Set(WORKER_LIGHT_JOB_TYPES);
export function jobExecutionLane(type){ return WORKER_LIGHT_SET.has(String(type)) ? 'worker-light' : 'github-heavy'; }
function runtimeLane(env){
  const mode=String(env.COMPUTE_EXECUTOR||'cloudflare');
  if(mode==='hybrid') return env.EXTERNAL_RUNTIME==='github-actions'?'github-heavy':'worker-light';
  if(mode==='github-actions') return env.EXTERNAL_RUNTIME==='github-actions'?'all':'none';
  return 'all';
}
async function sendWake(env, bodies, delaySeconds=0) {
  if (env.COMPUTE_EXECUTOR==='github-actions' || !env.CDRS_QUEUE || !bodies.length) return;
  const wakeBodies=env.COMPUTE_EXECUTOR==='hybrid'?bodies.filter(b=>jobExecutionLane(b.type)==='worker-light'):bodies;
  if(!wakeBodies.length)return;
  const opts = delaySeconds > 0 ? { delaySeconds: Math.min(MAX_QUEUE_DELAY, Math.ceil(delaySeconds)) } : undefined;
  try {
    if (wakeBodies.length === 1) await env.CDRS_QUEUE.send(wakeBodies[0], opts);
    else for (let i=0;i<wakeBodies.length;i+=100) await env.CDRS_QUEUE.sendBatch(wakeBodies.slice(i,i+100).map(body=>({body})), opts);
  } catch (_) {}
}

export async function enqueue(env, projectId, type, payload={}, priority=100, delaySeconds=0) {
  const t = new Date(Date.now()+delaySeconds*1000).toISOString();
  const id=uid('job'), now=nowIso();
  await run(env.DB, `INSERT INTO jobs(id,project_id,type,status,priority,payload_json,phase,run_after,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?,?,?,?)`,
    [id, projectId, type, priority, JSON.stringify(payload), payload?.phase ?? null, t, now, now]);
  // Queue is the execution transport; D1 remains the durable source of truth and fallback queue.
  // 메시지도 run_after 와 같은 시각에 도착시킨다. 지연 없이 보내면 컨슈머가 아직 due 가 아닌 job 을 못 집고 ack 해,
  // 그 job 은 다음 메시지가 올 때까지 방치된다(enqueueOnce 가 중복 생성을 막으므로 되살릴 경로도 없다).
  await sendWake(env, [{ job_id:id, project_id:projectId, type }], delaySeconds);
  return id;
}

// 같은 (project,type)의 대기(queued) 작업이 이미 있으면 새로 만들지 않는다.
// compute_candidate 가 끝날 때마다 advance_project 를 무조건 enqueue 하던 것(후보 수만큼 중복)을 1건으로 합친다.
// 'running' 은 중복으로 보지 않는다: 실행 중인 작업은 이미 상태를 읽었을 수 있어 뒤따르는 1건이 필요하다.
export async function enqueueOnce(env, projectId, type, payload={}, priority=100, delaySeconds=0) {
  // Atomic insert-if-absent: avoids a SELECT round-trip for every enqueue attempt.
  const t = new Date(Date.now()+delaySeconds*1000).toISOString(), id=uid('job'), now=nowIso();
  const r = await run(env.DB, `INSERT INTO jobs(id,project_id,type,status,priority,payload_json,phase,run_after,created_at,updated_at)
    SELECT ?,?,?, 'queued',?,?,?,?,?,?
    WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE project_id IS ? AND type=? AND status='queued')`,
    [id,projectId,type,priority,JSON.stringify(payload),payload?.phase ?? null,t,now,now,projectId,type]);
  if ((r.meta?.changes || 0) <= 0) return null;
  await sendWake(env, [{ job_id:id, project_id:projectId, type }], delaySeconds);
  return id;
}

let lastStaleSweep = 0;
export async function recoverStaleJobs(env, minutes=8) {
  // A Worker killed by a resource limit never reaches finishJob, leaving the job 'running' forever.
  if (Date.now()-lastStaleSweep < 120000) return;   // 큐 메시지마다가 아니라 isolate 당 2분에 1회만 점검
  lastStaleSweep = Date.now();
  const cutoff = new Date(Date.now()-minutes*60000).toISOString();
  await run(env.DB, `UPDATE jobs SET status=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'queued' END, locked_at=NULL, run_after=?, last_error='stale_lock_recovered: lease expired; termination cause unverified', updated_at=? WHERE status='running' AND locked_at IS NOT NULL AND locked_at<?`, [nowIso(), nowIso(), cutoff]);
}

export async function enqueueMany(env, projectId, type, payloads=[], priority=100) {
  // One D1 batch + chunked queue sends instead of one round-trip per job (Free plan subrequest limit).
  if (!payloads.length) return 0;
  const now = nowIso(), ids = payloads.map(()=>uid('job'));
  const inserts=[];
  for(let offset=0;offset<payloads.length;offset+=100){const rows=payloads.slice(offset,offset+100).map((pl,i)=>({id:ids[offset+i],payload:pl,phase:pl?.phase??null}));
    inserts.push(env.DB.prepare(`INSERT INTO jobs(id,project_id,type,status,priority,payload_json,phase,run_after,created_at,updated_at)
      SELECT json_extract(value,'$.id'),?,?,'queued',?,json_extract(value,'$.payload'),json_extract(value,'$.phase'),?,?,? FROM json_each(?)`).bind(projectId,type,priority,now,now,now,JSON.stringify(rows)));}
  await env.DB.batch(inserts);
  await sendWake(env, ids.map(id=>({ job_id:id, project_id:projectId, type })));
  return ids.length;
}

export async function claimJobs(env, limit=4) {
  await recoverStaleJobs(env);
  const lane=runtimeLane(env); if(lane==='none')return [];
  const remaining=env.EXTERNAL_RUNTIME==='github-actions'&&typeof env.DB.remaining==='number'?env.DB.remaining:1000000;
  const laneSql=lane==='worker-light'?` AND type IN ('advance_project','approve_project')`:lane==='github-heavy'?` AND type NOT IN ('advance_project','approve_project')`:'';
  // An oversized collector must not block smaller compute jobs behind it. In hybrid mode,
  // the same indexed queue is partitioned by job type so Worker and Actions never steal each other's work.
  const jobs = await all(env.DB, `SELECT * FROM jobs WHERE status='queued' AND run_after<=?${laneSql}
    AND CASE type WHEN 'collect_project' THEN 180 WHEN 'generate_report' THEN 100 WHEN 'advance_project' THEN 90 ELSE 60 END<=?
    ORDER BY priority ASC, created_at ASC LIMIT ?`, [nowIso(), remaining, limit]);
  if(!jobs.length&&remaining<180){const waiting=await one(env.DB,`SELECT 1 x FROM jobs WHERE status='queued' AND run_after<=? LIMIT 1`,[nowIso()]);if(waiting)env.RUNNER_BUDGET_DEFERRED=true;}
  const claimed=[];
  for (const j of jobs) {
    const needed=j.type==='collect_project'?180:j.type==='generate_report'?100:j.type==='advance_project'?90:60;
    if(env.EXTERNAL_RUNTIME==='github-actions'&&typeof env.DB.remaining==='number'&&env.DB.remaining<needed){env.RUNNER_BUDGET_DEFERRED=true;break;}
    const r = await run(env.DB, `UPDATE jobs SET status='running', locked_at=?, attempts=attempts+1, updated_at=? WHERE id=? AND status='queued'`, [nowIso(), nowIso(), j.id]);
    if ((r.meta?.changes || 0) > 0) claimed.push({...j, attempts:(j.attempts||0)+1});
  }
  return claimed;
}

export async function finishJob(env, job, error=null) {
  if (!error) {
    await run(env.DB, `UPDATE jobs SET status='done', updated_at=?, last_error=NULL WHERE id=?`, [nowIso(), job.id]);
    return;
  }
  const max = job.max_attempts || 5;
  const retry = (job.attempts || 1) < max;
  const backoff = Math.min(3600, 30*Math.pow(2, job.attempts || 1));
  const next = new Date(Date.now() + backoff*1000).toISOString();
  await run(env.DB, `UPDATE jobs SET status=?, run_after=?, locked_at=NULL, last_error=?, updated_at=? WHERE id=?`,
    [retry?'queued':'failed', next, String(error).slice(0,2000), nowIso(), job.id]);
  // 재시도 job 에도 깨우기 메시지를 예약(이전에는 다음 무관한 메시지가 올 때까지 방치될 수 있었다)
  if (retry) await sendWake(env, [{ job_id:job.id, project_id:job.project_id, type:job.type }], backoff);
}

// 끝난 job 행은 더 이상 쓰이지 않지만 jobs 테이블을 계속 키워 모든 jobs 스캔/집계의 비용을 올린다.
export async function pruneJobs(env, days=3) {
  const cutoff = new Date(Date.now()-days*86400000).toISOString();
  const r = await run(env.DB, `DELETE FROM jobs WHERE status='done' AND updated_at<?`, [cutoff]);
  return r.meta?.changes || 0;
}

// 안전망: due 상태인데 깨우는 메시지가 없는 queued job(메시지 유실, 지연 메시지 이전 배포분 등)에 메시지를 다시 보낸다.
// 인덱스(idx_jobs_claim) 순서로 최대 limit 행만 읽으므로 Cron 1회당 읽기는 많아야 limit 행.
export async function wakeDueJobs(env, limit=10) {
  if (!env.CDRS_QUEUE) return 0;
  const lane=runtimeLane(env); if(lane==='none'||lane==='github-heavy')return 0;
  const laneSql=lane==='worker-light'?` AND type IN ('advance_project','approve_project')`:'';
  const rows = await all(env.DB, `SELECT id,project_id,type FROM jobs WHERE status='queued' AND run_after<=?${laneSql} ORDER BY priority ASC, created_at ASC LIMIT ?`, [nowIso(), limit]);
  await sendWake(env, rows.map(r=>({ job_id:r.id, project_id:r.project_id, type:r.type })));
  return rows.length;
}

export async function enqueueComputeOnce(env,projectId,payload,priority){
 const id=uid('job'),ts=nowIso(),body=JSON.stringify(payload);
 const r=await run(env.DB,`INSERT INTO jobs(id,project_id,type,status,priority,payload_json,phase,run_after,created_at,updated_at) SELECT ?,?,'compute_candidate','queued',?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM jobs WHERE project_id=? AND type='compute_candidate' AND payload_json=? AND status IN ('queued','running','done'))`,[id,projectId,priority,body,payload.phase,ts,ts,ts,projectId,body]);
 if(r.meta?.changes)await sendWake(env,[{job_id:id,project_id:projectId,type:'compute_candidate'}]);return r.meta?.changes?id:null;
}
