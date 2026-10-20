const MASK='[REDACTED]';
const sensitive=key=>/^(?:x_)?api_?key$|^authorization$|^proxy_authorization$|^(?:access|refresh|bearer)_token$|^(?:client_secret|secret_key|password)$/.test(key.toLowerCase().replace(/[-\s]/g,'_'));
export function captureSecrets(headers,into){
 for(const [key,value]of Object.entries(headers))if(sensitive(key))for(const text of Array.isArray(value)?value:[value]){
  if(typeof text!=='string')continue;const secret=text.replace(/^(?:Bearer|Basic)\s+/i,'');if(secret.length>=4&&secret!==MASK)into.add(secret);
 }
}
export function redact(value,secrets=new Set()){
 const visit=x=>{
  if(Array.isArray(x))return x.map(visit);
  if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,sensitive(k)?MASK:visit(v)]));
  if(typeof x!=='string')return x;
  let text=x;
  for(const secret of secrets)if(secret.length>=4)text=text.replaceAll(secret,MASK);
  // Nested JSON strings include tool arguments and non-streaming response bodies.
  if(/^\s*[\[{]/.test(text)){try{return JSON.stringify(visit(JSON.parse(text)));}catch{}}
  // SSE events are independently sanitized; unknown event types remain intact.
  if(/(^|\n)data:/.test(text))return text.split(/(\r?\n)/).map(line=>line.startsWith('data:')?'data: '+visit(line.slice(5).trim()):line).join('');
  text=text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,(_,scheme)=>scheme+' '+MASK);
  text=text.replace(/\bsk-(?:proj-|ant-[A-Za-z0-9]+-)?[A-Za-z0-9_-]{12,}/g,MASK);
  // Credentials in prose, shell snippets, URL query strings, and env assignments.
  text=text.replace(/((?:[\w-]*api[_-]?key|authorization|proxy[_-]authorization|access[_-]token|refresh[_-]token|bearer[_-]token|client[_-]secret|secret[_-]key|password)["']?\s*(?::|=)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;}]+)/gi,'$1'+MASK);
  return text;
 };
 return visit(value);
}
