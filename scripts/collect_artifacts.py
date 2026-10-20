#!/usr/bin/env python3
"""Verify native installer outputs and stage only distributable files for CI."""
import argparse
import hashlib
from pathlib import Path
import shutil
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = {
    "ubuntu-x64": ("deb/*.deb", "appimage/*.AppImage"),
    "macos-arm64": ("dmg/*.dmg",),
    "windows-x64": ("msi/*.msi", "nsis/*-setup.exe"),
}

def collect(root, platform):
    dist = root / "dist"
    bundle = root / "target/release/bundle"
    release = dist / ("trace-gateway-" + platform + "-unified")
    if release.exists():
        shutil.rmtree(release)
    release.mkdir(parents=True)
    portable = [p for p in dist.glob("trace-gateway-*") if p.is_dir() and not p.name.endswith("-unified")]
    if len(portable) != 1:
        raise RuntimeError("Expected exactly one prepared CLI directory")
    shutil.copytree(portable[0], release / "cli")
    desktop = release / "desktop"
    desktop.mkdir()
    for pattern in PATTERNS[platform]:
        matches = sorted(bundle.glob(pattern))
        if not matches:
            raise RuntimeError(f"Missing required installer: {bundle / pattern}")
        for source in matches:
            shutil.copy2(source, desktop / source.name)
    if platform == "macos-arm64":
        apps = list((bundle / "macos").glob("*.app"))
        if len(apps) != 1:
            raise RuntimeError("Expected one macOS app bundle")
        shutil.copytree(apps[0], desktop / "Trace Gateway.app", symlinks=True)
    shutil.copy2(root / "README.md", release / "README.md")
    script = "install.ps1" if platform == "windows-x64" else "install.sh"
    shutil.copy2(root / "scripts/installers" / script, release / script)
    (release / script).chmod(0o755)
    uninstaller = "uninstall.ps1" if platform == "windows-x64" else "uninstall.sh"
    shutil.copy2(root / "scripts/installers" / uninstaller, release / uninstaller)
    (release / uninstaller).chmod(0o755)
    files = sorted(p for p in release.rglob("*") if p.is_file() and not p.is_symlink())
    lines = []
    for path in files:
        with path.open("rb") as stream:
            hasher = hashlib.sha256()
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                hasher.update(chunk)
            digest = hasher.hexdigest()
        lines.append(f"{digest}  {path.relative_to(release).as_posix()}\n")
    (release / "SHA256SUMS.txt").write_text("".join(lines), encoding="utf-8")
    final = dist / "release"
    final.mkdir(exist_ok=True)
    if platform == "windows-x64":
        archive = final / (release.name + ".zip")
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
            for path in release.rglob("*"):
                if path.is_file():
                    output.write(path, path.relative_to(dist))
    else:
        archive = final / (release.name + ".tar.gz")
        with tarfile.open(archive, "w:gz") as output:
            output.add(release, arcname=release.name)
    print("Unified package:", archive)
    print("Verified artifacts:\n" + "".join(lines))

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", required=True, choices=PATTERNS)
    collect(ROOT, parser.parse_args().platform)
