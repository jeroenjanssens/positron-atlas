# Benchmarks

All numbers were measured on an Apple M4 Pro (24 GB) on 2026-11-19. Setup:

- Positron 2026.10.1 (Electron 42, Chromium 148).
- Python 3.12 or 3.13 with numpy 2.5.
- Synthetic Gaussian blobs.
- Times are wall-clock.

## Browser UMAP (embedding-atlas 0.26 WASM, 200 epochs, `n_neighbors = 15`)

Measured inside a Positron webview with `test/e2e/scenario-bench-umap.json`. The input is 50 dimensions unless noted.

| Anchors | WebGPU | CPU (WASM, single thread) | Speed-up |
|---:|---:|---:|---:|
| 10,000 | 0.5 s | 7.1 s | 13× |
| 25,000 | 1.0 s | 18.1 s | 18× |
| 50,000 | 1.8 s | 36.6 s | 20× |
| 100,000 | 4.1 s | 74.2 s | 18× |
| 200,000 | 10.2 s | n/a | |
| 200,000 (PCA, 10 dims) | 7.7 s | n/a | |

- CPU time grows linearly, at about 0.73 ms per anchor (50 dims, 200 epochs).
- WebGPU is available in Positron's webviews on macOS and is the default. Atlas falls back to the CPU automatically.
- A live parameter change (`min_dist`, `spread`, …) re-anneals for 100 epochs: about 0.2 s for 100k anchors on the GPU.
- Defaults that follow from this: `maxAnchors = 100,000` with WebGPU and `maxAnchorsCpu = 25,000` without.

## Kernel pipeline (numpy only)

Measured with `uv run --project python python python/bench.py`.

- `prepare`: read, NaN policy, standardize, optional PCA, anchors.
- `project`: place all non-anchor rows from their 10 nearest anchors, using the numpy IVF index.

| Rows | Columns | Frame | Sample | PCA | Kept rows | Dims | Anchors | prepare | project |
|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 1,000,000 | 50 | polars | 100 % | – | 1,000,000 | 50 | 100,000 | 0.2 s | 13.4 s |
| 1,000,000 | 50 | polars | 100 % | 20 | 1,000,000 | 20 | 100,000 | 0.3 s | 13.1 s |
| 1,000,000 | 50 | pandas | 100 % | – | 1,000,000 | 50 | 100,000 | 0.4 s | 13.5 s |
| 1,000,000 | 200 | polars | 100 % | 50 | 1,000,000 | 50 | 100,000 | 1.2 s | 13.2 s |
| 1,000,000 | 1,000 | polars | 10 % | – | 100,000 | 1,000 | 10,000 | 0.8 s | 3.0 s |
| 1,000,000 | 1,000 | polars | 10 % | 50 | 100,000 | 50 | 100,000 | 1.8 s | – |
| 10,000,000 | 20 | polars | 100 % | – | 10,000,000 | 20 | 100,000 | 0.5 s | 140.6 s |
| 10,000,000 | 20 | polars | 10 % | – | 1,000,000 | 20 | 100,000 | 0.1 s | 14.0 s |
| 10,000,000 | 100 | polars | 100 % | 20 | 10,000,000 | 20 | 50,000 | 21.8 s | 100.5 s |

How to read these results:

- **Projection costs about 13 µs per row.** That cost is dominated by top-k selection and is almost independent of the dimensionality after PCA. Placing all 10⁷ rows takes about 2 minutes. With the sample control at 10 %, it takes about 15 s.
- **The time estimate shown before placing rows** is `1.2e-5 × rows + 2.2e-11 × flops` seconds, fitted to the table above. Rows are placed automatically after UMAP when the estimate is under 20 s. Otherwise Atlas shows a "Place all rows (≈ …)" button.
- **Wide data without PCA** is limited by the anchor budget (10⁷ values). For example, 1,000 columns allow only 10,000 anchors, and the UI suggests turning PCA on.
- **Peak kernel memory** is about one float32 copy of the selected and sampled features. Arrays over 1 GiB are memory-mapped into the job directory.

## End to end in Positron

300,000 × 51 Polars DataFrame, WebGPU (`test/e2e/scenario-polars-projection.json`):

| Step | Time |
|---|---:|
| UMAP on 100,000 anchors | 4.5 s |
| Place the other 200,000 rows (kernel) | 2.8 s |
| Live `min_dist` change, then automatic re-placement | 4.0 s |
| Rebuild with `n_neighbors = 30`, then re-placement | 13.1 s |
| 10 % sample, PCA to 20 dims, UMAP on all 30,000 rows | 2.5 s |
| Switch color column (300k values) | 0.3 s |
| Hover tooltip (row fetched from the kernel) | 0.3 s |

## Placing rows: Rust core vs numpy (2026-11-21)

Measured with `python/bench_project.py` on a 4-core Intel Xeon (2.3 GHz, AVX-512), 15 GB RAM, Linux,
Python 3.13, numpy 2.x. Synthetic data: 50 overlapping Gaussian blobs. Anchors laid out by their
first two principal components; 10 nearest anchors per row. Accuracy is measured on 20,000 rows
against exact (brute force) neighbors: recall@10, and the mean placement error relative to the
layout's spread (RMS distance of the anchors to their mean).

| Rows | Dims | Anchors | numpy | Rust | Speed-up | recall@10 numpy / Rust | placement error numpy / Rust |
|---:|---:|---:|---:|---:|---:|---|---|
| 100,000 | 50 | 20,000 | 1.00 s | 0.08 s | 12× | 0.987 / 0.989 | 0.11 % / 0.10 % |
| 1,000,000 | 20 | 100,000 | 15.8 s | 1.37 s | 11.6× | 0.904 / 0.909 | 0.80 % / 0.74 % |
| 1,000,000 | 50 | 100,000 | 16.2 s | 1.89 s | 8.6× | 0.840 / 0.846 | 1.21 % / 1.13 % |
| 100,000 | 1,000 | 10,000 | 1.76 s | 0.77 s | 2.3× | 0.9995 / 0.9998 | 0.002 % / 0.001 % |
| 10,000,000 | 20 | 100,000 | 197 s | 15.4 s | 12.8× | 0.905 / 0.909 | 0.79 % / 0.74 % |

Times are for placing the rows (index build: numpy 0.7–3 s, Rust 0.15–0.5 s, not included).

- The Rust core uses the same index (k-means cells, 4 probed cells) and the same weights as the
  numpy code. It groups the queries by cell and computes distances as matrix products with the
  `gemm` crate (SIMD kernels chosen at runtime), on all cores, with the GIL released.
- A first version that compared rows one at a time was only 3× faster at 20–50 dims and 4× slower
  at 1,000 dims than numpy (whose BLAS uses AVX-512 on all cores); batching fixed both.
- The time estimate for the Rust core is `1.2e-6 × rows + 6e-12 × flops` seconds
  (`src/shared/estimate.ts`), within 15 % of the measurements above.

### Choice of index (`rust/bench-ann`)

`cargo run --release -p bench-ann -- <anchors> <dims> <queries>`, same machine, k = 10:

| Anchors × dims, queries | Index | Build | Query | recall@10 |
|---|---|---:|---:|---:|
| 100k × 20, 200k | atlas-core IVF | 0.28 s | 0.32 s | 0.903 |
| | nndescent (embedding-atlas, `query`) | 2.37 s | 2.47 s | 0.910 |
| | hnsw_rs, ef 32 / 64 | 13.2 s | 10.6 / 13.9 s | 0.915 / 0.944 |
| 100k × 50, 200k | atlas-core IVF | 0.41 s | 0.41 s | 0.836 |
| | nndescent | 2.79 s | 5.46 s | 0.868 |
| | hnsw_rs, ef 32 / 64 | 15.9 s | 17.8 / 22.0 s | 0.759 / 0.856 |
| 10k × 1000, 20k | atlas-core IVF | 0.52 s | 0.20 s | 0.999 |
| | nndescent | 1.72 s | 1.68 s | 0.944 |
| | hnsw_rs, ef 32 / 64 | 3.27 s | 1.91 / 2.27 s | 0.990 / 0.999 |

The IVF index is 8–40× faster at similar recall, so Atlas keeps it. The SIMD crates (`pulp`,
`simsimd`) and `kiddo` are not needed: `gemm` already picks the SIMD kernels at runtime, and the
IVF index is fast at low dimensions.

## Preparing data and colors (2026-11-21)

Same 4-core Xeon. `python/bench_prepare.py` times each stage of `prepare` (synthetic blobs, polars
unless noted); "before" is the numpy-only helper.

| Rows × dims | Options | Total before → after | Standardizing before → after | Reading | PCA fit / transform |
|---|---|---:|---:|---:|---:|
| 10⁶ × 50 | | 0.57 → 0.18 s | 0.29 → 0.02 s | 0.21 → 0.10 s | |
| 10⁶ × 50, pandas | | 1.42 → 0.63 s | 0.33 → 0.02 s | 0.9 → 0.5 s | |
| 10⁶ × 200 | PCA 50 | 4.5 → 4.0 s | 1.15 → 0.07 s | 0.9 s | 2.2–2.5 / 0.3 s |
| 10⁷ × 20 | | 2.1 → 0.8 s | 1.30 → 0.07 s | 0.7 s | |
| 5·10⁶ × 100 | PCA 20 | 15.6 → 10.4 s | 6.4 → 1.0 s | 4.0–4.3 s | 3.5–3.9 / 1.2–1.6 s |

- **Standardizing** (Rust core, `column_moments` and `scale_columns`): the same float64 sums and
  formula as numpy, multithreaded. 6–18× faster; the 6× case writes to a memory-mapped file
  (features over 1 GiB are memory-mapped on purpose, to bound memory).
- **Reading** polars frames asks polars for row-major arrays (`to_numpy(order="c")`), about 25 %
  faster. Most of the remaining reading time at 5·10⁶ × 100 is writing the memory-mapped file.
- **PCA** stays in numpy: its BLAS already does the heavy lifting, so Rust would not reach the 2×
  bar set in the plan.

`colors()` for categorical columns (300 text values, 8 integer values), before → after:

| Rows | pandas text | pandas integers | polars text | polars integers |
|---:|---:|---:|---:|---:|
| 10⁶ | 0.90 → 0.03 s | 0.64 → 0.03 s | 1.00 → 0.18 s | 0.66 → 0.08 s |
| 5·10⁶ | 8.2 → 0.20 s | 5.6 → 0.13 s | 7.9 → 0.94 s | 5.8 → 0.41 s |

Category codes now come from `pandas.factorize` or polars dense ranks instead of Python-level
`str()` on every value (text, categorical, boolean and integer columns; floats and dates keep the
general path). Results are identical, except that integers with missing values are labeled "3"
(as in the data) instead of "3.0".

The selection comparison and cluster descriptions already take 0.03–0.08 s at 5·10⁶ rows, because
they use a random sample of 50,000–100,000 rows; using every row would make them slower without a
visible change in the result, so they keep the sample.

## Exact UMAP in the kernel: polars-umap vs umap-learn (2026-11-21)

`python/bench_exact.py`, same 4-core Xeon, 50 blobs, `n_neighbors=15`, 200 epochs, fixed seed
(umap-learn then runs single-threaded; numba warmed up first):

| Rows × dims | polars-umap | umap-learn |
|---|---:|---:|
| 10,000 × 50 | 1.1 s | 22.4 s |
| 100,000 × 50 | 12.4 s | 43.0 s |

Atlas offers polars-umap first when both are installed.

## Re-placing rows with cached neighbours (2026-11-21)

`python/bench_project.py`, on this repository's development Mac (Apple Silicon), synthetic blobs, 10 nearest anchors per row. "Place" is the first placement (index build and neighbour search included); "re-place" reuses the cached neighbours, which is what happens after a live UMAP change (`min_dist`, `spread`, …) or a new UMAP seed.

| Backend | Rows × dims | Anchors | Place | Re-place | Speed-up |
|---|---|---:|---:|---:|---:|
| numpy | 10⁵ × 50 | 20,000 | 0.72 s | 0.017 s | 43× |
| numpy | 10⁶ × 20 | 100,000 | 15.5 s | 0.225 s | 69× |
| Rust | 10⁵ × 50 | 20,000 | 0.027 s | 0.001 s | 27× |
| Rust | 10⁶ × 20 | 100,000 | 0.44 s | 0.004 s | 110× |

- The neighbour search runs in its own thread right after `prepare`, while the browser computes the anchor layout, so the first placement usually only waits for the weighted mean too.
- The cache costs 8 bytes per row and neighbour (u32 index + f32 squared distance): 80 MB for 10⁶ rows at k = 10. It is skipped above `positronAtlas.neighborCacheMB` (default 1,024 MB).
- The cache is keyed by metric and k, so cosine neighbours are cached too (2026-11-22). If both don't fit in the budget, the euclidean entries are evicted first; a cosine cache that alone exceeds the budget is skipped and the job status says why.

Cosine metric, numpy (`python/bench_project.py`, same machine):

| Rows × dims | Cosine neighbours (first placement) | Re-place from the cache | Per row |
|---|---:|---:|---:|
| 10⁵ × 50 | 0.88 s | 0.017 s | 0.21 µs |
| 10⁶ × 20 | 14.75 s | 0.18 s | 0.20 µs |
| 10⁵ × 1,000 | 2.96 s | 0.018 s | 0.20 µs |
