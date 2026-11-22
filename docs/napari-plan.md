# Plan: napari-inspired features, navigation presets and a controls cheat sheet

Status: **proposal, nothing implemented**. Written 2026-11-22 against local `main` (`d9a00aa`).

This plan follows [`roadmap-plan.md`](roadmap-plan.md), whose items are done.

**Scope rule** (agreed 2026-11-22): a colleague is building a multi-dimensional (image) viewer for Positron.

- **Atlas shows what is similar to what:** rows of a DataFrame and their layout.
- **His viewer shows where things are:** nD arrays, images, volumes.

Everything below stays on the rows side. Interop with his viewer is noted for later in `roadmap-plan.md` section 15.

Effort is S (≤ 1 day), M (a few days) or L (a week or more). Facts about other applications are marked **verified** (official docs or source code) or **unverified** (general knowledge, to check before naming anything in the UI).

---

## Summary: what we'll add

1. **Navigation presets and native shortcuts.** 2D and 3D controls that feel familiar.
   - Presets for the main conventions: data maps and napari, molecular viewers, CAD and 3D tools, design tools.
   - Trackpad handling.
   - Every keyboard shortcut is an Atlas command, rebindable in Positron's Keyboard Shortcuts editor.
2. **Controls cheat sheet.** One keypress or button shows every mouse and keyboard control for the active preset, in your operating system's notation (⌘/⌥ or Ctrl/Alt), with links to change the preset and the shortcuts.
3. **Bounding boxes.** In 3D: a box around the data, as an orientation frame. In 2D and 3D: boxes per category, per cluster or per selection, as an alternative to hull outlines.
4. **Grid mode (small multiples).** The same layout side by side in a 2D grid of panels, each coloured by a different column, with linked cameras. Works for 2D and 3D maps.
5. **Layers: another DataFrame on the map.** New rows (new compounds, trials, proteins) are placed onto an existing map by nearest anchors and shown as their own layer. A layer list gives visibility, opacity, blending and order.
6. **Undo / redo** for everything that edits: tags, label positions, annotations, shapes, brush tagging, filters.
7. **Brush tagging.** Paint over points to give them a class. Eraser, brush size, fill a cluster. Written back as a column.
8. **Shapes on the map.** Rectangles, ellipses, polygons, lines, arrows and text as annotations. A shape can become a tag for the points inside it.
9. **Marker symbols.** Encode a second categorical column by point shape.
10. **Time slider and video export.** Filter rows by a date or number column with play/pause; export an animation (time slider, rotation, UMAP converging) as a video.
11. **Tracks and vectors between rows.** Lines connecting rows with the same ID ordered by time; arrows between two layouts or two conditions.
12. **Python API.** A handle in your session (`m = atlas.open(df)`, `m.selection`, `m.color_by(...)`, `m.on_select(...)`) so notebooks and the map drive each other.
13. **Small conveniences.**
    - An "Atlas: Open example" command (sample data).
    - "Open the selection in the Data Explorer".
    - 3D view options: perspective or orthographic, depth fade.

---

## Open questions (with recommendations)

Each question has a recommendation; the plan below assumes the recommendations.

**Q1. "Grid": small multiples or a reference grid?** napari's grid mode (`Cmd/Ctrl+G`, verified) shows layers side by side.

- **Recommendation:** item 4 is small multiples.
- **Also:** an optional reference grid (a floor plane in 3D), offered as an option of item 3, because a floor helps orientation in 3D the same way a bounding box does.
- **Alternative:** only one of the two.

**Q2. Default preset.**

- **Recommendation:** "Data map" (below). It is what Atlas does today, and it matches napari, deck.gl, Plotly and three.js:
  - 2D: left-drag pans, scroll zooms to the cursor.
  - 3D: left-drag rotates, right-drag or Shift-drag pans.
- **Alternative:** detect a trackpad and default to the "Design" scroll behaviour. Rejected: surprising, and detection is unreliable.

**Q3. Trackpad scrolling.** On macOS, two-finger scroll arrives as wheel events.

- **Recommendation:** a separate setting, **Scroll gesture: zoom | pan**, defaulting to **zoom** (today's behaviour, and the convention for data plots and maps).
  - With **pan**, pinch or ⌘/Ctrl+scroll zooms, as in Figma.
- **Pros:** predictable; one setting covers mice and trackpads.
- **Cons:** trackpad users who expect panning must find the setting. The cheat sheet mentions it.

**Q4. The reset-view key.**

- **Facts:**
  - napari uses `Ctrl/Cmd+R` (verified).
  - In VS Code, `Ctrl+R` opens Recent (Windows/Linux) and is also "Open Recent" on macOS (`Ctrl+R`).
  - `Cmd+0`, `Cmd+=` and `Cmd+-` zoom the whole window, so they are taken.
- **Recommendation:**
  - Plain keys while the map has focus: `R` reset/fit, `+`/`-` zoom, arrow keys pan, `1/2/3` top/front/side in 3D, `?` cheat sheet.
  - Every one of them is a contributed keybinding scoped to Atlas focus, so users can rebind them and they never steal keys elsewhere.
- **Alternative:** napari's `Cmd/Ctrl+R`, which conflicts with Open Recent.

**Q5. Python API transport.**

- **Recommendation:** start on the existing `evaluateCode` bridge. The kernel side queues commands that the host drains while polling job status. Events (selection changed) are pushed as a queue the Python handle reads, or as callbacks run when the kernel is idle.
- **Pros:** works today, no new channel.
- **Cons:** events are only as fast as the polling (150 ms).
- **Alternatives:**
  - Positron comms (Jupyter comm messages): native and instant, but needs a Positron API for extensions to open a comm. Spike first.
  - A local socket: fast, but a new network surface.

**Q6. Time slider and the scope rule.**

- **Recommendation:** build it as a **row filter** on a column (dates, years, epochs), not as slicing through array axes, and name it accordingly ("Animate by column"). Mention it to your colleague first.
- **Alternative:** skip it.

**Q7. Video format.**

- **Recommendation:** WebM via the browser's `MediaRecorder` on the canvas (no dependency).
- **Plus:** an animated PNG/GIF export for short clips through a small encoder, which needs a dependency.
- **Alternative:** frames as PNGs into a folder.

**Q8. Preset names.**

- **Recommendation:** describe conventions rather than claim compatibility: "Data map (napari, maps)", "Molecular viewer (ChimeraX, PyMOL)", "3D/CAD (Blender, Fusion 360)", "Design (Figma, Illustrator)".
- **Before naming:** verify the unverified bindings (Fusion 360 presets, Illustrator, Maestro, Spotfire) against current official docs.

---

## How the work can run in parallel

The shared files that create conflicts:

- **`render/renderer.ts`** (layers, controllers, overlays).
- **The input handling** (deck.gl controller, `LassoLayer.svelte`, `App.svelte`, label and annotation drags).
- **`package.json` contributes** (settings, commands, keybindings).
- **`src/shared/protocol.ts`.**

The plan splits along those lines.

**Wave A** (foundations, 3 agents in parallel, plus 1 spike):

- **A1 Input and navigation layer** (item 1). Owns: the controller setup in `renderer.ts`, a new `src/webview/input/` module (all pointer and keyboard dispatch), `package.json` keybindings, commands and navigation settings, and the focus context key.
- **A2 Layer model** (the first half of item 5). Owns: `PointSet` → `Layer` in `renderer.ts`, the layer list state and the protocol for layers. Coordinates with A1 on `renderer.ts`: A1 changes controllers and events, A2 changes the layers array.
- **A3 Undo/redo stack** (item 6). Owns: a new `src/webview/atlas/history.ts` and hooks in the existing editing functions (tags, label drags, annotations, filters). Small touch points in many `atlas/*.ts` files, but append-only.
- **Spike S1 (Positron):**
  - Do VS Code keybindings fire while the webview has focus (key forwarding), and does `activeWebviewPanelId` or a custom context work for Atlas tabs?
  - Can extensions open a kernel comm (Q5)?
  - List the default Positron keybindings that collide with the planned keys (dump Preferences → Open Default Keyboard Shortcuts (JSON)).

**Wave B** (after A1–A3, 4 agents in parallel):

- **B1 Cheat sheet** (item 2): needs A1's binding registry.
- **B2 Bounding boxes and reference grid** (item 3): renderer overlay layers only.
- **B3 Another DataFrame on the map** (the second half of item 5, plus item 9 symbols): needs A2.
- **B4 Brush tagging and shapes** (items 7 and 8): needs A1 (input modes) and A3 (undo). Shared input-tool code, so one agent.

**Wave C** (2–3 agents in parallel):

- **C1 Grid mode** (item 4): multiple deck views; needs A2.
- **C2 Time slider, video export, tracks and vectors** (items 10 and 11): renderer and filter work.
- **C3 Python API** (item 12): kernel, host and protocol; needs S1's answer.
- **Small items** (item 13) can be picked up by any agent with spare capacity.

The usual integration rules apply (see `roadmap-plan.md` section 14):

- every agent rebases onto local `main` first;
- there are no attribution trailers;
- commits are never rewritten from an old checkout;
- every new ToHost message has a handler in both hosts (`test/host-coverage.test.ts`);
- every runtime asset is packaged (`test/packaging.test.ts`);
- screenshots are looked at, and drawn pixels are asserted, not just state.

---

## 1. Navigation presets and native shortcuts — A1 (M–L)

### 1.1 Research summary

Details are in the research notes of 2026-11-22.

| Family | 2D | 3D | Source |
|---|---|---|---|
| **Data map**: napari, deck.gl, Google Maps, Tableau | Left-drag pan, scroll zoom to cursor, double-click zoom in, Alt-double-click zoom out, Alt-drag zoom box (napari) | Left-drag orbit, Shift-drag or right-drag pan, scroll zoom | napari and vispy source (verified), deck.gl source (verified) |
| **Molecular viewers**: ChimeraX, PyMOL, Maestro | — | Left-drag rotate, middle or right-drag translate, scroll zoom, Ctrl-left-drag select (ChimeraX); PyMOL right-drag zoom | ChimeraX docs (verified); PyMOL and Maestro (unverified) |
| **3D / CAD**: Blender, Fusion 360 (default), SolidWorks, Onshape | Middle-drag pan | Middle-drag orbit, Shift-middle-drag pan, scroll zoom, Home or F frame all, numpad views (Blender) | Blender manual (verified); Fusion 360 and SolidWorks (unverified) |
| **Design**: Figma, Illustrator | Space-drag pan; two-finger scroll pans, pinch or ⌘/Ctrl-scroll zooms; Shift+1 fit; left-drag selects | — | Figma (partly verified), Illustrator (unverified) |
| **Presets in other apps** | Fusion 360 "Pan, Zoom, Orbit shortcuts" with presets (names unverified); PyMOL mouse modes; ChimeraX reassignable modes; Blender "Emulate 3 Button Mouse" (Alt+left = middle, verified) | | |

**The main conflict is left-drag.** Maps and napari 2D pan with it, while molecular viewers and every web 3D library rotate with it. CAD tools use the middle button. Design tools select with it. That is exactly why presets help.

### 1.2 Design

- **Settings** (Positron Settings editor, like Posit Assistant's `assistant.submitKey` enum):
  - `positronAtlas.navigation.preset`: `dataMap` (default) | `molecular` | `cad` | `design`, with an `enumDescriptions` text per preset that spells out the bindings.
  - `positronAtlas.navigation.scrollGesture`: `zoom` (default) | `pan` (Q3).
  - `positronAtlas.navigation.zoomToCursor`: true.
  - `positronAtlas.navigation.invertZoom`: false.
  - `positronAtlas.navigation.emulateMiddleButton`: `off` | `alt` | `cmd` (Blender's idea, for the CAD preset on trackpads).
- **Preset tables:**

  | Action | Data map | Molecular | CAD | Design |
  |---|---|---|---|---|
  | 2D pan | left-drag | left-drag | middle-drag (or Alt-left with emulation) | Space-drag, middle-drag, trackpad scroll |
  | 2D zoom | scroll to cursor | scroll | scroll | pinch, ⌘/Ctrl-scroll |
  | 2D lasso | Shift-drag (add), Alt-drag (remove), the lasso tool | the same | left-drag in lasso tool, or Shift-drag | left-drag (selection is the default tool) |
  | 3D orbit | left-drag | left-drag | middle-drag | — (falls back to Data map in 3D) |
  | 3D pan | right-drag, Shift-left-drag | middle- or right-drag | Shift-middle-drag | — |
  | 3D zoom | scroll | scroll, right-drag | scroll | — |
  | Fit all | `R`, double-click background | `R` | `F`, `Home` | `Shift+1` |
  | Standard views (3D) | `1` top, `2` front, `3` side | the same | numpad 7/1/3 and `1/2/3` | — |
  | Zoom box | Alt-drag (napari) | — | — | Z tool |

  Clicking (pin a card), Shift-click (add) and Alt/Option-click (remove) stay the same in every preset.
- **Keyboard shortcuts** are contributed commands with `category: "Atlas"`, scoped with `when: "positronAtlas.webviewFocused"`. The panel sets the context key on focus and blur, as Posit Assistant does with `posit-assistant.webviewFocused`. Users rebind them in the Keyboard Shortcuts editor.
  - **Commands:** `positronAtlas.view.reset`, `.zoomIn`, `.zoomOut`, `.panLeft/Right/Up/Down`, `.viewTop/Front/Side`, `.toggle3D`, `.toggleFullScreen`, `.tool.pan`, `.tool.lasso`, `.tool.annotate`, `.showControls` (`?`), `.undo`, `.redo`, `.selectAll`, `.clearSelection`, `.toggleGrid`.
  - **Defaults:** platform-specific where needed (`mac` / `win` / `linux` fields).
- **Mouse bindings can't be keybindings,** so they come from the preset and the settings above. The webview reads them through `init` and `settingsChanged` messages.

### 1.3 To-do

- [ ] Spike S1 results: keybinding dispatch while the webview is focused, the context key, and the collision list.
- [ ] `src/webview/input/`: one dispatcher for pointer, wheel and keys. Map events → actions by preset; route to the deck.gl controller (configure `dragMode`, `scrollZoom`, `keyboard`, `inertia`), the lasso, label and annotation drags, and clicks. Remove the per-component key listeners (`LassoLayer`, `App`) in favour of the dispatcher.
- [ ] A trackpad heuristic, used only for `scrollGesture: pan`: `wheel` with `ctrlKey` = pinch (Chromium sends pinch as ctrl+wheel); pixel deltas with horizontal components = two-finger scroll.
- [ ] Middle-button and emulation support (deck.gl controllers need custom handling for middle-drag orbit; implement in the dispatcher).
- [ ] Settings in `package.json` with Markdown enum descriptions; `readSettings()`; live update when settings change (`onDidChangeConfiguration` → `settingsChanged` message).
- [ ] Commands and keybindings in `package.json`; host forwards commands as `command { id }` messages; the webview runs them through the dispatcher; the same in `test/harness/host.js` (the harness simulates commands).
- [ ] Help entries (`help.ts`) for each navigation setting; the Info popover links to the cheat sheet.
- [ ] Tests:
  - vitest: preset tables and dispatcher mapping, every preset × action × 2D/3D.
  - Harness: a real mouse drag per preset in 2D and 3D, asserting the view state changed as expected (pan vs orbit); wheel with and without ctrl; keyboard commands.
  - e2e in Positron for keybinding dispatch and rebinding.
- [ ] Verify the unverified bindings (Fusion 360, Illustrator, PyMOL 3-button, Maestro) before the preset descriptions name them (Q8).

---

## 2. Controls cheat sheet — B1 (S–M)

- **Design** (after Figma's shortcuts panel, which opens with `Ctrl+Shift+?` and stays open while you work, partly verified; and napari's `Cmd/Ctrl+Alt+/` dialog, verified):
  - **Opening:** `?` (rebindable), a toolbar button (codicon `keyboard`), and the command **Atlas: Show Controls** in the Command Palette.
  - **Where:** a panel docked at the bottom of the map, so it doesn't hide the data; it stays open while you try controls; Escape closes it.
  - **Content:**
    - the active preset (a dropdown to switch it, writing the setting);
    - sections: Navigate, Select, Annotate, View (3D), Panels;
    - each row: action, mouse or gesture, key.
  - **Platform notation:** macOS glyphs (⌘ ⌥ ⇧ ⌃) or Windows/Linux words (Ctrl, Alt, Shift). The webview gets the platform from the host (`process.platform`) rather than guessing.
  - **Highlight:** briefly highlights a row when its action is used, like Figma.
  - **Links:** "Change keyboard shortcuts…" opens `workbench.action.openGlobalKeybindings` filtered to `positronAtlas`; "Navigation settings…" opens the Settings editor at `positronAtlas.navigation`.
- **Showing the user's own key bindings:** the extension API cannot read the user's keybindings. Options:
  - **Recommended:** the host reads the user's `keybindings.json` (from the user-data folder, read-only, tolerant of comments) and merges it with the defaults for display only. Pros: accurate. Cons: depends on the file location (profiles), which needs testing.
  - **Alternative:** show the defaults with a note that you may have rebound them.
- **To-do:**
  - [ ] `CheatSheet.svelte` and a binding registry from A1 (single source for the dispatcher and the cheat sheet, so they can't drift).
  - [ ] Platform notation helper with unit tests (mac vs win/linux strings for every binding).
  - [ ] Command, keybinding and toolbar button; links to Keyboard Shortcuts and Settings.
  - [ ] Optional reading of user keybindings (spike; fall back to defaults).
  - [ ] A first-run hint ("Press ? for controls") shown once per user (global state).
  - [ ] Harness: open with `?`, check content per preset and platform; screenshots in three themes.

---

## 3. Bounding boxes (and a reference grid) — B2 (M)

- **What:**
  - **3D data box:** a wireframe box around all points, as an orientation frame. Option: a floor grid at the box bottom (Q1), and a small orientation gizmo (x/y/z arrows, coloured) in a corner. No tick labels: UMAP units mean nothing.
  - **Group boxes:** per category of the colour or label column, per automatic cluster (2D; clusters are off in 3D), or per selection. Axis-aligned in 2D (rectangles) and 3D (wireframe cubes), in the group's colour, with an optional label at a corner. The extent is robust (2nd–98th percentile by default, or min/max), so outliers don't blow the boxes up.
  - **Selection box:** live, while selecting.
- **Relation to existing outlines:** cluster outlines (hulls) exist in 2D. Boxes are an alternative style ("Outline style: hull | box"), and the only option in 3D.
- **To-do:**
  - [ ] Box geometry helpers (robust extents per group, vectorized over codes; reuse `groupMeanColors`-style loops) with unit tests.
  - [ ] deck.gl `LineLayer` / `PathLayer` for wireframes (2D and 3D), and `TextLayer` for corner labels (billboard in 3D).
  - [ ] Floor grid and gizmo (3D only), toggles in Explore → Display.
  - [ ] Annotate → Labels: "Outline style: hull | box"; boxes per category or selection in 3D.
  - [ ] PNG export and HTML viewer include the boxes (2D at least).
  - [ ] Harness: pixel assertions for the box edges in 2D and 3D; screenshots.

---

## 4. Grid mode: small multiples — C1 (M–L)

- **What:** View → **Grid** (`Ctrl/Cmd+G` per napari, rebindable; check for collisions in S1). Shows 2, 4, 6 or 9 panels of the same layout, each with its own colour column (and optionally its own filter), with the camera linked (pan, zoom and rotate together). A click selects the same row in all panels. Works in 2D and 3D.
- **Design:** deck.gl `views` array with several `OrthographicView` or `OrbitView`s sharing one view state; one set of GPU buffers for positions, with colour attributes per panel.
- **To-do:**
  - [ ] Multi-view renderer (shared positions, per-view colours), with per-panel legend chips and titles.
  - [ ] Panel configuration UI (a colour column per panel, layout presets) and state persistence.
  - [ ] Hover and pin work in any panel; the lasso selects across panels.
  - [ ] PNG export of the whole grid.
  - [ ] Performance check at 1M points × 4 panels.
  - [ ] Harness: grid of 4 with different colourings, pixel assertions per panel.

---

## 5. Layers: another DataFrame on the map — A2 then B3 (L)

- **What:**
  - **Add rows:** Map → **Layers** → **Add DataFrame…** picks another DataFrame in the session with the same feature columns. Its rows go through the same preparation (the standardization and PCA fitted on the base frame) and are placed by their nearest anchors on the existing map, without rerunning UMAP (the neighbour search and placement exist).
  - **Show them:** they appear as a new layer, with their own colour or symbol, a title column and hover cards.
  - **Layer list:** visibility, opacity, blending (normal, additive) and order for every layer, including the base and the annotation and shape layers. Layers can be removed.
- **Why:** "Where do my new compounds land in our chemical space?" is the core pharma question. Mapping new rows without recomputing the layout makes it fast and stable.
- **To-do:**
  - [ ] Kernel: `prepare_overlay(job, name)` applies the stored transforms (mean/std, PCA components) to another frame's matching columns, with a clear error when columns are missing; `project_overlay` places those rows with the existing anchor index; outputs per layer.
  - [ ] Protocol and host: layer ids on messages (`xyChunk`, `colors`, `rows` …), a handler in both hosts.
  - [ ] Renderer: `Layer` model (A2): a list of point layers with their own attributes, blending and order; picking returns the layer and row.
  - [ ] UI: a layer list section (codicons `eye`, `eye-closed`; an opacity slider; drag to reorder), built with the shared controls.
  - [ ] Hover cards show the layer name; legend per layer; search and filters can target a layer.
  - [ ] Export: PNG (all visible layers); HTML viewer (layers as separate point sets); "New DataFrame from selection" includes the layer.
  - [ ] Tests: Python (transforms identical to base; placement of an overlay that equals base rows lands on the same positions); harness (overlay layer drawn, hidden, reordered: pixel assertions).

---

## 6. Undo / redo — A3 (M)

- **What:** `Cmd/Ctrl+Z` and `Shift+Cmd/Ctrl+Z` (rebindable commands, scoped to Atlas focus so the editor's undo is untouched) for: label drags, annotations (add, move, edit, delete), shapes, brush strokes, highlight changes, legend and histogram filters, selections.
- **Writes to the DataFrame** (tags, clusters, coordinates) are confirmed with a modal and are **not undoable** in Atlas. Say so in the confirmation, and offer "Undo" only where a write is reversible (for example, removing a tag column Atlas just added: decide in the spike).
- **To-do:**
  - [ ] `atlas/history.ts`: a command stack with typed entries (do / undo closures over plain data), coalescing for drags, and a size limit.
  - [ ] Hook every editing function; persist nothing (session only), or optionally the last N entries.
  - [ ] Toolbar buttons (codicons `discard`, `redo`) in the Annotate tab; commands and keybindings via A1.
  - [ ] Tests: unit tests for the stack; harness for drag → undo → redo on a label and an annotation (pixel or state + screenshot).

---

## 7. Brush tagging — B4 (M)

- **What:** an Annotate tool **Brush** (codicon `paintcan`).
  - **Painting:** drag over points to assign the current class. Choose or type the class; colours come from the palette.
  - **Eraser:** with Alt.
  - **Brush size:** a slider, `[` and `]` keys.
  - **Fill:** click a cluster or category to assign it all.
- **Where it goes:** a pending tag layer, shown live, then **Write to DataFrame** (confirm modal, as tags today) into a string column. Undoable until written (item 6).
- **Scope check:** this is tagging rows, not painting pixels, so it stays on the Atlas side.
- **To-do:**
  - [ ] Input mode in A1's dispatcher; a screen-space brush with the hit index (2D) or projected points (3D).
  - [ ] Pending-tag state with codes per row (u16), rendered as a colour overlay; legend of classes.
  - [ ] Write back through the existing `write_labels` path.
  - [ ] Help texts; cheat-sheet entries.
  - [ ] Harness: brush a region, assert codes and pixels, undo, write.

---

## 8. Shapes on the map — B4 (M–L)

- **What:** an Annotate tool **Shapes** with rectangle, ellipse, polygon, freehand (lasso), line, arrow and text.
  - **Editing** (after napari's Shapes layer, verified): select, move, resize (Shift keeps the aspect ratio), rotate, edit vertices, front/back order, copy and paste, delete.
  - **Style:** stroke and fill colour, width, opacity, dash, arrowhead; text font through the FontPicker.
  - **Placement:** shapes live in map coordinates (they move with zoom and pan, unlike callouts, which use screen offsets).
  - **Shape → tag:** points inside a closed shape can be tagged in one step.
- **To-do:**
  - [ ] Shape model (`atlas/shapes.ts`), persistence in the panel state, JSON export and import with annotations.
  - [ ] Rendering: deck.gl `PolygonLayer` / `PathLayer` / `TextLayer`, and SVG handles for editing.
  - [ ] Input mode and editing interactions (A1), undo (A3).
  - [ ] Point-in-shape (reuse `pointsInPolygon`; ellipses and rectangles as polygons) → tag.
  - [ ] PNG export and HTML viewer render shapes.
  - [ ] Harness: draw, edit, tag-inside; pixel assertions.

---

## 9. Marker symbols — B3 (S–M)

- **What:** Explore → **Symbol by** a categorical column (≤ 8 categories): circle, square, triangle, diamond, cross, star … with a symbol legend. Per layer (item 5): a fixed symbol for an overlay layer.
- **To-do:**
  - [ ] SDF symbol atlas or deck.gl `IconLayer` with symbol codes (binary attribute); keep `ScatterplotLayer` for the circle-only fast path.
  - [ ] Legend for symbols; hover card mentions the symbol category; PNG and HTML export.
  - [ ] Harness: pixel check that two categories render different shapes.

---

## 10. Time slider and video export — C2 (M)

- **What** (a row filter, Q6):
  - Explore → **Animate by** a date or number column. A slider with a window (for example 1 year), play/pause, speed and loop. Rows outside the window fade or hide (`DataFilterExtension`, combined with the other filters). Labels update when the window settles.
  - **Export video:** WebM of the time animation, a 3D turntable, or UMAP converging (from the worker's frames), via `MediaRecorder` (Q7), with resolution and fps options.
- **To-do:**
  - [ ] Time filter attribute (f32), window logic, playback loop on `requestAnimationFrame`.
  - [ ] UI with the shared controls; help texts; keyboard (Space play/pause while focused, rebindable).
  - [ ] Recorder (canvas stream plus the overlays composited per frame, reusing the PNG compositing), and a save dialog in the host.
  - [ ] Harness: step the slider and assert drawn pixels change; record 1 s and check the file is a valid WebM (size, header).

---

## 11. Tracks and vectors between rows — C2 (M)

- **Tracks:** Explore → **Connect rows by** an ID column, ordered by a time column. Lines through each ID's points (`PathLayer`), coloured by ID or by time, with an optional fading tail; works in 2D and 3D. Example: the same patient across visits, a compound series over time.
- **Vectors:** **Compare with a layout**:
  - arrows from each row's position to its position in a second layout (an earlier run or another condition), or to an overlay layer's matching rows (item 5);
  - arrows can be thinned for large frames.
- **To-do:**
  - [ ] Group-by-ID ordering in the kernel (codes plus order), file output.
  - [ ] Path and arrow layers, thinning, colours; legend.
  - [ ] Harness: tracks drawn (pixels); vectors between two layouts.

---

## 12. Python API — S1 then C3 (L)

- **What** (from napari's `viewer.add_points`, which is verified as the pattern):

  ```python
  import positron_atlas as atlas      # thin module provided by the kernel helper
  m = atlas.open(df)                  # opens a tab, returns a handle
  m.color_by("phase"); m.label_by("clusters"); m.dims = 3
  m.selection                         # current lasso selection → DataFrame (or row index)
  m.on_select(lambda rows: ...)       # callback when the selection changes
  m.annotate(row=123, text="Imatinib")
  m.add_layer(new_compounds)          # item 5
  m.save_png("map.png"); m.save_html("map.html")
  ```

- **Design:** the kernel helper exposes an importable module only on request: `atlas.open` registers it in `sys.modules`, explicit only. Commands flow kernel → host through a queue drained while polling (Q5), or a comm if S1 says it's possible. Events flow back the same way.
- **To-do:**
  - [ ] Spike S1 (comms).
  - [ ] Command queue and handle object in the kernel helper; host drains and forwards; webview applies through the same functions the UI uses.
  - [ ] Selection events → kernel (`m.selection` updated), callbacks run when the kernel is idle.
  - [ ] Docs (README section), examples in a notebook, and the scope check (no image viewing).
  - [ ] Tests: Python unit tests for the queue; harness end-to-end (Python call → map changes; lasso → `m.selection`).

---

## 13. Small conveniences — any wave (S each)

- [ ] **Atlas: Open example**: a quick pick of the example datasets (MNIST, HIGGS, ChEMBL sample, UniProt human, trials sample). It downloads and caches like the notebooks, creates a DataFrame in the session, and opens it.
- [ ] **Open selection in the Data Explorer**: after "New DataFrame from selection", open it in Positron's Data Explorer (check which command or API Positron offers).
- [ ] **3D view options:**
  - perspective or orthographic (`OrbitView` `fovy` vs orthographic; Blender's numpad 5 analogue, verified);
  - depth fade (fog);
  - point shading as spheres (optional).

---

## Testing and risks

- **Testing:** as in `roadmap-plan.md`:
  - unit tests for logic;
  - harness scenarios with pixel assertions and screenshots in three themes;
  - Positron e2e for keybindings, focus context, settings and Data Explorer integration.
- **Risks:**
  - **Keybindings inside webviews.** Key forwarding and `when` contexts may behave differently in Positron (S1 first).
  - **Middle-button orbit and emulation** need custom controller code in deck.gl.
  - **Trackpad detection** is heuristic; keep it behind the explicit `scrollGesture` setting.
  - **More layers and panels** multiply GPU memory; measure at 1M points.
  - **Name accuracy.** Don't name presets after products until their bindings are verified (Q8).
  - **Scope.** Keep the time slider and shapes framed as row features; review with your colleague if anything moves toward image viewing.
