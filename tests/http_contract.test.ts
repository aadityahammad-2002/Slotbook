import {test} from 'node:test';
import assert from 'node:assert/strict';
import {api} from '../web/src/http.js';

const ok=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
test('Bodyless logout POST does not falsely advertise a JSON body',async()=>{
 let recorded:RequestInit|undefined;
 const send=(async(_url:RequestInfo|URL,options?:RequestInit)=>{recorded=options;return ok({ok:true});}) as typeof fetch;
 const result=await api('/auth/logout',{method:'POST'},send);
 assert.deepEqual(result,{ok:true});
 assert.equal(new Headers(recorded?.headers).has('Content-Type'),false);
});
test('Request with JSON payload sets content type and reports structured error',async()=>{
 let recorded:RequestInit|undefined;
 const send=(async(_url:RequestInfo|URL,options?:RequestInit)=>{recorded=options;return ok({error:'SLOT_FULL',message:'No seats left'},409);}) as typeof fetch;
 await assert.rejects(api('/holds',{method:'POST',body:JSON.stringify({event_id:'x'})},send),
  (error:any)=>error.status===409&&error.code==='SLOT_FULL'&&error.message==='No seats left');
 assert.equal(new Headers(recorded?.headers).get('Content-Type'),'application/json');
});
test('Non-JSON server failures provide a helpful error',async()=>{
 const send=(async()=>new Response('Service unavailable',{status:503})) as typeof fetch;
 await assert.rejects(api('/health',{},send),/Unexpected server response \(HTTP 503\)/);
});
