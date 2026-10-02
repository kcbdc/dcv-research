import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {createHumanTrial,recordHumanTrial} from '../src/lib/human_trials.js';
import {buildThesisData} from '../src/lib/thesis.js';

test('participant identity is scoped by project and research cycle in browser UI',()=>{
  const js=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  assert.match(js,/dcv_participant:\$\{projectId\|\|'none'\}:\$\{Number\(cycle\|\|1\)\}/);
  assert.match(js,/newParticipantBtn/);
  assert.match(js,/crypto\.randomUUID\(\)/);
});

test('distinct calibrated participants increase current-cycle participant count',async()=>{
  const DB=makeDb(),projectId=await seedProject(DB,{candidates:0,reviewer:0,episodes:0}),env={DB};
  for(let i=0;i<14;i++){
    const ph=`participant-${String(i).padStart(2,'0')}`;
    const t=await createHumanTrial(env,projectId,ph);
    await recordHumanTrial(env,projectId,{trial_id:t.trial_id,participant_hash:ph,human_accept:true,response_ms:500+i});
  }
  const t=await buildThesisData(env,projectId);
  assert.equal(t.reviewer.participants,14);
  assert.equal(t.reviewer.cumulative_participants,14);
});
