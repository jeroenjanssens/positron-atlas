/**
 * B3/Item 3: Search and histogram-filter targeting a specific overlay layer.
 *
 * When atlas.searchLayerId is set to an overlay layer id, the search box queries
 * that overlay's columns via the searchOverlay message, and the results are stored
 * as a Uint8Array mask in atlas.overlaySearchMasks.
 *
 * render.ts calls reapplyOverlaySearch() after setPointSets to align the search
 * highlight with the current PointSet order.
 */

import type { Atlas } from '../atlas.svelte';
import type { FilterAttribute, PointSet } from '../render/renderer';
import type { FileRef } from '../../shared/protocol';
import { vscode } from '../vscode';

// ---- Search targeting overlay ---------------------------------------------------

/** Start a search on an overlay layer. */
export function runSearchOverlay(atlas: Atlas, layerId: string, column: number, query: string): void {
  const q = query.trim();
  if (!q) {
    clearSearchOverlay(atlas);
    return;
  }
  atlas.searchQuery = q;
  atlas.searchPending = true;
  atlas.searchLayerId = layerId;
  vscode.post({ type: 'searchOverlay', layerId, column, query: q, limit: 100_000 });
}

/** Handle search results for an overlay layer. */
export async function onSearchOverlayResults(
  atlas: Atlas,
  msg: { type: 'searchOverlayResults'; layerId: string; query: string; file: FileRef; count: number },
): Promise<void> {
  atlas.searchPending = false;
  if (atlas.searchQuery !== msg.query || atlas.searchLayerId !== msg.layerId) return;
  try {
    const buf = await fetch(msg.file.uri).then((r) => r.arrayBuffer());
    const posIndices = new Uint32Array(buf);
    const nKept = atlas.overlayNKept.get(msg.layerId) ?? 0;
    if (nKept === 0) return;
    const mask = new Uint8Array(nKept);
    for (const idx of posIndices) {
      if (idx < nKept) mask[idx] = 1;
    }
    atlas.overlaySearchMasks.set(msg.layerId, mask);
    atlas.searchMatchCount = posIndices.length;
    // Re-apply search filter to current renderer PointSets.
    if (atlas.renderer) {
      const sf = _buildOverlaySearchFilters(atlas, msg.layerId, mask);
      atlas.renderer.setSearch(sf);
    }
  } catch {
    clearSearchOverlay(atlas);
  }
}

/** Handle empty search result for an overlay layer. */
export function onSearchOverlayEmpty(
  atlas: Atlas,
  msg: { type: 'searchOverlayEmpty'; layerId: string; query: string },
): void {
  atlas.searchPending = false;
  if (atlas.searchQuery !== msg.query || atlas.searchLayerId !== msg.layerId) return;
  const nKept = atlas.overlayNKept.get(msg.layerId) ?? 0;
  atlas.overlaySearchMasks.set(msg.layerId, new Uint8Array(nKept)); // all zero = no matches
  atlas.searchMatchCount = 0;
  if (atlas.renderer) {
    atlas.renderer.setSearch(_buildOverlaySearchFilters(atlas, msg.layerId, new Uint8Array(nKept)));
  }
}

/** Clear overlay search state. */
export function clearSearchOverlay(atlas: Atlas): void {
  atlas.overlaySearchMasks.clear();
  atlas.searchLayerId = null;
  atlas.searchQuery = '';
  atlas.searchMatchCount = 0;
  atlas.searchPending = false;
  atlas.renderer?.setSearch(null);
}

/**
 * Re-apply the active overlay search mask after render() rebuilds PointSets.
 * Called from render.ts after setPointSets.
 */
export function reapplyOverlaySearch(atlas: Atlas, sets: PointSet[]): void {
  const layerId = atlas.searchLayerId;
  if (!layerId || !atlas.renderer) return;
  const mask = atlas.overlaySearchMasks.get(layerId);
  if (!mask) return;
  const sf = _buildSearchFiltersFromSets(sets, layerId, mask);
  atlas.renderer.setSearch(sf);
}

/**
 * Build a search filter array aligned to the given PointSets array.
 * Sets for the target overlay get the mask; all other sets get null (normal rendering).
 * When searchActive (some entry != null), the renderer's two-pass logic highlights matches.
 */
function _buildSearchFiltersFromSets(
  sets: PointSet[],
  targetLayerId: string,
  mask: Uint8Array,
): (Float32Array | null)[] {
  return sets.map((s) => {
    if (s.layerId !== targetLayerId) return null;
    const f = new Float32Array(s.length);
    for (let i = 0; i < Math.min(mask.length, s.length); i++) f[i] = mask[i];
    return f;
  });
}

/**
 * Build search filter array when we don't have the current PointSets array handy
 * (called from async message handlers). Reconstructs the PointSet order from atlas state.
 */
function _buildOverlaySearchFilters(atlas: Atlas, layerId: string, mask: Uint8Array): (Float32Array | null)[] {
  // Determine how many base PointSets there are (1 or 2).
  const { showingAll } = atlas as any;
  const nBase = (typeof showingAll === 'function' ? showingAll() : false) ? 2 : 1;

  const filters: (Float32Array | null)[] = [];
  for (let i = 0; i < nBase; i++) filters.push(null);

  for (const layer of atlas.layers) {
    if (layer.kind !== 'point-overlay' || !layer.visible) continue;
    const nFilled = atlas.overlayFilled.get(layer.id) ?? 0;
    if (nFilled === 0) { filters.push(null); continue; }
    if (layer.id === layerId) {
      const f = new Float32Array(nFilled);
      for (let i = 0; i < Math.min(mask.length, nFilled); i++) f[i] = mask[i];
      filters.push(f);
    } else {
      filters.push(null);
    }
  }
  return filters;
}

// ---- Histogram filter targeting overlay -----------------------------------------

/** Request histogram float32 values for an overlay layer's column. */
export function requestHistOverlay(atlas: Atlas, layerId: string, column: number): void {
  atlas.histFilterLayerId = layerId;
  vscode.post({ type: 'histValuesOverlay', layerId, column });
}

/** Handle histogram values for an overlay layer. */
export async function onHistValuesOverlay(
  atlas: Atlas,
  msg: { type: 'histValuesOverlay'; layerId: string; column: number; file: FileRef },
): Promise<void> {
  if (atlas.histFilterLayerId !== msg.layerId) return;
  try {
    const buf = await fetch(msg.file.uri).then((r) => r.arrayBuffer());
    const values = new Float32Array(buf);
    atlas.histValuesOverlayData.set(msg.layerId, { column: msg.column, values });
    // Trigger a re-render so the histogram filter is applied to the overlay PointSet.
    atlas.render();
  } catch { /* ignore */ }
}

/**
 * Build a FilterAttribute for an overlay PointSet based on the current histogram brush.
 * Returns null when no overlay histogram filter is active for this layer.
 */
export function buildOverlayHistFilter(atlas: Atlas, layerId: string, nFilled: number): FilterAttribute | null {
  if (atlas.histFilterLayerId !== layerId) return null;
  const entry = atlas.histValuesOverlayData.get(layerId);
  if (!entry) return null;
  const range = atlas.histFilter?.range;
  if (!range) return null;
  const { values } = entry;
  const [lo, hi] = range;
  const precomputed = new Float32Array(nFilled).fill(1);
  for (let i = 0; i < Math.min(nFilled, values.length); i++) {
    if (values[i] < lo || values[i] > hi) precomputed[i] = 0;
  }
  return { codes: new Uint16Array(nFilled), hidden: new Set(), precomputed };
}
