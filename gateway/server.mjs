import http from 'node:http';
import {SessionMatcher} from './session-matcher.mjs';
import {redact,captureSecrets} from './redaction.mjs';
import {createFileBackup,QueryTracker} from './file-backup.mjs';
import {forwardWithBackups} from './tool-call-capture.mjs';
import https from 'node:https';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, readdir, realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOP = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','host','content-length']);
const json = (res, status, value) => {res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
async function body(req, limit = 32*1024*1024) {
  const chunks=[]; let size=0;
  for await (const chunk of req) {size+=chunk.length;if(size>limit)throw Object.assign(new Error('Request body exceeds 32 MiB'),{status:413});chunks.push(chunk);}
  return Buffer.concat(chunks);
}
const parse = bytes => {try{return JSON.parse(bytes.toString());}catch{return null;}};
const userText = payload => {
  const messages=payload?.messages || payload?.input;
  if(typeof messages==='string')return messages;
  const first=Array.isArray(messages)?messages.find(x=>x.role==='user'):null;
  return typeof first?.content==='string'?first.content: first?.content?.filter(x=>x.type==='text'||x.type==='input_text').map(x=>x.text).join(' ') || 'Untitled session';
};
export async function createGateway({port=Number(process.env.PORT||4317),dataDir=process.env.DATA_DIR||path.join(ROOT,'data'),seed=process.env.TRACE_SEED_DEMO==='1'}={}) {
  await mkdir(path.join(dataDir,'records'),{recursive:true,mode:0o700});
  const fileBackup=await createFileBackup({dataDir});
  let providers=[];try{providers=JSON.parse(await readFile(path.join(dataDir,'providers.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const knownSecrets=new Set(),sessionMatcher=new SessionMatcher();
  const records=new Map(), responseSessions=new Map();
  let settings={};try{settings=JSON.parse(await readFile(path.join(dataDir,'settings.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  let pending=Promise.resolve(), diskError=null, active=0;
  function queue(fn){pending=pending.then(fn).catch(e=>{diskError=e.message;console.error('Recording error:',e.message);});return pending;}
  function saveProviders(){const snapshot=JSON.stringify(providers,null,2);return queue(async()=>{const p=path.join(dataDir,'providers.json');await writeFile(p+'.tmp',snapshot,{mode:0o600});await rename(p+'.tmp',p);});}
  async function persist(record) {
    const safe=redact(record,knownSecrets);records.set(record.id,safe);sessionMatcher.add(safe);
    const snapshot=JSON.stringify(safe);
    await queue(()=>writeFile(path.join(dataDir,'records',record.id+'.json'),snapshot,{mode:0o600}));
  }
  for(const f of await readdir(path.join(dataDir,'records'))){if(f.endsWith('.json')){try{const original=await readFile(path.join(dataDir,'records',f),'utf8');const r=redact(JSON.parse(original),knownSecrets);records.set(r.id,r);if(JSON.stringify(r)!==original){const dest=path.join(dataDir,'records',f);await writeFile(dest+'.tmp',JSON.stringify(r),{mode:0o600});await rename(dest+'.tmp',dest);}}catch(e){diskError=`Unreadable record: ${f}`;}}}
  const queryTracker=new QueryTracker();
  const chronologicalRecords=[...records.values()].sort((a,b)=>a.startedAt.localeCompare(b.startedAt));
  for(const r of chronologicalRecords){
    queryTracker.assign(r);
    sessionMatcher.add(r);
    const data=parse(Buffer.from(r.response||''));if(data?.id)responseSessions.set(`${r.providerId}:${data.id}`,r.sessionId);
    if(r.stream)for(const line of (r.response||'').split('\n'))if(line.startsWith('data: ')){const event=parse(Buffer.from(line.slice(6)));if(event?.response?.id)responseSessions.set(`${r.providerId}:${event.response.id}`,r.sessionId);}
  }
  fileBackup.restore(chronologicalRecords);
  const agents={http:new http.Agent({keepAlive:true,maxSockets:256}),https:new https.Agent({keepAlive:true,maxSockets:256})};
  let base='';
  function sessionFor(req,p,payload){
    const explicit=req.headers['x-session-id']||req.headers['x-agent-session-id']||req.headers['session_id']||req.headers['x-codex-session-id']||payload?.metadata?.session_id;
    if(explicit)return {id:`${p.id}:${String(explicit).slice(0,160)}`,method:'explicit'};
    const previous=payload?.previous_response_id;
    if(previous&&responseSessions.has(`${p.id}:${previous}`))return {id:responseSessions.get(`${p.id}:${previous}`),method:'response-chain'};
    const match=sessionMatcher.match(p.id,redact(payload,knownSecrets));
    if(match&&!match.ambiguous)return match;
    return {id:`${p.id}:${randomUUID()}`,method:match?.ambiguous?'ambiguous-context':'new-session',evidence:match?.ambiguous?{reason:'multiple-matching-sessions',candidateSessionIds:match.candidates}:{reason:'no-unambiguous-continuation'}};
  }
  async function proxy(req,res,p,suffix){
    let backupConfig;
    try{backupConfig=await fileBackup.config();}catch(e){return json(res,503,{error:'Invalid file-backup configuration: '+e.message});}
    captureSecrets(req.headers,knownSecrets);
    const started=performance.now(),bytes=await body(req),payload=parse(bytes),session=sessionFor(req,p,payload);
    const target=new URL(p.url);target.pathname=target.pathname.replace(/\/$/,'')+'/'+suffix.replace(/^\//,'');target.search=new URL(req.url,base).search;
    // /v1 in both configured base and incoming endpoint is normalized once.
    target.pathname=target.pathname.replace(/\/v1\/v1\//,'/v1/');
    const headers={};const connectionTokens=new Set(String(req.headers.connection||'').split(',').map(x=>x.trim().toLowerCase()));
    for(const[k,v]of Object.entries(req.headers))if(!HOP.has(k)&&!connectionTokens.has(k)&&!['x-session-id','x-agent-session-id','x-codex-session-id','session_id','origin','referer','cookie'].includes(k))headers[k]=v;
    headers['accept-encoding']='identity';headers['content-length']=bytes.length;
    const record={id:randomUUID(),sessionId:session.id,sessionMethod:session.method,sessionEvidence:session.evidence||null,providerId:p.id,providerName:p.name,protocol:suffix.includes('messages')?'anthropic':suffix.includes('responses')?'responses':'openai',path:suffix,model:payload?.model||'unknown',title:userText(payload).slice(0,160),startedAt:new Date().toISOString(),status:'streaming',httpStatus:null,stream:!!payload?.stream,fileBackupEnabled:backupConfig.enabled,request:payload||bytes.toString(),response:'',bytes:0,ttftMs:null,durationMs:0,truncated:false,demo:!!p.demo};
    queryTracker.assign(record);
    records.set(record.id,redact(record,knownSecrets));active++;
    await new Promise(resolve=>{
      let done=false,upstream,parts=[],size=0,guarded=false;
      const finish=(error)=>{
        if(done)return;done=true;active--;record.durationMs=Math.round((performance.now()-started)*10)/10;
        record.status=error?'error':record.httpStatus>=400?'error':'completed';if(error)record.error=error;
        record.response=Buffer.concat(parts).toString('utf8');parts=[];
        // Recording and response-chain indexing run after the forwarding loop.
        const response=parse(Buffer.from(record.response));let ids=[response?.id];
        if(record.stream)for(const line of record.response.split('\n'))if(line.startsWith('data: ')){const event=parse(Buffer.from(line.slice(6)));if(event?.response?.id)ids.push(event.response.id);}
        for(const id of ids)if(id)responseSessions.set(`${p.id}:${id}`,record.sessionId);
        void persist(record);resolve();
      };
      upstream=(target.protocol==='https:'?https:http).request(target,{method:req.method,headers,agent:agents[target.protocol.slice(0,-1)]},incoming=>{
        record.httpStatus=incoming.statusCode;const responseHeaders={};
        const tokens=new Set(String(incoming.headers.connection||'').split(',').map(x=>x.trim().toLowerCase()));
        for(const[k,v]of Object.entries(incoming.headers))if(!HOP.has(k)&&!tokens.has(k)&&k!=='set-cookie')responseHeaders[k]=v;
        res.writeHead(incoming.statusCode,{...responseHeaders,'x-trace-id':record.id,'x-trace-session-id':encodeURIComponent(record.sessionId),'x-accel-buffering':'no'});res.flushHeaders();
        const onChunk=chunk=>{
          if(record.ttftMs===null)record.ttftMs=Math.round((performance.now()-started)*10)/10;
          record.bytes+=chunk.length;
          if(!record.truncated&&size+chunk.length<=32*1024*1024){parts.push(chunk);size+=chunk.length;}else record.truncated=true;
        };
        if(backupConfig.enabled&&incoming.statusCode>=200&&incoming.statusCode<300){
          guarded=true;
          void (async()=>{
            try{
              await forwardWithBackups({incoming,res,config:backupConfig,dataDir,record,onChunk,onTools:async calls=>{
                try{await fileBackup.capture(backupConfig,calls,record);}catch(e){record.fileBackup={enabled:true,status:'error',error:e.message,configHash:backupConfig.configHash};}
                await persist(record);
              }});
              res.end();finish();
            }catch(e){record.fileBackup={...record.fileBackup,enabled:true,status:'error',error:e.message};incoming.destroy();res.destroy();finish(e.message);}
          })();
          return;
        }
        incoming.on('data',chunk=>{
          onChunk(chunk);
          if(!res.write(chunk)){incoming.pause();res.once('drain',()=>incoming.resume());}
        });
        incoming.on('end',()=>{res.end();finish();});
        incoming.on('error',e=>{res.destroy();finish(e.message);});
        incoming.on('aborted',()=>{res.destroy();finish('Upstream aborted');});
      });
      upstream.setTimeout(300_000,()=>upstream.destroy(new Error('Upstream idle timeout')));
      upstream.on('error',e=>{if(!res.headersSent)json(res,502,{error:{message:e.message,type:'gateway_error'}});else res.destroy();finish(e.message);});
      res.on('close',()=>{if(!res.writableEnded){upstream.destroy();if(!guarded)finish('Client disconnected');}});
      upstream.end(bytes);
    });
  }
  const server=http.createServer(async(req,res)=>{
    try{
      const host=req.headers.host||'';
      if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))return json(res,403,{error:'Localhost Host required'});
      if(req.headers.origin&&![base,base.replace('127.0.0.1','localhost')].includes(req.headers.origin))return json(res,403,{error:'Cross-origin requests are disabled'});
      const u=new URL(req.url,base),p=u.pathname;
      if(p.startsWith('/p/')){
        const match=p.match(/^\/p\/([^/]+)\/(.+)$/),provider=providers.find(x=>x.id===match?.[1]);
        if(!provider)return json(res,404,{error:'Provider not found'});
        if(!['POST','GET','DELETE'].includes(req.method))return json(res,405,{error:'Method not allowed'});
        return await proxy(req,res,provider,match[2]);
      }
      if(p==='/api/settings/file-backup'){
        if(!['GET','PUT'].includes(req.method))return json(res,405,{error:'Method not allowed'});
        if(req.method==='PUT'){
          const localOrigin=[base,base.replace('127.0.0.1','localhost')].includes(req.headers.origin);
          const authorized=process.env.TRACE_CONTROL_TOKEN&&req.headers['x-trace-control-token']===process.env.TRACE_CONTROL_TOKEN;
          if(!localOrigin&&!authorized)return json(res,403,{error:'Settings changes require the local console or management token'});
          if(!String(req.headers['content-type']||'').startsWith('application/json'))return json(res,415,{error:'JSON required'});
          try{await fileBackup.update(parse(await body(req)));}catch(e){return json(res,400,{error:e.message});}
        }
        const {configHash,...config}=await fileBackup.config();
        return json(res,200,{config,configPath:fileBackup.configPath,backupDirectory:path.join(dataDir,'file-backups')});
      }
      if(p==='/api/health')return json(res,200,{app:'trace-gateway',version:'0.2.0',instanceId:process.env.TRACE_INSTANCE_ID||null});
      if(p.startsWith('/api/admin/')){
        if(!process.env.TRACE_CONTROL_TOKEN||req.headers['x-trace-control-token']!==process.env.TRACE_CONTROL_TOKEN)return json(res,403,{error:'Management token required'});
        if(p==='/api/admin/shutdown'&&req.method==='POST'){json(res,200,{ok:true});setImmediate(()=>process.emit('SIGTERM'));return;}
        if(p==='/api/admin/provider/use'&&req.method==='POST'){const input=parse(await body(req));if(!providers.some(x=>x.id===input?.id))return json(res,404,{error:'Provider not found'});settings.defaultProviderId=input.id;await queue(async()=>{const dest=path.join(dataDir,'settings.json');await writeFile(dest+'.tmp',JSON.stringify(settings),{mode:0o600});await rename(dest+'.tmp',dest);});return json(res,200,settings);}
        const match=p.match(/^\/api\/admin\/provider\/([^/]+)$/);if(match&&req.method==='DELETE'){const id=match[1];if(!providers.some(x=>x.id===id))return json(res,404,{error:'Provider not found'});providers=providers.filter(x=>x.id!==id);await saveProviders();if(settings.defaultProviderId===id){delete settings.defaultProviderId;await writeFile(path.join(dataDir,'settings.json'),JSON.stringify(settings),{mode:0o600});}return json(res,200,{ok:true});}
        return json(res,404,{error:'Unknown management operation'});
      }
      if(p==='/api/state')return json(res,200,{providers:providers.map(x=>({...x,localUrl:`${base}/p/${x.id}`,openaiUrl:`${base}/p/${x.id}/v1`})),defaultProviderId:providers.some(x=>x.id===settings.defaultProviderId)?settings.defaultProviderId:providers.find(x=>!x.demo)?.id||null,sessions:redact(sessions(),knownSecrets),active,recordingError:diskError,base});
      if(p.startsWith('/api/sessions/')){
        const id=decodeURIComponent(p.slice('/api/sessions/'.length));const list=[...records.values()].filter(r=>r.sessionId===id).sort((a,b)=>a.startedAt.localeCompare(b.startedAt));
        if(u.searchParams.has('export')){res.setHeader('content-disposition','attachment; filename="session.json"');return json(res,200,redact(list,knownSecrets));}
        return json(res,200,redact(list,knownSecrets));
      }
      if(p==='/api/providers'&&req.method==='POST'){
        const data=parse(await body(req));if(!data?.name?.trim())return json(res,400,{error:'Provider name required'});
        let target;try{target=new URL(data.url);}catch{return json(res,400,{error:'Invalid Provider URL'});}
        if(!['http:','https:'].includes(target.protocol)||target.username||target.password||target.search||target.hash)return json(res,400,{error:'Use an HTTP(S) base URL without credentials, query or fragment'});
        if(target.origin===base&&target.pathname.startsWith('/p/'))return json(res,400,{error:'Proxy loop is not allowed'});
        const provider={id:randomUUID().slice(0,8),name:data.name.trim().slice(0,80),url:target.href.replace(/\/$/,''),protocol:['openai','anthropic','auto'].includes(data.protocol)?data.protocol:'auto'};
        providers.push(provider);await saveProviders();return json(res,201,provider);
      }
      if(p==='/api/demo'&&req.method==='POST'){await demo();return json(res,200,{ok:true});}
      if(p.startsWith('/internal/mock/')){
        const data=parse(await body(req));res.setHeader('content-type',data?.stream?'text/event-stream':'application/json');
        if(!data?.stream)return res.end(JSON.stringify({id:'demo-'+randomUUID(),object:'chat.completion',model:'deepseek-chat',choices:[{message:{role:'assistant',content:'代理链路已连通。请求、响应与工具调用已归档到当前 Session。'}}],usage:{prompt_tokens:126,completion_tokens:32,total_tokens:158}}));
        res.flushHeaders();for(const token of ['已检查项目结构。','\n\n网关通过原始字节流转发响应，','并将请求与工具调用记录到同一个 Session。','\n\n现在可以配置你的 Provider，开始录制真实的 Agent 轨迹。']){
          res.write(`data: ${JSON.stringify({id:'demo-stream',choices:[{delta:{content:token}}]})}\n\n`);await new Promise(r=>setTimeout(r,45));
        }res.write(`data: ${JSON.stringify({choices:[],usage:{prompt_tokens:840,completion_tokens:72,total_tokens:912}})}\n\ndata: [DONE]\n\n`);return res.end();
      }
      if(p.startsWith('/api/'))return json(res,404,{error:'Not found'});
      const assets={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};if(!assets[p])return json(res,404,{error:'Not found'});
      res.writeHead(200,{'content-type':p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html; charset=utf-8','content-security-policy':"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",'x-content-type-options':'nosniff'});res.end(await readFile(path.join(ROOT,'public',assets[p])));
    }catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.message});else res.destroy();}
  });
  function sessions(){
    const groups=new Map();for(const r of records.values()){
      let s=groups.get(r.sessionId);if(!s){s={id:r.sessionId,title:r.title,providerName:r.providerName,model:r.model,protocol:r.protocol,startedAt:r.startedAt,updatedAt:r.startedAt,count:0,durationMs:0,bytes:0,errors:0,status:r.status,demo:r.demo,sessionMethod:r.sessionMethod};groups.set(r.sessionId,s);}
      s.count++;s.durationMs+=r.durationMs;s.bytes+=r.bytes;if(r.status==='error')s.errors++;
      if(r.startedAt>=s.updatedAt){s.updatedAt=r.startedAt;s.status=r.status;s.model=r.model;}
    }return [...groups.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  }
  async function demo(){
    let p=providers.find(x=>x.demo);if(!p){p={id:'demo',name:'Local demo',url:`${base}/internal/mock`,protocol:'openai',demo:true};providers.push(p);await saveProviders();}else if(p.url!==`${base}/internal/mock`){p.url=`${base}/internal/mock`;await saveProviders();}
    const session='demo-'+randomUUID().slice(0,8);
    const messages=[{role:'user',content:'检查 agent 录制网关的项目结构，并验证流式代理是否正常。'}];
    const call=async(stream)=>{const r=await fetch(`${base}/p/demo/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer local-demo-only','x-session-id':session},body:JSON.stringify({model:'deepseek-chat',messages,stream})});await r.text();};
    await call(false);messages.push({role:'assistant',content:'先查看项目文件。',tool_calls:[{id:'call_1',type:'function',function:{name:'terminal.exec',arguments:'{"command":"ls -la"}'}}]},{role:'tool',tool_call_id:'call_1',content:'server.mjs  public/  test/  package.json'},{role:'user',content:'继续检查流式链路。'});await call(true);
  }
  server.listen(port,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
  if(seed&&records.size===0)await demo();
  return {server,base,flush:()=>pending,close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await pending;agents.http.destroy();agents.https.destroy();}};
}
// Canonicalize both sides: Windows 8.3 paths and junctions can spell the
// entry script differently from import.meta.url. A false negative exits 0
// without ever starting the listener, including when launched by the Rust CLI.
const canonicalPath=async value=>realpath(value).catch(()=>path.resolve(value));
if(process.argv[1]&&(await canonicalPath(process.argv[1]))===(await canonicalPath(fileURLToPath(import.meta.url)))){
 const app=await createGateway();console.log(`Trace Gateway running at ${app.base}`);
 let closing=false;const shutdown=()=>{if(closing)return;closing=true;app.close().then(()=>process.exit());};
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,shutdown);
 if(process.env.TRACE_PARENT_WATCH==='1'){process.stdin.resume();process.stdin.on('end',shutdown);}
}
