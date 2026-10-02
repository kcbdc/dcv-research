import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {generateReport} from '../src/lib/report.js';
import worker from '../src/index.js';
test('new participant is shown live while previous report keeps its snapshot counts',async()=>{
 const DB=makeDb(),id=await seedProject(DB,{reviewer:10,candidates:0,episodes:0});DB.raw.exec('UPDATE reviewer_observations SET participant_hash=id');const report=await generateReport({DB},id);
 DB.raw.prepare("INSERT INTO reviewer_observations(id,project_id,participant_hash,ai_confidence,ai_correct,human_accept,response_ms,context_json,created_at) VALUES('new',?,'new-participant',.75,1,1,200,'{}',?)").run(id,new Date().toISOString());DB.raw.exec('UPDATE projects SET evidence_revision=evidence_revision+1; UPDATE reports SET stale_at=created_at');
 const response=await worker.fetch(new Request(`https://test/api/projects/${id}/report`),{DB},{});const data=await response.json();assert.equal(data.live_human.participants,11);assert.match(data.content_markdown,/누적 참가자 11명/);assert.match(data.content_markdown,/참가자 10명/);assert.equal(data.id,report.id);assert.equal(data.stale,true);
});
test('evidence arriving during report AI generation cannot relabel old counts as new revision',async()=>{
 const DB=makeDb(),id=await seedProject(DB,{reviewer:10,candidates:0,episodes:0});const old=DB.raw.prepare('SELECT evidence_revision FROM projects').get().evidence_revision;
 const result=await generateReport({DB,AI:{run:async()=>{DB.raw.exec('UPDATE projects SET evidence_revision=evidence_revision+1');return {response:JSON.stringify({abstract:'Invented participant count 999'})};}}},id);
 const row=DB.raw.prepare('SELECT * FROM reports WHERE id=?').get(result.id);assert.equal(row.evidence_revision,old);assert.ok(row.stale_at);assert.equal(result.stale,true);assert.ok(!row.content_markdown.includes('Invented participant count 999'));
});
