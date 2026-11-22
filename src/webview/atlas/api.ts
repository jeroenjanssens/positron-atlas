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
        const col = Number(args['column']);
        if (!isFinite(col) || col < 0) {
          reply(commandId, false, `colorBy: invalid column index ${col}`);
          return;
        }
        setColorColumnImpl(atlas, col);
        reply(commandId, true);
        break;
      }

      case 'labelBy': {
        const col = Number(args['column']);
        if (!isFinite(col) || col < 0) {
          reply(commandId, false, `labelBy: invalid column index ${col}`);
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
