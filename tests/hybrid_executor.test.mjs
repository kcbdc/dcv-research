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
