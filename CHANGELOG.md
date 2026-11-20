# Changelog

## 0.1.0 (unreleased)

- Open a pandas or polars DataFrame from the Data Explorer toolbar or the "Atlas: Open DataFrame…" command.
- Interactive UMAP in the browser (embedding-atlas WASM), animated while it converges.
- Live `min_dist`, `spread`, repulsion, negative sample rate and learning rate; `n_neighbors`, metric, epochs and seed rebuild.
- Row sampling (0.1–100 %), standardization, optional PCA, NaN policy.
- Anchor + projection for large data: UMAP on up to 100k anchors, the remaining rows placed in the kernel (numpy only).
- Color by any column (continuous colormaps or categories), legend, hover tooltips with row values.
- Background color picker for the plot (defaults to the theme's editor background; used for PNG export).
- Points and additive density modes, PNG export, write coordinates back to the DataFrame, copy equivalent umap-learn code.
