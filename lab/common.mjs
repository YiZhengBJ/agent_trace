import {mkdir,readFile,writeFile,rename,realpath,stat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import path from 'node:path';

export const sha=value=>createHash('sha256').update(Buffer.isBuffer(value)||typeof value==='string'?value:stable(value)).digest('hex');
export const sampleHash=sample=>{const {split,...evidence}=sample;return sha(evidence);};
export async function hashFile(file){const h=createHash('sha256');for await(const chunk of createReadStream(file,{highWaterMark:64*1024}))h.update(chunk);return h.digest('hex');}
export function stable(value){return JSON.stringify(sort(value));}
function sort(v){if(Array.isArray(v))return v.map(sort);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])]));return v;}
export const inside=(root,p)=>{const r=path.relative(root,p);return r===''||(!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep));};
export const textOf=c=>typeof c==='string'?c:Array.isArray(c)?c.filter(b=>b?.type==='text').map(b=>b.text||'').join('\n'):'';
export const clean=v=>Array.isArray(v)?v.map(clean):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k])=>k!=='cache_control').map(([k,v])=>[k,clean(v)])):v;
export async function jsonFile(file,max=32*1024*1024){if((await stat(file)).size>max)throw new Error('JSON exceeds size limit: '+file);return JSON.parse(await readFile(file,'utf8'));}
export async function saveJSON(file,data){await mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(tmp,file);}
export async function checkedPath(root,relative){if(typeof relative!=='string'||path.isAbsolute(relative))throw new Error('Expected a relative artifact path');const base=await realpath(root),p=await realpath(path.resolve(base,relative));if(!inside(base,p))throw new Error('Artifact escapes its storage root');return p;}
export async function resolvedDestination(file){let current=path.resolve(file),tail=[];for(;;){try{return path.join(await realpath(current),...tail);}catch(e){if(e.code!=='ENOENT')throw e;const parent=path.dirname(current);if(parent===current)throw e;tail.unshift(path.basename(current));current=parent;}}}
export async function assertSeparate(source,destination){const a=await resolvedDestination(source),b=await resolvedDestination(destination);if(inside(a,b)||inside(b,a))throw new Error('Source project and lab output must be disjoint');}
export async function readBody(req,max=32*1024*1024){let n=0;const chunks=[];for await(const c of req){n+=c.length;if(n>max)throw new Error('HTTP body exceeds limit');chunks.push(c);}return Buffer.concat(chunks);}
export function reply(res,status,obj){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(obj));}
export function localURL(value){const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error('Invalid model URL');return u;}
export function endpoint(base,suffix){const u=localURL(base);u.pathname=u.pathname.replace(/\/$/,'')+'/'+suffix.replace(/^\//,'');u.pathname=u.pathname.replace(/\/v1\/v1\//,'/v1/');return u.href;}

export const DEFAULT_CONFIG={version:1,traceDataDir:'',outputDir:'./lab-data',sourceRoot:null,maxRecords:1000,maxSamples:100,maxRestoreBytes:67108864,target:{protocol:'openai',baseURL:'http://127.0.0.1:18080/v1',model:'CHANGE_ME',apiKeyEnv:'LOCAL_LLM_API_KEY',maxTokens:4096,timeoutMs:120000},harness:{command:['claude'],maxTurns:12,timeoutMs:300000},verifier:{type:'basic'},policy:{minSimilarity:0.85,margin:0.1,minCalibrationLocal:2,maxFalseLocalRate:0.05}};
export async function loadConfig(file){
 const c=await jsonFile(file,256*1024),root=path.dirname(path.resolve(file));
 if(c.version!==1||!c.target||!['auto','openai','anthropic'].includes(c.target.protocol)||!c.harness||!Array.isArray(c.harness.command)||!c.harness.command.length||c.harness.command.some(x=>typeof x!=='string'||!x)||!['basic','llm','module'].includes(c.verifier?.type))throw new Error('Invalid lab configuration');
 for(const key of ['traceDataDir','outputDir'])if(typeof c[key]!=='string'||!c[key])throw new Error(key+' is required');else c[key]=path.resolve(root,c[key]);
 if(c.sourceRoot)c.sourceRoot=path.resolve(root,c.sourceRoot);
 for(const [key,max]of [['maxRecords',100000],['maxSamples',10000],['maxRestoreBytes',1024**3]])if(!Number.isSafeInteger(c[key])||c[key]<=0||c[key]>max)throw new Error('Invalid '+key);
 for(const [v,max]of [[c.target.maxTokens,65536],[c.target.timeoutMs,3600000],[c.harness.maxTurns,100],[c.harness.timeoutMs,3600000]])if(!Number.isSafeInteger(v)||v<=0||v>max)throw new Error('Invalid execution limit');
 localURL(c.target.baseURL);
 if(!c.target.model||c.target.model==='CHANGE_ME')throw new Error('Set target.model before running the lab');
 if(typeof c.target.apiKeyEnv!=='string')throw new Error('target.apiKeyEnv must name an environment variable');
 c.configFile=path.resolve(file);
 c.fingerprint=sha({target:{protocol:c.target.protocol,model:c.target.model,deploymentId:c.target.deploymentId||null,maxTokens:c.target.maxTokens},harness:c.harness,tools:['Read','Write','Edit','Bash:python3-captured-script'],engine:'trace-lab-v1',sourceNormalization:1,textOnlyReplay:1,anthropicThinking:1,protocolSelection:1});
 return c;
}

export const isTextOnly=sample=>sample.executionMode==='text-only'&&Array.isArray(sample.files)&&sample.files.length===0&&Array.isArray(sample.requiredTools)&&sample.requiredTools.length===0;

export function resolveTarget(target,request={},sourceProtocol){
 const messages=request.messages||[];
 const thinking=messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>['thinking','redacted_thinking'].includes(b.type)));
 const reasoning=messages.some(m=>typeof m.reasoning_content==='string'&&m.reasoning_content.length);
 if(thinking&&reasoning)throw new Error('mixed_protocol_reasoning_history');
 if(!['auto','openai','anthropic'].includes(target.protocol))throw new Error('Invalid target protocol');
 const protocol=target.protocol==='auto'?(thinking?'anthropic':reasoning?'openai':['openai','anthropic'].includes(sourceProtocol)?sourceProtocol:'openai'):target.protocol;
 return {...target,protocol};
}
