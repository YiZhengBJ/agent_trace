import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath,lstat} from 'node:fs/promises';
import path from 'node:path';
import {inside} from './common.mjs';

export function pythonScript(command){
 if(typeof command!=='string')throw new Error('Only python3 <captured-script.py> is supported');
 const m=command.match(/^python3\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"'`$;&|<>()\\]+))\s*$/);
 const script=m&&(m[1]||m[2]||m[3]);
 if(!script||!script.endsWith('.py')||script.startsWith('-')||script.includes('\0'))throw new Error('Only python3 <captured-script.py> is supported; flags, arguments and shell operators are disabled');
 return script;
}
const quote=value=>JSON.stringify(value);
export async function pythonRuntime(){
 if(process.platform!=='darwin')throw new Error('Restricted Python replay currently requires macOS sandbox-exec');
 const {stdout}=await promisify(execFile)('/usr/bin/python3',['-I','-c','import sys,os,json; print(json.dumps({"version":sys.version,"executable":os.path.realpath(sys.executable),"prefix":os.path.realpath(sys.prefix),"basePrefix":os.path.realpath(sys.base_prefix)}))'],{timeout:10000,maxBuffer:16384,env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'}});
 return JSON.parse(stdout);
}
export function pythonProfile(workspace,runtime){
 // No network, forks, external writes or access to the source project. The
 // interpreter can read its system runtime and the restored workspace only.
 const roots=[workspace,runtime.prefix,runtime.basePrefix,'/System/Library','/usr/lib','/usr/share/locale'];
 return `(version 1) (deny default) (allow process-exec (subpath ${quote(runtime.prefix)}) (literal ${quote(runtime.executable)})) (allow sysctl-read) (allow mach-lookup) (allow file-read-metadata) (allow file-read* (literal "/") (literal "/private") (literal "/usr") (literal "/Library") (literal "/System") ${roots.map(r=>`(subpath ${quote(r)})`).join(' ')} (literal ${quote(runtime.executable)}) (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random")) (allow file-write* (subpath ${quote(workspace)}) (literal "/dev/null"))`;
}
export async function executePython({script,workspace,runtime,signal,timeoutMs=10000,maxBytes=65536}){
 const root=await realpath(workspace),dest=path.resolve(root,script);
 if(!inside(root,dest)||dest===root||await realpath(dest)!==dest||!(await lstat(dest)).isFile())throw new Error('Python script must be a regular file inside the replay workspace');
 if(signal?.aborted)throw new Error('Python replay cancelled');
 const profile=pythonProfile(root,runtime);let stdout='',stderr='',size=0,reason;
 const child=spawn('/usr/bin/sandbox-exec',['-p',profile,runtime.executable,'-I','-B',dest],{cwd:root,env:{PATH:'/usr/bin:/bin',HOME:root,TMPDIR:root,LANG:'en_US.UTF-8'},stdio:['ignore','pipe','pipe'],detached:true});
 const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
 const abort=()=>{reason='cancelled';kill();};signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>{reason='timeout';kill();},timeoutMs);
 for(const [stream,key]of [[child.stdout,'stdout'],[child.stderr,'stderr']])stream.on('data',b=>{size+=b.length;if(size>maxBytes){reason='output_limit';kill();return;}if(key==='stdout')stdout+=b.toString();else stderr+=b.toString();});
 let exit;
 try{exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);kill();}
 return {executor:'macos-sandbox-python-v1',runtime:{executable:runtime.executable,version:runtime.version},script:path.relative(root,dest),exit,stdout,stderr,valid:!reason&&exit.code===0,reason:reason||(exit.code===0?null:'python_or_environment_error')};
}
