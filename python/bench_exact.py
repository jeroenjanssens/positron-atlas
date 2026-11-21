"""Exact UMAP on all rows: umap-learn vs polars-umap (as Atlas runs them in the kernel).

    uv run --project python python python/bench_exact.py [sizes like 1e4x50,1e5x50]

umap-learn's first call includes numba's compilation; it is warmed up on small data first.
"""

import sys
import time

import numpy as np

import positron_atlas_kernel as pak


def data(n, d):
    rng = np.random.default_rng(0)
    c = rng.normal(0, 4, (50, d)).astype(np.float32)
    x = c[rng.integers(0, 50, n)]
    x += rng.normal(0, 1, (n, d)).astype(np.float32)
    return x


def umap_learn(x, params):
    import umap

    return umap.UMAP(n_neighbors=15, min_dist=0.1, n_epochs=200, random_state=params["seed"]).fit_transform(x)


def polars_umap(x, params):
    import polars as pl
    import polars_umap as pu

    return pl.DataFrame([pl.Series("f", x)]).select(xy=pu.umap("f", **pak._polars_umap_args(params)))["xy"].to_numpy()


if __name__ == "__main__":
    sizes = [tuple(int(float(v)) for v in s.split("x")) for s in (sys.argv[1] if len(sys.argv) > 1 else "1e4x50,1e5x50").split(",")]
    params = {"nNeighbors": 15, "minDist": 0.1, "nEpochs": 200, "seed": 1}
    umap_learn(data(500, 10), params)  # numba warm-up
    for n, d in sizes:
        x = data(n, d)
        for name, fn in (("polars-umap", polars_umap), ("umap-learn", umap_learn)):
            t0 = time.perf_counter()
            xy = fn(x, params)
            print(f"{n:>9,} × {d:<4} {name:12s} {time.perf_counter() - t0:7.1f} s  {np.asarray(xy).shape}", flush=True)
