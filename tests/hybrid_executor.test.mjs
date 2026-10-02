import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {enqueue,claimJobs,finishJob,jobExecutionLane} from '../src/lib/db.js';
import {processJobs} from '../src/lib/orchestrator.js';
import {computeCandidate} from '../src/lib/compute.js';
import {scheduleLab} from '../src/lib/lab.js';

test('hybrid lane classification keeps only lightweight orchestration on Worker',()=>{
  assert.equal(jobExecutionLane('advance_project'),'worker-light');
  assert.equal(jobExecutionLane('approve_project'),'worker-light');
  for(const t of ['compute_candidate','validate_project','fit_reviewer','recompute_project','finalize_recompute','collect_project','generate_report','refit_empirical']) assert.equal(jobExecutionLane(t),'github-heavy');
});

test('hybrid Worker and GitHub runner claim disjoint job types',async()=>{
  const DB=makeDb(),id=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
  DB.raw.exec('DELETE FROM jobs');
  await enqueue({DB,COMPUTE_EXECUTOR:'hybrid'},id,'advance_project',{},10);
  await enqueue({DB,COMPUTE_EXECUTOR:'hybrid'},id,'compute_candidate',{candidate_id:'cand_0',phase:'exploration',cycle:0},20);
  const worker=await claimJobs({DB,COMPUTE_EXECUTOR:'hybrid'},4);
  assert.deepEqual(worker.map(x=>x.type),['advance_project']);
  await finishJob({DB,COMPUTE_EXECUTOR:'hybrid'},worker[0]);
  const github=await claimJobs({DB,COMPUTE_EXECUTOR:'hybrid',EXTERNAL_RUNTIME:'github-actions'},4);
  assert.deepEqual(github.map(x=>x.type),['compute_candidate']);
});

test('hybrid public Worker cannot run heavy compute or LAB directly',async()=>{
  const env={COMPUTE_EXECUTOR:'hybrid',DB:{prepare(){throw Error('unexpected read');}}};
  await assert.rejects(computeCandidate(env,'missing','missing'),/compute_requires_github_actions/);
  assert.equal((await scheduleLab(env)).status,'waiting_for_github_actions');
});

test('hybrid processJobs on Worker leaves heavy queued work untouched',async()=>{
  const DB=makeDb(),id=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
  DB.raw.exec('DELETE FROM jobs');
  await enqueue({DB,COMPUTE_EXECUTOR:'hybrid'},id,'compute_candidate',{candidate_id:'cand_0',phase:'exploration',cycle:0},20);
  const out=await processJobs({DB,COMPUTE_EXECUTOR:'hybrid',MAX_JOBS_PER_TICK:4});
  assert.equal(out.length,0);
  assert.equal(DB.raw.prepare("SELECT status FROM jobs WHERE type='compute_candidate'").get().status,'queued');
});
