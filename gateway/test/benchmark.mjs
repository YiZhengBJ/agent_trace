import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createGateway} from '../server.mjs';
const dir=await mkdtemp(path.join(os.tmpdir(),'trace-bench-')),count=100,interval=2;
const upstream=http.createServer(async(req,res)=>{for await(const _ of req){}res.writeHead(200,{'content-type':'text/event-stream'});let n=0;const timer=setInterval(()=>{res.write('data: {"choices":[{"delta":{"content":"token"}}]}\n\n');if(++n===count){clearInterval(timer);res.end('data: [DONE]\n\n');}},interval);res.on('close',()=>clearInterval(timer));});
upstream.listen(0,'127.0.0.1');await once(upstream,'listening');const direct=`http://127.0.0.1:${upstream.address().port}`,app=await createGateway({port:0,dataDir:dir,seed:false});
try{
 const provider=await(await fetch(app.base+'/api/providers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Bench',url:direct})})).json(),proxied=`${app.base}/p/${provider.id}`,payload=JSON.stringify({model:'mock',stream:true,messages:[{role:'user',content:'bench'}]});
 async function run(base){const start=performance.now(),r=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:payload});let first;const reader=r.body.getReader();while(true){const {done}=await reader.read();if(done)break;if(first===undefined)first=performance.now();}const end=performance.now();return{ttfb:first-start,duration:end-start,tps:count/((end-first)/1000)};}
 await run(direct);await run(proxied);const a=[],b=[];for(let i=0;i<12;i++){if(i%2){b.push(await run(proxied));a.push(await run(direct));}else{a.push(await run(direct));b.push(await run(proxied));}}
 const median=(xs,k)=>xs.map(x=>x[k]).sort((a,b)=>a-b)[Math.floor(xs.length/2)];const report={environment:`Node ${process.version}, ${process.platform}/${process.arch}, loopback HTTP`,samplesPerPath:12,stream:{events:count,intervalMs:interval},direct:{ttfbMs:median(a,'ttfb'),durationMs:median(a,'duration'),eventsPerSecond:median(a,'tps')},gateway:{ttfbMs:median(b,'ttfb'),durationMs:median(b,'duration'),eventsPerSecond:median(b,'tps')},note:'Synthetic SSE events, not model tokens. Includes response recording. Does not establish real Provider TPS or high concurrency capacity.'};report.eventThroughputChangePercent=(report.gateway.eventsPerSecond/report.direct.eventsPerSecond-1)*100;report.addedMedianTtfbMs=report.gateway.ttfbMs-report.direct.ttfbMs;console.log(JSON.stringify(report,null,2));if(process.env.BENCH_OUTPUT)await writeFile(process.env.BENCH_OUTPUT,JSON.stringify(report,null,2)+'\n');
}finally{await app.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));await rm(dir,{recursive:true,force:true});}
