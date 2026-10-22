import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,stat,opendir,unlink} from 'node:fs/promises';
import {gzip,gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import path from 'node:path';
const compress=promisify(gzip),expand=promisify(gunzip);
const CHUNK=64*1024,MAX_RECORD=128*1024*1024;
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(id);
export function recordSummary(record){
 const result={};
 for(const key of ['id','sessionId','sessionMethod','sessionEvidence','providerId','providerName','protocol','path','model','title','startedAt','status','httpStatus','stream','bytes','ttftMs','durationMs','truncated','demo','error','queryId','queryFingerprint','fileBackupEnabled','revision','bodyBytes'])if(record[key]!==undefined)result[key]=record[key];
 return result;
}
export async function readRecordFile(file){
 if((await stat(file)).size>MAX_RECORD)throw new Error('Record exceeds 128 MiB safety limit');
 const record=JSON.parse(await readFile(file,'utf8'));
 if(record._traceStorage!==2)return record;
 const store=await createRecordStore(path.dirname(path.dirname(file)));
 return store.hydrate(record);
}
export async function createRecordStore(dataDir){
 const root=path.join(dataDir,'records'),chunks=path.join(dataDir,'record-chunks');
 await mkdir(root,{recursive:true,mode:0o700});await mkdir(chunks,{recursive:true,mode:0o700});
 let writtenChunks=0,reusedChunks=0;
 const chunkPath=id=>{if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Invalid record chunk reference');return path.join(chunks,id.slice(0,2),id+'.gz');};
 async function atomic(file,bytes){const temp=file+'.'+randomUUID()+'.tmp';try{await writeFile(temp,bytes,{flag:'wx',mode:0o600});await rename(temp,file);}finally{await unlink(temp).catch(()=>{});}}
 async function putChunk(bytes){
  const id=hash(bytes),file=chunkPath(id);
  try{await stat(file);reusedChunks++;return id;}catch(e){if(e.code!=='ENOENT')throw e;}
  await mkdir(path.dirname(file),{recursive:true,mode:0o700});await atomic(file,await compress(bytes,{level:1}));writtenChunks++;return id;
 }
 async function getChunk(id){
  const bytes=await expand(await readFile(chunkPath(id)),{maxOutputLength:CHUNK*4});
  if(hash(bytes)!==id)throw new Error('Record chunk checksum mismatch');return bytes;
 }
 async function putValue(value){
  const bytes=Buffer.from(JSON.stringify(value));const refs=[];
  for(let offset=0;offset<bytes.length;offset+=CHUNK)refs.push(await putChunk(bytes.subarray(offset,offset+CHUNK)));
  return {chunks:refs,bytes:bytes.length};
 }
 async function getValue(value){
  if(!value||!Array.isArray(value.chunks)||value.bytes>MAX_RECORD)throw new Error('Invalid record value descriptor');
  const buffers=[];let length=0;
  for(const ref of value.chunks){const bytes=await getChunk(ref);length+=bytes.length;if(length>MAX_RECORD)throw new Error('Expanded record exceeds safety limit');buffers.push(bytes);}
  if(length!==value.bytes)throw new Error('Record value length mismatch');return JSON.parse(Buffer.concat(buffers,length).toString('utf8'));
 }
 async function putRequest(request){
  if(!request||typeof request!=='object'||Array.isArray(request))return {value:await putValue(request)};
  const fields={};let bytes=0;
  for(const [key,value]of Object.entries(request)){
   if(Array.isArray(value)){
    const blocks=[];let block=[];
    for(const item of value){const descriptor=await putValue(item);bytes+=descriptor.bytes;block.push(descriptor);if(block.length===64){blocks.push(await putChunk(Buffer.from(JSON.stringify(block))));block=[];}}
    if(block.length)blocks.push(await putChunk(Buffer.from(JSON.stringify(block))));
    fields[key]={blocks,length:value.length};
   }else{fields[key]={value:await putValue(value)};bytes+=fields[key].value.bytes;}
  }
  return {fields,bytes};
 }
 async function getRequest(request){
  if(request.value)return getValue(request.value);
  const fields={};
  for(const [key,descriptor]of Object.entries(request.fields)){
   if(descriptor.value){Object.defineProperty(fields,key,{value:await getValue(descriptor.value),enumerable:true,writable:true});continue;}
   const items=[];for(const ref of descriptor.blocks)for(const value of JSON.parse((await getChunk(ref)).toString('utf8')))items.push(await getValue(value));
   if(items.length!==descriptor.length)throw new Error('Record array length mismatch');Object.defineProperty(fields,key,{value:items,enumerable:true,writable:true});
  }
  return fields;
 }
 async function put(record,projection){
  if(!validId(record.id))throw new Error('Invalid record ID');
  const request=await putRequest(record.request),response=await putValue(record.response||'');
  const {request:ignoredRequest,response:ignoredResponse,...metadata}=record;
  const manifest={...metadata,revision:randomUUID(),bodyBytes:(request.bytes??request.value?.bytes??0)+response.bytes,_traceStorage:2,_body:{request,response},_projection:projection||null};
  await atomic(path.join(root,record.id+'.json'),JSON.stringify(manifest));return manifest;
 }
 async function hydrate(manifest){
  if(manifest._traceStorage!==2)return manifest;
  const {_traceStorage,_body,_projection,...record}=manifest;
  record.request=await getRequest(_body.request);record.response=await getValue(_body.response);return record;
 }
 async function metadata(id){if(!validId(id))throw new Error('Invalid record ID');const file=path.join(root,id+'.json');if((await stat(file)).size>MAX_RECORD)throw new Error('Record exceeds safety limit');return JSON.parse(await readFile(file,'utf8'));}
 async function* entries(){const dir=await opendir(root);for await(const entry of dir)if(entry.isFile()&&entry.name.endsWith('.json'))yield entry.name;}
 return {put,hydrate,metadata,entries,async get(id){return hydrate(await metadata(id));},async legacy(name){const file=path.join(root,name);if((await stat(file)).size>MAX_RECORD)throw new Error('Record exceeds safety limit');return JSON.parse(await readFile(file,'utf8'));},stats:()=>({writtenChunks,reusedChunks}),root};
}
