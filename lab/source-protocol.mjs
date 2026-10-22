// Normalize OpenAI Chat Completions source history for the Claude replay harness.
// The untouched request remains in sample.originalRequest and evidence records.
export const toolName=name=>({read:'Read',write:'Write',edit:'Edit',bash:'Bash'}[name]||name);
const fields={Read:['file_path','offset','limit'],Write:['file_path','content'],Edit:['file_path','old_string','new_string','replace_all']};
const metadata=new Set(['sandbox_permissions','justification']);
function text(content){
 if(typeof content==='string')return [{type:'text',text:content}];
 if(content==null)return [];
 if(!Array.isArray(content)||content.some(b=>b.type!=='text'||typeof b.text!=='string'))throw new Error('unsupported_openai_content');
 return structuredClone(content);
}
export function normalizeSource(record){
 const request=record.request;
 if(record.protocol==='anthropic')return {request:structuredClone(request),warnings:[]};
 if(record.protocol!=='openai')throw new Error('unsupported_source_protocol:'+record.protocol);
 if(!Array.isArray(request?.messages))throw new Error('missing_messages');
 const system=[],messages=[],pending=new Set(),known=new Set(),warnings=['openai_chat_to_anthropic_history'];
 let seenConversation=false;
 for(const m of request.messages){
  if(m.name)throw new Error('unsupported_named_message');
  if((m.reasoning_content!=null&&typeof m.reasoning_content!=='string')||m.reasoning||m.refusal||m.function_call||m.audio)throw new Error('unsupported_openai_history_fields');
  if(['system','developer'].includes(m.role)){
   if(seenConversation)throw new Error('interleaved_system_message');
   system.push(...text(m.content));if(m.role==='developer')warnings.push('developer_role_mapped_to_system');continue;
  }
  seenConversation=true;
  if(m.role==='tool'){
   if(!m.tool_call_id||!pending.delete(m.tool_call_id))throw new Error('unmatched_tool_result');
   messages.push({role:'user',content:[{type:'tool_result',tool_use_id:m.tool_call_id,content:text(m.content)}]});continue;
  }
  if(!['user','assistant'].includes(m.role)||pending.size)throw new Error('incomplete_or_unsupported_openai_history');
  const content=text(m.content);
  if(m.tool_calls?.length){
   if(m.role!=='assistant')throw new Error('invalid_tool_call_role');
   for(const t of m.tool_calls){
    if(t.type!=='function'||!t.id||known.has(t.id)||typeof t.function?.name!=='string')throw new Error('invalid_tool_call');
    let input;try{input=JSON.parse(t.function.arguments);}catch{throw new Error('invalid_tool_arguments');}
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('invalid_tool_arguments');
    const name=toolName(t.function.name);
    if(fields[name])for(const k of Object.keys(input)){
     if(metadata.has(k)){delete input[k];warnings.push('source_execution_metadata_removed');}
     else if(!fields[name].includes(k))throw new Error('unsupported_tool_argument:'+k);
    }
    known.add(t.id);pending.add(t.id);content.push({type:'tool_use',id:t.id,name,input});
   }
  }
  messages.push({role:m.role,content,...(m.reasoning_content?{reasoning_content:m.reasoning_content}:{})});
 }
 if(pending.size)throw new Error('unresolved_history_tool_call');
 const tools=(request.tools||[]).map(t=>{
  if(t.type!=='function'||!t.function?.name)throw new Error('unsupported_tool_definition');
  const f=t.function,name=toolName(f.name),schema=structuredClone(f.parameters||{type:'object',properties:{}});
  if(fields[name]){
   for(const k of Object.keys(schema.properties||{}))if(metadata.has(k))delete schema.properties[k];
   schema.required=(schema.required||[]).filter(k=>!metadata.has(k));
   for(const [k,v]of Object.entries(schema.properties||{}))if(['offset','limit'].includes(k)&&v.type==='number')v.type='integer';
  }
  return {name,description:f.description||'',input_schema:schema};
 });
 if(new Set(tools.map(t=>t.name)).size!==tools.length)throw new Error('tool_name_collision');
 let choice;
 if(request.tool_choice==='required')choice={type:'any'};
 else if(request.tool_choice==='auto')choice={type:'auto'};
 else if(request.tool_choice==='none')choice={type:'none'};
 else if(request.tool_choice?.type==='function')choice={type:'tool',name:toolName(request.tool_choice.function.name)};
 return {request:{model:request.model,system,messages,tools,max_tokens:request.max_completion_tokens||request.max_tokens,...(choice?{tool_choice:choice}:{})},warnings:[...new Set(warnings)]};
}
