import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {createHumanTrial,recordHumanTrial} from '../src/lib/human_trials.js';
import {buildThesisData} from '../src/lib/thesis.js';
import {readLabSnapshot} from '../src/lib/lab_evidence.js';

test('participant identity is scoped by project and human protocol, not research cycle',()=>{
  const js=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  assert.match(js,/dcv_participant:\$\{projectId\|\|'none'\}:\$\{encodeURIComponent\(protocol\|\|'legacy'\)\}/);
  assert.doesNotMatch(js,/participantStorageKey\(projectId=current,cycle=currentResearchCycle\)/);
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


test('same human protocol keeps completed participants eligible after research cycle advances',async()=>{
  const DB=makeDb(),projectId=await seedProject(DB,{candidates:0,reviewer:0,episodes:0}),env={DB};
  for(let i=0;i<14;i++){
    const ph=`stable-participant-${String(i).padStart(2,'0')}`;
    const t=await createHumanTrial(env,projectId,ph);
    await recordHumanTrial(env,projectId,{trial_id:t.trial_id,participant_hash:ph,human_accept:true,response_ms:600+i});
  }
  DB.raw.exec('UPDATE projects SET research_cycle=research_cycle+1');
  const t=await buildThesisData(env,projectId);
  assert.equal(t.reviewer.participants,14);
  assert.equal(t.reviewer.cumulative_participants,14);
  assert.equal(t.reviewer.excluded_trials,0);
});


test('10-agent lab snapshot keeps protocol participants after research cycle advances',async()=>{
  const DB=makeDb(),projectId=await seedProject(DB,{candidates:0,reviewer:0,episodes:0}),env={DB};
  for(let i=0;i<30;i++){
    const ph=`lab-participant-${String(i).padStart(2,'0')}`;
    const t=await createHumanTrial(env,projectId,ph);
    await recordHumanTrial(env,projectId,{trial_id:t.trial_id,participant_hash:ph,human_accept:true,response_ms:700+i});
  }
  DB.raw.exec('UPDATE projects SET research_cycle=research_cycle+1');
  const snapshot=await readLabSnapshot(env,{project_id:projectId},{force:true});
  assert.equal(Number(snapshot.human.participants),30);
  assert.doesNotMatch(snapshot.diagnostics.blockers.join(' | '),/Fewer than 30 real human participants/);
});
