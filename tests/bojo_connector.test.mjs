import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {enableOfficialConnector,collectOfficialSource} from '../src/lib/official_sources.js';
test('BOJO pagination preserves sector rows and encodes encoded secrets only once',async()=>{
 const DB=makeDb(),id=await seedProject(DB,{candidates:0,reviewer:0,episodes:0}),env={DB,BOJO_API_KEY:'test%2Fkey%3D%3D'};
 await enableOfficialConnector(env,id,'bojo_openapi',{endpoint_url:'https://apis.data.go.kr/1051000/MoefOpenAPI/T_OPD_PRMSCT_SBBGST?bsnsyear=2025'});
 const previous=globalThis.fetch;let calls=0;globalThis.fetch=async url=>{calls++;const u=new URL(url);assert.equal(u.searchParams.get('serviceKey'),'test/key==');assert.equal(u.searchParams.get('bsnsyear'),'2025');assert.equal(u.searchParams.get('resultType'),'json');const page=Number(u.searchParams.get('pageNo'));return Response.json({response:{header:{resultCode:'00'},body:{pageNo:page,numOfRows:1,totalCount:2,items:{item:{REALM_CODE:'010',SECT_CODE:page===1?'011':'012',BSNSYEAR:'2025',BGAMT:page===1?'571':'11'}}}}});};
 try{let source=DB.raw.prepare("SELECT * FROM data_sources WHERE connector_id='bojo_openapi'").get();const a=await collectOfficialSource(env,id,source);assert.equal(a.partial,true);source=DB.raw.prepare('SELECT * FROM data_sources WHERE id=?').get(source.id);assert.equal(source.last_fetched_at,null);assert.equal(JSON.parse(source.config_json).sync_page,2);const b=await collectOfficialSource(env,id,source);assert.equal(b.partial,false);const rows=DB.raw.prepare("SELECT * FROM official_observations WHERE connector_id='bojo_openapi'").all();assert.equal(rows.length,2);assert.equal(new Set(rows.map(r=>r.series_key)).size,2);assert.equal(rows.reduce((n,r)=>n+r.value_num,0),582);assert.ok(rows.every(r=>r.metric_code==='bojo.budget.by_sector'));assert.equal(calls,2);
 }finally{globalThis.fetch=previous;}
});
test('BOJO API error is not stored as a numeric observation',async()=>{
 const DB=makeDb(),id=await seedProject(DB,{candidates:0,reviewer:0,episodes:0}),env={DB,BOJO_API_KEY:'test'};await enableOfficialConnector(env,id,'bojo_openapi');const previous=globalThis.fetch;globalThis.fetch=async()=>Response.json({response:{header:{resultCode:'30',resultMsg:'denied'}}});
 try{await assert.rejects(()=>collectOfficialSource(env,id,DB.raw.prepare("SELECT * FROM data_sources WHERE connector_id='bojo_openapi'").get()),/BOJO_API_ERROR:30/);assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM official_observations').get().n,0);}finally{globalThis.fetch=previous;}
});
