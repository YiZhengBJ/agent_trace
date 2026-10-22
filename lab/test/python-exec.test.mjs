import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,symlink} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {pythonScript,pythonRuntime,executePython} from '../python-exec.mjs';
test('restricted Python command parser accepts one path and no shell syntax',()=>{
 assert.equal(pythonScript('python3 "/a b/main.py"'),'/a b/main.py');assert.equal(pythonScript("python3 'main.py'"),'main.py');
 for(const s of ['python3 -c "print(1)"','python3 a.py && echo x','python3 a.py > x','python3 a.py arg','python3 $(pwd)/a.py','bash a.py','python3 -a.py','python3 a.py\nrm -rf x'])assert.throws(()=>pythonScript(s));
});
test('macOS Python sandbox enforces file, network, subprocess and execution bounds',{skip:process.platform!=='darwin'},async()=>{
 const base=await mkdtemp(path.join(tmpdir(),'trace-python-security-')),workspace=path.join(base,'workspace');const {mkdir}=await import('node:fs/promises');await mkdir(workspace);const outside=path.join(base,'secret.txt');await writeFile(outside,'PRIVATE');const runtime=await pythonRuntime();
 const run=async(code,options={})=>{await writeFile(path.join(workspace,'main.py'),code);return executePython({script:'main.py',workspace,runtime,...options});};
 try{
  let r=await run('print("sandbox ok")');assert.equal(r.valid,true,JSON.stringify(r));assert.equal(r.stdout,'sandbox ok\n');
  r=await run(`open(${JSON.stringify(outside)}).read()`);assert.equal(r.valid,false);assert.ok(!r.stdout.includes('PRIVATE'));
  r=await run(`open(${JSON.stringify(outside)},'w').write('changed')`);assert.equal(r.valid,false);assert.equal(await readFile(outside,'utf8'),'PRIVATE');
  r=await run('import socket\nsocket.socket().connect(("127.0.0.1", 9))');assert.equal(r.valid,false);assert.match(r.stderr,/PermissionError|Operation not permitted/);
  r=await run('import subprocess\nsubprocess.run(["/bin/echo", "escape"],check=True)');assert.equal(r.valid,false);
  r=await run('while True: pass',{timeoutMs:100});assert.equal(r.reason,'timeout');
  r=await run('print("x"*100000)',{maxBytes:1000});assert.equal(r.reason,'output_limit');
  await symlink(outside,path.join(workspace,'link.py'));await assert.rejects(executePython({script:'link.py',workspace,runtime}));
 }finally{await rm(base,{recursive:true,force:true});}
});
