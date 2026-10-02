import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const wrangler=JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
const workflow=fs.readFileSync(new URL('../.github/workflows/dcv-research.yml',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const index=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const orch=fs.readFileSync(new URL('../src/lib/orchestrator.js',import.meta.url),'utf8');

test('aggressive hybrid cadence reduces idle gaps between Worker and GitHub',()=>{
  assert.deepEqual(wrangler.triggers.crons,['* * * * *']);
  assert.equal(wrangler.vars.MAX_JOBS_PER_TICK,'3');
  assert.match(workflow,/cron:\s*'\*\/5 \* \* \* \*'/);
});

test('Worker scheduled event drains a short fast-path chain',()=>{
  assert.match(index,/processFastLane\(env,\{rounds:3\}\)/);
  assert.match(orch,/export async function processFastLane/);
});

test('dashboard exposes hybrid executor lanes to make the split observable',()=>{
  assert.match(app,/WORKER FAST/);
  assert.match(app,/SHARED FAST/);
  assert.match(app,/GITHUB HEAVY/);
  assert.match(app,/HYBRID FAST/);
});
