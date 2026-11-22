# Contributing to Positron Atlas

How the code is organised, and the rules that keep it fast and easy to maintain. Start with
[`docs/architecture.html`](docs/architecture.html) (`just architecture`): it explains the three
processes, the data flow, and where every piece lives.

## Layout of the code

| Area | Where | Notes |
|---|---|---|
| Extension host (Node) | `src/extension/` | `atlasPanel.ts` routes messages between the webview and the kernel; `kernelBridge.ts` calls the kernel helper through `positron.runtime.evaluateCode`. |
| Messages | `src/shared/protocol.ts` | Every message between webview and host. Typed; arrays travel as `Uint8Array`. |
| Webview state | `src/webview/atlas.svelte.ts` | **State fields and one-line delegations only.** The logic lives in `src/webview/atlas/*.ts`, one module per area (hover, colors, labels, clusters, selection, projection, umap, annotations, …). Keep `atlas.svelte.ts` small. |
| Rendering | `src/webview/render/` | deck.gl renderer (2D and 3D), hit index, PNG compositing. |
| UI | `src/webview/components/` | Svelte 5 components. Use the shared controls in `components/controls/` (Checkbox, Select, NumberInput, Slider, Info, FontPicker) — never raw inputs. |
| Help texts | `src/webview/help.ts` | Every setting has an `<Info id>` and an entry here; `test/help.test.ts` checks both directions. |
| Kernel helper | `python/positron_atlas_kernel.py` | Loaded by path into the user's session; **only numpy is required** (pandas, polars, narwhals, the Rust core and UMAP engines are optional). Heavy work runs in job threads. |
| Rust core | `rust/` | Optional speed-up for placement and standardization (`npm run build:native`). The helper checks the functions it needs (`_NATIVE_FUNCTIONS`) and falls back to numpy otherwise. |
| HTML viewer | `src/viewer/` | The stand-alone viewer inlined into HTML exports. |
| Browser harness | `test/harness/` | Runs the real webview and kernel helper in Chromium without Positron. `host.js` is a hand-written copy of the extension host's message handling. |

## Rules

- **Look like Positron.** Positron theme tokens first, VS Code tokens as fallback (`var(--vscode-positron…, var(--vscode-…))`), codicons for icons. Check dark, light and high-contrast themes (`--theme dark|light|hc` in the harness).
- **Settings and shortcuts are native.** Settings are `contributes.configuration` entries (enums with descriptions); keyboard shortcuts are contributed commands with `when` clauses, so users change them in Positron's Settings and Keyboard Shortcuts editors.
- **Both hosts handle every message.** Each `ToHost` message type needs a `case` in `src/extension/atlasPanel.ts` and in `test/harness/host.js` (`test/host-coverage.test.ts`).
- **Ship what you load.** Any file the extension host reads from its install folder must be included by `.vscodeignore` (`test/packaging.test.ts`).
- **Bulk data never goes through JSON.** The kernel writes little-endian binary files into the job directory and the webview fetches them; arrays to the host are bytes.
- **Fast paths stay fast.** Measure before and after changes on large frames (`python/bench*.py`, harness `test:harness:big`); record results in `docs/benchmarks.md`.
- **Tests come with the change.** Unit tests (vitest, pytest, cargo) for logic; harness scenarios for features, which **assert on what is drawn** (pixels via `a.renderer.toDataURL`, or screenshot analysis), not only on state; look at the screenshots.
- **Keep the docs current.** Update `docs/architecture.html` when processes, messages, files or dependencies change, and the README for user-visible features.
- **Scope.** Atlas shows *what is similar to what* (rows and their layout). Image and nD-array viewing belongs to other tools.

## Checks before every commit

```sh
npm run check        # TypeScript + svelte-check: 0 errors, 0 warnings
npm test             # vitest
npm run test:py      # pytest (build the Rust core first: npm run build:native)
npm run build
npm run test:harness           # all harness scenarios
npm run test:harness:mnist     # MNIST scenarios (download once)
```

Use real `node_modules` and `native/` folders (`npm ci`, `npm run build:native`) — never symlinks.

## Commits

Small, focused commits with a clear message (what and why). No co-author or attribution trailers.
