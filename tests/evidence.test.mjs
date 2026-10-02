import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers/d1shim.mjs';
import { registerEvidence, approvalGates, impactForEvidence } from '../src/lib/evidence.js';

const now=()=>new Date().toISOString();
async function base(){
  const DB=makeDb(),env={DB};
  await DB.prepare(`INSERT INTO projects(id,name,status,current_stage,auto_run,auto_approve,created_at,updated_at,candidate_count,reviewer_obs_count) VALUES('p','x','complete','report',1,1,?,?,1,0)`).bind(now(),now()).run();
  await DB.prepare(`INSERT INTO design_candidates(id,project_id,sigma,tau,alpha,authority_k,delay_d,recovery_w,adjust_m,status,estimator,evidence_status,created_at,research_cycle) VALUES('c','p',.05,0,.35,2,1,.1,.1,'confirmed_feasible','ema','FEASIBLE',?,1)`).bind(now()).run();
  await DB.prepare(`INSERT INTO approvals(id,project_id,candidate_id,decision,evidence_level,basis_json,automatic,created_at,research_cycle,evidence_revision) VALUES('a','p','c','SCIENTIFICALLY_APPROVED','A','{}',0,?,1,0)`).bind(now()).run();
  await DB.prepare(`INSERT INTO reports(id,project_id,kind,title,content_markdown,data_json,created_at,research_cycle,evidence_revision) VALUES('r','p','paper_summary','x','x','{}',?,1,0)`).bind(now()).run();
  return env;
}

test('impact classifier starts human trial at Validate and external data at Measure',()=>{
  assert.equal(impactForEvidence('HUMAN_TRIAL'),'validate');
  assert.equal(impactForEvidence('EXTERNAL_DATA'),'measure');
  assert.equal(impactForEvidence('SCENARIO'),'compute');
  assert.equal(impactForEvidence('DESIGN_CHANGE'),'define');
});

test('one new human trial invalidates prior approval but does not restart compute cycle',async()=>{
  const env=await base();
  const r=await registerEvidence(env,'p',{kind:'HUMAN_TRIAL',source:'test'});
  assert.equal(r.impact_from,'validate'); assert.equal(r.research_cycle,1); assert.equal(r.evidence_revision,1);
  const p=env.DB.raw.prepare(`SELECT * FROM projects WHERE id='p'`).get();
  assert.equal(p.current_stage,'validate'); assert.equal(p.approval_stale,1); assert.equal(p.research_cycle,1);
  const a=env.DB.raw.prepare(`SELECT stale_at FROM approvals WHERE id='a'`).get(); assert.ok(a.stale_at);
  const j=env.DB.raw.prepare(`SELECT type FROM jobs WHERE project_id='p' AND status='queued'`).all().map(x=>x.type); assert.ok(j.includes('advance_project')); assert.ok(!j.includes('fit_reviewer'));
});

test('new external data after computation opens a new research cycle from Measure',async()=>{
  const env=await base();
  await env.DB.prepare(`INSERT INTO jobs(id,project_id,type,status,priority,payload_json,run_after,created_at,updated_at) VALUES('j','p','compute_candidate','queued',40,'{}',?,?,?)`).bind(now(),now(),now()).run();
  const r=await registerEvidence(env,'p',{kind:'EXTERNAL_DATA',source:'test'});
  assert.equal(r.full_cycle,true); assert.equal(r.research_cycle,2); assert.equal(r.impact_from,'measure');
  const p=env.DB.raw.prepare(`SELECT * FROM projects WHERE id='p'`).get(); assert.equal(p.research_cycle,2); assert.equal(p.candidate_count,0); assert.equal(p.current_stage,'measure');
  const old=env.DB.raw.prepare(`SELECT status,last_error FROM jobs WHERE id='j'`).get(); assert.equal(old.status,'failed'); assert.match(old.last_error,/superseded/);
  const snap=env.DB.raw.prepare(`SELECT COUNT(*) n FROM evidence_snapshots WHERE project_id='p'`).get(); assert.equal(snap.n,1);
});

test('approval gates are dependency ordered and current-revision evidence cannot skip G3',async()=>{
  const env=await base();
  // The fixture has a feasible candidate and an old sign-off, but no frozen protocol/robust/reviewer chain.
  // Downstream artifacts must not make later gates PASS out of order.
  const g=await approvalGates(env,'p');
  assert.equal(g.total,6); assert.equal(g.passed,0);
  assert.deepEqual(g.gates.map(x=>x.status),['WAIT','WAIT','WAIT','WAIT','WAIT','WAIT']);
  await registerEvidence(env,'p',{kind:'HUMAN_TRIAL'});
  const g2=await approvalGates(env,'p');
  assert.equal(g2.evidence_revision,1);
  assert.equal(g2.gates.find(x=>x.id==='G4').status,'WAIT');
  assert.equal(g2.gates.find(x=>x.id==='G5').status,'WAIT');
});


test('later evidence cannot skip an already pending earlier revalidation stage',async()=>{
  const env=await base();
  await registerEvidence(env,'p',{kind:'EXTERNAL_DATA',source:'first'});
  let p=env.DB.raw.prepare(`SELECT current_stage,revalidation_from FROM projects WHERE id='p'`).get();
  assert.equal(p.current_stage,'measure'); assert.equal(p.revalidation_from,'measure');
  await registerEvidence(env,'p',{kind:'HUMAN_TRIAL',source:'later'});
  p=env.DB.raw.prepare(`SELECT current_stage,revalidation_from FROM projects WHERE id='p'`).get();
  assert.equal(p.current_stage,'measure'); assert.equal(p.revalidation_from,'measure');
});
