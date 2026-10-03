import {one} from './db.js';
import {uid,nowIso,safeJson} from './util.js';
import {latestDefinition} from './define.js';
export const HUMAN_PROTOCOL='calibrated-task-v2';
export function makeHumanTask(index,rng=Math.random){
 const confidence=[.55,.75,.92][index%3],limit=100,amount=50+Math.floor(rng()*101),truth=amount>limit;
 const correct=rng()<confidence,recommendation=correct?truth:!truth;
 return {confidence,ai_correct:correct?1:0,recommendation:recommendation?1:0,task:{amount,limit,rule:'Stop a payment if and only if its amount exceeds the approval limit.',scope:'Controlled synthetic recommendation; correctness probability is assigned by study design, not measured AI accuracy'}};
}
export async function createHumanTrial(env,projectId,participant){
 if(typeof participant!=='string'||participant.length<8||participant.length>200)throw new Error('Participant pseudonym is required');
 const p=await one(env.DB,'SELECT research_cycle,evidence_revision FROM projects WHERE id=?',[projectId]);if(!p)throw new Error('project_not_found');
 const def=await latestDefinition(env,projectId),cap=Math.max(1,Math.min(30,Number(def?.content?.validation?.max_trials_per_participant||30)));
 const count=await one(env.DB,'SELECT COUNT(*) n FROM reviewer_trials WHERE project_id=? AND research_cycle=? AND participant_hash=?',[projectId,p.research_cycle,participant]);
 if(count.n>=cap)throw new Error('participant_trial_cap_reached');
 const t=makeHumanTask(Number(count.n)),id=uid('trial');
 const result=await env.DB.prepare(`INSERT INTO reviewer_trials(id,project_id,participant_hash,confidence,ai_correct,recommendation,task_json,research_cycle,evidence_revision,created_at)
 SELECT ?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM reviewer_trials WHERE project_id=? AND research_cycle=? AND participant_hash=?)<?`).bind(id,projectId,participant,t.confidence,t.ai_correct,t.recommendation,JSON.stringify(t.task),p.research_cycle,p.evidence_revision,nowIso(),projectId,p.research_cycle,participant,cap).run();
 if(!result.meta?.changes)throw new Error('participant_trial_cap_reached');
 return {trial_id:id,protocol:HUMAN_PROTOCOL,confidence:t.confidence,recommendation:!!t.recommendation,task:t.task,trial_number:Number(count.n)+1,cap};
}
export async function recordHumanTrial(env,projectId,b){
 const t=await one(env.DB,'SELECT t.*,p.research_cycle current_cycle FROM reviewer_trials t JOIN projects p ON p.id=t.project_id WHERE t.id=? AND t.project_id=? AND t.participant_hash=?',[b.trial_id,projectId,b.participant_hash]);
 if(!t||t.status!=='pending'||t.research_cycle!==t.current_cycle)throw new Error('Invalid, consumed or superseded trial');
 if(typeof b.human_accept!=='boolean'||!Number.isFinite(b.response_ms)||b.response_ms<0||b.response_ms>3600000)throw new Error('Invalid response');
 const id=uid('review'),correct=!!t.ai_correct,recovered=!correct&&!b.human_accept;
 const rs=await env.DB.batch([
  env.DB.prepare(`INSERT INTO reviewer_observations(id,project_id,participant_hash,ai_confidence,ai_correct,human_accept,response_ms,recovered,recovery_ms,context_json,created_at,trial_id)
  SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM reviewer_trials WHERE id=? AND status='pending')`).bind(id,projectId,b.participant_hash,t.confidence,t.ai_correct,b.human_accept?1:0,b.response_ms,recovered?1:0,recovered?b.response_ms:null,JSON.stringify({protocol:HUMAN_PROTOCOL,task:safeJson(t.task_json),cycle:t.research_cycle}),nowIso(),t.id,t.id),
  env.DB.prepare("UPDATE reviewer_trials SET status='done' WHERE id=? AND EXISTS(SELECT 1 FROM reviewer_observations WHERE id=?)").bind(t.id,id)
 ]);
 if(!rs[0].meta?.changes)throw new Error('Trial already consumed');
 return {id,correct,recovered,protocol:HUMAN_PROTOCOL};
}
