"""Browser harness for Positron Atlas: the real kernel helper behind a tiny HTTP server.

    uv run --project python python test/harness/server.py SCENARIO.json [--port 8765]

Runs the scenario's ``setup`` code (the same JSON as test/e2e) to create a DataFrame, loads
python/positron_atlas_kernel.py, and serves:

    GET  /                      test/harness/index.html (the webview page plus host.js)
    GET  /dist/<path>           the built webview (dist/webview)
    GET  /harness/<path>        files in test/harness
    GET  /job/<file>            files the kernel helper wrote into the job directory
    POST /call                  {"fn": name, "args": [...]} -> the helper's JSON result
    POST /write?name=<file>     write the request body into the job directory; returns its path
    POST /rm?name=<file>        remove a file from the job directory
    POST /exec                  {"code": ...} run code in the scenario's namespace (tests only); a stub
                                `datamapplot` module records create_interactive_plot calls in
                                `_dmp_calls`. Returns {"ok", "error"}.

It stands in for Positron (positron.runtime.evaluateCode) so the webview can be tested and
screenshotted in a plain browser. See test/harness/host.js for the extension-host side.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import mimetypes
import os
import shutil
import sys
import tempfile
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parents[2]
HARNESS = ROOT / "test" / "harness"
DIST = ROOT / "dist" / "webview"


def load_helper(namespace: dict):
    spec = importlib.util.spec_from_file_location("_positron_atlas", ROOT / "python" / "positron_atlas_kernel.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["_positron_atlas"] = module
    spec.loader.exec_module(module)
    # The helper looks variables up in the user's namespace: point it at the scenario's.
    module._user_ns = lambda: namespace
    return module


def install_datamapplot_stub(namespace: dict) -> None:
    """A stand-in for datamapplot that records calls (checks snippets without installing it)."""
    import types

    import numpy as np

    calls: list = []
    namespace["_dmp_calls"] = calls

    def create_interactive_plot(coords, *label_layers, **kwargs):
        coords = np.asarray(coords)
        if coords.ndim != 2 or coords.shape[1] != 2 or not np.isfinite(coords).all():
            raise ValueError(f"bad coordinates: shape {coords.shape}")
        for labels in label_layers:
            labels = np.asarray(labels)
            if labels.shape != (coords.shape[0],) or any(not isinstance(v, str) for v in labels):
                raise ValueError("labels must be one string per point")
        calls.append({"n": int(coords.shape[0]), "layers": [sorted(set(map(str, la))) for la in label_layers], "kwargs": sorted(kwargs)})
        return types.SimpleNamespace(save=lambda path: None)

    module = types.ModuleType("datamapplot")
    module.create_interactive_plot = create_interactive_plot
    sys.modules["datamapplot"] = module


def safe_join(base: Path, rel: str) -> Path | None:
    p = (base / unquote(rel)).resolve()
    return p if p == base.resolve() or base.resolve() in p.parents else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("scenario")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()

    scenario = json.loads(Path(args.scenario).read_text())
    namespace: dict = {"__name__": "__main__"}
    exec(compile(scenario["setup"], args.scenario, "exec"), namespace)  # noqa: S102 - test scenario
    helper = load_helper(namespace)
    install_datamapplot_stub(namespace)
    job_root = Path(tempfile.mkdtemp(prefix="atlas-harness-"))
    # One kernel call at a time, like evaluateCode on a single kernel.
    call_lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *a):  # quiet
            pass

        def send(self, code: int, body: bytes, ctype: str = "application/json") -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def send_file(self, path: Path | None) -> None:
            if path is None or not path.is_file():
                self.send(404, b"not found", "text/plain")
                return
            ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            self.send(200, path.read_bytes(), ctype)

        def do_GET(self) -> None:  # noqa: N802
            url = urlparse(self.path)
            p = url.path
            if p in ("/", "/index.html"):
                self.send_file(HARNESS / "index.html")
            elif p.startswith("/dist/"):
                self.send_file(safe_join(DIST, p[len("/dist/") :]))
            elif p.startswith("/harness/"):
                self.send_file(safe_join(HARNESS, p[len("/harness/") :]))
            elif p.startswith("/job/"):
                self.send_file(safe_join(job_root, p[len("/job/") :]))
            elif p == "/info":
                info = {"variable": scenario["variable"], "jobRoot": str(job_root), "settings": scenario.get("settings", {})}
                self.send(200, json.dumps(info).encode())
            else:
                self.send(404, b"not found", "text/plain")

        def do_POST(self) -> None:  # noqa: N802
            url = urlparse(self.path)
            body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            query = parse_qs(url.query)
            try:
                if url.path == "/call":
                    req = json.loads(body)
                    fn = getattr(helper, req["fn"])
                    with call_lock:
                        result = fn(*req.get("args", []))
                    self.send(200, result.encode() if isinstance(result, str) else json.dumps(result).encode())
                elif url.path == "/exec":
                    code = json.loads(body)["code"]
                    try:
                        with call_lock:
                            exec(compile(code, "<harness>", "exec"), namespace)  # noqa: S102 - test harness
                        self.send(200, json.dumps({"ok": True}).encode())
                    except Exception as e:  # noqa: BLE001
                        self.send(200, json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}).encode())
                elif url.path == "/write":
                    target = safe_join(job_root, query["name"][0])
                    if target is None:
                        raise ValueError("bad name")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(body)
                    self.send(200, json.dumps({"path": str(target)}).encode())
                elif url.path == "/rm":
                    target = safe_join(job_root, query["name"][0])
                    if target is not None and target.is_file():
                        target.unlink()
                    self.send(200, b"{}")
                else:
                    self.send(404, b"not found", "text/plain")
            except Exception as e:  # noqa: BLE001
                self.send(500, json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()}).encode())

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"listening on http://127.0.0.1:{server.server_address[1]}/ (job root {job_root})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        shutil.rmtree(job_root, ignore_errors=True)


if __name__ == "__main__":
    os.environ.setdefault("PYTHONHASHSEED", "0")
    main()
