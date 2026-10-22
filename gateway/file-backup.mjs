import {constants} from 'node:fs';
import {lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import {requestMessages} from './session-matcher.mjs';

const inside=(root,file)=>{const r=path.relative(root,file);return r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};
const positive=(n,max)=>Number.isSafeInteger(n)&&n>0&&n<=max;
const keys=(value,allowed)=>Object.keys(value).every(k=>allowed.includes(k));

export function validateConfig(c) {
  if(!c||typeof c!=='object'||Array.isArray(c)||!keys(c,['version','enabled','workspaceRoot','maxFileBytes','maxFilesPerResponse','maxResponseBytes','rules']))throw new Error('Invalid file-backup configuration fields');
  if(c.version!==1||typeof c.enabled!=='boolean')throw new Error('file-backup requires version=1 and enabled boolean');
  if(!positive(c.maxFileBytes,1024**3)||!positive(c.maxFilesPerResponse,1024)||!positive(c.maxResponseBytes,128*1024**2))throw new Error('Invalid file-backup resource limits');
  if(!Array.isArray(c.rules)||c.rules.length>256)throw new Error('Invalid file-backup rules');
  const ids=new Set();
  for(const r of c.rules){
    if(!r||!keys(r,['id','operation','toolNames','namePattern','pathFields'])||typeof r.id!=='string'||!r.id||ids.has(r.id)||!['read','write'].includes(r.operation))throw new Error('Invalid or duplicate file-backup rule');
    ids.add(r.id);
    if(r.toolNames!==undefined&&(!Array.isArray(r.toolNames)||!r.toolNames.length||r.toolNames.some(n=>typeof n!=='string'||!n)))throw new Error('Invalid toolNames');
    if(r.namePattern!==undefined&&(typeof r.namePattern!=='string'||r.namePattern.length>256))throw new Error('Invalid namePattern');
    if(!r.toolNames&&!r.namePattern)throw new Error('A rule needs toolNames or namePattern');
    if(r.namePattern)new RegExp(r.namePattern);
    if(!Array.isArray(r.pathFields)||!r.pathFields.length||r.pathFields.some(p=>typeof p!=='string'||!p||p.split('.').some(k=>!k||['__proto__','constructor','prototype'].includes(k))))throw new Error('Invalid pathFields');
  }
  // Ignore the obsolete global workspace restriction when loading old settings.
  const {workspaceRoot,...current}=c;
  return current;
}

function valuesAt(value,parts){
  if(!parts.length)return Array.isArray(value)?value.flatMap(v=>valuesAt(v,[])):typeof value==='string'?[value]:[];
  if(!value||typeof value!=='object')return [];
  const [key,...rest]=parts;
  return key==='*'?Object.values(value).flatMap(v=>valuesAt(v,rest)):Object.hasOwn(value,key)?valuesAt(value[key],rest):[];
}

export function matchedPaths(c,call){
  const rules=c.rules.filter(r=>r.toolNames?.includes(call.name)||(r.namePattern&&new RegExp(r.namePattern).test(call.name)));
  let args=call.arguments;
  if(typeof args==='string'){try{args=JSON.parse(args);}catch{return {rules,invalidArguments:true,files:[]};}}
  const files=[];
  for(const r of rules)for(const field of r.pathFields)for(const value of valuesAt(args,field.split('.')))if(value&&!files.some(f=>f.path===value&&f.ruleId===r.id))files.push({path:value,ruleId:r.id,operation:r.operation});
  return {rules,files};
}

// Relative tool paths require an explicit per-request working-directory signal.
// Never resolve against the gateway process's own cwd.
function contextDirectory(value){
 const text=value.trim(),quote=text[0];
 // Punctuation belongs to the surrounding prose only when a matching quote
 // establishes where the path ends. Bare paths may legally end with a dot.
 if(!['"',"'",'`'].includes(quote))return text;
 const end=text.indexOf(quote,1);
 if(end<0||! /^[\s.,;:!?。；，！？，]*$/.test(text.slice(end+1)))return null;
 return text.slice(1,end);
}
export function requestWorkingDirectory(payload){
  const explicit=[payload?.cwd,payload?.working_directory,payload?.workingDirectory,payload?.metadata?.cwd,payload?.metadata?.working_directory,payload?.context?.cwd,payload?.environment?.cwd];
  const direct=explicit.find(value=>typeof value==='string'&&path.isAbsolute(value));if(direct)return direct;
  const textOf=value=>typeof value==='string'?value:Array.isArray(value)?value.filter(p=>p?.type==='text'||p?.type==='input_text').map(p=>p.text||'').join('\n'):'';
  const messages=payload?.messages||(Array.isArray(payload?.input)?payload.input:[]);
  const texts=[textOf(payload?.system),textOf(payload?.instructions),...messages.filter(m=>['system','developer'].includes(m.role)||/^(Current runtime context|<environment_context>|<system-reminder>|# Environment)/.test(textOf(m.content))).map(m=>textOf(m.content))];
  for(const text of texts.reverse()){
    const values=[...text.matchAll(/(?:Primary working directory|Current working directory|Working directory|cwd)\s*:\s*([^\r\n]+)/gi),...text.matchAll(/<(?:cwd|working_directory)>([^<]+)<\/(?:cwd|working_directory)>/gi)].map(m=>contextDirectory(m[1]));
    const roots=[...new Set(values.filter(v=>typeof v==='string'&&path.isAbsolute(v)))];if(roots.length===1)return roots[0];if(roots.length>1)return null;
  }
  return null;
}

export class QueryTracker{
  constructor(){this.known=new Map();this.current=new Map();this.starts=new Map();}
  assign(record){
    const messages=requestMessages(record.request);let lastUser=-1;
    for(let i=0;i<messages.length;i++)if(messages[i].role==='user'&&!messages[i].results.length)lastUser=i;
    const fingerprint=lastUser<0?null:createHash('sha256').update(JSON.stringify(messages.slice(0,lastUser+1).filter(m=>!['system','developer'].includes(m.role)))).digest('hex');
    const key=fingerprint?record.sessionId+':'+fingerprint:null;
    const signal=[...messages].reverse().find(m=>m.role==='user'||m.role==='tool');
    const userTriggered=signal?.role==='user'&&!signal.results.length;
    const prior=key?this.known.get(key):this.current.get(record.sessionId);
    const previous=this.starts.get(prior);
    // A completed standalone user request followed by the same prompt is a new
    // query; retries of a failed/in-flight root retain its original snapshot.
    record.queryId=record.queryId||((userTriggered&&previous?.status==='completed')?record.id:prior)||record.id;
    if(!this.starts.has(record.queryId))this.starts.set(record.queryId,record);
    if(key)this.known.set(key,record.queryId);
    this.current.set(record.sessionId,record.queryId);
    return record.queryId;
  }
}

export async function createFileBackup({dataDir,configPath=process.env.TRACE_FILE_BACKUP_CONFIG||path.join(dataDir,'file-backup.json')}){
  // Seed a user-editable, disabled configuration.
  try{await writeFile(configPath,await readFile(new URL('./file-backup.example.json',import.meta.url)),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
  let cached,signature;
  const queryVersions=new Map(),queryLocks=new Map();
  const queryKey=record=>record.sessionId+':'+(record.queryId||record.id);
  const versionsFor=record=>{const key=queryKey(record);if(!queryVersions.has(key))queryVersions.set(key,new Map());return queryVersions.get(key);};
  async function config(){
    const s=await stat(configPath);if(s.size>256*1024)throw new Error('file-backup configuration exceeds 256 KiB');
    const sig=`${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
    if(sig!==signature){const text=await readFile(configPath,'utf8');const c=validateConfig(JSON.parse(text));cached={...c,configHash:createHash('sha256').update(text).digest('hex')};signature=sig;}
    return cached;
  }
  await config();

  async function captureQuery(c,calls,record){
    const started=performance.now(),dir=path.join(dataDir,'file-backups',record.id);
    const requestCwd=requestWorkingDirectory(record.request);
    const store=path.join(await realpath(dataDir),'file-backups');
    const result={enabled:true,queryId:record.queryId||record.id,configHash:c.configHash,status:'complete',files:[],unmatchedTools:[]};
    const versions=versionsFor(record);let count=0;
    for(const call of calls){
      const match=matchedPaths(c,call);
      if(!match.rules.length){result.unmatchedTools.push({toolCallId:call.id,toolName:call.name});continue;}
      if(match.invalidArguments||!match.files.length){result.files.push({toolCallId:call.id,toolName:call.name,status:match.invalidArguments?'invalid_arguments':'no_path'});result.status='partial';continue;}
      for(const file of match.files){
        const entry={toolCallId:call.id,toolName:call.name,...file};result.files.push(entry);
        let source,dest,temp;
        try{
          if(file.path.includes('\0'))throw new Error('Invalid path');
          let args=call.arguments;try{if(typeof args==='string')args=JSON.parse(args);}catch{}
          const toolCwd=[args?.cwd,args?.working_directory].find(v=>typeof v==='string'&&path.isAbsolute(v));
          const cwd=toolCwd||requestCwd;
          if(!path.isAbsolute(file.path)&&!cwd){entry.status='relative_path_unresolved';entry.error='No working directory in tool arguments or request context';result.status='partial';continue;}
          const requested=path.isAbsolute(file.path)?path.resolve(file.path):path.resolve(cwd,file.path);entry.resolvedPath=requested;
          if(inside(store,requested)){entry.status='backup_storage';result.status='partial';continue;}
          if(versions.has(requested)){Object.assign(entry,versions.get(requested),{reused:true});continue;}
          let resolved;
          try{resolved=await realpath(requested);}catch(e){
            if(e.code!=='ENOENT')throw e;
            // Verify the nearest existing ancestor, including symlinked parents.
            let parent=requested;
            for(;;){
              try{if((await lstat(parent)).isSymbolicLink())throw new Error('Unresolvable symbolic link');}catch(err){if(err.code!=='ENOENT')throw err;}
              try{await realpath(parent);break;}catch(err){if(err.code!=='ENOENT')throw err;const next=path.dirname(parent);if(next===parent)throw err;parent=next;}
            }
            if(++count>c.maxFilesPerResponse){entry.status='file_limit';result.status='partial';continue;}
            entry.status='absent';entry.sourceRecordId=record.id;versions.set(requested,{status:'absent',sourceRecordId:record.id});continue;
          }
          entry.resolvedPath=resolved;
          if(inside(store,resolved)){entry.status='backup_storage';result.status='partial';continue;}
          if(versions.has(resolved)){const saved=versions.get(resolved);versions.set(requested,saved);Object.assign(entry,saved,{reused:true});continue;}
          if(++count>c.maxFilesPerResponse){entry.status='file_limit';result.status='partial';continue;}
          source=await open(resolved,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));
          const before=await source.stat();
          if(!before.isFile()){entry.status='not_regular_file';result.status='partial';continue;}
          if(before.size>c.maxFileBytes){entry.status='too_large';entry.size=before.size;result.status='partial';continue;}
          await mkdir(dir,{recursive:true,mode:0o700});
          const filename=randomUUID()+'.bin';temp=path.join(dir,filename+'.tmp');
          dest=await open(temp,'wx',0o600);
          let bytes=0;const buffer=Buffer.allocUnsafe(64*1024);
          for(;;){const {bytesRead}=await source.read(buffer,0,buffer.length,null);if(!bytesRead)break;bytes+=bytesRead;if(bytes>c.maxFileBytes)throw new Error('File grew beyond maxFileBytes');await dest.writeFile(buffer.subarray(0,bytesRead));}
          const after=await source.stat(),current=await stat(resolved);
          if(before.dev!==current.dev||before.ino!==current.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||current.mtimeMs!==after.mtimeMs)throw new Error('File changed during capture');
          await dest.close();dest=null;
          await rename(temp,path.join(dir,filename));temp=null;
          Object.assign(entry,{status:'saved',sourceRecordId:record.id,size:bytes,mode:before.mode,mtimeMs:before.mtimeMs,backupPath:path.posix.join('file-backups',record.id,filename)});
          const snapshot={status:entry.status,sourceRecordId:record.id,size:entry.size,mode:entry.mode,mtimeMs:entry.mtimeMs,backupPath:entry.backupPath};
          versions.set(resolved,snapshot);versions.set(requested,snapshot);
        }catch(e){entry.status='error';entry.error=e.message;result.status='partial';}
        finally{await source?.close().catch(()=>{});await dest?.close().catch(()=>{});if(temp)await unlink(temp).catch(()=>{});}
      }
    }
    if(result.unmatchedTools.length)result.status='partial';
    result.durationMs=Math.round((performance.now()-started)*10)/10;
    // Commit association before releasing any held tool instruction to the client.
    await mkdir(dir,{recursive:true,mode:0o700});
    await writeFile(path.join(dir,'manifest.json.tmp'),JSON.stringify({recordId:record.id,sessionId:record.sessionId,...result},null,2),{mode:0o600});
    await rename(path.join(dir,'manifest.json.tmp'),path.join(dir,'manifest.json'));
    result.manifestPath=path.posix.join('file-backups',record.id,'manifest.json');
    record.fileBackup=result;
    return result;
  }
  async function capture(c,calls,record){
    const key=queryKey(record),previous=queryLocks.get(key)||Promise.resolve();
    const pending=previous.catch(()=>{}).then(()=>captureQuery(c,calls,record));queryLocks.set(key,pending);
    try{return await pending;}finally{if(queryLocks.get(key)===pending)queryLocks.delete(key);}
  }
  function restore(records){
    for(const record of records){
      const versions=versionsFor(record),cwd=requestWorkingDirectory(record.request);
      for(const file of record.fileBackup?.files||[]){
        if(!['saved','absent'].includes(file.status)||!file.resolvedPath)continue;
        const snapshot=Object.fromEntries(['status','size','mode','mtimeMs','backupPath','sourceRecordId'].filter(k=>file[k]!==undefined).map(k=>[k,file[k]]));snapshot.sourceRecordId||=record.id;
        if(!versions.has(file.resolvedPath))versions.set(file.resolvedPath,snapshot);
        const alias=path.isAbsolute(file.path||'')?path.resolve(file.path):cwd?path.resolve(cwd,file.path||''):null;
        if(alias&&!versions.has(alias))versions.set(alias,snapshot);
      }
    }
  }
  async function update(value){
    const next=validateConfig(value);
    const text=JSON.stringify(next,null,2)+'\n';
    if(Buffer.byteLength(text)>256*1024)throw new Error('file-backup configuration exceeds 256 KiB');
    const temp=configPath+'.'+randomUUID()+'.tmp';
    try{await writeFile(temp,text,{mode:0o600,flag:'wx'});await rename(temp,configPath);}finally{await unlink(temp).catch(()=>{});}
    signature=undefined;
    return config();
  }
  return {config,capture,configPath,update,restore};
}
