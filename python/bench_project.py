"""Benchmark row placement ("projection"): speed breakdown and accuracy.

    uv run --project python python python/bench_project.py [--quick] [--backend numpy|rust|both] [--sizes 1e5x50,...]

For each size it builds synthetic data (50 overlapping Gaussian blobs), picks random anchors, gives
them a 2D layout (their first two principal components), then places every other row from its
10 nearest anchors, as Atlas does after UMAP. It reports:

- time to build the anchor index, to find the neighbors, and to place the rows, and µs per row;
- accuracy on a sample of 20,000 rows against exact (brute force) neighbors: recall@10, and the
  mean placement error in units of the layout's spread (the RMS distance of anchors to their mean).

The numpy backend is positron_atlas_kernel's AnchorIndex + place_from_neighbors; the rust backend
is the native core (_positron_atlas_core), when it is built.
"""

from __future__ import annotations

import argparse
import json
import time

import numpy as np

import positron_atlas_kernel as pak

K = 10


def make_data(n: int, d: int, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    centers = rng.normal(0, 4, (50, d)).astype(np.float32)
    x = centers[rng.integers(0, 50, n)]
    x += rng.normal(0, 1, (n, d)).astype(np.float32)
    return x


def anchor_layout(anchors: np.ndarray) -> np.ndarray:
    """A deterministic 2D layout for the anchors: their first two principal components."""
    s = anchors[: min(len(anchors), 20_000)]
    mu = s.mean(0)
    _, _, vt = np.linalg.svd(s - mu, full_matrices=False)
    return np.ascontiguousarray((anchors - mu) @ vt[:2].T, dtype=np.float32)


def exact_neighbors(q: np.ndarray, anchors: np.ndarray, k: int = K) -> tuple[np.ndarray, np.ndarray]:
    """Brute-force k nearest anchors (squared euclidean), in chunks."""
    a_sq = np.einsum("ij,ij->i", anchors, anchors)
    out_i = np.empty((len(q), k), dtype=np.int64)
    out_d = np.empty((len(q), k), dtype=np.float32)
    step = max(1, (1 << 24) // max(len(anchors), 1))
    for s in range(0, len(q), step):
        d = pak._sqdist(q[s : s + step], anchors, a_sq)
        out_i[s : s + step], out_d[s : s + step] = pak._topk(d, np.broadcast_to(np.arange(len(anchors)), d.shape), k)
    return out_i, out_d


class NumpyBackend:
    name = "numpy"

    def __init__(self, anchors: np.ndarray, seed: int = 0):
        self.index = pak.AnchorIndex(anchors, seed=seed)

    def neighbors(self, q: np.ndarray, k: int = K):
        return self.index.query(q, k)

    def place(self, x: np.ndarray, rows: np.ndarray, anchor_xy: np.ndarray, out: np.ndarray, chunk: int) -> None:
        for s in range(0, len(rows), chunk):
            sel = rows[s : s + chunk]
            ii, dd = self.index.query(np.asarray(x[sel], dtype=np.float32), K)
            out[sel] = pak.place_from_neighbors(ii, dd, anchor_xy)


class RustBackend:
    name = "rust"

    def __init__(self, anchors: np.ndarray, seed: int = 0):
        core = pak._native_core()
        if core is None:
            raise RuntimeError("The native core is not built (npm run build:native).")
        self.index = core.Index(anchors, seed=seed)

    def neighbors(self, q: np.ndarray, k: int = K):
        return self.index.neighbors(q, k)

    def place(self, x: np.ndarray, rows: np.ndarray, anchor_xy: np.ndarray, out: np.ndarray, chunk: int) -> None:
        self.index.place(x, rows, anchor_xy, out, K)


BACKENDS = {"numpy": NumpyBackend, "rust": RustBackend}


def run(n: int, d: int, n_anchors: int, backend: str, sample: int = 20_000) -> dict:
    x = make_data(n, d)
    rng = np.random.default_rng(1)
    anchor_pos = np.sort(rng.choice(n, size=min(n_anchors, n), replace=False))
    anchors = np.ascontiguousarray(x[anchor_pos])
    anchor_xy = anchor_layout(anchors)
    is_anchor = np.zeros(n, dtype=bool)
    is_anchor[anchor_pos] = True
    rows = np.flatnonzero(~is_anchor)

    t0 = time.perf_counter()
    b = BACKENDS[backend](anchors, seed=0)
    t_build = time.perf_counter() - t0

    out = np.zeros((n, 2), dtype=np.float32)
    chunk = max(1, min(1_000_000, (1 << 22) // max(d, 1) * 4))
    t0 = time.perf_counter()
    b.place(x, rows, anchor_xy, out, chunk)
    t_place = time.perf_counter() - t0

    # --- cached re-placement: pre-compute neighbours (as the background thread does),
    #     then place from cached indices (place_from_neighbors only, no index search). ---
    q_all = np.ascontiguousarray(x[rows], dtype=np.float32)
    core = pak._native_core()

    t0 = time.perf_counter()
    if backend == "rust" and core is not None:
        nbr_idx, nbr_sqd = b.index.neighbors_u32(q_all, K)  # returns u32 indices
    else:
        nbr_idx_i64, nbr_sqd = b.index.query(q_all, K)
        sentinel = np.iinfo(np.uint32).max
        nbr_idx = np.where(nbr_idx_i64 >= 0, nbr_idx_i64.astype(np.uint32), sentinel)
        nbr_sqd = nbr_sqd.astype(np.float32)
    t_nbr = time.perf_counter() - t0

    t0 = time.perf_counter()
    if backend == "rust" and core is not None:
        placed_cached = core.place_from_neighbors(nbr_idx, nbr_sqd, anchor_xy)
    else:
        placed_cached = pak.place_from_neighbors(nbr_idx, nbr_sqd, anchor_xy)
    t_replace = time.perf_counter() - t0
    # ----------------------------------------------------------------------------------

    # Accuracy on a sample of the placed rows, against exact neighbors.
    qs = rows[np.sort(np.random.default_rng(2).choice(len(rows), size=min(sample, len(rows)), replace=False))]
    q = np.ascontiguousarray(x[qs])
    ex_i, ex_d = exact_neighbors(q, anchors)
    ap_i, _ = b.neighbors(q, K)
    recall = float(np.mean([len(np.intersect1d(ap_i[j], ex_i[j])) / K for j in range(len(q))]))
    exact_xy = pak.place_from_neighbors(ex_i, ex_d, anchor_xy)
    spread = float(np.sqrt(((anchor_xy - anchor_xy.mean(0)) ** 2).sum(1).mean()))
    err = float(np.linalg.norm(out[qs] - exact_xy, axis=1).mean() / spread)
    return {
        "n": n,
        "d": d,
        "anchors": len(anchors),
        "backend": backend,
        "build_s": round(t_build, 3),
        "place_s": round(t_place, 3),
        "us_per_row": round(t_place / max(len(rows), 1) * 1e6, 2),
        "neighbours_s": round(t_nbr, 3),
        "replace_s": round(t_replace, 3),
        "replace_us_per_row": round(t_replace / max(len(rows), 1) * 1e6, 2),
        "recall@10": round(recall, 4),
        "place_err": round(err, 5),
    }


QUICK = [(100_000, 50, 20_000), (1_000_000, 20, 100_000), (100_000, 1000, 10_000)]
FULL = QUICK + [(1_000_000, 50, 100_000), (10_000_000, 20, 100_000)]


def parse_sizes(text: str) -> list[tuple[int, int, int]]:
    out = []
    for part in text.split(","):
        nd, _, a = part.partition("@")
        n, d = nd.split("x")
        out.append((int(float(n)), int(d), int(float(a)) if a else 100_000))
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--backend", default="numpy", choices=["numpy", "rust", "both"])
    ap.add_argument("--sizes", help="e.g. 1e6x20@100000,1e5x1000@10000")
    args = ap.parse_args()
    sizes = parse_sizes(args.sizes) if args.sizes else QUICK if args.quick else FULL
    backends = ["numpy", "rust"] if args.backend == "both" else [args.backend]
    for n, d, a in sizes:
        for backend in backends:
            print(json.dumps(run(n, d, a, backend)), flush=True)
