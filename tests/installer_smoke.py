#!/usr/bin/env python3
"""Exercise Unix installer/uninstaller ownership, retention, and explicit purge."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]

def main():
    if os.name == 'nt':
        return
    for purge in (False, True):
        with tempfile.TemporaryDirectory(prefix='trace-uninstall-') as temp:
            root = Path(temp)
            package = root / 'package'
            (package / 'cli/runtime').mkdir(parents=True)
            (package / 'cli/runtime/node').write_text('bundled runtime')
            cli = package / 'cli/trace'
            cli.write_text('#!/bin/sh\nexit 0\n')
            cli.chmod(0o755)
            for name in ('install.sh', 'uninstall.sh'):
                shutil.copy2(ROOT / 'scripts/installers' / name, package / name)
            tools = root / 'tools'
            tools.mkdir()
            for name, content in [('uname', 'echo Linux'), ('pgrep', 'exit 1')]:
                tool = tools / name
                tool.write_text('#!/bin/sh\n' + content + '\n')
                tool.chmod(0o755)
            home = root / 'home'
            home.mkdir()
            data = home / 'data'
            data.mkdir()
            (data / 'config.json').write_text('{}')
            (data / 'recording.json').write_text('keep this recording')
            dest = root / 'installation with spaces'
            bindir = root / 'bin'
            env = dict(os.environ, HOME=str(home), TRACE_HOME=str(data),
                       TRACE_INSTALL_DIR=str(dest), TRACE_BIN_DIR=str(bindir),
                       PATH=str(tools) + os.pathsep + os.environ['PATH'])
            # A populated, unmarked directory must never become installer-owned.
            dest.mkdir()
            (dest / 'unrelated').write_text('keep')
            result = subprocess.run(['sh', str(package / 'install.sh'), '--headless'], env=env)
            assert result.returncode != 0
            assert (dest / 'unrelated').read_text() == 'keep'
            (dest / 'unrelated').unlink()
            subprocess.run(['sh', str(package / 'install.sh'), '--headless'], env=env, check=True)
            assert (bindir / 'trace').is_symlink()
            assert (dest / 'runtime/node').exists()
            (dest / 'unrelated').write_text('keep')
            unsafe = dict(env, TRACE_HOME=str(home) + '/.')
            rejected = subprocess.run([str(bindir / 'trace-uninstall'), '--purge-data'], env=unsafe)
            assert rejected.returncode != 0
            assert (dest / 'trace').exists() and home.exists()
            command = [str(bindir / 'trace-uninstall')]
            if purge:
                command.append('--purge-data')
            subprocess.run(command, env=env, check=True)
            assert not (bindir / 'trace').is_symlink()
            assert not (bindir / 'trace-uninstall').is_symlink()
            assert not (dest / 'runtime').exists()
            assert not (dest / 'trace').exists()
            assert (dest / 'unrelated').read_text() == 'keep'
            assert data.exists() == (not purge)
            print('PASS install/uninstall:', 'purge' if purge else 'retain data')

if __name__ == '__main__':
    main()
