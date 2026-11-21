"""Profile `prepare`: time spent in each stage (R0 for phase R4 of docs/rust-plan.md).

    uv run --project python python python/bench_prepare.py [--quick]

Stages follow the job's status: sampling, reading (incl. missing values), standardizing,
PCA fit, PCA transform, anchors (selection and writing).
"""

from __future__ import annotations

import argparse
import json
import tempfile
import time

import numpy as np

import positron_atlas_kernel as pak


def frame(n: int, d: int, kind: str, nan_frac: float = 0.0):
    rng = np.random.default_rng(0)
    centers = rng.normal(0, 5, (10, d)).astype(np.float32)
    x = centers[rng.integers(0, 10, n)]
    x += rng.normal(0, 1, (n, d)).astype(np.float32)
    if nan_frac:
        x[rng.random((n, d)) < nan_frac / d] = np.nan
    if kind == "polars":
        import polars as pl

        return pl.from_numpy(x, schema=[f"f{i}" for i in range(d)])
    import pandas as pd

    return pd.DataFrame(x, columns=[f"f{i}" for i in range(d)], copy=False)


def profile(n, d, kind="polars", pca=False, pca_dims=50, pct=100.0, nan_frac=0.0, nan_policy="drop"):
    df = frame(n, d, kind, nan_frac)
    ns = {"df": df}
    pak._user_ns = lambda: ns
    with tempfile.TemporaryDirectory() as tmp:
        jid = json.loads(pak.create_job("df", tmp))["jobId"]
        job = pak._JOBS[jid]
        marks: list[tuple[str, float]] = []
        orig = job.set

        def set_(stage=None, progress=None, message=None):
            label = stage
            if stage == "pca":
                label = "pca transform" if (message or "").startswith("Projecting") else "pca fit" if message else None
            if label and (not marks or marks[-1][0] != label):
                marks.append((label, time.perf_counter()))
            return orig(stage, progress, message)

        job.set = set_
        t0 = time.perf_counter()
        opts = {"features": list(range(d)), "samplePct": pct, "pca": pca, "pcaDims": pca_dims, "nanPolicy": nan_policy}
        pak.prepare(jid, json.dumps(opts))
        while json.loads(pak.status(jid))["stage"] not in ("done", "error"):
            time.sleep(0.005)
        total = time.perf_counter() - t0
        st = json.loads(pak.status(jid))
        assert st["stage"] == "done", st
        marks.append(("end", t0 + total))
        stages = {}
        for (name, t), (_, t_next) in zip(marks, marks[1:]):
            if name not in ("finishing",):
                stages[name] = stages.get(name, 0) + (t_next - t)
        pak.cleanup(jid)
    return {"n": n, "d": d, "kind": kind, "pca": pca_dims if pca else None, "nan": nan_frac, "total_s": round(total, 2), **{k: round(v, 2) for k, v in stages.items()}}


CONFIGS = [
    dict(n=1_000_000, d=50),
    dict(n=1_000_000, d=50, kind="pandas"),
    dict(n=1_000_000, d=50, nan_frac=0.05),
    dict(n=1_000_000, d=50, nan_frac=0.05, nan_policy="impute"),
    dict(n=1_000_000, d=50, pca=True, pca_dims=20),
    dict(n=1_000_000, d=200, pca=True, pca_dims=50),
    dict(n=10_000_000, d=20),
    dict(n=5_000_000, d=100, pca=True, pca_dims=20),
]

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    args = ap.parse_args()
    for c in CONFIGS[:2] if args.quick else CONFIGS:
        print(json.dumps(profile(**c)), flush=True)
