# Plan: a Rust core for the kernel work, and polars-umap as an exact mode

> **Status (2026-11-21).** Implemented: R0–R6 and phase P (see the checkboxes and
> `docs/benchmarks.md`). Still to check on real machines: the macOS, Windows and Remote-SSH items of R3.
> Earlier status: plan only. Each phase ends with tests, numbers
> in `docs/benchmarks.md` and a commit. Do the work on its own branch, so it can ship independently
> of the DataMapPlot features (`docs/datamapplot-plan.md`).

## 1. Where the time goes today

The kernel helper (`python/positron_atlas_kernel.py`) is numpy only. UMAP itself and clustering
already run in Rust (embedding-atlas, compiled to WASM, in the webview).

| Work | Where | Cost (`docs/benchmarks.md`, M4 Pro) | Move to Rust? |
|---|---|---|---|
| Read columns, sample rows | pandas/polars → numpy | small; polars is already Rust | No: needs the user's objects |
| Missing values, standardize | numpy | small | Only if profiling says so (phase R4) |
| PCA (randomized SVD) | numpy BLAS | 0.3–22 s | Only if profiling says so (phase R4) |
| **Place rows** (10 nearest anchors, weighted mean) | numpy, IVF index | **≈ 13 µs per row: 14 s at 10⁶, 140 s at 10⁷** | **Yes (phases R1–R3)** |
| Colors, labels, selection statistics, cluster names | numpy | < 1 s (subsampled) | No |
| Write columns, new DataFrames | pandas/polars | small | No: changes the user's objects |
| Exact UMAP on all rows | umap-learn (numba) | minutes | Offer polars-umap (Rust) too (phase R5) |

So the work is:

1. **A Rust core for placing rows**, with numpy as the fallback, bundled in the extension so users
   still install nothing.
2. **polars-umap as a second exact engine** next to umap-learn, when it is installed.
3. **A polars-native path** in the Python helper for polars DataFrames: Polars' own Rust engine,
   with nothing to ship.
4. **Measure before moving anything else** (PCA, standardizing).

### Crates

| Need | Crate | Decision |
|---|---|---|
| Parallelism | `rayon` | Use |
| Python binding | `pyo3` (abi3), `numpy` (rust-numpy), `maturin` | Use |
| Nearest anchors | our IVF index; `nndescent` from apple/embedding-atlas (PyNNDescent port with a `query` API); `hnsw_rs` | Benchmark in R1, keep the best at our recall target |
| Distances | plain loops the compiler vectorizes; `pulp` or `simsimd` | Benchmark in R1 |
| PCA and blocked distances | `faer` (pure Rust, no BLAS or LAPACK to link) | Use in R4 if R0 shows a gain |
| Low-dimensional data | `kiddo` (k-d tree) | Only if R1 shows a gain at ≤ 20 dims |
| Seeds | `rand_pcg` | Use |
| Not used | `ndarray-linalg` (system LAPACK), `linfa` (too heavy), the `polars` crate (see below) | |

**Reuse (spike, done):** polars-umap 0.1.0 depends on apple/embedding-atlas's Rust crates `umap`
and `nndescent` as git dependencies (pinned revision). They build as native crates, and
`nndescent::NNDescent` has `query(query_data, k, epsilon)`, so it can serve as the anchor index.
It is the same code Atlas already runs as WASM in the webview.

**Not the `polars` crate.** Embedding it would add tens of MB per VSIX, couple Atlas to the user's
Python polars version through pyo3-polars, and still leave pandas on another path, for work that is
not the bottleneck. Instead, the helper uses the user's own polars (phase P) for polars frames.

What stays in Python: reading and writing the user's DataFrames, the job threads, status and files.
Moving row placement to the webview (WASM) does not work: the browser would need every row's
features, up to 40 GB, which is exactly what the anchor design avoids.

## 2. Phases

### Phase R0: baseline and profile — [x]

- Extend `python/bench.py` to time each part of placing rows separately: k-means for the index,
  nearest cells per query, candidate distances, top-k selection (`argpartition`), weighting. Run it
  at 10⁵, 10⁶, 10⁷ rows × 20, 50 (and 1,000 at 10⁵) dims, 100k anchors.
- Add an accuracy reference: on a 20k-row sample, the exact 10 nearest anchors by brute force.
  Report the IVF index's recall@10 and the mean placement error against the exact neighbors
  (in units of the layout's standard deviation). These numbers are the bar the Rust core must meet.
- Profile `prepare` the same way (reading, NaN handling, standardizing, PCA fit, PCA transform,
  writing) to decide phase R4.
- **Done when:** `docs/benchmarks.md` has the breakdown and the accuracy reference.

### Phase R1: the Rust crate (`rust/atlas-core`) — [x]

A pure Rust library, no Python, so it is testable with `cargo test` alone.

- **`AnchorIndex`**, the same algorithm as the numpy version so results are comparable:
  - exact brute force for ≤ 4,096 anchors;
  - otherwise IVF: k-means (≈ √n cells, at most 1,024, fit on ≤ 50k anchors, 8 Lloyd iterations),
    each anchor in its nearest cell, queries search their `nprobe = 4` nearest cells.
- **Query and place in one pass** per row: squared distances to the candidates, a fixed-size
  max-heap of the k = 10 best (no `argpartition` over full rows), then the weighted mean of the
  anchors' 2D positions with the current weights, `exp(-(d - ρ)/σ)`, ρ the nearest distance, σ the
  mean gap.
- **Speed:**
  - Parallel over query rows with `rayon` (chunks of a few thousand rows).
  - f32 math with loops the compiler can vectorize; group queries by cell so each cell's anchors
    stay in cache (the numpy version already sorts queries by cell).
  - Optional: blocked distances with the `gemm` crate when d ≥ 64; decide by benchmark.
- **Cosine metric:** normalize anchors and queries, as today.
- **Determinism:** k-means seeded from the job seed with a fixed RNG (`rand_pcg`); same input and
  seed give the same output on every platform. (It will not match numpy's RNG bit for bit; that is
  fine, see the tests.)
- **Cancellation and progress:** the caller passes an atomic flag and a progress counter, checked
  per chunk.
- **Tests (`cargo test`):**
  - exact mode equals brute force;
  - IVF recall@10 on blobs and on uniform data is at least the numpy version's (R0);
  - placement weights match a straightforward reference implementation;
  - NaN-free output; k larger than the number of anchors; one anchor; duplicate points;
  - cancellation stops within one chunk.
- **Done when:** `cargo test` passes and a Rust benchmark (`cargo bench` or a small binary) shows
  the speed-up on R0's sizes.

### Phase R2: Python binding, loaded by path — [x]

- A PyO3 module `_positron_atlas_core` built with maturin against the **stable ABI (`abi3-py310`)**,
  so one build per platform works for CPython 3.10 and newer. `rust-numpy` for zero-copy arrays.
- API, mirroring what `_project_impl` needs:
  - `Index(anchors: f32[n, d], seed: int, nprobe: int = 4, cosine: bool = False)`
  - `Index.place(x: f32[m, d] (may be a read-only memmap), rows: i64[r], anchor_xy: f32[n, 2],
    out: f32[m, 2], k: int = 10, cancel: Event-like, progress: callable | None)` writes the
    positions of `rows` into `out`.
- **Release the GIL** (`py.allow_threads`) for the whole computation, so the user's console stays
  responsive; Python only checks cancellation and reports progress between chunks.
- **Loading:** the extension passes the path of its bundled native module to the bootstrap code
  (`kernelBridge.ts`). The helper loads it with `importlib.machinery.ExtensionFileLoader` into
  `sys.modules["_positron_atlas_core"]`, like the helper itself: nothing is installed and nothing
  enters the user's namespace. It checks the module's version against the helper's.
- **Fallback:** if there is no binary for this platform, the Python is not CPython ≥ 3.10, loading
  fails, or the setting `positronAtlas.nativeCore` is false, the numpy code runs, unchanged.
  `describe` reports which backend is active; the footer shows it with the placement time
  ("placement 1.2 s (Rust)"). A load failure is logged to the Atlas output channel, not shown as an
  error.
- **Tests (pytest, parametrized over both backends):**
  - every existing projection test passes with each backend;
  - Rust vs numpy on the same data: recall@10 against brute force within 0.01 of each other, and
    mean placement difference below 1 % of the layout's spread;
  - cancelling during placement stops it; the console thread is not blocked (a second thread keeps
    running Python code while placement runs);
  - a missing or broken binary falls back to numpy and reports it.
- **Done when:** the harness scenarios pass with the native core loaded, and `python/bench.py`
  shows the speed-up end to end.

### Phase R3: packaging and CI — [x] (macOS, Windows and remote checks still to do on real machines)

Done: `scripts/build_native.py` (`--release`: manylinux2014 via Zig, verified glibc ≤ 2.17;
`--rust-target` for cross builds, verified for linux-arm64), `scripts/package.mjs` (universal VSIX
without a binary; `--target T` with native/T only), and a CI matrix for all five targets
(darwin-x64 and linux-arm64 cross-compiled, not tested). Loading the core from an unpacked VSIX was
verified on linux-x64. Not verifiable in this container: the macOS, Windows and Remote-SSH checks
listed below.

- **Build:** `npm run build:native` runs `maturin build --release` (abi3) and copies the module into
  `native/<platform>-<arch>/`. Development builds use the local toolchain.
- **Platform-specific VSIX files** (`vsce package --target …`), which Open VSX also supports:
  `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`. Plus a universal VSIX
  without a binary (numpy only) for every other platform.
- **CI (GitHub Actions):** a matrix job per target builds the module (manylinux2014 for Linux so
  it loads on older glibc; macOS deployment target 11), runs `cargo test` and the pytest suite with
  the native backend, then packages that target's VSIX.
- `extensionKind: workspace` already makes the extension (and its binary) install on the machine
  that runs the kernel, including Remote-SSH and Posit Workbench, so the binary matches the
  kernel's platform. Verify this in R3 on a Linux remote from a Mac.
- **To check early (a spike at the start of R3):**
  - macOS: a `.so` unpacked from a VSIX loads without Gatekeeper or quarantine prompts, from
    Positron's bundled and from user-installed Pythons (uv, pyenv, conda);
  - Windows: the `.pyd` loads in conda and python.org Pythons (abi3 links `python3.dll`);
  - Linux: loads on the oldest glibc we support; musl (Alpine) falls back to numpy.
- **Done when:** CI produces all VSIX files, and each one passes the harness scenarios on its
  platform (or at least the pytest suite with the native backend).

### Phase R4: more of `prepare` in Rust (only if R0 says so) — [x] (standardizing moved; PCA stays in numpy, see docs/benchmarks.md)

numpy's BLAS already does PCA's heavy lifting, so this phase only happens if R0 shows a large
share of `prepare` outside BLAS (for example NaN handling, standardizing in chunks, or the
float32 conversions at 10⁷ rows). Candidates, each behind the same fallback:

- one pass that reads a numeric block, applies the NaN policy and standardizes it;
- the PCA transform of the full data (the fit stays in numpy).

**Done when:** each moved step is faster in the R0 benchmark by at least 2×, or the phase is
dropped with the numbers recorded in `docs/benchmarks.md`.

### Phase P: polars-native path in the Python helper — [x] (vectorized category codes for pandas and polars, row-major reads; the comparison keeps its sample, see docs/benchmarks.md)

For polars DataFrames, do in polars expressions what is now done in numpy, so it runs on Polars'
Rust engine (multithreaded) with nothing to ship. pandas frames keep the numpy path.

- Reading features: select, cast to Float32 and handle missing values (drop or median) in one
  polars query before `to_numpy()`.
- Row sampling with `gather` on sorted positions (already the case), checked for speed.
- Category codes for colors and labels: `value_counts` and a join or `replace` on the codes,
  instead of Python-level `str()` over objects.
- Selection comparison and cluster descriptions: `group_by` on a codes column, so they can use all
  rows instead of a 50–100k row sample.
- **Tests:** every existing pytest case for polars frames gives the same result as before;
  benchmarks for 10⁶ and 10⁷ rows in `docs/benchmarks.md`.

### Phase R5: polars-umap as an exact engine — [x]

[polars-umap](https://polars-umap.jeroenjanssens.com) computes UMAP in Rust inside Polars. Atlas
already has an exact mode with umap-learn; this adds polars-umap as a second engine.

- **Detection:** `_optional_deps()` adds `polars_umap` (and requires `polars`).
- **UI (Map → UMAP → Compute):** "Browser (live)", "Kernel (umap-learn)", "Kernel (polars-umap)",
  each shown only when available. The default for the kernel engine is polars-umap when both are
  installed (faster, no numba compile on first use).
- **Implementation:** `_exact_impl(job, params, engine)`:
  - wrap the prepared features (`job.features`, possibly PCA'd, possibly a memmap) in a polars
    DataFrame without copying where possible;
  - call `pu.umap(...)` on the feature columns. polars-umap 0.1.0's parameters (checked) have the
    same names as umap-learn's, so every Atlas parameter maps one to one: `n_neighbors`,
    `min_dist`, `spread`, `metric` (euclidean, cosine and more), `n_epochs`, `learning_rate`,
    `negative_sample_rate`, `repulsion_strength`, `random_state`. Wheels exist for macOS (arm64,
    x64), Linux (x64, arm64, glibc and musl) and Windows x64;
  - write the coordinates in chunks, as umap-learn's path does. There is no progress and no
    cancellation inside the fit; like umap-learn, a superseded fit is orphaned and its result
    ignored.
- **Export → Code:** "Copy as Python (polars-umap)" next to the umap-learn snippet, using the
  same expression style as the `04-polars-umap.ipynb` example.
- **Tests:** pytest for the engine (skipped when polars-umap is not installed), checking shape,
  determinism with a seed and the parameter mapping; the examples' `exact` dependency group gains
  polars-umap.
- **Done when:** the exact mode runs with either engine from the UI, and the benchmark table has
  both engines at 10⁴–10⁶ rows.

### Phase R6: docs — [x]

- README: requirements stay "numpy plus pandas or polars"; a note that platform builds include a
  Rust core for placing rows, and which platforms fall back to numpy.
- `docs/benchmarks.md`: numpy vs Rust for placement, umap-learn vs polars-umap for exact mode.
- CHANGELOG entries; the setting `positronAtlas.nativeCore`.

## 3. Targets

These are goals to confirm in R0–R2, not promises:

| Size | Today (numpy) | Target (Rust) |
|---|---:|---:|
| Place 10⁶ rows, 50 dims, 100k anchors | 13.4 s | ≤ 2 s |
| Place 10⁷ rows, 20 dims, 100k anchors | 140 s | ≤ 20 s |
| Accuracy (recall@10, placement error) | R0 reference | no worse |
| Console while placing | responsive | responsive (GIL released) |

## 4. Risks

| Risk | Mitigation |
|---|---|
| A native binary does not load on some setups (Gatekeeper, old glibc, unusual Pythons) | Always fall back to numpy; a spike at the start of R3; log the reason |
| Per-platform packaging adds release work | CI builds every target; the universal VSIX stays numpy-only |
| Rust and numpy give slightly different layouts | Equivalence tests on quality (recall, placement error), not bit equality; the footer names the backend |
| The speed-up is smaller than hoped (memory bandwidth, not compute) | R0 profiles first; R1 has its own benchmark before any packaging work |
| Releasing the GIL while reading a memmap the user frees | The helper keeps a reference to the array for the whole call |
| polars-umap's options differ from Atlas's | Map what exists, show the rest as not used; tests pin the mapping |
| Installing the binary into the user's environment | Never: it is loaded by path, like the helper |

## 5. Order and effort

Phase P and R5 need no Rust build. R0 → R1 → R2 can be done and measured locally, without packaging. R3 is the costly part and only
starts once R2 shows a clear win. R5 does not depend on R1–R3 and can be done at any time. R4 is
optional.

Rough effort: R0 ½ day, R1 2–3 days, R2 1–2 days, R3 2–3 days (most of it CI and checking platforms),
R4 1–2 days if needed, R5 1 day, R6 ½ day.
