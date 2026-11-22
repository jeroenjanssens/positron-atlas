/**
 * Brush operations (plan item 7, wave B4).
 *
 * Business logic for the brush tool.  State lives in Atlas; this module only
 * provides the operations that mutate it.
 */

import type { Atlas } from '../atlas.svelte';
import { vscode, typedArrayToBytes } from '../vscode';
import { formatCount } from '../logic';
import {
  hitBrush,
  paintBrush,
  eraseBrush,
  fillBrushCluster,
  fillBrushCategory,
  buildBrushOverlayColors,
  brushWorldRadius,
  BRUSH_ERASER_CODE,
  BRUSH_PALETTE,
} from './brush';
import { recordHistory } from './undo';

/** Ensure the pending-codes buffer exists (allocate all-erased if not). */
function ensurePendingCodes(atlas: Atlas): Uint16Array {
  const n = atlas.prepared?.nKept ?? 0;
  if (!atlas.pendingBrushCodes || atlas.pendingBrushCodes.length !== n) {
    const buf = new Uint16Array(n).fill(BRUSH_ERASER_CODE);
    atlas.pendingBrushCodes = buf;
    return buf;
  }
  return atlas.pendingBrushCodes;
}

/**
 * Find kept-row indices from the XY array that are visible and cover the given
 * point set.  Returns the xy array and length used (all rows or anchors-only).
 */
function getActiveXY(atlas: Atlas): { xy: Float32Array; n: number } | null {
  if (!atlas.anchorXY || !atlas.prepared) return null;
  // When all rows are shown, use allXY; otherwise fall back to anchors.
  if (atlas.allXY && atlas.placedRows > 0) {
    return { xy: atlas.allXY.subarray(0, atlas.placedRows * 2), n: atlas.placedRows };
  }
  return { xy: atlas.anchorXY, n: atlas.prepared.nAnchors };
}

/**
 * Apply a brush stroke at world coordinates (cx, cy).
 * Updates `pendingBrushCodes` and rebuilds the overlay render.
 */
export function applyBrushStroke(atlas: Atlas, cx: number, cy: number): void {
  if (!atlas.renderer || !atlas.prepared) return;
  const active = getActiveXY(atlas);
  if (!active) return;

  const wpp = atlas.renderer.worldPerPixel();
  const radius = brushWorldRadius(atlas.brush.sizePx, wpp);

  const hits = hitBrush(active.xy, active.n, cx, cy, radius);
  if (!hits.length) return;

  const before = ensurePendingCodes(atlas).slice();
  let after: Uint16Array;
  if (atlas.brush.erasing) {
    after = eraseBrush(atlas.pendingBrushCodes!, hits);
  } else {
    after = paintBrush(atlas.pendingBrushCodes!, hits, atlas.brush.currentClass);
  }

  // Record undo entry.
  recordHistory(atlas, {
    label: atlas.brush.erasing ? 'Brush erase' : `Brush paint "${atlas.brush.classes[atlas.brush.currentClass] ?? ''}"`,
    undo: () => {
      atlas.pendingBrushCodes = before;
      refreshBrushOverlay(atlas);
    },
    redo: () => {
      atlas.pendingBrushCodes = after;
      refreshBrushOverlay(atlas);
    },
    coalesceKey: 'brush:stroke',
  });

  atlas.pendingBrushCodes = after;
  refreshBrushOverlay(atlas);
}

/**
 * Fill all points that share a cluster or category code with the row at `prepIdx`.
 */
export function fillBrushAtPoint(atlas: Atlas, prepIdx: number): void {
  if (!atlas.prepared) return;

  const before = ensurePendingCodes(atlas).slice();
  const classIdx = atlas.brush.currentClass;

  let after: Uint16Array | null = null;

  // Try cluster fill first.
  if (atlas.cluster) {
    const codes = atlas.cluster.codes;
    if (prepIdx < codes.length) {
      const targetCode = codes[prepIdx];
      after = fillBrushCluster(atlas.pendingBrushCodes!, codes, targetCode, classIdx);
    }
  }
  // If no cluster, try category fill.
  if (!after && atlas.colorValues instanceof Uint16Array) {
    const catIdx = atlas.colorValues[prepIdx];
    after = fillBrushCategory(atlas.pendingBrushCodes!, atlas.colorValues, catIdx, classIdx);
  }

  if (!after) return;

  recordHistory(atlas, {
    label: `Brush fill "${atlas.brush.classes[classIdx] ?? ''}"`,
    undo: () => { atlas.pendingBrushCodes = before; refreshBrushOverlay(atlas); },
    redo: () => { atlas.pendingBrushCodes = after!; refreshBrushOverlay(atlas); },
  });

  atlas.pendingBrushCodes = after;
  refreshBrushOverlay(atlas);
}

/** Rebuild the brush overlay ScatterplotLayer colours and trigger a render. */
export function refreshBrushOverlay(atlas: Atlas): void {
  if (!atlas.renderer || !atlas.pendingBrushCodes || !atlas.anchorXY || !atlas.prepared) return;
  const n = atlas.prepared.nAnchors;
  const palette = BRUSH_PALETTE;
  const rgba = buildBrushOverlayColors(atlas.pendingBrushCodes, n, palette);
  atlas.renderer.setBrushOverlay(rgba, n, atlas.anchorXY, atlas.dims);
}

/**
 * Write pending brush codes to the DataFrame via the existing `writeLabels` path.
 * Shows the confirm modal (handled by the host).
 */
export function commitBrush(atlas: Atlas, column: string): void {
  if (!atlas.pendingBrushCodes || !atlas.prepared) return;
  const names = atlas.brush.classes.slice();
  // Filter to rows that actually have a pending class (not 65535).
  let count = 0;
  for (let i = 0; i < atlas.pendingBrushCodes.length; i++) {
    if (atlas.pendingBrushCodes[i] !== BRUSH_ERASER_CODE) count++;
  }
  if (!count) {
    atlas.flash('No pending brush tags to write.');
    return;
  }
  const codes = atlas.pendingBrushCodes.slice();
  vscode.post({
    type: 'writeLabels',
    codes: typedArrayToBytes(codes),
    names,
    column: column.trim() || 'brush_tag',
    keepOthers: true,
    description: `Write brush tags (${formatCount(count)} rows tagged) to column "${column}"`,
  });
}

/** Discard all pending brush codes (without writing). Undoable. */
export function cancelBrush(atlas: Atlas): void {
  if (!atlas.pendingBrushCodes) return;
  const before = atlas.pendingBrushCodes.slice();
  recordHistory(atlas, {
    label: 'Cancel brush strokes',
    undo: () => { atlas.pendingBrushCodes = before; refreshBrushOverlay(atlas); },
    redo: () => { atlas.pendingBrushCodes = null; atlas.renderer?.clearBrushOverlay(); },
  });
  atlas.pendingBrushCodes = null;
  atlas.renderer?.clearBrushOverlay();
}
