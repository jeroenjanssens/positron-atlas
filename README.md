# Positron Atlas

Interactive UMAP scatter plots of high-dimensional DataFrames, right inside [Positron](https://positron.posit.co).

Open a pandas or polars DataFrame (or a pyarrow Table, DuckDB relation, or lazy frame through narwhals) with many numeric columns and Atlas shows a UMAP map of its rows in an editor tab, in 2D or 3D. The layout animates while it converges, the UMAP parameters are sliders, and you can color, label, filter, annotate and export the map, in the style of [DataMapPlot](https://github.com/TutteInstitute/datamapplot).

## Features

- **Live UMAP in the browser.** UMAP runs in a web worker using the Rust/WASM port from [apple/embedding-atlas](https://github.com/apple/embedding-atlas), on the GPU (WebGPU) when available. You watch the layout converge.
- **Live parameters.** `min_dist`, `spread`, repulsion strength, negative sample rate and learning rate change the running layout. `n_neighbors`, metric, epochs and seed rebuild the neighbor graph.
- **Large data (10⁴ to 10⁷ rows).** UMAP runs on up to 100,000 *anchor* rows. The remaining rows are placed in the kernel by their nearest anchors, streamed in chunks. Platform builds include a small Rust core that does this 8–13× faster (10⁷ rows in about 15 s on 4 cores); elsewhere, or with `positronAtlas.nativeCore` off, the same algorithm runs in numpy.
- **Sampling, standardization, optional PCA** (off by default) and a missing-value policy.
- **Labels on the map.** Label the map by a categorical column, or by **automatic clusters** of the layout (density clustering from embedding-atlas, with outlines). Each label is written at the densest spot of its points, sized by group size, and labels that would overlap are hidden (larger groups win). Clusters can be named by number, by their most distinguishing columns ("↑ income ↓ age", computed in the kernel) or by the most common value of a column.
- **Color by any column.** Numeric and datetime columns get continuous colormaps (viridis, cividis, magma, …). Text, categorical, boolean and low-cardinality integer columns get categorical colors, with a legend. By default the categorical palette follows the map: groups that are close together get related hues and outlying groups are more saturated (after DataMapPlot).
- **Lasso selection.** Draw around points with the lasso tool, or hold Shift (add) or Alt (remove) and drag. The other points fade. **Compare with all rows** lists the most over-represented values and the largest differences in column means; **New DataFrame** puts the selected rows in a new variable (`<name>_selection`). The selection is kept when the layout changes.
- **Hover and pinned cards.** The tooltip appears instantly with a title from a text column (detected automatically), with the row's fields loaded in the background (prefetched for nearby points, cached). Click a point to pin its card; links in a URL column open from the card, or directly with Cmd/Ctrl-click.
- **Points are images.** For image data with one pixel per column (such as `px0` … `px783`), or a column of image URLs or file paths (downloaded by the extension after you allow it), the card shows the row as a picture.
- **Legend toggles, search and filters.** Click a legend entry to hide a group, Alt-click to show only that group. Search the title column (matches are highlighted, Enter zooms to them). Brush a histogram of a numeric or date column to filter points. All filters combine on the GPU, also at 10⁷ points.
- **DataMapPlot-style annotation.** A font picker (bundled fonts, any Google Font, or an installed font), label weight by group size, wrapping and halos; labels at two levels of detail that appear as you zoom in; draggable labels that remember their position; highlighted labels in filled badges; labels **around the map** with straight, curved or wedge leader lines; a soft **glow** around clusters; color by cluster with grey "Unlabelled" points; point size by a column; a title, subtitle and logo; and **point annotations**: click a point to add a callout with its title or, for image data, its image, then drag it where you want.
- **3D.** Switch Map → UMAP → Dimensions to 3D for a rotatable map (orbit, reset, auto-rotate, top/front/side views), with hover, lasso, legend and filters.
- **Points or additive density mode**, a background color picker, pan and zoom, full screen.
- **Export** a PNG of the map as shown (labels, annotations and title included), a **self-contained HTML file** with an interactive viewer and the data embedded (works offline; 2.7 MB for MNIST with images), or an interactive DataMapPlot page (when `datamapplot` is installed).
- **Write coordinates back** to the DataFrame (`umap_x`, `umap_y`) and **copy equivalent umap-learn code**.
- **Tags and clusters back to the DataFrame.** Tag the selected rows (`atlas_tag`) or write the automatic cluster names (`atlas_cluster`); the new column can be used for colors and labels right away. **Copy as DataMapPlot code** draws the same map with [DataMapPlot](https://github.com/TutteInstitute/datamapplot).
- **Optional exact mode**: if [polars-umap](https://polars-umap.jeroenjanssens.com) or `umap-learn` is installed in the kernel, run full UMAP on all rows there instead (Map → UMAP → Compute). polars-umap is UMAP in Rust and 3.5–20× faster. Without WebGPU, polars-umap can also lay out just the anchors in the kernel (much faster than the browser's CPU fallback).
- **Fast re-placement.** After a live UMAP change, rows are placed again from their cached nearest anchors, 27–110× faster than the first placement; the neighbour search runs while the browser computes UMAP.
- **Help next to every setting.** An ⓘ explains what each control does, how to think about it, and whether changing it is live or rebuilds the layout. The interface uses Positron's own controls and theme colors.

## Requirements

- Positron 2026.10 or newer.
- A Python session with **numpy** and the DataFrame library you use (pandas or polars). Nothing else is required.

## Installation

Build the package (or use a prebuilt `positron-atlas-<version>.vsix`) and install it into Positron:

```sh
npm install && npm run package
/Applications/Positron.app/Contents/Resources/app/bin/code --install-extension positron-atlas-0.1.0.vsix
```

You can also run **Extensions: Install from VSIX…** from Positron's Command Palette. Then reload the window.

## Usage

- **From the Data Explorer.** Open a DataFrame from the Variables pane, then click **Open in Atlas**, the first button in the Data Explorer's toolbar (top left).
- **From the Command Palette.** Run **Atlas: Open DataFrame…** and pick a DataFrame from the foreground Python session, or enter an expression.

Positron does not yet let extensions add items to the Variables pane itself, so the Data Explorer button is the closest entry point.

### Example notebooks

The `examples/` folder in the source repository has notebooks with real data: MNIST and Fashion-MNIST (70,000 × 784 each), Covertype (581,012 rows), HIGGS (11,000,000 × 28), and **Wikipedia titles** (11.8 million English, German and French articles with titles and URLs, embedded with a static embedding model on the CPU), all as polars DataFrames. Each one downloads its dataset once; the Wikipedia notebook needs `uv sync --group wikipedia` in `examples/` and about 40 minutes on the first run (mostly downloading).

Three pharma/bio notebooks are also included: **ChEMBL chemical space** (100,000 small molecules as 64-component Morgan-fingerprint projections with structure images and phase metadata), **UniProt protein embeddings** (the full human proteome — ~20,000 proteins — using 1,024-dim ProtT5 embeddings from the UniProt FTP), and **ClinicalTrials.gov** (612,000+ studies embedded from their titles with model2vec).

### Anchors

UMAP runs in the browser on the *anchors*, a random subset of the (sampled) rows. Every other row is placed in the kernel at the weighted average position of its 10 nearest anchors (measured in the original feature space). By default the number of anchors is the smallest of:

- 100,000 with WebGPU, or 25,000 on the CPU (settings `positronAtlas.maxAnchors` and `positronAtlas.maxAnchorsCpu`),
- 10 million values ÷ the number of dimensions (`positronAtlas.anchorBudget`; with 785 columns that is about 12,700, so apply PCA for wide data),
- the number of rows.

The **Anchors** slider in the Data section changes it per tab, within the last two limits. When every row is an anchor, no placement is needed.

### Controls

The sidebar has four tabs. The plot has its own toolbar (top left): **Pan and zoom**, **Lasso select**, **Annotate**, **Fit to view** and **Full screen** (plus the camera buttons in 3D), with a **search box** below it. Every setting has an ⓘ with an explanation.

| Tab | Section | Control | Effect |
|---|---|---|---|
| Map | Data | Features, sample %, standardize, PCA, anchors, missing values, seed | Click **Apply** to re-prepare in the kernel |
| Map | UMAP | Neighbors, epochs, metric, seed (`rebuild`) | Restarts UMAP |
| Map | UMAP | Min distance, spread, advanced (`live`) | Applied to the running layout |
| Map | UMAP | Pause, +1 / +10 epochs, resume, done; restart paused | Step through the optimization epoch by epoch |
| Map | UMAP | Dimensions: 2D or 3D (`rebuild`) | Restarts UMAP |
| Map | Result | Place all rows (when UMAP ran on anchors) | Kernel |
| Explore | Color | Color by (a column or the automatic clusters), treat as categories, palette (follows the map, Tableau 20 or color-vision safer), colormap, range | Recolors |
| Explore | Size, Filter | Size by a column; histogram brush filter on a numeric or date column | Rendering; the values come from the kernel |
| Explore | Display | Point size, opacity, points/density, glow, background color (or follow the theme), points are images (image width, invert colors) | Rendering only |
| Explore | Tooltip | Title column, fields, link column, image URL column, load images from URLs | Hover and pinned cards |
| Explore | Selection | Selected rows, clear, invert, compare with all rows | The comparison runs in the kernel |
| Annotate | Labels | Label by a column or by automatic clusters (detail, two levels of detail, name by number, distinguishing columns or the most common value of a column, outlines), finer labels by a second column, label style (over the points or around the map with leader lines), sizes, color labels like the points | Rendering; clusters are found when the layout settles |
| Annotate | Typography, highlights, positions | Font, weight and weight range, wrap width, line spacing, halo, letter case; highlighted labels; reset dragged label positions | Rendering only |
| Annotate | Title, annotations | Title, subtitle, font, size, color, logo; the list of point annotations (go to, rename, delete, export and import as JSON) | Rendering only; shown in exports |
| Annotate | Tags | Tag the selected rows (writes a string column, `atlas_tag` by default) | Writes to the DataFrame after a confirmation |
| Export | Image | Export PNG (with labels, outlines, annotations, title and glow) | |
| Export | Interactive | HTML… (self-contained viewer with the data; sample, tooltip columns, images), Export with DataMapPlot | Save dialog |
| Export | To the DataFrame | Add coordinates (`umap_x`, `umap_y`), new DataFrame from the selection | Kernel; asks before modifying the DataFrame |
| Export | Code | Copy as Python (umap-learn or polars-umap; pandas or polars code), copy as DataMapPlot code | Clipboard |

The active tab and collapsed sections are remembered per tab.

## How it works

```
Kernel (Python)                  Extension host                 Webview (editor tab)
_positron_atlas helper  <-JSON-  KernelBridge (evaluateCode)    Svelte UI
 sample/standardize/PCA          AtlasPanel                     UMAP worker (WASM)
 anchors, projection             job directory  -- files -->    deck.gl renderer
 writes .f32/.u16 files                                         fetch(asWebviewUri)
```

- The extension loads a numpy-only helper module (`python/positron_atlas_kernel.py`) into the kernel's `sys.modules`. Nothing is added to your namespace.
- Calls go through `positron.runtime.evaluateCode`, so they are silent and not recorded in the console history.
- Heavy work (reading, PCA, the neighbour search, placing rows) runs in background threads, so your console stays usable.
- Bulk data never goes through JSON. The kernel writes raw little-endian binary files into a per-tab job directory, and the webview fetches them; arrays going the other way are sent as raw bytes.
- A detailed overview with diagrams, the data flow step by step, and where the data lives is in [`docs/architecture.html`](docs/architecture.html) (`just architecture`).

## Settings

| Setting | Default | |
|---|---|---|
| `positronAtlas.maxAnchors` | 100000 | Maximum number of rows UMAP runs on in the browser (with WebGPU) |
| `positronAtlas.maxAnchorsCpu` | 25000 | The same limit when UMAP runs on the CPU (no WebGPU) |
| `positronAtlas.useWebGpu` | true | Run UMAP on the GPU when available; falls back to the CPU |
| `positronAtlas.anchorBudget` | 10000000 | Maximum values (anchors × dimensions) sent to the browser |
| `positronAtlas.defaultSamplePct` | 100 | Default sample percentage |
| `positronAtlas.pcaEnabled` | false | Apply PCA by default |
| `positronAtlas.pcaDims` | 50 | Default PCA components |
| `positronAtlas.nativeCore` | true | Place rows with the bundled Rust core when this platform has one (numpy otherwise) |
| `positronAtlas.neighborCacheMB` | 1024 | Memory for each row's cached nearest anchors (makes re-placement fast); above it, rows are searched again |
| `positronAtlas.maxLazyRows` | 10000000 | Rows collected from a lazy frame (polars LazyFrame, DuckDB relation, …) when opening it |
| `positronAtlas.downloadGoogleFonts` | ask | Download Google Fonts for labels and titles on demand: `ask` once, `always`, or `never` (sends the font name and your IP address to Google) |

## Performance

See `docs/benchmarks.md` in the source repository.

## Limitations

- Python only for now; R support is planned.
- The kernel and the extension host must share a file system (local sessions, Remote-SSH and Posit Workbench all do).
- The bundled UMAP (embedding-atlas 0.26 from npm) supports the euclidean and cosine metrics and the SGD optimizer.
- In 3D, automatic clusters, outlines, labels around the map, glow, label dragging, point annotations and the DataMapPlot and HTML exports are turned off (the interface says so); switch back to 2D for them.
- The neighbour cache holds euclidean neighbours; with the cosine metric, rows are searched again for each placement.
- Positron 2026.10 does not expose the Data Explorer's variable to extensions. Atlas reads it from the tab title (`Data: <name>`) and uses `positron.dataExplorer.getContext()` when available.

## Development

With [just](https://just.systems):

```sh
just examples            # build, sync examples/.venv, start Positron with the extension on examples/
just examples-isolated   # the same in a fresh, throwaway Positron profile
just test                # type checks, vitest, pytest
just e2e                 # end-to-end tests in an isolated Positron
just package             # build the .vsix
```

The Rust core for placing rows lives in `rust/` (see `docs/rust-plan.md`). It needs a Rust
toolchain to build; without it, Atlas uses the numpy code:

```sh
npm run build:native                          # native/<this platform>/ (use --release for a portable Linux build)
npm run test:rust                             # cargo tests
npm run package                               # universal .vsix (numpy only)
npm run package:target -- linux-x64           # platform .vsix with that platform's Rust core
```

CI builds the platform VSIX files for darwin-arm64, darwin-x64, linux-x64, linux-arm64 and win32-x64.

Or with npm directly:

```sh
npm install
uv sync --project python          # Python test environment
npm run build                     # extension host (esbuild) + webview (Vite/Svelte)
npm run check                     # TypeScript + svelte-check
npm test                          # vitest
npm run test:py                   # pytest for the kernel helper
npm run package                   # positron-atlas-<version>.vsix
```

End-to-end tests drive a real, isolated Positron over the Chrome DevTools Protocol. A helper extension starts Python, creates a DataFrame and opens Atlas.

```sh
uv venv --python 3.12 .venv-e2e && VIRTUAL_ENV=.venv-e2e uv pip install numpy pandas polars pyarrow
npm run build && npm run test:e2e
```

Screenshots land in `/tmp/positron-atlas-e2e/`.

The architecture (processes, data flow, dependencies, possible optimizations) is described in [`docs/architecture.html`](docs/architecture.html); open it with `just architecture`.

Without Positron, the **browser harness** runs the built webview in Chromium against the real kernel helper (a small Python server stands in for Positron). It is quicker and also produces screenshots:

```sh
npm run build && npm run test:harness                   # synthetic data: small, ui, tags (pandas and polars)
npm run test:harness:mnist                               # MNIST (downloaded once): labels, palette, selection, clusters
npm run harness -- test/harness/scenario-mnist.json      # any scenario; --theme light for the light theme
```

Screenshots land in `/tmp/positron-atlas-harness/`.

## License

MIT. UMAP comes from [embedding-atlas](https://github.com/apple/embedding-atlas) (MIT); rendering uses [deck.gl](https://deck.gl) (MIT).
