import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {enqueue,claimJobs,finishJob,jobExecutionLane} from '../src/lib/db.js';
import {processJobs} from '../src/lib/orchestrator.js';
import {computeCandidate} from '../src/lib/compute.js';
import {scheduleLab} from '../src/lib/lab.js';

test('hybrid lane classification uses aggressive Worker fast path and shared transitions',()=>{
  assert.equal(jobExecutionLane('measure_project'),'worker-fast');
  assert.equal(jobExecutionLane('seed_candidates'),'worker-fast');
  for(const t of ['advance_project','recompute_project','finalize_recompute','approve_project']) assert.equal(jobExecutionLane(t),'shared-fast');
  for(const t of ['compute_candidate','validate_project','fit_reviewer','collect_project','generate_report','refit_empirical','define_project']) assert.equal(jobExecutionLane(t),'github-heavy');
});

test('hybrid Worker claims worker-fast/shared but leaves heavy compute for GitHub',async()=>{
  const DB=makeDb(),id=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
  DB.raw.exec('DELETE FROM jobs');
  await enqueue({DB,COMPUTE_EXECUTOR:'hybrid'},id,'measure_project',{},8);
  await enqueue({DB,COMPUTE_EXECUTOR:'hybrid'},id,'advance_project',{},10);
  await enqueue({DB,COMPUTE_EXECUTOR:'hybrid'},id,'compute_candidate',{candidate_id:'cand_0',phase:'exploration',cycle:0},20);
  const worker=await claimJobs({DB,COMPUTE_EXECUTOR:'hybrid'},4);
  assert.deepEqual(worker.map(x=>x.type),['measure_project','advance_project']);
  for(const j of worker)await finishJob({DB,COMPUTE_EXECUTOR:'hybrid'},j);
  const github=await claimJobs({DB,COMPUTE_EXECUTOR:'hybrid',EXTERNAL_RUNTIME:'github-actions'},4);
  assert.deepEqual(github.map(x=>x.type),['compute_candidate']);
});

test('shared-fast transition can be claimed by GitHub immediately after heavy compute',async()=>{
  const DB=makeDb(),id=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
  DB.raw.exec('DELETE FROM jobs');
  await enqueue({DB,COMPUTE_EXECUTOR:'hybrid'},id,'advance_project',{},10);
  const github=await claimJobs({DB,COMPUTE_EXECUTOR:'hybrid',EXTERNAL_RUNTIME:'github-actions'},4);
  assert.deepEqual(github.map(x=>x.type),['advance_project']);
});

test('hybrid public Worker cannot run heavy compute or LAB directly',async()=>{
  const env={COMPUTE_EXECUTOR:'hybrid',DB:{prepare(){throw Error('unexpected read');}}};
  await assert.rejects(computeCandidate(env,'missing','missing'),/compute_requires_github_actions/);
  assert.equal((await scheduleLab(env)).status,'waiting_for_github_actions');
});

test('hybrid processJobs on Worker leaves heavy compute queued',async()=>{
  const DB=makeDb(),id=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
  DB.raw.exec('DELETE FROM jobs');
  await enqueue({DB,COMPUTE_EXECUTOR:'hybrid'},id,'compute_candidate',{candidate_id:'cand_0',phase:'exploration',cycle:0},20);
  const out=await processJobs({DB,COMPUTE_EXECUTOR:'hybrid',MAX_JOBS_PER_TICK:4});
  assert.equal(out.length,0);
  assert.equal(DB.raw.prepare("SELECT status FROM jobs WHERE type='compute_candidate'").get().status,'queued');
});

test('GitHub hybrid prioritizes compute_candidate over low-priority-number shared advance jobs',async()=>{
  const DB=makeDb(),id=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
  DB.raw.exec('DELETE FROM jobs');
  // Reproduce v0.7.4 starvation: advance priority 5, compute priority 40.
  await enqueue({DB,COMPUTE_EXECUTOR:'hybrid'},id,'advance_project',{},5);
  await enqueue({DB,COMPUTE_EXECUTOR:'hybrid'},id,'compute_candidate',{candidate_id:'cand_0',phase:'exploration',cycle:0},40);
  const github=await claimJobs({DB,COMPUTE_EXECUTOR:'hybrid',EXTERNAL_RUNTIME:'github-actions'},1);
  assert.equal(github.length,1);
  assert.equal(github[0].type,'compute_candidate');
});

test('scheduleAll demotes stale queued advance jobs while pending candidates need compute',async()=>{
  const DB=makeDb(),id=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
  DB.raw.exec("DELETE FROM jobs");
  DB.raw.prepare("UPDATE design_candidates SET status='pending' WHERE project_id=?").run(id);
  await enqueue({DB,COMPUTE_EXECUTOR:'hybrid'},id,'advance_project',{},5);
  const {scheduleAll}=await import('../src/lib/orchestrator.js');
  await scheduleAll({DB,COMPUTE_EXECUTOR:'hybrid',EXTERNAL_RUNTIME:'github-actions'},{process:false});
  const row=DB.raw.prepare("SELECT priority FROM jobs WHERE project_id=? AND type='advance_project' AND status='queued' ORDER BY created_at LIMIT 1").get(id);
  assert.equal(row.priority,90);
});

test('hybrid heavy enqueue event-dispatches GitHub once and cooldown coalesces bursts',async()=>{
  const DB=makeDb(),id=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
  DB.raw.exec('DELETE FROM jobs');
  let calls=0;
  const env={
    DB,COMPUTE_EXECUTOR:'hybrid',
    GITHUB_ACTIONS_TOKEN:'secret-token',GITHUB_OWNER:'kcbcdc',GITHUB_REPO:'dcv-research-platform',GITHUB_WORKFLOW:'dcv-research.yml',GITHUB_REF:'main',
    GITHUB_FETCH:async(url,opts)=>{calls++;assert.match(url,/actions\/workflows\/dcv-research\.yml\/dispatches$/);assert.equal(JSON.parse(opts.body).ref,'main');return new Response(null,{status:204});}
  };
  await enqueue(env,id,'compute_candidate',{candidate_id:'cand_0',phase:'exploration',cycle:0},40);
  await enqueue(env,id,'validate_project',{},50);
  assert.equal(calls,1);
  const state=DB.raw.prepare("SELECT lease_until FROM external_runner_leases WHERE id='github-dispatch'").get();
  assert.ok(state?.lease_until);
});

test('hybrid worker-fast enqueue does not dispatch GitHub',async()=>{
  const DB=makeDb(),id=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
  DB.raw.exec('DELETE FROM jobs');
  let calls=0;
  const env={DB,COMPUTE_EXECUTOR:'hybrid',GITHUB_ACTIONS_TOKEN:'secret-token',GITHUB_OWNER:'kcbcdc',GITHUB_REPO:'dcv-research-platform',GITHUB_FETCH:async()=>{calls++;return new Response(null,{status:204});}};
  await enqueue(env,id,'measure_project',{},30);
  assert.equal(calls,0);
});

test('runner status exposes configuration and queue health without exposing token',async()=>{
  const {githubRunnerStatus}=await import('../src/lib/github_dispatch.js');
  const DB=makeDb(),id=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
  DB.raw.exec('DELETE FROM jobs');
  // Insert without token so enqueue cannot dispatch; status should still describe the queue once configured.
  await enqueue({DB,COMPUTE_EXECUTOR:'hybrid'},id,'compute_candidate',{candidate_id:'cand_0',phase:'exploration',cycle:0},40);
  const status=await githubRunnerStatus({DB,COMPUTE_EXECUTOR:'hybrid',GITHUB_ACTIONS_TOKEN:'do-not-leak',GITHUB_OWNER:'kcbcdc',GITHUB_REPO:'dcv-research-platform'});
  assert.equal(status.configured,true);
  assert.equal(status.heavy_due,1);
  assert.equal('token' in status,false);
  assert.doesNotMatch(JSON.stringify(status),/do-not-leak/);
});
