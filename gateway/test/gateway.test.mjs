import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createGateway} from '../server.mjs';

test('HTTP integration',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'trace-test-')),seen=[];
 const sse=Buffer.from('event: future_event\r\ndata: {"text":"你好🌍"}\r\n\r\ndata: [DONE]\n\n');
 const upstream=http.createServer(async(req,res)=>{
   const chunks=[];for await(const b of req)chunks.push(b);seen.push({url:req.url,headers:req.headers,body:Buffer.concat(chunks)});
   if(req.url.includes('failure')){res.writeHead(429,{'retry-after':'2','content-type':'application/json'});return res.end('{"error":{"message":"rate limited"}}');}
   if(req.url.includes('stream')){res.writeHead(200,{'content-type':'text/event-stream'});res.write(sse.subarray(0,43));setTimeout(()=>res.end(sse.subarray(43)),120);return;}
   if(req.url.includes('slow')){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: start\n\n');const timer=setInterval(()=>res.write('data: next\n\n'),15);res.on('close',()=>clearInterval(timer));return;}
   if(req.url.includes('reset')){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: partial\n\n');setTimeout(()=>res.destroy(),20);return;}
   res.writeHead(200,{'content-type':'application/json','x-upstream':'preserved'});res.end('{"id":"resp_123","output":[{"role":"assistant","content":[{"type":"output_text","text":"OK"}]}]}');
 });upstream.listen(0,'127.0.0.1');await once(upstream,'listening');let app=await createGateway({port:0,dataDir,seed:false});
 const post=(url,payload={},headers={})=>fetch(app.base+url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(payload)});
 try{
   const p=await(await post('/api/providers',{name:'Test',url:`http://127.0.0.1:${upstream.address().port}/v1`,protocol:'auto'})).json(),prefix=`/p/${p.id}/v1`;
   await t.test('JSON body, Anthropic auth/beta headers, query and /v1 normalization',async()=>{
     const payload={model:'test',messages:[{role:'user',content:'你好'}],tools:[{name:'test'}]};
     const r=await post(prefix+'/messages?beta=true',payload,{'x-api-key':'secret-anthropic','anthropic-version':'2023-06-01','anthropic-beta':'test-beta','x-session-id':'session-a'});assert.equal(r.status,200);assert.equal(r.headers.get('x-upstream'),'preserved');await r.text();
     assert.equal(seen.at(-1).url,'/v1/messages?beta=true');assert.equal(seen.at(-1).headers['x-api-key'],'secret-anthropic');assert.equal(seen.at(-1).headers['anthropic-beta'],'test-beta');assert.deepEqual(JSON.parse(seen.at(-1).body),payload);
   });
   await t.test('SSE arrives before end and preserves split Unicode/unknown events',async()=>{
     const r=await post(prefix+'/stream',{model:'test',stream:true,messages:[{role:'user',content:'hello'}]},{authorization:'Bearer secret-openai','x-session-id':'session-a'});
     const reader=r.body.getReader(),first=await reader.read();assert.equal(first.done,false);assert.ok(first.value.length<sse.length);const all=[Buffer.from(first.value)];for(;;){const next=await reader.read();if(next.done)break;all.push(Buffer.from(next.value));}assert.deepEqual(Buffer.concat(all),sse);assert.equal(seen.at(-1).headers.authorization,'Bearer secret-openai');
   });
   await t.test('explicit sessions and Responses previous_response_id chains',async()=>{
     let r=await post(prefix+'/responses',{input:'root'},{'x-session-id':'response-session'});const sid=r.headers.get('x-trace-session-id');await r.text();r=await post(prefix+'/responses',{input:'next',previous_response_id:'resp_123'});assert.equal(r.headers.get('x-trace-session-id'),sid);await r.text();
     const st=await(await fetch(app.base+'/api/state')).json();assert.equal(st.sessions.find(s=>s.id.endsWith(':session-a')).count,2);assert.equal(st.sessions.find(s=>s.id===decodeURIComponent(sid)).count,2);
   });
   await t.test('Unicode session metadata is encoded safely in response headers',async()=>{const r=await post(prefix+'/messages',{metadata:{session_id:'中文会话🌍'},messages:[{role:'user',content:'hi'}]});assert.match(decodeURIComponent(r.headers.get('x-trace-session-id')),/中文会话🌍/);await r.text();});
   await t.test('upstream errors preserve status and retry-after',async()=>{const r=await post(prefix+'/failure',{});assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'2');assert.match(await r.text(),/rate limited/);});
   await t.test('cancellation and upstream disconnect finish recording',async()=>{
     const r=await post(prefix+'/slow',{stream:true},{'x-session-id':'cancelled'}),reader=r.body.getReader();await reader.read();await reader.cancel();await new Promise(r=>setTimeout(r,60));
     const broken=await post(prefix+'/reset',{stream:true});await assert.rejects(()=>broken.text());await new Promise(r=>setTimeout(r,20));const st=await(await fetch(app.base+'/api/state')).json();assert.equal(st.active,0);assert.equal(st.sessions.find(s=>s.id.endsWith(':cancelled')).errors,1);
   });
   await t.test('cross-origin browser configuration is denied',async()=>{assert.equal((await post('/api/providers',{name:'bad',url:'https://example.com'},{origin:'https://evil.test'})).status,403);});
   await t.test('export and restart persistence, no recorded auth secrets',async()=>{
     await app.flush();const files=await readdir(path.join(dataDir,'records'));assert.ok(files.length>=7);const disk=(await Promise.all(files.map(f=>readFile(path.join(dataDir,'records',f),'utf8')))).join('');assert.ok(!disk.includes('secret-anthropic'));assert.ok(!disk.includes('secret-openai'));
     const st=await(await fetch(app.base+'/api/state')).json(),exported=await fetch(app.base+'/api/sessions/'+encodeURIComponent(st.sessions[0].id)+'?export=1');assert.ok(exported.headers.get('content-disposition'));assert.ok((await exported.json()).length);await app.close();app=await createGateway({port:0,dataDir,seed:false});assert.equal((await(await fetch(app.base+'/api/state')).json()).sessions.length,st.sessions.length);
   });
 }finally{await app.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));await rm(dataDir,{recursive:true,force:true});}
});
