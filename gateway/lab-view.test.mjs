import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createGateway} from './server.mjs';
test('Lab binding, artifact visibility, authorization and path boundaries',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'trace-lab-ui-'));const app=await createGateway({port:0,dataDir:path.join(root,'data')});
 try{
 const request=async(url,opts)=>{const r=await fetch(app.base+url,opts);return [r.status,await r.json()];};
 assert.equal((await request('/api/lab'))[1].config,null);
 const configPath=path.join(root,'lab.json');await writeFile(configPath,JSON.stringify({version:1,outputDir:'output',target:{model:'local'},verifier:{type:'basic'}}));
 const opts={method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({configPath})};assert.equal((await request('/api/lab/config',opts))[0],403);
 opts.headers.origin=app.base;assert.equal((await request('/api/lab/config',opts))[0],200);
 assert.equal((await request('/api/lab'))[1].groups.samples.total,0);
 await mkdir(path.join(root,'output/samples'),{recursive:true});await mkdir(path.join(root,'output/runs/abc'),{recursive:true});
 await writeFile(path.join(root,'output/samples/abc.json'),JSON.stringify({id:'abc',query:'<script>alert(1)</script>',eligibility:{eligible:true},createdAt:'2026-10-22'}));
 await writeFile(path.join(root,'output/runs/abc/run.json'),JSON.stringify({id:'abc',status:'invalid',validity:{valid:false}}));
 await writeFile(path.join(root,'output/samples/bad.json'),'broken');await symlink(configPath,path.join(root,'output/samples/escape.json'));
 const d=(await request('/api/lab'))[1];assert.equal(d.groups.samples.items.length,1);assert.equal(d.groups.samples.errors,1);assert.equal(d.groups.runs.items[0].valid,false);
 assert.equal((await request('/api/lab/items/samples/abc'))[1].id,'abc');assert.equal((await request('/api/lab/items/samples/escape'))[0],400);assert.equal((await request('/api/lab/items/other/abc'))[0],400);
 assert.equal((await fetch(app.base+'/lab.js')).status,200);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
