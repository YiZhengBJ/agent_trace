import {pythonScript} from './python-exec.mjs';
import {normalizeSource,toolName} from './source-protocol.mjs';
import {readdir,mkdir,copyFile,chmod,stat} from 'node:fs/promises';
import path from 'node:path';
import {requestWorkingDirectory} from '../gateway/file-backup.mjs';
import {requestMessages,responseMessages} from '../gateway/session-matcher.mjs';
import {ToolCalls} from '../gateway/tool-call-capture.mjs';
import {resolveTarget,isTextOnly,assertSeparate,checkedPath,inside,jsonFile,saveJSON,sha,hashFile,textOf} from './common.mjs';

export function responseTools(record){
 const collector=new ToolCalls();let obj;
 try{obj=JSON.parse(record.response);}catch{}
 if(obj)collector.accept(obj);else for(const line of (record.response||'').split(/\r?\n/))if(line.startsWith('data:'))try{collector.accept(JSON.parse(line.slice(5)));}catch{}
 return collector.list().map(t=>record.protocol==='openai'?{...t,name:toolName(t.name)}:t);
}
function inferredQuery(r){const m=requestMessages(r.request);let i=m.length-1;while(i>=0&&(m[i].role!=='user'||m[i].results.length))i--;return sha([r.sessionId,m.slice(0,i+1)]);}
function userQuery(request){const msgs=request.messages||[];for(let i=msgs.length-1;i>=0;i--){const m=msgs[i];if(m.role==='user'&&(!Array.isArray(m.content)||m.content.some(b=>b.type!=='tool_result')))return textOf(m.content);}return '';}

export async function prepare(c){
 const dir=path.join(c.traceDataDir,'records'),names=(await readdir(dir)).filter(n=>n.endsWith('.json')).sort();
 if(names.length>c.maxRecords)throw new Error(`Found ${names.length} records, exceeding maxRecords=${c.maxRecords}; use a smaller exported data directory or raise the limit`);
 const index=[];
 for(const name of names){const file=await checkedPath(dir,name),r=await jsonFile(file);if(r.demo)continue;index.push({id:r.id,sessionId:r.sessionId,queryId:r.queryId||inferredQuery(r),inferred:!r.queryId,time:r.startedAt,file});}
 index.sort((a,b)=>(a.time||'').localeCompare(b.time||'')||String(a.id).localeCompare(String(b.id)));
 const groups=new Map();for(const r of index){const key=sha([r.sessionId,r.queryId]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
 const result=[];
 for(const [id,group]of [...groups].slice(0,c.maxSamples)){
  try{const existing=await jsonFile(path.join(c.outputDir,'samples',id+'.json'));result.push({id,eligible:existing.eligibility.eligible,issues:existing.eligibility.issues,existing:true});continue;}catch(e){if(e.code!=='ENOENT')throw e;}
  const records=[];for(const meta of group)records.push(await jsonFile(meta.file));
  const first=records[0],last=records.at(-1),issues=[],warnings=['partial_filesystem_capture'];
  const sourceRoot=c.sourceRoot||requestWorkingDirectory(first.request),query=userQuery(first.request);

  let initialRequest=first.request;
  try{const normalized=normalizeSource(first);initialRequest=normalized.request;warnings.push(...normalized.warnings);}catch(e){issues.push(e.message);}
  let targetProtocol=c.target.protocol;try{targetProtocol=resolveTarget(c.target,initialRequest,first.protocol).protocol;}catch(e){issues.push(e.message);}
  if(targetProtocol==='anthropic'&&initialRequest.messages?.some(m=>m.reasoning_content))issues.push('openai_reasoning_requires_openai_target');
  // Validate all source requests, including history added after the initial call.
  for(const r of records.slice(1))try{normalizeSource(r);}catch(e){issues.push(e.message);}
  if(!query)issues.push('missing_user_query');
  if(!Array.isArray(first.request?.messages))issues.push('missing_messages');

  if(group.some(r=>r.inferred))warnings.push('inferred_query_boundary');
  if(records.some(r=>r.status!=='completed'||r.truncated))issues.push('incomplete_source_trace');
  const tools=records.flatMap(responseTools);
  const textOnly=tools.length===0&&records.every(r=>!(r.fileBackup?.files||[]).length);
  if(!textOnly&&(!sourceRoot||!path.isAbsolute(sourceRoot)||path.parse(sourceRoot).root===sourceRoot))issues.push('missing_or_overbroad_source_root');
  if(!textOnly&&sourceRoot)await assertSeparate(sourceRoot,c.outputDir);
  if(textOnly)warnings.push('text_only_replay_tools_disabled');
  const sampleKind=/^Generate the session title\b/i.test(query)||(/^<session>[\s\S]*<\/session>/.test(query)&&/Write the title/.test(query))?'auxiliary:title':/^\[SUGGESTION MODE:/.test(query)?'auxiliary:suggestion':'user-task';
  if(tools.some(t=>!['Read','Write','Edit','Bash'].includes(t.name)))issues.push('unsupported_source_tools');
  if(responseTools(last).length)issues.push('source_turn_not_finished');
  const allContent=(first.request.messages||[]).flatMap(m=>Array.isArray(m.content)?m.content:[]);
  if(allContent.some(b=>!['text','tool_use','tool_result','thinking'].includes(b.type)))issues.push('unsupported_history_content');
  const thinking=allContent.filter(b=>b.type==='thinking');
  if(thinking.length){if(targetProtocol!=='anthropic')issues.push('thinking_requires_anthropic_target');else if(thinking.some(b=>typeof b.thinking!=='string'||typeof b.signature!=='string'||!b.signature))issues.push('invalid_thinking_history');else warnings.push('anthropic_thinking_preserved');}
  const files=new Map();let copiedBytes=0;
  for(const r of records){
   if(responseTools(r).some(t=>['Read','Write','Edit'].includes(t.name))&&!r.fileBackup)issues.push('missing_tool_backups');
   for(const f of r.fileBackup?.files||[]){
    if(!['saved','absent'].includes(f.status)){issues.push('uncaptured_file:'+f.status);continue;}
    const sourcePath=f.resolvedPath;
    if(!sourceRoot||!sourcePath||!inside(sourceRoot,sourcePath)||sourcePath===sourceRoot){issues.push('file_outside_source_root');continue;}
    if(files.has(sourcePath))continue;
    const item={sourcePath,relativePath:path.relative(sourceRoot,sourcePath),state:f.status,sourceRecordId:f.sourceRecordId||r.id};
    if(f.status==='saved'){
     try{
      if(!f.backupPath?.replaceAll('\\','/').startsWith('file-backups/'))throw new Error('Invalid backup reference');
      const src=await checkedPath(c.traceDataDir,f.backupPath),info=await stat(src);if(!info.isFile())throw new Error('Backup is not a file');copiedBytes+=info.size;if(copiedBytes>c.maxRestoreBytes)throw new Error('Evidence exceeds maxRestoreBytes');
      const dest=path.join(c.outputDir,'evidence',id,'files',sha(sourcePath)+'.bin');
      await mkdir(path.dirname(dest),{recursive:true,mode:0o700});await copyFile(src,dest);await chmod(dest,0o600);item.snapshotPath=path.relative(c.outputDir,dest);item.snapshotSha256=await hashFile(dest);
     }catch(e){issues.push('missing_backup_blob:'+e.message);continue;}
    }
    files.set(sourcePath,item);
   }
  }
  for(const tool of tools){let args;try{args=typeof tool.arguments==='string'?JSON.parse(tool.arguments):tool.arguments;}catch{issues.push('invalid_source_arguments');continue;}
   if(!['Read','Write','Edit','Bash'].includes(tool.name))continue;
   let raw=args?.file_path;
   if(tool.name==='Bash'){try{raw=pythonScript(args?.command);}catch{issues.push('unsupported_bash_command');continue;}if(args?.workdir||args?.cwd)issues.push('unsupported_bash_working_directory');}
   if(typeof raw!=='string'){issues.push('unsupported_path_schema');continue;}
   const absolute=path.isAbsolute(raw)?path.resolve(raw):sourceRoot?path.resolve(sourceRoot,raw):null;
   // Keep aliases explicit. Symlinks and ambiguous path identity are not reconstructed.
   if(!absolute||!files.has(absolute))issues.push('unresolved_tool_dependency');
  }
  const evidenceDir=path.join(c.outputDir,'evidence',id,'records');await mkdir(evidenceDir,{recursive:true,mode:0o700});
  const refs=[];for(let i=0;i<records.length;i++){const dest=path.join(evidenceDir,String(i).padStart(4,'0')+'.json');await saveJSON(dest,records[i]);refs.push(path.relative(c.outputDir,dest));}
  const sample={version:1,id,sessionId:first.sessionId,queryId:group[0].queryId,split:'unassigned',query,sourceRoot,executionMode:textOnly?'text-only':'workspace',sampleKind,requiredTools:[...new Set(tools.map(t=>t.name))],initialRequest,originalRequest:first.request,sourceProtocol:first.protocol,normalizationVersion:1,targetProtocol,referenceAnswer:responseMessages(last).map(m=>m.text).join('\n'),recordRefs:refs,files:[...files.values()],eligibility:{eligible:issues.length===0,issues:[...new Set(issues)],warnings},assertions:[],createdAt:new Date().toISOString()};
  await saveJSON(path.join(c.outputDir,'samples',id+'.json'),sample);result.push({id,eligible:sample.eligibility.eligible,issues:sample.eligibility.issues});
 }
 await saveJSON(path.join(c.outputDir,'prepare-report.json'),{createdAt:new Date().toISOString(),totalGroups:groups.size,selected:result.length,samples:result});
 return result;
}

export async function restoreWorkspace(c,sample,runDir){
 const workspace=path.join(runDir,'workspace');
 // Never create a replay underneath a source project, nor treat the source as a destination.
 if(!isTextOnly(sample)){if(!sample.sourceRoot)throw new Error('Missing source root');await assertSeparate(sample.sourceRoot,runDir);}
 await mkdir(workspace,{recursive:true,mode:0o700});let bytes=0;
 for(const f of sample.files){
  const dest=path.resolve(workspace,f.relativePath);
  if(!f.relativePath||!inside(workspace,dest)||dest===workspace||path.isAbsolute(f.relativePath))throw new Error('Invalid restore path');
  await mkdir(path.dirname(dest),{recursive:true,mode:0o700});
  if(f.state==='absent')continue;
  const src=await checkedPath(c.outputDir,f.snapshotPath),s=await stat(src);bytes+=s.size;if(bytes>c.maxRestoreBytes)throw new Error('Restore exceeds maxRestoreBytes');
  await copyFile(src,dest);await chmod(dest,0o600);
  if(f.snapshotSha256&&await hashFile(dest)!==f.snapshotSha256)throw new Error('Evidence file hash mismatch');
 }
 return workspace;
}
