/**
 * Help texts for every user-facing setting and control in the Atlas sidebar and plot toolbar.
 *
 * Each entry has:
 *   title       – the control label as shown in the UI
 *   what        – one sentence: what it does
 *   intuition   – 1–3 sentences building intuition; mentions typical values and
 *                 what you see when you raise or lower the setting
 *   when        – (optional) when to change it from the default
 *   cost        – what a change triggers:
 *                   'reprepare' – click Apply; the full data-preparation pipeline reruns
 *                   'rebuild'   – UMAP restarts from scratch (new kNN graph + optimisation)
 *                   'live'      – applied to the running UMAP without rebuilding
 *                   'none'      – display-only or action button; no computation
 *   dataMapPlot – the equivalent umap-learn / DataMapPlot option, when one exists
 */

export interface HelpEntry {
  title: string;
  what: string;
  intuition: string;
  when?: string;
  cost: 'live' | 'rebuild' | 'reprepare' | 'none';
  dataMapPlot?: string;
}

export const HELP: Record<string, HelpEntry> = {
  // ---- Data tab ----------------------------------------------------------------

  'data.layout': {
    title: 'Layout',
    what: 'Whether the map coordinates come from UMAP or from existing columns in the DataFrame.',
    intuition:
      '"UMAP" runs the dimensionality reduction pipeline (the default). ' +
      '"From columns" skips UMAP entirely and reads pre-computed x/y (and optionally z) columns as the layout — useful when you already have UMAP, t-SNE or PCA coordinates written back to the DataFrame, or when you receive a DataMapPlot-style frame with pre-computed positions. ' +
      'In "From columns" mode there is no embedding step, so very large frames load almost instantly.',
    when: 'Use "From columns" when you have umap_x/umap_y columns already in the DataFrame (written by Atlas, umap-learn, or polars-umap), or any other pre-computed 2D/3D projection.',
    cost: 'reprepare',
  },

  'data.coordsX': {
    title: 'X column',
    what: 'The numeric or datetime column to use as the horizontal coordinate.',
    intuition:
      'Each row\'s value in this column becomes its x position on the map. ' +
      'Rows with missing values are dropped (imputing coordinate positions is meaningless). ' +
      'Datetime columns are converted to numeric (nanoseconds since epoch) so they can be positioned on a time axis.',
    when: 'Choose the column that holds the first dimension of your pre-computed layout (e.g. umap_x, tsne_1, or PC1).',
    cost: 'reprepare',
  },

  'data.coordsY': {
    title: 'Y column',
    what: 'The numeric or datetime column to use as the vertical coordinate.',
    intuition:
      'Each row\'s value in this column becomes its y position on the map. ' +
      'Datetime columns are converted to numeric so they can be used as an axis.',
    when: 'Choose the column that holds the second dimension of your pre-computed layout (e.g. umap_y, tsne_2, or PC2).',
    cost: 'reprepare',
  },

  'data.coordsZ': {
    title: 'Z column (optional)',
    what: 'The numeric or datetime column to use as the depth coordinate, enabling the 3D view.',
    intuition:
      'When set, the map switches to 3D (orbit, rotate, zoom). ' +
      'Leave as "None" for a flat 2D map. ' +
      'Datetime columns are converted to numeric.',
    when: 'Choose the third dimension when you have a 3D projection (e.g. umap_z or PC3), or leave as None to keep the 2D view.',
    cost: 'reprepare',
  },

  'data.features': {
    title: 'Features',
    what: 'The numeric columns used as the input to UMAP.',
    intuition:
      'Each selected column becomes one dimension of the input vector for every row. ' +
      'More columns give richer distance information but increase preparation time and anchor memory. ' +
      'Deselect free-form IDs, timestamps and highly correlated duplicates; keep the columns that capture the structure you care about.',
    when: 'When you want to focus the map on a subset of your data, or when you have many columns and want to reduce noise.',
    cost: 'reprepare',
  },

  'data.samplePct': {
    title: 'Sample rows',
    what: 'The percentage of the DataFrame rows sent to UMAP.',
    intuition:
      'Sampling at 100% uses every row; lowering it speeds up both preparation and UMAP. ' +
      'At 10%, a 10 million-row frame becomes 1 million rows, which UMAP handles in seconds in the browser. ' +
      'The sample is drawn randomly (using the Data seed for reproducibility), so rare groups may disappear entirely at very low percentages.',
    when: 'When UMAP is too slow or the frame is very large and you want a quick overview first.',
    cost: 'reprepare',
    dataMapPlot: 'n/a — DataMapPlot receives pre-computed coordinates',
  },

  'data.standardize': {
    title: 'Standardize columns (z-score)',
    what: 'Rescales each feature to mean 0 and standard deviation 1 before UMAP.',
    intuition:
      'Without standardization, a column measured in thousands (e.g. income) dominates columns measured in ones (e.g. a rating). ' +
      'Z-scoring makes all features equally weighted. ' +
      'Disable it only when your columns are already on comparable scales, or when the raw magnitudes carry meaning you want to preserve.',
    when: 'Leave on (the default) unless your features are already normalized or you explicitly want magnitude to matter.',
    cost: 'reprepare',
  },

  'data.pca': {
    title: 'Apply PCA first',
    what: 'Runs PCA on the feature matrix before UMAP and passes the top components as UMAP input.',
    intuition:
      'Wide data (hundreds or thousands of features) makes UMAP slow and the anchor budget tight. ' +
      'PCA compresses the features to a smaller number of components (see PCA components) while keeping most of the variance, ' +
      'letting UMAP work faster and place many more anchors accurately. ' +
      'For image pixels (e.g. MNIST 784 columns → 50 PCA components) this is a standard pre-processing step.',
    when: 'Whenever you have more than roughly 50 features, especially image pixel data.',
    cost: 'reprepare',
    dataMapPlot: 'n/a — DataMapPlot receives pre-computed coordinates',
  },

  'data.pcaDims': {
    title: 'PCA components',
    what: 'How many principal components to keep when PCA is enabled.',
    intuition:
      'More components preserve more variance but slow UMAP and tighten the anchor budget. ' +
      'Typical choices: 50 for image data (retains >95% of variance for MNIST), 10–20 for tabular data, up to 200 when you need fine detail. ' +
      'The slider is capped at the number of selected features.',
    when: 'Raise it if clusters feel blurry; lower it if preparation is slow or the anchor count is limited.',
    cost: 'reprepare',
  },

  'data.anchors': {
    title: 'Anchors',
    what: 'The number of rows UMAP runs on in the browser; every other row is placed next to its nearest anchors by the kernel.',
    intuition:
      'UMAP runs only on the anchor subset (live, in your browser). ' +
      'The remaining rows are placed in the kernel: each row finds its 10 nearest anchors and is positioned at their UMAP-style weighted mean. ' +
      'More anchors give a more faithful layout for the placed rows but increase UMAP time (roughly 0.7 ms per anchor on the CPU, 0.04 ms on the GPU at 200 epochs). ' +
      'The slider maximum is set by the anchor budget (features × anchors ≤ budget) so the data fits in memory.',
    when: 'Lower it if UMAP is too slow; raise it for more accurate placement of the non-anchor rows.',
    cost: 'reprepare',
  },

  'data.missingValues': {
    title: 'Missing values',
    what: 'What to do with rows that have NaN in any selected feature.',
    intuition:
      '"Drop rows" removes those rows from the map entirely — they will not appear in the layout or in a selection. ' +
      '"Impute median" replaces each missing value with the column median, so the row is kept but placed near the median of that feature. ' +
      'Imputation is faster than rerunning after dropping and keeps rare rows visible, but may place them in misleading positions.',
    when: 'Use "Impute median" when missing values are few and random; use "Drop rows" when missingness is systematic (e.g. a whole feature block).',
    cost: 'reprepare',
  },

  'data.seed': {
    title: 'Seed',
    what: 'The random seed for sampling and PCA; makes preparation reproducible.',
    intuition:
      'Changing the seed produces a different random sample (when sample rows < 100%) and a different PCA orientation, ' +
      'which can shift which rows become anchors and subtly change the layout. ' +
      'Two runs with the same seed and the same settings produce identical prepared data.',
    when: 'Change it to verify that your map\'s structure is robust and not an artefact of one particular sample.',
    cost: 'reprepare',
  },

  'data.apply': {
    title: 'Apply',
    what: 'Sends the current data settings to the kernel, runs the full preparation pipeline, and restarts UMAP.',
    intuition:
      'Data settings are not applied automatically — click Apply when you are ready. ' +
      'The button is enabled only when the settings differ from the last applied run. ' +
      'After Apply, the kernel samples the frame, filters columns, handles missing values, optionally standardizes and applies PCA, ' +
      'selects the anchor rows, and returns the anchor feature matrix; then UMAP starts immediately.',
    cost: 'reprepare',
  },

  // ---- UMAP tab ----------------------------------------------------------------

  'umap.dims': {
    title: 'Dimensions',
    what: 'Whether UMAP embeds points into 2D or 3D space.',
    intuition:
      '2D is the default: points are placed in a flat plane that you pan and zoom. ' +
      '3D adds a depth axis — drag to rotate the cloud, Shift-drag to pan, scroll to zoom. ' +
      'The 3D view is interactive but some features (auto clusters, glow, label dragging, annotations) are only available in 2D.',
    when: 'Use 3D when you want to rotate and inspect the cloud from multiple angles or when a third dimension separates groups that overlap in 2D.',
    cost: 'rebuild',
  },

  'umap.computeMode': {
    title: 'Compute',
    what: 'Whether UMAP runs live in the browser or exactly in the Python kernel.',
    intuition:
      '"Browser (live)" runs the WASM implementation on the anchor rows, animating the layout as it converges — you see it evolve in real time. ' +
      '"Kernel (polars-umap)" or "Kernel (umap-learn)" runs a full UMAP of all prepared rows in the kernel; there is no animation, ' +
      'and you click Run to start it. The kernel options appear only when the matching package is installed in the session.',
    when: 'Use the kernel for the most accurate layout of large frames; use the browser for interactive exploration.',
    cost: 'rebuild',
  },

  'umap.nNeighbors': {
    title: 'Neighbors',
    what: 'How many nearby rows each row looks at when UMAP builds its nearest-neighbor graph.',
    intuition:
      'Small values (5–15) preserve fine local detail and can split groups into tight islands; ' +
      'large values (50–200) smooth out noise and reveal broader global structure, often merging small groups. ' +
      'The default of 15 is a good balance for most datasets. ' +
      'Rebuilding the graph is the slowest step, so changes here restart UMAP from scratch.',
    when: 'Raise it when the map breaks into many small islands or you care about the overall shape; lower it when distinct groups merge into one blob.',
    cost: 'rebuild',
    dataMapPlot: 'n_neighbors',
  },

  'umap.minDist': {
    title: 'Min distance',
    what: 'The minimum distance between points in the final 2D layout.',
    intuition:
      'Low values (0–0.1) pack similar points tightly into compact clusters; ' +
      'high values (0.5–1) push points apart for a more uniform, cloud-like spread. ' +
      'This is a live parameter: you can drag the slider and watch the layout repel or compress without restarting.',
    when: 'Lower it to make cluster structure more visible; raise it to see the global distribution more evenly.',
    cost: 'live',
    dataMapPlot: 'min_dist',
  },

  'umap.spread': {
    title: 'Spread',
    what: 'The effective scale of the embedded points; works together with min distance.',
    intuition:
      'Spread sets how far apart the clusters sit from each other. ' +
      'Increasing spread while keeping min distance fixed stretches the whole map; ' +
      'the ratio min_dist / spread controls how tightly points cluster relative to the inter-cluster gaps. ' +
      'Default is 1.0; values from 0.5 to 3 cover most use cases.',
    when: 'Raise spread when clusters overlap; lower it when you want a more compact map.',
    cost: 'live',
    dataMapPlot: 'spread',
  },

  'umap.nEpochs': {
    title: 'Epochs',
    what: 'How many optimization steps UMAP runs to refine the layout.',
    intuition:
      'More epochs give a more converged, stable layout but take longer. ' +
      '200 (the default) works well for most datasets; small frames (< 1,000 rows) may converge in 50; ' +
      'large frames with complex structure may benefit from 500. ' +
      'Changing epochs restarts UMAP because the learning-rate schedule is recalculated from scratch.',
    when: 'Raise it when the layout still looks noisy after UMAP finishes; lower it for a quick preview.',
    cost: 'rebuild',
    dataMapPlot: 'n_epochs',
  },

  'umap.metric': {
    title: 'Metric',
    what: 'The distance function used to build the nearest-neighbor graph in input space.',
    intuition:
      '"Euclidean" measures straight-line distance and works well for most numeric data. ' +
      '"Cosine" measures the angle between vectors, ignoring magnitude — it is better for text embeddings, ' +
      'bag-of-words features, or any data where the direction of a vector matters more than its length.',
    when: 'Switch to Cosine for TF-IDF or word-embedding features.',
    cost: 'rebuild',
    dataMapPlot: 'metric',
  },

  'umap.seed': {
    title: 'Seed',
    what: 'The random seed for UMAP\'s initialization and stochastic optimization.',
    intuition:
      'UMAP initializes positions at random (before the first epoch) and uses random negative sampling during optimization. ' +
      'The same seed with the same data and parameters always produces the same layout. ' +
      'Click ⚄ to generate a new random seed and see an alternative layout of the same data.',
    when: 'Change it to verify that your findings are not artefacts of one random initialization.',
    cost: 'rebuild',
    dataMapPlot: 'random_state',
  },

  'umap.useGpu': {
    title: 'Use GPU (WebGPU)',
    what: 'Runs the UMAP optimization on your graphics card via WebGPU instead of the CPU.',
    intuition:
      'GPU UMAP is typically 15–20× faster than the CPU (≈ 0.04 ms vs ≈ 0.7 ms per anchor per 200 epochs). ' +
      'This checkbox appears only when WebGPU is available in your browser. ' +
      'If the GPU run fails (driver incompatibility), Atlas automatically falls back to the CPU.',
    when: 'Enable it whenever you have many anchors or many epochs and the GPU is available.',
    cost: 'rebuild',
  },

  'umap.repulsionStrength': {
    title: 'Repulsion strength',
    what: 'How hard each negative sample pushes dissimilar points apart.',
    intuition:
      'Higher values (> 1) produce more separated clusters with more empty space between them; ' +
      'lower values (< 1) make the layout more compressed and uniform. ' +
      'The default of 1 matches umap-learn\'s default. This is a live parameter.',
    when: 'Raise it to emphasize cluster separation; lower it for a denser, more continuous map.',
    cost: 'live',
    dataMapPlot: 'repulsion_strength',
  },

  'umap.negativeSampleRate': {
    title: 'Negative sample rate',
    what: 'How many negative (dissimilar) pairs are sampled per positive (similar) pair in each epoch.',
    intuition:
      'More negative samples push unrelated points apart more aggressively, sharpening cluster boundaries ' +
      'at the cost of slower epochs. The default of 5 (five negatives per positive) is umap-learn\'s default. ' +
      'Values between 3 and 10 cover most use cases. This is a live parameter.',
    when: 'Raise it if clusters feel smeared together; lower it to speed up each epoch.',
    cost: 'live',
    dataMapPlot: 'negative_sample_rate',
  },

  'umap.learningRate': {
    title: 'Learning rate',
    what: 'The step size of the stochastic gradient descent optimizer.',
    intuition:
      'Higher learning rates move points more boldly each step, converging faster but potentially overshooting. ' +
      'Lower rates are more cautious and produce smoother layouts. ' +
      'The default of 1.0 matches umap-learn. ' +
      'This is a live parameter: raising it mid-run can "unstick" a layout that has converged to a poor local minimum.',
    when: 'Rarely needs changing; raise it slightly (1.5–2) if the layout looks frozen after many epochs.',
    cost: 'live',
    dataMapPlot: 'learning_rate',
  },

  'umap.restart': {
    title: 'Restart',
    what: 'Restarts UMAP from a fresh random initialization with the current parameters.',
    intuition:
      'Because UMAP is stochastic, different runs can produce different layouts of the same data. ' +
      'Restart to explore an alternative arrangement or to recover after changing a rebuild parameter.',
    cost: 'none',
  },

  'umap.pause': {
    title: 'Pause',
    what: 'Pauses the running UMAP at the end of the current epoch so you can step through the schedule.',
    intuition:
      'Once paused, the layout is frozen at that epoch. ' +
      'Use +1 and +10 to advance one or ten epochs at a time and watch the map take shape step by step. ' +
      '"Restart paused" starts a new run already paused at epoch 0 (the initial layout).',
    cost: 'none',
  },

  'umap.resume': {
    title: 'Resume',
    what: 'Continues the paused UMAP schedule to the end.',
    intuition: 'Equivalent to unpausing; the remaining epochs run at full speed.',
    cost: 'none',
  },

  'umap.step': {
    title: '+1 / +10',
    what: 'Runs one or ten more epochs of the paused UMAP schedule.',
    intuition:
      'Each step advances the layout by the specified number of epochs and then pauses again. ' +
      'Note that epoch 0 is the initial random layout — UMAP moves no points in epoch 0, ' +
      'so the first +1 step produces no visible change.',
    cost: 'none',
  },

  'umap.stop': {
    title: 'Stop / Done',
    what: 'Ends the UMAP run early and keeps the current layout.',
    intuition:
      'The layout may not be fully converged, but it is preserved for exploration and export. ' +
      'Useful when the map looks good before all epochs complete, or when you just want to pause the animation.',
    cost: 'none',
  },

  // ---- Result tab (shown only when anchors < all rows) ---------------------------

  'result.placeAll': {
    title: 'Place all rows',
    what: 'Runs the kernel projection that places every non-anchor row next to its nearest anchors.',
    intuition:
      'While UMAP runs only on the anchor subset, clicking this button sends the final anchor positions ' +
      'to the kernel, which finds the 10 nearest anchors for each remaining row and places it at their ' +
      'UMAP-style weighted mean position. ' +
      'The time estimate (≈ N s) is shown beside the button; for frames under about 20 seconds it runs automatically.',
    when: 'After UMAP has converged and you want to see all rows on the map — required before adding coordinates to the DataFrame.',
    cost: 'none',
  },

  'result.estimate': {
    title: 'Time estimate',
    what: 'An estimate of how long placing all rows will take, computed by the kernel.',
    intuition:
      'The estimate is based on a small probe of the actual placement speed on your machine (Rust or NumPy backend). ' +
      'If the estimate is under 20 seconds, Atlas runs placement automatically when UMAP finishes.',
    cost: 'none',
  },

  // ---- Explore → Color ---------------------------------------------------------

  'explore.colorBy': {
    title: 'Color by',
    what: 'The DataFrame column used to color the points on the map.',
    intuition:
      'Categorical and boolean columns produce a palette of distinct colors (one per category). ' +
      'Numeric columns use a sequential colormap (Colormap setting). ' +
      'Choosing "None" renders all points in the default blue.',
    when: 'Switch to any column whose values you want to see reflected spatially.',
    cost: 'none',
  },

  'explore.treatAsCategories': {
    title: 'Treat as categories',
    what: 'Forces a numeric column to be colored as if it were categorical.',
    intuition:
      'Useful for integer columns that represent labels or IDs (e.g. a cluster index from an earlier run). ' +
      'Each unique integer value gets its own distinct color instead of a gradient.',
    when: 'When the numeric column contains a small number of discrete codes that represent groups.',
    cost: 'none',
  },

  'explore.palette': {
    title: 'Palette',
    what: 'How the colors are assigned to the categories of a categorical column.',
    intuition:
      '"Follows the map" (the default) assigns hues based on each group\'s position in the layout: ' +
      'groups that are close on the map get related hues, and outlying groups are more saturated. ' +
      'This is the same approach used by DataMapPlot. ' +
      '"Tableau 20" assigns colors from a fixed list of 20 distinct colors regardless of position.',
    when: 'Switch to Tableau 20 when you need stable, presentation-ready colors that do not change as the layout evolves.',
    cost: 'none',
    dataMapPlot: 'color_label_sides / color_label_text (DataMapPlot assigns colors from the layout similarly)',
  },

  'explore.colormap': {
    title: 'Colormap',
    what: 'The sequential colormap used to map numeric values to colors.',
    intuition:
      'Available colormaps: viridis (blue–green–yellow, perceptually uniform), cividis (blue–olive, colorblind-safe), ' +
      'magma, plasma, inferno (dark-to-light variants), and a blue–red diverging map. ' +
      'All are linearly interpolated between the range endpoints.',
    when: 'Choose cividis or viridis for publication figures; use blue–red diverging for data with a natural midpoint.',
    cost: 'none',
  },

  'explore.colorRange': {
    title: 'Range',
    what: 'The numeric interval mapped to the full colormap.',
    intuition:
      '"2nd–98th percentile" (the default) clips outliers so the colormap covers the typical data range; ' +
      '"Min–max" maps the full spread from the absolute minimum to the maximum. ' +
      'Outliers look like the extreme color in both cases.',
    when: 'Switch to Min–max when the extreme values carry meaning and should not be clipped.',
    cost: 'none',
  },

  // ---- Explore → Display -------------------------------------------------------

  'explore.pointSize': {
    title: 'Point size',
    what: 'The diameter of each point in pixels.',
    intuition:
      'Smaller points (1–3) work better for large, dense datasets where individual points overlap. ' +
      'Larger points (5–10) make sparse maps and selected subsets easier to see. ' +
      'Point size also sets the hover hit radius.',
    cost: 'none',
  },

  'explore.opacity': {
    title: 'Opacity',
    what: 'The transparency of the points (1 = fully opaque, 0.05 = nearly transparent).',
    intuition:
      'Lower opacity reveals dense overlapping regions because layers of semi-transparent points accumulate visually. ' +
      'This is an alternative to density mode for showing crowded areas. ' +
      'Very low opacity (0.05–0.2) can make clusters look like a heatmap without switching the render mode.',
    when: 'Lower it when the center of clusters is overplotted and you want to see the density.',
    cost: 'none',
  },

  'explore.mode': {
    title: 'Mode',
    what: 'How the points are rendered: as individual points or as an additive density estimate.',
    intuition:
      '"Points" draws each row as a circle. ' +
      '"Density (additive)" accumulates the contribution of nearby points into a smooth image that shows where rows are most concentrated, ' +
      'similar to a 2D histogram. Density mode is useful for very large datasets (millions of points) where individual points are indistinguishable.',
    when: 'Switch to Density when points are too dense to see structure.',
    cost: 'none',
  },

  'explore.background': {
    title: 'Background',
    what: 'The background color of the plot.',
    intuition:
      'By default it follows the current editor theme (dark or light). ' +
      'You can override it with any color; click "Theme" to revert. ' +
      'The background color also affects label contrast and the "Follows the map" palette lightness.',
    when: 'Set a custom color for screenshots or presentations.',
    cost: 'none',
  },

  'explore.images': {
    title: 'Points are images',
    what: 'Shows a thumbnail image in the hover tooltip for each row, using pixel columns in the DataFrame.',
    intuition:
      'Atlas detects numeric columns named with a common prefix followed by a number (e.g. px0, px1, … px783 for MNIST 28×28). ' +
      'When this option is enabled, hovering a point shows a small grayscale image reconstructed from those columns. ' +
      'The checkbox is disabled when no pixel columns are detected.',
    when: 'Enable when your DataFrame contains image pixel data (e.g. MNIST, CIFAR, Fashion-MNIST).',
    cost: 'none',
  },

  'explore.imageWidth': {
    title: 'Image width',
    what: 'The width of the image in pixels, used to reshape the flat pixel vector into a 2D image.',
    intuition:
      'Atlas guesses the width automatically as the square root of the pixel count when it is a perfect square (e.g. 784 → 28). ' +
      'If your images are not square, enter the correct width here. ' +
      'The height is computed as ⌈total pixels / width⌉.',
    when: 'Set it when the auto-detected shape looks wrong in the hover thumbnail.',
    cost: 'none',
  },

  'explore.imageInvert': {
    title: 'Invert image colors',
    what: 'Swaps dark and light in image thumbnails (pixel columns and image-URL columns).',
    intuition:
      'Some datasets (e.g. MNIST) encode digits as bright pixels on a black background, ' +
      'which can look muddy on a light plot background. ' +
      'Invert swaps the intensity so digits appear dark on white, matching a printed appearance. ' +
      'The Auto option inverts only in dark VS Code themes (dark or high-contrast), ' +
      'so the same atlas looks correct whether the editor is light or dark.',
    when:
      'Use Auto for datasets whose images look better inverted in dark themes ' +
      '(black-on-white images like MNIST). Use On to always invert regardless of theme.',
    cost: 'none',
  },

  // ---- Explore → Display → Glow (A12) -----------------------------------------

  'explore.glow': {
    title: 'Glow',
    what: 'Adds a soft blurred halo around each cluster in its color, drawn underneath the points.',
    intuition:
      'Glow renders the point positions at 1/4 resolution using additive color blending and blurs the result. ' +
      'The effect is similar to DataMapPlot\'s add_glow (Gaussian kernel) and works well on dark backgrounds. ' +
      'Recomputed whenever the view changes.',
    when: 'Enable to emphasize cluster shapes, especially on dark backgrounds.',
    cost: 'none',
    dataMapPlot: 'add_glow',
  },

  'explore.glowStrength': {
    title: 'Glow strength',
    what: 'Overall opacity of the glow layer (0 = invisible, 1 = fully opaque).',
    intuition: 'Lower values produce a subtle ambient halo; higher values create a vivid neon effect.',
    cost: 'none',
  },

  'explore.glowRadius': {
    title: 'Glow radius',
    what: 'Gaussian blur radius in CSS pixels applied to the glow halo.',
    intuition: 'A small radius (10–20 px) gives a tight glow close to the clusters. ' +
      'A large radius (50–100 px) creates a diffuse bloom that covers a wider area.',
    cost: 'none',
  },

  // ---- Explore → Selection -----------------------------------------------------

  'explore.compareSelection': {
    title: 'Compare with all rows',
    what: 'Computes how the selected rows differ from the full dataset and shows the most striking differences.',
    intuition:
      'For categorical columns it shows over-represented values (the share in the selection vs. the share overall). ' +
      'For numeric columns it shows the columns with the largest mean shift (expressed in standard deviations). ' +
      'Based on a random sample of up to 50,000 rows for large frames.',
    when: 'After drawing a lasso around an interesting region of the map to characterize what makes those rows different.',
    cost: 'none',
  },

  // ---- Explore → Size (A10) ----------------------------------------------------

  'explore.sizeBy': {
    title: 'Size by',
    what: "Scale each point's radius by the value of a numeric column.",
    intuition:
      'Uses a square-root scale (like a bubble chart) so area is proportional to the value. ' +
      'Useful for showing magnitude alongside the UMAP layout. ' +
      'Values are clamped to the range of the column; missing values get the smallest radius.',
    when: 'When the magnitude of a column (e.g. a count, a price, a frequency) is as important as the structural grouping.',
    cost: 'none',
    dataMapPlot: 'marker_size_array',
  },

  // ---- Explore → Filter / Histogram (A13) --------------------------------------

  'explore.histFilter': {
    title: 'Histogram filter',
    what: 'Shows a histogram of a numeric column and lets you drag a brush to show only points in a value range.',
    intuition:
      'Each bin shows how many prepared rows fall in that range. ' +
      'Drag the left or right handle to narrow the brush, or drag the filled area to slide it. ' +
      'The filter combines with the legend toggles: a point must be both in the brush range and in a visible legend category to be shown. ' +
      'Click Reset to show all values again.',
    when: 'To focus on a subset of rows by value, for example outliers in a score column or a specific time window.',
    cost: 'none',
    dataMapPlot: 'histogram_*',
  },

  // ---- Explore → Tooltip (H3–H8) -----------------------------------------------

  'tooltip.titleColumn': {
    title: 'Title column',
    what: 'The column shown as the card heading when you hover or click a point.',
    intuition:
      'Atlas auto-detects a column named title, name, label, or text on first load and defaults to showing only the title (Fields = None). ' +
      'Set to "(none / auto)" to fall back to "Row N". ' +
      'Only text and categorical columns are listed; use Link column for URLs.',
    cost: 'none',
  },

  'tooltip.fields': {
    title: 'Fields',
    what: 'Which columns appear as key–value rows in the hover card.',
    intuition:
      '"None" hides all fields — useful when the title or image is enough to identify a point. ' +
      '"All columns" shows every column returned by the kernel. ' +
      '"Chosen columns" lets you pick exactly the columns you care about.',
    cost: 'none',
  },

  'tooltip.linkColumn': {
    title: 'Link column',
    what: 'A column containing a URL; the card shows an "Open link" button and Cmd/Ctrl+click opens it directly.',
    intuition:
      'Atlas auto-detects columns named url, link, href, or uri. ' +
      'Only valid http/https/mailto values are treated as links; other values are ignored.',
    cost: 'none',
  },

  'tooltip.imageUrlColumn': {
    title: 'Image URL column',
    what: 'A column containing an image file path or URL; the card fetches and shows the image.',
    intuition:
      'Atlas auto-detects columns named image, img, photo, picture, thumbnail, or thumb. ' +
      'Local file paths are served by the extension without a network request. ' +
      'For http/https URLs, use "Load images" to control whether fetching is allowed.',
    cost: 'none',
  },

  'tooltip.loadImages': {
    title: 'Load images',
    what: 'Whether the extension fetches images from http/https URLs in the image column.',
    intuition:
      '"Ask first" shows a one-time dialog the next time an http/https image is requested. ' +
      '"Always" loads silently without prompting. ' +
      '"Never" blocks remote fetching; local file paths still work.',
    cost: 'none',
  },

  // ---- Annotate → Labels -------------------------------------------------------

  'labels.labelBy': {
    title: 'Label by',
    what: 'The source of the text labels placed on the map.',
    intuition:
      '"Automatic clusters" finds density peaks in the layout and places a label at each; labels update as the map evolves. ' +
      'Choosing a column writes the most frequent value of that column for each group of points near the same position. ' +
      '"None" removes all labels. Labels that would overlap a neighbour are hidden; zoom in to reveal them.',
    when: 'Use automatic clusters for a first read of the map; use a column when you have a known grouping variable.',
    cost: 'none',
  },

  'labels.detail': {
    title: 'Detail',
    what: 'How finely the layout is split into automatically detected clusters.',
    intuition:
      '1 (Coarsest) gives a small number of large, broad clusters. ' +
      '5 (Finest) finds many smaller clusters, including sub-structures inside larger groups. ' +
      'The default of 2 (Coarse) works well for most maps. ' +
      'Re-clustering runs in a background worker when the layout settles.',
    when: 'Raise it to label sub-clusters; lower it for a high-level overview.',
    cost: 'none',
  },

  'labels.nameBy': {
    title: 'Name clusters by',
    what: 'How automatic clusters are named.',
    intuition:
      '"Number" gives each cluster a plain index (Cluster 1, Cluster 2, …). ' +
      '"Distinguishing columns" uses the kernel to find the features whose means differ most from the full dataset ' +
      '(↑ above average, ↓ below average) — good for profiling what makes each cluster distinct. ' +
      '"Most common value of …" names each cluster after the dominant value of a chosen column in its rows.',
    when: 'Use "Distinguishing columns" for exploratory data analysis; use a known category column to validate structure.',
    cost: 'none',
  },

  'labels.outlines': {
    title: 'Show outlines',
    what: 'Draws a boundary polygon around each automatically detected cluster.',
    intuition:
      'Outlines are drawn from the cluster\'s convex-hull-like boundary in the layout and are shown only once the layout has settled. ' +
      'They make it easier to see where one cluster ends and another begins.',
    when: 'Enable when clusters are dense and labels alone are hard to associate with their region.',
    cost: 'none',
  },

  'labels.minSize': {
    title: 'Smallest label',
    what: 'The font size (in pixels) of the label for the smallest group.',
    intuition:
      'Label sizes scale with group size: the largest group gets the "Largest label" font size, ' +
      'the smallest gets this font size, and all others are interpolated. ' +
      'Minimum is 6 px; maximum is capped at the "Largest label" value.',
    cost: 'none',
  },

  'labels.maxSize': {
    title: 'Largest label',
    what: 'The font size (in pixels) of the label for the largest group.',
    intuition:
      'Large labels dominate the map visually and draw the eye to the biggest clusters. ' +
      'Reducing the maximum size makes the font hierarchy less dramatic; a uniform size is achieved by setting both sliders to the same value.',
    cost: 'none',
  },

  'labels.colorText': {
    title: 'Color labels like the points',
    what: 'Gives each label the same color as the points of its group.',
    intuition:
      'Each label is colored with its group\'s point color, slightly shifted toward the contrast text color so it remains legible. ' +
      'This mirrors what DataMapPlot does with its "deep" label palette. ' +
      'Visible only when the label column and the color column are the same.',
    when: 'Disable for maximum readability in a dense map; enable to match the visual feel of DataMapPlot output.',
    cost: 'none',
    dataMapPlot: 'label_color_map',
  },

  'labels.addToFrame': {
    title: 'Add clusters to DataFrame',
    what: 'Writes each row\'s cluster name into the column atlas_cluster of the DataFrame.',
    intuition:
      'Rows that fall in no cluster (noise between clusters) receive a missing value. ' +
      'After adding, you can color by atlas_cluster, filter in the console, or export to code. ' +
      'The column is overwritten on each call.',
    when: 'After automatic clustering has produced names you are happy with.',
    cost: 'none',
  },

  // ---- Annotate → Label typography (A2) ----------------------------------------

  'labels.fontFamily': {
    title: 'Font',
    what: 'The font family used to draw cluster and column labels on the map.',
    intuition:
      'The bundled fonts (Cinzel, Montserrat, Roboto, etc.) are available offline and load instantly. ' +
      'You can also type any font name installed on your machine; deck.gl uses the browser\'s font stack. ' +
      'Google Fonts downloads are supported when positronAtlas.downloadGoogleFonts is set.',
    when: 'To match a DataMapPlot look (Cinzel for a dramatic title style, Montserrat for a modern sans-serif look).',
    cost: 'none',
  },

  'labels.fontWeight': {
    title: 'Font weight',
    what: 'The base font weight for all labels (100 = thin, 400 = regular, 600 = semibold, 700 = bold, 900 = black).',
    intuition:
      'Variable-weight fonts (Montserrat, Roboto, Inter) render smoothly at any weight. ' +
      'The weight range sliders below can give smaller groups lighter labels and larger groups heavier ones, ' +
      'similar to DataMapPlot\'s min_font_weight / max_font_weight.',
    cost: 'none',
  },

  'labels.minFontWeight': {
    title: 'Min weight (small groups)',
    what: 'Font weight for the label of the smallest group.',
    intuition:
      'When set lower than the max weight, smaller groups get lighter labels (e.g. weight 300), ' +
      'while larger groups get heavier ones — the same visual idea as DataMapPlot\'s min_font_weight. ' +
      'Works best with variable-weight fonts (Montserrat, Roboto, Inter).',
    cost: 'none',
    dataMapPlot: 'min_font_weight',
  },

  'labels.maxFontWeight': {
    title: 'Max weight (large groups)',
    what: 'Font weight for the label of the largest group.',
    intuition:
      'The largest group\'s label gets this weight; smaller groups get weights between min and max weight, ' +
      'proportional to the square root of their point count — the same as DataMapPlot\'s max_font_weight. ' +
      'Works best with variable-weight fonts.',
    cost: 'none',
    dataMapPlot: 'max_font_weight',
  },

  'labels.wrapWidth': {
    title: 'Wrap width',
    what: 'The approximate number of characters before a label is wrapped to the next line.',
    intuition:
      'Long group names (e.g. "North American English Dialects") wrap into two lines when the character count exceeds this value. ' +
      'Set to 0 to disable wrapping entirely. ' +
      'Like DataMapPlot\'s label_wrap_width.',
    cost: 'none',
    dataMapPlot: 'label_wrap_width',
  },

  'labels.lineSpacing': {
    title: 'Line spacing',
    what: 'The line height multiplier for multi-line labels.',
    intuition:
      'Values around 0.95–1.1 give compact labels; values above 1.5 spread lines apart noticeably. ' +
      'Like DataMapPlot\'s line_spacing.',
    cost: 'none',
    dataMapPlot: 'line_spacing',
  },

  'labels.haloWidth': {
    title: 'Halo width',
    what: 'The width of the outline/halo drawn behind each label.',
    intuition:
      'A thin halo (10–15) makes labels readable against colorful or cluttered backgrounds by drawing a soft outline in the background color. ' +
      'Set to 0 to remove the halo entirely. ' +
      'Like DataMapPlot\'s text_outline_width.',
    cost: 'none',
    dataMapPlot: 'text_outline_width',
  },

  'labels.haloColor': {
    title: 'Halo color',
    what: 'The color of the label halo/outline.',
    intuition:
      'By default (Auto) the halo matches the plot background, making labels appear to float. ' +
      'Set a custom color to create a colored outline effect. ' +
      'Like DataMapPlot\'s text_outline_color.',
    cost: 'none',
    dataMapPlot: 'text_outline_color',
  },

  'labels.textCase': {
    title: 'Letter case',
    what: 'Whether to transform label text to uppercase.',
    intuition:
      '"As is" keeps the original category or cluster name. ' +
      '"UPPERCASE" is a common choice for display-style atlas maps (like DataMapPlot\'s display galleries).',
    cost: 'none',
  },

  // ---- Annotate → Highlighted labels (A9) -------------------------------------

  'labels.highlightGroups': {
    title: 'Highlighted groups',
    what: 'Groups shown as filled badges: solid cluster-color background with white bold text.',
    intuition:
      'Highlighted labels stand out from the rest of the map labels. ' +
      'Use this to call attention to key regions of the map (like DataMapPlot\'s highlight_labels). ' +
      'Enter each group name exactly as it appears in the label column or cluster names.',
    cost: 'none',
    dataMapPlot: 'highlight_labels',
  },

  // ---- Annotate → Labels around the map (A11) ---------------------------------

  'labels.labelStyle': {
    title: 'Label style',
    what: 'Controls where group labels are placed: on top of the points or around the edge of the cloud.',
    intuition:
      '"Over the points" places labels directly on the density centre of each group, like DataMapPlot\'s default. ' +
      '"Around the map" places labels outside the point cloud in radial order and connects each label to its group anchor with a leader line, like DataMapPlot\'s static output.',
    cost: 'none',
    dataMapPlot: 'add_labels',
  },

  'labels.leaderStyle': {
    title: 'Leader line style',
    what: 'Visual style of the lines connecting each around-the-map label to its group anchor.',
    intuition:
      '"Straight" draws a simple line. ' +
      '"Curved" adds a slight quadratic bezier arc (like DataMapPlot\'s arc3 style). ' +
      '"Wedge" draws a filled isoceles triangle that widens at the anchor end (like DataMapPlot\'s wedge arrowprops).',
    cost: 'none',
    dataMapPlot: 'arrowprops',
  },

  'labels.leaderColor': {
    title: 'Leader color',
    what: 'Color of the leader lines in around-the-map mode.',
    intuition:
      '"Like the cluster" colors each leader line in the same hue as the cluster it points to, making it easy to match label to region. ' +
      '"Grey" uses a neutral grey for all leaders, which looks cleaner on dark backgrounds.',
    cost: 'none',
  },

  'labels.leaderWidth': {
    title: 'Leader width',
    what: 'Stroke width (CSS pixels) of the leader lines in around-the-map mode.',
    intuition:
      'Thinner lines (1–2 px) look cleaner. Thicker lines (3–5 px) are more legible on complex backgrounds.',
    cost: 'none',
  },

  // ---- Annotate → Label positions (A3) ----------------------------------------

  'labels.resetPositions': {
    title: 'Reset all label positions',
    what: 'Moves all dragged labels back to their automatically computed positions.',
    intuition:
      'Each label is returned to the position chosen by the density-weighted placement algorithm. ' +
      'Individual labels can also be reset by right-clicking them on the map.',
    cost: 'none',
  },

  // ---- Annotate → Multi-level labels (A8) -------------------------------------

  'labels.multiLevel': {
    title: 'Show two levels of detail',
    what: 'Adds a second, finer layer of cluster labels that appear when you zoom in.',
    intuition:
      'Coarse labels (fewer, larger clusters) are always visible; fine labels appear as you zoom in and there is room for them. ' +
      'The fine labels have lower collision priority than the coarse ones (like DataMapPlot\'s hierarchical_collision_priority), ' +
      'so they never push out the coarse labels.',
    cost: 'none',
    dataMapPlot: 'hierarchical_collision_priority',
  },

  'labels.fineColumn': {
    title: 'Fine labels by',
    what: 'A second, finer column whose values are drawn as an additional layer of smaller labels.',
    intuition:
      'For example, if the coarse column is "region" and the fine column is "city", ' +
      'region labels are always visible and city labels appear when zoomed in. ' +
      'Fine labels have lower collision priority and are smaller than coarse labels.',
    cost: 'none',
  },

  // ---- Annotate → Tags ---------------------------------------------------------

  'tags.tag': {
    title: 'Tag',
    what: 'The text written into the tag column for all currently selected rows.',
    intuition:
      'You can apply multiple tags over time by selecting different regions and entering a different text each time. ' +
      'Rows that are not in the current selection keep whatever value they had in the column before.',
    when: 'After drawing a lasso around a region of interest.',
    cost: 'none',
  },

  'tags.column': {
    title: 'Column',
    what: 'The DataFrame column that receives the tag values.',
    intuition:
      'The column is created as a string column if it does not exist; existing values in unselected rows are preserved. ' +
      'You can then color or label the map by this column to see your annotations.',
    when: 'Use a descriptive column name (e.g. "region" or "review") that you will remember when inspecting the DataFrame.',
    cost: 'none',
  },

  'tags.apply': {
    title: 'Tag selected rows',
    what: 'Writes the tag text into the tag column for the selected rows.',
    intuition:
      'The button is enabled only when rows are selected and both the tag and column fields are non-empty. ' +
      'After tagging, switch to the Explore tab and color by the tag column to see your annotations on the map.',
    cost: 'none',
  },

  // ---- Export → Image ----------------------------------------------------------

  'export.png': {
    title: 'Export PNG',
    what: 'Saves the current plot view as a PNG file.',
    intuition:
      'The exported image matches exactly what is shown on screen: the current point positions, colors, labels, and outlines, ' +
      'at the current zoom level, on the current background color. ' +
      'Resolution equals the canvas size in CSS pixels (the panel width × height).',
    when: 'For presentations, reports, or sharing a snapshot of the current state.',
    cost: 'none',
  },

  // ---- Export → To the DataFrame -----------------------------------------------

  'export.addCoordinates': {
    title: 'Add coordinates (umap_x, umap_y)',
    what: 'Adds the 2D UMAP coordinates as two new columns to the DataFrame.',
    intuition:
      'Each row that is on the map gets its x and y position in umap_x and umap_y; rows that were dropped ' +
      '(by the sample, by the missing-values policy, or because they are not yet placed) receive NaN. ' +
      'Requires all rows to be placed first (Map → Result → Place all rows) when anchors < all rows.',
    when: 'Before exporting DataMapPlot code, or when you want to use the coordinates in your own analysis.',
    cost: 'none',
  },

  'export.selectionToFrame': {
    title: 'New DataFrame from selection',
    what: 'Creates a new DataFrame in the kernel session containing only the selected rows.',
    intuition:
      'The new variable is named automatically (e.g. df_selection) and appears in the Positron Variables pane. ' +
      'The rows are taken from the original DataFrame (before sampling), so the full data is preserved.',
    when: 'To investigate a cluster further in the console, or to run a model on a subset of the data.',
    cost: 'none',
  },

  // ---- Export → Code -----------------------------------------------------------

  'export.copyPython': {
    title: 'Copy as Python (umap-learn)',
    what: 'Copies a self-contained Python script that reproduces this map with umap-learn.',
    intuition:
      'The snippet includes the feature list, sampling, standardization, PCA, missing-value handling, and all UMAP parameters ' +
      'with umap-learn\'s parameter names (n_neighbors, min_dist, etc.). ' +
      'Paste it into a notebook cell to reproduce the layout outside Atlas.',
    when: 'To share the exact map configuration, or to run UMAP on a server with umap-learn installed.',
    cost: 'none',
    dataMapPlot: 'umap.UMAP()',
  },

  'export.copyPolarsUmap': {
    title: 'Copy as Python (polars-umap)',
    what: 'Copies a self-contained Python script that reproduces this map with polars-umap (UMAP in Rust, inside Polars).',
    intuition:
      'polars-umap is typically 10–30× faster than umap-learn on large frames and runs UMAP in a Rust thread pool. ' +
      'The snippet uses the same parameters as the umap-learn version but calls polars_umap.umap() on a Polars DataFrame.',
    when: 'When you want the fastest possible UMAP and have polars-umap installed.',
    cost: 'none',
  },

  'export.copyDataMapPlot': {
    title: 'Copy as DataMapPlot code',
    what: 'Copies Python that draws this map as an interactive DataMapPlot visualization.',
    intuition:
      'The snippet calls datamapplot.create_interactive_plot() with the umap_x and umap_y coordinates and the current label column. ' +
      'Add umap_x and umap_y to the DataFrame first (above). ' +
      'If you used automatic cluster labels, add them to the DataFrame first too (Annotate → Labels → Add clusters to DataFrame).',
    when: 'To produce a standalone HTML map that can be shared without Atlas.',
    cost: 'none',
    dataMapPlot: 'datamapplot.create_interactive_plot()',
  },

  'export.exportDataMapPlot': {
    title: 'Export with DataMapPlot',
    what: 'Saves the map as a self-contained interactive HTML file using DataMapPlot.',
    intuition:
      'Opens a save dialog, then calls datamapplot.create_interactive_plot() with the current coordinates, ' +
      'the active label column and the hover-text column. ' +
      'The resulting HTML file contains everything needed to explore the map in any browser.',
    when: 'To share the map as a standalone file without requiring Atlas or Python.',
    cost: 'none',
    dataMapPlot: 'datamapplot.create_interactive_plot()',
  },

  'export.exportHtml': {
    title: 'Export as HTML',
    what: 'Saves the map as a self-contained interactive HTML file that works offline in any browser.',
    intuition:
      'Opens a dialog to choose which columns to show in tooltips, then writes a single HTML file with the viewer JS, ' +
      'point positions, colours, labels, annotations, and tooltip text all embedded. ' +
      'The file supports pan/zoom, hover tooltips, legend toggles, search, and full screen.',
    when: 'To share the map as a standalone file without requiring Atlas, Positron, or Python.',
    cost: 'none',
  },

  // ---- Search ------------------------------------------------------------------

  'search.query': {
    title: 'Search',
    what: 'Filter the map to highlight rows whose title text matches a query.',
    intuition:
      'Type a word or phrase; matching points are shown at full brightness while non-matching points fade. ' +
      'Press Enter to zoom the view to the matching points; press Escape to clear. ' +
      'The search runs locally when titles are preloaded, or via the kernel otherwise.',
    when: 'To find a specific item or group by name.',
    cost: 'none',
  },

  // ---- Annotate → Title (A1) ---------------------------------------------------

  'titleOverlay.title': {
    title: 'Map title',
    what: 'A short title shown in the top-left of the map.',
    intuition:
      'The title appears as an HTML overlay over the plot, so it stays crisp at any zoom level. ' +
      'It is included in PNG exports and in the DataMapPlot code snippet (title= parameter).',
    when: 'For presentations, reports, or when exporting the map.',
    cost: 'none',
    dataMapPlot: 'title=',
  },

  'titleOverlay.subtitle': {
    title: 'Subtitle',
    what: 'An optional subtitle shown below the title.',
    intuition:
      'The subtitle is smaller than the title and slightly more transparent. ' +
      'It is included in PNG exports and as the sub_title= parameter in DataMapPlot code.',
    when: 'To add a brief description, date, or data source below the title.',
    cost: 'none',
    dataMapPlot: 'sub_title=',
  },

  'titleOverlay.fontFamily': {
    title: 'Title font',
    what: 'Font family for the title and subtitle text.',
    intuition:
      'Pick a bundled font (e.g. Cinzel, Montserrat) or type any font name. ' +
      'Leave empty to use the editor font. The font is loaded before export.',
    when: 'To match the map style to a presentation or report theme.',
    cost: 'none',
  },

  'titleOverlay.fontSize': {
    title: 'Title size',
    what: 'Font size of the title in CSS pixels.',
    intuition: 'The subtitle is automatically scaled to 60% of the title size.',
    cost: 'none',
  },

  'titleOverlay.color': {
    title: 'Title color',
    what: 'Text color for the title and subtitle.',
    intuition:
      'Pick a color that contrasts with the map background. ' +
      'The title has a subtle text shadow to stay readable over dense clusters.',
    cost: 'none',
  },

  'titleOverlay.logo': {
    title: 'Logo image',
    what: 'An optional image shown above the title.',
    intuition:
      'Pick any image file from your computer. It is stored in the panel state as a data URL ' +
      'so it survives reloads. Keep it small (a few KB) to avoid bloating the state.',
    when: 'To brand the map with a company or project logo.',
    cost: 'none',
  },

  'titleOverlay.logoWidth': {
    title: 'Logo width',
    what: 'Width of the logo image in CSS pixels.',
    intuition: 'The image height is scaled proportionally. Default is 48 px.',
    cost: 'none',
  },

  // ---- Annotate → Annotations (A4) -------------------------------------------

  'pointAnnotations.list': {
    title: 'Annotations list',
    what: 'All point annotations you have added to the map.',
    intuition:
      'Each annotation is linked to a DataFrame row. Click the location icon to zoom to it, ' +
      'or the trash icon to delete it. Export saves all annotations as a JSON file you can re-import later.',
    cost: 'none',
  },

  // ---- Layers (A2) ------------------------------------------------------------

  'layers.visibility': {
    title: 'Layer visibility',
    what: 'Show or hide a layer on the map.',
    intuition:
      'Click the eye icon to toggle a layer on or off. ' +
      'Hiding the base map removes all data points from the view, leaving only overlays (labels, outlines). ' +
      'Useful for checking that overlays are positioned correctly against a blank background.',
    cost: 'none',
  },

  'layers.opacity': {
    title: 'Layer opacity',
    what: 'Multiplies the layer opacity on top of the global point-opacity setting.',
    intuition:
      'At 1.0 (the default) the layer renders at the opacity set by the Display → Opacity slider. ' +
      'Lower values fade the layer without changing the global opacity. ' +
      'Setting a layer to 0.5 and the global opacity to 0.8 gives an effective opacity of 0.4 for that layer.',
    cost: 'none',
  },

  'layers.blending': {
    title: 'Layer blending',
    what: 'How the layer is composited over the layers behind it.',
    intuition:
      '"Normal" (default) draws points with standard alpha compositing: each point covers what is behind it. ' +
      '"Additive" adds point colours together — dense areas become brighter and saturate toward white, ' +
      'which makes it easy to see where many points pile up.',
    when: 'Use "Additive" when many points overlap and you want density to show up as brightness rather than a uniform mass.',
    cost: 'none',
  },

  // ---- Plot toolbar ------------------------------------------------------------

  'toolbar.pan': {
    title: 'Pan and zoom',
    what: 'The default tool: drag to pan, scroll to zoom, hover for point details.',
    intuition:
      'While in pan mode you can still select points by holding Shift (adds to the selection) or Alt (removes from the selection) ' +
      'and dragging. Escape clears the selection.',
    cost: 'none',
  },

  'toolbar.lasso': {
    title: 'Lasso select',
    what: 'Draw a freehand outline around points to select them.',
    intuition:
      'Drag to draw the lasso; release to close it and select all points inside. ' +
      'Hold Shift while drawing to add to an existing selection; hold Alt to remove from it. ' +
      'The lasso is disabled until data preparation is complete.',
    cost: 'none',
  },

  'toolbar.fitView': {
    title: 'Fit to view',
    what: 'Resets the zoom and pan so all points are visible.',
    intuition: 'Equivalent to double-clicking the background. Useful after zooming into a cluster.',
    cost: 'none',
  },

  'toolbar.annotate': {
    title: 'Annotate',
    what: 'Click a point to add a callout annotation.',
    intuition:
      'While in annotate mode the cursor changes to a crosshair. ' +
      'Clicking a point opens a callout showing the title column value (or "Row N" if no title column is configured). ' +
      'Drag the callout to reposition it; double-click the text to edit it.',
    cost: 'none',
  },

  'toolbar.compass': {
    title: 'Compass / Rotation reset',
    what: 'Shows the current map rotation and resets it to north-up (0°) on click.',
    intuition:
      'The compass needle rotates with the map. ' +
      'Only visible when the map has been rotated away from the default north-up orientation. ' +
      'Click it to snap back to 0°. Use the [ and ] keys to rotate by 15° steps, or right-drag to rotate freely.',
    cost: 'none',
  },

  // ---- Navigation settings (item 1) --------------------------------------------

  'nav.preset': {
    title: 'Navigation preset',
    what: 'Sets the mouse and gesture control scheme.',
    intuition:
      '"Data map" (default): scroll to zoom, drag to pan, right-drag to rotate (2D). ' +
      '"Molecular viewer": same as Data map; intended for 3D point clouds. ' +
      '"3D / CAD": middle-drag to pan, left-drag to rotate, scroll to zoom. ' +
      '"Design": Space+drag to pan, Ctrl+scroll to zoom; mimics Figma/Sketch.',
    when: 'Change when the default drag-to-pan conflicts with your workflow, or when you prefer CAD/design conventions.',
    cost: 'none',
  },

  'nav.scrollGesture': {
    title: 'Scroll gesture',
    what: 'What happens when you scroll (or use a two-finger trackpad swipe) over the map.',
    intuition:
      '"Zoom" (default) zooms in and out. ' +
      '"Pan" scrolls the map vertically, with horizontal two-finger swipe panning horizontally.',
    when: 'Set to "Pan" if your workflow involves a lot of vertical scrolling rather than zooming.',
    cost: 'none',
  },

  'nav.zoomToCursor': {
    title: 'Zoom to cursor',
    what: 'When enabled, zooming keeps the point under the cursor stationary.',
    intuition:
      'With "Zoom to cursor" on (default) the map zooms into the spot where your mouse is, like a geographic map. ' +
      'With it off, the map always zooms toward the view center.',
    cost: 'none',
  },

  'nav.invertZoom': {
    title: 'Invert zoom direction',
    what: 'Reverses the scroll-to-zoom direction.',
    intuition:
      'By default, scrolling up / pinching out zooms in. ' +
      'Enable this to reverse that so scrolling up zooms out, matching some CAD or mapping applications.',
    cost: 'none',
  },

  'nav.emulateMiddleButton': {
    title: 'Emulate middle button',
    what: 'Treats Alt + left-drag as a middle-button drag.',
    intuition:
      'Useful with the "3D / CAD" preset on a laptop trackpad where there is no physical middle button. ' +
      'Enable this and Alt+drag will pan instead of rotate in that preset.',
    cost: 'none',
  },
};

/** Look up a help entry by its dot-separated id.  Returns undefined when not found. */
export function getHelp(id: string): HelpEntry | undefined {
  return HELP[id];
}
