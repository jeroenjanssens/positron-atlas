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

/** Build a packed-bits bitmask for overlay points inside a world-space polygon. */
function overlayPointsInPolygon(xy: Float32Array, nFilled: number, poly: Float64Array): Uint8Array {
  const hits = pointsInPolygon(xy, nFilled, poly);
  const nBytes = Math.ceil(nFilled / 8);
  const mask = new Uint8Array(nBytes);
  for (const idx of hits) {
    mask[idx >> 3] |= 1 << (idx & 7);
  }
  return mask;
}

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

  // B3: also select overlay rows that fall within the lasso polygon (2D only).
  if (atlas.dims === 2) {
    const polyWorld = new Float64Array(screen.length * 2);
    screen.forEach(([x, y], i) => {
      const [wx, wy] = atlas.renderer!.unproject(x, y);
      polyWorld[2 * i] = wx;
      polyWorld[2 * i + 1] = wy;
    });
    const prevOverlaySelection = new Map(atlas.overlaySelection);
    for (const layer of atlas.layers) {
      if (layer.kind !== 'point-overlay' || !layer.visible) continue;
      const ovXY = atlas.overlayXY.get(layer.id);
      const nFilled = atlas.overlayFilled.get(layer.id) ?? 0;
      if (!ovXY || nFilled === 0) continue;
      const newMask = overlayPointsInPolygon(ovXY.subarray(0, nFilled * 2), nFilled, polyWorld);
      const hasAny = newMask.some((b) => b !== 0);
      if (mode === 'replace') {
        if (hasAny) atlas.overlaySelection.set(layer.id, newMask);
        else atlas.overlaySelection.delete(layer.id);
      } else if (mode === 'add') {
        if (hasAny) {
          const existing = atlas.overlaySelection.get(layer.id);
          if (existing) {
            const merged = new Uint8Array(Math.max(existing.length, newMask.length));
            merged.set(existing);
            for (let i = 0; i < newMask.length; i++) merged[i] |= newMask[i];
            atlas.overlaySelection.set(layer.id, merged);
          } else {
            atlas.overlaySelection.set(layer.id, newMask);
          }
        }
      } else if (mode === 'remove') {
        const existing = atlas.overlaySelection.get(layer.id);
        if (existing) {
          const cleared = new Uint8Array(existing.length);
          for (let i = 0; i < existing.length; i++) cleared[i] = existing[i] & ~newMask[i];
          if (cleared.some((b) => b !== 0)) atlas.overlaySelection.set(layer.id, cleared);
          else atlas.overlaySelection.delete(layer.id);
        }
      }
    }
    const afterOverlaySelection = new Map(atlas.overlaySelection);
    atlas.recordHistory({
      label: modeLabels[mode] ?? 'Lasso selection',
      undo: () => {
        atlas.selectionOnAnchors = beforeOnAnchors;
        setSelection(atlas, beforeMask ? new Uint8Array(beforeMask) : null);
        atlas.overlaySelection = new Map(prevOverlaySelection);
      },
      redo: () => {
        atlas.selectionOnAnchors = afterOnAnchors;
        setSelection(atlas, afterMask ? new Uint8Array(afterMask) : null);
        atlas.overlaySelection = new Map(afterOverlaySelection);
      },
    });
  } else {
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
}

export function setSelection(atlas: Atlas, mask: Uint8Array | null): void {
  atlas.selection = mask;
  atlas.selectedCount = mask ? countSelected(mask) : 0;
  if (!mask) {
    atlas.selectionOnAnchors = false;
    atlas.overlaySelection.clear(); // B3: clear overlay selections when base selection is cleared
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
  // B3: include overlay row selections when present.
  const overlayMasks: { layerId: string; variable: string; mask: Uint8Array }[] = [];
  for (const [layerId, mask] of atlas.overlaySelection) {
    if (!mask.some((b) => b !== 0)) continue;
    const layer = atlas.layers.find((l) => l.id === layerId);
    if (!layer) continue;
    overlayMasks.push({ layerId, variable: layer.sourceName ?? layer.name, mask: packBits(mask) });
  }
  vscode.post({
    type: 'selectionFrame',
    mask: packBits(atlas.selection),
    overlayMasks: overlayMasks.length > 0 ? overlayMasks : undefined,
  });
}

/** Recolor with selection fade. Called by recolor() in colors.ts. */
export function applySelectionFade(atlas: Atlas, colorsAll: Uint8Array): void {
  const n = atlas.nKept;
  if (atlas.selection && atlas.selection.length === n) {
    fadeUnselected(colorsAll, atlas.selection, hexToRgb(toHex(plotBackground(atlas))));
  }
}
