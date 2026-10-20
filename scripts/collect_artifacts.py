#!/usr/bin/env python3
"""Verify native installer outputs and stage only distributable files for CI."""
import argparse
import hashlib
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = {
    "ubuntu-x64": ("deb/*.deb", "appimage/*.AppImage"),
    "macos-arm64": ("dmg/*.dmg",),
    "windows-x64": ("msi/*.msi", "nsis/*-setup.exe"),
}

def collect(root, platform):
    dist = root / "dist"
    bundle = root / "target/release/bundle"
    installers = dist / "installers"
    installers.mkdir(parents=True, exist_ok=True)
    archives = sorted(dist.glob("*.tar.gz")) + sorted(dist.glob("*.zip"))
    if not archives:
        raise RuntimeError("No headless CLI archive was produced")
    files = list(archives)
    for pattern in PATTERNS[platform]:
        matches = sorted(bundle.glob(pattern))
        if not matches:
            raise RuntimeError(f"Missing required installer: {bundle / pattern}")
        for source in matches:
            target = installers / source.name
            shutil.copy2(source, target)
            files.append(target)
    lines = []
    for path in files:
        with path.open("rb") as stream:
            hasher = hashlib.sha256()
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                hasher.update(chunk)
            digest = hasher.hexdigest()
        lines.append(f"{digest}  {path.relative_to(dist).as_posix()}\n")
    (dist / "SHA256SUMS.txt").write_text("".join(lines), encoding="utf-8")
    print("Verified artifacts:\n" + "".join(lines))

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", required=True, choices=PATTERNS)
    collect(ROOT, parser.parse_args().platform)
