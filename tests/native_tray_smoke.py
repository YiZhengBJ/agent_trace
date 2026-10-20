#!/usr/bin/env python3
"""macOS packaged app smoke test; uses a temporary data directory and random port."""
import contextlib,json,os,pathlib,socket,subprocess,tempfile,time
ROOT=pathlib.Path(__file__).resolve().parents[1];APP=ROOT/'dist/Trace Gateway.app/Contents/MacOS'
with tempfile.TemporaryDirectory(prefix='trace-tray-')as temp:
 home=pathlib.Path(temp);s=socket.socket();s.bind(('127.0.0.1',0));port=s.getsockname()[1];s.close();log=open(home/'launch.log','w');env=os.environ.copy();env['TRACE_HOME']=str(home)
 process=subprocess.Popen([str(APP/'trace-desktop'),'--home',str(home),'--port',str(port)],stdout=log,stderr=log,env=env)
 def cli(*args):return json.loads(subprocess.check_output([str(APP/'trace'),'--home',str(home),'--port',str(port),'--json',*args],text=True,timeout=15))
 try:
  for _ in range(100):
   if process.poll()is not None:raise RuntimeError((home/'launch.log').read_text())
   if cli('status')['running']:break
   time.sleep(.1)
  else:raise RuntimeError('Native tray did not start gateway')
  duplicate=subprocess.run([str(APP/'trace-desktop'),'--home',str(home),'--port',str(port)],env=env,capture_output=True,timeout=10);assert duplicate.returncode==0
  process.terminate();process.wait(timeout=10);assert cli('status')['running'];cli('stop');assert not cli('status')['running'];print('PASS: packaged Tauri startup, single tray instance, daemon survives tray exit, CLI lifecycle.')
 finally:
  if process.poll()is None:process.terminate();process.wait(timeout=10)
  with contextlib.suppress(Exception):cli('stop')
  log.close()
