/**
 * B3: Overlay layer operations — another DataFrame on the map.
 *
 * Overlay XY data is stored in atlas.overlayXY (Map<layerId, Float32Array>)
 * and atlas.overlayColors (Map<layerId, Uint8Array>).
 * Each overlay layer has a fixed RGBA color derived from the layer id.
 */

import type { Atlas } from '../atlas.svelte';
import type { FileRef } from '../../shared/protocol';
import { vscode, fetchTyped } from '../vscode';
import { addOverlayLayer, removeLayer } from './layers';
import { overlaySymbolCode } from './symbols';
import { HitIndex } from '../render/hitIndex';

/** Distinct overlay colors (RGBA). Assigned in rotation as overlays are added. */
const OVERLAY_COLORS: [number, number, number, number][] = [
  [255, 127,  14, 220],  // orange
  [ 44, 160,  44, 220],  // green
  [148, 103, 189, 220],  // purple
  [214,  39,  40, 220],  // red
  [ 23, 190, 207, 220],  // cyan
  [188, 189,  34, 220],  // yellow-green
  [227, 119, 194, 220],  // pink
  [140,  86,  75, 220],  // brown
];

/** Returns a consistent RGBA color for the nth overlay. */
export function overlayColor(n: number): [number, number, number, number] {
  return OVERLAY_COLORS[n % OVERLAY_COLORS.length];
}

/**
 * Called when the host confirms overlay transforms are ready (overlayPrepared).
 * Adds the layer to the layer list, then triggers projection.
 */
export function onOverlayPrepared(
  atlas: Atlas,
  layerId: string,
  nKept: number,
  variable: string,
): void {
  // Add the layer to the layer list (if not already there).
  if (!atlas.layers.find((l) => l.id === layerId)) {
    const overlayIdx = atlas.layers.filter((l) => l.kind === 'point-overlay').length;
    const symCode = overlaySymbolCode(overlayIdx);
    atlas.layers = addOverlayLayer(atlas.layers, layerId, variable, variable, symCode);
    // Pre-allocate XY and colors for the overlay.
    const nd = atlas.dims;
    atlas.overlayXY.set(layerId, new Float32Array(nKept * nd));
    const color = overlayColor(overlayIdx);
    const colors = new Uint8Array(nKept * 4);
    for (let i = 0; i < nKept; i++) {
      colors[i * 4] = color[0];
      colors[i * 4 + 1] = color[1];
      colors[i * 4 + 2] = color[2];
      colors[i * 4 + 3] = color[3];
    }
    atlas.overlayColors.set(layerId, colors);
    atlas.overlayNKept.set(layerId, nKept);
    atlas.overlayFilled.set(layerId, 0);
  }
  // Trigger projection (host will stream xyChunk messages back).
  vscode.post({ type: 'projectOverlay', layerId, metric: 'euclidean', seed: 0 });
}

/**
 * Called when an overlay XY chunk arrives (xyChunk message with layerId).
 * Stores the chunk data in overlayXY and triggers a re-render.
 * When all rows are filled, builds a spatial HitIndex for hover detection.
 */
export async function onOverlayXYChunk(atlas: Atlas, layerId: string, file: FileRef): Promise<void> {
  const xy = (await fetchTyped(file.uri, 'f32')) as Float32Array;
  const nd = file.shape.length >= 2 ? file.shape[1] : 2;
  const offset = file.offset ?? 0;
  let buf = atlas.overlayXY.get(layerId);
  const nKept = atlas.overlayNKept.get(layerId) ?? 0;
  if (!buf || buf.length !== nKept * nd) {
    // Re-allocate if dims or size changed.
    buf = new Float32Array(nKept * nd);
    atlas.overlayXY.set(layerId, buf);
  }
  buf.set(xy, offset * nd);
  const prevFilled = atlas.overlayFilled.get(layerId) ?? 0;
  const newFilled = prevFilled + xy.length / nd;
  atlas.overlayFilled.set(layerId, newFilled);
  // Build spatial hit index when all rows have been received (2D only for now).
  if (newFilled >= nKept && nd === 2) {
    atlas.overlayHits.set(layerId, new HitIndex(buf, nKept));
    // B3/Item 3: request column metadata for the overlay so the search/hist pickers work.
    if (!atlas.overlayDescribes.has(layerId)) {
      vscode.post({ type: 'describeOverlay', layerId });
    }
  }
  atlas.render();
}

/**
 * Called when an overlay layer is removed (overlayRemoved).
 * Cleans up overlay data and updates the layer list.
 */
export function onOverlayRemoved(atlas: Atlas, layerId: string): void {
  atlas.layers = removeLayer(atlas.layers, layerId);
  atlas.overlayXY.delete(layerId);
  atlas.overlayColors.delete(layerId);
  atlas.overlayNKept.delete(layerId);
  atlas.overlayFilled.delete(layerId);
  atlas.overlayHits.delete(layerId);
  // Clear cached row data for this layer.
  for (const key of [...atlas.overlayRowCache.keys()]) {
    if (key.startsWith(`${layerId}:`)) atlas.overlayRowCache.delete(key);
  }
  // B3/Item 3: clear describe + search state for this layer.
  atlas.overlayDescribes.delete(layerId);
  atlas.overlaySearchMasks.delete(layerId);
  atlas.histValuesOverlayData.delete(layerId);
  if (atlas.searchLayerId === layerId) {
    atlas.searchLayerId = null;
    atlas.searchQuery = '';
    atlas.searchMatchCount = 0;
    atlas.renderer?.setSearch(null);
  }
  if (atlas.histFilterLayerId === layerId) {
    atlas.histFilterLayerId = null;
  }
  atlas.render();
}

/**
 * Called when overlay row values arrive (overlayRows message).
 * Caches the values and updates the visible tooltip if seq matches.
 */
export function onOverlayRows(
  atlas: Atlas,
  seq: number,
  layerId: string,
  values: Record<number, [string, string][]>,
): void {
  for (const [k, vals] of Object.entries(values)) {
    const posIdx = Number(k);
    atlas.overlayRowCache.set(`${layerId}:${posIdx}`, vals);
  }
  if (seq !== atlas.overlayHoverSeq) return;
  // Update the visible tooltip with the now-available values.
  const tt = atlas.tooltip;
  if (tt && tt.layerId === layerId) {
    for (const [k, vals] of Object.entries(values)) {
      if (Number(k) === tt.row) {
        atlas.tooltip = { ...tt, values: vals };
        break;
      }
    }
  }
}
