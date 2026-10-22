import {pythonScript,pythonRuntime,executePython} from './python-exec.mjs';
import http from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {resolveTarget,isTextOnly,clean,inside,readBody,reply,saveJSON,sha,stable} from './common.mjs';
import {callModel,messageSSE} from './model.mjs';

export class ReplayError extends Error{constructor(kind,message){super(message);this.kind=kind;}}
const fail=(kind,msg)=>{throw new ReplayError(kind,msg);};
const safeTools=new Set(['Read','Write','Edit','Bash']);
const pythonTool={name:'Bash',description:'Run only python3 <captured-script.py> in an isolated sandbox. No flags, extra arguments or shell operators.',input_schema:{type:'object',properties:{command:{type:'string'},description:{type:'string'}},required:['command']}};
function historyKey(value){
 const normalize=v=>{
  if(Array.isArray(v))return v.map(normalize);
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,k==='content'&&Array.isArray(x)&&x.length===1&&x[0]?.type==='text'&&Object.keys(x[0]).every(n=>['type','text'].includes(n))?x[0].text:normalize(x)]));
  return v;
 };
 return stable(normalize(value));
}

function compatible(source,actual){
 const a=source.input_schema,b=actual.input_schema;
 if(a?.type!=='object'||b?.type!=='object')return false;
 const ap=a.properties||{},bp=b.properties||{};
 return Object.keys(ap).every(k=>bp[k]&&(!ap[k].type||!bp[k].type||stable(ap[k].type)===stable(bp[k].type)))&&(b.required||[]).every(k=>(a.required||[]).includes(k));
}

export async function mapToolPath(raw,{sourceRoot,workspace}){
 if(typeof raw!=='string'||!raw||raw.includes('\0')||raw.startsWith('~'))fail('environment','Unsupported tool path');
 let dest;
 if(path.isAbsolute(raw)){
  const absolute=path.resolve(raw);
  if(inside(workspace,absolute))dest=absolute;
  else if(inside(sourceRoot,absolute))dest=path.resolve(workspace,path.relative(sourceRoot,absolute));
  else fail('environment','Tool path outside source and replay roots');
 }else dest=path.resolve(workspace,raw);
 if(dest===workspace||!inside(workspace,dest))fail('environment','Tool path escapes replay workspace');
 // A fresh restored workspace contains no symlinks. Check every existing ancestor
 // again before handing a tool to the CLI; never follow a link into the source.
 let current=dest;
 for(;;){
  try{if((await lstat(current)).isSymbolicLink())fail('environment','Symlink in replay tool path');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(current===workspace)break;current=path.dirname(current);
 }
 return dest;
}

export async function createReplayProxy({config,sample,workspace,runDir,token,env=process.env}){
 const textOnly=isTextOnly(sample),target=resolveTarget(config.target,sample.initialRequest,sample.sourceProtocol);
 const root=await realpath(workspace),sourceRoot=textOnly?root:path.resolve(sample.sourceRoot),events=[],issues=[],warnings=['filesystem_capture_is_partial','fresh_harness_internal_state'];
 const captured=new Map(sample.files.map(f=>[path.resolve(root,f.relativePath),f.state]));
 const produced=new Set(),ids=new Set();
 for(const m of sample.initialRequest.messages||[])for(const b of Array.isArray(m.content)?m.content:[])if(b.type==='tool_use')ids.add(b.id);
 let baseMessages,lastMessages,busy=false,requests=0,modelCalls=0,runtime;
 if(textOnly)warnings.push('text_only_replay_tools_disabled');
 const injections=new Map();
 const controller=new AbortController();
 let base='';
 const server=http.createServer(async(req,res)=>{
  const auth=req.headers['x-api-key']||String(req.headers.authorization||'').replace(/^Bearer /,'');
  if(auth!==token)return reply(res,403,{error:{type:'authentication_error',message:'Replay token required'}});
  if(req.method!=='POST')return reply(res,405,{error:'POST required'});
  const route=new URL(req.url,'http://localhost').pathname;
  if(!['/v1/messages','/messages','/v1/messages/count_tokens'].includes(route))return reply(res,404,{error:'Replay endpoint not supported'});
  let payload;
  try{payload=JSON.parse((await readBody(req)).toString());}catch{return reply(res,400,{error:'Invalid JSON'});}
  if(route.endsWith('count_tokens'))return reply(res,200,{input_tokens:Math.ceil(JSON.stringify(payload).length/3)});
  if(busy)return reply(res,409,{error:'Parallel replay model requests are not supported'});
  busy=true;
  const event={index:requests++,startedAt:new Date().toISOString()};events.push(event);
  try{
   if(requests>config.harness.maxTurns)fail('execution','Model-call budget exceeded');
   const messages=clean(payload.messages);
   event.cliMessages=messages;
   if(!Array.isArray(messages)||!messages.length)fail('context','CLI request has no messages');
   if(!baseMessages){baseMessages=structuredClone(messages);lastMessages=structuredClone(messages);}
   else{
    if(messages.length<lastMessages.length||historyKey(messages.slice(0,lastMessages.length))!==historyKey(lastMessages))fail('context','CLI history changed or compacted; refusing to guess a continuation');
    if(messages.length===lastMessages.length)fail('context','Duplicate/retried model request requires a new replay run');
    lastMessages=structuredClone(messages);
   }
   const source=clean(sample.initialRequest),sourceTools=source.tools||[];
   event.freshTools=clean(payload.tools||[]);
   const tools=textOnly?[]:sourceTools.filter(t=>safeTools.has(t.name)&&(t.name==='Bash'||(payload.tools||[]).some(actual=>actual.name===t.name))).map(t=>t.name==='Bash'?pythonTool:t);
   if(sourceTools.length!==tools.length&&!warnings.includes('restricted_tool_subset'))warnings.push('restricted_tool_subset');
   for(const name of sample.requiredTools||[])if(!tools.some(t=>t.name===name))fail('protocol','Source-required tool is not advertised by replay CLI: '+name);
   for(const tool of tools){if(tool.name==='Bash')continue;const actual=(payload.tools||[]).find(t=>t.name===tool.name);if(!compatible(tool,actual))fail('protocol','Tool schema incompatible: '+tool.name);}
   const suffix=messages.slice(baseMessages.length),merged=[...structuredClone(source.messages)];
   for(let i=0;i<=suffix.length;i++){merged.push(...structuredClone(injections.get(i)||[]));if(i<suffix.length)merged.push(suffix[i]);}
   const canonical={...source,messages:merged,tools,stream:false};
   delete canonical.metadata;delete canonical.thinking;delete canonical.output_config;
   if(canonical.tool_choice?.name&&!tools.some(t=>t.name===canonical.tool_choice.name))fail('protocol','Source forces an unavailable tool');
   event.context={sourcePrefixHash:sha(source.messages),sourcePrefixMessages:source.messages.length,newMessages:messages.length-baseMessages.length,sourceSystemHash:sha(source.system||''),tools:tools.map(t=>t.name)};
   event.canonicalRequest=canonical;
   let result;event.modelSteps=[];
   for(;;){
    if(++modelCalls>config.harness.maxTurns)fail('execution','Model-call budget exceeded');
    result=await callModel(target,canonical,{env,signal:controller.signal});
    const step={modelRequest:result.request,usage:result.usage,rawCandidate:structuredClone(result.message)};event.modelSteps.push(step);
    const calls=result.message.content.filter(b=>b.type==='tool_use'),bash=calls.filter(b=>b.name==='Bash');
    if(!bash.length)break;
    if(bash.length!==1||calls.length!==1||!tools.some(t=>t.name==='Bash'))fail('protocol','Restricted Python must be the only tool call in a model response');
    const block=bash[0];if(Object.keys(block.input||{}).some(k=>!['command','description'].includes(k)))fail('environment','Unsupported Python execution arguments');
    let raw;try{raw=pythonScript(block.input?.command);}catch(e){fail('environment',e.message);}
    const dest=await mapToolPath(raw,{sourceRoot,workspace:root});
    if(!captured.has(dest)&&!produced.has(dest))fail('environment','Python script was not captured');
    runtime||=await pythonRuntime();
    const execution=await executePython({script:dest,workspace:root,runtime,signal:controller.signal});step.execution=execution;
    if(!warnings.includes('restricted_python_executor'))warnings.push('restricted_python_executor');
    if(!execution.valid)fail('environment','Python sandbox execution failed: '+execution.reason);
    const assistant={role:'assistant',content:structuredClone(result.message.content)};
    for(const b of assistant.content)if(b.type==='tool_use'){if(!b.id||ids.has(b.id))b.id='tool_'+randomUUID();ids.add(b.id);}
    const toolResult={role:'user',content:[{type:'tool_result',tool_use_id:assistant.content.find(b=>b.type==='tool_use').id,content:JSON.stringify({exitCode:execution.exit.code,stdout:execution.stdout,stderr:execution.stderr})}]};
    const pair=[assistant,toolResult],offset=messages.length-baseMessages.length;
    injections.set(offset,[...(injections.get(offset)||[]),...structuredClone(pair)]);canonical.messages.push(...pair);
   }
   event.targetProtocol=target.protocol;event.modelRequest=result.request;event.usage=result.usage;event.rawCandidate=result.message;
   const message=structuredClone(result.message);
   for(const block of message.content){
    if(block.type==='text'||(block.type==='thinking'&&target.protocol==='anthropic'))continue;
    if(block.type!=='tool_use'||block.name==='Bash'||!safeTools.has(block.name)||!tools.some(t=>t.name===block.name))fail('protocol','Candidate requested an unsupported tool');
    const dest=await mapToolPath(block.input?.file_path,{sourceRoot,workspace:root});
    if(!captured.has(dest)&&!produced.has(dest))fail('environment','Candidate accessed an uncaptured file: '+path.relative(root,dest));
    if(block.name==='Read'||block.name==='Edit'){
     try{if(!(await lstat(dest)).isFile())fail('environment','Tool target is not a regular file');}catch(e){if(e.code!=='ENOENT')throw e;if(captured.get(dest)!=='absent')fail('environment','Captured/produced file is missing');}
    }
    if(!block.id||ids.has(block.id))block.id='tool_'+randomUUID();ids.add(block.id);
    block.input={...block.input,file_path:dest};
    if(block.name==='Write')produced.add(dest);
   }
   event.deliveredMessage=message;event.status='completed';
   // Commit the exact injected request and transformed response before the CLI can act.
   await saveJSON(path.join(runDir,'calls',String(event.index).padStart(4,'0')+'.json'),event);
   if(payload.stream){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});res.end(messageSSE(message));}
   else reply(res,200,message);
  }catch(e){
   event.status='error';event.error={kind:e.kind||'model',message:e.message};issues.push(event.error);
   await saveJSON(path.join(runDir,'calls',String(event.index).padStart(4,'0')+'.json'),event).catch(()=>{});
   reply(res,422,{type:'error',error:{type:'invalid_request_error',message:'Replay stopped: '+e.message}});
  }finally{busy=false;}
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
 return {base,events,issues,warnings,close:async()=>{controller.abort();server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
