import {createHash} from 'node:crypto';
const stable=x=>Array.isArray(x)?x.map(stable):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
const digest=x=>createHash('sha256').update(JSON.stringify(stable(x))).digest('hex');
const args=x=>{try{return stable(typeof x==='string'?JSON.parse(x):x);}catch{return x;}};
function message(m){
 if(typeof m==='string')m={role:'user',content:m};
 if(m.type==='reasoning')return null;
 if(m.type==='function_call')return {role:'assistant',text:'',tools:[{id:m.call_id||m.id,name:m.name,args:args(m.arguments)}],results:[]};
 if(m.type==='function_call_output')return {role:'tool',text:'',tools:[],results:[{id:m.call_id,body:args(m.output)}]};
 const blocks=Array.isArray(m.content)?m.content:[],text=typeof m.content==='string'?m.content:blocks.filter(b=>['text','input_text','output_text'].includes(b.type)).map(b=>b.text||'').join('');
 if(m.role==='user'&&/^(Current runtime context\.|<system-reminder>|Time sampled while preparing turn)/.test(text))return null;
 const tools=(m.tool_calls||[]).map(t=>({id:t.id,name:t.function?.name,args:args(t.function?.arguments)}));
 for(const b of blocks)if(b.type==='tool_use')tools.push({id:b.id,name:b.name,args:args(b.input)});
 const results=blocks.filter(b=>b.type==='tool_result').map(b=>({id:b.tool_use_id,body:args(b.content)}));
 if(m.role==='tool')results.push({id:m.tool_call_id,body:args(m.content)});
 const other=blocks.filter(b=>!['text','input_text','output_text','tool_use','tool_result','thinking','redacted_thinking'].includes(b.type));
 return {role:m.role==='tool'||results.length&&!text?'tool':m.role||'assistant',text:m.role==='tool'?'':text,tools,results,...(other.length?{other}: {})};
}
export function requestMessages(payload){
 if(!payload||typeof payload!=='object')return [];
 let input=payload.messages??payload.input;if(typeof input==='string')input=[{role:'user',content:input}];
 const messages=[];
 if(payload.system)messages.push({role:'system',content:payload.system});if(payload.instructions)messages.push({role:'system',content:payload.instructions});
 messages.push(...(Array.isArray(input)?input:[]));return messages.map(message).filter(Boolean);
}
export function responseMessages(record){
 let p;try{p=JSON.parse(record.response);}catch{}
 if(p)return(p.choices?[p.choices[0]?.message].filter(Boolean):p.output|| (p.content?[p]:[])).map(message).filter(Boolean);
 let text='',tools=new Map(),blocks=new Map(),output=[],completed=null;
 for(const line of (record.response||'').split(/\r?\n/)){
  if(!line.startsWith('data:'))continue;let e;try{e=JSON.parse(line.slice(5));}catch{continue;}
  const delta=e.choices?.[0]?.delta;
  if(delta){text+=delta.content||'';for(const t of delta.tool_calls||[]){const key=t.index??t.id,old=tools.get(key)||{id:'',name:'',arguments:''};old.id+=t.id||'';old.name+=t.function?.name||'';old.arguments+=t.function?.arguments||'';tools.set(key,old);}}
  if(e.type==='content_block_start'){blocks.set(e.index,e.content_block);if(e.content_block?.type==='text')text+=e.content_block.text||'';if(e.content_block?.type==='tool_use')tools.set(e.index,{id:e.content_block.id,name:e.content_block.name,arguments:'',input:e.content_block.input});}
  if(e.type==='content_block_delta'){if(e.delta?.type==='text_delta')text+=e.delta.text||'';if(e.delta?.type==='input_json_delta'){const t=tools.get(e.index);if(t)t.arguments+=e.delta.partial_json||'';}}
  if(e.type==='response.output_text.delta')text+=e.delta||'';
  if(e.type==='response.output_item.done')output.push(e.item);
  if(e.type==='response.completed')completed=e.response;
 }
 if(completed?.output?.length)return completed.output.map(message).filter(Boolean);
 if(output.length)return output.map(message).filter(Boolean);
 if(!text&&!tools.size)return [];
 return [message({role:'assistant',content:text,tool_calls:[...tools.values()].map(t=>({id:t.id,function:{name:t.name,arguments:t.arguments||t.input||{}}}))})];
}
export function projectRecord(record){
 const before=requestMessages(record.request),after=responseMessages(record),signatures=before.map(digest),responses=after.map(digest);
 return {explicit:record.sessionMethod==='explicit',sessionId:record.sessionId,recordId:record.id,providerId:record.providerId,startedAt:record.startedAt,before:signatures,after:responses,toolIds:new Set(after.flatMap(m=>m.tools.map(t=>t.id)).filter(Boolean)),length:after.reduce((n,m)=>n+m.text.length,0)};
}
export class SessionMatcher{
 constructor(){this.latest=new Map();}
 restore(p){const old=this.latest.get(p.sessionId);if(!old||old.startedAt<=p.startedAt)this.latest.set(p.sessionId,{...p,toolIds:new Set(p.toolIds)});}
 add(record){if(record.status!=='completed'||!record.response)return;const old=this.latest.get(record.sessionId);if(!old||old.startedAt<=record.startedAt){const projection=projectRecord(record);projection.explicit||=!!old?.explicit;this.latest.set(record.sessionId,projection);}}
 match(providerId,payload){
  const messages=requestMessages(payload),signatures=messages.map(digest),resultIds=new Set(messages.flatMap(m=>m.results.map(t=>t.id)).filter(Boolean));
  const candidates=[];
  for(const old of this.latest.values()){
   if(old.providerId!==providerId||!old.after.length)continue;
   let prefix=0;while(prefix<old.before.length&&prefix<signatures.length&&old.before[prefix]===signatures[prefix])prefix++;
   // Require the previous output to occur after its input, followed by new content.
   const full=old.before.length>0&&prefix===old.before.length&&old.after.every((sig,i)=>signatures[prefix+i]===sig)&&signatures.length>prefix+old.after.length;
   const newResultIds=new Set(messages.slice(prefix).flatMap(m=>m.results.map(t=>t.id)).filter(Boolean));
   const tool=[...old.toolIds].some(id=>newResultIds.has(id));
   if(full||tool)candidates.push({source:old,id:old.sessionId,method:tool?'tool-call-link':'context-continuation',evidence:{matchedRecordId:old.recordId,matchedContextMessages:prefix,matchedResponseMessages:old.after.length,toolCallIdMatched:tool,confidence:tool?'strong-tool-reference':'strong-context-prefix'}});
   else if(old.length>=80){
    // Compaction may remove early history. Match the whole last response plus two adjacent input messages.
    const tail=old.before.slice(-2);
    if(tail.length===2)for(let i=0;i+tail.length+old.after.length<signatures.length;i++)if([...tail,...old.after].every((sig,j)=>signatures[i+j]===sig)){candidates.push({source:old,id:old.sessionId,method:'context-overlap',evidence:{matchedRecordId:old.recordId,matchedContextMessages:2,matchedResponseMessages:old.after.length,confidence:'context-tail-overlap'}});break;}
   }
  }
  // An older fragment is not an independent candidate when its entire chain
  // is a strict prefix of another candidate's input. Preserve true forks.
  const leaves=candidates.filter(candidate=>!candidates.some(other=>{
    if(candidate===other||candidate.source.explicit||other.source.explicit)return false;
    const chain=[...candidate.source.before,...candidate.source.after];
    return chain.length>0&&chain.length<other.source.before.length&&chain.every((sig,i)=>other.source.before[i]===sig);
  }));
  if(leaves.length===1){const {source,...match}=leaves[0];return match;}
  return leaves.length>1?{ambiguous:true,candidates:leaves.map(x=>x.id)}:null;
 }
}
