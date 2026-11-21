# Changelog

## 0.1.0 (unreleased)

- Open a pandas or polars DataFrame from the Data Explorer toolbar or the "Atlas: Open DataFrame…" command.
- Interactive UMAP in the browser (embedding-atlas WASM), animated while it converges.
- Live `min_dist`, `spread`, repulsion, negative sample rate and learning rate; `n_neighbors`, metric, epochs and seed rebuild.
- Row sampling (0.1–100 %), standardization, optional PCA, NaN policy.
- Anchor + projection for large data: UMAP on up to 100k anchors, the remaining rows placed in the kernel (numpy only).
- Color by any column (continuous colormaps or categories), legend, hover tooltips with row values.
- "Points are images": hover tooltips show rows of pixel columns (e.g. `px0` … `px783`) as images; the width is detected automatically (square) or can be set, and the colors can be inverted.
- Tooltips stay inside the plot (they flip to the other side of the cursor near the edges).
- Step through the optimization: pause, +1 / +10 epochs, resume, done, and "Restart paused" to start from the initial layout.
- Anchors slider (the number of rows UMAP runs on in the browser), with a time estimate.
- The sample slider is linear (0.1–100 %).
- Background color picker for the plot (defaults to the theme's editor background; used for PNG export).
- Points and additive density modes, PNG export, write coordinates back to the DataFrame, copy equivalent umap-learn code.
- The sidebar is grouped into three tabs: Map (data, UMAP, result), Explore (color, display) and Annotate (labels). Fit to view and Export PNG are on a toolbar on the plot.
- A categorical palette that follows the map (default; Tableau 20 is still available): nearby groups get related hues, outlying groups more chroma. Computed in OKLCH when the layout settles, adapted to dark and light backgrounds.
- Lasso selection (plot toolbar, or Shift/Alt-drag): unselected points fade; Explore → Selection shows the count, clears or inverts the selection, compares it with all rows (over-represented values, largest standardized mean differences, computed in the kernel) and creates a new DataFrame from it.
- Tags (Annotate → Tags): write a tag for the selected rows into a string column of the DataFrame (`atlas_tag`; other rows keep their tag). "Add clusters to DataFrame" writes the cluster names (`atlas_cluster`). Both ask first and make the new column available for colors and labels right away (kernel `write_labels`).
- Copy as DataMapPlot code (Annotate → Share): Python that draws the map with `datamapplot.create_interactive_plot` from `umap_x`, `umap_y` and the label column, for pandas and polars.
- Automatic clusters (Annotate → Labels → Label by → Automatic clusters): the layout's density is clustered with embedding-atlas's density clustering when the layout settles, with five detail levels, optional outlines, and names by number, by distinguishing columns (kernel `describe_groups`) or by the most common value of a column.
- Labels: label the map by a categorical, boolean or integer column. Labels sit at the densest spot of each group, grow with the group size, hide when they would overlap, follow the animation and appear in the PNG export. Inspired by DataMapPlot.
