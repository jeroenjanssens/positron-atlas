/**
 * Rendering: setView, render, fitView, plotBackground.
 */

import type { Atlas } from '../atlas.svelte';
import { bounds } from '../render/hitIndex';
import { lowerBound } from '../logic';
import { themeBackground } from './utils';

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
  if (showingAll(atlas) && atlas.allXY && atlas.colorsAll && atlas.anchorPos) {
    const placed = atlas.placedRows;
    const first = lowerBound(atlas.anchorPos, placed);
    sets = [
      { id: 'all', positions: atlas.allXY.subarray(0, placed * 2), colors: atlas.colorsAll.subarray(0, placed * 4), length: placed },
      { id: 'anchors', positions: atlas.anchorXY.subarray(first * 2), colors: atlas.colorsAnchors.subarray(first * 4), length: nA - first },
    ];
  } else {
    sets = [{ id: 'anchors', positions: atlas.anchorXY, colors: atlas.colorsAnchors, length: nA }];
  }
  atlas.renderer.setPointSets(sets);
  atlas.scheduleLabels();
  if (atlas.autoFit) {
    atlas.renderer.fit(bounds(atlas.anchorXY, nA), false, atlas.legendWidth());
  }
}

export function fitView(atlas: Atlas): void {
  if (atlas.anchorXY && atlas.prepared) {
    atlas.autoFit = true;
    atlas.renderer?.fit(bounds(atlas.anchorXY, atlas.prepared.nAnchors), true, atlas.legendWidth());
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
