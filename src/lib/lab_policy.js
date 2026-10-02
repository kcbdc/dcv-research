export const LAB_ROLES = [
 {id:'advisor_direction',name:'공동지도교수 1',title:'Research direction',group:'advisor',mission:'Challenge novelty, theory, identification, scope, and journal fit.'},
 {id:'advisor_methods',name:'공동지도교수 2',title:'Methods advisor',group:'advisor',mission:'Critique design, causal language, uncertainty and independent validation.'},
 {id:'collector_literature',name:'자료수집가 1',title:'Literature curator',group:'collector',mission:'Synthesize verified DOI metadata, distinguish relevance from claim support; metadata is not full-text verification.'},
 {id:'collector_data',name:'자료수집가 2',title:'Data curator',group:'collector',mission:'Inventory actual project evidence, provenance and missing official/human evidence. Never manufacture observations.'},
 {id:'analyst_statistics',name:'자료분석가 1',title:'Statistical analyst',group:'analyst',mission:'Interpret deterministic replication diagnostics and actual confidence intervals, without inventing effect sizes or p-values.'},
 {id:'analyst_robustness',name:'자료분석가 2',title:'Robustness analyst',group:'analyst',mission:'Audit robustness, reconstructed vs verified evidence, holdout separation and sensitivity.'},
 {id:'standardizer_claims',name:'표준화 관리자 1',title:'Claims and standards',group:'standardizer',mission:'Check numerical claims, evidence identifiers, limitations and research ethics. Flag unsupported assertions.'},
 {id:'standardizer_repro',name:'사후관리자 2',title:'Reproducibility editor',group:'standardizer',mission:'Check references, code, journal metric evidence, anonymization and submission completeness.'},
 {id:'writer',name:'자료작성자',title:'Manuscript writer',group:'writer',mission:'Draft and revise the assigned manuscript section in precise scholarly English, using only supplied evidence.'},
 {id:'leader',name:'리더',title:'Principal investigator agent',group:'leader',mission:'Make the final internal editorial recommendation, reconcile reviews, prioritize real blockers and prepare submission documents. Never claim journal acceptance.'}
];
export const MANUSCRIPT_SECTIONS=['abstract','introduction','related_work','methods','results','discussion','conclusion'];
export const DEFAULT_DEADLINE='2026-10-30T14:59:59.000Z'; // October 30 23:59:59 Asia/Seoul
export const DEFAULT_YEARS=[2023,2024,2025]; // JCR metric years, not release years
export const DEFAULT_TARGET_JOURNAL='Journal of Financial Stability';
export function labPhase(day){return day<=4?'protocol_and_gap':day<=10?'evidence_collection':day<=17?'analysis_and_validation':day<=23?'manuscript_revision':day<=27?'independent_review':'submission_packaging';}
export function writingSection(day){return MANUSCRIPT_SECTIONS[(day-1)%MANUSCRIPT_SECTIONS.length];}
export function makeLabPlan(){return Array.from({length:300},(_,seq)=>({seq,day:Math.floor(seq/10)+1,role_id:LAB_ROLES[seq%10].id,phase:labPhase(Math.floor(seq/10)+1)}));}
export function normalizeConfig(input={}){
 const years=(input.metric_years||DEFAULT_YEARS).map(Number);
 if(years.length!==3||new Set(years).size!==3||years.some(y=>!Number.isInteger(y)||y<2000||y>2100))throw new Error('Three distinct JCR metric years are required');
 const authors=Array.isArray(input.authors)?input.authors.slice(0,20).map(a=>({name:String(a.name||'').slice(0,120),affiliation:String(a.affiliation||'').slice(0,300),email:String(a.email||'').slice(0,150),corresponding:!!a.corresponding})):[];
 return {metric_years:years.sort(),authors,target_journal:String(input.target_journal||DEFAULT_TARGET_JOURNAL).trim().slice(0,200),
  literature_query:String(input.literature_query||'algorithmic delegation public payments uncertainty human oversight').slice(0,250),
  ethics_statement:String(input.ethics_statement||'').slice(0,2000),funding:String(input.funding||'').slice(0,1000),conflicts:String(input.conflicts||'').slice(0,1000),
  full_text_verified_dois:Array.isArray(input.full_text_verified_dois)?input.full_text_verified_dois.slice(0,100).map(String):[],
  start_on_deploy:input.start_on_deploy!==false};
}

export function labGateState(snapshot,{sources=[],journals=[],documents=[],replication=null}={},config={}){
 const diagnostics=snapshot?.diagnostics||{},base=new Set(diagnostics.blockers||[]),foundation=[];
 const take=pattern=>{for(const b of base)if(pattern.test(b))foundation.push(b);};
 take(/^Frozen research protocol missing$/);take(/^No candidate results$/);take(/^Fewer than 30 real human participants$/);
 take(/^Human correct\/error strata below predeclared minimum$/);take(/^Current-revision human recomputation not confirmed$/);
 take(/^Raw simulation aggregates missing for reproduction$/);take(/^Snapshot truncated:/);
 const replayChecks=replication?.checks_json?JSON.parse(replication.checks_json||'{}'):{};
 const replayVerified=replication?.data_digest===snapshot?.data_digest&&replayChecks.full_seed_replay===true;
 if(!replayVerified)foundation.push('Complete simulation seed replay has not been independently verified');
 const target=String(config.target_journal||DEFAULT_TARGET_JOURNAL).trim();
 const journal=journalAssessment(journals,config.metric_years||DEFAULT_YEARS,target);
 const evidence=[];
 if(!journal.eligible)evidence.push('Official three-year journal eligibility evidence missing or below threshold');
 if((sources||[]).length<15)evidence.push('Fewer than 15 DOI-verified references');
 const verified=new Set((config.full_text_verified_dois||[]).map(d=>String(d).toLowerCase()));
 const verifiedCount=[...verified].filter(d=>(sources||[]).some(s=>String(s.doi||'').toLowerCase()===d)).length;
 if(verifiedCount<10)evidence.push('Full-text support verification missing for key literature');
 const docs=new Map((documents||[]).map(d=>[d.section,d]));
 const manuscript=[];
 for(const section of MANUSCRIPT_SECTIONS){const d=docs.get(section);if(!d?.markdown?.trim())manuscript.push('Manuscript section missing: '+section);else if(d.evidence_signature!==snapshot?.data_digest)manuscript.push('Manuscript section uses superseded evidence: '+section);}
 const allSectionsPresent=MANUSCRIPT_SECTIONS.every(section=>docs.get(section)?.markdown?.trim());
 const words=MANUSCRIPT_SECTIONS.map(k=>docs.get(k)?.markdown||'').join(' ').split(/\s+/).filter(Boolean).length;
 if(allSectionsPresent&&words<3500)manuscript.push('Main manuscript below 3500-word internal review floor');
 const submission=[];
 if(allSectionsPresent&&manuscript.length===0)for(const section of ['cover_letter','title_page','highlights','appendices'])if(!docs.get(section)?.markdown?.trim())submission.push('Submission document missing: '+section);
 return {target_journal:target,journal,replay_verified:replayVerified,word_count:words,
  foundation:[...new Set(foundation)],evidence:[...new Set(evidence)],manuscript:[...new Set(manuscript)],submission:[...new Set(submission)],
  research_ready:foundation.length===0,evidence_ready:foundation.length===0&&evidence.length===0,
  manuscript_ready:foundation.length===0&&evidence.length===0&&manuscript.length===0,
  submission_ready:foundation.length===0&&evidence.length===0&&manuscript.length===0&&submission.length===0};
}

export function taskGate(roleId,gate){
 if(!gate.research_ready)return {blocked:true,stage:'research_foundation',blockers:gate.foundation};
 if(roleId==='writer'&&!gate.evidence_ready)return {blocked:true,stage:'evidence_verification',blockers:gate.evidence};
 if(roleId==='leader'&&!gate.manuscript_ready)return {blocked:true,stage:gate.evidence_ready?'manuscript':'evidence_verification',blockers:gate.evidence_ready?gate.manuscript:gate.evidence};
 return {blocked:false,stage:'ready',blockers:[]};
}

export function validateJournalRow(row,years){
 if(!years.includes(Number(row.metric_year)))throw new Error('Unexpected JCR metric year');
 if(!['SCIE','SSCI'].includes(row.edition))throw new Error('SCIE or SSCI coverage evidence is required');
 const source=new URL(row.source_url);
 if(source.protocol!=='https:'||!['clarivate.com','webofscience.com'].some(d=>source.hostname===d||source.hostname.endsWith('.'+d)))throw new Error('Use an official Clarivate or Web of Science evidence URL');
 if(!String(row.journal||'').trim()||!String(row.category||'').trim()||!String(row.verified_by||'').trim())throw new Error('Journal, category and human verifier are required');
 if(row.quartile!=null&&!['Q1','Q2','Q3','Q4'].includes(row.quartile))throw new Error('Invalid quartile');
 if(row.ais!=null&&(!Number.isFinite(Number(row.ais))||Number(row.ais)<0))throw new Error('Invalid AIS');
 return {...row,metric_year:Number(row.metric_year),ais:row.ais==null?null:Number(row.ais)};
}
export function journalAssessment(rows,years,target=''){
 const groups=new Map();for(const r of rows){if(target&&r.journal!==target)continue;if(!groups.has(r.journal))groups.set(r.journal,[]);groups.get(r.journal).push(r);}
 const candidates=[...groups].map(([journal,rs])=>({journal,years:years.map(year=>{const r=rs.find(x=>Number(x.metric_year)===year);return {year,evidence:r||null,pass:!!r&&['SCIE','SSCI'].includes(r.edition)&&(['Q1','Q2'].includes(r.quartile)||(r.ais!=null&&Number(r.ais)>=.75))};})}));
 for(const c of candidates)c.eligible=c.years.every(y=>y.pass);
 return {rule:'Each of the latest three configured metric years: SCIE/SSCI and (Q1/Q2 or AIS >= 0.75)',candidates,eligible:candidates.some(c=>c.eligible)};
}
export function validateLabOutput(output,role,sources){
 if(!output||typeof output.summary!=='string'||!output.summary.trim())throw new Error('AI output missing summary');
 const serialized=JSON.stringify(output);
 if(serialized.length>24000)throw new Error('AI output exceeds bounded task size');
 if(/[가-힣]/.test(output.summary))throw new Error('Research output must be English');
 const allowed=new Set(sources.map(s=>s.doi.toLowerCase()));
 for(const m of serialized.matchAll(/\[SRC:([^\]]+)\]/g))if(!allowed.has(m[1].toLowerCase()))throw new Error('Unverified DOI cited: '+m[1]);
 for(const m of serialized.matchAll(/10\.\d{4,9}\/[A-Za-z0-9._;()/:+-]+/g)){
  const doi=m[0].replace(/[).,;]+$/,'').toLowerCase();
  if(!allowed.has(doi)&&!allowed.has(m[0].toLowerCase()))throw new Error('Unknown DOI in AI output');
 }
 if(role.id==='writer'&&(typeof output.markdown!=='string'||output.markdown.split(/\s+/).length<80))throw new Error('Writer section is incomplete');
 if(role.id==='writer'&&/[가-힣]/.test(output.markdown))throw new Error('Manuscript sections must be English');
 return {summary:output.summary.slice(0,1800),findings:Array.isArray(output.findings)?output.findings.slice(0,12):[],
  blockers:Array.isArray(output.blockers)?output.blockers.slice(0,12).map(String):[],recommendations:Array.isArray(output.recommendations)?output.recommendations.slice(0,12).map(String):[],
  markdown:typeof output.markdown==='string'?output.markdown.slice(0,18000):'',documents:role.id==='leader'&&output.documents&&typeof output.documents==='object'?output.documents:{}};
}
