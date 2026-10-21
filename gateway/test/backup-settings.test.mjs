import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createGateway} from '../server.mjs';

test('local backup settings validate and persist without restart',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'trace-settings-'));
 const dataDir=path.join(root,'data'),workspace=path.join(root,'workspace');await mkdir(workspace);
 const app=await createGateway({port:0,dataDir,seed:false});
 const get=async()=>{const response=await fetch(app.base+'/api/settings/file-backup');assert.equal(response.status,200);return response.json();};
 const put=(value,headers={origin:app.base})=>fetch(app.base+'/api/settings/file-backup',{method:'PUT',headers:{'content-type':'application/json',...headers},body:JSON.stringify(value)});
 try{
  const original=await get();assert.equal(original.config.enabled,false);assert.equal(original.configPath,path.join(dataDir,'file-backup.json'));
  assert.equal((await put(original.config,{})).status,403);
  assert.equal((await put(original.config,{origin:'https://foreign.example'})).status,403);
  const value={...original.config,enabled:true,rules:[{id:'dsh-read',operation:'read',toolNames:['read'],pathFields:['file_path']}]};
  assert.equal(Object.hasOwn(original.config,'workspaceRoot'),false);
  assert.equal((await put({...value,rules:[{id:'invalid'}]})).status,400);
  assert.deepEqual((await get()).config,original.config);
  const response=await put(value);assert.equal(response.status,200);assert.deepEqual((await response.json()).config,value);
  assert.deepEqual(JSON.parse(await readFile(original.configPath,'utf8')),value);
  assert.deepEqual((await get()).config,value);
  assert.equal((await put({...value,enabled:false})).status,200);assert.equal((await get()).config.enabled,false);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
