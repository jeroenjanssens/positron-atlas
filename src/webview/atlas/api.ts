/**
 * Python API command handler (C3).
 *
 * Receives ``apiCommand`` messages from the host (which routes incoming comm
 * messages from the Python kernel), applies each command through the same
 * functions the UI uses, and replies with ``apiReply``.
 *
 * Also exports ``notifySelectionChanged``, called by ``setSelection`` after
 * every selection change to push the new mask to the host via comm.
 */

import type { Atlas } from '../atlas.svelte';
import { vscode } from '../vscode';
import {
  setColorColumn as setColorColumnImpl,
} from './colors';
import {
  setLabelColumn as setLabelColumnImpl,
} from './labels';
import {
  addAnnotation,
} from './annotations';
import { packBits } from '../select/lasso';

/**
 * Commands run one at a time, in the order Python sent them, each once the map has
 * settled: the layout is done (all rows placed) and the colours of the current colour
 * column have arrived. `atlas.open(df); m.color_by(...); m.save_png(...)` in one cell
 * sends all three before the map exists; without this the PNG would be blank.
 */
const queues = new WeakMap<Atlas, Promise<void>>();
const SETTLE_TIMEOUT_MS = 120_000;

export function isSettled(atlas: Atlas): boolean {
  const p = atlas.prepared;
  return (
    atlas.phase === 'ready' &&
    !!p &&
    (!p.needsProjection || atlas.projection === 'done') &&
    (atlas.colorColumn === null || atlas.colorMeta !== null)
  );
}

async function waitSettled(atlas: Atlas): Promise<boolean> {
  const t0 = Date.now();
  while (!isSettled(atlas)) {
    if (atlas.phase === 'error' || Date.now() - t0 > SETTLE_TIMEOUT_MS) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  // Not requestAnimationFrame: it never fires while the tab is hidden. The PNG export
  // redraws explicitly, so the settled state only needs its messages handled.
  await new Promise((r) => setTimeout(r, 0));
  return true;
}

/** Queue one ``apiCommand`` from the host (see above). */
export function enqueueApiCommand(atlas: Atlas, commandId: string, name: string, args: Record<string, unknown>): void {
  const sentAt = Number(args['_sentAt']);
  if (Number.isFinite(sentAt)) atlas.apiLatencyMs = Date.now() - sentAt;
  const prev = queues.get(atlas) ?? Promise.resolve();
  const next = prev.then(async () => {
    if (!(await waitSettled(atlas))) {
      reply(commandId, false, `${name}: the map did not finish loading`);
      return;
    }
    await onApiCommand(atlas, commandId, name, args);
  });
  queues.set(atlas, next.catch(() => undefined));
}

/** A column from `columnName` (or `column`, an index); an error message if there is none. */
export function resolveColumn(atlas: Atlas, args: Record<string, unknown>): number | string {
  const cols = atlas.describe?.columns ?? [];
  if (typeof args['columnName'] === 'string') {
    const name = args['columnName'];
    const c = cols.find((x) => x.name === name);
    return c ? c.index : `no column named ${JSON.stringify(name)} (columns: ${cols.map((x) => x.name).join(', ')})`;
  }
  const i = Number(args['column']);
  return cols.some((x) => x.index === i) ? i : `no column with index ${String(args['column'])}`;
}

/** Handle one ``apiCommand`` message from the host. */
export async function onApiCommand(
  atlas: Atlas,
  commandId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  try {
    switch (name) {
      case 'colorBy': {
        const col = resolveColumn(atlas, args);
        if (typeof col === 'string') {
          reply(commandId, false, `colorBy: ${col}`);
          return;
        }
        setColorColumnImpl(atlas, col);
        reply(commandId, true);
        break;
      }

      case 'labelBy': {
        const col = resolveColumn(atlas, args);
        if (typeof col === 'string') {
          reply(commandId, false, `labelBy: ${col}`);
          return;
        }
        setLabelColumnImpl(atlas, col);
        reply(commandId, true);
        break;
      }

      case 'setDims': {
        const dims = Number(args['dims']);
        if (dims !== 2 && dims !== 3) {
          reply(commandId, false, `setDims: dims must be 2 or 3, got ${dims}`);
          return;
        }
        atlas.setDims(dims as 2 | 3);
        reply(commandId, true);
        break;
      }

      case 'annotate': {
        const row = Number(args['row']);
        const text = String(args['text'] ?? '');
        if (!atlas.prepared || (!atlas.allXY && !atlas.anchorXY)) {
          reply(commandId, false, 'annotate: map not ready (run UMAP first)');
          return;
        }
        // Find the prepared index for this original row via kept_idx mapping.
        let prepIdx = findPrepIdx(atlas, row);
        if (prepIdx < 0) {
          reply(commandId, false, `annotate: row ${row} not in the prepared set (was it sampled out?)`);
          return;
        }
        const xy = atlas.allXY ?? atlas.anchorXY;
        if (!xy) {
          reply(commandId, false, 'annotate: no XY positions available');
          return;
        }
        const wx = xy[2 * prepIdx];
        const wy = xy[2 * prepIdx + 1];
        addAnnotation(atlas, prepIdx, row, wx, wy, text);
        reply(commandId, true);
        break;
      }

      case 'savePng': {
        if (!atlas.renderer) {
          reply(commandId, false, 'savePng: renderer not ready');
          return;
        }
        const { plotBackground } = await import('./render');
        const bytes = await atlas.renderer.toPngBytesWithOverlay(plotBackground(atlas), {
          titleOverlay: atlas.titleOverlay,
          annotations: atlas.annotations,
          leaderStyle: atlas.labels.leaderStyle,
          leaderColor: atlas.labels.leaderColor,
          leaderWidth: atlas.labels.leaderWidth,
          labelFontFamily: atlas.labels.fontFamily || undefined,
        });
        replyWithBytes(commandId, bytes);
        break;
      }

      case 'saveHtml': {
        // Trigger the existing multi-step HTML export (exportHtml → exportHtmlAssembly
        // → exportHtmlReady). The host intercepts exportHtmlReady and writes to the
        // path, then replies via comm.  Do NOT post apiReply here — the host does it.
        if (!atlas.prepared) {
          reply(commandId, false, 'saveHtml: map not ready (run UMAP first)');
          return;
        }
        const cols = (atlas.describe?.columns ?? []).map((c) => c.index);
        atlas.exportHtml({
          tooltipColumns: cols,
          linkColumn: atlas.tooltipOpts?.linkColumn ?? -1,
          maxChars: 500,
          embedImages: false,
          samplePct: 100,
        });
        // The host will call reply when the HTML file is written.
        break;
      }

      case 'close': {
        // Reply immediately so the Python close() doesn't hang.
        reply(commandId, true);
        vscode.post({ type: 'reload' } as any);
        break;
      }

      default:
        reply(commandId, false, `Unknown API command: ${name}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reply(commandId, false, msg);
  }
}

function reply(commandId: string, ok: boolean, error?: string): void {
  vscode.post({ type: 'apiReply', commandId, ok, error } as any);
}

function replyWithBytes(commandId: string, bytes: Uint8Array): void {
  vscode.post({ type: 'apiReply', commandId, ok: true, bytes } as any);
}

/**
 * Find the prepared-row index for an original DataFrame row number.
 *
 * Returns -1 if the row is not found.
 */
function findPrepIdx(atlas: Atlas, originalRow: number): number {
  if (atlas.anchorPos) {
    for (let i = 0; i < atlas.anchorPos.length; i++) {
      if (atlas.anchorPos[i] === originalRow) return i;
    }
  }
  // Fallback: when no projection is needed (all rows are anchors), use direct index.
  if (!atlas.prepared?.needsProjection && originalRow < (atlas.nKept ?? 0)) {
    return originalRow;
  }
  return -1;
}

/**
 * Build a packed selection mask from the current atlas selection and post
 * a ``selectionChanged`` message to the host.
 *
 * Called by ``setSelection`` in ``selection.ts`` after every selection change.
 * In Positron this triggers a comm message to the Python handle (C3).
 */
export function notifySelectionChanged(atlas: Atlas): void {
  const mask = atlas.selection ? packBits(atlas.selection) : null;
  vscode.post({ type: 'selectionChanged', mask, nKept: atlas.nKept ?? 0 } as any);
}
