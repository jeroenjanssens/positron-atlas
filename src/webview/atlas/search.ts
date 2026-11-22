/**
 * A7 Search: search the title/chosen text column across all prepared rows.
 *
 * When the TextsStore is preloaded the search runs locally (no kernel round
 * trip).  Otherwise the host's `search` message path is used and the kernel
 * performs a vectorized case-insensitive substring (or regex) search.
 *
 * Results are cached by (column, query) so that repeated identical queries
 * do not trigger extra work.  Matches are highlighted on the renderer via
 * the two-pass search filter; non-matches are faded.  Pressing Enter zooms
 * the view to the bounds of the matching points; Escape clears everything.
 */

import type { Atlas } from '../atlas.svelte';
import type { FileRef } from '../../shared/protocol';
import { vscode } from '../vscode';
import { detectTitleColumn } from '../hover/texts';
import { lowerBound } from '../logic';

// ---- public helpers ------------------------------------------------------------------

/** Return the column index to search (title column or first text column). */
export function searchColumn(atlas: Atlas): number | null {
  const col = atlas.tooltipOpts.titleColumn;
  if (typeof col === 'number') return col;
  return detectTitleColumn(atlas.describe?.columns ?? []);
}

/**
 * Run a search for `query` on `column`.  Called from the SearchBox debounce.
 * Clears the current highlight first; then either runs a local search
 * (TextsStore ready) or posts a kernel `search` message.
 */
export function runSearch(atlas: Atlas, query: string, column: number, regex = false): void {
  const q = query.trim();
  if (!q) {
    clearSearch(atlas);
    return;
  }

  const cacheKey = `${column}:${regex ? 're:' : ''}${q}`;
  const cached = atlas.searchCache.get(cacheKey);
  if (cached !== undefined) {
    _applyMask(atlas, cached, q, column);
    return;
  }

  const nKept = atlas.nKept;
  if (nKept === 0) return;

  if (atlas.textsStore.ready) {
    // Local search: iterate over the TextsStore without a kernel call.
    const mask = new Uint8Array(nKept);
    const qLower = q.toLowerCase();
    let matchPat: RegExp | null = null;
    if (regex) {
      try {
        matchPat = new RegExp(q, 'i');
      } catch {
        matchPat = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      }
    }
    let count = 0;
    for (let i = 0; i < nKept; i++) {
      const text = atlas.textsStore.get(i) ?? '';
      const hit = matchPat ? matchPat.test(text) : text.toLowerCase().includes(qLower);
      if (hit) {
        mask[i] = 1;
        count++;
      }
    }
    atlas.searchCache.set(cacheKey, mask);
    _applyMask(atlas, mask, q, column);
    return;
  }

  // Kernel search: post the message and wait for 'searchResults'.
  // Also kick off texts loading in the background so future searches can run locally.
  if (!atlas.textsStore.requested_ && atlas.phase === 'ready') {
    atlas.textsStore.markRequested();
    vscode.post({ type: 'texts', column, maxChars: 120 });
  }
  atlas.searchPending = true;
  atlas.searchQuery = q;
  vscode.post({ type: 'search', column, query: q, limit: 100_000, regex });
}

/**
 * Handle the host's `searchResults` message (kernel search path).
 */
export async function onSearchResults(
  atlas: Atlas,
  msg: { type: 'searchResults'; column: number; query: string; file: FileRef; count: number },
): Promise<void> {
  atlas.searchPending = false;
  if (atlas.searchQuery !== msg.query) return; // stale result
  try {
    const buf = await fetch(msg.file.uri).then((r) => r.arrayBuffer());
    const indices = new Uint32Array(buf);
    const nKept = atlas.nKept;
    const mask = new Uint8Array(nKept);
    for (const idx of indices) {
      if (idx < nKept) mask[idx] = 1;
    }
    const cacheKey = `${msg.column}::${msg.query}`;
    atlas.searchCache.set(cacheKey, mask);
    _applyMask(atlas, mask, msg.query, msg.column);
  } catch {
    atlas.searchMask = null;
    atlas.searchMatchCount = 0;
    atlas.renderer?.setSearch(null);
  }
}

/**
 * Handle the host's `searchEmpty` message (no matches from kernel).
 */
export function onSearchEmpty(atlas: Atlas, msg: { type: 'searchEmpty'; column: number; query: string }): void {
  atlas.searchPending = false;
  if (atlas.searchQuery !== msg.query) return;
  _applyMask(atlas, new Uint8Array(atlas.nKept), msg.query, msg.column);
}

/** Clear the search state and restore normal rendering. */
export function clearSearch(atlas: Atlas): void {
  atlas.searchQuery = '';
  atlas.searchMask = null;
  atlas.searchMatchCount = 0;
  atlas.searchPending = false;
  atlas.renderer?.setSearch(null);
}

/**
 * Zoom the view to the bounding box of the matched points.
 * No-op when there are no matches or no layout yet.
 */
export function zoomToSearchMatches(atlas: Atlas): void {
  const mask = atlas.searchMask;
  if (!mask || !atlas.renderer || !atlas.anchorXY || !atlas.prepared) return;

  const xy = atlas.allXY ?? atlas.anchorXY;
  const nPts = atlas.allXY ? atlas.placedRows : atlas.prepared.nAnchors;

  // Collect matched positions.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let found = false;

  if (atlas.allXY && atlas.placedRows > 0) {
    // Placed rows: prepared-row i → allXY[2i], allXY[2i+1].
    for (let i = 0; i < atlas.placedRows && i < mask.length; i++) {
      if (mask[i]) {
        const x = atlas.allXY[2 * i];
        const y = atlas.allXY[2 * i + 1];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        found = true;
      }
    }
  } else if (atlas.anchorXY && atlas.anchorPos) {
    // Anchors only: anchor j has prepared-row atlas.anchorPos[j].
    for (let j = 0; j < atlas.prepared.nAnchors; j++) {
      const prepIdx = atlas.anchorPos[j];
      if (prepIdx < mask.length && mask[prepIdx]) {
        const x = atlas.anchorXY[2 * j];
        const y = atlas.anchorXY[2 * j + 1];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        found = true;
      }
    }
  } else if (atlas.anchorXY) {
    // No anchorPos (all rows are anchors): prepared-row i = anchor i.
    for (let i = 0; i < nPts && i < mask.length; i++) {
      if (mask[i]) {
        const x = xy[2 * i];
        const y = xy[2 * i + 1];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        found = true;
      }
    }
  }

  if (!found) return;
  // Add a small padding.
  const pad = Math.max((maxX - minX) * 0.1, (maxY - minY) * 0.1, 0.1);
  atlas.renderer.fit([minX - pad, minY - pad, maxX + pad, maxY + pad], true, atlas.legendWidth());
}

// ---- internal helpers ----------------------------------------------------------------

/**
 * Build per-set search filter arrays and push them to the renderer.
 * The filter values are 1.0 (match) or 0.0 (non-match) per point, in the
 * same order as the PointSets passed to setPointSets.
 *
 * Mirrors the set construction in atlas/render.ts:
 *   showingAll → two sets [all-placed, remaining-anchors]
 *   otherwise  → one set [anchors]
 */
function _buildSearchFilters(atlas: Atlas, mask: Uint8Array): (Float32Array | null)[] {
  if (!atlas.prepared) return [];
  const hasAll = !!atlas.allXY && !!atlas.anchorPos && atlas.placedRows > 0 && atlas.prepared.needsProjection;

  if (hasAll) {
    const placed = atlas.placedRows;
    const nA = atlas.prepared.nAnchors;
    const first = lowerBound(atlas.anchorPos!, placed);

    const allFilter = new Float32Array(placed);
    for (let i = 0; i < placed; i++) allFilter[i] = i < mask.length && mask[i] ? 1 : 0;

    const anchorFilter = new Float32Array(nA - first);
    for (let j = 0; j < nA - first; j++) {
      const prepIdx = atlas.anchorPos![first + j];
      anchorFilter[j] = prepIdx < mask.length && mask[prepIdx] ? 1 : 0;
    }

    return [allFilter, anchorFilter];
  } else {
    const nA = atlas.prepared.nAnchors;
    const sf = new Float32Array(nA);
    if (atlas.prepared.needsProjection && atlas.anchorPos) {
      for (let j = 0; j < nA; j++) {
        const prepIdx = atlas.anchorPos[j];
        sf[j] = prepIdx < mask.length && mask[prepIdx] ? 1 : 0;
      }
    } else {
      // No projection needed: prepared-row i === anchor i.
      for (let i = 0; i < nA; i++) sf[i] = i < mask.length && mask[i] ? 1 : 0;
    }
    return [sf];
  }
}

function _applyMask(atlas: Atlas, mask: Uint8Array, query: string, _column: number): void {
  atlas.searchQuery = query;
  atlas.searchMask = mask;
  atlas.searchMatchCount = 0;
  for (const v of mask) if (v) atlas.searchMatchCount++;

  if (atlas.searchMatchCount === 0 || !atlas.prepared) {
    atlas.renderer?.setSearch(null);
    return;
  }

  const sf = _buildSearchFilters(atlas, mask);
  atlas.renderer?.setSearch(sf);
}
