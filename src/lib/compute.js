import { all, one, run, audit, enqueue, enqueueOnce, enqueueMany, enqueueComputeOnce } from './db.js';
import { latestDefinition } from './define.js';
import { nowIso, uid, mulberry32, randn, clamp, safeJson, hashString, mean, sha256Hex, stableStringify } from './util.js';
import { wilson, normInv } from './stats.js';
import { loadEmpiricalCalibration, empiricalScenarioFromEpisode } from './empirical.js';
import { ensureFrozenProtocol, assertProtocolIntegrity } from './rigor.js';
import { cached } from './memo.js';
import { officialValidationScenarios } from './official_mapping.js';

const EPS=1e-9;
const ESTIMATORS=['ema','kalman','changepoint','adaptive'];
const PROB_CONSTRAINTS={loss_exceed_rate:'loss_exceed_max',fp_rate:'fp_max',fn_rate:'fn_max'};
const MEAN_CONSTRAINTS={review_burden:'review_burden_max',recovery_time:'recovery_time_max'};

function normalCI(mu,sd,n,z=1.96){
  if(!n) return {mean:0,lo:-Infinity,hi:Infinity};
  const se=(sd||0)/Math.sqrt(Math.max(1,n));
  return {mean:mu,lo:mu-z*se,hi:mu+z*se};
}
function sampleSd(sum,sumSq,n){ if(n<2) return 0; return Math.sqrt(Math.max(0,(sumSq-sum*sum/n)/(n-1))); }
function logistic(x){ return 1/(1+Math.exp(-x)); }
function empiricalChannel(cal,S,C){
  return clamp(cal.coeff.kappa + cal.coeff.theta1*S + cal.coeff.theta2*C*S, 0, 0.75);
}
function scenarioFromRow(r,cal){
  const meta=safeJson(r?.metadata_json,{});
  const S=clamp(Number(meta.severity??r?.severity??cal.params.baseline_shock?.value??0.75),0,1);
  const C=clamp(Number(meta.concentration??cal.params.korea_concentration_anchor?.value??0.75),0,1);
  const D=clamp(Number(meta.digital_adoption??cal.params.korea_digital_adoption?.value??0.92),0,1);
  return {
    key:String(r?.id||r?.name||'scenario'), name:r?.name||'scenario', severity:S, concentration:C,digital:D,
    empirical_outflow:Number(meta.empirical_outflow??empiricalChannel(cal,S,C)),
    volatility:Number(r?.volatility||1), delay_multiplier:Number(r?.delay_multiplier||1), loss_multiplier:Number(r?.loss_multiplier||1),
    drift:Number(meta.drift||0), rho:Number(meta.rho??0.82), shift_time:Number(meta.shift_time??-1),
    shift_magnitude:Number(meta.shift_magnitude||0), process_noise:Number(meta.process_noise??Math.max(.015,cal.coeff.rmse)),
    provenance:meta.provenance||'scenario_table', validation_group:meta.validation_group||null
  };
}
function syntheticScenarios(cal){
  const baseS=Number(cal.params.baseline_shock?.value??.75), C=Number(cal.params.korea_concentration_anchor?.value??.75), D=Number(cal.params.korea_digital_adoption?.value??.92), rmse=Math.max(.015,cal.coeff.rmse);
  const base=empiricalChannel(cal,baseS,C);
  return [
    {key:'paper_korea_baseline',name:'Published Korea baseline anchor',severity:baseS,concentration:C,digital:D,empirical_outflow:base,volatility:1,delay_multiplier:1,loss_multiplier:1,drift:0,rho:.82,shift_time:-1,shift_magnitude:0,process_noise:rmse,provenance:'published_summary_anchor',validation_group:'Synthetic'},
    {key:'paper_low_shock',name:'Published low-shock sensitivity',severity:.60,concentration:C,digital:D,empirical_outflow:empiricalChannel(cal,.60,C),volatility:1.05,delay_multiplier:1,loss_multiplier:1.05,drift:0,rho:.82,shift_time:-1,shift_magnitude:0,process_noise:rmse,provenance:'published_summary_anchor',validation_group:'Synthetic'},
    {key:'paper_high_shock',name:'Published high-shock sensitivity',severity:.90,concentration:C,digital:D,empirical_outflow:empiricalChannel(cal,.90,C),volatility:1.15,delay_multiplier:1.10,loss_multiplier:1.15,drift:0,rho:.80,shift_time:12,shift_magnitude:.10,process_noise:rmse*1.25,provenance:'published_summary_anchor',validation_group:'Synthetic'},
    {key:'paper_low_digital',name:'Published low-digital sensitivity',severity:baseS,concentration:C,digital:.30,empirical_outflow:base,volatility:.92,delay_multiplier:1,loss_multiplier:.95,drift:0,rho:.82,shift_time:-1,shift_magnitude:0,process_noise:rmse,provenance:'published_summary_anchor',validation_group:'Synthetic'}
  ];
}
function paperStressScenarios(cal){
  const out=[];
  for(const cm of [.6,1,1.4]) for(const dm of [.6,1,1.4]) for(const sm of [.6,1,1.4]){
    const C=clamp(Number(cal.params.korea_concentration_anchor?.value??.75)*cm,0,1),D=clamp(Number(cal.params.korea_digital_adoption?.value??.92)*dm,0,1),S=clamp(Number(cal.params.baseline_shock?.value??.75)*sm,0,1);
    out.push({key:`paper_wide_${cm}_${dm}_${sm}`,name:`±40% C/D/S (${cm},${dm},${sm})`,severity:S,concentration:C,digital:D,empirical_outflow:empiricalChannel(cal,S,C),volatility:1+.25*Math.abs(sm-1),delay_multiplier:1+.25*Math.max(0,sm-1),loss_multiplier:1+.35*Math.max(0,sm-1),drift:0,rho:.80,shift_time:S>.85?10:-1,shift_magnitude:S>.85?.12:0,process_noise:Math.max(.015,cal.coeff.rmse)*(1+.4*Math.abs(sm-1)),provenance:'paper_robustness_grid',validation_group:'Adversarial'});
  }
  return out;
}

function calibrationUncertaintyScenarios(cal){
  const reps=cal.local_refit?.uncertainty?.representative_draws||[];
  if(!reps.length)return [];
  const S=Number(cal.params.baseline_shock?.value??.75),C=Number(cal.params.korea_concentration_anchor?.value??.75),D=Number(cal.params.korea_digital_adoption?.value??.92),rmse=Math.max(.015,cal.coeff.rmse);
  return reps.map((b,i)=>({key:`calibration_boot_${i}`,name:`Calibration uncertainty draw ${i+1}`,severity:S,concentration:C,digital:D,empirical_outflow:clamp(Number(b.kappa)+Number(b.theta1)*S+Number(b.theta2)*C*S,0,.75),volatility:1,delay_multiplier:1,loss_multiplier:1,drift:0,rho:.82,shift_time:-1,shift_magnitude:0,process_noise:Math.max(.015,Number(b.rmse||rmse)),provenance:'empirical_bootstrap_uncertainty',validation_group:'Adversarial'}));
}
function lossProxyScenarios(cal){
  const L=cal.loss||{}; if(L.identification_status!=='PROXY_ONLY'||!Number.isFinite(Number(L.c_fp))||!Number.isFinite(Number(L.c_fn)))return [];
  const baseS=Number(cal.params.baseline_shock?.value??.75),C=Number(cal.params.korea_concentration_anchor?.value??.75),D=Number(cal.params.korea_digital_adoption?.value??.92),rmse=Math.max(.015,cal.coeff.rmse);
  const fps=[Number(L.c_fp_low||L.c_fp),Number(L.c_fp_high||L.c_fp)],fns=[Number(L.c_fn_low||L.c_fn),Number(L.c_fn_high||L.c_fn)],out=[];
  for(const fp of fps)for(const fn of fns)out.push({key:`loss_proxy_${fp.toFixed(4)}_${fn.toFixed(4)}`,name:'FP/FN proxy-cost sensitivity',severity:baseS,concentration:C,digital:D,empirical_outflow:empiricalChannel(cal,baseS,C),volatility:1,delay_multiplier:1,loss_multiplier:1,c_fp_multiplier:fp/Math.max(EPS,Number(L.c_fp)),c_fn_multiplier:fn/Math.max(EPS,Number(L.c_fn)),drift:0,rho:.82,shift_time:-1,shift_magnitude:0,process_noise:rmse,provenance:'loss_proxy_sensitivity',validation_group:'Adversarial'});
  return out;
}
function estimatorStep(kind,state,y,alpha,sigma){
  const a=clamp(alpha,.03,.97);
  if(kind==='kalman' || kind==='adaptive'){
    const q=.02+.30*a*a, r=Math.max(.0025,sigma*sigma);
    const pred=state.x, pPred=(state.p??1)+q, gain=pPred/(pPred+r);
    let x=pred+gain*(y-pred), p=(1-gain)*pPred;
    if(kind==='adaptive'){
      const z=Math.abs(y-x)/Math.sqrt(Math.max(EPS,p+r));
      if(z>2.4-a*.5){ x=.65*y+.35*x; p=Math.min(2,p+r*.35); state.change=true; }
      else state.change=false;
    }
    return {...state,x,p,gain};
  }
  if(kind==='changepoint'){
    const prev=state.x??y, scale=Math.sqrt((state.var??1)+sigma*sigma+EPS), z=Math.abs(y-prev)/scale;
    const threshold=3.0-1.2*a;
    const change=z>threshold;
    const eff=change?Math.max(.65,a):a;
    const x=eff*y+(1-eff)*prev;
    const resid=y-x, v=.9*(state.var??1)+.1*resid*resid;
    return {...state,x,var:v,change};
  }
  const prev=state.x??y, x=a*y+(1-a)*prev;
  return {...state,x,var:.9*(state.var??1)+.1*(y-x)*(y-x),change:false};
}
function confidenceFor(estState,estimate,threshold,sigma,method='residual_common_v1'){
  if(method==='residual_common_v1'){const variance=Math.max(sigma*sigma,estState.predictionVariance??sigma*sigma,EPS);return clamp(.5+.5*(1-Math.exp(-Math.abs(estimate-threshold)/Math.sqrt(variance))),.5,.999);}

  const distance=Math.abs(estimate-threshold);
  const uncertainty=Math.sqrt(Math.max(EPS,estState.p??estState.var??sigma*sigma));
  return clamp(.5+.5*(1-Math.exp(-distance/(uncertainty+.12))),.5,.999);
}
function reviewerDecision(rng,aiStop,shouldStop,confidence,reviewer,delayBase,delayMult){
  const falseAccept=Number(reviewer?.false_accept_rate??.08);
  const correctOverride=Number(reviewer?.correct_override_rate??.78);
  const unnecessaryOverride=Number(reviewer?.unnecessary_override_rate??Math.min(.18,falseAccept*.5));
  let finalStop=aiStop;
  if(aiStop!==shouldStop){ if(rng()<correctOverride) finalStop=shouldStop; }
  else if(rng()<unnecessaryOverride) finalStop=!aiStop;
  const base=Math.max(0,Number(delayBase||0))+Math.max(0,Number(reviewer?.mean_delay||0))/86400;
  return {finalStop,delay:Math.max(0,base*delayMult*(.85+.3*rng())),falseAccept,correctOverride};
}
function simulateEpisode(c,constraints,rng,scenario,reviewer,config,reviewRng=mulberry32(20261002)){
  const horizon=Number(config.horizon||24), tau=Math.max(0,Math.round(c.tau||0));
  const threshold=Number(scenario.risk_threshold_override??config.risk_threshold??.68), latentThreshold=Math.log(threshold/(1-threshold));
  const history=[], est={x:0,p:1,var:Math.max(c.sigma*c.sigma,scenario.process_noise**2),predictionVariance:Math.max(c.sigma*c.sigma,scenario.process_noise**2),change:false};
  const confidenceBins=Array.from({length:10},()=>({n:0,sum:0,correct:0}));
  let state=randn(rng)*.25, reviewN=0, rtSum=0, fp=0,fn=0, decisions=0, totalLoss=0, adjustmentN=0;
  let rollingErrors=0, safeMode=0;
  for(let t=0;t<horizon;t++){
    const shifted=scenario.shift_time>=0 && t>=scenario.shift_time ? scenario.shift_magnitude : 0;
    const digitalSens=Number(config.empirical?.params?.outflow_digital_sensitivity?.value??0.35),empiricalPulse=Number(scenario.empirical_outflow||0)*(1+digitalSens*Number(scenario.digital||0));
    state=scenario.rho*state + scenario.drift + empiricalPulse + shifted*(t===scenario.shift_time?1:.02) + randn(rng)*scenario.process_noise*scenario.volatility;
    const obs=state+randn(rng)*c.sigma*scenario.volatility;
    history.push(obs);
    const delayed=history[Math.max(0,history.length-1-tau)];
    // Identical one-step predictive residual semantics for every estimator; no latent labels.
    const residual=delayed-est.x,previousVariance=est.predictionVariance;
    const es=estimatorStep(c.estimator||'ema',est,delayed,c.alpha,c.sigma);
    Object.assign(est,es);
    const estimate=est.x;let confidence=confidenceFor(est,estimate,latentThreshold,c.sigma,config.confidence_method||'residual_common_v1');
    est.predictionVariance=.9*previousVariance+.1*residual*residual;
    const shouldStop=logistic(state)>threshold;
    const aiStop=estimate>latentThreshold;
    // Only pure offline audit callers can request perfect-label foresight; configFrom never enables it.
    if(config.audit_perfect_label===true)confidence=aiStop===shouldStop?1:0;
    const bin=confidenceBins[Math.min(9,Math.floor(confidence*10))];bin.n++;bin.sum+=confidence;bin.correct+=aiStop===shouldStop?1:0;
    const K=Number(c.authority_k);
    let needsReview=K===0 || K===1 || safeMode>0;
    if(K===2) needsReview=needsReview || confidence<Number(config.k2_confidence||.84);
    if(K>=3) needsReview=needsReview || confidence<Number(config.k3_confidence||.67);
    let finalStop=aiStop, decisionDelay=Number(config.autonomous_delay_days??.02);
    if(needsReview){
      reviewN++;
      const hr=reviewerDecision(reviewRng,aiStop,shouldStop,confidence,reviewer,c.delay_d,scenario.delay_multiplier);
      finalStop=hr.finalStop; decisionDelay=hr.delay;
    }
    if(finalStop&&!shouldStop) fp++;
    if(!finalStop&&shouldStop) fn++;
    const wrong=finalStop!==shouldStop;
    const recAlpha=Number(config.recovery_alpha??.18);
    rollingErrors=(1-recAlpha)*rollingErrors+recAlpha*(wrong?1:0);
    const riskExcess=Math.max(0,logistic(state)-threshold);
    const lossCal=config.empirical?.loss||{};
    const cFP=Number(lossCal.c_fp??.0592)*Number(scenario.c_fp_multiplier??1), cFN=Number(lossCal.c_fn??.0832)*Number(scenario.c_fn_multiplier??1), T=Number(lossCal.horizon??horizon);
    // FP = 정지 오판(정상지급 차단), FN = 정지 누락(부정지급·유출).
    // 비용은 n=81 위기 패널의 실패/비실패 집단 평균 peak_outflow로 보정한다.
    const decisionLoss=(finalStop&&!shouldStop?cFP:0)+(!finalStop&&shouldStop?cFN:0);
    const exposure=(!finalStop?cFN*riskExcess*(1+decisionDelay/Math.max(1,T)):0);
    const delayLoss=(decisionDelay/Math.max(1,T))*(finalStop?cFP:cFN);
    let loss=(decisionLoss+exposure+delayLoss)*Number(scenario.loss_multiplier||1);
    if(needsReview) loss+=Number(lossCal.review_cost??cFP/Math.max(1,T));
    totalLoss+=loss; rtSum+=decisionDelay; decisions++;
    // Recovery: error EWMA(recAlpha)는 설계 파라미터이며, 비용 스케일만 n=81 패널에서 보정한다.
    if((rollingErrors>Number(c.adjust_m)||exposure>Number(c.recovery_w)) && safeMode===0){
      safeMode=Math.max(1,Math.round(2+3*c.recovery_w)); adjustmentN++; totalLoss+=Number(lossCal.adjustment_cost??cFN/Math.max(1,T));
    }
    if(safeMode>0) safeMode--;
  }
  const episodeLoss=totalLoss/Math.max(1,horizon);
  const recoveryTime=rtSum/Math.max(1,decisions), burden=reviewN/Math.max(1,decisions), norm=Math.max(EPS,Number(config.empirical?.loss?.normalization??constraints.loss_max??1));
  // 목적함수는 임의 가중치를 제거하고 각 항을 경험적 손실 스케일과 T로 무차원화한다.
  const objective=episodeLoss/norm + burden + recoveryTime/Math.max(1,horizon) + adjustmentN/Math.max(1,horizon);
  return {episodeLoss,lossExceeded:episodeLoss>constraints.loss_max,fp,fn,decisions,reviewN,recoveryTime,adjustmentN,objective,confidenceBins};
}
function emptyAgg(){ return {episodes:0,lossExceed:0,fp:0,fn:0,decisions:0,reviewN:0,rtSum:0,rtSq:0,lossSum:0,lossSq:0,objSum:0,objSq:0,adjustments:0,confidenceBins:Array.from({length:10},()=>({n:0,sum:0,correct:0})),scenarios:{},groups:{}}; }
function addEpisodeStats(a,e,key){
  for(let i=0;i<10;i++)for(const k of ['n','sum','correct'])a.confidenceBins[i][k]+=Number(e.confidenceBins?.[i]?.[k]||0);
  a.episodes++; a.lossExceed+=e.lossExceeded?1:0; a.fp+=e.fp; a.fn+=e.fn; a.decisions+=e.decisions; a.reviewN+=e.reviewN;
  a.rtSum+=e.recoveryTime; a.rtSq+=e.recoveryTime*e.recoveryTime; a.lossSum+=e.episodeLoss; a.lossSq+=e.episodeLoss*e.episodeLoss; a.objSum+=e.objective; a.objSq+=e.objective*e.objective; a.adjustments+=e.adjustmentN;
  const s=a.scenarios[key]??={n:0,objSum:0,lossSum:0,violations:0}; s.n++; s.objSum+=e.objective; s.lossSum+=e.episodeLoss; s.violations+=e.lossExceeded?1:0;
}
function addEpisode(a,e,key,group=null){
  addEpisodeStats(a,e,key);
  if(group){const g=a.groups[group]??=emptyAgg();addEpisodeStats(g,e,key);}
}
function mergeAgg(target,src){
  for(let i=0;i<10;i++)for(const k of ['n','sum','correct'])target.confidenceBins[i][k]+=Number(src.confidenceBins?.[i]?.[k]||0);
  for(const k of ['episodes','lossExceed','fp','fn','decisions','reviewN','rtSum','rtSq','lossSum','lossSq','objSum','objSq','adjustments']) target[k]+=Number(src[k]||0);
  for(const [k,v] of Object.entries(src.scenarios||{})){ const s=target.scenarios[k]??={n:0,objSum:0,lossSum:0,violations:0}; for(const f of ['n','objSum','lossSum','violations']) s[f]+=Number(v[f]||0); }
  for(const [k,v] of Object.entries(src.groups||{})){const g=target.groups[k]??=emptyAgg();mergeAgg(g,v);}
  return target;
}
function finalizeAgg(a,constraints,confidence=.95,inference={},includeGroups=true){
  const nominalZ=confidence>=.99?2.576:confidence>=.95?1.96:1.645;
  const method=inference.method||'none',familySize=Math.max(1,Number(inference.familySize||1)),constraintCount=Object.keys(PROB_CONSTRAINTS).length+Object.keys(MEAN_CONSTRAINTS).length+(Number.isFinite(constraints.loss_mean_max)?1:0);
  const alpha=1-confidence,tests=Math.max(1,familySize*constraintCount),adjust=method==='bonferroni'&&inference.adjust===true;
  const z=adjust?normInv(1-alpha/(2*tests)):nominalZ;
  const nE=Math.max(1,a.episodes), nD=Math.max(1,a.decisions);
  const metrics={
    n:a.episodes,decisions:a.decisions,loss_mean:a.lossSum/nE,loss_exceed_rate:a.lossExceed/nE,
    fp_rate:a.fp/nD,fn_rate:a.fn/nD,review_burden:a.reviewN/nD,recovery_time:a.rtSum/nE,
    objective_score:a.objSum/nE,adjustment_rate:a.adjustments/nE
  };
  const lossSd=sampleSd(a.lossSum,a.lossSq,a.episodes), rtSd=sampleSd(a.rtSum,a.rtSq,a.episodes);
  const burdenCI=wilson(a.reviewN,a.decisions,z), lossCI=wilson(a.lossExceed,a.episodes,z), fpCI=wilson(a.fp,a.decisions,z), fnCI=wilson(a.fn,a.decisions,z);
  const rtCI=normalCI(metrics.recovery_time,rtSd,a.episodes,z);
  const ci={loss_mean:normalCI(metrics.loss_mean,lossSd,a.episodes,z),loss_exceed_rate:lossCI,fp_rate:fpCI,fn_rate:fnCI,review_burden:burdenCI,recovery_time:rtCI};
  const evals=[];
  if(Number.isFinite(constraints.loss_mean_max))evals.push({metric:'loss_mean',limit:constraints.loss_mean_max,...ci.loss_mean,mean:metrics.loss_mean});
  for(const [metric,limitKey] of Object.entries(PROB_CONSTRAINTS)){ const q=ci[metric], lim=Number(constraints[limitKey]); evals.push({metric,limit:lim,lo:q.lo,hi:q.hi,mean:metrics[metric]}); }
  for(const [metric,limitKey] of Object.entries(MEAN_CONSTRAINTS)){ const q=ci[metric], lim=Number(constraints[limitKey]); evals.push({metric,limit:lim,lo:q.lo,hi:q.hi,mean:metrics[metric]}); }
  const anyFail=evals.some(x=>x.lo>x.limit), allPass=evals.every(x=>x.hi<=x.limit);
  const classification=anyFail?'INFEASIBLE':allPass?'FEASIBLE':'UNRESOLVED';
  const normalizedDistances=evals.map(x=>Math.abs(x.mean-x.limit)/Math.max(.01,Math.abs(x.limit)));
  const boundaryScore=1/(.05+Math.min(...normalizedDistances));
  const scenario_scores=Object.fromEntries(Object.entries(a.scenarios).map(([k,v])=>[k,{n:v.n,objective:v.objSum/Math.max(1,v.n),loss_mean:v.lossSum/Math.max(1,v.n),loss_exceed_rate:v.violations/Math.max(1,v.n)}]));
  const validation_groups={};
  if(includeGroups)for(const [k,g] of Object.entries(a.groups||{}))validation_groups[k]=finalizeAgg(g,constraints,confidence,inference,false);
  const confidence_bins=(a.confidenceBins||[]).filter(b=>b.n).map(b=>({n:b.n,confidence:b.sum/b.n,accuracy:b.correct/b.n}));
  const calibration_ece=confidence_bins.reduce((s,b)=>s+b.n*Math.abs(b.confidence-b.accuracy),0)/nD;
  return {metrics,ci,confidence_audit:{bins:confidence_bins,ece:calibration_ece,scope:'diagnostic, not a calibration certificate'},classification,boundary_score:boundaryScore,constraints:evals,scenario_scores,validation_groups,inference:{method:adjust?'bonferroni':'nominal',nominal_confidence:confidence,family_size:familySize,constraint_count:constraintCount,simultaneous_tests:adjust?tests:constraintCount,z_critical:z},raw:a};
}
function deterministicSeed(projectId,candidateId,phase,cycle){ return hashString(`${projectId}|${candidateId}|${phase}|${cycle}|DCV-CDRS-v2`)&0x7fffffff; }
function applyNoninferiority(ev,candidate,baseline,margins){
 const comparisons=[['loss_mean',Number(margins.loss_relative_margin),true],['fn_rate',Number(margins.fn_absolute_margin),false],['fp_rate',Number(margins.fp_absolute_margin),false]].map(([metric,margin,relative])=>{
  const a=candidate.ci[metric],b=baseline.ci[metric],factor=relative?1+margin:1,limit=relative?0:margin;
  return {metric:'noninferiority_'+metric,limit,mean:candidate.metrics[metric]-factor*baseline.metrics[metric],lo:a.lo-factor*b.hi,hi:a.hi-factor*b.lo};
 });
 ev.noninferiority={baseline:'matched full-review K0; same estimator, delays, scenario and environment seed',margins,baseline_metrics:baseline.metrics,comparisons,scope:'Conservative simultaneous CI contrasts for the current independent batch; no post-hoc threshold selection'};
 ev.constraints.push(...comparisons);
 ev.classification=ev.constraints.some(x=>x.lo>x.limit)?'INFEASIBLE':ev.constraints.every(x=>x.hi<=x.limit)?'FEASIBLE':'UNRESOLVED';
 return ev;
}
function configFrom(def,env,cal){
  const b=def.content.benchmark||{}, v=def.content.validation||{};
  return {confidence_method:b.confidence_method||'residual_common_v1',autonomous_delay_days:Number(b.autonomous_delay_days??.02),noninferiority:b.noninferiority||null,horizon:Number(b.horizon||cal.params.horizon_days?.value||90),risk_threshold:Number(b.risk_threshold||cal.params.stability_theta_korea?.value||.62),recovery_alpha:Number(b.recovery_alpha??.18),k2_confidence:Number(b.k2_confidence||.84),k3_confidence:Number(b.k3_confidence||.67),max_refinement:Number(v.max_refinement||3),max_confirmation:Number(v.max_confirmation||2),confidence:Number(def.content.constraints?.confidence||.95),familywise_confidence:Number(v.familywise_confidence||def.content.constraints?.confidence||.95),multiplicity_method:v.multiplicity_method||'bonferroni',family_size:Number(def.content.design?.max_candidates||128),exploration_n:Number(v.exploration_n||env.SIM_BATCH_SIZE||180),refinement_n:Number(v.refinement_n||env.SIM_BATCH_SIZE||240),confirmation_n:Number(v.confirmation_n||Math.max(300,Number(env.SIM_BATCH_SIZE||180))),robust_n:Number(v.robust_n||Math.max(300,Number(env.SIM_BATCH_SIZE||180))),empirical:cal};
}
function designDims(d){
  const dims=['sigma','tau','alpha','K','d','W','m'].map(k=>({k,vals:(d[k]&&d[k].length?d[k]:[0]).map(Number)}));
  const est=(d.estimators||ESTIMATORS).filter(x=>ESTIMATORS.includes(x));
  dims.push({k:'estimator',vals:est.length?est:['ema']});
  return dims;
}
function decodePoint(dims,idx){ const o={}; for(const {k,vals} of dims){ o[k]=vals[idx%vals.length]; idx=Math.floor(idx/vals.length); } return o; }
// CPU-light maximin: never materialises the full cartesian grid (tens of thousands of points).
// Draws a deterministic random pool, then greedy farthest-point selection with an incremental min-distance array.
export function sampleDesign(d,max,seed){
  const dims=designDims(d); const total=dims.reduce((a,x)=>a*x.vals.length,1);
  const pool=[], poolMult=2;
  if(total<=max*poolMult){ for(let i=0;i<total;i++) pool.push(decodePoint(dims,i)); }
  else{ const rng=mulberry32(seed), seen=new Set(), want=max*poolMult; while(pool.length<want){ const i=Math.floor(rng()*total); if(seen.has(i))continue; seen.add(i); pool.push(decodePoint(dims,i)); } }
  if(pool.length<=max) return pool;
  const nk=['sigma','tau','alpha','K','d','W','m'], range={};
  for(const k of nk){ const vs=dims.find(x=>x.k===k).vals; range[k]=[Math.min(...vs),Math.max(...vs)]; }
  const D=nk.length, N=pool.length, vec=new Float64Array(N*D), est=new Int8Array(N), ests=dims[7].vals;
  for(let i=0;i<N;i++){ for(let t=0;t<D;t++){ const k=nk[t]; vec[i*D+t]=(Number(pool[i][k])-range[k][0])/Math.max(EPS,range[k][1]-range[k][0]); } est[i]=ests.indexOf(pool[i].estimator); }
  const minD=new Float64Array(N).fill(Infinity), taken=new Uint8Array(N), chosen=[]; let cur=0;
  while(true){
    taken[cur]=1; chosen.push(pool[cur]); if(chosen.length>=max)break;
    let best=-1,bi=-1; const co=cur*D;
    for(let i=0;i<N;i++){ if(taken[i])continue; let s2=est[i]===est[cur]?0:1; const io=i*D; for(let t=0;t<D;t++){const z=vec[io+t]-vec[co+t]; s2+=z*z;} if(s2<minD[i])minD[i]=s2; if(minD[i]>best){best=minD[i];bi=i;} }
    cur=bi;
  }
  return chosen;
}
export async function seedCandidates(env,projectId){
  const proj=await one(env.DB,`SELECT research_cycle,evidence_revision FROM projects WHERE id=?`,[projectId]); const cycle=Number(proj?.research_cycle||1);
  const existing=await one(env.DB,`SELECT COUNT(*) n FROM design_candidates WHERE project_id=? AND research_cycle=?`,[projectId,cycle]); if(Number(existing?.n||0)>0){
    // 주기적 수집(collect→measure→seed_candidates)마다 buildProtocol(후보 128행+에폭+계수)을 다시 돌리던 경로.
    // 동결된 프로토콜이 이미 있으면 재구성하지 않는다(무결성은 compute_candidate 에서 검증).
    const frozen=await one(env.DB,`SELECT 1 x FROM research_protocols WHERE project_id=? AND research_cycle=? LIMIT 1`,[projectId,cycle]);
    if(!frozen) await ensureFrozenProtocol(env,projectId);
    await enqueueOnce(env,projectId,'advance_project',{},5);
    return{created:0,resume_requested:true};
  }
  const def=await latestDefinition(env,projectId); if(!def)throw new Error('definition_missing'); const d={...(def.content.design||{})};
  const mr=await one(env.DB,`SELECT metrics_json FROM measurements WHERE project_id=? ORDER BY measured_at DESC LIMIT 1`,[projectId]);
  const mm=safeJson(mr?.metrics_json,{}),op=mm.operational||{},observedSigma=Number(mm?.pooled?.empirical_sigma);
  const robustGrid=(v,min=0,max=999,integer=false)=>{const a=[.6,1,1.4].map(m=>clamp(v*m,min,max)).map(x=>integer?Math.round(x):Number(x.toFixed(4)));return [...new Set(a)];};
  if(d.grid_source==='operational'&&Number.isFinite(observedSigma)&&observedSigma>0&&Number(mm.numeric_observations||0)>=30)d.sigma=robustGrid(observedSigma,.005,.50,false);
  if(d.grid_source==='operational'&&op.data_latency_days!=null&&Number.isFinite(Number(op.data_latency_days)))d.tau=robustGrid(Number(op.data_latency_days),0,30,true);
  if(d.grid_source==='operational'&&op.approval_delay_days!=null&&Number.isFinite(Number(op.approval_delay_days)))d.d=robustGrid(Number(op.approval_delay_days),0,30,false);
  const combos=Array.isArray(d.candidate_rows)?d.candidate_rows:sampleDesign(d,Number(d.max_candidates||128),hashString(`${projectId}:design`)); const now=nowIso(); const candIds=combos.map(()=>uid('cand'));
  const rows=combos.map((x,i)=>({...x,id:candIds[i]}));
  const stmts=[env.DB.prepare(`INSERT INTO design_candidates(id,project_id,sigma,tau,alpha,authority_k,delay_d,recovery_w,adjust_m,status,estimator,evidence_status,created_at,updated_at,research_cycle,base_id,candidate_role,pair_seed_key)
   SELECT json_extract(value,'$.id'),?,json_extract(value,'$.sigma'),json_extract(value,'$.tau'),json_extract(value,'$.alpha'),json_extract(value,'$.K'),json_extract(value,'$.d'),json_extract(value,'$.W'),json_extract(value,'$.m'),'pending',json_extract(value,'$.estimator'),'pending',?,?,?,json_extract(value,'$.base_id'),COALESCE(json_extract(value,'$.role'),'exploratory'),json_extract(value,'$.base_id') FROM json_each(?)`).bind(projectId,now,now,cycle,JSON.stringify(rows))];
  if(rows.length)await env.DB.batch([...stmts,env.DB.prepare('UPDATE projects SET candidate_count=? WHERE id=?').bind(rows.length,projectId)]);
  await ensureFrozenProtocol(env,projectId);
  await enqueueMany(env,projectId,'compute_candidate',candIds.map(id=>({candidate_id:id,phase:'exploration',cycle:0})),40);
  await audit(env,projectId,'agent','cdrs.seed','project',projectId,{created:rows.length,method:Array.isArray(d.candidate_rows)?'preregistered_paired_csv':'maximin',estimators:d.estimators||ESTIMATORS,empirical_grid:{sigma:d.sigma,tau:d.tau,d:d.d},source:{sigma:Number.isFinite(observedSigma)&&Number(mm.numeric_observations||0)>=30?'external_observations':'paper/default',tau:d.grid_source==='operational'&&op.data_latency_days!=null&&Number.isFinite(Number(op.data_latency_days))?'operational_logs':'declared_design',approval_delay:d.grid_source==='operational'&&op.approval_delay_days!=null&&Number.isFinite(Number(op.approval_delay_days))?'operational_logs':'declared_design'}}); return{created:rows.length};
}
async function loadScenarios(env,projectId,phase,cal){
  if(phase==='historical'){
    const eps=await cached(env,projectId,'scn:episodes',()=>all(env.DB,`SELECT * FROM empirical_episodes WHERE project_id=? AND peak_outflow IS NOT NULL AND concentration IS NOT NULL AND severity IS NOT NULL ORDER BY year,episode_name`,[projectId]));
    if(eps.length){const full=eps.length>=Number(cal.profile.panel_n||81);return {scenarios:eps.map(r=>({...empiricalScenarioFromEpisode(r,cal),validation_group:'Historical'})),source:full?'empirical_episodes_full':'empirical_episodes_partial',empirical_ready:full,episode_n:eps.length};}
    const rows=await cached(env,projectId,'scn:user-historical',()=>all(env.DB,`SELECT * FROM scenarios WHERE project_id=? AND scenario_type='historical' ORDER BY name`,[projectId]));
    if(rows.length)return {scenarios:rows.map(r=>({...scenarioFromRow(r,cal),validation_group:'Historical'})),source:'user_historical_scenarios',empirical_ready:false,episode_n:0};
    return {scenarios:syntheticScenarios(cal),source:'published_summary_anchor',empirical_ready:false,episode_n:0};
  }
  if(phase==='stress'){
    const rows=await cached(env,projectId,'scn:user-adversarial',()=>all(env.DB,`SELECT * FROM scenarios WHERE project_id=? AND scenario_type='adversarial' ORDER BY name`,[projectId]));
    if(rows.length)return {scenarios:rows.map(r=>scenarioFromRow(r,cal)),source:'user_adversarial_scenarios',empirical_ready:true,episode_n:rows.length};
    const base=paperStressScenarios(cal),boot=calibrationUncertaintyScenarios(cal),loss=lossProxyScenarios(cal),official=await officialValidationScenarios(env,projectId,cal),scenarios=[...base,...boot,...loss,...official];
    return {scenarios,source:`paper_wide_40pct_grid+calibration_uncertainty+loss_proxy_sensitivity${official.length?'+official_external_validation':''}`,empirical_ready:true,episode_n:scenarios.length,official_scenarios:official.length};
  }
  return {scenarios:syntheticScenarios(cal),source:'published_summary_anchor',empirical_ready:false,episode_n:0};
}
async function priorAggregate(env,candidateId,phase){
  let phases=phase==='refinement'?['exploration','refinement']:[phase];
  if(phase==='confirmation')phases=['confirmation'];
  const marks=phases.map(()=>'?').join(','); const rows=await all(env.DB,`SELECT result_json FROM simulation_runs WHERE candidate_id=? AND phase IN (${marks}) ORDER BY created_at`,[candidateId,...phases]);
  const a=emptyAgg(); for(const r of rows){const j=safeJson(r.result_json,{});if(j.raw)mergeAgg(a,j.raw);} return a;
}
function nForPhase(config,phase){ if(phase==='exploration')return config.exploration_n;if(phase==='refinement')return config.refinement_n;if(phase==='confirmation')return config.confirmation_n;return config.robust_n; }
export async function computeCandidate(env,projectId,candidateId,phase='exploration',cycle=0){
  if(['github-actions','hybrid'].includes(env.COMPUTE_EXECUTOR)&&env.EXTERNAL_RUNTIME!=='github-actions')throw new Error('compute_requires_github_actions');
  const c=await one(env.DB,`SELECT * FROM design_candidates WHERE id=? AND project_id=?`,[candidateId,projectId]);if(!c)throw new Error('candidate_not_found');
  const projectMeta=await cached(env,projectId,'project:compute-meta',()=>one(env.DB,`SELECT research_cycle,evidence_revision FROM projects WHERE id=?`,[projectId]),30_000);const projectCycle=Number(projectMeta?.research_cycle||1),projectRev=Number(projectMeta?.evidence_revision||0);if(Number(c.research_cycle||1)!==projectCycle)throw new Error('candidate_superseded_by_new_cycle');
  await assertProtocolIntegrity(env,projectId,{cycle:projectCycle});
  const def=await latestDefinition(env,projectId);if(!def)throw new Error('definition_missing');const constraints=def.content.constraints,cal=await loadEmpiricalCalibration(env,projectId),config=configFrom(def,env,cal);
  let reviewer=null;if(phase==='recompute'){const key=`reviewer:latest:${projectCycle}:${projectRev}`;const rm=await cached(env,projectId,key,()=>one(env.DB,`SELECT model_json FROM reviewer_models WHERE project_id=? AND research_cycle=? AND evidence_revision=? ORDER BY version DESC LIMIT 1`,[projectId,projectCycle,projectRev]));reviewer=rm?safeJson(rm.model_json,{}):null;}
  const scenarioPack=await loadScenarios(env,projectId,phase==='recompute'?'confirmation':phase,cal),scenarios=scenarioPack.scenarios; const seed=deterministicSeed(projectId,c.pair_seed_key||candidateId,phase,cycle),rng=mulberry32(seed),n=nForPhase(config,phase);
  const id=`sim_unit_${candidateId}_${phase}_${cycle}_${phase==='recompute'?projectRev:'protocol'}`,saved=await one(env.DB,`SELECT result_json FROM simulation_runs WHERE id=?`,[id]);
  const batch=emptyAgg(),baseline=emptyAgg();if(!saved)for(let i=0;i<n;i++){const sc=scenarios[i%scenarios.length],episodeSeed=hashString(seed+'|'+i);addEpisode(batch,simulateEpisode(c,constraints,mulberry32(episodeSeed),sc,reviewer,config,mulberry32(episodeSeed^0x5a5a)),sc.key,sc.validation_group||null);if(config.noninferiority)addEpisode(baseline,simulateEpisode({...c,authority_k:0},constraints,mulberry32(episodeSeed),sc,reviewer,config,mulberry32(episodeSeed^0x5a5a)),sc.key,sc.validation_group||null);}
  let combined=batch; if(!saved&&['refinement','confirmation'].includes(phase)){const prior=await priorAggregate(env,candidateId,phase);combined=mergeAgg(prior,batch);}
  const confirmatory=['confirmation','historical','stress','recompute'].includes(phase);
  const ev=saved?safeJson(saved.result_json,{}):finalizeAgg(combined,constraints,confirmatory?config.familywise_confidence:config.confidence,{method:config.multiplicity_method,familySize:config.family_size*(config.noninferiority?2:1),adjust:confirmatory});
  if(config.noninferiority&&!saved){const base=finalizeAgg(baseline,constraints,config.familywise_confidence,{method:'bonferroni',familySize:config.family_size*2,adjust:true});applyNoninferiority(ev,finalizeAgg(batch,constraints,config.familywise_confidence,{method:'bonferroni',familySize:config.family_size*2,adjust:true}),base,config.noninferiority);}
  const m=ev.metrics;
  const currentScope=await one(env.DB,`SELECT research_cycle,evidence_revision FROM projects WHERE id=?`,[projectId]);
  if(Number(currentScope?.research_cycle||1)!==projectCycle||Number(currentScope?.evidence_revision||0)!==projectRev)throw new Error('compute_scope_changed_during_run');
  const resultHash=saved?ev.result_hash:await sha256Hex(stableStringify({seed,phase,cycle,projectRev,raw:batch,metrics:m}));
  // Fast evaluation path: persist one candidate atomically in a single D1 batch.
  // The numerical engine, deterministic seed and statistical thresholds are unchanged;
  // only REST round-trips are reduced. This is especially important when >100 candidates
  // are still UNEVALUATED on the GitHub Actions/D1 REST runner.
  const writeTs=nowIso();
  const resultJson=JSON.stringify({...ev,result_hash:resultHash,raw:saved?ev.raw:batch,cycle,runner_code_revision:env.RUNNER_CODE_REVISION||null,engine_version:'DCV-CDRS-v3',confidence_method:config.confidence_method,candidate_role:c.candidate_role,reviewer_source:reviewer?'current_revision_human_model':'design_priors_unvalidated',estimator:c.estimator,reviewer_used:!!reviewer,scenario_source:scenarioPack.source,empirical_ready:scenarioPack.empirical_ready,empirical_episode_n:scenarioPack.episode_n,empirical_profile:cal.profile.version});
  const auditDetail=JSON.stringify({phase,cycle,classification:ev.classification,boundary_score:ev.boundary_score,metrics:m,seed,result_hash:resultHash,runner_code_revision:env.RUNNER_CODE_REVISION||null,scenario_source:scenarioPack.source,empirical_ready:scenarioPack.empirical_ready,empirical_profile:cal.profile.version});
  const writes=[
    env.DB.prepare(`INSERT OR IGNORE INTO simulation_runs(id,project_id,candidate_id,phase,seed,n,loss_mean,loss_exceed_rate,fp_rate,fn_rate,review_burden,recovery_time,regret,result_json,created_at,evidence_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,projectId,candidateId,phase,seed,n,m.loss_mean,m.loss_exceed_rate,m.fp_rate,m.fn_rate,m.review_burden,m.recovery_time,null,resultJson,writeTs,projectRev),
    env.DB.prepare(`INSERT OR IGNORE INTO candidate_evidence(id,project_id,candidate_id,phase,cycle,classification,boundary_score,metrics_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).bind(`evidence_${id}`,projectId,candidateId,phase,cycle,ev.classification,ev.boundary_score,JSON.stringify(ev),writeTs)
  ];
  // Preserve the exact legacy state-transition semantics while combining writes.
  if(['exploration','refinement'].includes(phase)){
    const candidateStatus=ev.classification==='FEASIBLE'?'provisionally_feasible':ev.classification==='INFEASIBLE'?'infeasible':cycle>=config.max_refinement?'boundary_hold':'unresolved';
    writes.push(env.DB.prepare(`UPDATE design_candidates SET status=?,evidence_status=?,boundary_score=?,objective_score=?,updated_at=? WHERE id=?`).bind(candidateStatus,ev.classification,ev.boundary_score,m.objective_score,writeTs,candidateId));
  } else if(phase==='confirmation'){
    if(ev.classification==='FEASIBLE')writes.push(env.DB.prepare(`UPDATE design_candidates SET status='confirmed_feasible',evidence_status='FEASIBLE',boundary_score=?,objective_score=?,updated_at=? WHERE id=?`).bind(ev.boundary_score,m.objective_score,writeTs,candidateId));
    else if(ev.classification==='INFEASIBLE')writes.push(env.DB.prepare(`UPDATE design_candidates SET status='confirmation_failed',evidence_status='INFEASIBLE',updated_at=? WHERE id=?`).bind(writeTs,candidateId));
    else if(cycle>=config.max_confirmation)writes.push(env.DB.prepare(`UPDATE design_candidates SET status='boundary_hold',evidence_status='UNRESOLVED',boundary_score=?,updated_at=? WHERE id=?`).bind(ev.boundary_score,writeTs,candidateId));
  }
  writes.push(env.DB.prepare(`INSERT INTO audit_log(id,project_id,actor,action,entity_type,entity_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?)`).bind(uid('audit'),projectId,'agent','cdrs.run','candidate',candidateId,auditDetail,writeTs));
  await env.DB.batch(writes);
  if(['exploration','refinement'].includes(phase)){
    if(ev.classification==='UNRESOLVED'&&cycle<config.max_refinement)await enqueueComputeOnce(env,projectId,{candidate_id:candidateId,phase:'refinement',cycle:cycle+1},35-Math.min(10,Math.round(ev.boundary_score)));
    if(ev.classification==='FEASIBLE')await enqueueComputeOnce(env,projectId,{candidate_id:candidateId,phase:'confirmation',cycle:0},45);
  } else if(phase==='confirmation'&&ev.classification==='UNRESOLVED'&&cycle<config.max_confirmation){
    await enqueueComputeOnce(env,projectId,{candidate_id:candidateId,phase:'confirmation',cycle:cycle+1},42);
  }
  return{id,phase,cycle,seed,classification:ev.classification,boundary_score:ev.boundary_score,...m};
}
export async function enqueueRobustValidation(env,projectId){
  const proj=await one(env.DB,`SELECT research_cycle FROM projects WHERE id=?`,[projectId]); const cycle=Number(proj?.research_cycle||1);
  const cands=await all(env.DB,`SELECT id FROM design_candidates WHERE project_id=? AND research_cycle=? AND status='confirmed_feasible' AND (NOT EXISTS(SELECT 1 FROM simulation_runs r WHERE r.candidate_id=design_candidates.id AND r.phase='historical') OR NOT EXISTS(SELECT 1 FROM simulation_runs r WHERE r.candidate_id=design_candidates.id AND r.phase='stress')) ORDER BY boundary_score DESC LIMIT 60`,[projectId,cycle]);
  // 후보마다 'SELECT DISTINCT phase' 를 날리던 N+1 루프 → 프로젝트 단위 1회 조회(커버링 인덱스)
  const doneRows=await all(env.DB,`SELECT DISTINCT candidate_id,phase FROM simulation_runs WHERE project_id=? AND phase IN ('historical','stress')`,[projectId]);
  const done=new Set(doneRows.map(r=>`${r.candidate_id}|${r.phase}`));
  const hist=[],stress=[];
  for(const c of cands){
    if(!done.has(`${c.id}|historical`))hist.push({candidate_id:c.id,phase:'historical',cycle:0});
    if(!done.has(`${c.id}|stress`))stress.push({candidate_id:c.id,phase:'stress',cycle:0});
  }
  // 작업당 INSERT+큐 전송 1회씩 하던 것을 배치로
  await enqueueMany(env,projectId,'compute_candidate',[...hist,...stress],50);
  return{queued:hist.length+stress.length,candidates:cands.length};
}
export async function computeRegretTable(env,projectId,preloadedRuns=null){
  const proj=await one(env.DB,`SELECT research_cycle FROM projects WHERE id=?`,[projectId]); const cycle=Number(proj?.research_cycle||1);
  const cands=await all(env.DB,`SELECT id FROM design_candidates WHERE project_id=? AND research_cycle=? AND status='confirmed_feasible'`,[projectId,cycle]);
  const confirmedIds=new Set(cands.map(c=>c.id));
  // 후보마다 simulation_runs 를 따로 조회하던 N+1 루프 → 프로젝트 단위 1회 조회(호출자가 이미 읽었으면 재사용)
  const runs=preloadedRuns||await all(env.DB,`SELECT candidate_id,phase,result_json FROM simulation_runs WHERE project_id=? AND phase IN ('historical','stress') ORDER BY created_at DESC`,[projectId]);
  const latestBy=new Map(); for(const r of runs){ if(!confirmedIds.has(r.candidate_id)||(r.phase!=='historical'&&r.phase!=='stress'))continue; let m=latestBy.get(r.candidate_id); if(!m){m={};latestBy.set(r.candidate_id,m);} if(!m[r.phase])m[r.phase]=safeJson(r.result_json,{}); }
  const rows=cands.map(c=>({id:c.id,latest:latestBy.get(c.id)||{}}));
  const complete=rows.filter(r=>['historical','stress'].every(ph=>Object.keys(r.latest[ph]?.scenario_scores||{}).length));
  const keys=new Set(complete.flatMap(r=>['historical','stress'].flatMap(ph=>Object.keys(r.latest[ph].scenario_scores).map(k=>ph+':'+k))));
  const eligible=complete.filter(r=>['historical','stress'].reduce((n,ph)=>n+Object.keys(r.latest[ph].scenario_scores).length,0)===keys.size);
  const best={};for(const row of eligible)for(const ph of ['historical','stress'])for(const [key,v] of Object.entries(row.latest[ph].scenario_scores))best[ph+':'+key]=Math.min(best[ph+':'+key]??Infinity,Number(v.objective));
  const ids=new Set(eligible.map(r=>r.id)),result=rows.map(row=>{if(!ids.has(row.id))return {candidate_id:row.id,max_regret:null,mean_regret:null,status:'MISSING_SCENARIO_COVERAGE'};const values=['historical','stress'].flatMap(ph=>Object.entries(row.latest[ph].scenario_scores).map(([key,v])=>Math.max(0,Number(v.objective)-best[ph+':'+key])));return {candidate_id:row.id,max_regret:Math.max(...values),mean_regret:mean(values),status:'COMPUTED'};});
  if(result.length){const payload=JSON.stringify(result),ts=nowIso();await env.DB.batch([
   env.DB.prepare(`UPDATE design_candidates SET max_regret=(SELECT json_extract(value,'$.max_regret') FROM json_each(?) WHERE json_extract(value,'$.candidate_id')=design_candidates.id),updated_at=? WHERE id IN (SELECT json_extract(value,'$.candidate_id') FROM json_each(?))`).bind(payload,ts,payload),
   env.DB.prepare(`UPDATE simulation_runs SET regret=(SELECT json_extract(value,'$.max_regret') FROM json_each(?) WHERE json_extract(value,'$.candidate_id')=simulation_runs.candidate_id) WHERE candidate_id IN (SELECT json_extract(value,'$.candidate_id') FROM json_each(?)) AND phase IN ('historical','stress')`).bind(payload,payload)
  ]);}
  return result.sort((a,b)=>(a.max_regret??Infinity)-(b.max_regret??Infinity));
}

// Pure helpers exposed only for deterministic unit tests; production orchestration uses the exported CDRS functions above.
export const __test = { simulateEpisode,confidenceFor,configFrom,applyNoninferiority,finalizeAgg, emptyAgg, mergeAgg, estimatorStep, empiricalChannel, calibrationUncertaintyScenarios, lossProxyScenarios };
