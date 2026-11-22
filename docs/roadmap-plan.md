# Plan: performance, hover, native look, annotation, export, data and 3D

Status: **accepted 2026-11-21**: all recommendations in section 1 (D1–D14) and the wave plan in section 14 were accepted as written. In particular:

- **D1:** the ⓘ icon is the information icon.
- **D3:** click pins a card; Cmd/Ctrl-click opens the link.
- **D4:** narwhals as a hybrid.
- **D6:** HIGGS and Wikipedia titles as the large examples.
- **D5 and D11:** a one-time prompt before downloading images or Google Fonts.
- **D13:** 3D last.
- **Section 14:** the `atlas.svelte.ts` split in wave 0.

Written 2026-11-21 against commit `830812c`; implementation starts in waves (section 14).

**Progress (2026-11-22, local `main` at `b630ec0`):**

- **Waves 0, 1 and 2 are done.** Done items: P1, P2, P3, P4, P5, P6; H1–H8; I1–I3; N1–N5; L1; F1; D-1; E1, E2; A1–A10 and A13.
- **Dropped:** P7 (spike: kNN is 3–4 % of browser CPU UMAP time).
- **Waves 3 and 4 are done:** X1–X4 (self-contained HTML export), A11 (labels around the map), A12 (glow), and 3D (T2–T6: browser and kernel UMAP in 3D, Rust and numpy placement in 3D, orbit view with camera buttons, hover, lasso, legend and filters; the 2D-only features are turned off in 3D with a hint).
- **All items in sections 3–11 are done**, except P7 (dropped after its spike) and the items left out on purpose in section 12.
- **Measured HTML export sizes:** 3k points 1.3 MB (mostly the 1.25 MB viewer); MNIST 70k with images 2.7 MB (2 s load); 10⁶ points 12.1 MB.

This plan covers everything asked for on 2026-11-21:

- the performance ideas from [`architecture.html`](architecture.html), section 5;
- snappier hover;
- a hover title from a text column, with clickable URLs;
- narwhals for more DataFrame types;
- an example with at least 10 million points;
- ⓘ explanations next to settings;
- 3D maps;
- a full-screen button;
- legend items that toggle groups;
- self-contained HTML export;
- point annotations (text and images) that can be dragged;
- cluster labels that can be dragged, with remembered positions;
- label fonts;
- DataMapPlot parity for annotation;
- controls that look native in Positron.

It follows the style of [`datamapplot-plan.md`](datamapplot-plan.md) (phases A–G there are done).

How to read it:

- **Section 1** lists the decisions that are yours to make. Each has a recommendation, its pros and cons, and the alternatives.
- **Section 2** is the recommended order.
- **Sections 3–12** are the work items.
- **Section 13** covers testing and risks.

Effort is given as S (≤ 1 day), M (a few days) or L (a week or more). Numbers are marked *measured* (on this machine or in `docs/benchmarks.md`) or *estimate*.

---

## 0. What the investigation found

| Topic | Finding | Evidence |
|---|---|---|
| Hover latency | The kernel spends **0.05–0.6 ms** per row (measured, pandas and polars, 1M × 50 and 70k × 786). The delay is the **120 ms debounce** plus a full **`evaluateCode` round trip** per new point (≈ 0.3 s end to end in `docs/benchmarks.md`). No cache, no prefetch; the tooltip appears only when the reply arrives. | `onPointer` in `src/webview/atlas.svelte.ts`; `row()` in `python/positron_atlas_kernel.py` |
| Native look | Buttons and inputs use `--vscode-*` tokens, but none of Positron's own tokens, which webviews also receive (section 6.1). **Sliders, checkboxes and selects are Chromium's own controls**, tinted with `accent-color`. The tabs are a filled segmented control; Positron's own segmented toggle is outlined and smaller. There is no icon font (hand-drawn SVGs). Settings are explained only by `title` attributes (a slow native tooltip). | `src/webview/style.css` (132 lines), `components/*.svelte` |
| 3D | `createUMAP(n, d, outputDim, …)` accepts `outputDim = 3`: **verified on the CPU path** (Node, 2,000 points, finite 3D output). The WebGPU path is untested: headless Chromium has no WebGPU. Placement, the file format (`xy` = 2 columns), hover, lasso, outlines and clustering all assume 2D. | spike in `/tmp`, not in the repo |
| UMAP from a kNN graph | embedding-atlas also has `createUMAPFromKNN(count, outputDim, knnIndices, knnDistances)`: the browser can run only the layout (SGD) on a neighbour graph computed elsewhere. | `node_modules/embedding-atlas/dist/umap.d.ts` |
| Placement | Every placement builds the index again and searches every row's neighbours again, although they depend only on the prepared features, the anchors and the metric. The Rust binding already exposes `Index.neighbors(q, k)`. | `_project_impl`, `_project_native`; `rust/atlas-core-py/src/lib.rs` |
| Frames | 18 places in the helper branch on pandas versus polars, with tuned fast paths (row-major polars reads, `pandas.factorize`, polars dense ranks). | `positron_atlas_kernel.py` |
| Fonts | Labels use the editor font at weight 600. The webview CSP allows fonts only from the extension (`font-src ${webview.cspSource}`), so web fonts must be bundled. Installed system fonts work by name. | `atlasPanel.ts` `html()`, `renderer.ts` |
| Full screen | Not implemented. VS Code webviews run in an iframe; whether the Fullscreen API is allowed there needs a test in Positron (expected: no). | — |
| DataMapPlot | 9 gallery images and the `create_plot` / `create_interactive_plot` options inventoried (section 9.1). None of its examples has ≥ 10M points (largest ≈ 517k). | research notes, 2026-11-21 |

### 0.1 Wave-0 spike results (2026-11-21)

Details in [`spikes/positron.md`](spikes/positron.md) and [`spikes/offline.md`](spikes/offline.md).

| Spike | Result | Effect on the plan |
|---|---|---|
| H1 hover | Round trip **6 ms median, 9 ms p95** (300k × 50 polars frame; `evaluateCode` 3 ms). | The 120 ms debounce is the delay. **No side channel** (D2 alternative dropped). H2–H4 remain for instant content and caching. |
| F1 full screen | `requestFullscreen()` is **blocked** in Positron webviews ("Disallowed by permissions policy"). | D8 as recommended: `workbench.action.maximizeEditorHideSidebar` plus focus mode in Positron; the Fullscreen API only in a browser. |
| P4 binary messages | `ArrayBuffer`s pass through `postMessage` intact both ways: 1 MB in 2.2 ms, 30 MB in 68 ms. Base64 encoding alone costs 96 ms for 30 MB. | Do P4. |
| N1 theme variables | 1,090 `--vscode-*` variables reach the webview, **152 Positron ones** (action bar, data grid, dialogs, tooltips, checkbox, drop-down). **No size variables** (`positronActionBar-height` is not passed). | D7 as recommended; sizes are constants copied from Positron's CSS (28 / 24 / 20 px). Light and high-contrast dumps are still to do (in N1). |
| T1 3D | `outputDim = 3` works on **WebGPU and CPU** in Positron with no measurable extra time (10k × 50: GPU 0.59 s, CPU 7.74 s, same as 2D). | 3D is feasible; T2–T6 unchanged. |
| P7 kNN from the kernel | kNN is only **3–4 %** of browser CPU UMAP time. The Rust IVF graph is 17× faster than NNDescent at 100k, with identical trustworthiness (0.9913). | **P7 dropped** as a speed item. P3 (kernel layout on CPU-only machines) stays. |
| E2 Wikipedia | en + de + fr = **11.8M** articles (22 GB of Parquet with full text). `potion-multilingual-128M`: 256 dims, ~361k titles/s (≈ 33 s for 11.8M), 512 MB model. First run ≈ 40 min (mostly download), later runs ≈ 25 min; result ≈ 4 GB. | Do E2 with en + de + fr. |

---

## 1. Decisions for you

Each decision: **recommendation**, then pros, cons and alternatives. The rest of the plan assumes the recommendations.

### D1. The ⓘ icon

"A circle with an eye in it" is read as the **information icon ⓘ** ("i" heard as "eye"). If you meant a literal eye (as in "show/hide"), say so; the rest of this decision stays the same.

**Recommendation:** an ⓘ (codicon `info`) after each setting's label. Hover or keyboard focus shows a popover in VS Code's hover style; a click pins it, Escape closes it. The texts live in one file (`src/webview/help.ts`).

- Pros: discoverable without clutter; the same text can feed the README; it can be longer than a `title` and formatted (a line of intuition, a "when to change" line, cost: *live* or *rebuild*).
- Cons: 30–40 texts to write and keep correct; popovers need care near panel edges.
- Alternatives:
  - **Inline help that expands under the control.** Simplest, but pushes the layout around.
  - **A "Learn" panel that explains the section in focus.** Good for long reads, weak for a quick check.
  - **Keep `title` attributes.** No work, but slow and unformatted.

### D2. Making hover fast

**Recommendation:** work on the existing channel first, and measure before considering a new one.

1. Show what the webview already knows **immediately**: the title (see D3), the colour value or category, and the cluster name. Highlight the hovered point.
2. Coalesce requests: one in flight, and the latest wins.
3. Keep an LRU cache of rows (≈ 1,000).
4. Prefetch the hovered point's map neighbours in one batched `rows()` call.
5. Lower the debounce from 120 ms to ≈ 30 ms, which is safe once requests are coalesced.

- Pros: no new moving parts; works the same in Positron and in the harness. The first visible content should appear within a frame (*estimate*), and details within one round trip, which the cache often makes 0.
- Cons: the remaining round trip still waits for the kernel. If your own code is running in the console, `evaluateCode` queues behind it and details do not arrive until it finishes.
- Alternatives:
  - **A side channel.** A small thread in the kernel helper serves rows over a local socket with a random token, and the host connects to it. This bypasses the execute queue, so hover keeps working while your code runs. But it is a new network surface (localhost, token, firewall prompts on some systems) and must not break remote kernels. Only worth doing if measurement shows the round trip itself is the bottleneck.
  - **Positron comms** (Jupyter comm messages). Native to the kernel protocol, but needs a Positron API for extensions to open a comm. Check whether Positron exposes one; if not, it is not an option.
  - **Preload all hover data into the webview.** Instant, but memory grows with rows × columns. Fine for titles (D3), not for every column.

### D3. Hover title and links

**Recommendation:** a **Tooltip** section in Explore:

- **Title:** a text column, auto-detected from names such as `title`, `name`, `label` or `text`, or the first text column. Shown as the tooltip's heading.
- **Fields:** none, a chosen list, or all (today's behaviour). The default is none when a title is set.
- **Link:** a column whose values are URLs, auto-detected (`http(s)://`).
- **Image:** pixel columns (today's "points are images", such as MNIST) or an image-URL column, both as in D5.

Title strings are **preloaded** for every kept row when they fit in a budget (default 64 MB, truncated to 120 characters). Otherwise they are fetched with the row, using the cache and prefetch from D2.

For links, **both**:

- **Click a point:** pins the tooltip as a card (DataMapPlot's `tap_to_inspect`). The link is clickable there, with an **Open** button. Escape or a click elsewhere closes it.
- **Cmd/Ctrl-click a point:** opens its link directly (DataMapPlot's `on_click`).

Links open through the host with `vscode.env.openExternal`, so Positron's own link protection applies. Only `http`, `https` and `mailto` are allowed.

- Pros: a tooltip that follows the mouse can never be clicked, so pinning is needed anyway. Cmd/Ctrl-click is fast for power users.
- Cons: click is currently free on the map (pan uses drag), so this is a small behaviour change. Preloading 10M titles exceeds the budget, so very large frames fall back to fetching.
- Alternatives:
  - **Only modifier-click.** Invisible to most users.
  - **Only pinning.** Two clicks for every link.
  - **A template** like DataMapPlot's `hover_text_html_template` (`"{title} ({year})"`). Powerful, but later: start with title + fields.

### D4. narwhals

**Recommendation:** a **hybrid**.

- Keep the native pandas and polars paths: they are tuned and benchmarked.
- Route every other frame type through narwhals when narwhals can be imported in your session: pyarrow Tables, Modin, cuDF, and lazy frames from DuckDB, Ibis or polars (collected, with a row limit and a warning).
- Without narwhals, accept anything that implements the Arrow PyCapsule interface (`__arrow_c_stream__`), using polars or pyarrow if one of them is installed.

- Pros:
  - More frame types without slowing down the two that matter most.
  - narwhals is often installed already (plotly ≥ 6 and Altair depend on it), and nothing is installed into your environment.
  - Write-back (adding columns, new frames) stays native for pandas and polars, and is narwhals-generic for the rest.
- Cons:
  - Two code paths to test: the matrix grows (pandas, polars, pyarrow, and one lazy backend in CI).
  - Lazy backends need a "collect" step that can be expensive; the UI must say so.
- Alternatives:
  - **Full migration to narwhals**, vendoring a pinned copy loaded by path. One code path, but:
    - narwhals imports itself as `narwhals`, so a vendored copy conflicts with your own version;
    - the tuned paths would need narwhals-level equivalents, so a regression risk;
    - roughly half of the helper rewritten.
  - **Arrow PyCapsule only.** Small, but needs polars or pyarrow and covers fewer types.
  - **Status quo.** pandas and polars only, plus the existing hint to `.collect()` LazyFrames.

  Note: R data frames in Positron are a separate question (another kernel language), out of scope here.

### D5. Images: pixel columns and image URLs

Two ways a row can be an image, both used everywhere an image appears (tooltip, pinned card, point annotations in A4, PNG export, HTML export):

1. **Pixel columns** (MNIST, Fashion-MNIST): many numeric columns that are the pixels. This exists today (Explore → "Points are images": automatic detection of the pixel columns, width, invert). Annotations need nothing new: the kernel already returns a row's pixels with `row()`, and the webview draws them (`PixelImage`).
2. **An image-URL column** (new): a text column whose values point to images, such as `https://…/cat.jpg`, or a local path (`images/0001.png`, relative to the workspace or absolute). It is auto-detected from a sample of values (an image extension, or `http(s)` plus a check of the content type for a few rows), and can be chosen by hand.

A third kind could follow later: **image bytes in a column** (Hugging Face datasets store images as `{bytes, path}` structs; pandas often holds PIL images). The kernel would turn them into small PNG thumbnails on request. Not in the first version.

**How URL images are loaded: recommendation.** Through the **extension host**, not by the webview itself:

- The webview asks for the image of row *i*.
- The host gets it: it downloads `http(s)` URLs with Node's `fetch` (with a timeout and a size limit, for example 10 MB), or reads a local path. It writes a thumbnail-sized copy into the job directory, a small LRU disk cache.
- The webview shows it as an ordinary webview resource (`asWebviewUri`), like the other job files.

Downloading from the internet is a setting, **"Load images from URLs"**. It is asked once per panel the first time an image-URL column is used ("This column links to images on N hosts. Download them?"), and remembered. Local paths need no prompt.

- Pros:
  - **No CSP change**: the webview still loads nothing from the internet itself.
  - **PNG export keeps working.** Images loaded by the webview straight from other sites would "taint" the canvas, and the browser then refuses to export it (`toDataURL` fails without CORS headers on those sites). Images from the job directory don't have that problem.
  - Local files work too (the webview cannot read arbitrary paths).
  - One place for the timeout, size limit and cache.
  - The HTML export can embed the thumbnails of annotated points, so they also work offline.
- Cons: a bit more code in the host; the first hover on a new image waits for a download (the D2 prefetch helps: it prefetches the neighbours' images too).
- Alternatives:
  - **The webview loads URLs directly**, with `img-src https:` in the CSP when the setting is on. Least code, but PNG export breaks for most sites, local paths don't work, and every image request comes from the webview with no size limit.
  - **The kernel downloads the images.** Same result as the host, but it uses your Python session (slower, and it competes with your own code), and needs `urllib` handling there.
  - **Never download; show URL images only in exported HTML.** Private, but you cannot see the images while exploring.

In the **HTML export**, pixel images are embedded for annotated points and, if chosen, for all points (MNIST: 784 bytes per point, so 70,000 points ≈ 55 MB, too big by default). URL images are embedded as thumbnails for annotated points; for the other points the exported page links to the original URLs, which needs a network connection to view.

### D6. A large example (≥ 10M points)

DataMapPlot's examples top out at ≈ 517k points (CORD-19) and ship only 2D coordinates, not features. Its larger suggestions (OpenAlex, peS2o) have no embeddings: embedding 10M+ texts with a neural model takes GPU-hours.

**Recommendation:** two new example notebooks.

1. **HIGGS:**
   - 11,000,000 rows × 28 numeric features plus a class label. UCI, CC BY 4.0, 2.6 GB compressed CSV (verified).
   - Tests scale: placement, 10M-point rendering, legend toggles on the label.
   - Ready to use, with no embedding step.
2. **Wikipedia titles:**
   - English, German and French articles from `wikimedia/wikipedia` (Parquet on Hugging Face, CC BY-SA 3.0, verified). English alone is 6.4M articles; the three together should exceed 10M (*estimate*: check the counts).
   - Embedded with the static embedding model `minishlab/potion-multilingual-128M` (MIT, verified), which runs on a CPU. Throughput needs a measurement; the notebook caches the result. Then PCA to 64 dims and stored as Parquet.
   - Columns: `title`, `url`, `language`, `first_sentence`, features.
   - Exercises everything asked for: hover title, clickable URL, legend toggle by language, labels, annotations.
   - At 11M × 64 float32, the prepared features take about 2.8 GB in the kernel (*estimate*).

- Pros: one example for scale, one for text, links and annotation; both freely licensed, with no GPU needed.
- Cons:
  - The Wikipedia notebook has a long first run (download a few GB plus embedding: minutes to an hour, *estimate*).
  - Static embeddings give a coarser map than transformer embeddings.
- Alternatives:
  - **NYC taxi trips.** A year is ≈ 40M rows of numeric and categorical data in monthly Parquet files (URL verified); no text.
  - **OpenAlex slice.** CC0, titles, DOIs and a 3-level topic taxonomy, ideal for multi-level labels, but needs embeddings computed: too heavy for an example.
  - **DataMapPlot's own CORD-19 / Wikipedia data.** Great for comparing annotation looks, but small and without features.

### D7. Native look: how

**What other Positron extensions do** (checked 2026-11-21 on the installed extensions; section 6.1 has the details):

- **Posit Publisher** (a sidebar form, the closest to our sidebar) hand-builds its controls in Vue on VS Code theme tokens: a custom checkbox on `--vscode-settings-checkbox*` with a codicon check, a custom select, and bundled codicons. It uses no component library.
- **Posit Assistant** (chat) uses Tailwind on VS Code tokens.
- Neither uses Positron's own tokens.

**Positron's built-in panes** (Plots, Variables, Data Explorer, dialogs) are not webviews, but they use 353 Positron theme colours, and **Positron passes every registered colour and size into extension webviews** as `--vscode-*` variables (verified in the workbench code). So we can use Positron's own look directly, which is more native than copying the extensions.

**Recommendation:** our own CSS, using **Positron's tokens first, VS Code's as fallback**, with **bundled codicons** (`@vscode/codicons`: font CC BY 4.0, code MIT). Copy Positron's own components:

- **Plot toolbar:** Positron's action bar (28 px high, 24 px transparent icon buttons, 4 px corners, `--vscode-positronActionBar-hoverBackground` on hover, a 7 px separator).
- **Map / Explore / Annotate / Export:** Positron's **segmented toggle** (20 px high, 6 px corners; the selected item gets `--vscode-positronActionBar-background` and a `--vscode-positronActionBar-toggleButtonHighlightedBorder` border). Today's pill switcher is close to this already; only the colours and sizes change.
- **Checkbox:** Positron's (16 px, 3 px corners, `--vscode-positronCheckbox-background/-border/-foreground`, a bold 12 px codicon check).
- **Select:** styled like Positron's drop-down list box (4 px corners, `--vscode-positronDropDownListBox-*`, codicon chevron), on a native `<select>` so keyboard behaviour and accessibility stay free.
- **Text and number inputs:** Positron's dialog input (4 px corners, 4 px padding).
- **Slider:** neither Positron nor VS Code has one, so we design it in their visual language: a thin track (`--vscode-scrollbarSlider-background`), a filled part and a 12 px thumb in `--vscode-button-background`, and a `--vscode-focusBorder` focus ring.
- **Small bar charts** (Selection → comparison): the Data Explorer's sparkline colours (`--vscode-positronDataExplorer-sparkline*`).
- **Tooltips and ⓘ popovers:** `--vscode-positronToolTip-*` (VS Code's hover widget colours as fallback).
- **Section headers:** pane-header style with codicon chevrons.

Then dump the real variables in Positron (N1) and copy them into the harness, so harness screenshots match Positron. Test dark, light and high-contrast themes; high contrast needs `--vscode-contrastBorder`.

- Pros: no runtime dependency; looks like Positron itself rather than generic VS Code; follows whatever theme you use, including Positron's own theme colours.
- Cons:
  - We maintain the controls (focus, keyboard and ARIA for sliders and checkboxes).
  - Positron tokens can be renamed in a Positron release. Every use gets a VS Code fallback (`var(--vscode-positronCheckbox-background, var(--vscode-checkbox-background))`), so a rename degrades to the VS Code look instead of breaking.
- Alternatives:
  - **Match Posit Publisher** (VS Code settings-editor style). Proven in a Posit extension, but it looks like VS Code's settings page, not Positron's panes.
  - **`@vscode-elements/elements`** (community web components in the VS Code style). Fast to adopt, but a dependency with its own release cycle, web components inside Svelte, and the VS Code look rather than Positron's.
  - **`@vscode/webview-ui-toolkit`.** Deprecated by Microsoft (January 2025): no.

### D8. Full screen

**Recommendation:** one **Full screen** button (codicon `screen-full`) in the plot toolbar.

- **In Positron:** it asks the host to run `workbench.action.maximizeEditorHideSidebar` and switches the panel to **focus mode** (sidebar collapsed, footer hidden, toolbar and legend kept). Pressing it again restores both.
- **In a browser** (the harness, or an exported HTML file): the Fullscreen API (`element.requestFullscreen()`).

First test whether `requestFullscreen()` works in a Positron webview. If it does, use it there too.

- Pros: always works, and feels native (Positron's own maximize).
- Cons: "maximize editor" is not true OS full screen.
- Alternatives:
  - **Move the editor to a new window** (`workbench.action.moveEditorToNewWindow`) and make that window full screen. Real full screen, but heavier and the panel moves window.
  - **Only focus mode inside the panel.** Simplest, but it doesn't hide Positron's chrome.

### D9. Legend toggles

**Recommendation:**

- **Click:** hides or shows a category.
- **Alt/Option-click:** shows only that category, and Alt-clicking it again shows all.
- A **Show all** link appears when anything is hidden.

Hidden points are not drawn, not hoverable, not lassoed, and do not count for labels or clusters. They stay in the data, so placement and colours stay stable. It is implemented with deck.gl's `DataFilterExtension` on a per-point category attribute, a GPU filter with no re-upload of positions. The hidden set is saved in the panel state. For numeric colours, a range brush on the colour bar comes later (it is DataMapPlot's histogram filter in another form).

- Pros: instant even at 10M points; consistent with how DataMapPlot and most plotting tools behave.
- Cons: "do not count for labels" means labels move when you toggle. The alternative is to keep labels fixed, which can leave labels of hidden groups. Recommendation: hide those labels too, but don't recluster.
- Alternatives: dim hidden points instead of removing them (keeps context, but the map stays cluttered). This could be an option later.

### D10. Annotations: what "relative position" means, and where they are kept

**Recommendation:**

- A dragged annotation or label stores an **offset in screen pixels from its anchor**. For a point annotation, the anchor is the point; for a cluster label, it is the label's automatic position. The offset therefore stays the same at every zoom level, which keeps annotations readable when zooming in, like callouts on a map.
- Annotations are stored in the **panel state** (survives reloads and restarts of Positron). They are keyed by the **DataFrame row index**, or by the value of an **ID column** if you pick one, which survives sorting and filtering.
- They can be exported and imported as JSON, and are included in the HTML export and the DataMapPlot code (as highlights).

- Pros: predictable when zooming; survives what usually happens to a DataFrame; portable.
- Cons: screen-pixel offsets mean an annotation's leader line gets longer in world terms when zoomed out. The static export uses the view as shown, so this is consistent.
- Alternatives:
  - **Offsets in map units.** They scale with zoom: matches a static figure, but annotations collide or fly away when zooming.
  - **Store annotations in the DataFrame** (an `atlas_note` column). Visible and persistent in your session, but it clutters your data and loses the positions.
  - **A sidecar file** in the workspace (`.atlas/<variable>.json`). Survives closing the panel and can be committed to git, but ties the annotations to a workspace and a variable name. Could be added on top of the panel state later.

### D11. Fonts

**Recommendation:** a font picker for **labels** and for the **title and subtitle**, with three sources in one searchable list:

1. **Bundled:** a small curated set of open (OFL) fonts matching DataMapPlot's gallery, so the common looks work offline from the first run: Cinzel, Playfair Display SC, Marcellus SC, Montserrat, Roboto, Roboto Condensed, plus Inter and a monospace (≈ 0.5–1.5 MB of woff2 in total, *estimate*: Latin subsets).
2. **Google Fonts, downloaded on demand:** any of the ≈ 1,960 families.
3. **Installed on this machine:** a free-text field for any font by name, which works because deck.gl draws text with the browser's fonts. **Editor font** (today's default) is the first entry.

Each role also gets a weight, and a **weight range** for dynamic weight (big clusters bolder, as DataMapPlot's `min_font_weight` / `max_font_weight`).

**How Google Fonts are loaded** (same pattern as D5's images):

- **The catalogue** of family names, categories (serif, sans-serif, display, handwriting, monospace) and available weights is a **snapshot bundled with the extension**: about 30–60 KB after trimming (*estimate*). It is generated at build time by a script from `fonts.google.com/metadata/fonts` (checked: no key needed, 1,961 families, 2.7 MB untrimmed). The picker works offline, can filter by category, and is updated with each release.
- **Downloading:** when you pick a family that isn't cached, the **extension host** asks the Google Fonts CSS2 API for it (`fonts.googleapis.com/css2?family=Cinzel:wght@400..900`; checked: no key needed, returns variable-weight woff2 files split per script). It downloads the woff2 files for the scripts in use (Latin first; others when the labels contain them) from `fonts.gstatic.com`, with a timeout and a size limit.
- **Caching:** the files go to the extension's **global storage** (`context.globalStorageUri/fonts`), so they survive sessions and are shared by all panels and workspaces. The host rewrites the `@font-face` rules to point at webview URIs.
- **Loading in the webview:** the webview loads those rules as webview resources; `font-src` already allows them, so **no CSP change** is needed. Before using a font, it waits for `document.fonts.load()`, because deck.gl rasterizes the glyphs once into a texture and would otherwise cache the fallback font.
- **Permission:** a setting **"Download fonts from Google Fonts"**, asked once (globally) the first time you pick a non-bundled family. Off means the Google entries are shown but greyed out, with a hint.
- **Offline:** cached and bundled fonts keep working; uncached Google fonts fall back to the editor font, with a notice.
- **HTML and PNG export** embed or use the font files from the cache, so exports look the same everywhere, offline too. Google Fonts' licences (OFL, Apache 2.0, UFL) all allow embedding; the export includes the licence name.

- Pros: the whole Google catalogue, like DataMapPlot (`font_family` downloads from Google Fonts there too); bundled fonts and the cache keep it working offline; the privacy cost is opt-in and only paid once per family.
- Cons:
  - More code than bundling: the catalogue script, downloads, cache and permission.
  - The catalogue endpoint is unofficial and could change; it is only used at build time, so a change breaks the next release's update, not users.
  - Downloads tell Google your IP address and the fonts you picked.
- Alternatives:
  - **The official Google Fonts Developer API** for the catalogue. It needs an API key (checked: 403 without one), and a key can't be kept secret in an extension.
  - **Let the webview load Google Fonts directly** (`font-src https://fonts.gstatic.com` plus the CSS from `fonts.googleapis.com`). Least code, but a CSP change, no cache across panels, no offline use, and exports have to download the fonts again.
  - **Bundled and installed fonts only.** No network at all, but a limited choice.

### D12. Self-contained HTML export

**Recommendation:** our own **viewer build**: a second Vite entry with the renderer, labels, outlines, legend (with toggles), tooltip (title, fields and link), search, annotations, and title and subtitle, without the sidebar or the kernel.

The export writes one HTML file with the viewer inlined and the data embedded as **gzip-compressed binary**, base64-encoded and decoded with the browser's `DecompressionStream`:

- positions as f32;
- colours as category codes (u8/u16) plus a palette, or RGBA;
- tooltip columns as UTF-8 text with offsets.

Before writing, a dialog shows the estimated size, with options:

- **Sample:** 100 % / 10 % / 1 %.
- **Columns:** which columns go into the tooltip.
- **Rows:** a maximum number of rows.

The default limit is about 100 MB.

- Pros: looks exactly like the panel; works offline; no Python dependency; can carry Atlas-only features (annotations, legend toggles).
- Cons: a second bundle to maintain. Browsers struggle with HTML files over a few hundred MB, so 10M points need sampling (*estimate*: about 12 bytes per point before text).
- Alternatives:
  - **Generate DataMapPlot's HTML in the kernel** (`datamapplot.create_interactive_plot(...).save()`). The DataMapPlot look for free, but needs datamapplot installed and loses Atlas-only features. Recommendation: offer it too, as "Export with DataMapPlot", since the code snippet already exists.
  - **embedding-atlas's static viewer.** Another look and heavier.

### D13. 3D maps

**Recommendation:** yes, but **late** (phase 6), behind a **2D / 3D** toggle in Map → UMAP. It needs a rebuild of the layout.

- **UMAP:** browser UMAP with `outputDim = 3`; the kernel engines with `n_components = 3`.
- **Placement:** generalized to any number of dimensions (numpy is already generic; Rust `place_point` returns 2 values today). Files become `xyz` with 3 columns.
- **Rendering:** deck.gl `OrbitView`. Drag rotates, Shift-drag pans, scroll zooms. Buttons: **Reset view**, **Auto-rotate**, and **Top / Front / Side**.
- **Labels:** drawn as billboards (always facing you).
- **Hover:** GPU picking or a screen-space index rebuilt when the camera stops.
- **Lasso:** in screen space.
- **Off in 3D at first:** outlines, automatic clusters, dragging labels, and DataMapPlot code (2D only).
- **Write-back:** `add_coordinates` adds `umap_z`.

- Pros: a real UMAP option, and some structures separate better in 3D.
- Cons:
  - 3D scatterplots are harder to read and to annotate.
  - DataMapPlot is 2D only, so the annotation work does not carry over.
  - It touches the whole pipeline (file formats, placement, renderer, hover, lasso) and doubles the cases to test.
- Alternatives:
  - **3D for anchors only, without placement.** Half the work, but at most 100k points.
  - **No 3D.** Focus on 2D annotation parity.

### D14. Labels around the map with leader lines (DataMapPlot's static style)

**Recommendation:** a **Label style** choice: **Over the points** (today's) or **Around the map**. The second places labels outside the point cloud with leader lines (straight, curved or wedge; coloured like the cluster or grey). The layout is computed for the current view and recomputed when the view settles; it is meant for presentation and PNG/HTML export.

- Pros: the most recognizable DataMapPlot look (3 of its 4 static gallery images).
- Cons:
  - Needs a placement algorithm (radial order plus overlap removal, like DataMapPlot's `pylabeladjust`).
  - It changes as you pan and zoom.
  - Effort L.
- Alternatives: only in the PNG export (simpler, no live recomputation), or not at all.

---

## 2. Recommended order

| Phase | Contents | Why first | Effort |
|---|---|---|---|
| 1 · Feel | Hover speed (H1–H4), tooltip title/link/pin (H5–H7), image URLs (H8), ⓘ help (I1–I3), native look (N1–N5), legend toggles (L1), full screen (F1) | What you notice every minute; low risk; no pipeline changes | M + M + M + M + S + S |
| 2 · Speed | Neighbour cache (P1), search during UMAP (P2), polling and chunks (P5), binary messages (P4), HIGGS example (E1) as the benchmark | Big wins on large frames; E1 gives the 10M test case | M + S + S + S + S |
| 3 · Annotate | Title/subtitle (A1), fonts (A2), draggable labels (A3), point annotations (A4), hover highlight (A5), colour by cluster (A6), search (A7), multi-level labels (A8), highlighted labels (A9), size by column (A10) | DataMapPlot parity | L overall |
| 4 · Share | Self-contained HTML (X1–X4), "Export with DataMapPlot" | Needs phase 3 to carry annotations | M–L |
| 5 · Data | narwhals hybrid (D-1), Wikipedia example (E2), CPU-only machines (P3/P7) | Independent; E2 shows off phases 1–4 | M + M + M |
| 6 · Later | 3D (T1–T6), labels around the map (A11), glow (A12), histogram filter (A13) | Large or lower value | L + L + M + M |

---

## 3. Performance (P)

### P1. Keep each row's nearest anchors between placements — M

- **Kernel:**
  - After the first placement, keep `job.nbr_idx` (u32, n × k) and `job.nbr_sqd` (f32, n × k).
  - Key them by prepare generation, metric, k and an **index seed fixed at 0**. Today the IVF k-means uses the UMAP seed, so a new UMAP seed would empty the cache.
  - On later placements with the same key, skip the index build and the search, and only compute the weighted mean.
  - New setting `positronAtlas.neighborCacheMB` (default 1024). Above it, use today's fused path.
- **Rust:**
  - Add `place_from_neighbors(nbr_idx, nbr_sqd, anchor_xy, out)` (parallel; `place_point` exists).
  - Have `Index.neighbors` return u32 instead of i64 (half the memory) or add a variant.
  - Optionally store distances as f16 to reach 6 bytes per neighbour.
- **numpy:** `AnchorIndex.query` + `place_from_neighbors` already exist; cache their outputs.
- **Expected:** re-placement of 10⁶ rows ≈ 0.05–0.1 s instead of 1.4–1.9 s (Rust) or 16 s (numpy) (*estimate*). Memory 80 bytes per row at k = 10 (u32 + f32), or 60 with f16.
- **Tests:** identical output with and without the cache (numpy and Rust); the cache is invalidated by prepare, by metric changes and by cancel; the memory cap.
- **Benchmarks:** add a "re-place" column to `python/bench_project.py` and to `docs/benchmarks.md`.

### P2. Search neighbours while the browser runs UMAP — S (after P1)

- **Option A (recommended):** a **neighbours** stage at the end of `prepare`. Prepare publishes its anchor outputs first, and the host sends `prepared` as soon as those outputs appear, instead of waiting for `done`; UMAP starts while the job continues. `project` then waits for the neighbours stage if it is still running.
- **Option B:** a second task slot (`_Job.run` supersedes the running task today). More general, but more state to manage.
- **Threads:** cap rayon at cores − 1 while the browser runs UMAP on the CPU.
- **UI:** "Place all rows" becomes automatic for much larger frames. The 20 s estimate rule becomes "neighbours done, or done within a few seconds".

### P3. Without WebGPU, compute the anchor layout in the kernel — S

When `navigator.gpu` is missing and polars-umap is installed, suggest a **Kernel (polars-umap) on anchors** mode (new: today the kernel engines run on all rows). Allow the GPU anchor limit with it. You lose the live animation.

Evidence: browser CPU 74 s for 100k anchors, versus polars-umap 12.4 s for 100k × 50 (both *measured*, different machines).

### P4. Binary messages from the webview to the host — S

Post `Uint8Array`s instead of base64 for the anchor layout, masks and codes. First check that Positron's webview passes `ArrayBuffer`s through `postMessage` (VS Code has supported this since 1.57; test it in Positron e2e). Keep base64 as a fallback behind a capability check.

### P5. Shorter waits — S

- While a task runs, cap the polling backoff at 150 ms (today 500 ms).
- Make placement chunks geometric (10⁵, 2·10⁵, 4·10⁵, then 10⁶ rows), so the first points appear sooner.

### P6. Small copies — S

- Reuse the anchors gathered in `prepare` (moot with P1).
- The webview could fetch `anchors.f32` again instead of keeping a second copy for restarts. Measure first: 20 MB in the example.

### P7. UMAP from a kernel kNN graph — M (spike first)

- `createUMAPFromKNN` lets the kernel compute the anchors' neighbour graph on all cores, while the browser runs only SGD and keeps the animation and live changes.
- **Spike:** split the 74 s of CPU UMAP into kNN time and SGD time. Only worth it if kNN is a large share.
- **Recall:** the IVF index is approximate (recall ≈ 0.84–0.91 at k = 10, *measured*), which can change the layout. Measure layout quality (trustworthiness) against the browser's NNDescent.

---

## 4. Hover (H)

- **H1. Measure — S.** Add performance marks at each step: pointer → request → host → `evaluateCode` start and end → reply → render. Add an e2e scenario that hovers 50 points and reports the median and p95 per step. This decides whether the side channel in D2 is needed.
- **H2. Instant content — S.**
  - Render the tooltip immediately with what the webview has: the title (H5), the colour value or category, the cluster name, and the row number.
  - Highlight the hovered point with a ring (DataMapPlot's `point_hover_color`).
- **H3. Coalescing and cache — S.**
  - One request in flight; newer hovers replace queued ones.
  - LRU cache of 1,000 rows, keyed by kept row.
  - A new kernel function `rows(job, [i…], columns)` returns several rows in one call.
- **H4. Prefetch — S.** On hover, prefetch the 16 nearest points (from the hit index) in one `rows()` call.
- **H5. Title column — M.**
  - Kernel `texts(job, column, max_chars)` writes UTF-8 bytes plus u32 offsets to the job directory, up to the budget in D3.
  - Webview decodes lazily with `TextDecoder`.
  - Auto-detects the title column.
- **H6. Fields and link — S.**
  - Field picker (none, chosen, all).
  - Link column auto-detected from a sample of values.
  - Links rendered as anchors that post `openLink` to the host, which validates the scheme and calls `openExternal`.
- **H7. Pinned card — S.**
  - Click pins; Cmd/Ctrl-click opens the link.
  - The card has **Open link**, **Copy value** and **Annotate** (creates an A4 annotation).
  - Escape closes it.
- **H8. Image-URL column — M.** As in D5.
  - Auto-detect image-URL and image-path columns.
  - New `ToHost` message `image { row }`: the host resolves the URL or path, downloads it (after the one-time permission), makes a thumbnail, caches it in the job directory, and replies with a webview URI.
  - Neighbour images are prefetched with H4.
  - Tests: a harness scenario with local image paths, and a unit test for the host's size limit, timeout and allowed schemes.

---

## 5. ⓘ help (I)

- **I1. Texts — M.** One entry per setting in `src/webview/help.ts`: what it does, the intuition, when to change it, and the cost (*live* / *rebuild* / *re-prepare*). Example:

  > **Neighbours (`n_neighbors`)**: how many nearby rows each row "looks at" when UMAP builds its graph. Small values (5–15) keep fine local detail and can split groups into islands; large values (50–200) show the global shape and merge small groups. Rebuild.

  Settings covered:
  - **Data:** features, sample, standardize, PCA, anchors, missing values, seed.
  - **UMAP:** compute mode, neighbours, min distance, spread, epochs, metric, seed, and the advanced settings (repulsion, negative samples, learning rate).
  - **Result:** placement.
  - **Explore:** colours, palette, point size, opacity, density, images.
  - **Annotate:** labels (detail, name by, outlines, sizes).
- **I2. Component — S.** `<Info id="…">` with a codicon, a popover in VS Code hover style, keyboard focus, `aria-describedby`, and pin on click.
- **I3. Test — S.** A unit test that every control has a help entry and every entry is used. A harness screenshot with a popover open.

---

## 6. Native look (N)

### 6.1 Reference: what Positron and Posit extensions use

| Source | Kind | Controls | Tokens |
|---|---|---|---|
| Positron workbench (Plots, Variables, Data Explorer, dialogs) | built-in UI, React | action bar, segmented toggle, checkbox, drop-down list box, text input, buttons, tooltips | 353 `positron*` colours (for example `positronActionBar.*` 14, `positronModalDialog.*` 38, `positronDropDownListBox.*` 7, `positronCheckbox.*` 3, `positronToolTip.*` 2, `positronDataExplorer.*` 16), plus sizes such as `positronActionBar.height` = 28 px and `positronActionBar.iconSize` = 24 px |
| Posit Publisher 2.13 | webview, Vue | custom checkbox and select, codicons | `settings-checkbox*`, `sideBarSectionHeader-*`, `list-*`, `toolbar-hover*`, `input-*` |
| Posit Assistant 1.13 | webview, Tailwind | chat | `editor-*`, `button-*`, `editorHoverWidget-*`, `menu-*`, `dropdown-border` |
| Quarto, positron-r, positron-pdf-server | webviews | previews only (no settings controls) | — |

Webviews receive all of these: Positron builds the webview variables from the full colour registry (`getColors()`) and size registry (`getSizes()`), so `positron*` tokens are available as `--vscode-positron…` (the first `.` becomes `-`).

### 6.2 Items

- **N1. Audit — S.**
  - In real Positron (e2e), dump `getComputedStyle(document.documentElement)` for all `--vscode-*` variables in the dark, light and high-contrast themes. This confirms the `positron*` tokens arrive in our panel.
  - Screenshot Positron's Plots pane toolbar, a dialog with checkboxes and selects, and the Data Explorer summary, next to Atlas.
- **N2. Harness theme — S.** Replace the abridged theme in `test/harness/index.html` with the dumps, so harness screenshots match Positron.
- **N3. Codicons — S.** Bundle `@vscode/codicons` (CC BY 4.0 font, MIT code) and use it for the toolbar, the ⓘ icons, chevrons and checkboxes, as Positron and Publisher do. Keep a custom lasso icon drawn in codicon style.
- **N4. Controls — M.** As listed in D7. Each `positron*` token gets a VS Code fallback, and the primary and secondary buttons keep the VS Code button tokens. In detail:
  - **Plot toolbar** → action bar.
  - **Tab switcher** → segmented toggle.
  - **Checkbox, select and inputs** → the Positron dialog controls.
  - **Slider** → our own, in their visual language.
  - **Comparison bars** → sparkline colours.
  - **Tooltips** → `positronToolTip`.
- **N5. Check — S.** Harness screenshots in 3 themes for every tab, compared with the N1 screenshots of Positron, and keyboard-only navigation (Tab, arrows on sliders, Space on checkboxes).

---

## 7. Legend toggles (L) and full screen (F)

- **L1. Legend toggles — S.** As in D9.
  - `DataFilterExtension` with a category attribute (u16 codes, which exist already for categorical colours).
  - Hover, lasso and labels honour it.
  - Stored in the panel state.
  - Harness scenario: toggle and solo, with an assertion on visible counts.
- **F1. Full screen — S.**
  - As in D8. New `ToHost` message `fullscreen { on }`.
  - The host runs `workbench.action.maximizeEditorHideSidebar` (or toggles back).
  - The webview enters focus mode; the browser uses the Fullscreen API.
  - Spike first: try `requestFullscreen()` inside a Positron webview.

---

## 8. Data (D) and examples (E)

- **D-1. narwhals hybrid — M.** As in D4.
  - A `_Frame` subclass per path: pandas, polars, and generic (narwhals or Arrow C stream).
  - `list_frames` lists the new types (with a "lazy" marker).
  - Lazy frames: collect with a row limit (setting), showing the size first.
  - Tests: a pyarrow Table and a DuckDB relation in CI, through narwhals.
- **E1. HIGGS example — S.** Notebook `05-higgs.ipynb` (download 2.6 GB once, polars `read_csv`, 11M × 28). Used as the 10M benchmark for phase 2.
- **E2. Wikipedia titles example — M.**
  - Notebook `06-wikipedia-titles.ipynb`: download en + de + fr Parquet, embed titles with `potion-multilingual-128M` in batches (cached), PCA to 64 dims, columns `title`, `url`, `language`, `first_sentence`.
  - Measure the embedding throughput first, and document the first-run time and the disk use.
- `scripts/make_examples.py` generates both, like the existing notebooks.

---

## 9. Annotation: DataMapPlot parity (A)

### 9.1 What DataMapPlot shows, and where Atlas stands

From its 9 gallery images (4 static PNGs, 4 interactive GIFs, 1 edge-bundle PNG) and its API documentation. "Images" = in how many of the 9 the feature is visible.

| Feature | Images | DataMapPlot option | Atlas today | Item |
|---|---:|---|---|---|
| Title and subtitle, top left, own font and size | 9 | `title`, `sub_title`, `title_keywords`, `font_family` | missing | A1 |
| Label text coloured like the cluster | 9 | `color_label_text` | yes (`colorText`) | — |
| Grey "unlabelled" (noise) points | 9 | `noise_color`, `noise_label` | partial (clusters don't recolour points) | A6 |
| Logo, bottom right | 9 | `logo`, `logo_width` | missing | A1 (small) |
| Display fonts (Cinzel, Playfair Display SC, Marcellus SC, Montserrat, Roboto Condensed) | 9 | `font_family`, `font_weight` | editor font only | A2 |
| Multi-line wrapping | 5+ | `label_wrap_width`, `line_spacing` | fixed (`maxWidth: 9`) | A2 |
| Labels around the map with leader lines (straight, wedge, curved) | 3 | `label_over_points=False`, `arrowprops` | missing | A11 |
| Labels over the points, size and weight by cluster size | 3 | `label_over_points`, `dynamic_label_size`, `min/max_font_size`, `min/max_font_weight` | size only (`minSize`/`maxSize`) | A2 |
| Labels at several levels, changing with zoom | 3 | `*label_layers`, `hierarchical_collision_priority` | one level (detail 1–5) | A8 |
| Search box | 4 | `enable_search`, `search_field` | missing | A7 |
| Glow around clusters | 3 | `add_glow`, `glow_keywords` | missing (density mode is different) | A12 |
| Light, dark or cream background | 9 | `darkmode`, `background_color` | yes (background setting) | — |
| Text halo for readability | 2 | `text_outline_width`, `text_outline_color` | fixed halo | A2 |
| Highlighted labels in badges | 1 | `highlight_labels`, `highlight_label_keywords` | missing | A9 |
| Cluster boundary outlines | 1 | `cluster_boundary_polygons`, `polygon_alpha`, `color_cluster_boundaries` | yes (grey only) | A6 |
| Colour by another column with a legend | 1 | `marker_color_array` + custom legend | yes; toggles missing | L1 |
| Edge bundling | 1 | `edge_bundle` | missing | not planned |
| Tooltip text / HTML template / click action | docs | `hover_text`, `hover_text_html_template`, `on_click`, `tap_to_inspect` | all columns only | H5–H7 |
| Point size by column | docs | `marker_size_array` | missing | A10 |
| Hover highlight of the point | docs | `point_hover_color` | missing | A5 |
| Histogram filter, topic tree, hex density | docs | `histogram_*`, `enable_topic_tree`, `enable_hex_density` | missing (density mode exists) | A13 (histogram); others not planned |
| Lasso selection handler | docs | `selection_handler` | yes (comparison, tags, new DataFrame) | — |
| Use medoids for label positions | docs | `use_medoids` | densest spot (comparable) | — |
| Colour-vision-safer palette | docs | `cvd_safer` | missing | A6 (option) |

### 9.2 Items

- **A1. Title, subtitle and logo — S.**
  - Annotate → **Title**: title, subtitle, font, size, colour, position (top left by default).
  - Drawn as HTML over the map (crisp text), included in PNG and HTML export and in the DataMapPlot code.
  - Logo: pick an image file (stored in the panel state, limited in size). Optional.
- **A2. Label typography — M.**
  - Fonts as in D11, per role (labels, title): bundled, Google Fonts on demand, or installed.
  - Host: `fonts.ts` (catalogue lookup, CSS2 download, woff2 cache in global storage, `@font-face` rewrite); new messages `fontRequest { family, weights, scripts }` and `fontReady { css }`.
  - Build: `scripts/google_fonts_catalog.py` writes the trimmed catalogue snapshot.
  - Tests: a unit test for the CSS2 parsing and URL rewriting (from a recorded response); a harness scenario that uses a bundled font and asserts that the label texture was drawn with it.
  - Weight range (dynamic weight by group size), wrap width (characters), line spacing, halo width and colour, letter case (as is / UPPERCASE / Small caps through the font).
- **A3. Draggable cluster and column labels — M.**
  - In **pan** mode, dragging a label moves it (the cursor shows a move icon over labels). A label needs to be pickable: switch on picking for the `TextLayer` only.
  - Stored as a pixel offset from the automatic position (D10), keyed by the group (the column value, or the cluster's name plus nearest-centroid matching after reclustering).
  - Dragged labels get top collision priority (never hidden).
  - The context menu has **Reset position**; Annotate has **Reset all label positions**.
  - When a group disappears (another detail level or prepare), its offset is kept but unused.
- **A4. Point annotations — L.**
  - A new **Annotate** tool (codicon `pin`) in the plot toolbar. Clicking a point adds a callout: a box with text (default: the title column, else "Row n") or, when points are images (pixel columns or an image-URL column, D5), the **image**. A leader line runs from the point to the box.
  - Drag the box to move it; the line follows. Double-click the text to edit it.
  - Styles: plain, badge (coloured like the point), image with caption.
  - Annotate → **Annotations** lists them (go to, rename, delete, clear all); JSON export and import.
  - Rendering: HTML overlay positioned from the deck.gl viewport each frame. This gives crisp text, easy editing and images; deck layers would need texture atlases. Leader lines are an SVG overlay.
  - PNG export draws them onto the canvas.
- **A5. Hover highlight — S.** A ring around the hovered point, and around the pinned point.
- **A6. Colour by cluster — S.**
  - With automatic clusters, a **Colour by: clusters** choice (the map palette) with grey noise points and an "Unlabelled" legend entry.
  - Outlines coloured like their cluster (`color_cluster_boundaries`).
  - Optional colour-vision-safer palette.
- **A7. Search — M.**
  - A search box (top left, like DataMapPlot) that searches the title column (or a chosen text column).
  - The kernel returns matching kept rows (polars or pandas string contains, capped), the webview highlights them and fades the rest, and Enter zooms to them.
  - Cached for repeated keystrokes.
- **A8. Multi-level labels — M.**
  - Cluster at 2–3 detail levels.
  - Coarse labels show when zoomed out, finer ones fade in when zooming in, and coarse labels win collisions (`hierarchical_collision_priority`).
  - Works for column labels too, when you pick a second, finer column.
- **A9. Highlighted labels — S.** Pick groups to show in a badge (filled with the cluster colour, white bold text): DataMapPlot's `highlight_labels`.
- **A10. Size by column — S.** Point size from a numeric column (square-root scale, clamped), like `marker_size_array`.
- **A11. Labels around the map — L.** As in D14.
- **A12. Glow — M.** A blurred density halo per cluster, in the cluster's colour, under the points (a texture-based layer). Mostly for presentation.
- **A13. Histogram filter — M.** For a numeric or date column, a small histogram with brushing that filters points (with `DataFilterExtension`, like L1).

---

## 10. Self-contained HTML export (X)

- **X1. Viewer entry — M.** `src/viewer/main.ts`, reusing `render/`, `labels/`, `color/`, `select/` and the tooltip and legend components; no host messages, no kernel. Built by Vite to `dist/viewer/viewer.js` (one file).
- **X2. Packaging — M.**
  - Export → **HTML…** opens the dialog (size estimate, sample, tooltip columns).
  - The kernel writes the selected tooltip columns as UTF-8 plus offsets.
  - The webview packs positions, colour codes, labels, outlines, annotations, title and fonts into one binary blob, gzipped with `CompressionStream`.
  - The host writes the HTML file (viewer inlined, blob as base64).
- **X3. Viewer features:** pan and zoom, hover with title and link (links open in a new tab), legend toggles, search over the embedded text, annotations (read-only), the title, and full screen.
- **X4. Tests:** the harness exports a scenario, opens the HTML in Chromium, and asserts that it renders and that the counts and labels match; there is a size budget test.
- **"Export with DataMapPlot"** (S): runs `datamapplot.create_interactive_plot(...)` in the kernel with the current labels and title when datamapplot is installed, and saves the HTML.

---

## 11. 3D (T)

- **T1. Spike — S.** WebGPU `outputDim = 3` in Positron (e2e), timing against 2D.
- **T2. UMAP and placement — M.**
  - A `dims` field in the protocol (2 or 3).
  - The worker passes `outputDim`; the kernel engines pass `n_components`.
  - `place_from_neighbors` and Rust `place_point` take any number of dimensions.
  - Files `xyz_*.f32`.
- **T3. Renderer — M.** `OrbitView`, 3D positions, billboard labels, depth testing on, and the camera buttons (reset, auto-rotate, top/front/side).
- **T4. Interaction — M.** Hover by GPU picking (or a screen-space grid rebuilt when the camera stops), lasso in screen space, legend toggles unchanged.
- **T5. Turned off in 3D — S.** Outlines, automatic clusters, label dragging, point annotations, and DataMapPlot code, with a hint explaining why.
- **T6. Write-back — S.** `umap_z` in `add_coordinates`; 3D in the Python snippets.

---

## 12. Things deliberately left out

- **Edge bundling:** heavy to compute, and mainly decorative.
- **Topic tree:** needs a label hierarchy; it could follow A8.
- **Hex density overview:** the existing density mode covers the use.
- **Custom HTML, CSS and JS injection** (`custom_html` / `custom_css` / `custom_js`): a security concern in a webview, and of little value inside Positron.
- **R data frames:** a separate kernel language; a separate plan.

---

## 13. Testing and risks

**Testing**

- **Harness:** every phase adds harness scenarios with screenshots, for the hover card, the legend toggle, label drags (drag steps exist), point annotations, fonts, the title, and the HTML export (opened in Chromium).
- **Real Positron e2e:** host-dependent pieces need it: full screen and maximize, opening links, binary `postMessage`, the hover timing (H1) and the theme dump (N1).
- **Benchmarks:** `docs/benchmarks.md` gets the re-placement (P1), the hover latency (H1) and 10M-row HIGGS runs (E1).
- **The architecture page:** `docs/architecture.html` is updated with each phase (new messages, files and settings).

**Risks**

- **Picking labels** for dragging needs deck.gl picking on the `TextLayer` together with `CollisionFilterExtension`. Check early (in A3) that hidden labels are not pickable.
- **The HTML overlay for annotations** at 60 fps while panning: limit it to visible annotations and update positions in one `requestAnimationFrame`.
- **Neighbour cache memory** on 10M+ frames: the cap plus f16 distances; make the setting visible.
- **narwhals** lazy backends can be slow or huge to collect: always show the row count and a limit first.
- **3D** doubles the test matrix: keep it behind the toggle and, at first, out of the annotation and export features.
- **Fonts and licences:** include the OFL texts for the bundled fonts in the VSIX; HTML exports name each embedded font's licence.
- **Google Fonts endpoints:** the CSS2 API is public and stable; the catalogue endpoint is unofficial. If it disappears, the catalogue snapshot stays as it is and can be maintained by hand.

---

## 14. Running the work with several agents in parallel

### 14.1 What limits parallelism

Most work items are independent in *content*, but they meet in a few **shared files**. Two agents editing the same region of one of these files produce merge conflicts and, worse, inconsistent designs:

| File | Lines | Touched by |
|---|---:|---|
| `src/webview/atlas.svelte.ts` (all webview state, one class) | 1,408 | almost every webview item: H, L1, F1, A1–A13, X, T, P2, P4 |
| `python/positron_atlas_kernel.py` | 1,568 | P1, P2, P5, P6, H3, H5, A7, D-1 (narwhals rewrites `_Frame`, which every reader uses), T2 |
| `src/webview/render/renderer.ts` | 269 | L1 (filter), A3 (label picking), A5 (hover ring), A6, A8–A10, A12, A13, T3 (`OrbitView`) |
| `src/shared/protocol.ts` | 233 | every new message: H3, H5–H8, P2, P4, F1, D11 (fonts), A7, X2, T2 |
| `src/extension/atlasPanel.ts` and its copy `test/harness/host.js` | 507 / 286 | every new message (each handler exists twice) |
| `src/webview/style.css` and `components/*.svelte` | 132 + 9 files | N4 restyles all of them; I2 adds ⓘ to every control; H6, L1, A1, A4, A7 add UI |
| `rust/atlas-core/src/place.rs` | 175 | P1 (`place_from_neighbors`) and T2 (any number of dimensions) |
| `docs/architecture.html`, `docs/benchmarks.md` | — | everyone |

Additions to `protocol.ts` and to the message `switch` statements are small and append-only, so conflicts there are easy to resolve. The real conflicts are `atlas.svelte.ts`, `renderer.ts` and the kernel's `_Frame`.

Other limits:

- **Real Positron** (e2e) runs one instance at a time reliably, so every spike and check that needs Positron goes to **one agent**: T1, F1, P4, N1, H1, and the theme screenshots for N5.
- **Each agent works in its own git worktree.** Each needs its own `npm ci`, and its own `cargo` build if it touches Rust (a few minutes the first time). The harness picks random ports, so several harness runs at once are fine.
- **Every merge** runs `just test` plus the harness suite (`npm run test:harness`). One integrator (the main session) merges, resolves conflicts, and updates `architecture.html` and `benchmarks.md`, so agents don't all edit them.

### 14.2 Wave 0: prepare, mostly serial (1–2 days)

| Task | Agent | Why first |
|---|---|---|
| **Split `atlas.svelte.ts`** into modules along its existing sections: `state/hover.ts`, `state/colors.ts` (with the legend filter), `state/labels.ts`, `state/clusters.ts`, `state/selection.ts`, `state/umap.ts`, `state/projection.ts`, plus a thin `Atlas` that composes them. No behaviour change; the harness suite must pass unchanged. | 1 (the integrator or one agent) | Turns the biggest conflict point into separate files, so waves 1–2 can run with 4–5 agents instead of 2. |
| **Shared control components:** `Checkbox.svelte`, `Select.svelte`, `NumberInput.svelte`, `Info.svelte` (an empty ⓘ shell), next to the existing `Slider.svelte` and `Section.svelte`. Replace raw `<input type=checkbox>` and `<select>` with them. Same look as today. | same agent, after the split | Lets N4 restyle in one place while feature agents use the components. |
| **Positron spikes:** T1 (WebGPU 3D), F1 (`requestFullscreen`), P4 (`ArrayBuffer` in `postMessage`), N1 (theme variable dump, screenshots), H1 (hover timing). | 1 Positron agent, **in parallel** with the split (read-only, no repo changes except a results note) | Their answers change the designs of P4, F1, H2–H4, N4 and T. |
| **Offline spikes:** P7 (kNN versus SGD time in browser CPU UMAP), E2 (embedding throughput of `potion-multilingual-128M`, Wikipedia row counts). | 1 agent, **in parallel** | Decide whether P7 is worth doing, and E2's size. |

Without the split (an alternative): waves 1–2 still work, but at most 2–3 webview agents at a time, and with more merge work. The split costs about a day and carries a small risk of regressions, which the harness suite covers well.

### 14.3 Wave 1: feel and speed (5 agents in parallel)

| Agent | Items | Owns (writes) | Shares (append-only) |
|---|---|---|---|
| **1 · Kernel speed** | P1, P2 (kernel side, option A), P5, P6; P4 if the spike says yes | kernel `project`/`prepare` functions, `rust/`, `python/bench_*.py`, `kernelBridge.ts` polling | `protocol.ts` (`prepared` sent early), `atlasPanel.ts` + `host.js` |
| **2 · Hover** | H2–H8 | `state/hover.ts`, `App.svelte` tooltip and card, new `images.ts` in the host; kernel `rows()`, `texts()` | `protocol.ts`, host handlers, `renderer.ts` (hover ring only: A5 moves here from phase 3) |
| **3 · Native look** | N2–N5, N3 codicons | `style.css`, the shared control components, `PlotToolbar.svelte`, tab switcher, `test/harness/index.html` | none (it restyles, it doesn't add features) |
| **4 · Help** | I1 texts, I2 component, I3 test | `help.ts`, `Info.svelte` | adds `<Info>` next to each control in the tab components: after agent 3's component changes are merged, or touching only the label line of each control |
| **5 · Data and examples** | E1 HIGGS, E2 Wikipedia, D-1 narwhals | `examples/`, `scripts/make_examples.py`, kernel `_Frame` and `list_frames`, `python/tests/` | — |

Small items that fit with these agents:

- **L1 (legend toggles):** goes to agent 2 or 3, because it touches `Legend.svelte`, `state/colors.ts` and a renderer filter.
- **F1 (full screen):** goes to agent 3, because it touches the toolbar and adds one host message.

Conflict notes:

- **Agents 1 and 5 both edit the kernel helper,** but in different parts: agent 1 the `project` and `prepare` internals, agent 5 `_Frame`. Merge agent 5's `_Frame` change first, or keep its interface unchanged (recommended: narwhals goes behind the same `_Frame` methods).
- **Agent 2's new kernel functions** (`rows`, `texts`) use `_Frame` methods only, so they are not affected by narwhals.
- **Agents 3 and 4** both touch the components. Run them as one agent if the wave-0 control components were skipped.

### 14.4 Wave 2: annotation (4 agents in parallel)

Grouped by the code each touches, not by feature:

| Agent | Items | Owns |
|---|---|---|
| **6 · Labels** | A2 (typography, with the D11 fonts UI), A3 (dragging labels), A8 (multi-level labels), A9 (highlighted badges) | `state/labels.ts`, `labels/place.ts`, the renderer's `TextLayer`. These must be one agent, because all four change how labels are placed, prioritized and drawn. |
| **7 · Overlay** | A1 (title, subtitle, logo), A4 (point annotations, text and image) | new `overlay/` components (HTML and SVG over the map), `state/annotations.ts`, PNG export compositing |
| **8 · Colours and size** | A6 (colour by cluster, coloured outlines, colour-vision-safer palette), A10 (size by column), A13 (histogram filter; reuses L1's filter) | `state/colors.ts`, `color/`, `Legend.svelte`, the renderer's point attributes |
| **9 · Search and fonts plumbing** | A7 (search), D11 host side (`fonts.ts`, catalogue script, cache), "Export with DataMapPlot" | kernel `search()`, search box component, host `fonts.ts`, `scripts/google_fonts_catalog.py` |

- Agent 9's font plumbing can start in **wave 1** already: host code and a build script, no webview changes. Agent 6 then only consumes `fontReady`.
- **Agents 6 and 7** meet in PNG export: labels on the canvas, annotations composited on top. Agree the compositing order in wave 0, or have agent 7 own `toDataURL`.

### 14.5 Wave 3: share (2 agents)

| Agent | Items | Notes |
|---|---|---|
| **10 · Viewer** | X1 (viewer entry), X3 (viewer features) | Starts as soon as wave 2's modules exist; reuses them read-only. |
| **11 · Packaging** | X2 (dialog, packing, gzip, host writes the file), X4 (export tests) | The data format is agreed with agent 10 at the start (a small `viewer/format.ts` both use). |

The X1 and X2 skeleton (the Vite entry, the gzip packing and loading) can start during wave 2. Only the feature list waits for it.

### 14.6 Wave 4: later items (mostly serial)

- **3D (T2–T6): one agent, alone in its area.** It crosses the protocol, the kernel, Rust (`place.rs`, after P1), the renderer, hover, the lasso and export. Running it next to anything else that edits `renderer.ts` or `place.rs` guarantees conflicts.
- **A11 (labels around the map)** and **A12 (glow)** can run in parallel with each other, but A11 not with 3D (both change label rendering).

### 14.7 Summary

| Wave | Agents at once | Can't be split further because |
|---|---:|---|
| 0 | 1 serial + 2 spike agents | The refactor must land before feature work. |
| 1 | 5 | — |
| 2 | 4 | The label items share placement and drawing code. |
| 3 | 2 | The viewer and packaging share one data format. |
| 4 | 1–2 | 3D touches everything. |

- **With the wave-0 split,** everything except 3D, A11 and the wave-0 refactor itself can run with 4–5 agents at a time.
- **Without the wave-0 split,** waves 1 and 2 drop to about 2–3 agents each.
