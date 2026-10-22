#!/usr/bin/env node
import {writeFile,mkdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG,loadConfig} from './common.mjs';
import {prepare} from './samples.mjs';
import {replay} from './runner.mjs';
import {evaluate} from './verifiers.mjs';
import {build,publish} from './policy.mjs';

const help=`Trace Lab v1 — offline evidence and routing experiments
Usage: trace-lab <command> --config /path/lab.json [options]
  init      --out /path/lab.json      Write a configuration template
  prepare                            Sample query traces and copy evidence
  replay    --sample <id|all>         Restore files and run Claude via replay proxy
  evaluate  --run <id|all>            Run a pluggable verifier
  build                              Build lexical policy with held-out calibration
  publish   --policy <id>             Publish a validated local policy bundle
No command restarts or reconfigures the online gateway.
`;
export async function main(args=process.argv.slice(2)){
 if(!args.length||args.includes('--help')){console.log(help);return;}
 const [command,...rest]=args,opts={};
 for(let i=0;i<rest.length;i+=2){if(!['--config','--out','--sample','--run','--policy'].includes(rest[i])||!rest[i+1]||Object.hasOwn(opts,rest[i]))throw new Error('Invalid or duplicate CLI option');opts[rest[i]]=rest[i+1];}
 if(command==='init'){
  if(!opts['--out'])throw new Error('--out is required');const dest=path.resolve(opts['--out']);await mkdir(path.dirname(dest),{recursive:true,mode:0o700});await writeFile(dest,JSON.stringify(DEFAULT_CONFIG,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify({config:dest,requiresConfiguration:true}));return;
 }
 if(!opts['--config'])throw new Error('--config is required');const c=await loadConfig(path.resolve(opts['--config']));
 let result;
 switch(command){case 'prepare':result=await prepare(c);break;case 'replay':result=await replay(c,opts['--sample']||'all');break;case 'evaluate':result=await evaluate(c,opts['--run']||'all');break;case 'build':result=await build(c);break;case 'publish':result=await publish(c,opts['--policy']);break;default:throw new Error('Unknown command: '+command);}
 console.log(JSON.stringify(result,null,2));
 if(command==='replay'&&result.some(r=>r.status==='invalid'))process.exitCode=1;
}
const canonical=p=>realpath(p).catch(()=>path.resolve(p));
if(process.argv[1]&&await canonical(process.argv[1])===await canonical(fileURLToPath(import.meta.url)))main().catch(e=>{console.error('trace-lab: '+e.message);process.exitCode=1;});
