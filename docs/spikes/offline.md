# Offline spikes: P7 and E2

Measured on an Apple M4 Pro (24 GB), 2026-11-21.

---

## P7 — UMAP from a kernel kNN graph

The question is whether offloading the kNN step to the Rust core (which runs on all CPU cores
while the browser is busy elsewhere) is worth the work.

### Time split: kNN vs SGD in CPU UMAP

Synthetic Gaussian blobs, 50 blobs × 50 dims, `n_neighbors = 15`, 200 epochs, CPU-only
(WASM single thread). Measured with `createNNDescent` for the kNN step and
`createUMAPFromKNN` for SGD only.

| n | full (s) | kNN (s) | SGD (s) | kNN % |
|---:|---:|---:|---:|---:|
| 10,000 | 7.55 | 0.23 | 7.04 | 3.0 % |
| 25,000 | 18.65 | 0.59 | 18.12 | 3.2 % |
| 100,000 | 78.30 | 3.46 | 75.72 | 4.4 % |

**kNN is 3–4 % of CPU UMAP time.** The 100 k anchor run takes 78 s; replacing the
browser's NNDescent with Rust would save at most 3.5 s. P7 is not worth implementing
for speed alone on the CPU path.

The GPU (WebGPU) path is faster overall (100 k → 4.1 s), so the absolute saving would
be even smaller there.

### Rust IVF timing for the UMAP kNN step

Synthetic data as above. Rust IVF build + query (`Index(X).neighbors(X, k=15)`),
run on all cores in the kernel process.

| n | Rust IVF (s) | Browser NNDescent (s) | Speed-up |
|---:|---:|---:|---:|
| 10,000 | 0.044 | 0.23 | 5× |
| 25,000 | 0.067 | 0.59 | 9× |
| 100,000 | 0.199 | 3.46 | 17× |

Rust IVF is 17× faster than the browser's single-threaded NNDescent at 100 k, but the
absolute time saved (3.3 s out of 78 s) is still only 4 %.

**recall@15 at n=10,000:** 0.9327. For comparison, recall@10 from the placement
benchmark at 100 k × 50 dims (anchors for `project`): numpy IVF 0.840, Rust IVF 0.846
(`docs/benchmarks.md`).

### Layout quality: trustworthiness

UMAP on 10,000 points (5-nearest-neighbour trustworthiness, 5,000-point subsample),
run with `polars_umap`:

| Path | SGD time (s) | trustworthiness |
|---|---:|---:|
| Full UMAP (own NNDescent + SGD) | 0.44 | 0.9913 |
| UMAP from Rust IVF kNN (SGD only) | 0.38 | 0.9913 |

**Trustworthiness is identical.** The Rust IVF kNN graph produces the same layout
quality as NNDescent. `polars_umap.umap_from_knn` accepts
`(knn_indices: Array[Int64, k], knn_distances: Array[Float32, k])`.

### Conclusion

- **P7 speed optimization: not worth it.** kNN is only 3–4 % of CPU UMAP time;
  offloading it to Rust saves ≤ 3.5 s of a 78 s run, and nothing on the GPU path.
- **Quality is identical.** Rust IVF produces the same trustworthiness as NNDescent.
- **Consistency win available at low cost.** The kernel already computes a Rust IVF kNN
  graph for placement. Sending that same graph to the browser (via `createUMAPFromKNN`)
  would let UMAP and projection share one kNN computation, with no quality loss. This
  is a small change — worth doing as part of P5/P6, not as a standalone P7.

---

## E2 — Wikipedia titles example

### Dataset

Wikipedia November 2023 snapshot, three languages (Wikimedia Foundation, CC BY-SA 4.0).
Sizes from the Hugging Face datasets-server API.

| Language | Rows | Parquet shards | Parquet size |
|---|---:|---:|---:|
| English (en) | 6,407,814 | 41 | 11.6 GB |
| German (de) | 2,831,633 | 20 | 5.8 GB |
| French (fr) | 2,564,575 | 17 | 4.6 GB |
| **Total** | **11,804,022** | **78** | **22 GB** |

Schema per row: `id`, `url`, `title`, `text` (full article text). There is no
`first_sentence` column; it must be extracted from the `text` column (`text.split(".")[0]`
or a sentence splitter).

### Parquet column-selective reads over HTTP

Polars `read_parquet(url, columns=["title", "url"])` streams only those two columns:

| Shard | Rows | Title-only read |
|---|---:|---:|
| en/train/0000.parquet (420 MB) | 156,289 | 24 s |

Downloading all 78 shards in serial for titles and URLs: 78 × 24 s ≈ **31 min**. With
4 parallel workers that becomes ≈ 8 min. The notebook caches the results, so this is
a one-time cost.

### Embedding throughput

Model: `minishlab/potion-multilingual-128M` (MIT licence, CPU-only, model2vec).
Output dimension: **256** (then PCA to 64 dims as specified in the notebook plan).
Model file: 512 MB safetensors.

| Batch size | Throughput |
|---:|---:|
| 1,000 | 52,000 titles/s |
| 10,000 | 186,000 titles/s |
| 50,000 | 361,000 titles/s |

Throughput scales with batch size because model2vec is essentially a lookup-and-average
operation (no transformer, no attention). At 361k titles/s, **11.8 M titles embeds in
≈ 33 seconds** (batch size 50k).

**Model loading:** 76–210 s from cache (the 512 MB embedding matrix is memory-mapped
and read into RAM). First-ever run downloads the matrix from Hugging Face: ~15 min on
this machine.

### Disk use estimate

| Artefact | Size |
|---|---:|
| Raw parquet (full text, 3 languages) | 22 GB |
| Model download (one-time, `~/.cache/huggingface`) | ≈ 530 MB |
| Per-shard embedding cache (78 × ~160 MB, optional) | ≈ 12.5 GB |
| Final Parquet (`title`, `url`, `language`, `first_sentence`, 64-dim fp32) | ≈ 4 GB |

The notebook does not need to store the full 22 GB of article text. Each shard is
processed in turn: download → extract `first_sentence` from `text` → embed `title`
→ keep the 64-dim result → discard the text. Peak per-shard memory is about 160 MB.

### First-run time estimate

| Step | Time |
|---|---:|
| Download model (one-time) | ≈ 15 min |
| Download and process 78 shards (4 parallel, full columns for `first_sentence`) | ≈ 15–20 min |
| Embed 11.8 M titles (batch 50k, all cores) | ≈ 1 min |
| PCA fit + transform (11.8 M × 256 → 64 dims) | ≈ 5 min (estimate) |
| Write final Parquet | ≈ 1 min |
| **Total (after model download)** | **≈ 25 min** |
| **Total first ever run** | **≈ 40 min** |

The notebook caches per-shard embeddings so a restart resumes from the last shard.

### Conclusion

- **E2 is feasible on a laptop in about 25 minutes** (after the one-time model
  download). Embedding takes only ~1 minute; the bottleneck is downloading 22 GB
  of parquet shards (even column-selectively, the `text` column is needed for
  `first_sentence`).
- **`first_sentence` needs extraction** from `text`; a simple
  `text.split(". ")[0]` captures the lead sentence for most articles.
- **Final dataset: ≈ 4 GB** of Parquet (11.8 M rows × 64 dims + 4 string columns).
  Well within a typical laptop's storage.
- **Model loading (1–3 min on restarts)** is the unexpected cost. The notebook
  should load the model once at the top, before the shard loop.
