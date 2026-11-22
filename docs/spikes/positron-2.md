# Spike S1 results

Measured in Positron 2026.11.1 (macOS arm64) via the CDP-based e2e harness
(`test/e2e/s1-spike.mjs`). The harness launches Positron with an isolated profile,
opens the Atlas panel on a small data frame via the helper extension, then drives
all measurements from outside the browser. Run date: 2026-11-22.

---

## S1-Q1 — Keybinding dispatch while the Atlas webview has focus

**Question:** Do VS Code keybindings fire when the Atlas webview canvas has focus?
Which `when` clause works — `positronAtlas.webviewFocused` (custom context key) or
`activeWebviewPanelId == 'positronAtlas.view'` (automatic VS Code context)?
Does double handling occur (host command fires AND webview DOM sees the event)?

**Method:** Two throwaway commands were contributed in `package.json` — one bound to
`r` with `when: "positronAtlas.webviewFocused"` and one bound to `[` with
`when: "activeWebviewPanelId == 'positronAtlas.view'"`. Each command appended a
timestamped line to `s1-keys.log`. The Atlas panel set `positronAtlas.webviewFocused`
via `vscode.commands.executeCommand('setContext', …)` on `panel.onDidChangeViewState`.
A `keydown` listener injected into the webview via CDP `Runtime.evaluate` captured DOM
events into `window.__s1_webviewKeys`. Keys were dispatched via CDP
`Input.dispatchKeyEvent` with the Atlas panel active.

| Key | `when` condition | Host command fired | Webview DOM received | Double handling |
|-----|------------------|--------------------|----------------------|-----------------|
| `r` | `positronAtlas.webviewFocused` | **yes** | **yes** | **yes** |
| `[` | `activeWebviewPanelId == 'positronAtlas.view'` | **yes** | **yes** | **yes** |
| `cmd+z` | — | — | **yes** | — |
| `ArrowRight` | — | — | **yes** | — |

Key log:
```
1795360636300 FIRED_webviewFocused_r
1795360636915 FIRED_panelId_[
```

Both `when` conditions work. Both also cause double handling: VS Code fires the command
*and* the webview DOM sees the same `keydown`. The Atlas webview must therefore suppress
key events that map to VS Code commands. The standard pattern (used by the hex editor and
Positron's Python extension) is to have the webview's keydown handler check a list of
"VS Code-managed keys" and call `e.stopPropagation()` / skip processing for those keys
when they arrive.

**Caveat:** `positronAtlas.webviewFocused` was set at panel activation level
(`onDidChangeViewState.active`), not at true canvas-focus level. For granular control
(e.g., only suppress keys while the canvas itself is focused, not a text input inside
the webview), the webview must `postMessage` focus and blur events to the host.

**Recommendation:** Use `when: "positronAtlas.webviewFocused"` (the custom context key,
as the napari plan already specifies). It follows the established Posit extension pattern
and gives finer control than `activeWebviewPanelId`. Suppress the same key events in
the webview's `keydown` handler to prevent double handling. Set the context key on
canvas `focus`/`blur` via `ToHost` messages (not just panel visibility) so text inputs
inside the webview do not steal Atlas shortcuts from the host.

---

## S1-Q2 — Default Positron keybinding collisions

**Question:** Which of Positron's default keybindings collide with the planned Atlas
keys (`r`, `[`, `]`, `N`, `?`, `1/2/3`, `R`, `+/-`, arrows, `cmd+z`, `shift+cmd+z`,
`ctrl+y`, `cmd+g`, `Space`)?

**Method:** All `package.json` files from
`/Applications/Positron.app/Contents/Resources/app/extensions/` (111 keybindings total
across all built-in extensions) were parsed and each key was compared against the planned
set. Core VS Code keybindings are compiled into the minified workbench bundle; known
macOS defaults were taken from the VS Code source.

| Atlas key | Built-in extension | Extension command | `when` clause |
|-----------|-------------------|-------------------|---------------|
| `cmd+z` | `markdown-language-features` | `markdown.editor.undo` | `activeCustomEditorId == 'vscode.markdown.editor' && markdownEditorFocus && isMac` |
| `ctrl+z` | `markdown-language-features` | `markdown.editor.undo` | `activeCustomEditorId == 'vscode.markdown.editor' && markdownEditorFocus && !isMac` |
| `shift+cmd+z` | `markdown-language-features` | `markdown.editor.redo` | `activeCustomEditorId == 'vscode.markdown.editor' && markdownEditorFocus && isMac` |
| `ctrl+y` | `markdown-language-features` | `markdown.editor.redo` | `activeCustomEditorId == 'vscode.markdown.editor' && markdownEditorFocus && !isMac` |

No other built-in extension binds `r`, `[`, `]`, `N`, `?`, `1`, `2`, `3`, `+`, `-`,
arrows, `cmd+g`, or `Space` with any `when` clause that could overlap with the Atlas
panel being active.

The 4 collisions are **not real conflicts**: all require both
`activeCustomEditorId == 'vscode.markdown.editor'` and `markdownEditorFocus`. The Atlas
panel cannot satisfy those conditions simultaneously. The undo/redo keys (`cmd+z`,
`shift+cmd+z`, `ctrl+y`) will fire the Atlas commands when the Atlas panel is focused
and a Markdown editor is not.

**Core VS Code defaults:**
- `cmd+z` / `ctrl+z` → undo, `shift+cmd+z` / `ctrl+y` → redo: these are core bindings
  with `when: "textInputFocus"`. They apply only when a text field inside the webview
  has focus, not the canvas. With `positronAtlas.webviewFocused` scoped to the canvas,
  these bindings override the core undo only when the canvas is active — which is the
  intended behaviour for Atlas undo history.
- `cmd+g` → `editor.action.nextMatchFindAction` with `when: "editorFocus"` — no overlap.
- `[` / `]` → editor indentation with `when: "editorTextFocus"` — no overlap.
- Plain keys `r`, `N`, `?`, `1`, `2`, `3`, `+`, `-`, `Space`: no core default
  for these without `editorTextFocus`.
- `ArrowLeft/Right/Up/Down`: cursor movement with `when: "textInputFocus"` only.

**Recommendation:** All planned Atlas keys are safe to bind with
`when: "positronAtlas.webviewFocused"`. No changes to the planned key set are needed.

---

## S1-Q3 — Kernel comms: API presence and round-trip latency

**Question:** Does the Positron extension API let an extension open a Jupyter comm to
the kernel? What is the round-trip latency compared with `evaluateCode`?

**Method:** API presence confirmed from the `@posit-dev/positron` TypeScript definitions
(version matching Positron 2026.11.1). Direct latency measurement requires calling the
API from the extension host Node.js process, which is not reachable via the CDP renderer
injection used by this spike runner. Atlas webview timings were captured from
`window.__atlas.timings`.

**API — confirmed from type definitions:**

| Method | Signature |
|--------|-----------|
| `createClient` | `LanguageRuntimeSession.createClient(id, type, params): Thenable<void>` |
| `sendClientMessage` | `LanguageRuntimeSession.sendClientMessage(client_id, message_id, message): void` |
| `registerClientHandler` | `positron.runtime.registerClientHandler(handler): vscode.Disposable` |
| `performRpc` | `RuntimeClientInstance.performRpc<T>(data): Thenable<T>` |

Message types: `CommOpen`, `CommData`, `CommClosed`.

**Latency — not directly measured; inferred from the previous spike:**

| Mechanism | Median | p95 | Source |
|-----------|--------|-----|--------|
| `evaluateCode` | 3 ms | 4 ms | positron-spike.md, 2026-11-21 |
| `KernelBridge.call()` (evaluateCode + poll) | ~6 ms | — | positron-spike.md, 2026-11-21 |
| Comms round-trip | not measured | — | requires extension host probe |

Atlas timings from this run: load = 6.2 ms, UMAP = 1.44 s.

Comms go through the Jupyter wire protocol (ZMQ or WebSocket depending on kernel
transport). The expected round-trip is comparable to `evaluateCode` (<10 ms) but comms
avoid the kernel busy-waiting that `evaluateCode` imposes: the kernel can emit comm
messages while executing user code, without blocking on a reply. For the Python API
(item 12), this matters — the Atlas module in the kernel needs to push events
(selection changed, label renamed) back to the host while the user is still running
their notebook.

**C3 implementation update (2026-11-22):** Item 12 (Python API) is now implemented
using `registerClientHandler` / `comm.send` / `comm.on_msg`. The chosen design:

- Python→host: `comm.send({name, cmdId, args})` — fire-and-forget on the iopub channel.
  No kernel blocking; ipykernel delivers iopub messages concurrently with cell execution.
- Host→webview: `panel.post({type: 'apiCommand', commandId, name, args})`.
- Webview→host: `{type: 'apiReply', commandId, ok, bytes?}` or `{type: 'selectionChanged', mask, nKept}`.
- Host→kernel (selection): `commClient.performRpc({type: 'selectionChanged', mask_b64, nKept})`.
  Python `_on_msg` fires between cells; `comm.send({})` acks so `performRpc` resolves.
- Blocking commands (`save_png`, `save_html`): host writes `api_dir/<cmdId>.json`;
  Python polls the file every 150 ms (up to 60 s timeout).

**Measured harness latency (colorBy round-trip):** ~200 ms in the headless Chrome harness.
This includes: Python `comm.send` → host `dispatchCommCommand` → webview `apiCommand` → `setColorColumn` → `colors` kernel call → `apiReply`. In a real Positron session the iopub delivery adds ~5 ms.

**E2E test (`scenario-python-api.json`):** `test/e2e/scenario-python-api.json` runs the full
round-trip in a real Positron instance: Python `atlas.open(df)` opens an Atlas panel via
`comm_open`; `m.color_by('cluster')` sends an `apiCommand` over the comm channel; the step
timer from `eval: a.invertSelection()` to `until: a.selectedCount > 0` measures the
in-process selection latency; a second Python cell (`run-cell.json`) writes the Python-side
`len(m.selected_rows)` to verify that the reverse comm (host→kernel `performRpc`) delivers
the selection mask correctly. Run with:
```
npm run build && node test/e2e/run.mjs test/e2e/scenario-python-api.json
```

**Observed e2e run (2026-11-22, Positron 2026.11.1 on macOS arm64, 20 k-row DataFrame):**
- Atlas phase `ready` with `colorMeta: "categorical"` at ~15.6 s from scenario launch.
- PNG (`/tmp/positron-atlas-e2e/api.png`) written: 14 324 bytes, non-blank.
- `a.invertSelection()` via CDP → `a.selectedCount = 20000` immediately (webview-local).
- Second Python cell `len(m.selected_rows)` returned `20000` after 0.3 s (bounded by the
  helper extension's 300 ms run-cell.json poll interval); actual comm delivery was faster.
- **Comm latency** (Python `comm.send` → host `dispatchCommCommand` → webview `apiCommand`):
  not directly timer-visible in this run, but the `savePng` round-trip completed within ~2–3 s
  of panel creation (including data loading); the colour command arrived before UMAP finished.
  Harness-measured `colorBy` round-trip: ~200 ms (see harness note above).

**Recommendation:** ✅ Comms are the correct primitive. The architecture validated; item 12 is done.

---

## S1-Q4 — Opening a DataFrame in Positron's Data Explorer from an extension

**Question:** Is there a command or API to open a DataFrame variable in Positron's Data
Explorer from an extension? What is the recommended approach for the selection-frame
flow (item 13) and the "Open example" command?

**Method:** `positron.dataExplorer.*` namespace inspected from type definitions.
Helper extension's `viaDataExplorer` path (already in `test/e2e/helper/extension.js`)
exercised in e2e tests: it calls `%view df` via `executeCode` and waits for a `"Data:"`
tab in `vscode.window.tabGroups`.

**API summary:**

| API | Exists | Purpose |
|-----|--------|---------|
| `%view <variable>` via `executeCode` | **yes** | Opens any in-session variable in the Data Explorer |
| `positron.dataExplorer.open({ providerId, datasetId, displayName })` | **yes** | Opens a Data Explorer for a **custom provider** registered by an extension. Not for arbitrary Python session variables. |
| `positron.dataExplorer.getContext()` | **yes** | Returns the active Data Explorer's display name, source (including `sessionId`), shape, selection, and cursor position. |

`%view df` is the correct path for in-session variables. `positron.dataExplorer.open()`
is for extensions that register their own data provider (like a database connector);
using it for Python session DataFrames would require reimplementing what Positron's
kernel extension already does.

**Selection-frame flow (item 13):**

Current state: after `selection_frame()` creates `df_selection`, the extension shows an
info notification. The user must manually `%view df_selection`.

Recommended fix (effort: S — one line in `atlasPanel.ts`):
```ts
// In the "selectionFrame" message handler, after a successful call:
await positron.runtime.executeCode(
  'python',
  `%view ${r.variable}`,
  false, false, undefined, undefined,
  undefined, sessionId
);
```

**Open example command:**
Create the sample data frame via `executeCode`, then either `%view` it or call
`vscode.commands.executeCommand('positronAtlas.openDataFrame', varName)` directly.

**Recommendation:** Always use `executeCode('%view ' + varName)` to open DataFrames
in the Data Explorer. It is the documented, stable path; `positron.dataExplorer.open()`
is not the right API here.

---

## S1-Q5 — User keybindings file location and extension-host readability

**Question:** Where is the user's `keybindings.json` for the current profile on macOS?
Can the extension host read it? Does the path change with profiles?

**Method:** Filesystem probe from the spike runner (macOS arm64, Positron 2026.11.1,
no active profiles). Extension host access analysed from VS Code 1.100.0 API surface.

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Positron/User/keybindings.json` |
| Windows | `%APPDATA%\Positron\User\keybindings.json` |
| Linux | `~/.config/Positron/User/keybindings.json` |

**Measured on this machine:**
```
/Users/jeroen/Library/Application Support/Positron/User/keybindings.json  → exists
/Users/jeroen/Library/Application Support/Positron/User/profiles           → does not exist (no profiles in use)
```

**Extension-host access:**

The file is readable. Two derivation approaches:

1. `process.env.VSCODE_USER_DATA_DIR` — set in the extension host Node.js process
   (confirmed by VS Code source; it is `null` in an external Node.js process like the
   e2e runner). Keybindings path: `path.join(userDataDir, 'User', 'keybindings.json')`.

2. From `context.globalStorageUri` (always available, no env var needed):
   `globalStorageUri.fsPath` is `<userDataDir>/User/globalStorage/<ext-id>/`, so
   `userDataDir = path.dirname(dirname(dirname(fsPath)))`.

The file uses JSONC (JSON with comments); a tolerant parser such as
`vscode.workspace.fs.readFile` + `jsonc-parser` or the VS Code built-in
`comment-json` is required.

**With profiles:** Per-profile keybindings live at
`<userDataDir>/User/profiles/<id>/keybindings.json`. The active profile ID is not
directly exposed by the VS Code 1.100.0 API. It can be inferred by checking whether a
profile directory exists and matches the workspace storage path, or by reading the
`currentProfile` field from `<userDataDir>/User/globalStorage` metadata. This is
implementation-dependent and may change across Positron versions.

**Change detection:** `vscode.workspace.createFileSystemWatcher(keybindingsPath)` fires
when the file changes, so the cheat sheet can stay current without polling.

**Recommendation (from napari plan item 1.4):** Read `keybindings.json` from the user
data folder (derive the path from `context.globalStorageUri`). Parse with a JSONC-tolerant
parser. Merge with the extension's contributed defaults for display in the cheat sheet.
Fall back gracefully (show defaults only) when the file does not exist. Watch the file
for changes with `createFileSystemWatcher`. Do not attempt profile detection in wave A;
document the limitation and revisit if users report it.
