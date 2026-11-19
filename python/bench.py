"""Benchmark the kernel pipeline (prepare + projection) on synthetic data.

    uv run --project python python python/bench.py [--quick]
"""

import json
import sys
import tempfile
import time

import numpy as np

import positron_atlas_kernel as pak


def run(n, d, pct=100.0, pca=False, pca_dims=50, anchors=100_000, kind="polars"):
    rng = np.random.default_rng(0)
    centers = rng.normal(0, 5, (10, d)).astype(np.float32)
    lab = rng.integers(0, 10, n)
    x = centers[lab]
    x += rng.normal(0, 1, (n, d)).astype(np.float32)
    if kind == "polars":
        import polars as pl

        df = pl.from_numpy(x, schema=[f"f{i}" for i in range(d)])
    else:
        import pandas as pd

        df = pd.DataFrame(x, columns=[f"f{i}" for i in range(d)], copy=False)
    del x
    ns = {"df": df}
    pak._user_ns = lambda: ns
    with tempfile.TemporaryDirectory() as tmp:
        jid = json.loads(pak.create_job("df", tmp))["jobId"]
        t0 = time.time()
        opts = {"features": list(range(d)), "samplePct": pct, "pca": pca, "pcaDims": pca_dims, "maxAnchors": anchors}
        pak.prepare(jid, json.dumps(opts))
        st = wait(jid)
        t_prep = time.time() - t0
        r = st["result"]
        est = json.loads(pak.estimate_projection(jid))
        t_proj = 0.0
        if r.get("needsProjection"):
            axy = np.random.default_rng(1).normal(size=(r["nAnchors"], 2)).astype("<f4")
            p = f"{tmp}/axy.f32"
            axy.tofile(p)
            t0 = time.time()
            pak.project(jid, p, "{}")
            st2 = wait(jid)
            assert st2["stage"] == "done", st2
            t_proj = time.time() - t0
        pak.cleanup(jid)
    return {
        "n": n, "d": d, "kind": kind, "sample%": pct, "pca": pca_dims if pca else None,
        "kept": r["nKept"], "dims": r["dims"], "anchors": r["nAnchors"],
        "prepare_s": round(t_prep, 2), "project_s": round(t_proj, 2), "est_gflop": round(est["flops"] / 1e9, 1),
    }


def wait(jid):
    while True:
        st = json.loads(pak.status(jid))
        if st["stage"] in ("done", "error", "cancelled"):
            if st["stage"] != "done":
                raise RuntimeError(st)
            return st
        time.sleep(0.05)


CONFIGS = [
    dict(n=1_000_000, d=50),
    dict(n=1_000_000, d=50, pca=True, pca_dims=20),
    dict(n=1_000_000, d=50, kind="pandas"),
    dict(n=1_000_000, d=200, pca=True, pca_dims=50),
    dict(n=1_000_000, d=1000, pct=10),
    dict(n=1_000_000, d=1000, pct=10, pca=True, pca_dims=50),
    dict(n=10_000_000, d=20),
    dict(n=10_000_000, d=20, pct=10),
    dict(n=10_000_000, d=100, pca=True, pca_dims=20, anchors=50_000),
]

if __name__ == "__main__":
    configs = CONFIGS[:2] if "--quick" in sys.argv else CONFIGS
    for c in configs:
        print(json.dumps(run(**c)), flush=True)
