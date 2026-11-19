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
