import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('aliased entrypoint starts and remains alive until supervisor pipe closes', {timeout: 15000}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'trace-entry-'));
  let child;
  try {
    const alias = path.join(root, 'gateway alias');
    const source = fileURLToPath(new URL('..', import.meta.url));
    await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
    child = spawn(process.execPath, ['--preserve-symlinks-main', path.join(alias, 'server.mjs')], {
      env: {...process.env, PORT: '0', DATA_DIR: path.join(root, 'data'), TRACE_SEED_DEMO: '0', TRACE_PARENT_WATCH: '1'},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', data => { log += data; });
    child.stderr.on('data', data => { log += data; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
    const deadline = Date.now() + 8000;
    while (!log.includes('Trace Gateway running at ') && child.exitCode === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.match(log, /Trace Gateway running at http:\/\/127\.0\.0\.1:\d+/, `No engine startup log: ${log}; exit=${child.exitCode}`);
    const base = log.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
    assert.equal((await fetch(base + '/api/health')).status, 200);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(child.exitCode, null, 'Engine must remain alive while supervisor holds stdin');
    child.stdin.end();
    assert.deepEqual(await exited, {code: 0, signal: null});
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    await rm(root, {recursive: true, force: true});
  }
});
