"""Build the Rust core and put it where the kernel helper looks for it.

    uv run --project python python scripts/build_native.py [--release] [--wheel PATH] [--target darwin-arm64]

Builds rust/atlas-core-py with maturin (stable ABI, CPython >= 3.10) unless --wheel is given, and
copies the extension module out of the wheel into native/<target>/, where <target> is a VS Code
platform name (darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64); by default this
machine's. The helper (python/positron_atlas_kernel.py) loads it from there by path.

--release builds a portable binary: on Linux with Zig for manylinux2014 (glibc 2.17), so it loads
on old distributions too (a plain build links against this machine's glibc).
"""

from __future__ import annotations

import argparse
import json
import platform
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE = "_positron_atlas_core"


def host_target() -> str:
    machine = platform.machine().lower()
    arch = {"x86_64": "x64", "amd64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(machine, machine)
    plat = "win32" if sys.platform.startswith("win") else sys.platform
    return f"{plat}-{arch}"


def check_versions() -> str:
    """The extension, the kernel helper and the Rust crates must have the same version."""
    pkg = json.loads((ROOT / "package.json").read_text())["version"]
    helper = re.search(r'^VERSION = "([^"]+)"', (ROOT / "python" / "positron_atlas_kernel.py").read_text(), re.M).group(1)
    crate = re.search(r'^version = "([^"]+)"', (ROOT / "rust" / "Cargo.toml").read_text(), re.M).group(1)
    if not (pkg == helper == crate):
        sys.exit(f"Version mismatch: package.json {pkg}, kernel helper {helper}, rust/Cargo.toml {crate}")
    return pkg


def build_wheel(release: bool) -> Path:
    out = ROOT / "rust" / "target" / "wheels"
    for old in out.glob("positron_atlas_core-*.whl"):
        old.unlink()
    cmd = ["maturin", "build", "--release", "-m", str(ROOT / "rust" / "atlas-core-py" / "Cargo.toml"), "-o", str(out)]
    portable = release and sys.platform.startswith("linux")
    if portable:
        cmd += ["--zig", "--compatibility", "manylinux2014"]
    if shutil.which("maturin") is None:
        cmd = ["uvx", *(["--with", "ziglang"] if portable else []), *cmd]
    subprocess.run(cmd, check=True)
    wheels = sorted(out.glob("positron_atlas_core-*.whl"))
    if len(wheels) != 1:
        sys.exit(f"Expected one wheel in {out}, found {len(wheels)}")
    return wheels[0]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wheel", type=Path, help="use this wheel instead of building one")
    ap.add_argument("--target", default=host_target(), help="VS Code platform name (default: this machine)")
    ap.add_argument("--release", action="store_true", help="portable build (manylinux2014 on Linux, via Zig)")
    args = ap.parse_args()
    version = check_versions()
    wheel = args.wheel or build_wheel(args.release)
    dest = ROOT / "native" / args.target
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    with zipfile.ZipFile(wheel) as z:
        names = [n for n in z.namelist() if Path(n).name.startswith(MODULE + ".") and Path(n).suffix in (".so", ".pyd")]
        if len(names) != 1:
            sys.exit(f"No extension module in {wheel.name}: {z.namelist()}")
        target = dest / Path(names[0]).name
        target.write_bytes(z.read(names[0]))
    (dest / "VERSION").write_text(version + "\n")
    print(f"{target.relative_to(ROOT)} ({target.stat().st_size // 1024} KB, version {version}, from {wheel.name})")


if __name__ == "__main__":
    main()
