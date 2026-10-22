import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readdir,lstat,readFile,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {resolveTarget,isTextOnly,assertSeparate,checkedPath,jsonFile,saveJSON,sha,sampleHash} from './common.mjs';
import {restoreWorkspace} from './samples.mjs';
import {createReplayProxy} from './replay-proxy.mjs';

export async function harnessInfo(c){
 const [exe,...prefix]=c.harness.command;
 const help=await promisify(execFile)(exe,[...prefix,'--help'],{timeout:10000,maxBuffer:1024*1024});
 for(const flag of ['--restricted','--bare','--permission-prompts'])if(!help.stdout.includes(flag))throw new Error('Harness lacks required replay isolation flag '+flag);
 const version=await promisify(execFile)(exe,[...prefix,'--version'],{timeout:10000,maxBuffer:65536});return version.stdout.trim();
}

export async function listSamples(c,id){
 const dir=path.join(c.outputDir,'samples');
 if(id&&id!=='all'){if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Invalid sample ID');return [await jsonFile(await checkedPath(dir,id+'.json'))];}
 const result=[];for(const name of (await readdir(dir)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).sort())result.push(await jsonFile(await checkedPath(dir,name)));return result;
}

async function artifacts(c,sample,workspace){
 const output=[];let total=0;
 for(const f of sample.files){
  const file=path.join(workspace,f.relativePath);
  try{
   const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()){output.push({path:f.relativePath,status:'not_regular_file'});continue;}
   total+=s.size;if(total>c.maxRestoreBytes){output.push({path:f.relativePath,status:'artifact_limit'});continue;}
   const body=await readFile(file),before=f.state==='saved'?await readFile(await checkedPath(c.outputDir,f.snapshotPath)):null;
   output.push({path:f.relativePath,status:'present',size:s.size,sha256:sha(body),changed:!before||!before.equals(body),preview:body.subarray(0,4096).toString('utf8'),previewTruncated:body.length>4096});
  }catch(e){output.push({path:f.relativePath,status:e.code==='ENOENT'?'absent':'error',error:e.code==='ENOENT'?undefined:e.message});}
 }
 return output;
}

export async function replayOne(c,sample,{version}={}){
 if(!sample.eligibility?.eligible)throw new Error('Sample is ineligible: '+sample.eligibility?.issues.join(', '));
 if(!isTextOnly(sample))await assertSeparate(sample.sourceRoot,c.outputDir);
 version||=await harnessInfo(c);
 const runId=randomUUID(),runDir=path.join(c.outputDir,'runs',runId),startedAt=new Date().toISOString();
 const result={version:1,id:runId,sampleId:sample.id,sampleHash:sampleHash(sample),executionMode:sample.executionMode||'workspace',sampleKind:sample.sampleKind||'user-task',configFingerprint:c.fingerprint,harnessVersion:version,startedAt,status:'running',validity:{valid:false,scope:'model-visible-prefix-and-captured-files'}};
 let proxy,child,stdout='',stderr='',resultMessage,timedOut=false,logLimit=false;
 try{
  result.targetProtocol=resolveTarget(c.target,sample.initialRequest,sample.sourceProtocol).protocol;
  const workspace=await restoreWorkspace(c,sample,runDir);result.workspace=workspace;
  const token='replay-'+randomUUID();
  proxy=await createReplayProxy({config:c,sample,workspace,runDir,token});
  const env={};for(const k of ['PATH','HOME','USER','LOGNAME','TMPDIR','TEMP','TMP','SystemRoot','WINDIR','LANG','LC_ALL'])if(process.env[k])env[k]=process.env[k];
  Object.assign(env,{CLAUDE_CONFIG_DIR:path.join(runDir,'claude-config'),ANTHROPIC_BASE_URL:proxy.base,ANTHROPIC_API_KEY:token,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1'});
  await mkdir(env.CLAUDE_CONFIG_DIR,{recursive:true,mode:0o700});
  const [exe,...prefix]=c.harness.command;
  result.cliModel=c.harness.model||sample.initialRequest.model||'replay-local';
  const args=[...prefix,'--bare','--restricted','--disable-slash-commands','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--tools',isTextOnly(sample)?'':'Read,Write,Edit','--permission-mode','acceptEdits','--permission-prompts','none','--no-session-persistence','--output-format','stream-json','--verbose','--max-turns',String(c.harness.maxTurns),'--model',result.cliModel,'-p'];
  child=spawn(exe,args,{cwd:workspace,env,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  const terminate=()=>{if(child.exitCode!==null)return;try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid,'SIGKILL');}catch{}};
  const timer=setTimeout(()=>{timedOut=true;terminate();},c.harness.timeoutMs);
  let pending='';
  child.stdout.on('data',bytes=>{
   stdout+=bytes.toString();pending+=bytes.toString();
   if(Buffer.byteLength(stdout)>8*1024*1024){logLimit=true;terminate();return;}
   let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);try{const e=JSON.parse(line);if(e.type==='result')resultMessage=e;}catch{}}
  });
  child.stderr.on('data',bytes=>{if(Buffer.byteLength(stderr)<1024*1024)stderr+=bytes.toString();});
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  child.stdin.on('error',()=>{});child.stdin.end(sample.query);
  let exit;
  try{exit=await done;}finally{clearTimeout(timer);terminate();}
  if(pending.trim())try{const e=JSON.parse(pending);if(e.type==='result')resultMessage=e;}catch{}
  await writeFile(path.join(runDir,'harness.stdout.jsonl'),stdout.replaceAll(token,'[REDACTED]'),{mode:0o600});
  await writeFile(path.join(runDir,'harness.stderr.txt'),stderr.replaceAll(token,'[REDACTED]'),{mode:0o600});
  result.exit=exit;result.answer=resultMessage?.result||'';result.harnessResult=resultMessage||null;
  result.calls=proxy.events.map(e=>({index:e.index,targetProtocol:e.targetProtocol,status:e.status,usage:e.usage,error:e.error,modelSteps:e.modelSteps?.map(s=>({usage:s.usage,execution:s.execution}))}));
  result.validity={valid:!proxy.issues.length&&proxy.events.length>0&&exit.code===0&&!timedOut&&!logLimit&&resultMessage?.subtype==='success'&&!resultMessage?.is_error,scope:'model-visible-prefix-and-captured-files',issues:[...proxy.issues,...(timedOut?[{kind:'execution',message:'Harness timed out'}]:[]),...(logLimit?[{kind:'execution',message:'Harness output limit exceeded'}]:[])],warnings:proxy.warnings};
  if(!result.validity.valid&&!result.validity.issues.length)result.validity.issues.push({kind:'harness',message:'Harness did not finish successfully'});
  if(resultMessage?.permission_denials?.length){result.validity.valid=false;result.validity.issues.push({kind:'environment',message:'Harness denied tool permissions'});}
  result.artifacts=await artifacts(c,sample,workspace);
  if(result.artifacts.some(a=>['error','not_regular_file','artifact_limit'].includes(a.status))){result.validity.valid=false;result.validity.issues.push({kind:'environment',message:'Artifact inspection incomplete'});}
  result.status=result.validity.valid?'completed':'invalid';
 }catch(e){result.status='invalid';result.error=e.message;result.validity.issues=[...(result.validity.issues||[]),{kind:'setup',message:e.message}];}
 finally{await proxy?.close();result.finishedAt=new Date().toISOString();result.durationMs=Date.parse(result.finishedAt)-Date.parse(startedAt);await saveJSON(path.join(runDir,'run.json'),result);}
 return result;
}

export async function replay(c,id='all'){
 const samples=await listSamples(c,id),version=await harnessInfo(c),results=[];
 for(const sample of samples){if(!sample.eligibility.eligible){results.push({sampleId:sample.id,status:'skipped',issues:sample.eligibility.issues});continue;}results.push(await replayOne(c,sample,{version}));}
 return results;
}
