import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {buildThesisData} from '../src/lib/thesis.js';
import {generateReport} from '../src/lib/report.js';
import {scheduleAll} from '../src/lib/orchestrator.js';
test('legacy untagged participants carry forward while explicitly incompatible protocols stay excluded',async()=>{
 const DB=makeDb(),id=await seedProject(DB,{reviewer:60,candidates:0,episodes:0});
 DB.raw.exec("UPDATE reviewer_observations SET participant_hash=id");
 const d=DB.raw.prepare('SELECT content_json FROM definitions').get();const content=JSON.parse(d.content_json);content.validation={human_protocol:'calibrated_task_v2'};DB.raw.prepare('UPDATE definitions SET content_json=?').run(JSON.stringify(content));
 DB.raw.prepare("UPDATE reviewer_observations SET context_json=json_object('protocol','older-explicit-protocol') WHERE rowid=(SELECT rowid FROM reviewer_observations LIMIT 1)").run();
 const t=await buildThesisData({DB},id);assert.equal(t.reviewer.cumulative_participants,60);assert.equal(t.reviewer.cumulative_trials,60);assert.equal(t.reviewer.participants,59);assert.equal(t.reviewer.excluded_trials,1);assert.equal(t.reviewer.legacy_untagged_trials,59);
 const report=await generateReport({DB},id);assert.match(report.content_markdown,/누적 참가자 60명/);assert.match(report.content_markdown,/legacy 무태그 관측 59건/);assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM reviewer_observations').get().n,60);
});
test('automatic draft report is queued before final approval and coalesced',async()=>{
 const DB=makeDb(),id=await seedProject(DB,{reviewer:0,candidates:0,episodes:0});await scheduleAll({DB},{process:false});await scheduleAll({DB},{process:false});
 assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM jobs WHERE type='generate_report' AND status='queued'").get().n,1);
});

test('queued report regeneration keeps prior text and does not claim AI failure',async()=>{
 const {readFile}=await import('node:fs/promises');const {runInNewContext}=await import('node:vm');const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');const start=source.indexOf('let reportPollTimer;');const end=source.indexOf("\n}",start)+2;
 const nodes={'#reportStatus':{textContent:''},'#reportRegenBtn':{disabled:false},'#reportText':{textContent:'previous report'}};let timer;
 const ctx={current:'p1',$:s=>nodes[s],modal:()=>({show(){}}),api:async(p,o)=>o?{status:'queued'}:{content_markdown:'previous report',stale:true},window:{DCVReportRender(){}},clearTimeout(){},setTimeout(fn){timer=fn;return 1;}};
 runInNewContext(source.slice(start,end)+';globalThis.showReport=showReport;',ctx);await ctx.showReport(true);
 assert.equal(nodes['#reportText'].textContent,'previous report');assert.match(nodes['#reportStatus'].textContent,/GitHub Actions/);assert.equal(nodes['#reportRegenBtn'].disabled,false);assert.ok(timer);
});
test('latest report GET preserves stale snapshots with explicit revision warning',async()=>{
 const {default:worker}=await import('../src/index.js');const DB=makeDb(),id=await seedProject(DB,{reviewer:0,candidates:0,episodes:0});const report=await generateReport({DB},id);DB.raw.exec('UPDATE projects SET evidence_revision=evidence_revision+1; UPDATE reports SET stale_at=created_at');
 const response=await worker.fetch(new Request(`https://test/api/projects/${id}/report`),{DB},{});assert.equal(response.status,200);const body=await response.json();assert.equal(body.id,report.id);assert.equal(body.stale,true);assert.match(body.content_markdown,/이전 증거 스냅샷/);
});
