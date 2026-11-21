"""
P7 spike (Python side): Rust IVF kNN timing, recall@15 vs exact, and
trustworthiness comparison of UMAP-from-NNDescent vs UMAP-from-Rust-IVF.

Run from the repo root:
  uv run --project python python -I docs/spikes/scripts/p7_rust_knn.py
"""
from __future__ import annotations

import os
import sys
import time

import numpy as np

# ---------------------------------------------------------------------------
# Setup path so the native module loads from the worktree
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT   = os.path.normpath(os.path.join(SCRIPT_DIR, "..", "..", ".."))
PYTHON_DIR  = os.path.join(REPO_ROOT, "python")
if PYTHON_DIR not in sys.path:
    sys.path.insert(0, PYTHON_DIR)

import positron_atlas_kernel as _k  # noqa: E402  (loads the helper)

N_BLOBS = 50
DIMS    = 50
SEED    = 42

def gaussian_blobs(n: int, d: int = DIMS, n_blobs: int = N_BLOBS, seed: int = SEED) -> np.ndarray:
    rng = np.random.default_rng(seed)
    centers = rng.standard_normal((n_blobs, d)) * 4.0
    labels  = np.arange(n) % n_blobs
    X = centers[labels] + rng.standard_normal((n, d)) * 0.5
    return X.astype(np.float32)


def exact_knn(X: np.ndarray, k: int) -> np.ndarray:
    """Brute-force kNN indices for all rows; returns (n, k) int32."""
    n = X.shape[0]
    batch = 2000  # do in batches to avoid huge intermediates
    idx = np.empty((n, k), dtype=np.int32)
    for start in range(0, n, batch):
        end = min(start + batch, n)
        q = X[start:end]  # (m, d)
        # squared distances: (m, n)
        diff = q[:, None, :] - X[None, :, :]
        sqd = (diff * diff).sum(axis=2)
        # exclude self
        for i in range(end - start):
            sqd[i, start + i] = np.inf
        idx[start:end] = np.argsort(sqd, axis=1)[:, :k].astype(np.int32)
    return idx


def recall_at_k(predicted: np.ndarray, exact: np.ndarray) -> float:
    """Mean fraction of exact neighbors found in predicted (row-wise)."""
    n, k = exact.shape
    hits = 0
    for i in range(n):
        hits += len(set(predicted[i]) & set(exact[i]))
    return hits / (n * k)


def rust_knn(X: np.ndarray, k: int = 15) -> tuple[np.ndarray, float]:
    """Build Rust IVF index on X, return (knn_indices int32, build+query time)."""
    native = _k._native_core()
    if native is None:
        raise RuntimeError(f"Rust native module not available: {_k._NATIVE_INFO}")
    t0 = time.perf_counter()
    idx_obj = native.Index(X, seed=0, cosine=False)
    # query all points against themselves
    knn_idx, knn_sqd = idx_obj.neighbors(X, k)
    t1 = time.perf_counter()
    # native returns i64; self-neighbor will be in col 0 (distance 0), skip it
    knn_idx = knn_idx.astype(np.int32)
    return knn_idx, knn_sqd.astype(np.float32), t1 - t0


def run_umap_py(knn_idx: np.ndarray, knn_sqd: np.ndarray, n: int) -> np.ndarray:
    """Run polars-umap on the given kNN graph; returns (n, 2) embedding."""
    import polars_umap
    # polars-umap exposes from_knn if available; otherwise fall back to its own umap
    # Check API
    if hasattr(polars_umap, "umap_from_knn"):
        t0 = time.perf_counter()
        emb = polars_umap.umap_from_knn(knn_idx, knn_sqd, n_components=2, n_epochs=200, random_state=SEED)
        t = time.perf_counter() - t0
    else:
        # polars-umap doesn't expose from_knn; we'll use the full UMAP path instead
        # for the trustworthiness comparison we just note it's unavailable
        emb = None
        t = 0.0
    return emb, t


def trustworthiness_score(X: np.ndarray, embedding: np.ndarray, n_neighbors: int = 5, sample: int = 5000) -> float:
    from sklearn.manifold import trustworthiness as tw
    if X.shape[0] > sample:
        rng = np.random.default_rng(SEED)
        idx = rng.choice(X.shape[0], sample, replace=False)
        X = X[idx]
        embedding = embedding[idx]
    return tw(X, embedding, n_neighbors=n_neighbors)


def main():
    print("=" * 70)
    print("P7: Rust IVF kNN timing and recall@15 vs exact")
    print("=" * 70)
    k = 15

    # Build/query time for 100k
    sizes_recall = [10_000, 25_000]
    sizes_time   = [10_000, 25_000, 100_000]

    print("\nRecall@15 and timing (Rust IVF vs exact brute force)")
    print(f"{'n':>10}  {'rust_time_s':>12}  {'recall_rust':>12}  {'note'}")

    rust_results = {}
    for n in sizes_time:
        X = gaussian_blobs(n)
        knn_rust, knn_sqd_rust, t_rust = rust_knn(X, k=k)
        rust_results[n] = (X, knn_rust, knn_sqd_rust)
        note = "build+query"
        if n in sizes_recall:
            exact_idx = exact_knn(X, k=k)
            # Rust returns self in first col at distance 0; shift
            # Actually let's find recall treating rust result as-is
            # compare each row's top-k rust (excluding self) to exact
            rust_no_self = []
            for i in range(n):
                row = knn_rust[i]
                row_filtered = row[row != i][:k]
                if len(row_filtered) < k:
                    row_filtered = np.concatenate([row_filtered, row[row == i][:k-len(row_filtered)]])
                rust_no_self.append(row_filtered[:k])
            rust_no_self = np.array(rust_no_self)
            rec = recall_at_k(rust_no_self, exact_idx)
            print(f"{n:>10}  {t_rust:>12.3f}  {rec:>12.4f}  {note}")
        else:
            print(f"{n:>10}  {t_rust:>12.3f}  {'(skipped)':>12}  {note}")

    # Trustworthiness comparison on 10k
    print("\nTrustworthiness comparison (5k subsample, n_neighbors=5)")
    print("Using 10k points, 50 dims, 50 blobs")

    n_trust = 10_000
    X, knn_rust, knn_sqd_rust = rust_results[n_trust]

    # 1. polars-umap full UMAP (uses its own NNDescent internally)
    import polars_umap
    t0 = time.perf_counter()
    emb_full_py = polars_umap.umap(X, n_components=2, n_neighbors=k, n_epochs=200, random_state=SEED)
    t_full_py = time.perf_counter() - t0

    tw_full = trustworthiness_score(X, emb_full_py)
    print(f"  polars-umap full (own NNDescent+SGD): {t_full_py:.2f}s, trust={tw_full:.4f}")

    # 2. Try umap from Rust IVF graph using polars-umap if it supports it
    has_from_knn = hasattr(polars_umap, "umap_from_knn")
    print(f"  polars-umap has umap_from_knn: {has_from_knn}")
    if has_from_knn:
        t0 = time.perf_counter()
        emb_rust_knn = polars_umap.umap_from_knn(knn_rust, knn_sqd_rust, n_components=2, n_epochs=200, random_state=SEED)
        t_rust_knn = time.perf_counter() - t0
        tw_rust = trustworthiness_score(X, emb_rust_knn)
        print(f"  polars-umap from Rust IVF kNN:        {t_rust_knn:.2f}s, trust={tw_rust:.4f}")
    else:
        print("  polars-umap from Rust IVF kNN: not available (umap_from_knn missing)")
        print("  Trustworthiness comparison requires the from_knn API.")

    # Print polars-umap API for diagnosis
    print(f"\n  polars-umap version: {polars_umap.__version__ if hasattr(polars_umap, '__version__') else 'unknown'}")
    print(f"  polars-umap public API: {[x for x in dir(polars_umap) if not x.startswith('_')]}")

    print("\nDone.")


if __name__ == "__main__":
    main()
