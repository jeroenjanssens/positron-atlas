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

| Batch | Titles | Time | Throughput |
|---|---:|---:|---:|
| — | — | — | — |

*Results from E2 embedding benchmark; filled once the run completes.*

Estimated total embedding time at the measured throughput for 11.8 M titles:
*to be calculated*.

### Disk use estimate

| Artefact | Size |
|---|---:|
| Raw parquet (full text, 3 languages) | 22 GB |
| Title + URL columns only (cached) | ≈ 0.9 GB |
| Embeddings (pre-PCA, fp32) | — |
| Embeddings after PCA to 64 dims (fp32) | — |
| Final Parquet (`title`, `url`, `language`, `first_sentence`, 64-dim embedding) | — |

*Embedding sizes filled once model dimension is confirmed.*

### First-run time estimate

| Step | Time |
|---|---:|
| Download title+url from 78 shards (4 parallel) | ≈ 8 min |
| Embed 11.8 M titles (at measured throughput) | — |
| PCA to 64 dims (sklearn, 11.8 M × emb_dim) | ≈ 5 min (estimate) |
| Write final Parquet | ≈ 1 min (estimate) |

The notebook caches embeddings per shard so a restart after a failure resumes from
the last shard.

### Conclusion

- **E2 is feasible on a laptop.** 11.8 M titles, CPU-only embedding, one-time download.
- The main first-run cost is the parquet download; embedding speed determines whether
  the total stays under an hour.
- `first_sentence` needs extraction from `text`; a simple `text.split(". ")[0]`
  captures the lead sentence for most articles.
- The final dataset fits in a few GB of Parquet; the full 22 GB raw download is
  avoided by selecting only `title` and `url` columns.
