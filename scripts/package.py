#!/usr/bin/env python3
"""Build a native headless archive and optional Tauri installers; no user data copied."""
import argparse, os, pathlib, platform, shutil, subprocess, tarfile, zipfile, plistlib, urllib.request, uuid
ROOT=pathlib.Path(__file__).resolve().parents[1]
def run(*args,**kw): subprocess.run([str(a) for a in args],cwd=ROOT,check=True,**kw)
def fresh_copy(source,dest):
 # Replace the inode: macOS may kill an executable overwritten in place.
 temp=dest.with_name(dest.name+'.'+uuid.uuid4().hex+'.tmp')
 try:shutil.copy2(source,temp);os.replace(temp,dest)
 finally:temp.unlink(missing_ok=True)
def copy_lab(portable):
 # Offline engine is a separate entry point; it shares the bundled runtime only.
 shutil.copytree(ROOT/'lab',portable/'lab',dirs_exist_ok=True,ignore=shutil.ignore_patterns('test','__pycache__'))
 (portable/'gateway').mkdir(exist_ok=True);(portable/'scripts').mkdir(exist_ok=True)
 for name in ['record-store.mjs','file-backup.mjs','file-backup.example.json','session-matcher.mjs','tool-call-capture.mjs']:
  shutil.copy2(ROOT/'gateway'/name,portable/'gateway'/name)
 for name in ['trace-lab','trace-lab.cmd']:
  shutil.copy2(ROOT/'scripts'/name,portable/'scripts'/name)
def main():
 p=argparse.ArgumentParser();p.add_argument('--node');p.add_argument('--desktop',action='store_true');p.add_argument('--native-macos-bundle',action='store_true');p.add_argument('--skip-build',action='store_true');a=p.parse_args()
 node=a.node or shutil.which('node');fallback=pathlib.Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
 if not node and fallback.is_file():node=str(fallback)
 if not node: p.error('Build requires Node.js 22+ via --node. End users do not need Node.')
 major=int(subprocess.check_output([node,'-p','process.versions.node.split(".")[0]']).strip());assert major>=22,'Node.js 22+ required'
 target=subprocess.check_output(['rustc','-vV'],text=True).split('host: ')[1].splitlines()[0];suffix='.exe' if os.name=='nt' else ''
 runtime=ROOT/'runtime';runtime.mkdir(exist_ok=True);fresh_copy(node,runtime/('node'+suffix));version=subprocess.check_output([node,'-p','process.version'],text=True).strip();license_path=runtime/'LICENSE.node.txt';
 if not license_path.exists():license_path.write_bytes(urllib.request.urlopen(f'https://raw.githubusercontent.com/nodejs/node/{version}/LICENSE',timeout=30).read())
 if not a.skip_build:run('cargo','build','--locked','--release','-p','trace-gateway-cli')
 cli=ROOT/'target/release'/('trace'+suffix);bins=ROOT/'desktop/binaries';bins.mkdir(exist_ok=True);shutil.copy2(cli,bins/('trace-'+target+suffix));background=ROOT/'target/release'/('trace-background'+suffix);shutil.copy2(background,bins/('trace-background-'+target+suffix))
 dist=ROOT/'dist';dist.mkdir(exist_ok=True);portable=dist/('trace-gateway-'+target);portable.mkdir(exist_ok=True);shutil.copy2(cli,portable/cli.name);shutil.copy2(background,portable/background.name);shutil.copytree(runtime,portable/'runtime',dirs_exist_ok=True);fresh_copy(runtime/('node'+suffix),portable/'runtime'/('node'+suffix));shutil.copy2(ROOT/'README.md',portable/'README.md');shutil.copy2(ROOT/'LICENSE',portable/'LICENSE');shutil.copy2(ROOT/'THIRD_PARTY_NOTICES.md',portable/'THIRD_PARTY_NOTICES.md')
 copy_lab(portable)
 if os.name=='nt':
  with zipfile.ZipFile(str(portable)+'.zip','w',zipfile.ZIP_DEFLATED)as z:
   for f in portable.rglob('*'):
    if f.is_file():z.write(f,f.relative_to(dist))
 else:
  with tarfile.open(str(portable)+'.tar.gz','w:gz')as t:t.add(portable,arcname=portable.name)
 if a.native_macos_bundle:
  assert platform.system()=='Darwin';run('cargo','build','--locked','--release','-p','trace-gateway-desktop')
  app=dist/'Trace Gateway.app';mac=app/'Contents/MacOS';resources=app/'Contents/Resources';mac.mkdir(parents=True,exist_ok=True);resources.mkdir(parents=True,exist_ok=True)
  shutil.copy2(ROOT/'target/release/trace-desktop',mac/'trace-desktop');shutil.copy2(cli,mac/'trace');shutil.copy2(background,mac/'trace-background');shutil.copytree(runtime,resources/'runtime',dirs_exist_ok=True);fresh_copy(runtime/('node'+suffix),resources/'runtime'/('node'+suffix));shutil.copy2(ROOT/'desktop/icons/icon.icns',resources/'icon.icns')
  with open(app/'Contents/Info.plist','wb')as f:plistlib.dump({'CFBundleExecutable':'trace-desktop','CFBundleIdentifier':'dev.trace.gateway','CFBundleName':'Trace Gateway','CFBundleDisplayName':'Trace Gateway','CFBundlePackageType':'APPL','CFBundleShortVersionString':'0.2.0','CFBundleVersion':'0.2.0','CFBundleIconFile':'icon.icns','LSMinimumSystemVersion':'13.5','LSUIElement':True,'NSHighResolutionCapable':True},f)
  run('codesign','--force','--deep','--sign','-',app)
  run('ditto','-c','-k','--sequesterRsrc','--keepParent',app,dist/('Trace-Gateway-macos-'+platform.machine()+'.zip'))
 elif a.desktop:
  tauri=os.environ.get('TAURI_CLI','cargo');args=[tauri,'tauri','build']if tauri=='cargo'else[tauri,'build'];subprocess.run(args,cwd=ROOT/'desktop',check=True)
 print('Packages:',dist)
if __name__=='__main__':main()
