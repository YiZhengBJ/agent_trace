#!/usr/bin/env python3
"""Check the offline entry point in a portable layout without building Rust."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("trace_packaging", ROOT / "scripts/package.py")
packaging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packaging)
node = Path(os.environ.get("TRACE_TEST_NODE", ROOT / "runtime" / ("node.exe" if os.name == "nt" else "node")))
assert node.is_file(), "Bundled runtime or TRACE_TEST_NODE is required"

with tempfile.TemporaryDirectory(prefix="trace-lab-package-") as temp:
    portable = Path(temp) / "portable with spaces"
    portable.mkdir()
    packaging.copy_lab(portable)
    (portable / "runtime").mkdir()
    target = portable / "runtime" / node.name
    if os.name == "nt":
        shutil.copy2(node, target)
        prefix = ["cmd", "/c", str(portable / "scripts/trace-lab.cmd")]
    else:
        target.symlink_to(node.resolve())
        prefix = ["sh", str(portable / "scripts/trace-lab")]
    config = Path(temp) / "lab.json"
    result = subprocess.run(prefix + ["init", "--out", str(config)], capture_output=True, text=True, check=True)
    assert json.loads(result.stdout)["requiresConfiguration"]
    assert json.loads(config.read_text())["verifier"]["type"] == "basic"
    assert not (portable / "lab/test").exists()
    assert (portable / "gateway/file-backup.example.json").exists()
    assert subprocess.run(prefix + ["init", "--out", str(config)], capture_output=True).returncode != 0
    assert "offline" in subprocess.check_output(prefix + ["--help"], text=True)
print("PASS: portable Lab CLI, bundled runtime, shared dependencies, config init and no-overwrite.")
