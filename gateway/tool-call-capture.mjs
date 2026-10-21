import {mkdir, open, unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

const parse=text=>{try{return JSON.parse(text);}catch{return null;}};

// Only structured protocol fields are interpreted; text and shell commands are never executed.
export class ToolCalls {
  constructor(){this.calls=new Map();this.argumentBytes=0;}
  put(key,value,append=false){
    let call=this.calls.get(key);
    if(!call){if(this.calls.size>=256)throw new Error('Too many tool calls');call={id:value.id||key,name:'',arguments:''};this.calls.set(key,call);}
    if(value.id)call.id=value.id;
    if(value.name)call.name=append?call.name+value.name:value.name;
    if(value.arguments!==undefined){
      const text=typeof value.arguments==='string'?value.arguments:JSON.stringify(value.arguments);
      this.argumentBytes+=Buffer.byteLength(text);
      if(this.argumentBytes>2*1024*1024)throw new Error('Tool arguments exceed 2 MiB');
      call.arguments=append?call.arguments+text:text;
    }
  }
  accept(e){
    if(!e||typeof e!=='object')return false;
    let tool=false;
    for(const [i,choice]of (Array.isArray(e.choices)?e.choices:[]).entries()){
      const msg=choice.delta||choice.message||{};
      for(const [j,t]of (msg.tool_calls||[]).entries()){
        tool=true;this.put(`chat:${choice.index??i}:${t.index??j}`,{id:t.id,name:t.function?.name,arguments:t.function?.arguments},!!choice.delta);
      }
      if(msg.function_call){tool=true;this.put(`chat:${choice.index??i}:legacy`,msg.function_call,!!choice.delta);}
    }
    if(e.type==='content_block_start'&&e.content_block?.type==='tool_use'){
      tool=true;const b=e.content_block;this.put(`anthropic:${e.index}`,{id:b.id,name:b.name,arguments:Object.keys(b.input||{}).length?b.input:undefined});
    }
    if(e.type==='content_block_delta'&&e.delta?.type==='input_json_delta'){
      tool=true;this.put(`anthropic:${e.index}`,{arguments:e.delta.partial_json||''},true);
    }
    for(const [i,b]of (Array.isArray(e.content)?e.content:[]).entries())if(b.type==='tool_use'){
      tool=true;this.put(`anthropic:${i}`,{id:b.id,name:b.name,arguments:b.input??{}});
    }
    const item=e.item;
    if(item?.type==='function_call'){
      tool=true;this.put(`responses:${item.id||e.output_index}`,{id:item.call_id||item.id,name:item.name,arguments:item.arguments||undefined});
    }
    if(e.type==='response.function_call_arguments.delta'){
      tool=true;this.put(`responses:${e.item_id??e.output_index}`,{arguments:e.delta||''},true);
    }
    if(e.type==='response.function_call_arguments.done'){
      tool=true;this.put(`responses:${e.item_id??e.output_index}`,{name:e.name,arguments:e.arguments});
    }
    const output=e.output||e.response?.output;
    for(const [i,b]of (Array.isArray(output)?output:[]).entries())if(b.type==='function_call'){
      tool=true;this.put(`responses:${b.id||i}`,{id:b.call_id||b.id,name:b.name,arguments:b.arguments});
    }
    return tool;
  }
  list(){return [...this.calls.values()];}
}

async function send(res,chunk){
  if(res.destroyed)throw new Error('Client disconnected');
  if(!res.write(chunk))await new Promise((resolve,reject)=>{
    const cleanup=()=>{res.off('drain',drain);res.off('close',close);res.off('error',error);};
    const drain=()=>{cleanup();resolve();};
    const error=e=>{cleanup();reject(e);};
    const close=()=>error(new Error('Client disconnected'));
    res.once('drain',drain);res.once('close',close);res.once('error',error);
    if(res.destroyed)close();
  });
}

// Text SSE frames keep flowing. From the first structured tool frame onward,
// spool exact bytes to disk until arguments and pre-tool backups are complete.
export async function forwardWithBackups({incoming,res,config,dataDir,onChunk,onTools,record}){
  const collector=new ToolCalls(),sse=String(incoming.headers['content-type']||'').includes('text/event-stream');
  let held,heldPath,heldBytes=0,buffer=Buffer.alloc(0),gated=!sse;
  async function hold(bytes){
    heldBytes+=bytes.length;if(heldBytes>config.maxResponseBytes)throw new Error('Buffered tool response exceeds maxResponseBytes');
    if(!held){const dir=path.join(dataDir,'file-backups','.pending');await mkdir(dir,{recursive:true,mode:0o700});heldPath=path.join(dir,randomUUID()+'.tmp');held=await open(heldPath,'wx',0o600);}
    // writeFile(FileHandle) advances the descriptor and handles partial writes.
    await held.writeFile(bytes);
  }
  async function frame(bytes){
    const text=bytes.toString('utf8');
    const data=text.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).replace(/^ /,'')).join('\n');
    if(data&&data!=='[DONE]'&&collector.accept(parse(data)))gated=true;
    if(gated)await hold(bytes);else await send(res,bytes);
  }
  try{
    for await(const chunk of incoming){
      onChunk(chunk);
      if(!sse){await hold(chunk);continue;}
      buffer=buffer.length?Buffer.concat([buffer,chunk]):chunk;
      for(;;){
        const boundary=/\r?\n\r?\n/.exec(buffer.toString('latin1'));
        if(!boundary)break;
        const end=boundary.index+boundary[0].length;
        await frame(buffer.subarray(0,end));buffer=buffer.subarray(end);
      }
      if(buffer.length>2*1024*1024)throw new Error('SSE frame exceeds 2 MiB');
    }
    if(sse&&buffer.length)await frame(buffer);
    if(!sse&&held){
      const reader=await open(heldPath,'r');let text;
      try{text=await reader.readFile('utf8');}finally{await reader.close();}
      const json=parse(text);
      if(json)collector.accept(json);
      else record.fileBackup={enabled:true,status:'unparsed_response',configHash:config.configHash};
    }
    if(collector.calls.size)await onTools(collector.list());
    else if(!record.fileBackup)record.fileBackup={enabled:true,status:'no_tool_calls',configHash:config.configHash};
    if(held){
      await held.close();held=null;
      const reader=await open(heldPath,'r');
      try{for await(const chunk of reader.createReadStream({autoClose:false,highWaterMark:64*1024}))await send(res,chunk);}finally{await reader.close();}
    }
  }finally{await held?.close().catch(()=>{});if(heldPath)await unlink(heldPath).catch(()=>{});}
}
