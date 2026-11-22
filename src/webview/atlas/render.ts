/**
 * Rendering: setView, render, fitView, plotBackground.
 */

import type { Atlas } from '../atlas.svelte';
import type { FilterAttribute } from '../render/renderer';
import { bounds } from '../render/hitIndex';
import { lowerBound } from '../logic';
import { themeBackground } from './utils';
import { gatherU16 } from './utils';
import { runSearch, searchColumn } from './search';

export function setView(atlas: Atlas, v: Partial<import('./types').ViewOptions>): void {
  const cmapChanged = v.colormap !== undefined && v.colormap !== atlas.view.colormap;
  const paletteChanged = v.palette !== undefined && v.palette !== atlas.view.palette;
  const backgroundChanged = v.background !== undefined && v.background !== atlas.view.background;
  if (v.images !== undefined && v.images !== atlas.view.images) {
    atlas.tooltip = null;
  }
  atlas.view = { ...atlas.view, ...v };
  atlas.renderer?.setStyle(atlas.view);
  if (paletteChanged || backgroundChanged) {
    atlas.mapColors = null;
    if (atlas.phase === 'ready' || atlas.paused) {
      atlas.updateMapColors(false);
    }
  }
  if (cmapChanged || paletteChanged || backgroundChanged) {
    atlas.recolor();
  }
}

export function showingAll(atlas: Atlas): boolean {
  return !!atlas.prepared?.needsProjection && (atlas.projection === 'running' || atlas.projection === 'done') && atlas.placedRows > 0;
}

export function render(atlas: Atlas): void {
  if (!atlas.renderer || !atlas.anchorXY || !atlas.colorsAnchors || !atlas.prepared) {
    return;
  }
  const nA = atlas.prepared.nAnchors;
  let sets: import('../render/renderer').PointSet[];
  let filters: (FilterAttribute | null)[];

  const filterForCodes = (codes: Uint16Array | null): FilterAttribute | null => {
    if (!codes || atlas.colorColumn === null) return null;
    const hidden = atlas.hiddenCategories.get(atlas.colorColumn);
    if (!hidden || hidden.size === 0) return null;
    return { codes, hidden };
  };

  if (showingAll(atlas) && atlas.allXY && atlas.colorsAll && atlas.anchorPos) {
    const placed = atlas.placedRows;
    const first = lowerBound(atlas.anchorPos, placed);
    sets = [
      { id: 'all', positions: atlas.allXY.subarray(0, placed * 2), colors: atlas.colorsAll.subarray(0, placed * 4), length: placed },
      { id: 'anchors', positions: atlas.anchorXY.subarray(first * 2), colors: atlas.colorsAnchors.subarray(first * 4), length: nA - first },
    ];
    filters = [
      filterForCodes(atlas.colorValues instanceof Uint16Array ? atlas.colorValues.subarray(0, placed) : null),
      filterForCodes(atlas.colorValues instanceof Uint16Array ? gatherU16(atlas.colorValues, atlas.anchorPos).subarray(first) : null),
    ];
  } else {
    sets = [{ id: 'anchors', positions: atlas.anchorXY, colors: atlas.colorsAnchors, length: nA }];
    filters = [filterForCodes(
      atlas.colorValues instanceof Uint16Array
        ? (atlas.prepared.needsProjection && atlas.anchorPos ? gatherU16(atlas.colorValues, atlas.anchorPos) : atlas.colorValues)
        : null,
    )];
  }
  atlas.renderer.setPointSets(sets, filters);
  // Re-apply any active search highlight after the point sets change (A7).
  if (atlas.searchMask && atlas.searchQuery) {
    const col = searchColumn(atlas);
    if (col !== null) runSearch(atlas, atlas.searchQuery, col);
  }
  atlas.scheduleLabels();
  if (atlas.autoFit) {
    atlas.renderer.fit(bounds(atlas.anchorXY, nA), false, atlas.legendWidth());
    atlas.fittedZoom = atlas.renderer.fittedZoom; // A8: track for zoom-dependent fine labels
  }
}

export function fitView(atlas: Atlas): void {
  if (atlas.anchorXY && atlas.prepared) {
    atlas.autoFit = true;
    atlas.renderer?.fit(bounds(atlas.anchorXY, atlas.prepared.nAnchors), true, atlas.legendWidth());
    if (atlas.renderer) atlas.fittedZoom = atlas.renderer.fittedZoom; // A8
  }
}

export function legendWidth(atlas: Atlas): number {
  const el = document.querySelector('.legend') as HTMLElement | null;
  return el ? el.offsetWidth + 20 : 0;
}

/** The effective plot background (the custom color, or the theme's editor background). */
export function plotBackground(atlas: Atlas): string {
  return atlas.view.background || themeBackground();
}
