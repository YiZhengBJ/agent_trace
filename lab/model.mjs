import {randomUUID} from 'node:crypto';
import {resolveTarget,clean,endpoint,readBody,textOf} from './common.mjs';

export function toChat(body){
 const messages=[];
 if(body.system)messages.push({role:'system',content:textOf(body.system)});
 for(const m of body.messages){
  if(typeof m.content==='string'){messages.push({role:m.role,content:m.content,...(m.reasoning_content?{reasoning_content:m.reasoning_content}:{})});continue;}
  const content=m.content||[],text=textOf(content),tools=content.filter(b=>b.type==='tool_use');
  if(m.role==='assistant')messages.push({role:'assistant',content:text||null,...(m.reasoning_content?{reasoning_content:m.reasoning_content}:{}),...(tools.length?{tool_calls:tools.map(b=>({id:b.id,type:'function',function:{name:b.name,arguments:JSON.stringify(b.input)}}))}:{})});
  else{
   for(const b of content.filter(b=>b.type==='tool_result'))messages.push({role:'tool',tool_call_id:b.tool_use_id,content:typeof b.content==='string'?b.content:JSON.stringify(b.content||[])});
   if(text)messages.push({role:'user',content:text});
  }
 }
 return {messages,...(body.tools?.length?{tools:body.tools.map(t=>({type:'function',function:{name:t.name,description:t.description||'',parameters:t.input_schema}})),tool_choice:body.tool_choice?.type==='any'?'required':body.tool_choice?.type==='none'?'none':body.tool_choice?.type==='tool'?{type:'function',function:{name:body.tool_choice.name}}:'auto'}:{})};
}

export async function callModel(target,body,{env=process.env,signal}={}){
 target=resolveTarget(target,body);
 if(target.protocol==='anthropic'&&body.messages?.some(m=>m.reasoning_content))throw new Error('OpenAI reasoning history requires an OpenAI-compatible target');
 if(target.protocol==='openai'&&body.messages?.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.type==='thinking'||b.type==='redacted_thinking')))throw new Error('Anthropic thinking history requires an Anthropic target; refusing to drop it');
 const key=target.apiKeyEnv?env[target.apiKeyEnv]:null;
 const headers={'content-type':'application/json'};
 if(key){if(target.protocol==='anthropic')headers['x-api-key']=key;else headers.authorization='Bearer '+key;}
 if(target.protocol==='anthropic')headers['anthropic-version']='2023-06-01';
 const request=target.protocol==='openai'?{...toChat(body),model:target.model,max_tokens:target.maxTokens,temperature:0,stream:false}:{...clean(body),model:target.model,max_tokens:target.maxTokens,stream:false};
 if(target.protocol==='anthropic'){delete request.metadata;delete request.thinking;delete request.output_config;}
 const controller=AbortSignal.timeout(target.timeoutMs),combined=signal?AbortSignal.any([signal,controller]):controller;
 const response=await fetch(endpoint(target.baseURL,target.protocol==='openai'?'chat/completions':'messages'),{method:'POST',headers,body:JSON.stringify(request),signal:combined,redirect:'error'});
 const raw=await readBody(response.body,16*1024*1024).catch(e=>{throw new Error('Model response: '+e.message);});
 if(!response.ok)throw new Error('Model HTTP '+response.status);
 let json;try{json=JSON.parse(raw);}catch{throw new Error('Model did not return JSON');}
 if(target.protocol==='anthropic'){
  if(!Array.isArray(json.content))throw new Error('Invalid Anthropic model response');
  return {protocol:target.protocol,message:json,request,usage:json.usage||{}};
 }
 const choice=json.choices?.[0];if(!choice?.message)throw new Error('Invalid Chat model response');
 const m=choice.message,content=[];
 if(m.content)content.push({type:'text',text:typeof m.content==='string'?m.content:JSON.stringify(m.content)});
 for(const t of m.tool_calls||[]){let input;try{input=JSON.parse(t.function.arguments);}catch{throw new Error('Model returned invalid tool arguments');}content.push({type:'tool_use',id:t.id||'call_'+randomUUID(),name:t.function.name,input});}
 return {protocol:target.protocol,message:{id:'msg_'+randomUUID(),type:'message',role:'assistant',model:target.model,content,stop_reason:(m.tool_calls||[]).length?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:json.usage?.prompt_tokens||0,output_tokens:json.usage?.completion_tokens||0}},request,usage:json.usage||{}};
}

export function messageSSE(message){
 const lines=[],emit=e=>lines.push('event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n');
 emit({type:'message_start',message:{...message,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:message.usage?.input_tokens||0,output_tokens:0}}});
 for(const [index,b]of message.content.entries()){
  if(b.type==='text'){
   emit({type:'content_block_start',index,content_block:{type:'text',text:''}});
   emit({type:'content_block_delta',index,delta:{type:'text_delta',text:b.text}});
  }else if(b.type==='thinking'){
   if(typeof b.thinking!=='string')throw new Error('Invalid thinking response');
   emit({type:'content_block_start',index,content_block:{type:'thinking',thinking:''}});
   emit({type:'content_block_delta',index,delta:{type:'thinking_delta',thinking:b.thinking}});
   if(b.signature)emit({type:'content_block_delta',index,delta:{type:'signature_delta',signature:b.signature}});
  }else if(b.type==='tool_use'){
   emit({type:'content_block_start',index,content_block:{type:'tool_use',id:b.id,name:b.name,input:{}}});
   emit({type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:JSON.stringify(b.input)}});
  }else throw new Error('Unsupported candidate content block: '+b.type);
  emit({type:'content_block_stop',index});
 }
 emit({type:'message_delta',delta:{stop_reason:message.stop_reason||'end_turn',stop_sequence:null},usage:{output_tokens:message.usage?.output_tokens||0}});
 emit({type:'message_stop'});return lines.join('');
}
