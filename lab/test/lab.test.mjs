import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {DEFAULT_CONFIG,loadConfig,saveJSON,jsonFile,sha,sampleHash,stable} from '../common.mjs';
import {prepare,restoreWorkspace} from '../samples.mjs';
import {replayOne,harnessInfo} from '../runner.mjs';
import {createReplayProxy,mapToolPath} from '../replay-proxy.mjs';
import {verify,evaluate} from '../verifiers.mjs';
import {build,publish,route,features} from '../policy.mjs';
import {toChat,messageSSE} from '../model.mjs';

const tools=[
 {name:'Read',description:'Read',input_schema:{type:'object',properties:{file_path:{type:'string'}},required:['file_path']}},
 {name:'Write',description:'Write',input_schema:{type:'object',properties:{file_path:{type:'string'},content:{type:'string'}},required:['file_path','content']}},
 {name:'Edit',description:'Edit',input_schema:{type:'object',properties:{file_path:{type:'string'},old_string:{type:'string'},new_string:{type:'string'}},required:['file_path','old_string','new_string']}}
];
const anthropic=content=>({id:'msg-source',type:'message',role:'assistant',content,stop_reason:content.some(b=>b.type==='tool_use')?'tool_use':'end_turn',usage:{input_tokens:1,output_tokens:1}});

async function fixture(t,{modelHandler}={}){
 const root=await mkdtemp(path.join(tmpdir(),'trace-lab-')),source=path.join(root,'source'),data=path.join(root,'trace-data'),out=path.join(root,'lab-data');
 await mkdir(source);await mkdir(path.join(data,'records'),{recursive:true});await mkdir(path.join(data,'file-backups','r1'),{recursive:true});
 await writeFile(path.join(source,'note.txt'),'USER CURRENT FILE — DO NOT TOUCH');
 await writeFile(path.join(data,'file-backups','r1','before.bin'),'alpha');
 const messages=[{role:'user',content:'Remember the marker mango.'},{role:'assistant',content:'I will remember mango.'},{role:'user',content:'Read note.txt, replace alpha with beta, and report the marker.'}];
 const req={model:'cloud',system:'Source system. Working directory: '+source,messages,tools,max_tokens:4096};
 const read={type:'tool_use',id:'source-read',name:'Read',input:{file_path:path.join(source,'note.txt')}};
 const edit={type:'tool_use',id:'source-edit',name:'Edit',input:{file_path:path.join(source,'note.txt'),old_string:'alpha',new_string:'beta'}};
 const base={sessionId:'session-one',queryId:'query-one',protocol:'anthropic',status:'completed',truncated:false};
 const file={status:'saved',path:path.join(source,'note.txt'),resolvedPath:path.join(source,'note.txt'),backupPath:'file-backups/r1/before.bin',sourceRecordId:'r1'};
 const r1={...base,id:'r1',startedAt:'2026-10-22T00:00:00Z',request:req,response:JSON.stringify(anthropic([read])),fileBackup:{files:[file]}};
 const r2={...base,id:'r2',startedAt:'2026-10-22T00:00:01Z',request:{...req,messages:[...messages,{role:'assistant',content:[read]},{role:'user',content:[{type:'tool_result',tool_use_id:read.id,content:'alpha'}]}]},response:JSON.stringify(anthropic([edit])),fileBackup:{files:[{...file,reused:true}]}};
 const r3={...base,id:'r3',startedAt:'2026-10-22T00:00:02Z',request:{...req,messages:[...r2.request.messages,{role:'assistant',content:[edit]},{role:'user',content:[{type:'tool_result',tool_use_id:edit.id,content:'edited'}]}]},response:JSON.stringify(anthropic([{type:'text',text:'Done: beta. Marker mango.'}]))};
 for(const r of [r1,r2,r3])await saveJSON(path.join(data,'records',r.id+'.json'),r);
 const seen=[];
 const model=http.createServer(async(req,res)=>{
  let text='';for await(const b of req)text+=b;const body=JSON.parse(text);seen.push(body);
  let message;
  if(modelHandler)message=await modelHandler(body,seen.length);
  else if(body.messages[0].content.startsWith('Evaluate whether'))message={content:JSON.stringify({verdict:'pass',reason:'The candidate meets the task'})};
  else{
   const results=body.messages.filter(m=>m.role==='tool');
   if(!results.length)message={tool_calls:[{id:'local-read',type:'function',function:{name:'Read',arguments:JSON.stringify({file_path:path.join(source,'note.txt')})}}]};
   else if(results.length===1)message={tool_calls:[{id:'local-edit',type:'function',function:{name:'Edit',arguments:JSON.stringify({file_path:path.join(source,'note.txt'),old_string:'alpha',new_string:'beta'})}}]};
   else message={content:'Done: beta. Marker mango.'};
  }
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',...message}}],usage:{prompt_tokens:10,completion_tokens:5}}));
 });
 model.listen(0,'127.0.0.1');await once(model,'listening');
 t.after(async()=>{model.closeAllConnections();await new Promise(r=>model.close(r));await rm(root,{recursive:true,force:true});});
 const fake=path.join(root,'fake-claude.mjs');
 await writeFile(fake,`
import {readFile,writeFile} from 'node:fs/promises';
const args=process.argv.slice(2);
if(args.includes('--help')){console.log('--restricted --bare --permission-prompts');process.exit(0);}
if(args.includes('--version')){console.log('fake-claude 1');process.exit(0);}
let query='';for await(const b of process.stdin)query+=b;
const messages=[{role:'user',content:query}],tools=${JSON.stringify(tools)};
for(let i=0;i<8;i++){
 const response=await fetch(process.env.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY},body:JSON.stringify({model:'cli-model',system:'Fresh CLI system',messages,tools,stream:false})});
 const result=await response.json();if(!response.ok){console.log(JSON.stringify({type:'result',subtype:'error',is_error:true,result:result.error?.message||'proxy error'}));process.exit(1);}
 messages.push({role:'assistant',content:result.content});const calls=result.content.filter(b=>b.type==='tool_use');
 if(!calls.length){console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:result.content.map(b=>b.text||'').join('')}));process.exit(0);}
 const output=[];
 for(const call of calls){let answer;const p=call.input.file_path;
  if(call.name==='Read')answer=await readFile(p,'utf8');
  else if(call.name==='Edit'){const text=await readFile(p,'utf8');await writeFile(p,text.replace(call.input.old_string,call.input.new_string));answer='edited';}
  else{await writeFile(p,call.input.content);answer='written';}
  output.push({type:'tool_result',tool_use_id:call.id,content:answer});
 }
 messages.push({role:'user',content:output});
}
process.exit(2);
`);
 const cfg={...structuredClone(DEFAULT_CONFIG),traceDataDir:data,outputDir:out,sourceRoot:source,target:{...DEFAULT_CONFIG.target,baseURL:'http://127.0.0.1:'+model.address().port+'/v1',model:'mock-local'},harness:{...DEFAULT_CONFIG.harness,command:[process.execPath,fake]}};
 const configFile=path.join(root,'lab.json');await saveJSON(configFile,cfg);const c=await loadConfig(configFile);
 return {root,source,data,out,c,cfg,configFile,seen,records:[r1,r2,r3]};
}

test('prepare groups a whole query, keeps full prefix, deduplicates backups and preserves evidence',async t=>{
 const f=await fixture(t),report=await prepare(f.c);assert.equal(report.length,1);assert.equal(report[0].eligible,true);
 const sample=await jsonFile(path.join(f.out,'samples',report[0].id+'.json'));
 assert.deepEqual(sample.initialRequest,f.records[0].request);assert.equal(sample.recordRefs.length,3);assert.equal(sample.files.length,1);
 assert.equal(await readFile(path.join(f.out,sample.files[0].snapshotPath),'utf8'),'alpha');
 sample.split='train';await saveJSON(path.join(f.out,'samples',sample.id+'.json'),sample);await prepare(f.c);
 assert.equal((await jsonFile(path.join(f.out,'samples',sample.id+'.json'))).split,'train');
 assert.equal(await readFile(path.join(f.source,'note.txt'),'utf8'),'USER CURRENT FILE — DO NOT TOUCH');
});

test('complete replay uses source prefix on every call, executes fresh tools and leaves original files untouched',async t=>{
 const f=await fixture(t),[entry]=await prepare(f.c),file=path.join(f.out,'samples',entry.id+'.json'),sample=await jsonFile(file);
 sample.assertions=[{type:'file_equals',path:'note.txt',value:'beta'},{type:'answer_contains',value:'mango'}];await saveJSON(file,sample);
 const run=await replayOne(f.c,sample);
 assert.equal(run.status,'completed',JSON.stringify(run));assert.equal(run.calls.length,3);assert.match(run.answer,/mango/);
 assert.equal(await readFile(path.join(run.workspace,'note.txt'),'utf8'),'beta');
 assert.equal(await readFile(path.join(f.source,'note.txt'),'utf8'),'USER CURRENT FILE — DO NOT TOUCH');
 assert.equal(f.seen.length,3);
 for(const body of f.seen){assert.equal(body.messages[0].content,sample.initialRequest.system);assert.equal(body.messages.filter(m=>m.content==='Remember the marker mango.').length,1);assert.equal(body.messages.filter(m=>m.content===sample.query).length,1);}
 assert.equal(f.seen[1].messages.at(-1).content,'alpha');assert.equal(f.seen[2].messages.at(-1).content,'edited');
 const verdict=await verify(f.c,sample,run);assert.equal(verdict.verdict,'pass');assert.equal(verdict.eligibleForLearning,true);
 assert.equal((await evaluate(f.c,run.id))[0].verdict,'pass');
 const self=await verify({...f.c,verifier:{type:'llm'}},sample,run);assert.equal(self.verdict,'pass');assert.equal(self.provisional,true);
 const changed=structuredClone(sample);changed.query+=' changed';assert.equal((await verify(f.c,changed,run)).eligibleForLearning,false);
});

test('missing dependencies invalidate replay instead of generating failure labels',async t=>{
 const f=await fixture(t,{modelHandler:()=>({tool_calls:[{id:'missing',type:'function',function:{name:'Read',arguments:JSON.stringify({file_path:'not-captured.txt'})}}]})});
 const [entry]=await prepare(f.c),sample=await jsonFile(path.join(f.out,'samples',entry.id+'.json')),run=await replayOne(f.c,sample);
 assert.equal(run.status,'invalid');assert.equal(run.validity.issues[0].kind,'environment');
 const verdict=await verify(f.c,sample,run);assert.equal(verdict.verdict,'uncertain');assert.equal(verdict.eligibleForLearning,false);
});

test('out-of-root candidate paths are blocked before harness receives a tool',async t=>{
 const f=await fixture(t,{modelHandler:()=>({tool_calls:[{id:'escape',type:'function',function:{name:'Write',arguments:JSON.stringify({file_path:'/tmp/trace-lab-forbidden.txt',content:'bad'})}}]})});
 const [entry]=await prepare(f.c),sample=await jsonFile(path.join(f.out,'samples',entry.id+'.json')),run=await replayOne(f.c,sample);
 assert.equal(run.status,'invalid');assert.match(run.validity.issues[0].message,/outside/);
});

test('history compaction or mutation is rejected, and replay endpoint requires its token',async t=>{
 const f=await fixture(t),[entry]=await prepare(f.c),sample=await jsonFile(path.join(f.out,'samples',entry.id+'.json')),runDir=path.join(f.out,'runs',randomUUID()),workspace=await restoreWorkspace(f.c,sample,runDir);
 const proxy=await createReplayProxy({config:f.c,sample,workspace,runDir,token:'token'});t.after(()=>proxy.close());
 const send=(messages,key='token')=>fetch(proxy.base+'/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':key},body:JSON.stringify({messages,tools,stream:false})});
 assert.equal((await send([{role:'user',content:sample.query}],'wrong')).status,403);
 assert.equal((await send([{role:'user',content:sample.query}])).status,200);
 assert.equal((await send([{role:'user',content:'compacted summary'}])).status,422);
 assert.equal(proxy.issues[0].kind,'context');
});

test('relative traversal and symlinks cannot reach source files; output/source overlap is rejected',async t=>{
 const f=await fixture(t),[entry]=await prepare(f.c),sample=await jsonFile(path.join(f.out,'samples',entry.id+'.json')),runDir=path.join(f.out,'runs',randomUUID()),workspace=await restoreWorkspace(f.c,sample,runDir);
 await assert.rejects(mapToolPath('../escape',{sourceRoot:f.source,workspace}));
 await symlink(f.source,path.join(workspace,'link'),'dir');await assert.rejects(mapToolPath('link/note.txt',{sourceRoot:f.source,workspace}),/Symlink/);
 await assert.rejects(restoreWorkspace(f.c,sample,path.join(f.source,'bad-run')),/disjoint/);
 const alias=path.join(f.root,'alias');await symlink(f.source,alias,'dir');await assert.rejects(restoreWorkspace(f.c,sample,path.join(alias,'bad-run')),/disjoint/);
 assert.equal((await readdir(f.source)).includes('bad-run'),false);
});

test('incomplete capture and unsupported harness tool paths stay in evidence but are ineligible',async t=>{
 const f=await fixture(t);f.records[0].fileBackup.files[0].status='too_large';f.records[1].fileBackup.files=[];
 for(const r of f.records)await saveJSON(path.join(f.data,'records',r.id+'.json'),r);
 const [entry]=await prepare(f.c);assert.equal(entry.eligible,false);assert.ok(entry.issues.includes('unresolved_tool_dependency'));
});

test('basic verifier is uncertain without criteria and custom verifier remains pluggable',async t=>{
 const f=await fixture(t),[entry]=await prepare(f.c),sample=await jsonFile(path.join(f.out,'samples',entry.id+'.json')),run=await replayOne(f.c,sample);
 assert.equal((await verify(f.c,sample,run)).verdict,'uncertain');
 const module=path.join(f.root,'custom-verifier.mjs');await writeFile(module,'export async function verify(){return {verdict:"pass",evidence:["custom check"]}}');
 const result=await verify({...f.c,verifier:{type:'module',module}},sample,run);assert.equal(result.verdict,'pass');assert.equal(result.eligibleForLearning,true);
 const broken=await verify({...f.c,verifier:{type:'module',module:'missing.mjs'}},sample,run);assert.equal(broken.verdict,'uncertain');
});

test('policy packages require disjoint calibration evidence; source representation excludes future outputs',async t=>{
 const f=await fixture(t);await mkdir(path.join(f.out,'evaluations'),{recursive:true});
 const examples=[['train','pass','summarize mango memo'],['train','fail','prove mathematical theorem'],['calibration','pass','summarize mango memo'],['calibration','pass','summarize mango memo'],['calibration','fail','prove mathematical theorem']];
 for(const [i,[split,verdict,text]]of examples.entries()){
  const id=sha('sample'+i),runId=randomUUID(),sample={id,sessionId:'session'+i,split,initialRequest:{messages:[{role:'user',content:text}]}};
  await saveJSON(path.join(f.out,'samples',id+'.json'),sample);
  await saveJSON(path.join(f.out,'runs',runId,'run.json'),{id:runId,validity:{valid:true},sampleHash:sampleHash(sample)});
  await saveJSON(path.join(f.out,'evaluations',runId+'.json'),{runId,sampleId:id,sampleHash:sampleHash(sample),configFingerprint:f.c.fingerprint,eligibleForLearning:true,verdict,harnessVersion:'fake-claude 1',verifier:{type:'basic',version:1},createdAt:new Date().toISOString()});
 }
 const p=await build(f.c);assert.equal(p.validation.passed,true);assert.equal(p.cases.length,2);
 assert.equal(route(p,{initialRequest:{messages:[{role:'user',content:'prove mathematical theorem'}]}}).backend,'cloud');
 const published=await publish(f.c,p.id);assert.equal(published.activatedOnline,false);
 const sample={initialRequest:{messages:[{role:'user',content:'query'}]},referenceAnswer:'future answer'};
 assert.deepEqual(features(sample),features({...sample,referenceAnswer:'different future'}));
 const policyFile=path.join(f.out,'policies',p.id+'.json');const changed=await jsonFile(policyFile);changed.threshold=0;await saveJSON(policyFile,changed);await assert.rejects(publish(f.c,p.id),/hash/);
});

test('empty or unassigned evidence produces an unpublished candidate, not an active policy',async t=>{
 const f=await fixture(t);await mkdir(path.join(f.out,'evaluations'),{recursive:true});const p=await build(f.c);
 assert.equal(p.validation.passed,false);await assert.rejects(publish(f.c,p.id),/calibration/);
});

test('protocol conversion preserves tool IDs and emits executable SSE envelopes',()=>{
 const b={system:'s',messages:[{role:'assistant',content:[{type:'tool_use',id:'t1',name:'Read',input:{file_path:'a'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'t1',content:'data'}]}],tools};
 const chat=toChat(b);assert.equal(chat.messages[1].tool_calls[0].id,'t1');assert.equal(chat.messages[2].tool_call_id,'t1');
 const wire=messageSSE(anthropic([{type:'tool_use',id:'t1',name:'Read',input:{file_path:'a'}}]));assert.match(wire,/input_json_delta/);assert.match(wire,/message_stop/);
});

test('real Claude CLI executes file tools with injected history against a mock local model', {skip:!process.env.TRACE_LAB_CLAUDE_BIN,timeout:60000},async t=>{
 const f=await fixture(t),[entry]=await prepare(f.c),sample=await jsonFile(path.join(f.out,'samples',entry.id+'.json'));
 const c={...f.c,harness:{...f.c.harness,command:[process.env.TRACE_LAB_CLAUDE_BIN],timeoutMs:45000}};
 const run=await replayOne(c,sample);
 assert.equal(run.status,'completed',JSON.stringify(run));
 assert.equal(await readFile(path.join(run.workspace,'note.txt'),'utf8'),'beta');
 assert.equal(await readFile(path.join(f.source,'note.txt'),'utf8'),'USER CURRENT FILE — DO NOT TOUCH');
 assert.match(run.answer,/mango/);assert.equal(run.calls.length,3);
});

test('OpenAI source query with historical tool results replays Read/Edit in isolation',async t=>{
 const f=await fixture(t);
 const {toChat}=await import('../model.mjs');
 for(const original of f.records){
  const converted=toChat(original.request);const r={...original,protocol:'openai',request:{...converted,model:'cloud-openai',max_tokens:4096}};
  r.request.tools=r.request.tools.map(t=>({...t,function:{...t.function,name:t.function.name.toLowerCase()}}));
  r.request.messages=r.request.messages.map(m=>({...m,...(m.tool_calls?{tool_calls:m.tool_calls.map(t=>({...t,function:{...t.function,name:t.function.name.toLowerCase()}}))}:{})}));
  const response=JSON.parse(original.response);const chat=toChat({messages:[{role:'assistant',content:response.content}]});
  r.response=JSON.stringify({choices:[{message:chat.messages[0]}]});
  const message=JSON.parse(r.response).choices[0].message;
  for(const tool of message.tool_calls||[])tool.function.name=tool.function.name.toLowerCase();
  r.response=JSON.stringify({choices:[{message}]});await saveJSON(path.join(f.data,'records',r.id+'.json'),r);
 }
 const report=await prepare(f.c);assert.equal(report[0].eligible,true,JSON.stringify(report));
 const sample=await jsonFile(path.join(f.out,'samples',report[0].id+'.json'));assert.equal(sample.sourceProtocol,'openai');assert.equal(sample.originalRequest.messages[0].role,'system');assert.equal(sample.initialRequest.tools[0].name,'Read');assert.ok(sample.eligibility.warnings.includes('openai_chat_to_anthropic_history'));
 const run=await replayOne(f.c,sample);assert.equal(run.status,'completed',JSON.stringify(run));assert.equal(run.validity.valid,true);assert.equal(run.answer,'Done: beta. Marker mango.');assert.equal(await readFile(path.join(f.source,'note.txt'),'utf8'),'USER CURRENT FILE — DO NOT TOUCH');assert.equal(await readFile(path.join(run.workspace,'note.txt'),'utf8'),'beta');
 assert.equal(f.seen[0].messages[0].content,sample.initialRequest.system.map(b=>b.text).join('\n'));assert.equal(f.seen[0].messages.filter(m=>m.content===sample.query).length,1);
});

test('OpenAI normalization preserves tool IDs, developer text and rejects missing or rich history',async()=>{
 const {normalizeSource}=await import('../source-protocol.mjs');
 const record={protocol:'openai',request:{model:'source',messages:[{role:'developer',content:'rules'},{role:'user',content:'task'},{role:'assistant',content:null,tool_calls:[{id:'call1',type:'function',function:{name:'read',arguments:'{"file_path":"a"}'}}]},{role:'tool',tool_call_id:'call1',content:'data'},{role:'user',content:'next'}],tools:[]}};
 const n=normalizeSource(record);assert.equal(n.request.system[0].text,'rules');assert.equal(n.request.messages[1].content[0].id,'call1');assert.equal(n.request.messages[2].content[0].tool_use_id,'call1');assert.equal(n.request.messages[3].content[0].text,'next');assert.equal(record.request.messages[1].content,'task');
 const missing=structuredClone(record);missing.request.messages.splice(3,1);assert.throws(()=>normalizeSource(missing),/incomplete/);
 const image=structuredClone(record);image.request.messages[1].content=[{type:'image_url',image_url:{url:'data:x'}}];assert.throws(()=>normalizeSource(image),/unsupported_openai_content/);
 const reasoning=structuredClone(record);reasoning.request.messages[2].reasoning_content='hidden';assert.equal(toChat(normalizeSource(reasoning).request).messages[2].reasoning_content,'hidden');
 const orphan=structuredClone(record);orphan.request.messages[3].tool_call_id='other';assert.throws(()=>normalizeSource(orphan),/unmatched_tool_result/);
 assert.throws(()=>normalizeSource({protocol:'responses',request:{input:'task'}}),/unsupported_source_protocol/);
});

test('captured Python command runs inside replay proxy and its result reaches the next model turn',{skip:process.platform!=='darwin'},async t=>{
 const {rm}=await import('node:fs/promises');
 const f=await fixture(t,{modelHandler:(body,index)=>index===1?{tool_calls:[{id:'python-local',type:'function',function:{name:'Bash',arguments:JSON.stringify({command:'python3 '+body.messages.find(m=>m.role==='user').content})}}]}:index===2?{tool_calls:[{id:'read-after-python',type:'function',function:{name:'Read',arguments:JSON.stringify({file_path:body.messages.find(m=>m.role==='user').content})}}]}:{content:'Python completed'}});
 const script=path.join(f.source,'hello.py');await writeFile(script,'ORIGINAL FILE');await writeFile(path.join(f.data,'file-backups/r1/before.bin'),'print("hello sandbox")');
 const base=f.records[0],bash={name:'Bash',description:'Run shell',input_schema:{type:'object',properties:{command:{type:'string'}},required:['command']}};
 const request={...base.request,messages:[{role:'user',content:script}],tools:[...tools,bash]};
 const source={...base,request,response:JSON.stringify(anthropic([{type:'tool_use',id:'source-python',name:'Bash',input:{command:'python3 '+script}}])),fileBackup:{files:[{...base.fileBackup.files[0],resolvedPath:script,path:script}]}};
 const final={...f.records[1],request,response:JSON.stringify(anthropic([{type:'text',text:'done'}])),fileBackup:undefined};
 await saveJSON(path.join(f.data,'records/r1.json'),source);await saveJSON(path.join(f.data,'records/r2.json'),final);await rm(path.join(f.data,'records/r3.json'));
 const report=await prepare(f.c);assert.equal(report[0].eligible,true,JSON.stringify(report));const sample=await jsonFile(path.join(f.out,'samples',report[0].id+'.json'));
 if(process.env.TRACE_LAB_CLAUDE_BIN)f.c.harness.command=[process.env.TRACE_LAB_CLAUDE_BIN];
 const run=await replayOne(f.c,sample);assert.equal(run.status,'completed',JSON.stringify(run));assert.equal(run.answer,'Python completed');assert.equal(f.seen.length,3);assert.equal(f.seen[2].messages.filter(m=>m.role==='tool').length,2);assert.match(f.seen[1].messages.find(m=>m.role==='tool').content,/hello sandbox/);assert.equal(await readFile(script,'utf8'),'ORIGINAL FILE');assert.equal(run.calls[0].modelSteps[0].execution.valid,true);
});

test('title generation without a source directory replays with no tool access',async t=>{
 const f=await fixture(t,{modelHandler:body=>{assert.equal(body.tools,undefined);return {content:'会话标题'};}});
 for(const r of f.records){r.request={model:'cloud',messages:[{role:'user',content:'<session>\n你是谁\n</session>\nWrite the title in the predominant language.'}]};r.response=JSON.stringify(anthropic([{type:'text',text:'title'}]));delete r.fileBackup;await saveJSON(path.join(f.data,'records',r.id+'.json'),r);}
 f.c.sourceRoot=null;
 const report=await prepare(f.c);assert.equal(report[0].eligible,true,JSON.stringify(report));const sample=await jsonFile(path.join(f.out,'samples',report[0].id+'.json'));
 assert.equal(sample.sourceRoot,null);assert.equal(sample.executionMode,'text-only');assert.equal(sample.sampleKind,'auxiliary:title');assert.equal(sample.files.length,0);
 if(process.env.TRACE_LAB_CLAUDE_BIN)f.c.harness.command=[process.env.TRACE_LAB_CLAUDE_BIN];
 const run=await replayOne(f.c,sample);assert.equal(run.status,'completed',JSON.stringify(run));assert.equal(run.answer,'会话标题');assert.equal(run.executionMode,'text-only');assert.equal(run.sampleKind,'auxiliary:title');
});

test('missing source directory still excludes file tasks; text-only rejects candidate tool calls',async t=>{
 const f=await fixture(t,{modelHandler:()=>({tool_calls:[{id:'unexpected-read',type:'function',function:{name:'Read',arguments:'{"file_path":"note.txt"}'}}]})});
 const report=await prepare(f.c);const sample=await jsonFile(path.join(f.out,'samples',report[0].id+'.json'));
 sample.sourceRoot=null;sample.files=[];sample.requiredTools=[];sample.executionMode='text-only';
 const run=await replayOne(f.c,sample);assert.equal(run.status,'invalid');assert.ok(run.validity.issues.some(i=>/unsupported tool/.test(i.message)));
 for(const r of f.records){delete r.request.system;await saveJSON(path.join(f.data,'records',r.id+'.json'),r);}
 f.c.sourceRoot=null;f.c.outputDir=path.join(f.root,'missing-cwd-results');const invalid=await prepare(f.c);assert.ok(invalid[0].issues.includes('missing_or_overbroad_source_root'));
});

test('Anthropic thinking history and signatures are preserved; OpenAI target cannot silently drop them',async t=>{
 const f=await fixture(t),thinking={type:'thinking',thinking:'Historical reasoning.',signature:'historical-signature'};
 for(const r of f.records){r.request.messages[1]={role:'assistant',content:[thinking,{type:'text',text:'I will remember mango.'}]};await saveJSON(path.join(f.data,'records',r.id+'.json'),r);}
 let report=await prepare(f.c);assert.ok(report[0].issues.includes('thinking_requires_anthropic_target'));
 const {callModel,messageSSE}=await import('../model.mjs');let received;
 const server=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;received=JSON.parse(raw);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(anthropic([{type:'thinking',thinking:'New reasoning.',signature:'new-signature'},{type:'text',text:'Done'}])));});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 f.c.target={...f.c.target,protocol:'anthropic',baseURL:'http://127.0.0.1:'+server.address().port+'/v1'};f.c.outputDir=path.join(f.root,'anthropic-results');report=await prepare(f.c);assert.equal(report[0].eligible,true,JSON.stringify(report));
 const sample=await jsonFile(path.join(f.c.outputDir,'samples',report[0].id+'.json'));assert.deepEqual(sample.initialRequest.messages[1].content[0],thinking);
 const result=await callModel(f.c.target,sample.initialRequest);assert.deepEqual(received.messages[1].content[0],thinking);assert.match(messageSSE(result.message),/thinking_delta/);assert.match(messageSSE(result.message),/signature_delta/);
 await assert.rejects(callModel({...f.c.target,protocol:'openai'},sample.initialRequest),/refusing to drop/);
 const {rm}=await import('node:fs/promises');
 // End-to-end response thinking blocks are consumed by the real CLI when enabled.
 for(const r of f.records){r.response=JSON.stringify(anthropic([{type:'text',text:'Done'}]));delete r.fileBackup;r.request.tools=[];await saveJSON(path.join(f.data,'records',r.id+'.json'),r);}
 f.c.outputDir=path.join(f.root,'thinking-pipeline');report=await prepare(f.c);const pure=await jsonFile(path.join(f.c.outputDir,'samples',report[0].id+'.json'));
 if(process.env.TRACE_LAB_CLAUDE_BIN)f.c.harness.command=[process.env.TRACE_LAB_CLAUDE_BIN];
 // Fake harness has no thinking SSE logic, but forwards non-stream blocks verbatim.
 f.c.target.protocol='auto';
 const run=await replayOne(f.c,pure);assert.equal(run.status,'completed',JSON.stringify(run));assert.equal(run.targetProtocol,'anthropic');assert.deepEqual(received.messages[1].content[0],thinking);
});

test('auto protocol selects by history, preserves manual selection and rejects mixed reasoning',async()=>{
 const {resolveTarget}=await import('../common.mjs');const target={protocol:'auto',model:'same-model',baseURL:'http://localhost/v1'};
 const thinking={messages:[{role:'assistant',content:[{type:'thinking',thinking:'why',signature:'signed'}]}]},reasoning={messages:[{role:'assistant',reasoning_content:'why',content:'answer'}]};
 assert.equal(resolveTarget(target,thinking,'openai').protocol,'anthropic');assert.equal(resolveTarget(target,reasoning,'anthropic').protocol,'openai');assert.equal(resolveTarget(target,{messages:[]},'anthropic').protocol,'anthropic');assert.equal(resolveTarget(target,{messages:[]},'openai').protocol,'openai');assert.equal(resolveTarget({...target,protocol:'openai'},thinking).protocol,'openai');
 assert.throws(()=>resolveTarget(target,{messages:[...thinking.messages,...reasoning.messages]}),/mixed_protocol_reasoning_history/);assert.equal(target.protocol,'auto');
});

test('one auto target calls both native endpoints with correct headers and history',async t=>{
 const {callModel}=await import('../model.mjs');const seen=[];
 const server=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);seen.push({url:req.url,headers:req.headers,body});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(req.url.endsWith('/messages')?anthropic([{type:'text',text:'Anthropic reply'}]):{choices:[{message:{content:'OpenAI reply'}}]}));});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const target={...DEFAULT_CONFIG.target,protocol:'auto',model:'test',baseURL:'http://127.0.0.1:'+server.address().port+'/v1'},thinking={role:'assistant',content:[{type:'thinking',thinking:'history',signature:'original-signature'},{type:'text',text:'prior'}]},reasoning={role:'assistant',content:'prior',reasoning_content:'openai reasoning'};
 let r=await callModel(target,{messages:[{role:'user',content:'first'},thinking,{role:'user',content:'next'}]},{env:{LOCAL_LLM_API_KEY:'test-key'}});assert.equal(r.protocol,'anthropic');assert.equal(seen[0].url,'/v1/messages');assert.equal(seen[0].headers['x-api-key'],'test-key');assert.deepEqual(seen[0].body.messages[1],thinking);
 r=await callModel(target,{messages:[{role:'user',content:'first'},reasoning,{role:'user',content:'next'}]},{env:{LOCAL_LLM_API_KEY:'test-key'}});assert.equal(r.protocol,'openai');assert.equal(seen[1].url,'/v1/chat/completions');assert.equal(seen[1].headers.authorization,'Bearer test-key');assert.equal(seen[1].body.messages[1].reasoning_content,'openai reasoning');
});

test('auto protocol is pinned and recorded throughout OpenAI-source replay',async t=>{
 const f=await fixture(t);f.c.target.protocol='auto';const report=await prepare(f.c),sample=await jsonFile(path.join(f.out,'samples',report[0].id+'.json'));
 // Force the OpenAI-native history path; no thinking is present.
 sample.sourceProtocol='openai';const run=await replayOne(f.c,sample);assert.equal(run.status,'completed',JSON.stringify(run));assert.equal(run.targetProtocol,'openai');assert.ok(run.calls.every(c=>c.targetProtocol==='openai'));
});


test('LLM verifier receives the source system instructions and reports its version',async t=>{
 const f=await fixture(t,{modelHandler:body=>{const input=JSON.parse(body.messages[1].content);assert.equal(input.system,'Critical source system rule');assert.equal(input.query,'task');return {content:JSON.stringify({verdict:'pass',reason:'Source system supplied'})};}});
 const sample={id:'sample',initialRequest:{system:'Critical source system rule',messages:[{role:'user',content:'task'}]},query:'task',assertions:[]};const run={id:'run',sampleId:'sample',sampleHash:sampleHash(sample),configFingerprint:f.c.fingerprint,harnessVersion:'test',validity:{valid:true},answer:'answer',artifacts:[]};
 const result=await verify({...f.c,verifier:{type:'llm'}},sample,run);assert.equal(result.verdict,'pass');assert.equal(result.provisional,true);assert.equal(result.verifier.version,2);
});
