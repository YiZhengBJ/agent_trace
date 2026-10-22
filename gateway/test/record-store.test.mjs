import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir,readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRecordStore} from '../record-store.mjs';
import {redact} from '../redaction.mjs';
test('shared message blocks reconstruct exact growing, branched and compacted contexts',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'trace-store-'));try{
 const store=await createRecordStore(dir),messages=Array.from({length:12},()=>({role:'user',content:randomBytes(50000).toString('base64')}));
 const original={id:'one',request:{model:'m',messages},response:'ok'};await store.put(original);const before=store.stats();
 const next={id:'two',request:{model:'m',messages:[...messages,{role:'user',content:'next'}]},response:'ok'};await store.put(next);const after=store.stats();
 assert.ok(after.reusedChunks>before.reusedChunks+12);assert.ok(after.writtenChunks-before.writtenChunks<5);
 for(const record of [original,next,{id:'branch',request:{messages:[...messages.slice(0,4),{role:'user',content:'fork'}]},response:'branch'},{id:'compact',request:{input:'summary'},response:'compact'}]){
 if(!['one','two'].includes(record.id))await store.put(record);const restored=await (await createRecordStore(dir)).get(record.id);assert.deepEqual(restored.request,record.request);assert.equal(restored.response,record.response);
 }
 const manifest=await store.metadata('one'),ref=manifest._body.response.chunks[0];await writeFile(path.join(dir,'record-chunks',ref.slice(0,2),ref+'.gz'),'corrupt');await assert.rejects(store.get('one'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('large legacy history migrates and restarts under a 96 MiB heap; pages and exports restore bodies', {timeout:60000},async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'trace-memory-'));try{
 await mkdir(path.join(dir,'records'));const text=randomBytes(400000).toString('base64');
 for(let i=0;i<200;i++)await writeFile(path.join(dir,'records',i+'.json'),JSON.stringify({id:String(i),sessionId:'s',providerId:'p',startedAt:new Date(i*1000).toISOString(),status:'completed',durationMs:1,bytes:2,request:{messages:[{role:'user',content:text}]},response:'ok'}));
 const script=`import {createGateway} from ${JSON.stringify(new URL('../server.mjs',import.meta.url).href)};const app=await createGateway({port:0,dataDir:process.argv[1]});global.gc();console.log(JSON.stringify({heap:process.memoryUsage().heapUsed}));const page=await(await fetch(app.base+'/api/sessions/s?limit=25')).json();if(page.records.length>=25||page.total!==200)throw Error('page byte limit');const response=await fetch(app.base+'/api/sessions/s?export=1');let n=0;for await(const chunk of response.body)n+=chunk.length;if(n<100000000)throw Error('incomplete export');await app.close();`;
 for(let pass=0;pass<2;pass++)await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--max-old-space-size=96','--expose-gc','--input-type=module','-e',script,dir]);let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);const timeout=setTimeout(()=>{child.kill();reject(Error('migration timeout'));},28000);child.on('exit',code=>{clearTimeout(timeout);if(code!==0)return reject(Error(err));const metrics=JSON.parse(out.trim());t.diagnostic('startup heap MiB: '+(metrics.heap/1024/1024).toFixed(1));assert.ok(metrics.heap<35*1024*1024,JSON.stringify(metrics));resolve();});});
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('long ordinary strings do not cause quadratic credential scanning',()=>{const text='x'.repeat(1024*1024);const start=performance.now();assert.equal(redact(text),text);assert.ok(performance.now()-start<2000);});
