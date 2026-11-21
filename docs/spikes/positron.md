# Positron spike results

Measured in real Positron (Positron 2026-11, macOS arm64) via the CDP-based e2e harness
(`test/e2e/run.mjs`). Each scenario exercises the live panel from outside the browser;
no mocking. Run date: 2026-11-21.

---

## H1 — Hover latency

**Question:** What is the end-to-end latency for a hover request today, and does it
require a side channel (D2)?

**Setup:** 300 k × 50 float32 frame; 50 random rows probed one by one via
`evaluateCode`; full RTT measured from request dispatch to reply arrival in the webview.

| Metric | Value |
|---|---|
| RTT median | 6 ms |
| RTT p95 | 9 ms |
| `evaluateCode` median | 3 ms |
| `evaluateCode` p95 | 4 ms |
| Frame size | 300 k rows |

The existing 120 ms pointer-move debounce dominates perceived latency; the kernel round
trip itself is 6 ms median. **No side channel is needed** to reach the sub-100 ms feel
target — removing or lowering the debounce (H2) will get there.

---

## F1 — Fullscreen

**Question:** Does `requestFullscreen()` work inside a Positron webview panel?

```
requestResult : "rejected"
error         : "Disallowed by permissions policy"
fullscreenEnabled : false
```

The Fullscreen API is blocked by the webview's permissions policy. The design that calls
`workbench.action.maximizeEditorHideSidebar` via VS Code API (and mirrors that with a
`ToHost` message) is the correct approach. The webview never calls `requestFullscreen`.

---

## P4 — Binary postMessage

**Question:** Do `ArrayBuffer`s pass through `postMessage` in Positron's webview?
How does binary compare to base64?

**Result:** `isBuffer: true` — ArrayBuffers are transferred intact.

| Transfer | Size | Latency |
|---|---|---|
| Binary (ArrayBuffer) | 1 MB | 2.2 ms RTT |
| Binary (ArrayBuffer) | 30 MB | 68 ms RTT |
| Base64 encode only | per MB | 3.2 ms/MB |
| Base64 decode only | per MB | 0.6 ms/MB |

Encoding 30 MB to base64 costs 96 ms before the transfer even starts; the binary round
trip for the same payload is 68 ms total. Binary is faster and simpler. Use `ArrayBuffer`
transfers for the anchor layout, masks and codes; keep base64 as a fallback behind a
capability flag for environments that report `isBuffer: false`.

---

## N1 — Theme variables

**Question:** Which `--vscode-*` CSS tokens arrive in our panel? Do any encode heights?

**Setup:** `getComputedStyle(document.documentElement)` on the dark theme in a live
Positron panel.

| Metric | Value |
|---|---|
| Total `--vscode-*` vars | 1 090 |
| `--vscode-positron*` vars | 152 |
| Height / size positron vars | 0 |

Representative positron tokens (first five of 152):

```
--vscode-positronDataGrid-foreground
--vscode-positronActionBar-textInputBorder
--vscode-positronConsole-ansiWhite
--vscode-positronModalDialog-buttonDisabledForeground
--vscode-positronRuntime-stateIconIdle
```

All 152 `--vscode-positron*` tokens are readable from inside the webview via
`getComputedStyle`. None of them encode heights or sizes, so shell-chrome heights must be
read by another means (VS Code layout API or hard-coded constants). Theme colours for the
data grid, action bar, console, tooltips, and dialogs are all present — N2 (harness theme
dump) can be automated against these values.

---

## T1 — 3D UMAP in Positron

**Question:** Does `createUMAP(n, d, outputDim=3, …)` work in Positron's WebGPU path?
How does 3D timing compare to 2D?

**Setup:** 10 k × 50 float32 frame; `outputDim` injected via `postMessage` intercept so
the same Atlas UMAP flow handles worker lifecycle correctly (the WASM module is
single-use per worker; creating a fresh worker resets compilation cost).

| Config | n | Time |
|---|---|---|
| 2D, GPU | 10 k | 0.59 s |
| 3D, GPU | 10 k | 0.59 s |
| 2D, CPU | 10 k | 7.74 s |
| 3D, CPU | 10 k | 7.78 s |

`outputDim = 3` works in Positron with both the WebGPU and CPU paths; output is finite.
**3D adds no measurable overhead** over 2D — the SGD kernel cost is dominated by the
neighbour-graph size, not the embedding dimension. The GPU path is ~13× faster than CPU
for this size.

The earlier timeout in the initial spike attempt was caused by posting to an
already-exhausted WASM worker instance, not by any 3D limitation. Each `a.startUmap()`
call creates a fresh worker; the test harness must hook the `postMessage` on that fresh
worker rather than the previous one.

**Conclusion for T2–T6:** 3D UMAP is feasible in Positron. The main implementation work
is in the renderer (T3) and interaction (T4), not the UMAP computation.
