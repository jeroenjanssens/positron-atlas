/**
 * Selection: lasso, set/clear/invert/compare/frame.
 */

import type { Atlas } from '../atlas.svelte';
import { combineSelection, countSelected, fadeUnselected, invertSelection as invertSel, packBits, pointsInPolygon, type SelectMode } from '../select/lasso';
import { vscode } from '../vscode';
import { toHex } from '../logic';
import { hexToRgb } from '../color/colormaps';
import { formatCount } from '../logic';
import { plotBackground } from './render';
import { notifySelectionChanged } from './api';

/**
 * Select the points inside a lasso drawn on the plot (CSS pixels relative to the plot).
 * Before all rows are placed, only the anchors on screen can be selected.
 */
export function applyLasso(atlas: Atlas, screen: [number, number][], mode: SelectMode): void {
  if (!atlas.renderer || !atlas.prepared || !atlas.anchorXY || !atlas.anchorPos || screen.length < 3) {
    return;
  }
  const beforeMask = atlas.selection ? new Uint8Array(atlas.selection) : null;
  const beforeOnAnchors = atlas.selectionOnAnchors;

  // T4: In 3D mode, lasso operates in screen space; use the projected screen XY.
  if (atlas.dims === 3 && atlas._3dScreenXY) {
    const poly = new Float64Array(screen.length * 2);
    screen.forEach(([x, y], i) => { poly[2 * i] = x; poly[2 * i + 1] = y; });
    const n = atlas.nKept;
    // _3dScreenXY has [sx0, sy0, sx1, sy1, ...] for all nKept points.
    const hits = pointsInPolygon(atlas._3dScreenXY, n, poly);
    const next = combineSelection(atlas.selection, hits, n, mode);
    atlas.selectionOnAnchors = false;
    setSelection(atlas, next);
  } else {
    const poly = new Float64Array(screen.length * 2);
    screen.forEach(([x, y], i) => {
      const [wx, wy] = atlas.renderer!.unproject(x, y);
      poly[2 * i] = wx;
      poly[2 * i + 1] = wy;
    });
    const n = atlas.nKept;
    let hits: Uint32Array;
    const onAnchors = !!atlas.prepared.needsProjection && !(atlas.projection === 'done' && atlas.allXY);
    if (!onAnchors) {
      hits = pointsInPolygon(atlas.prepared.needsProjection ? atlas.allXY! : atlas.anchorXY, n, poly);
    } else {
      const local = pointsInPolygon(atlas.anchorXY, atlas.prepared.nAnchors, poly);
      hits = new Uint32Array(local.length);
      for (let i = 0; i < local.length; i++) hits[i] = atlas.anchorPos[local[i]];
    }
    const next = combineSelection(atlas.selection, hits, n, mode);
    atlas.selectionOnAnchors = next ? (mode === 'replace' || !atlas.selection ? onAnchors : atlas.selectionOnAnchors || onAnchors) : false;
    setSelection(atlas, next);
  }

  const afterMask = atlas.selection ? new Uint8Array(atlas.selection) : null;
  const afterOnAnchors = atlas.selectionOnAnchors;
  const modeLabels: Record<SelectMode, string> = {
    replace: 'Select points (lasso)',
    add: 'Add to selection (lasso)',
    remove: 'Remove from selection (lasso)',
  };
  atlas.recordHistory({
    label: modeLabels[mode] ?? 'Lasso selection',
    undo: () => {
      atlas.selectionOnAnchors = beforeOnAnchors;
      setSelection(atlas, beforeMask ? new Uint8Array(beforeMask) : null);
    },
    redo: () => {
      atlas.selectionOnAnchors = afterOnAnchors;
      setSelection(atlas, afterMask ? new Uint8Array(afterMask) : null);
    },
  });
}

export function setSelection(atlas: Atlas, mask: Uint8Array | null): void {
  atlas.selection = mask;
  atlas.selectedCount = mask ? countSelected(mask) : 0;
  if (!mask) {
    atlas.selectionOnAnchors = false;
  }
  atlas.comparison = null;
  atlas.comparing = false;
  atlas.compareSeq++;
  atlas.recolor();
  // Notify Python handle (C3): push selection mask via comm.
  notifySelectionChanged(atlas);
}

export function clearSelection(atlas: Atlas): void {
  if (!atlas.selection) return;
  const beforeMask = new Uint8Array(atlas.selection);
  const beforeOnAnchors = atlas.selectionOnAnchors;
  setSelection(atlas, null);
  atlas.recordHistory({
    label: 'Clear selection',
    undo: () => {
      atlas.selectionOnAnchors = beforeOnAnchors;
      setSelection(atlas, new Uint8Array(beforeMask));
    },
    redo: () => { setSelection(atlas, null); },
  });
}

export function invertSelection(atlas: Atlas): void {
  if (!atlas.prepared || !atlas.anchorPos) return;
  const beforeMask = atlas.selection ? new Uint8Array(atlas.selection) : null;
  const beforeOnAnchors = atlas.selectionOnAnchors;
  const scope = atlas.selectionOnAnchors ? atlas.anchorPos : undefined;
  setSelection(atlas, invertSel(atlas.selection, atlas.nKept, scope));
  const afterMask = atlas.selection ? new Uint8Array(atlas.selection) : null;
  atlas.recordHistory({
    label: 'Invert selection',
    undo: () => {
      atlas.selectionOnAnchors = beforeOnAnchors;
      setSelection(atlas, beforeMask ? new Uint8Array(beforeMask) : null);
    },
    redo: () => {
      setSelection(atlas, afterMask ? new Uint8Array(afterMask) : null);
    },
  });
}

export function compareSelection(atlas: Atlas): void {
  if (!atlas.selection) return;
  atlas.comparing = true;
  atlas.comparison = null;
  vscode.post({ type: 'compareSelection', seq: ++atlas.compareSeq, mask: packBits(atlas.selection) });
}

export function selectionToFrame(atlas: Atlas): void {
  if (!atlas.selection) return;
  vscode.post({ type: 'selectionFrame', mask: packBits(atlas.selection) });
}

/** Recolor with selection fade. Called by recolor() in colors.ts. */
export function applySelectionFade(atlas: Atlas, colorsAll: Uint8Array): void {
  const n = atlas.nKept;
  if (atlas.selection && atlas.selection.length === n) {
    fadeUnselected(colorsAll, atlas.selection, hexToRgb(toHex(plotBackground(atlas))));
  }
}
