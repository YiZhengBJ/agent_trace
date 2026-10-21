const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
$('#rail-toggle').onclick=()=>{
 const collapsed=document.body.classList.toggle('rail-collapsed'),button=$('#rail-toggle');
 button.textContent=collapsed?'»':'«';button.setAttribute('aria-expanded',String(!collapsed));button.setAttribute('aria-label',collapsed?'展开导航':'折叠导航');button.title=collapsed?'展开导航':'折叠导航';
};
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state={providers:[],sessions:[]},selected=null,requests=[],selectedRequest=null,filter='all',view='sessions',rawTab='request',lastSignature='';
const trajectoryStates=new Map();
let uiPrefs={autoRefresh:true,tokensOpen:false};
try{const saved=JSON.parse(localStorage.getItem('trace-ui-preferences')||'{}');for(const key of ['autoRefresh','tokensOpen'])if(typeof saved?.[key]==='boolean')uiPrefs[key]=saved[key];}catch{}
function saveUiPrefs(){try{localStorage.setItem('trace-ui-preferences',JSON.stringify(uiPrefs));}catch{toast('浏览器无法保存显示偏好，本次使用仍会生效');}}
function updateRefreshLabel(){const footer=$('.session-footer');if(footer)footer.innerHTML=`<i class="green-dot"></i> ${uiPrefs.autoRefresh?'自动刷新':'已暂停刷新'} <span>本地持久化</span>`;}
$('#setting-auto-refresh').checked=uiPrefs.autoRefresh;$('#setting-token-chart').checked=uiPrefs.tokensOpen;updateRefreshLabel();
$('#setting-auto-refresh').onchange=e=>{uiPrefs.autoRefresh=e.target.checked;saveUiPrefs();updateRefreshLabel();};
$('#setting-token-chart').onchange=e=>{uiPrefs.tokensOpen=e.target.checked;for(const state of trajectoryStates.values())state.tokensOpen=uiPrefs.tokensOpen;lastSignature='';saveUiPrefs();};
let eventRequestId='',eventIndex=0;
function trajectoryState(){if(!trajectoryStates.has(selected))trajectoryStates.set(selected,{expanded:false,items:new Map(),tokensOpen:uiPrefs.tokensOpen});return trajectoryStates.get(selected);}
function setAllEvents(expanded){const state=trajectoryState();state.expanded=expanded;state.bulkExpanded=expanded;state.items.clear();$$('#trajectory details[data-event]').forEach(el=>{el.open=expanded;});updateBulkToggle();updateDisclosureButtons();}
$('#trajectory').addEventListener('toggle',e=>{const el=e.target;if(el.matches('details[data-event]')&&el.isConnected){trajectoryState().items.set(el.dataset.event,el.open);updateBulkToggle();}},true);
function updateBulkToggle(){
 const button=$('#toggle-all');if(!button)return;
 const entries=$$('#trajectory details[data-event]'),allOpen=entries.length>0&&entries.every(el=>el.open);
 button.textContent=allOpen?'− 全部缩略':'+ 全部展开';button.dataset.expanded=String(allOpen);button.setAttribute('aria-expanded',String(allOpen));
}
const fmt=n=>new Intl.NumberFormat('en').format(n||0),ms=n=>n>=1000?(n/1000).toFixed(2)+' s':Math.round(n||0)+' ms';
const date=s=>new Date(s).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
async function api(url,options){const r=await fetch(url,options);const data=await r.json();if(!r.ok)throw new Error(data.error||'请求失败');return data;}
function toast(s){$('#toast').textContent=s;$('#toast').classList.add('show');setTimeout(()=>$('#toast').classList.remove('show'),2800);}
async function copy(s){try{await navigator.clipboard.writeText(s);toast('已复制到剪贴板');}catch{toast('复制失败，请手动选择地址');}}
function showView(v){hideBackupTooltip();if(view==='settings'&&v!=='settings')void flushBackupChanges();view=v;for(const name of ['sessions','providers','connect','settings'])$(`#${name}-view`).hidden=name!==v;$$('.nav').forEach(b=>b.classList.toggle('active',b.dataset.view===v));$('#crumb').textContent={sessions:'轨迹记录',providers:'Providers',connect:'接入指南',settings:'设置'}[v];if(v==='providers')renderProviders();if(v==='connect')renderConnect();if(v==='settings'&&!backupConfig)loadBackupSettings();if(v==='sessions')refresh();}
$$('.nav').forEach(b=>b.onclick=()=>showView(b.dataset.view));
const dialog=$('#provider-dialog');for(const id of ['add-top','add-provider'])$('#'+id).onclick=()=>dialog.showModal();$('#close-dialog').onclick=()=>dialog.close();
$('#provider-form').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('[type=submit]');button.disabled=true;try{await api('/api/providers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});dialog.close();e.target.reset();$('#form-error').textContent='';await refresh();showView('providers');toast('Provider 已连接，本地端点已生成');}catch(e){$('#form-error').textContent=e.message;}finally{button.disabled=false;}};
let backupConfig;
async function loadBackupSettings(){
 const button=$('#backup-reload');button.disabled=true;$('#backup-fields').disabled=true;$('#backup-error').textContent='';$('#backup-message').textContent='读取中…';
 try{
  const data=await api('/api/settings/file-backup');backupConfig=data.config;
  $('#backup-enabled').checked=backupConfig.enabled;
  $('#backup-file-limit').value=backupConfig.maxFileBytes/1048576;$('#backup-count-limit').value=backupConfig.maxFilesPerResponse;$('#backup-response-limit').value=backupConfig.maxResponseBytes/1048576;
  $('#backup-rules').value=JSON.stringify(backupConfig.rules,null,2);$('#backup-location').textContent='配置：'+data.configPath+' · 备份目录：'+data.backupDirectory;
  $('#backup-error').textContent='';$('#backup-message').textContent=backupConfig.enabled?'已生效 · 文件备份已启用':'已生效 · 文件备份已关闭';$('#backup-fields').disabled=false;
 }catch(e){$('#backup-error').textContent='读取备份设置失败：'+e.message;$('#backup-message').textContent='';}finally{button.disabled=false;}
}
$('#backup-reload').onclick=loadBackupSettings;
$('#backup-dsh-rules').onclick=()=>{
 try{
  const rules=JSON.parse($('#backup-rules').value);if(!Array.isArray(rules))throw new Error('规则必须是数组');
  for(const [name,operation]of [['read','read'],['write','write'],['edit','write']]){
   if(rules.some(r=>r.toolNames?.includes(name)))continue;
   const baseId='dsh-'+name;let id=baseId,index=2;while(rules.some(r=>r.id===id))id=baseId+'-'+index++;
   rules.push({id,operation,toolNames:[name],pathFields:['file_path','path']});
  }
  $('#backup-rules').value=JSON.stringify(rules,null,2);queueBackupChange({rules});
 }catch(e){$('#backup-error').textContent='规则 JSON 无效：'+e.message;}
};
let backupPending={},backupSaving=false,backupTimer;
async function flushBackupChanges(){
 clearTimeout(backupTimer);
 if(backupSaving||!backupConfig||!Object.keys(backupPending).length)return;
 backupSaving=true;$('#backup-reload').disabled=true;
 const patch=backupPending;backupPending={};$('#backup-message').textContent='保存中…';
 try{
  const data=await api('/api/settings/file-backup',{method:'PUT',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json'},body:JSON.stringify({...backupConfig,...patch})});
  backupConfig=data.config;
  $('#backup-message').textContent=Object.keys(backupPending).length?'保存中…':(backupConfig.enabled?'已生效 · 文件备份已启用':'已生效 · 文件备份已关闭');
 }catch(e){
  backupPending={...patch,...backupPending};$('#backup-error').textContent='修改未生效：'+e.message+'。再次修改可重试。';$('#backup-message').textContent='保存失败，仍使用上次生效的配置';
  backupSaving=false;$('#backup-reload').disabled=false;return;
 }
 backupSaving=false;$('#backup-reload').disabled=false;
 if(Object.keys(backupPending).length)void flushBackupChanges();
}
function queueBackupChange(patch,delay=0){
 backupPending={...backupPending,...patch};$('#backup-error').textContent='';$('#backup-message').textContent=delay?'正在编辑，稍后自动保存…':'保存中…';clearTimeout(backupTimer);
 if(delay)backupTimer=setTimeout(flushBackupChanges,delay);else void flushBackupChanges();
}
$('#backup-enabled').onchange=e=>queueBackupChange({enabled:e.target.checked});
for(const [id,key,scale]of [['backup-file-limit','maxFileBytes',1048576],['backup-count-limit','maxFilesPerResponse',1],['backup-response-limit','maxResponseBytes',1048576]]){
 const input=$('#'+id);
 input.oninput=()=>{
  if(!input.validity.valid||input.value===''){delete backupPending[key];$('#backup-error').textContent='请输入有效的资源上限；该项未生效。';return;}
  queueBackupChange({[key]:Math.round(Number(input.value)*scale)},400);
 };
 input.onchange=()=>{if(input.validity.valid&&input.value!=='')void flushBackupChanges();};
}
$('#backup-rules').oninput=()=>{
 try{const rules=JSON.parse($('#backup-rules').value);if(!Array.isArray(rules))throw new Error('规则必须是数组');queueBackupChange({rules},600);}
 catch(e){delete backupPending.rules;$('#backup-error').textContent='规则未生效：'+e.message;$('#backup-message').textContent='正在编辑规则，仍使用上次生效的规则';}
};
$('#backup-rules').onchange=()=>void flushBackupChanges();
$('#backup-form').onsubmit=e=>{e.preventDefault();void flushBackupChanges();};
$('#backup-reload').onclick=()=>{clearTimeout(backupTimer);backupPending={};void loadBackupSettings();};
$('#demo').onclick=async()=>{const b=$('#demo');b.disabled=true;try{await api('/api/demo',{method:'POST'});selected=null;await refresh();toast('演示轨迹已通过网关录制');}catch(e){toast(e.message);}finally{b.disabled=false;}};
$('#search').oninput=renderSessions;$$('.filter').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;$$('.filter').forEach(x=>x.classList.toggle('selected',x===b));renderSessions();});
for(const id of ['session-sort','session-range','session-from','session-to'])$('#'+id).addEventListener('change',()=>{$('#session-custom-range').hidden=$('#session-range').value!=='custom';renderSessions();});
function sessionTimeOptions(){
 const [field,order]=$('#session-sort').value.split('-'),range=$('#session-range').value;
 let from=-Infinity,to=Infinity;
 if(range==='today'){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(p=>[p.type,p.value]));
  from=Date.parse(`${parts.year}-${parts.month}-${parts.day}T00:00:00+08:00`);to=from+86400000-1;
 }else if(range==='7'||range==='30'){to=Date.now();from=to-Number(range)*86400000;}
 else if(range==='custom'){
  if($('#session-from').value)from=Date.parse($('#session-from').value+':00+08:00');
  if($('#session-to').value)to=Date.parse($('#session-to').value+':00+08:00')+59999;
 }
 const error=from>to?'开始时间不能晚于结束时间':'';
 $('#session-time-error').hidden=!error;$('#session-time-error').textContent=error;
 return {key:field==='started'?'startedAt':'updatedAt',direction:order==='asc'?1:-1,from,to,error};
}
function renderSessions(){
 const q=$('#search').value.toLowerCase(),time=sessionTimeOptions(),sessions=state.sessions.filter(s=>(!q||[s.title,s.model,s.providerName,s.id].join(' ').toLowerCase().includes(q))&&(filter!=='real'||!s.demo)&&(filter!=='error'||s.errors)&&!time.error&&Date.parse(s[time.key])>=time.from&&Date.parse(s[time.key])<=time.to).sort((a,b)=>time.direction*(Date.parse(a[time.key])-Date.parse(b[time.key]))||a.id.localeCompare(b.id));
 $('#list-count').textContent=sessions.length;
 $('#session-list').innerHTML=sessions.map(s=>`<button class="session-card ${s.id===selected?'selected':''}" data-id="${esc(s.id)}"><div class="row"><span class="badge">${esc(s.demo?'DEMO':s.protocol.toUpperCase())}</span><time title="${time.key==='startedAt'?'创建时间':'最近活跃时间'}（北京时间）">${esc(date(s[time.key]))}</time></div><h3>${esc(s.title)}</h3><div class="meta"><span class="dot">${s.errors?'●':'●'}</span><span>${esc(s.model)}</span><span>· ${s.count} requests</span></div></button>`).join('')||'<div class="empty">还没有匹配的会话。<br>连接 Provider，开始录制。</div>';
 $$('.session-card').forEach(b=>b.onclick=async()=>{selected=b.dataset.id;selectedRequest=null;lastSignature='';renderSessions();await loadSession();});
}
function kv(k,v,c=''){return `<div class="kv"><span>${esc(k)}</span><strong class="${c}">${esc(v)}</strong></div>`;}
function event(type,title,text,code=false){
 const key=`${eventRequestId}:${eventIndex++}`,state=trajectoryState();
 const expanded=state.items.has(key)?state.items.get(key):state.expanded;
 const value=typeof text==='string'?text:JSON.stringify(text,null,2)||'';
 const preview=value.replace(/\s+/g,' ').trim().slice(0,140)||'无正文';
 return `<details class="event ${type}" data-event="${esc(key)}" ${expanded?'open':''}><summary aria-label="${esc(title)}，展开或收起"><span class="event-icon">${{user:'↗',assistant:'✦',tool:'⌘',thinking:'◌',error:'!'}[type]||'·'}</span><span class="event-title"><span>${esc(title)}</span><time>${type==='tool'?'TOOL':type.toUpperCase()}</time><button type="button" class="event-chevron disclosure-toggle" aria-label="展开或收起">›</button></span><span class="event-preview">${esc(preview)}</span></summary><div class="${code?'tool-box':'event-content'}">${esc(value)}</div></details>`;
}
function contentEvents(m){
 let out='';const role=m.role||'assistant',content=m.content;
 if(m.reasoning_content)out+=event('thinking','思考过程',m.reasoning_content);
 if(typeof content==='string'&&content)out+=event(role==='tool'?'tool':role,role==='tool'?'工具返回':role==='user'?'用户指令':role==='system'?'System prompt':'Agent',content,role==='tool');
 if(Array.isArray(content))for(const b of content){if(['text','input_text','output_text'].includes(b.type))out+=event(role,role==='user'?'用户指令':'Agent',b.text);else if(b.type==='thinking')out+=event('thinking','思考过程',b.thinking);else if(b.type==='tool_use')out+=event('tool',b.name,b.input,true);else if(b.type==='tool_result')out+=event('tool','工具返回',b.content,true);else out+=event(role,b.type||'内容',b,true);}
 for(const tool of m.tool_calls||[])out+=event('tool',tool.function?.name||'Tool call',tool.function?.arguments||tool,true);
 if(m.type==='function_call')out+=event('tool',m.name,m.arguments,true);
 if(m.type==='function_call_output')out+=event('tool','工具返回',m.output,true);
 if(m.type==='reasoning')for(const s of m.summary||[])out+=event('thinking','思考摘要',s.text);
 return out;
}
function responseEvents(r){
 if(!r.response)return event('assistant',r.status==='streaming'?'响应传输中…':'无响应正文',r.error||'');
 if(!r.stream){try{const p=JSON.parse(r.response);if(p.error)return event('error','Provider 返回错误',p.error,true);if(p.choices)return p.choices.map(c=>contentEvents(c.message||{})).join('');if(p.output)return p.output.map(contentEvents).join('');if(p.content)return contentEvents(p);return event('assistant','响应',p,true);}catch{return event('assistant','原始响应',r.response,true);}}
 let text='',thinking='',tools=new Map(),anthropic=new Map(),completed=null,errors=[];
 for(const line of r.response.split(/\r?\n/)){if(!line.startsWith('data:'))continue;let p;try{p=JSON.parse(line.slice(5).trim());}catch{continue;}
   const d=p.choices?.[0]?.delta;if(d){text+=d.content||'';thinking+=d.reasoning_content||'';for(const t of d.tool_calls||[]){const key=t.index??t.id;const old=tools.get(key)||{name:'',arguments:''};old.name+=t.function?.name||'';old.arguments+=t.function?.arguments||'';tools.set(key,old);}}
   if(p.type==='content_block_start'){anthropic.set(p.index,p.content_block);if(p.content_block?.type==='text')text+=p.content_block.text||'';if(p.content_block?.type==='thinking')thinking+=p.content_block.thinking||'';}
   if(p.type==='content_block_delta'){if(p.delta.type==='text_delta')text+=p.delta.text||'';if(p.delta.type==='thinking_delta')thinking+=p.delta.thinking||'';if(p.delta.type==='input_json_delta'){const t=tools.get(p.index)||{name:anthropic.get(p.index)?.name||'Tool call',arguments:''};t.arguments+=p.delta.partial_json||'';tools.set(p.index,t);}}
   if(p.type==='response.output_item.added'&&p.item?.type==='function_call')tools.set(p.item.id,{name:p.item.name,arguments:p.item.arguments||''});
   if(p.type==='response.function_call_arguments.delta'){const t=tools.get(p.item_id)||{name:'Tool call',arguments:''};t.arguments+=p.delta||'';tools.set(p.item_id,t);}
   if(p.type==='response.function_call_arguments.done'){const t=tools.get(p.item_id)||{name:'Tool call',arguments:''};t.arguments=p.arguments||t.arguments;tools.set(p.item_id,t);}
   if(p.type==='response.failed'||p.type==='response.incomplete')errors.push(p.response?.error||p);
   if(p.type==='response.output_text.delta')text+=p.delta||'';
   if(p.type==='response.reasoning_summary_text.delta')thinking+=p.delta||'';
   if(p.type==='response.completed')completed=p.response;
   if(p.type==='error'||p.error)errors.push(p.error||p);
 }
 if(completed?.output?.length)return completed.output.map(contentEvents).join('');
 return (thinking?event('thinking','思考过程',thinking):'')+(text?event('assistant','Agent',text):'')+[...tools.values()].map(t=>event('tool',t.name,t.arguments,true)).join('')+errors.map(e=>event('error','流式错误',e,true)).join('')||event('assistant','原始事件流',r.response,true);
}
function sameContent(a,b){
 const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
 return JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
}
function requestEvents(r,previous){
 const payload=r.request,prior=previous?.request;
 if(!payload||typeof payload!=='object')return event('system','请求正文',payload||'无请求正文',true);
 let repeated='',fresh='',repeatedCount=0;
 const add=(html,duplicate)=>{if(duplicate){repeated+=html;repeatedCount++;}else fresh+=html;};
 if(payload.system)add(event('system','System prompt',payload.system,typeof payload.system!=='string'),prior&&sameContent(payload.system,prior.system));
 if(payload.instructions)add(event('system','Instructions',payload.instructions,typeof payload.instructions!=='string'),prior&&sameContent(payload.instructions,prior.instructions));
 const messagesFor=p=>{const value=p?.messages??p?.input;return typeof value==='string'?[{role:'user',content:value}]:Array.isArray(value)?value:[];};
 const messages=messagesFor(payload),oldMessages=messagesFor(prior);
 let prefix=0;while(prefix<messages.length&&prefix<oldMessages.length&&sameContent(messages[prefix],oldMessages[prefix]))prefix++;
 for(const [index,message]of messages.entries()){
   const html=typeof message==='string'?event('user','输入内容',message):contentEvents(message)||event('system','消息内容',message,true);
   add(html,index<prefix);
 }
 if(payload.tools?.length)add(event('tool','工具定义 · '+payload.tools.length+' 个',payload.tools,true),prior&&sameContent(payload.tools,prior.tools));
 const parametersFor=p=>Object.fromEntries(Object.entries(p||{}).filter(([key])=>!['messages','input','system','instructions','tools'].includes(key)));
 const parameters=parametersFor(payload);
 if(Object.keys(parameters).length)add(event('system','请求参数',parameters,true),prior&&sameContent(parameters,parametersFor(prior)));
 if(!repeated)return fresh||event('system','请求正文',payload,true);
 const key=r.id+':history',state=trajectoryState(),expanded=state.items.has(key)?state.items.get(key):(state.bulkExpanded??false);
 const history=`<details class="request-history" data-event="${esc(key)}" ${expanded?'open':''}><summary><button type="button" class="event-chevron disclosure-toggle" aria-label="展开或收起">›</button><span>已包含的历史内容 <strong>${repeatedCount} 项</strong><small>与上一请求相同，点击右侧箭头展开</small></span></summary><div class="history-body">${repeated}</div></details>`;
 return history+(fresh||'<div class="unchanged-request">本次请求的内容与上一请求相同</div>');
}
function requestTrigger(r){
 const input=r.request?.messages??r.request?.input;
 if(typeof input==='string')return 'user';
 for(const message of [...(Array.isArray(input)?input:[])].reverse()){
   if(message?.role==='tool'||message?.type==='function_call_output'||message?.content?.some?.(part=>part.type==='tool_result'))return 'tool';
   if(message?.role==='user'){
     const text=typeof message.content==='string'?message.content:'';
     if(/^(Current runtime context|<system-reminder>|Time sampled while)/.test(text))continue;
     return 'user';
   }
 }
 return 'user';
}
let toolOperationIndex=new Map();
function indexToolOperations(list){
 const index=new Map();
 const byName=name=>/^(read|read_file|readfile|read_file_from_disk|read_text_file)$/i.test(name||'')?'read':/^(write|write_file|write_to_file|edit|multiedit|edit_file|replace_in_file|apply_patch|update_file|patch_file)$/i.test(name||'')?'write':null;
 const add=(id,name,operation)=>{const kind=operation||byName(name);if(id&&kind){if(!index.has(id))index.set(id,new Set());index.get(id).add(kind);}};
 for(const record of list){
  const input=record.request?.messages??record.request?.input;
  for(const m of Array.isArray(input)?input:[]){
   for(const call of m.tool_calls||[])add(call.id,call.function?.name);
   for(const part of Array.isArray(m.content)?m.content:[])if(part.type==='tool_use')add(part.id,part.name);
   if(m.type==='function_call')add(m.call_id||m.id,m.name);
  }
  for(const file of record.fileBackup?.files||[])add(file.toolCallId,file.toolName,file.operation);
 }
 return index;
}
function returnedFileOperations(record){
 const input=record.request?.messages??record.request?.input,ids=[];
 for(const m of [...(Array.isArray(input)?input:[])].reverse()){
  const blocks=Array.isArray(m.content)?m.content:[];
  if(m.role==='tool'){if(m.tool_call_id)ids.push(m.tool_call_id);continue;}
  if(m.type==='function_call_output'){if(m.call_id)ids.push(m.call_id);continue;}
  const results=blocks.filter(b=>b.type==='tool_result');
  if(results.length){ids.push(...results.map(b=>b.tool_use_id));continue;}
  if(m.role==='user'){
   const text=typeof m.content==='string'?m.content:blocks.filter(b=>b.type==='text'||b.type==='input_text').map(b=>b.text||'').join('');
   if(/^(Current runtime context|<system-reminder>|Time sampled while)/.test(text))continue;
  }
  break;
 }
 return new Set(ids.flatMap(id=>[...(toolOperationIndex.get(id)||[])]));
}
function roundFlags(record,kind){
 const labels=[];
 if(kind==='tool')for(const operation of returnedFileOperations(record))labels.push(`<span class="round-tag operation-${operation}" title="本次返回包含文件${operation==='read'?'读取':'写入或修改'}工具的执行结果">${operation==='read'?'读':'写'}</span>`);
 return labels.length?`<span class="exchange-flags">${labels.join('')}</span>`:'';
}
function archiveIndicator(record){
 if(!record.fileBackup?.files?.length)return '';
 return `<button type="button" class="round-archive" data-archive="${esc(record.id)}" aria-label="查看本轮文件备份与复用" aria-describedby="backup-tooltip"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v12h14V8M10 12h4"/></svg></button>`;
}
function backupTooltipContents(record){
 const files=record.fileBackup?.files||[];
 const unique=items=>[...new Map(items.map(f=>[f.backupPath||f.resolvedPath||f.path||f.toolCallId,f])).values()];
 const saved=unique(files.filter(f=>f.status==='saved'&&!f.reused&&f.backupPath));
 const reused=unique(files.filter(f=>f.reused));
 const other=unique(files.filter(f=>!f.reused&&f.status!=='saved'));
 const fileName=f=>esc(f.resolvedPath||f.path||f.toolName||'未解析路径');
 const states={absent:'原文件不存在，已记录初始状态',too_large:'文件超过大小限制',file_limit:'超过本轮文件数限制',not_regular_file:'不是普通文件',relative_path_unresolved:'无法解析相对路径',backup_storage:'备份目录不参与备份',invalid_arguments:'工具参数无效',no_path:'未找到文件路径',error:'采集失败'};
 const actual=saved.map(f=>`<li><strong>${fileName(f)}</strong><code>${esc(f.backupPath)}</code><small>${fmt(f.size)} 字节</small></li>`).join('');
 const notes=other.map(f=>`<li><strong>${fileName(f)}</strong><small>${esc(states[f.status]||f.status)}${f.error?'：'+esc(f.error):''}</small></li>`).join('');
 const references=reused.map(f=>{const index=requests.findIndex(r=>r.id===f.sourceRecordId);return `<li><strong>${fileName(f)}</strong><small>${index<0?'复用本 query 的首次记录':'复用第 '+String(index+1).padStart(2,'0')+' 轮首次记录'}${f.status==='absent'?' · 原文件不存在':''}</small>${f.backupPath?`<code>${esc(f.backupPath)}</code>`:''}</li>`;}).join('');
 return `<section><h4>实际备份文件列表 <span>${saved.length}</span></h4>${actual?`<ul>${actual}</ul>`:'<p>本轮未新增备份文件</p>'}${notes?`<ul>${notes}</ul>`:''}</section><section><h4>备份复用 <span>${reused.length}</span></h4>${references?`<ul>${references}</ul>`:'<p>本轮无备份复用</p>'}</section>`;
}
const backupTooltip=document.createElement('div');backupTooltip.id='backup-tooltip';backupTooltip.className='backup-tooltip';backupTooltip.setAttribute('role','tooltip');backupTooltip.hidden=true;document.body.append(backupTooltip);
let archiveHideTimer;
function hideBackupTooltip(){clearTimeout(archiveHideTimer);backupTooltip.hidden=true;}
function showBackupTooltip(button){
 clearTimeout(archiveHideTimer);const record=requests.find(r=>r.id===button.dataset.archive);if(!record)return;
 backupTooltip.innerHTML=backupTooltipContents(record);backupTooltip.hidden=false;
 const rect=button.getBoundingClientRect(),width=backupTooltip.offsetWidth,height=backupTooltip.offsetHeight;
 backupTooltip.style.left=Math.max(8,Math.min(rect.left,innerWidth-width-8))+'px';
 backupTooltip.style.top=Math.max(8,rect.bottom+height+8<innerHeight?rect.bottom+6:rect.top-height-6)+'px';
}
const deferHideBackupTooltip=()=>{clearTimeout(archiveHideTimer);archiveHideTimer=setTimeout(hideBackupTooltip,140);};
$('#trajectory').addEventListener('pointerover',e=>{const button=e.target.closest('[data-archive]');if(button)showBackupTooltip(button);});
$('#trajectory').addEventListener('pointerout',e=>{if(e.target.closest('[data-archive]')&&!e.relatedTarget?.closest?.('[data-archive]'))deferHideBackupTooltip();});
$('#trajectory').addEventListener('focusin',e=>{const button=e.target.closest('[data-archive]');if(button)showBackupTooltip(button);});
$('#trajectory').addEventListener('focusout',e=>{if(e.target.closest('[data-archive]'))deferHideBackupTooltip();});
$('#trajectory').addEventListener('click',e=>{const button=e.target.closest('[data-archive]');if(button){e.preventDefault();e.stopPropagation();showBackupTooltip(button);}});
backupTooltip.onpointerenter=()=>clearTimeout(archiveHideTimer);backupTooltip.onpointerleave=deferHideBackupTooltip;
$('#trajectory').addEventListener('scroll',hideBackupTooltip,{passive:true});window.addEventListener('resize',hideBackupTooltip);document.addEventListener('keydown',e=>{if(e.key==='Escape')hideBackupTooltip();});
function exchangeGroup(r,direction,number,contents){
 const key=r.id+':'+direction,state=trajectoryState(),expanded=state.items.has(key)?state.items.get(key):state.expanded;
 const isRequest=direction==='request',count=(contents.match(/<details class="event /g)||[]).length;
 const kind=isRequest?requestTrigger(r):'response',label=isRequest?(kind==='tool'?'工具返回请求':'用户请求'):'LLM 响应';
 const fragment=document.createElement('div');fragment.innerHTML=contents;const candidates=[...fragment.querySelectorAll(':scope > .event')];
 // Repeated history is nested in its own disclosure; direct user events are new.
 const firstNewUser=isRequest&&kind==='user'&&number!=='01';
 const preview=firstNewUser?candidates.find(el=>el.classList.contains('user')):isRequest?candidates.filter(el=>(el.classList.contains('user')||el.classList.contains('tool'))&&!el.querySelector('.event-title')?.textContent.startsWith('工具定义')).at(-1):candidates.find(el=>el.classList.contains('assistant'))||candidates[0];
 const text=(preview?.querySelector('.event-content,.tool-box')?.textContent||(firstNewUser?'本次请求没有新增用户指令':fragment.textContent)).replace(/\s+/g,' ').trim();
 const responseUsage=isRequest?'':(()=>{const u=usage(r);return `<span class="response-usage" aria-label="响应 Token 用量">${['input','cached','output'].map(key=>`<span>${key} <b>${u[key]==null?'—':u[key].toLocaleString('en-US')}</b></span>`).join('')}</span>`;})();
 const description=isRequest?'':(r.httpStatus?'HTTP '+r.httpStatus:'等待上游')+' · '+(r.stream?'SSE':'JSON')+' · '+ms(r.durationMs);
 return `<details class="exchange-group ${direction} kind-${kind}" data-event="${esc(key)}" data-kind="${kind}" ${expanded?'open':''}><summary aria-label="${label} ${number}，展开或收起"><span class="exchange-icon">${isRequest?(kind==='tool'?'⌘':'↗'):'↙'}</span><span class="exchange-heading"><strong>${label} ${number}${isRequest?`<span class="request-model" title="模型：${esc(r.model||r.request?.model||'unknown')}">${esc(r.model||r.request?.model||'unknown')}</span>`:''}${isRequest?roundFlags(r,kind):archiveIndicator(r)}${description?`<span>${esc(description)}</span>`:''}${responseUsage}</strong><span class="exchange-description">${esc(text.slice(0,160))}</span></span><span class="exchange-count">${count} 项</span><button type="button" class="event-chevron disclosure-toggle" aria-label="展开或收起">›</button></summary><div class="exchange-body"><div class="exchange-toolbar"><span>${isRequest?'本次请求的内容':'上游返回的具体内容'}</span><button class="request-select" data-request="${esc(r.id)}" data-direction="${direction}">原文与详情 ↗</button></div>${contents}</div></details>`;
}
function usage(r){
 let result={};const merge=p=>{const u=p?.usage||p?.response?.usage||p?.message?.usage;if(u)for(const[k,v]of Object.entries(u))if(v!=null)result[k]=typeof v==='object'?{...result[k],...v}:v;};
 try{merge(JSON.parse(r.response));}catch{for(const line of (r.response||'').split('\n'))if(line.startsWith('data:'))try{merge(JSON.parse(line.slice(5)));}catch{}}
 const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
 let input=number(result.prompt_tokens??result.input_tokens);
 const cached=number(result.prompt_tokens_details?.cached_tokens??result.input_tokens_details?.cached_tokens??result.prompt_cache_hit_tokens??result.cache_read_input_tokens);
 if(input!==null&&('cache_read_input_tokens'in result||'cache_creation_input_tokens'in result))input+=(number(result.cache_read_input_tokens)||0)+(number(result.cache_creation_input_tokens)||0);
 return {input,cached,output:number(result.completion_tokens??result.output_tokens)};
}
function selectRequest(id,direction){selectedRequest=id;rawTab=direction;renderDetail();}
function updateDisclosureButtons(){
 $$('#trajectory details[data-event]').forEach(detail=>{const button=detail.querySelector(':scope > summary .disclosure-toggle');if(button)button.setAttribute('aria-expanded',String(detail.open));});
}
$('#trajectory').addEventListener('click',event=>{
 const group=event.target.closest('.exchange-group');if(!group)return;
 const summary=event.target.closest('summary');
 if(summary)event.preventDefault();
 const toggle=event.target.closest('.disclosure-toggle');
 if(toggle){const detail=toggle.closest('details');detail.open=!detail.open;updateDisclosureButtons();}
 const key=group.dataset.event,direction=group.classList.contains('request')?'request':'response';
 selectRequest(key.slice(0,-direction.length-1),direction);
});

$('#trajectory').addEventListener('dblclick',event=>{
 const summary=event.target.closest('summary');if(!summary||!summary.closest('.exchange-group'))return;
 if(event.target.closest('button,a,input,select,textarea'))return;
 event.preventDefault();const detail=summary.closest('details');detail.open=!detail.open;
 updateDisclosureButtons();updateBulkToggle();
});

function renderDetail(){const r=requests.find(x=>x.id===selectedRequest)||requests.at(-1);if(!r){$('#detail').innerHTML='<h3>请求详情</h3><div class="empty">等待第一条请求</div>';return;}$$('#trajectory .exchange-group').forEach(el=>{const active=el.dataset.event===r.id+':'+rawTab;el.classList.toggle('is-selected',active);el.classList.remove('timeline-target');});const u=usage(r);
 $('#detail').innerHTML=`<h3>请求详情 <span class="badge">${r.httpStatus||'LIVE'}</span></h3><div class="section-label">MODEL & PROVIDER</div>${kv('模型',r.model,'purple')}${kv('Provider',r.providerName)}${kv('协议',r.protocol)}${kv('传输',r.stream?'SSE streaming':'JSON')}<div class="section-label">PERFORMANCE</div>${kv('首字节延迟',r.ttftMs===null?'—':ms(r.ttftMs))}${kv('总耗时',ms(r.durationMs))}${kv('Input tokens',u.input==null?'—':fmt(u.input))}${kv('Cached input',u.cached==null?'—':fmt(u.cached))}${kv('Output tokens',u.output==null?'—':fmt(u.output))}${kv('响应大小',(r.bytes/1024).toFixed(2)+' KB')}<div class="section-label">SESSION GROUPING</div>${kv('归类方式',r.sessionMethod==='explicit'?'显式 Session ID':r.sessionMethod==='response-chain'?'Responses 链接':({'tool-call-link':'工具调用 ID 续接','context-continuation':'上下文与响应续接','context-overlap':'上下文尾部重合','ambiguous-context':'候选冲突，新建会话','new-session':'新会话，未发现续接'}[r.sessionMethod]||'旧版对话启发式'))}<div class="mini-code">${esc(r.sessionId)}</div>${r.sessionEvidence?`<div class="section-label">关联依据</div><pre class="raw">${esc(JSON.stringify(r.sessionEvidence,null,2))}</pre>`:''}${r.truncated?'<p class="hint">响应超过 32 MiB，录制已截断；转发不受此限制。</p>':''}${r.error?`<p class="hint">${esc(r.error)}</p>`:''}<div class="detail-tabs"><button data-raw="request" class="${rawTab==='request'?'selected':''}">Request</button><button data-raw="response" class="${rawTab==='response'?'selected':''}">Response</button></div><pre class="raw">${esc(rawTab==='request'?JSON.stringify(r.request,null,2):r.response)}</pre>`;
 $$('[data-raw]').forEach(b=>b.onclick=()=>{rawTab=b.dataset.raw;renderDetail();});
}
async function loadSession(){
 if(!selected){$('#trajectory-head').innerHTML='<h2>开始记录你的第一个 Agent Session</h2>';$('#trajectory').innerHTML='<div class="empty">添加 Provider 后，将本地地址填入 Harness。<br>或者点击「＋ 演示」体验完整录制链路。</div>';requests=[];renderDetail();return;}
 const id=selected,list=await api('/api/sessions/'+encodeURIComponent(id));if(id!==selected)return;
 const signature=JSON.stringify(list.map(r=>[r.id,r.status,r.bytes,r.durationMs,r.fileBackupEnabled,r.fileBackup?.status,r.fileBackup?.files?.length]));if(signature===lastSignature)return;lastSignature=signature;hideBackupTooltip();requests=list;toolOperationIndex=indexToolOperations(list);
 const s=state.sessions.find(s=>s.id===id);if(!s)return;
 $('#trajectory-head').innerHTML=`<div class="trace-label">SESSION TRAJECTORY<button id="export">↓ 导出 JSON</button></div><h2>${esc(s.title)}</h2><div class="trace-sub"><span class="ok">● ${s.status==='streaming'?'录制中':s.errors?'包含异常':'已完成'}</span><span>${esc(s.providerName)}</span><span>${s.count} 次请求</span><span>${esc(date(s.startedAt))}</span></div><div id="timeline"></div>`;
 $('#export').onclick=()=>{const a=document.createElement('a');a.href='/api/sessions/'+encodeURIComponent(id)+'?export=1';a.download='session.json';a.click();};
 let html=s.demo?'<div class="demo-notice">◈ 演示会话 · 由本地模拟上游生成，经过实际代理链路，不代表真实模型输出。</div>':'';
 html+='<div class="trajectory-bulk-control"><button id="toggle-all" aria-expanded="false">+ 全部展开</button></div>';
 for(const[rindex,r]of list.entries()){
   const queryEnd=rindex===list.length-1||requestTrigger(list[rindex+1])==='user';
   const number=String(rindex+1).padStart(2,'0');
   eventRequestId=r.id+':request';eventIndex=0;
   const requestBody=requestEvents(r,list[rindex-1]);
   html+=exchangeGroup(r,'request',number,requestBody);
   eventRequestId=r.id+':response';eventIndex=0;
   html+=exchangeGroup(r,'response',number,responseEvents(r)).replace('exchange-group response ',`exchange-group response ${queryEnd?'query-end':'round-end'} `);
 }
 $('#trajectory').innerHTML=html;updateBulkToggle();updateDisclosureButtons();$('#toggle-all').onclick=()=>setAllEvents($('#toggle-all').dataset.expanded!=='true');$$('[data-request]').forEach(b=>b.onclick=()=>{selectRequest(b.dataset.request,b.dataset.direction);toast('已切换'+(rawTab==='request'?'请求':'响应')+'详情');});renderDetail();
 mountTimeline($('#timeline'),$('#trajectory'),list,requestTrigger);
}
function renderProviders(){ $('#providers').innerHTML=state.providers.map(p=>`<article class="provider-card"><span class="badge">${p.demo?'LOCAL DEMO':esc(p.protocol.toUpperCase())}</span><h2>${esc(p.name)} ${p.id===state.defaultProviderId?'<span class="badge">默认 Provider</span>':''}</h2><p>${esc(p.url)}</p><div class="section-label">LOCAL BASE URL</div><code>${esc(p.openaiUrl)}</code><button class="secondary" data-copy="${esc(p.openaiUrl)}">复制 OpenAI 地址</button> <button class="secondary" data-copy="${esc(p.localUrl)}">复制 Anthropic 地址</button></article>`).join('')||'<div class="empty">添加你的第一个 Provider。</div>';$$('[data-copy]').forEach(b=>b.onclick=()=>copy(b.dataset.copy));}
function renderConnect(){
 const old=$('#guide-provider')?.value;
 $('#connect-content').innerHTML=`<div class="guide-card"><h2>01 &nbsp; 选择 Provider</h2><select id="guide-provider" aria-label="选择接入 Provider">${state.providers.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}${p.demo?'（仅本地演示）':''}</option>`).join('')}</select><p>Local demo 仅用于 Chat Completions 演示。真实使用请添加自己的 Provider。Provider 协议需与 Harness 匹配。当前版本透传协议，不执行 OpenAI 与 Anthropic 之间的协议转换。</p></div><div id="guide-snippets"></div><div class="guide-card"><h2>03 &nbsp; 为 Session 设置稳定标识</h2><p>建议由 Harness / Wrapper 在同一会话的每个请求中注入 <code>X-Session-ID: your-session-id</code>。也支持 <code>metadata.session_id</code>、<code>session_id</code> 和 <code>x-codex-session-id</code> Header。没有显式 ID 时，Responses 优先通过 previous_response_id 关联；其余请求优先匹配上一响应的工具调用 ID，再检查「旧请求历史 + 旧响应 + 新消息/工具结果」是否连续；压缩后保留的完整长响应与相邻上下文也可辅助续接。不再使用 30 分钟超时；多个候选时新建并标记冲突。内容匹配无法完全区分会话分叉，精确归类仍需显式 ID。</p><p>UI 的首字节耗时从接收请求起算，包含上游推理等待，不是网关增加的延迟。Token 数仅在上游返回 usage 时展示。</p></div>`;
 if(old&&state.providers.some(p=>p.id===old))$('#guide-provider').value=old;$('#guide-provider').onchange=renderSnippets;renderSnippets();
}
function renderSnippets(){const p=state.providers.find(p=>p.id===$('#guide-provider').value);if(!p){$('#guide-snippets').innerHTML='';return;}
 const snippets=[['OpenAI SDK / DeepSeek compatible harness',`OPENAI_BASE_URL=${p.openaiUrl}\nOPENAI_API_KEY=<你的 Provider API Key>\n\n# Harness 是否读取环境变量，取决于其自身配置方式。\n# 如有 Base URL 设置项，直接粘贴上方地址。`],['Claude Code · Anthropic endpoint',`ANTHROPIC_BASE_URL=${p.localUrl} \\\nANTHROPIC_API_KEY=<你的 Anthropic Provider API Key> \\\nclaude`],['Codex · config.toml',`model_provider = "trace"\n# model 选择你的 Provider 支持的模型\n\n[model_providers.trace]\nname = "Trace Gateway"\nbase_url = "${p.openaiUrl}"\nwire_api = "responses"\nenv_key = "TRACE_PROVIDER_API_KEY"\nsupports_websockets = false\n\n# 启动前设置 TRACE_PROVIDER_API_KEY 为你的上游密钥\n# 该 Provider 必须支持 Responses API`]];
 $('#guide-snippets').innerHTML=snippets.map(([name,code])=>`<div class="guide-card"><h2>02 &nbsp; ${esc(name)}</h2><pre>${esc(code)}</pre><button class="secondary" data-copy="${esc(code)}">复制配置</button></div>`).join('');$$('[data-copy]').forEach(b=>b.onclick=()=>copy(b.dataset.copy));
}
async function refresh(){try{state=await api('/api/state');$('#error-banner').hidden=!state.recordingError;$('#error-banner').textContent=state.recordingError?'录制存储异常：'+state.recordingError:'';$('#session-count').textContent=state.sessions.length;if(!selected&&state.sessions.length)selected=state.sessions[0].id;renderSessions();if(view==='sessions')await loadSession();}catch(e){$('#error-banner').hidden=false;$('#error-banner').textContent='连接网关失败：'+e.message;}}
let disposeTimeline=()=>{};
function mountTimeline(host,trajectory,list,trigger){
 disposeTimeline();
 const ui=trajectoryState();ui.zoom??=1;ui.timelineLeft??=0;
 const rows=[['user','用户请求'],['response','LLM 响应'],['tool','工具返回']];
 const items=list.flatMap((r,i)=>[{key:r.id+':request',kind:trigger(r),round:i+1,slot:i*2},{key:r.id+':response',kind:'response',round:i+1,slot:i*2+1}]);
 if(!items.length){host.innerHTML='';return;}
 const queries=[];for(const [index,r]of list.entries()){if(!queries.length||trigger(r)==='user')queries.push({start:index,end:index+1});else queries.at(-1).end=index+1;}
 const roundCount=list.length;const tokenUsage=list.map(usage);
 const tokenSeries=[['input','输入','#6284d6'],['cached','Cached 输入','#32a48a'],['output','输出','#d49a47']];
 host.innerHTML=`<div class="timeline-caption"><span>轮次切片 <small id="timeline-scale"></small></span><button class="timeline-reset">适应全部</button></div><div class="timeline-layout"><div class="timeline-labels"><span class="timeline-axis-label">轮次</span><span class="timeline-query-label">Query</span>${rows.map(([kind,label])=>`<span class="kind-${kind}"><i></i>${label}</span>`).join('')}<div class="token-y-axis"><span>Tokens</span><span class="token-y-max"></span><span class="token-y-zero">0</span></div></div><div class="timeline-scroll" tabindex="0" aria-label="会话轮次轴，滚轮缩放，点击定位"><div class="timeline-canvas">${rows.map(([kind])=>`<div class="timeline-lane lane-${kind}"></div>`).join('')}<svg class="token-chart" height="94" role="img" aria-label="每轮输入、缓存输入和输出 Token 折线图"></svg><div class="timeline-axis"></div><div class="timeline-query-axis"></div><div class="timeline-window" aria-label="下方轨迹可见范围"><button class="timeline-grip" aria-label="拖动轨迹可见范围">⋮⋮</button></div></div></div></div><div class="token-legend"><span class="legend-input">● 输入</span><span class="legend-cached">● Cached 输入</span><span class="legend-output">● 输出</span><small>输入含缓存 · 缺失数据断线</small></div><button class="token-toggle" aria-expanded="false">+ 展开token消耗</button><div class="timeline-help">滚轮缩放 · 底部横向滚动 · 点击切片定位 · 拖动滑窗浏览</div>`;
 host.classList.toggle('tokens-open',!!ui.tokensOpen);
 const tokenTooltip=document.createElement('div');tokenTooltip.className='token-tooltip';tokenTooltip.id='token-point-tooltip';tokenTooltip.setAttribute('role','tooltip');tokenTooltip.hidden=true;document.body.append(tokenTooltip);
 function hideTokenTooltip(){tokenTooltip.hidden=true;}
 function showTokenTooltip(dot,index,key,event){
   const u=tokenUsage[index];tokenTooltip.innerHTML=`<strong>第 ${index+1} 轮 · Token 消耗</strong>${tokenSeries.map(([field,label,color])=>`<div class="token-tooltip-row ${field===key?'highlight':''}"><span>${label}</span><b>${u[field]===null?'未返回':fmt(u[field])}</b></div>`).join('')}<small>输入包含 Cached 输入</small>`;
   tokenTooltip.hidden=false;
   const rect=dot.getBoundingClientRect(),x=event?.clientX??rect.x+rect.width/2,y=event?.clientY??rect.y;
   const box=tokenTooltip.getBoundingClientRect();tokenTooltip.style.left=Math.max(8,Math.min(innerWidth-box.width-8,x+12))+'px';tokenTooltip.style.top=Math.max(8,y-box.height-10<8?Math.min(innerHeight-box.height-8,y+14):y-box.height-10)+'px';
 }
 const tokenToggle=host.querySelector('.token-toggle');
 function updateTokenToggle(){tokenToggle.textContent=ui.tokensOpen?'- 折叠token消耗':'+ 展开token消耗';tokenToggle.setAttribute('aria-expanded',String(!!ui.tokensOpen));host.classList.toggle('tokens-open',!!ui.tokensOpen);}
 updateTokenToggle();tokenToggle.onclick=()=>{hideTokenTooltip();ui.tokensOpen=!ui.tokensOpen;updateTokenToggle();};
 const scroll=host.querySelector('.timeline-scroll'),canvas=host.querySelector('.timeline-canvas'),axis=host.querySelector('.timeline-axis'),windowEl=host.querySelector('.timeline-window');
 let width=1,frame=0,drag=null;
 const groups=new Map([...trajectory.querySelectorAll('.exchange-group')].map(el=>[el.dataset.event,el]));
 const groupFor=item=>groups.get(item.key);
 function go(item){const group=groupFor(item);if(!group)return;trajectory.scrollTop+=group.getBoundingClientRect().top-trajectory.getBoundingClientRect().top-7;trajectory.querySelectorAll('.timeline-target').forEach(el=>el.classList.remove('timeline-target'));group.classList.add('timeline-target');selectRequest(item.key.slice(0,item.key.lastIndexOf(':')),item.kind==='response'?'response':'request');sync();}
 function nearest(px,kind){const round=Math.max(1,Math.min(roundCount,Math.floor(px/width*roundCount)+1));const candidates=items.filter(x=>x.round===round);return candidates.find(x=>x.kind===kind)||items[Math.max(0,Math.min(items.length-1,Math.floor(px/width*items.length)))];}
 function sync(){ui.traceScroll=trajectory.scrollTop;cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{
   const bounds=trajectory.getBoundingClientRect();const visible=items.filter(item=>{const g=groupFor(item);if(!g)return false;const rect=g.getBoundingClientRect();return rect.bottom>bounds.top+1&&rect.top<bounds.bottom-1;});
   if(!visible.length)return;
   const left=Math.min(...visible.map(x=>x.slot/items.length*width)),right=Math.max(...visible.map(x=>(x.slot+1)/items.length*width));
   const size=Math.min(width,Math.max(18,right-left+8));windowEl.style.width=size+'px';windowEl.style.left=Math.min(Math.max(0,left-4),width-size)+'px';
   const visibleKeys=new Set(visible.map(x=>x.key));host.querySelectorAll('.timeline-mark').forEach(el=>el.classList.toggle('in-window',visibleKeys.has(el.dataset.key)));
 });}
 function draw(){width=Math.max(1,scroll.clientWidth,ui.fitRounds?0:roundCount*64)*ui.zoom;canvas.style.width=width+'px';axis.innerHTML='';
   const step=Math.max(1,Math.ceil(roundCount/(width/45)));for(let round=1;round<=roundCount;round++){if((round-1)%step!==0&&round!==roundCount)continue;const tick=document.createElement('span');tick.textContent='第 '+round+' 轮';tick.style.left=((round-.5)/roundCount*100)+'%';axis.append(tick);}
   host.querySelectorAll('.timeline-mark,.timeline-divider,.query-divider').forEach(el=>el.remove());
   for(let round=1;round<roundCount;round++){if(queries.some(q=>q.start===round))continue;const divider=document.createElement('span');divider.className='timeline-divider';divider.setAttribute('aria-hidden','true');divider.style.left=(round/roundCount*100)+'%';canvas.append(divider);}
   const queryAxis=host.querySelector('.timeline-query-axis');queryAxis.replaceChildren();
   for(const [index,query]of queries.entries()){
     const band=document.createElement('button');band.className='query-band';band.textContent='Query '+String(index+1).padStart(2,'0');band.style.left=query.start/roundCount*100+'%';band.style.width=(query.end-query.start)/roundCount*100+'%';band.title=`Query ${index+1}：第 ${query.start+1}–${query.end} 轮，包含用户请求、LLM 响应与工具往返`;band.onclick=e=>{e.stopPropagation();go(items[query.start*2]);};queryAxis.append(band);
   }
   for(const boundary of [...queries.map(q=>q.start),roundCount]){
     const line=document.createElement('span');line.className='query-divider';line.setAttribute('aria-hidden','true');line.style.left=Math.max(2,Math.min(width-2,boundary/roundCount*width))+'px';canvas.append(line);
   }
   for(const item of items){const mark=document.createElement('button');mark.className='timeline-mark kind-'+item.kind;mark.dataset.key=item.key;mark.title=`第 ${item.round} 轮 · ${rows.find(x=>x[0]===item.kind)[1]}`;mark.setAttribute('aria-label',mark.title);mark.textContent=String(item.round).padStart(2,'0');const cell=width/items.length,bar=Math.min(cell*.76,80*ui.zoom);mark.style.left=(item.slot*cell+(cell-bar)/2)+'px';mark.style.width=bar+'px';mark.onclick=e=>{e.stopPropagation();go(item);};host.querySelector('.lane-'+item.kind).append(mark);}
   drawTokens();$('#timeline-scale').textContent='×'+ui.zoom.toFixed(1);sync();
 }
 function drawTokens(){
   hideTokenTooltip();
   const svg=host.querySelector('.token-chart');svg.replaceChildren();svg.setAttribute('width',width);svg.setAttribute('viewBox',`0 0 ${width} 94`);
   const values=tokenUsage.flatMap(u=>tokenSeries.map(([key])=>u[key])).filter(v=>v!==null);
   const max=Math.max(1,...values),unit=10**Math.floor(Math.log10(max)),ceiling=Math.ceil(max/unit)*unit;
   host.querySelector('.token-y-max').textContent=ceiling>=1000?(ceiling/1000).toLocaleString('en',{maximumFractionDigits:1})+'k':String(ceiling);
   const element=(tag,attrs)=>{const el=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs))el.setAttribute(k,v);svg.append(el);return el;};
   for(const y of [10,44,78])element('line',{x1:0,x2:width,y1:y,y2:y,stroke:'#eceef5','stroke-width':1});
   for(const[key,label,color]of tokenSeries){
     let path='',connected=false;
     for(const [index,u]of tokenUsage.entries()){
       if(u[key]===null){connected=false;continue;}
       const x=(index*2+1.5)/items.length*width,y=78-u[key]/ceiling*68;
       path+=(connected?' L':' M')+x+','+y;connected=true;
     }
     element('path',{d:path,fill:'none',stroke:color,'stroke-width':1.5,'vector-effect':'non-scaling-stroke','data-series':key});
     for(const [index,u]of tokenUsage.entries()){
       if(u[key]===null)continue;
       const dot=element('circle',{cx:(index*2+1.5)/items.length*width,cy:78-u[key]/ceiling*68,r:2.8,fill:color,stroke:'white','stroke-width':.8,'data-series':key,'data-round':index+1,'data-value':u[key],tabindex:0});
       const description=`第 ${index+1} 轮 · ${label} ${fmt(u[key])} tokens\n输入 ${u.input===null?'未返回':fmt(u.input)} · Cached 输入 ${u.cached===null?'未返回':fmt(u.cached)} · 输出 ${u.output===null?'未返回':fmt(u.output)}`;
       dot.setAttribute('aria-label',description);dot.setAttribute('aria-describedby','token-point-tooltip');dot.onpointerenter=e=>showTokenTooltip(dot,index,key,e);dot.onpointermove=e=>showTokenTooltip(dot,index,key,e);dot.onpointerleave=hideTokenTooltip;dot.onfocus=()=>showTokenTooltip(dot,index,key);dot.onblur=hideTokenTooltip;dot.onclick=e=>{e.stopPropagation();go(items[index*2+1]);};dot.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();go(items[index*2+1]);}};
     }
   }
   if(!values.length){const label=element('text',{x:width/2,y:47,'text-anchor':'middle',fill:'#a3aaba','font-size':9});label.textContent='上游未返回 Token usage';}
 }
 function wheel(e){e.preventDefault();const oldWidth=width,offset=e.clientX-scroll.getBoundingClientRect().left;const ratio=(scroll.scrollLeft+offset)/oldWidth;ui.zoom=Math.max(1,Math.min(64,ui.zoom*Math.exp(-Math.max(-200,Math.min(200,e.deltaY||e.deltaX))*.006)));draw();scroll.scrollLeft=ratio*width-offset;ui.timelineLeft=scroll.scrollLeft;}
 function down(e){e.preventDefault();drag={x:e.clientX,left:parseFloat(windowEl.style.left)||0};e.target.setPointerCapture(e.pointerId);}
 function move(e){if(!drag)return;const px=drag.left+(e.clientX-drag.x);go(nearest(px));}
 function up(){drag=null;}
 scroll.addEventListener('wheel',wheel,{passive:false});scroll.addEventListener('click',e=>{if(e.target.closest('.timeline-grip'))return;go(nearest(e.clientX-canvas.getBoundingClientRect().left,rows.find(([kind])=>e.target.closest('.lane-'+kind))?.[0]));});scroll.onscroll=()=>{ui.timelineLeft=scroll.scrollLeft;hideTokenTooltip();};
 const grip=host.querySelector('.timeline-grip');grip.onpointerdown=down;grip.onpointermove=move;grip.onpointerup=up;grip.onpointercancel=up;
 host.querySelector('.timeline-reset').onclick=()=>{ui.zoom=1;ui.fitRounds=true;ui.timelineLeft=0;draw();scroll.scrollLeft=0;};
 trajectory.addEventListener('scroll',sync,{passive:true});trajectory.addEventListener('toggle',sync,true);const resize=new ResizeObserver(()=>draw());resize.observe(scroll);
 trajectory.scrollTop=ui.traceScroll||0;draw();scroll.scrollLeft=ui.timelineLeft;
 disposeTimeline=()=>{tokenTooltip.remove();cancelAnimationFrame(frame);resize.disconnect();trajectory.removeEventListener('scroll',sync);trajectory.removeEventListener('toggle',sync,true);scroll.removeEventListener('wheel',wheel);};
}

await refresh();setInterval(()=>{if(uiPrefs.autoRefresh)refresh();},2500);
