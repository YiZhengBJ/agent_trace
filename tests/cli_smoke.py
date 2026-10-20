#!/usr/bin/env python3
"""Native CLI + detached daemon + real mock-upstream end-to-end test."""
import contextlib, http.server, json, os, pathlib, socket, subprocess, tempfile, threading, time, signal, urllib.request, urllib.error
ROOT=pathlib.Path(__file__).resolve().parents[1]
BIN=pathlib.Path(os.environ.get('TRACE_TEST_BIN',str(ROOT/'target/release'/('trace.exe' if os.name=='nt' else 'trace'))))
class Mock(http.server.BaseHTTPRequestHandler):
 def do_POST(self):
  payload=json.loads(self.rfile.read(int(self.headers['content-length'])));assert payload['model']=='mock'
  assert self.headers['Authorization']=='Bearer opaque-test-key-12345'
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  events=[{'choices':[{'delta':{'content':'hello from upstream'}}]},{'choices':[],'usage':{'prompt_tokens':20,'prompt_tokens_details':{'cached_tokens':10},'completion_tokens':3}}]
  for event in events:self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode());self.wfile.flush()
  self.wfile.write(b'data: [DONE]\n\n')
 def log_message(self,*a):pass
with tempfile.TemporaryDirectory(prefix='trace-cli-')as temp:
 home=pathlib.Path(temp)/'long gateway home with spaces';home.mkdir()
 if os.name=='nt':
  # Reproduce runner TEMP aliases (RUNNER~1) instead of relying on its spelling.
  import ctypes
  from ctypes import wintypes
  short_path=ctypes.WinDLL('kernel32',use_last_error=True).GetShortPathNameW
  short_path.argtypes=[wintypes.LPCWSTR,wintypes.LPWSTR,wintypes.DWORD];short_path.restype=wintypes.DWORD
  buffer=ctypes.create_unicode_buffer(32768);length=short_path(str(home),buffer,len(buffer))
  if not length or length>=len(buffer):raise ctypes.WinError(ctypes.get_last_error())
  home=pathlib.Path(buffer.value)
 s=socket.socket();s.bind(('127.0.0.1',0));port=s.getsockname()[1];s.close();upstream=http.server.ThreadingHTTPServer(('127.0.0.1',0),Mock);threading.Thread(target=upstream.serve_forever,daemon=True).start()
 prefix=[str(BIN),'--home',str(home),'--port',str(port),'--runtime-dir',str(ROOT/'runtime'),'--json']
 def cli(*args):return json.loads(subprocess.check_output(prefix+list(args),text=True,timeout=25))
 try:
  assert not cli('status')['running'];assert cli('start')['running'];assert cli('start')['alreadyRunning'];assert cli('provider','list')==[]
  provider=cli('provider','add','--name','Mock','--url',f'http://127.0.0.1:{upstream.server_port}','--activate');assert cli('provider','current')['id']==provider['id'];assert cli('provider','list')[0]['active'];url=cli('provider','url')['openai']
  messages=[{'role':'user','content':'hello api_key=do-not-export'}]
  def send(messages):
   request=urllib.request.Request(url+'/chat/completions',data=json.dumps({'model':'mock','messages':messages,'stream':True}).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer opaque-test-key-12345'})
   with urllib.request.urlopen(request,timeout=5)as response:return response.read().decode()
  assert 'hello from upstream'in send(messages);messages += [{'role':'assistant','content':'hello from upstream'},{'role':'user','content':'continue'}];send(messages);time.sleep(.1)
  sessions=cli('session','list');assert len(sessions)==1 and sessions[0]['count']==2,sessions
  records=cli('session','show',sessions[0]['id']);assert records[-1]['sessionMethod']=='context-continuation';out=pathlib.Path(temp)/'export.json';assert cli('session','export',sessions[0]['id'],'--output',str(out))['redacted'];data=out.read_text();assert 'do-not-export'not in data and 'opaque-test-key-12345'not in data
  service=cli('service','install','--dry-run');assert service['dryRun'] and 'serve'in service['configuration']
  try:urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{port}/api/admin/shutdown',data=b'{}',headers={'Content-Type':'application/json'}));raise AssertionError('Unauthenticated shutdown allowed')
  except urllib.error.HTTPError as error:assert error.code==403
  assert not cli('stop')['running'];assert not cli('status')['running'];assert cli('start')['running'];assert len(cli('session','list'))==1
  if os.name!='nt':
   instance=json.loads((home/'instance.json').read_text());os.kill(instance['pid'],signal.SIGKILL)
   for _ in range(100):
    try:
     probe=socket.create_connection(('127.0.0.1',port),timeout=.1);probe.close()
    except OSError:break
    time.sleep(.05)
   else:raise AssertionError('Engine orphaned after supervisor died')
   assert cli('start')['running']
  cli('provider','remove',provider['id']);assert cli('provider','current')is None
  cli('stop');import_home=pathlib.Path(temp)/'imported';(import_home/'data/records').mkdir(parents=True);import_prefix=[str(BIN),'--home',str(import_home),'--json'];result=json.loads(subprocess.check_output(import_prefix+['import','--from',str(home/'data')],text=True));assert result['importedRecords']==2
  print('PASS: native CLI, detached daemon, idempotent start, providers/default/URLs, SSE forwarding, session continuation, redacted export, service dry-run, management auth, stop/restart persistence.')
 except Exception:
  log=home/'gateway.log'
  if log.exists():print(log.read_text())
  raise
 finally:
  with contextlib.suppress(Exception):cli('stop')
  upstream.shutdown();upstream.server_close()
