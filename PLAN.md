# positron-atlas: detailed plan

> **Status (2026-11-19).** Phases 0–7 are implemented and tested. Phase 8 (labels) and Phase 9 (R) are still open.
>
> Changes from this plan, decided during implementation:
> - **WebGPU UMAP is the default.** It is 13–20× faster than CPU WASM in Positron's webviews.
> - **The npm `embedding-atlas@0.26` UMAP has no Adam optimizer**, so animation uses SGD with a linear learning-rate decay.
> - **Positron 2026.10 lacks `dataExplorer.getContext()`**, so the Data Explorer button reads the variable name from the tab title.
> - **Controls are native inputs styled with VS Code theme variables**, not `@vscode-elements`.
>
> Measured numbers are in `docs/benchmarks.md`.

A Positron extension that opens a pandas or Polars DataFrame in an editor tab. The tab shows an interactive UMAP scatter plot, UMAP parameter sliders, and a color-by-column dropdown. Cluster labels come later.

## Requirements

| | |
|---|---|
| Rows | 10^4 – 10^7 |
| Columns | 10 – 10^3, mostly numeric |
| Languages | Python first (pandas, Polars). R later |
| Entry point (v1) | Data Explorer toolbar button and a Command Palette command. An upstream PR for the Variables pane is postponed |
| Color | Continuous for numeric columns, categorical for the rest |
| Distribution | `.vsix` for now. Open VSX later, so stay publishable from the start |

Research material is in `research/`: `positron` (sparse checkout), `embedding-atlas`, `datamapplot`.

---

## 1. What the scale requirement forces

| Quantity | Worst case | Consequence |
|---|---|---|
| Raw features 10^7 × 10^3 float32 | **40 GB** | We can never move it, and can't even fully copy it in the kernel. Reduce it *in the kernel*, streaming in chunks. |
| After PCA to 50 dims, 10^7 rows | 2 GB | Still too big for the browser. It stays in the kernel (memory-mapped temp file). |
| UMAP input that is practical in browser WASM | a budget of about 10^7 floats (n_anchors × d) | The exact budget is measured in Phase 0. Above it, run UMAP on an **anchor sample**. PCA is **off by default**, so wide data gets fewer anchors (e.g. d = 1000 gives about 10k anchors), and the UI suggests turning PCA on. |
| 2D coordinates for 10^7 rows | 80 MB float32 | Fine to send to the webview as binary. Not fine as base64 JSON. |
| Color column for 10^7 rows | 40 MB (f32) or 20 MB (u16 codes) | Fine. |
| Drawing 10^7 points | WebGL2 instanced points | Feasible on Apple Silicon and discrete GPUs. Needs a density mode, our own hit-testing, and benchmarking. |

These numbers lead to three design decisions:

1. **Hybrid compute: "anchor + project".**
   - Optionally, the kernel first keeps a **random sample of p % of the rows** (default 100 %, seeded). Everything after this step, including display, colors and tooltips, uses only the sampled rows.
   - The kernel standardizes the data. If the **PCA toggle** is on (default off), it also runs PCA, streamed in chunks.
   - The kernel samples ≤ `N_live` anchor rows, where `N_live = min(N_live_max, budget / d)`. It sends their feature vectors (PCA or raw) to the browser.
   - The browser runs the WASM UMAP on the anchors. This is live and animated, and the sliders respond.
   - The kernel then places all the other sampled rows: k nearest anchors in feature space, then a weighted average of their 2D positions.
   - For n ≤ `N_live` there is no projection step; every row is an anchor.
   - An optional **"Exact (kernel)" mode** runs full `umap-learn` (or cuML if a GPU is present) in the kernel. It isn't animated.
2. **Bulk data goes through binary files, not `evaluateCode`.**
   - The kernel writes raw little-endian `.f32`/`.u16` chunk files into a job directory supplied by the extension.
   - The webview `fetch`es them through `asWebviewUri`.
   - `evaluateCode` carries only small JSON control messages.
   - A base64-over-`evaluateCode` fallback covers small data, or setups where the kernel can't write to a directory the extension host can read.
3. **Kernel work runs in a background thread inside the kernel.**
   - It must not block the user's console for minutes.
   - `evaluateCode` calls return immediately with a job id, and the extension polls `status(job)`.
   - This works because `evaluateCode` waits for the *execution* queue to be idle, not for background threads.

---

## 2. Architecture

```
┌──────────── Kernel (Python) ─────────────┐   ┌────── Extension host (TS) ──────┐   ┌────────── Webview (editor tab) ───────────┐
│ _positron_atlas helper module            │   │ commands / entry points         │   │ UI (Svelte): controls, legend, status     │
│  describe(var)  → schema JSON            │◄──┤ KernelBridge (evaluateCode)     │◄─►│ UmapWorker (WASM, embedding-atlas)        │
│  prepare(var, opts) → job (thread)       │   │ AtlasPanel (WebviewPanel)       │   │ Renderer (deck.gl, WebGL2)                │
│     standardize → PCA → anchors          │   │ JobStore (temp dirs, cleanup)   │   │ HitIndex worker (grid, nearest point)     │
│  project(job, anchor_xy) → job (thread)  │   │ Serializer (restore tabs)       │   │ DataLoader (fetch chunk files)            │
│  colors(var, col) / row(var, i)          │   │                                 │   │                                           │
│  writes chunk files ─────────────────────┼───┼── job dir (localResourceRoots) ─┼──►│ fetch(asWebviewUri(chunk))                │
└──────────────────────────────────────────┘   └─────────────────────────────────┘   └───────────────────────────────────────────┘
```

Set `"extensionKind": ["workspace"]` so the extension host runs on the same machine as the kernel, including over Remote-SSH and on Posit Workbench. That makes the shared job directory work.

### Repository layout
```
positron-atlas/
  package.json                 # contributes: commands, menus, configuration
  src/extension/               # ext host (esbuild → dist/extension.js, CJS)
    extension.ts  kernelBridge.ts  atlasPanel.ts  jobStore.ts  protocol.ts  positron.ts
  src/webview/                 # webview (Vite → dist/webview/*, ESM)
    main.ts  App.svelte  controls/  render/  workers/umap.worker.ts  workers/hit.worker.ts  color/
  src/shared/protocol.ts       # message types shared by ext host and webview
  python/positron_atlas_kernel/  # kernel helper (pure numpy; optional deps detected)
    __init__.py  prepare.py  pca.py  project.py  colors.py  io.py
  python/tests/                # pytest (run with uv)
  scripts/make_datasets.py     # synthetic blobs 1e4..1e7 × 10..1000
  test/                        # vitest (webview logic), extension integration tests
```

### Kernel helper module
- **Loading.** On first use, `evaluateCode` runs a bootstrap snippet. It uses `importlib.util.spec_from_file_location` to load `python/positron_atlas_kernel` into `sys.modules["_positron_atlas"]`. Nothing goes into the user's namespace.
- **Versioning.** The module is versioned, and the bootstrap reloads it if the extension's version differs.
- **Finding the DataFrame.** Variables are resolved via `get_ipython().user_ns[name]`. We keep a reference to the object, so the job survives the user rebinding the name. In-place mutation during a job is documented as undefined.
- **Return values.** Functions return `json.dumps(...)` strings. That avoids Positron's lossy `_to_json_compatible` conversion, and NaN becomes `null` explicitly.
- **Dependencies (decided: numpy only).** The only requirement is **numpy**, plus pandas or polars, whichever the object is. The default path (sampling, standardizing, PCA via randomized SVD, brute-force kNN projection) is implemented in pure numpy. Optional accelerators, detected at runtime and never required:
  - `pynndescent` or `faiss`: fast kNN for projection
  - `scikit-learn`
  - `umap-learn` or `cuml`: exact mode

  The UI shows which are available. If one is missing, it offers `uv pip install …`, or `pip install …` if the environment isn't uv-managed.

### API (all calls are quick; heavy work goes to a thread)
| Function | Returns |
|---|---|
| `describe(var)` | n_rows, columns `[{name, dtype, kind: numeric/categorical/datetime/bool/other, n_unique_est, null_frac}]`, available optional deps, memory estimate |
| `prepare(var, {features, sample_pct, standardize, pca: bool, pca_dims, nan_policy, n_live, seed, job_dir})` | job id. The thread draws the row sample (`sample_idx.u32`, sorted original row positions) and streams chunks of the sampled rows. It fits mean/std and, if `pca`, PCA on a sub-sample, then transforms into a memmapped `features.f32`. It writes `anchors.f32` and `anchor_idx.u32`, and reports the kept row count after sampling and the NaN policy |
| `status(job)` | `{stage, progress 0..1, message, outputs[]}` |
| `project(job, anchor_xy_path, {k, weighting})` | job id. The thread runs kNN from all rows to the anchors and writes `xy_000.f32 … xy_NNN.f32` (1M rows per chunk) progressively |
| `exact_umap(job, params)` | job id. Full umap-learn/cuML in the thread, writing `xy_*.f32` |
| `colors(var, column, job)` | Writes `color.f32` (numeric/datetime: float, with quantiles in JSON) or `color.u16` plus a categories list (top-K, "Other", null). Row-aligned with the kept rows |
| `row(var, i)` | One row as JSON for tooltips (lazy, on hover). `i` is a sampled-row index, mapped back to the original row through `sample_idx` |
| `cancel(job)`, `cleanup(job)` | |

`anchor_xy_path` points to a file the extension host writes for the kernel: the webview posts the anchor embedding and the extension host writes it to disk.

### Webview ↔ extension host protocol (`src/shared/protocol.ts`)
- **Webview → extension host:**
  - `ready`
  - `requestPrepare(opts)`
  - `requestProject(anchorXY: Float32Array)`
  - `requestColors(column)`
  - `requestRow(i)`
  - `cancel`
  - `saveState`
  - `exportCoords`
  - `log`
- **Extension host → webview:**
  - `init({schema, deps, settings, theme})`
  - `jobStatus`
  - `filesReady({kind: 'anchors'|'xy'|'color', uris[], dtype, shape, meta})`
  - `row`
  - `error`
  - `sessionChanged`

Typed `ArrayBuffer`s are only posted for small payloads. Bulk data always goes through `filesReady`, and then the webview fetches the files.

---

## 3. Phases

Each phase ends with acceptance criteria. Milestones:
- **M1** = P0–P2: tab opens and data arrives
- **M2** = P3–P5: usable up to `N_live` rows
- **M3** = P6: 10^7 rows
- **M4** = P7: polished `.vsix`
- **M5** = P8/P9: labels and R

### Phase 0: spikes and benchmarks (2–3 days; these gate later decisions)
1. **WASM UMAP in a Positron webview.**
   - Bundle `createUMAP` from npm `embedding-atlas` with Vite, using an inline worker and inlined or `asWebviewUri` WASM.
   - CSP: `script-src 'wasm-unsafe-eval' ${cspSource}; worker-src blob:; connect-src ${cspSource}`.
   - Measure time per stage (kNN, init, 200 epochs) for 10k / 50k / 100k / 200k / 500k × 16 / 32 / 64 dims, using embedding-atlas's `benchmark/browser` as a reference. **Output: the `N_live` default and the default PCA dimension count.**
   - Check whether `gpu: true` (WebGPU) works in Positron webviews. If it does, `N_live` grows.
2. **deck.gl at 10^7 points.**
   - Run `ScatterplotLayer` with binary `Float32Array` positions and `Uint8Array` colors in a webview with `OrthographicView`.
   - Measure frames per second during pan and zoom, upload time and memory, at 1M, 5M and 10M points.
   - **Gate:** if 10M isn't usable, compare `regl-scatterplot` and a minimal custom WebGL2 point renderer.
3. **Binary transfer.**
   - The kernel writes an 80 MB `.f32` into a job directory, and the webview fetches it through `asWebviewUri`.
   - Measure throughput, locally and over Remote-SSH.
   - Compare with base64 through `evaluateCode` at 1, 10 and 50 MB to set the fallback threshold.
4. **Background thread in the kernel.**
   - Confirm `evaluateCode` returns while a helper thread is computing.
   - Confirm the console stays responsive during chunked numpy PCA on 10^7 × 10^3. Use a memmap source or Polars to test without 40 GB of RAM.
5. **Projection kNN cost (numpy only).** Time chunked numpy brute force for 10^7 rows × {10k, 50k, 200k} anchors × {50 (PCA), 100, 1000 (raw)} dims. Compare with pynndescent and faiss as optional accelerators. This sets the default anchor budget, the time-estimate formula, and when to show the "enable PCA" hint.
6. **Row sampling cost.** Time sampled-row reads (`df.take` / `df.iloc[idx]` in chunks) at 1 %, 10 % and 50 % of 10^7 rows, for pandas and Polars.

Throwaway spike code lives in `spikes/`, and the results go into `docs/benchmarks.md`.

### Phase 1: new extension
- Scaffold with `yo code`: TypeScript, esbuild for the extension host, plus a separate Vite build for the webview (Svelte 5).
- `engines.vscode` should match Positron's VS Code base.
- Add `@posit-dev/positron` and keep a `positron.ts` wrapper:
  - `tryAcquirePositronApi()`.
  - If it returns `undefined` (plain VS Code), show a clear "requires Positron" message.
- Tooling:
  - ESLint and Prettier
  - vitest for webview logic
  - pytest via `uv run --with pandas,polars,numpy pytest python/tests`
  - GitHub Actions CI (lint, unit tests, `vsce package`)
- Debugging: `launch.json` for running Positron as the Extension Development Host.
- Hello-world `AtlasPanel`:
  - `createWebviewPanel('positronAtlas.view', …, {enableScripts, retainContextWhenHidden: true, localResourceRoots: [dist, jobRoot]})`.
  - Theme tokens come from VS Code CSS variables.
- **Done when:** a command opens an empty themed tab in Positron, and CI produces a `.vsix`.

### Phase 2: entry points and kernel bridge
Entry points:
- **Data Explorer button.**
  - `contributes.menus["editor/actions/right"]` with `when: isPositron && activeEditor == 'workbench.editor.positronDataExplorer'` and an icon such as `$(graph-scatter)`.
  - The handler calls `positron.dataExplorer.getContext()` and gets `displayName`, `source.sessionId` and `languageName`.
  - It refuses non-Python sessions for now ("R support coming").
  - Also add the button to `editor/title` in case `editor/actions/right` doesn't render; check this in P0.
- **Palette command "Atlas: Open DataFrame…".**
  - Lists table-like variables from `getSessionVariables(foregroundSessionId)`, filtered on `display_type`/`type_info` (DataFrame, Polars DataFrame).
  - Also accepts the identifier under the cursor in the editor.
- **Upstream (postponed).** An issue or PR proposing a `positronVariables/context` menu is on hold. Keep the entry-point code behind one `openAtlas({sessionId, variableName})` function so another entry point is easy to add later.

Bridge:
- `KernelBridge` handles bootstrap and versioning of the helper and typed wrappers for each kernel function.
- Every call uses `evaluateCode(lang, code, token, sessionId, RuntimeBusyBehavior.Queue)` and a timeout.
- Variable names are always passed as JSON string literals, never interpolated as raw code.
- Status polling uses backoff: 100 ms, rising to 1 s.

Other pieces:
- `JobStore`: one job directory per panel under `context.globalStorageUri/jobs/<uuid>`. It is removed when the panel closes and swept on activation.
- Session handling: listen to `onDidChangeForegroundSession` and session state changes. On kernel restart, mark the panel stale and show a "Reload" banner.
- Implement `describe()` for pandas (including nullable dtypes and `category`) and Polars (`DataFrame`, plus `LazyFrame` with a "collect first?" prompt).
- **Done when:** clicking the button on a 10^6-row DataFrame opens a tab showing the schema, row count and dependency status within about 1 s. pytest covers `describe` for pandas and Polars.

### Phase 3: prepare and browser UMAP (n ≤ `N_live`)
Kernel `prepare` thread:
- Select feature columns. The default is all numeric and bool columns.
- Row sampling: keep a seeded uniform random `sample_pct` % of the rows (default 100 %), using `rng.choice(n, m, replace=False)` sorted to preserve order. Only the sampled rows are read after this.
- NaN policy: `drop rows` (default, reports the count) or `impute median`.
- Standardize (on by default). Mean and std are computed exactly with a streaming pass.
- PCA toggle (**default off**). When on, reduce to `pca_dims` dimensions (default 50, from P0):
  - Fit randomized SVD (pure numpy) on a sample of ≤ 100k rows.
  - Transform in 100k-row chunks into a memmap.
  - Report explained variance, which the UI shows.
  - When off, the standardized raw features are memmapped instead. If d is large enough that the anchor budget falls below about 20k anchors, the UI shows a hint: "Wide data: enabling PCA allows more anchors and faster projection".
- Pick anchors: uniform random with a seed (stratified by color column as an option later). Write `anchors.f32` and `anchor_idx.u32`.
- For cosine metric, L2-normalize rows.

UMAP worker (`umap.worker.ts`):
- `createUMAP(n, d, 2, data, {nNeighbors, minDist, spread, metric, seed, optimizer:'adam', initializeMethod:'auto', progress})`.
- Then loop `step(k)` and post a *copy* of `embedding` at most every 33 ms, as a transferable.
- The annealing schedule follows embedding-atlas `docs/algorithms.md`.
- Commands: `start`, `setLive({minDist, spread, …})` (continues stepping), `rebuild` (new nNeighbors, metric or seed), `stop`, `cancel`.
- **Done when:** for 100k × 784 (MNIST-like), the user clicks the button and sees the points animate into the familiar clusters. Cancel works. PCA output matches sklearn within tolerance in pytest.

### Phase 4: drawing points
- Renderer behind an interface (`setPositions`, `setColors`, `setStyle`, `fitView`, `onHover`) so P0's choice can be swapped later.
- deck.gl (likely):
  - `OrthographicView`.
  - `ScatterplotLayer` with binary attributes, `radiusUnits: 'pixels'`, and `updateTriggers` to update positions without reallocating.
- Positions: during animation, update in place every frame. For 10^7 points, re-upload only after projection chunks arrive.
- **Hit-testing:** deck.gl GPU picking isn't viable at 10^7, so use our own `hit.worker.ts`.
  - A uniform grid index over the 2D coordinates, rebuilt when the layout settles.
  - Nearest-point lookup on hover, then `requestRow(i)` gives tooltip data from the kernel.
- Render modes:
  - **Points:** alpha blending, with point size and opacity adapted to zoom and n.
  - **Density:** a GPU-aggregated screen-space histogram with a log color scale, colored by the mean value or majority category per bin. This matters at 10^6 – 10^7 points, where a scatter plot overplots into a blob.
- Color pipeline (`color/`):
  - Numeric: robust range (2nd–98th quantiles from the kernel), with viridis, cividis or magma, and a diverging scale when the range spans 0.
  - Categorical: Tableau10 for ≤ 10 categories, Glasbey for ≤ 30, then "Other". NaN and null are grey.
  - Colors map to an RGBA `Uint8Array` in a worker, about 100 ms for 10^7.
  - Legend or colorbar component.
- **Done when:** 100k points pan and zoom at 60 fps. Hover shows a tooltip with row values. Switching color columns takes < 1 s.

### Phase 5: controls
Layout: a collapsible control sidebar (left), the canvas filling the rest, and a status line at the bottom (rows, anchors, epoch, stage timings, explained variance).

What each control triggers:

| Control | Range / default | Triggers |
|---|---|---|
| Feature columns (multi-select with search) | all numeric | kernel `prepare` |
| Sample % of rows (slider, log-scaled, plus number box) | 0.1–100 %, 100 % | kernel `prepare` (uses the seed). Shows the resulting row count, e.g. "10 % → 1,000,000 rows" |
| Standardize | on | kernel `prepare` |
| Apply PCA first (toggle) | **off** | kernel `prepare` |
| PCA dims (enabled only when the toggle is on) | 50 | kernel `prepare` |
| NaN policy | drop | kernel `prepare` |
| Anchor sample size `N_live` | from P0 | kernel `prepare` |
| `n_neighbors` | 2–200, 15 | rebuild in worker (debounced 300 ms) |
| `metric` | euclidean / cosine | rebuild |
| `seed` (and a 🎲 button) | 42 | rebuild |
| `min_dist` | 0–1, 0.1 | **live** |
| `spread` | 0.5–3, 1.0 | **live** |
| `repulsion_strength`, `learning_rate`, `negative_sample_rate` (advanced) | | **live** |
| `n_epochs` | 50–1000, 200 | run length |
| Color by | any column | kernel `colors` only |
| Colormap, point size, opacity, render mode | | render only |

- Widgets: native `<input type=range>` paired with a number box, styled with VS Code CSS variables. Use `@vscode-elements/elements` for dropdowns, checkboxes and collapsibles.
- Buttons: Run, Pause, Reset. Changes that need a kernel step show "Apply" instead of firing on every move.
- State: save it with `vscode.setState` and keep it across reloads with a `WebviewPanelSerializer`. Restore re-runs from the saved parameters. Caching layouts is an optional later step.
- Settings: `positronAtlas.defaultLiveRows`, `positronAtlas.defaultSamplePct`, `positronAtlas.pcaEnabled` (default false), `positronAtlas.pcaDims`, `positronAtlas.defaultColormap`, `positronAtlas.jobDir`.
- **Done when:** every control works at 100k rows, live sliders visibly reshape the layout without restarting, and state survives a window reload.

### Phase 6: scale to 10^7 rows
- Kernel `project` thread:
  - Build a kNN index on the anchors' feature vectors (PCA or raw). The default is numpy brute force in BLAS chunks (`‖x‖² − 2x·a + ‖a‖²`, then `argpartition`). pynndescent or faiss are used instead when detected.
  - Brute force costs about n × n_anchors × d. With PCA off on wide data this gets slow, so the UI shows an estimated time before projecting and suggests the PCA toggle or a lower sample %.
  - Query all rows in chunks with k = 10, using the anchor kNN graph.
  - Place each row at the weighted mean of its neighbors' 2D positions, with weights from UMAP-style membership `exp(-(d-ρ)/σ)`.
  - Write `xy_###.f32` chunks progressively.
- Flow: anchors animate in the browser, the layout converges (or the user clicks "Project all"), the anchor embedding goes to the kernel, chunks stream in and the plot fills in progressively.
- While the user drags a live slider, show anchors only. Re-project, debounced, when they release.
- Memory guards:
  - `describe` estimates kernel memory for PCA/memmap and warns.
  - The webview checks typed-array allocation and falls back to downsampled display (stratified 2M points plus density mode).
- Exact mode (optional): `umap-learn`/`cuml` in the kernel thread, with a time estimate and cancel.
- Synthetic data via `scripts/make_datasets.py`: Gaussian blobs and nested manifolds at 1e4, 1e5, 1e6, 1e7 rows × 10, 100, 1000 columns, as Parquet. Load them with Polars and pandas.
- **Done when:** 10^7 × 100 (Polars, numpy only, PCA on), from click to first anchor layout in < 30 s and fully projected in < 5 min on an M-series Mac. At 10 % sample, fully projected in < 30 s. Pan and zoom stay usable in density mode. The console stays responsive throughout. The real targets are adjusted after P0.

### Phase 7: polish and packaging (M4)
- Error UX:
  - No numeric columns
  - All-NaN rows
  - Kernel restart mid-job
  - Disk full
  - Missing optional dependency (offer an install command)
- Actions:
  - "Add UMAP coordinates to DataFrame". This writes `umap_x`/`umap_y` back into the user's frame with `evaluateCode`, so confirm first. Note that it can't work in place for Polars; it needs rebinding.
  - "Export PNG"
  - "Copy parameters as Python" (equivalent `umap.UMAP(...)` code)
- Accessibility: keyboard focus on controls, ARIA labels, and colorblind-safe default palettes.
- Telemetry: none.
- Docs: README with GIFs, CHANGELOG, LICENSE (MIT, matching embedding-atlas and datamapplot), third-party notices.
- Packaging: `vsce package`. Prepare `ovsx` publishing (namespace, icon, categories) but don't publish yet.

### Phase 8: labels (later)
- **Clustering** of the 2D layout:
  - Use embedding-atlas `findClusters` on a density map in WASM: fast, in-browser, works at any n.
  - Or HDBSCAN in the kernel as an option.
  - Multiple resolutions give hierarchical layers.
- **Naming**:
  - (a) Dominant category of a chosen column.
  - (b) Most distinguishing numeric features: largest |z| of the cluster mean versus the global mean, giving names like "↑income ↓age". This is computed in the kernel on the original columns.
  - (c) Later, LLM naming via Positron Assistant, opt-in.
- **Placement**:
  - deck.gl `TextLayer` with `CollisionFilterExtension`. Watch the 9.2/9.3 regression that datamapplot pins around.
  - Collision priority banded per layer, so coarse labels win (datamapplot `compute_collision_priority`).
  - Font size proportional to cluster size, positioned at the medoid.
  - Optional cluster hulls (`PolygonLayer`) and datamapplot's position-based palette for cluster coloring.

### Phase 9: R support (later)
- Port the helper to R (`positronAtlas` script sourced into a private environment). It uses the same JSON plus binary-file protocol, with data.frame, tibble and data.table via `writeBin`.
- Check first how ark converts `evaluateCode` results; returning a JSON string sidesteps the question.
- Background work in R has no threads, so use `callr`/`mirai`, or accept blocking with progress for prepare.

---

## 4. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Browser WASM UMAP slower than hoped | `N_live` is tunable, plus WebGPU `gpu:true` if available, plus kernel exact mode |
| deck.gl can't handle 10^7 points | Renderer interface. Fallback to regl-scatterplot or custom WebGL2. Density mode and downsampled display |
| Kernel can't share files with the extension host (exotic remote setups) | Detect it by writing a probe file, then fall back to base64 `evaluateCode` with a downsampled display |
| Background threads and the GIL make the console sluggish | Chunk sizes keep GIL hold short. numpy BLAS releases the GIL. Allow a subprocess for exact mode |
| Positron API changes (`getContext`, `editor/actions/right`) | Pin `@posit-dev/positron`, feature-detect, and test against Positron releases in CI |
| numpy-only brute-force kNN too slow at 10^7 rows (worse with PCA off) | Time estimate up front, sample % control, PCA toggle hint, chunked progress and cancel. Use accelerators automatically if present |
| Projection quality worse than true UMAP on all rows | Document it, offer exact mode, and allow larger anchor sets. kNN-weighted placement is the standard approach (as in openTSNE/parametric UMAP) |
| User mutates the DataFrame mid-job | We hold a reference. Detect shape changes on poll and mark the result stale |

## 5. Testing strategy
- **Python:** pytest via `uv` covering `describe`, `prepare` (pandas, Polars, nullable dtypes, NaN policies, PCA against sklearn), `project` (against brute-force ground truth), and `colors`.
- **TypeScript:** vitest for color mapping, the protocol, the hit index and debouncing logic.
- **Integration:** `@vscode/test-electron` pointed at a Positron build, if feasible. Otherwise a manual checklist per release.
- **Performance:** keep a benchmark table in `docs/benchmarks.md` (P0 numbers, re-run per milestone).

## 6. Decisions

Decided:
1. **Webview UI framework:** Svelte 5.
2. **Python dependencies:** numpy only, plus pandas or polars, whichever the DataFrame is. Optional accelerators are detected but never required.
3. **Upstream Positron issue/PR** (Variables context menu): postponed. Not part of the phases for now.
4. **PCA:** a toggle, default off.
5. **Row sampling:** a "sample %" control, default 100 %.

Still open (decided by Phase 0, or by recommendation):
- **Default anchor budget / `N_live_max`:** from P0 benchmarks, probably 100k–200k rows or about 10^7 floats.
- **Anchor sampling:** uniform random (recommended for v1); stratified or density-aware later.
