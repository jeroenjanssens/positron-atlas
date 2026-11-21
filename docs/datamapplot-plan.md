# Plan: DataMapPlot-inspired features for Positron Atlas

> **Status (2026-11-21).** Draft plan, implemented on branch `claude/project-research-dy9dot`.
> Each phase below ends with tests, screenshots and a commit. The checkboxes track progress.

[DataMapPlot](https://github.com/TutteInstitute/datamapplot) (Leland McInnes, Tutte Institute, MIT)
turns 2D coordinates plus label arrays into polished static plots and interactive deck.gl pages.
Atlas computes the map live in Positron and has a running kernel behind it. This plan takes
DataMapPlot's labeling, coloring and selection ideas and fits them to Atlas. Atlas reimplements them
in TypeScript and numpy: DataMapPlot's dependencies (numba, datashader, dask, scikit-learn, …)
would break Atlas's numpy-only rule.

## 1. Goals and non-goals

Goals:

- Make the map readable: labels on the map, a palette where neighboring clusters look related,
  and optional cluster outlines.
- Make the map explorable: lasso selection, a comparison of the selection with all rows, and a
  way to send the selection back to Python.
- Let users annotate: tag selected rows and write the tags back to the DataFrame.
- Keep the interface intuitive as it grows: group every control by what the user is doing.

Non-goals (for now):

- Text-specific handlers (word clouds, LLM summaries, text samples). Atlas works on numeric
  DataFrames. Cluster naming with Positron Assistant can come later.
- Standalone HTML output, offline mode, logos and fonts. These matter for publishing, not inside an IDE.
- Edge bundling (needs datashader and dask).

## 2. Interface: three groups

The sidebar currently has five sections: Data, UMAP, Color, Display, Actions. New features would
make it a long scroll. The sidebar becomes three tabs, each answering one question:

| Tab | Question | Sections |
|---|---|---|
| **Map** | How is the map computed? | Data · UMAP · Result (place all rows, add coordinates to the DataFrame, copy as Python) |
| **Explore** | What is in the map? | Color · Display · Selection |
| **Annotate** | What does it mean? | Labels · Tags · Share (copy as DataMapPlot code) |

The tabs keep the sections collapsible, as today. Actions that apply to the canvas itself move
to a small **toolbar on the plot** (top left, next to the collapse button):

| Tool | Effect |
|---|---|
| Pan (default) | Drag to pan, scroll to zoom, hover for tooltips |
| Lasso | Drag to select points; Shift adds, Alt removes |
| Fit to view | Same as today |
| Export PNG | Same as today, now includes labels |

Rules for the interface:

- One place per control. Nothing appears in two tabs.
- Controls that need the kernel keep an explicit **Apply** button. Controls that only change the
  rendering apply immediately.
- A control that does not apply right now is hidden, not shown disabled. For example, the colormap
  control only appears for numeric color columns.
- The active tab and the collapsed sections persist with the tab, like the other view settings.
- Every new control has a tooltip saying what it does.

## 3. Phases

### Phase A: browser harness for testing and screenshots — [x]

Positron cannot run in CI or in every development container. A small harness runs the real webview
bundle in Chromium against the real kernel helper:

- `test/harness/server.py`: a stdlib HTTP server. It runs a scenario's `setup` code (the same JSON
  as `test/e2e`) to create a DataFrame, loads `python/positron_atlas_kernel.py`, and exposes
  `POST /call` (helper function → JSON) and `GET /job/<file>` (job directory files).
- `test/harness/host.js`: a stand-in for `acquireVsCodeApi` that implements the same message
  handling as `AtlasPanel` (prepare, project, colors, row, …) over HTTP. Modal confirmations are
  accepted automatically.
- `test/harness/shot.mjs`: drives the page with Playwright, waits for the layout, runs the scenario
  `steps` (`eval`, `until`, `report`, `screenshot`) and fails on webview errors.
- `npm run test:harness` runs the harness scenarios. `test/e2e` stays the check in real Positron.

### Phase B: grouped interface — [x]

- Split `Controls.svelte` into `MapTab`, `ExploreTab` and `AnnotateTab` plus a shared `Section`
  component. No behavior changes.
- Add `PlotToolbar.svelte` (pan/lasso, fit, PNG).
- Persist `ui: { tab, closed: string[] }` in `PanelState`.
- Harness scenario that clicks every tab and checks the expected sections (`test/harness/scenario-ui.json`).
- The Annotate tab appears with its first section (labels, phase C), so it is never empty.

### Phase C: labels from a column — [x]

The quickest high-value feature: a categorical column is enough to label the map.

- **Annotate → Labels → Label by**: None, any categorical/boolean/low-cardinality column, or
  "Automatic clusters" (phase F).
- Kernel: `colors()` gains `max_categories` (default 20 as today; labels use up to 200).
- Placement (webview, `labels/place.ts`): for each category, find its densest spot. Build a grid
  histogram of the category's points over the map bounds, smooth it with a 3×3 box filter, and
  place the label at the mean of the points in the densest cell and its neighbors. A centroid can
  fall between two blobs or outside a curved cluster; the density peak always sits on the points.
- Rendering: deck.gl `TextLayer` with `CollisionFilterExtension`, sizes in pixels, `characterSet:
  'auto'`, and an outline in the plot background color.
  - Font size grows with the square root of the category's row count relative to the largest
    category (area-proportional), from a minimum to a maximum (`Smallest label`, `Largest label`).
    Unlike a min–max rescaling, groups of nearly equal size get nearly equal labels.
  - Collision priority: the row count, so larger groups win. When levels are added (phase F), use
    DataMapPlot's `compute_collision_priority` scheme: the level dominates, spread over ±900, so
    deck.gl's 16-bit collision depth cannot reorder labels
    (TutteInstitute/datamapplot#192, visgl/deck.gl#10346).
  - Text color: the category's point color, mixed 40 % toward the plain text color, when labels
    and colors use the same column (DataMapPlot's "deep" label palette); otherwise light text on dark
    backgrounds and dark text on light ones. Categories are matched by name, since label codes (200)
    and color codes (20) can order categories differently.
- Labels follow the layout while UMAP animates (positions are recomputed per frame, throttled).
- Labels are included in the PNG export.

### Phase D: palette that follows the map — [x]

DataMapPlot's `palette_from_datamap`: categories that sit near each other on the map get related
hues, and outlying categories are more saturated.

- Hue: sort the categories by angle around the map center and give each one a hue proportional to
  the cumulative (radius-weighted) angle. Neighbors on the map get neighboring hues.
- Chroma and lightness: from the category's radius relative to the radii of the points in its
  angular sector. Outlying groups get more chroma and more contrast with the background.
- Atlas uses OKLCH instead of CIECAM02 JCh (no colorspacious) and adapts the lightness range to the
  background: lighter colors on dark backgrounds, darker colors on light ones.
- **Explore → Color → Palette**: "Follows the map" (default for categories) or "Tableau 20" (today's).
  The palette is recomputed when a run finishes, not on every animation frame, so colors stay stable
  while the layout converges.

### Phase E: lasso selection — [x]

- Lasso tool on the plot toolbar. Drag to draw; Shift adds to the selection, Alt removes from it.
  With the pan tool, holding Shift or Alt and dragging also draws a lasso. Escape clears it.
- The selection is kept when the layout changes (rows keep their identity) and cleared by Apply.
- Selection is a mask over the prepared rows. Before all rows are placed, the lasso selects the
  anchors that are shown; after placement it selects all rows.
- Selected points keep their color; the others fade (alpha and a gray mix), as DataMapPlot does
  with `DataFilterExtension`. Done in the color buffer, so it costs one pass over the colors.
- **Explore → Selection** panel:
  - Count and share ("1,234 rows selected, 4.1 %"), Clear, Invert.
  - **Compare with all rows** (kernel `compare_selection`): for numeric columns, the selection's
    mean versus the overall mean as a standardized difference; for categorical columns, the
    values that are most over-represented (at least 5 % of the selection, 2 points and 25 % above
    their overall share). The top differences are listed, largest first.
  - **New DataFrame from selection** (kernel `selection_frame`): assigns the selected rows (in
    original order) to a new variable, `<name>_selection` by default (never overwrites an existing
    name without asking).
- The mask travels as packed bits (`np.unpackbits(..., bitorder="little")`), 1.25 MB for 10⁷ rows.

### Phase F: automatic clusters and outlines — [ ]

When there is no label column:

- Density map of the current layout (grid histogram plus a Gaussian blur), clustered with
  embedding-atlas's `findClusters` (density clustering in WASM; its worker ships with the npm
  package already in use). It returns each cluster's density-weighted center and boundary polygons.
- Points get their cluster through their grid cell; points outside every cluster are unlabeled.
- **Detail** slider: the grid resolution and blur, so fewer, larger or more, smaller clusters.
- **Name clusters by**: number ("Cluster 3"), the dominant value of a column ("mostly 7 (93 %)"),
  or distinguishing features (kernel `describe_groups`: the largest standardized differences of
  the cluster mean from the overall mean, like "↑ income ↓ age"). Feature names come from the
  original columns, not PCA components.
- **Show outlines**: the boundary polygons as a `PolygonLayer` (DataMapPlot's
  `cluster_boundary_polygons`), stroked in the cluster color with a light fill.
- Later: two detail levels at once, with DataMapPlot's level-based collision priority.

### Phase G: tags and sharing — [ ]

- **Annotate → Tags**: type a tag name and click **Tag selection**. Atlas writes the tag into a
  string column (`atlas_tag` by default) of the user's DataFrame, after a confirmation like **Add
  coordinates**. Rows that are not selected keep their current tag. polars frames are rebound, as
  for coordinates.
- **Annotate → Share → Copy as DataMapPlot code**: Python that builds the same picture with
  `datamapplot.create_interactive_plot` (or `create_plot`), using the coordinate columns and the
  label column. It reminds the user to add the coordinates first.

### Phase H: later

- Search and filter: a text match or a numeric range on a column, computed in the kernel, shown as
  a selection.
- Histogram brushing on a column to filter the points.
- Minimap, layer toggles (points, labels, outlines).
- Tile pyramid for 10⁷ points, hex density.
- CVD-safer palette option.

## 4. Testing

- vitest for pure logic: label placement, palette, lasso (point in polygon, packed bits), label sizes.
- pytest for new kernel functions: `max_categories`, `compare_selection`, `selection_frame`,
  `describe_groups`, `tag_rows` with pandas and polars.
- Harness scenarios (phase A) for each phase, with screenshots, run with `npm run test:harness`.
- `npm run check` (TypeScript and svelte-check) before every commit.
- The `test/e2e` scenarios in real Positron still apply; new ones mirror the harness scenarios.

## 5. Risks

| Risk | Mitigation |
|---|---|
| `CollisionFilterExtension` needs `@deck.gl/extensions` at the same version as core | Pin to 9.4.1, like the other deck.gl packages |
| Labels with characters outside ASCII | `characterSet: 'auto'` |
| Label placement every animation frame is too slow at 10⁵ anchors | Throttle to about 4 per second while animating; it is O(n) |
| Lasso at 10⁷ points | Bounding-box prefilter, then point-in-polygon; O(n) in a tight loop |
| Harness host drifts from `AtlasPanel` | Keep it small, note the mapping in comments, and keep running `test/e2e` in Positron |
