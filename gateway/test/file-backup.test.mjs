import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm,symlink,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createGateway} from '../server.mjs';
import {matchedPaths,validateConfig,requestWorkingDirectory,createFileBackup,QueryTracker} from '../file-backup.mjs';

const template=JSON.parse(await readFile(new URL('../file-backup.example.json',import.meta.url),'utf8'));
const chat=calls=>({choices:[{message:{role:'assistant',tool_calls:calls.map((c,i)=>({id:'call-'+i,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}))}}]});
const sse=e=>'data: '+JSON.stringify(e)+'\n\n';

async function setup(t,{enabled=true,config={},handler}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'trace-backup-')),workspace=path.join(root,'workspace'),dataDir=path.join(root,'data');
  await mkdir(workspace);await mkdir(dataDir);
  const cfg={...structuredClone(template),enabled,...config};
  await writeFile(path.join(dataDir,'file-backup.json'),JSON.stringify(cfg));
  const upstream=http.createServer(async(req,res)=>{
    try{let body='';for await(const c of req)body+=c;await handler(JSON.parse(body||'{}'),res);}catch(e){res.destroy(e);}
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const app=await createGateway({port:0,dataDir,seed:false});
  const provider=await(await fetch(app.base+'/api/providers',{method:'POST',body:JSON.stringify({name:'test',url:`http://127.0.0.1:${upstream.address().port}`})})).json();
  t.after(async()=>{await app.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));await rm(root,{recursive:true,force:true});});
  return {root,workspace,dataDir,cfg,app,post:(body={},endpoint='chat/completions')=>fetch(app.base+`/p/${provider.id}/v1/`+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({metadata:{cwd:workspace},...body})}),records:async()=>{await app.flush();return Promise.all((await readdir(path.join(dataDir,'records'))).map(async f=>JSON.parse(await readFile(path.join(dataDir,'records',f),'utf8'))));}};
}

test('rules are extensible with exact names, regex and nested/array path fields',()=>{
  const c={...template,rules:[{id:'custom',operation:'write',namePattern:'^mcp__fs__edit$',pathFields:['edits.*.path','file.paths']}]};
  validateConfig(c);
  assert.deepEqual(matchedPaths(c,{name:'mcp__fs__edit',arguments:JSON.stringify({edits:[{path:'a'},{path:'b'}],file:{paths:['c','d']}})}).files.map(f=>f.path),['a','b','c','d']);
  assert.equal(matchedPaths(c,{name:'other',arguments:{}}).rules.length,0);
  assert.throws(()=>validateConfig({...c,rules:[{...c.rules[0],unexpected:true}]}));
  assert.throws(()=>validateConfig({...c,rules:[{...c.rules[0],namePattern:'['}]}));
  assert.equal(validateConfig({...c,enabled:true,workspaceRoot:'obsolete'}).workspaceRoot,undefined);
});

test('disabled mode preserves response and does not create file backups',async t=>{
  const reply=JSON.stringify(chat([{name:'Write',args:{file_path:'a.txt'}}]));
  const env=await setup(t,{enabled:false,handler:(_,res)=>{res.setHeader('content-type','application/json');res.end(reply);}});
  await writeFile(path.join(env.workspace,'a.txt'),'before');
  assert.equal(await(await env.post()).text(),reply);
  assert.equal((await env.records())[0].fileBackup,undefined);
  await assert.rejects(stat(path.join(env.dataDir,'file-backups')),e=>e.code==='ENOENT');
});

test('JSON tool instructions are backed up and associated before the client can execute them',async t=>{
  const reply=JSON.stringify(chat([{name:'Write',args:{file_path:'a.txt',content:'after'}}]));
  const env=await setup(t,{handler:(_,res)=>{res.setHeader('content-type','application/json');res.end(reply);}});
  await writeFile(path.join(env.workspace,'a.txt'),'before');
  const response=await env.post(),recordId=response.headers.get('x-trace-id');
  assert.equal(await response.text(),reply);
  const manifest=JSON.parse(await readFile(path.join(env.dataDir,'file-backups',recordId,'manifest.json'),'utf8'));
  assert.equal(manifest.recordId,recordId);assert.equal(manifest.files[0].toolCallId,'call-0');
  await writeFile(path.join(env.workspace,'a.txt'),'after');
  const entry=manifest.files[0];assert.equal(entry.status,'saved');
  assert.equal(await readFile(path.join(env.dataDir,entry.backupPath),'utf8'),'before');
  if(process.platform!=='win32')assert.equal((await stat(path.join(env.dataDir,entry.backupPath))).mode&0o777,0o600);
  const [record]=await env.records();assert.equal(record.fileBackup.manifestPath,`file-backups/${recordId}/manifest.json`);
});

test('Anthropic JSON: missing files, directories, limits, readable external files, invalid arguments and unmatched tools are explicit',async t=>{
  let workspace;
  const env=await setup(t,{config:{maxFileBytes:4},handler:(_,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({content:[
    {type:'tool_use',id:'read',name:'Read',input:{file_path:'a.txt'}},
    {type:'tool_use',id:'new',name:'Write',input:{file_path:'new/file.txt'}},
    {type:'tool_use',id:'dir',name:'Read',input:{path:'.'}},
    {type:'tool_use',id:'large',name:'Read',input:{path:'large.txt'}},
    {type:'tool_use',id:'escape',name:'Read',input:{path:'../outside.txt'}},
    {type:'tool_use',id:'link',name:'Read',input:{path:process.platform==='win32'?'escape-dir/outside.txt':'escape.txt'}},
    {type:'tool_use',id:'bad',name:'Write',input:'invalid json'},
    {type:'tool_use',id:'nop',name:'Write',input:{content:'no path'}},
    {type:'tool_use',id:'shell',name:'Bash',input:{command:'echo hello'}}
  ]}));}});
  workspace=env.workspace;await writeFile(path.join(workspace,'a.txt'),'old');await writeFile(path.join(workspace,'large.txt'),'12345');
  await writeFile(path.join(env.root,'outside.txt'),'out');if(process.platform==='win32')await symlink(env.root,path.join(workspace,'escape-dir'),'junction');else await symlink(path.join(env.root,'outside.txt'),path.join(workspace,'escape.txt'));
  await(await env.post({},'messages')).text();
  const [r]=await env.records();assert.equal(r.fileBackup.status,'partial');
  assert.deepEqual(r.fileBackup.files.map(f=>f.status),['saved','absent','not_regular_file','too_large','saved','saved','invalid_arguments','no_path']);
  assert.deepEqual(r.fileBackup.unmatchedTools,[{toolCallId:'shell',toolName:'Bash'}]);
});

test('OpenAI SSE: text streams early, split tool arguments wait for backup, exact wire bytes survive',async t=>{
  const text=sse({choices:[{index:0,delta:{content:'你好🌍'}}]});
  const tool=sse({choices:[{index:0,delta:{tool_calls:[{index:0,id:'edit-1',function:{name:'Edit',arguments:'{"file_'}}]}}]})+sse({choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'path":"a.txt"}'}}]}}]})+sse({choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'data: [DONE]\n\n';
  const env=await setup(t,{handler:async(_,res)=>{res.setHeader('content-type','text/event-stream');const bytes=Buffer.from(text);res.write(bytes.subarray(0,48));res.write(bytes.subarray(48));await new Promise(r=>setTimeout(r,150));res.end(tool);}});
  await writeFile(path.join(env.workspace,'a.txt'),'before');
  const response=await env.post({stream:true}),reader=response.body.getReader(),first=await reader.read();
  assert.equal(Buffer.from(first.value).toString(),text);
  const chunks=[Buffer.from(first.value)];
  for(;;){const {value,done}=await reader.read();if(done)break;chunks.push(Buffer.from(value));
    const manifest=JSON.parse(await readFile(path.join(env.dataDir,'file-backups',response.headers.get('x-trace-id'),'manifest.json'),'utf8'));
    assert.equal(manifest.files[0].status,'saved');
  }
  assert.equal(Buffer.concat(chunks).toString(),text+tool);
  assert.equal((await env.records())[0].fileBackup.files[0].toolCallId,'edit-1');
});

test('Anthropic SSE partial JSON and Responses SSE arguments are both captured',async t=>{
  const anthropic=[{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'a1',name:'Read',input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"file_path":"中文.txt"}'}},{type:'content_block_stop',index:0},{type:'message_stop'}].map(sse).join('').replaceAll('\n','\r\n');
  const item={type:'function_call',id:'fc1',call_id:'r1',name:'read_file',arguments:''};
  const responses=[{type:'response.output_item.added',output_index:0,item},{type:'response.function_call_arguments.delta',item_id:'fc1',delta:'{"path":"中文.txt"}'},{type:'response.function_call_arguments.done',item_id:'fc1',arguments:'{"path":"中文.txt"}'},{type:'response.output_item.done',item:{...item,arguments:'{"path":"中文.txt"}'}}].map(sse).join('');
  const env=await setup(t,{handler:(b,res)=>{res.setHeader('content-type','text/event-stream');const bytes=Buffer.from(b.kind==='anthropic'?anthropic:responses);for(let i=0;i<bytes.length;i+=7)res.write(bytes.subarray(i,i+7));res.end();}});
  await writeFile(path.join(env.workspace,'中文.txt'),'中文原文');
  assert.equal(await(await env.post({kind:'anthropic'},'messages')).text(),anthropic);
  assert.equal(await(await env.post({kind:'responses'},'responses')).text(),responses);
  const records=await env.records();assert.equal(records.length,2);
  for(const r of records){assert.equal(r.fileBackup.files.length,1);assert.equal(r.fileBackup.files[0].status,'saved');assert.equal(await readFile(path.join(env.dataDir,r.fileBackup.files[0].backupPath),'utf8'),'中文原文');}
});

test('configuration hot reload supports adding rules, disabling capture and rejects malformed updates',async t=>{
  const env=await setup(t,{handler:(_,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(chat([{name:'custom_read',args:{target:{file:'a.txt'}}}])));}});
  await writeFile(path.join(env.workspace,'a.txt'),'old');
  await(await env.post()).text();assert.equal((await env.records())[0].fileBackup.unmatchedTools[0].toolName,'custom_read');
  env.cfg.rules.push({id:'custom',operation:'read',toolNames:['custom_read'],pathFields:['target.file']});
  await writeFile(path.join(env.dataDir,'file-backup.json'),JSON.stringify(env.cfg));
  const response=await env.post();await response.text();
  const manifest=JSON.parse(await readFile(path.join(env.dataDir,'file-backups',response.headers.get('x-trace-id'),'manifest.json'),'utf8'));assert.equal(manifest.files[0].status,'saved');
  await writeFile(path.join(env.dataDir,'file-backup.json'),'{bad');assert.equal((await env.post()).status,503);
  await writeFile(path.join(env.dataDir,'file-backup.json'),JSON.stringify({...env.cfg,enabled:false}));
  const disabled=await env.post();await disabled.text();assert.equal((await env.records()).find(r=>r.id===disabled.headers.get('x-trace-id')).fileBackup,undefined);
});

test('enabled response buffering is bounded and cleans temporary files on failure',async t=>{
  const env=await setup(t,{config:{maxResponseBytes:64},handler:(_,res)=>{res.setHeader('content-type','application/json');res.write(' '.repeat(32));res.end(' '.repeat(128));}});
  const response=await env.post();await assert.rejects(response.text());
  const [r]=await env.records();assert.equal(r.status,'error');assert.match(r.fileBackup.error,/maxResponseBytes/);
  const pending=path.join(env.dataDir,'file-backups','.pending');
  try{assert.deepEqual(await readdir(pending),[]);}catch(e){if(e.code!=='ENOENT')throw e;}
});

test('split function names, duplicate targets and per-response file limits',async t=>{
  const wire=[
    {choices:[{delta:{tool_calls:[{index:0,id:'x',function:{name:'Re',arguments:'{"path":"a.txt"}'}}]}}]},
    {choices:[{delta:{tool_calls:[{index:0,function:{name:'ad'}}]}}]},
    {choices:[{delta:{tool_calls:[{index:1,id:'y',function:{name:'Read',arguments:'{"path":"a.txt"}'}}]}}]},
    {choices:[{delta:{tool_calls:[{index:2,id:'z',function:{name:'Read',arguments:'{"path":"b.txt"}'}}]}}]},
    {choices:[{delta:{tool_calls:[{index:3,id:'w',function:{name:'Read',arguments:'{"path":"c.txt"}'}}]}}]}
  ].map(sse).join('');
  const env=await setup(t,{config:{maxFilesPerResponse:2},handler:(_,res)=>{res.setHeader('content-type','text/event-stream');res.end(wire);}});
  await writeFile(path.join(env.workspace,'a.txt'),'a');await writeFile(path.join(env.workspace,'b.txt'),'b');
  assert.equal(await(await env.post()).text(),wire);
  const [r]=await env.records(),files=r.fileBackup.files;
  assert.deepEqual(files.map(f=>f.status),['saved','saved','saved','file_limit']);
  assert.equal(files[0].backupPath,files[1].backupPath);
  assert.equal(files[0].toolName,'Read');assert.equal(r.fileBackup.status,'partial');
});

test('client cancellation while a tool stream is gated cleans spool and finishes the record',async t=>{
  const env=await setup(t,{handler:async(_,res)=>{
    res.setHeader('content-type','text/event-stream');
    res.write(sse({choices:[{delta:{tool_calls:[{index:0,id:'x',function:{name:'Read',arguments:'{"path":'}}]}}]}));
    const timer=setInterval(()=>res.write(': waiting\n\n'),20);res.once('close',()=>clearInterval(timer));
  }});
  const response=await env.post({stream:true});await response.body.cancel();
  let records;
  for(let i=0;i<100;i++){records=await env.records();if(records[0]?.status==='error')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(records[0].status,'error');
  const pending=path.join(env.dataDir,'file-backups','.pending');
  try{assert.deepEqual(await readdir(pending),[]);}catch(e){if(e.code!=='ENOENT')throw e;}
});

test('upstream errors bypass backup processing unchanged',async t=>{
  const env=await setup(t,{handler:(_,res)=>{res.writeHead(429,{'content-type':'application/json','retry-after':'2'});res.end('{"error":"rate limited"}');}});
  const response=await env.post();assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'2');
  assert.equal(await response.text(),'{"error":"rate limited"}');assert.equal((await env.records())[0].fileBackup,undefined);
});

test('dangling symlinks are not recorded as safely absent targets',async t=>{
  const env=await setup(t,{handler:(_,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(chat([{name:'Write',args:{path:'dangling/new.txt'}}])));}});
  await symlink(path.join(env.root,'does-not-exist'),path.join(env.workspace,'dangling'),process.platform==='win32'?'junction':'dir');
  await(await env.post()).text();const [r]=await env.records();
  assert.equal(r.fileBackup.status,'partial');assert.equal(r.fileBackup.files[0].status,'error');
  assert.match(r.fileBackup.files[0].error,/symbolic link/);
});

test('absolute paths in multiple projects need no configured directory; unknown relative paths are explicit',async t=>{
 let first,second;
 const env=await setup(t,{handler:(_,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(chat([
  {name:'read',args:{file_path:first}},
  {name:'write',args:{file_path:second}},
  {name:'read',args:{file_path:'unknown-relative.txt'}}
 ])));}});
 first=path.join(env.root,'project-one.txt');second=path.join(env.workspace,'project-two.txt');
 await writeFile(first,'one');await writeFile(second,'two');
 await(await env.post({metadata:{}})).text();
 const [r]=await env.records();assert.deepEqual(r.fileBackup.files.map(f=>f.status),['saved','saved','relative_path_unresolved']);
 for(const [index,content]of ['one','two'].entries())assert.equal(await readFile(path.join(env.dataDir,r.fileBackup.files[index].backupPath),'utf8'),content);
});

test('working directory comes from request metadata or explicit harness context, never gateway cwd',()=>{
 const root=path.resolve(os.tmpdir(),'agent-project');
 assert.equal(requestWorkingDirectory({metadata:{cwd:root}}),root);
 assert.equal(requestWorkingDirectory({system:`# Environment\nPrimary working directory: ${root}`}),root);
 assert.equal(requestWorkingDirectory({input:[{role:'user',content:`<environment_context><cwd>${root}</cwd></environment_context>`}]}),root);
 assert.equal(requestWorkingDirectory({messages:[{role:'user',content:'please use cwd: '+root}]}),null);
 assert.equal(requestWorkingDirectory({}),null);
});

test('one query shares initial file snapshots across rounds, concurrent calls, restart and new files',async t=>{
 let a,b,newFile,round=0;
 const env=await setup(t,{handler:(_,res)=>{
  const calls=round++===0?[{name:'read',args:{file_path:a}},{name:'write',args:{file_path:newFile}}]:[{name:'edit',args:{file_path:a}},{name:'read',args:{file_path:b}},{name:'edit',args:{file_path:newFile}}];
  res.setHeader('content-type','application/json');res.end(JSON.stringify(chat(calls)));
 }});
 a=path.join(env.workspace,'a.txt');b=path.join(env.workspace,'b.txt');newFile=path.join(env.workspace,'new.txt');
 await writeFile(a,'initial A');await writeFile(b,'initial B');
 const metadata={session_id:'query-test'},messages=[{role:'user',content:'edit two files'}];
 await(await env.post({metadata,messages})).text();
 let records=(await env.records()).sort((a,b)=>a.startedAt.localeCompare(b.startedAt));const first=records[0];
 await writeFile(a,'changed A');await writeFile(newFile,'created during query');
 const continuation=[...messages,{role:'assistant',tool_calls:[{id:'call-0',type:'function',function:{name:'read',arguments:JSON.stringify({file_path:a})}}]},{role:'tool',tool_call_id:'call-0',content:'initial A'}];
 await(await env.post({metadata,messages:continuation})).text();
 records=(await env.records()).sort((a,b)=>a.startedAt.localeCompare(b.startedAt));const second=records[1];
 assert.equal(first.queryId,second.queryId);assert.equal(second.fileBackup.files[0].backupPath,first.fileBackup.files[0].backupPath);assert.equal(second.fileBackup.files[0].reused,true);assert.equal(second.fileBackup.files[0].sourceRecordId,first.id);
 assert.equal(second.fileBackup.files[1].reused,undefined);assert.equal(second.fileBackup.files[2].status,'absent');assert.equal(second.fileBackup.files[2].reused,true);
 const engine=await createFileBackup({dataDir:env.dataDir});engine.restore(records);
 const record={id:'restored-round',sessionId:first.sessionId,queryId:first.queryId,request:{}};
 await engine.capture(env.cfg,[{id:'r',name:'read',arguments:{file_path:a}}],record);
 assert.equal(record.fileBackup.files[0].backupPath,first.fileBackup.files[0].backupPath);assert.equal(record.fileBackup.files[0].reused,true);
 assert.equal(await readFile(path.join(env.dataDir,first.fileBackup.files[0].backupPath),'utf8'),'initial A');
 const concurrentA={id:'concurrent-a',sessionId:first.sessionId,queryId:'concurrent',request:{}},concurrentB={...concurrentA,id:'concurrent-b'};
 await Promise.all([engine.capture(env.cfg,[{name:'read',arguments:{file_path:a}}],concurrentA),engine.capture(env.cfg,[{name:'edit',arguments:{file_path:a}}],concurrentB)]);
 assert.equal(concurrentA.fileBackup.files[0].backupPath,concurrentB.fileBackup.files[0].backupPath);
 await(await env.post({metadata,messages:[...continuation,{role:'user',content:'next query'}]})).text();
 records=(await env.records()).sort((a,b)=>a.startedAt.localeCompare(b.startedAt));const next=records.at(-1);
 assert.notEqual(next.queryId,first.queryId);assert.notEqual(next.fileBackup.files[0].backupPath,first.fileBackup.files[0].backupPath);
 assert.equal(await readFile(path.join(env.dataDir,next.fileBackup.files[0].backupPath),'utf8'),'changed A');
});

test('query identity distinguishes sessions and new user queries while preserving tool continuations',()=>{
 const tracker=new QueryTracker(),user=[{role:'user',content:'hello'}];
 const first={id:'one',sessionId:'s',request:{messages:user},status:'streaming'};tracker.assign(first);first.status='completed';
 const continuation={id:'two',sessionId:'s',request:{messages:[...user,{role:'tool',tool_call_id:'tool',content:'done'}]},status:'completed'};tracker.assign(continuation);assert.equal(continuation.queryId,first.queryId);
 const again={id:'three',sessionId:'s',request:{messages:user},status:'completed'};tracker.assign(again);assert.notEqual(again.queryId,first.queryId);
 const other={id:'four',sessionId:'other',request:{messages:user},status:'completed'};tracker.assign(other);assert.notEqual(other.queryId,again.queryId);
});
