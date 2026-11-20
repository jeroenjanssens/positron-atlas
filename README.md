# Positron Atlas

Interactive UMAP scatter plots of high-dimensional DataFrames, right inside [Positron](https://positron.posit.co).

Open a pandas or polars DataFrame with many numeric columns and Atlas shows a two-dimensional UMAP map of its rows in an editor tab. The layout animates while it converges, the UMAP parameters are sliders, and you can color the points by any column.

## Features

- **Live UMAP in the browser.** UMAP runs in a web worker using the Rust/WASM port from [apple/embedding-atlas](https://github.com/apple/embedding-atlas), on the GPU (WebGPU) when available. You watch the layout converge.
- **Live parameters.** `min_dist`, `spread`, repulsion strength, negative sample rate and learning rate change the running layout. `n_neighbors`, metric, epochs and seed rebuild the neighbor graph.
- **Large data (10⁴ to 10⁷ rows).** UMAP runs on up to 100,000 *anchor* rows. The remaining rows are placed in the kernel by their nearest anchors, with numpy only and streamed in chunks.
- **Sampling, standardization, optional PCA** (off by default) and a missing-value policy.
- **Color by any column.** Numeric and datetime columns get continuous colormaps (viridis, cividis, magma, …). Text, categorical, boolean and low-cardinality integer columns get categorical colors, with a legend.
- **Hover tooltips** with the row's values, fetched from the kernel on demand.
- **Points or additive density mode**, a background color picker, pan and zoom, PNG export.
- **Write coordinates back** to the DataFrame (`umap_x`, `umap_y`) and **copy equivalent umap-learn code**.
- **Optional exact mode**: if `umap-learn` is installed in the kernel, run full UMAP there instead.

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

The `examples/` folder in the source repository has notebooks with real data: MNIST and Fashion-MNIST (70,000 × 784 each) and Covertype (581,012 rows), all as polars DataFrames. Each one downloads its dataset once and needs only numpy and polars.

### Controls

| Section | Control | Effect |
|---|---|---|
| Data | Features, sample %, standardize, PCA, missing values, seed | Click **Apply** to re-prepare in the kernel |
| UMAP | Neighbors, epochs, metric, seed (`rebuild`) | Restarts UMAP |
| UMAP | Min distance, spread, advanced (`live`) | Applied to the running layout |
| Color | Color by, treat as categories, colormap, range | Recolors |
| Display | Point size, opacity, points/density, background color (or follow the theme), fit to view | Rendering only |
| Actions | Place all rows, add coordinates, export PNG, copy as Python | |

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
- Heavy work (reading, PCA, placing rows) runs in a background thread, so your console stays usable.
- Bulk data never goes through JSON. The kernel writes raw little-endian binary files into a per-tab job directory, and the webview fetches them.

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

## Performance

See `docs/benchmarks.md` in the source repository.

## Limitations

- Python only for now; R support is planned.
- The kernel and the extension host must share a file system (local sessions, Remote-SSH and Posit Workbench all do).
- The bundled UMAP (embedding-atlas 0.26 from npm) supports the euclidean and cosine metrics and the SGD optimizer.
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

## License

MIT. UMAP comes from [embedding-atlas](https://github.com/apple/embedding-atlas) (MIT); rendering uses [deck.gl](https://deck.gl) (MIT).
