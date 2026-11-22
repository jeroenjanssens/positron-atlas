/**
 * Rendering: setView, render, fitView, plotBackground.
 */

import type { Atlas } from '../atlas.svelte';
import type { FilterAttribute } from '../render/renderer';
import { bounds, bounds3D } from '../render/hitIndex';
import { lowerBound } from '../logic';
import { themeBackground } from './utils';
import { gatherU16 } from './utils';
import { runSearch, searchColumn } from './search';
import { buildRadii, buildHistFilterValues } from './colors';
import { getLayer } from './layers';

export function setView(atlas: Atlas, v: Partial<import('./types').ViewOptions>): void {
  const cmapChanged = v.colormap !== undefined && v.colormap !== atlas.view.colormap;
  const paletteChanged = v.palette !== undefined && v.palette !== atlas.view.palette;
  const backgroundChanged = v.background !== undefined && v.background !== atlas.view.background;
  const glowChanged = v.glow !== undefined || v.glowStrength !== undefined || v.glowRadius !== undefined;
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
  if (glowChanged) {
    atlas.glowVersion++;
  }
}

export function showingAll(atlas: Atlas): boolean {
  return !!atlas.prepared?.needsProjection && (atlas.projection === 'running' || atlas.projection === 'done') && atlas.placedRows > 0;
}

export function render(atlas: Atlas): void {
  if (!atlas.renderer || !atlas.anchorXY || !atlas.colorsAnchors || !atlas.prepared) {
    return;
  }
  // A2: check base layer visibility.
  const baseLayer = getLayer(atlas.layers, 'base');
  if (baseLayer && !baseLayer.visible) {
    atlas.renderer.setPointSets([], []);
    atlas._renderTick++;
    return;
  }
  const baseLO = baseLayer ? baseLayer.opacity : 1;
  const baseLB = baseLayer ? baseLayer.blending : 'normal';

  const nA = atlas.prepared.nAnchors;
  let sets: import('../render/renderer').PointSet[];
  let filters: (FilterAttribute | null)[];

  const filterForCodes = (
    codes: Uint16Array | null,
    histVals: Float32Array | null,
    histOffset = 0,
  ): FilterAttribute | null => {
    const hidden = (atlas.colorColumn !== null && !atlas.colorByCluster)
      ? atlas.hiddenCategories.get(atlas.colorColumn)
      : undefined;
    // Cluster colouring (A6): use cluster codes for the legend filter.
    const clusterCodes = atlas.colorByCluster && atlas.cluster
      ? (codes ?? atlas.cluster.codes)
      : null;
    const activeCodes = clusterCodes ?? (hidden && hidden.size > 0 ? codes : null);
    if (!activeCodes && !histVals) return null;
    const length = activeCodes ? activeCodes.length : (histVals ? histVals.length : 0);
    // Combined filter: 1 if visible in BOTH legend and histogram brush.
    const out = new Float32Array(length).fill(1);
    if (activeCodes && hidden && hidden.size > 0 && !atlas.colorByCluster) {
      for (let i = 0; i < activeCodes.length; i++) {
        if (hidden.has(activeCodes[i])) out[i] = 0;
      }
    }
    if (histVals) {
      for (let i = 0; i < Math.min(out.length, histVals.length); i++) {
        if (histVals[i] < 0.5) out[i] = 0;
      }
    }
    // Wrap in a FilterAttribute with an always-empty hidden set (we pre-computed the filter).
    return { codes: activeCodes ?? new Uint16Array(length), hidden: new Set(), precomputed: out };
  };

  const nd = atlas.dims;
  if (showingAll(atlas) && atlas.allXY && atlas.colorsAll && atlas.anchorPos) {
    const placed = atlas.placedRows;
    const first = lowerBound(atlas.anchorPos, placed);
    const histAll = buildHistFilterValues(atlas, placed, 0);
    const histAnchors = buildHistFilterValues(atlas, nA - first, first);
    const radiiAll = buildRadii(atlas, placed, 0);
    const radiiAnchors = buildRadii(atlas, nA - first, first);
    sets = [
      { id: 'all', layerId: 'base', positions: atlas.allXY.subarray(0, placed * nd), colors: atlas.colorsAll.subarray(0, placed * 4), length: placed, positionStride: nd, radii: radiiAll ?? undefined, layerOpacity: baseLO, layerBlending: baseLB },
      { id: 'anchors', layerId: 'base', positions: atlas.anchorXY.subarray(first * nd), colors: atlas.colorsAnchors.subarray(first * 4), length: nA - first, positionStride: nd, radii: radiiAnchors ?? undefined, layerOpacity: baseLO, layerBlending: baseLB },
    ];
    filters = [
      filterForCodes(atlas.colorValues instanceof Uint16Array ? atlas.colorValues.subarray(0, placed) : null, histAll),
      filterForCodes(atlas.colorValues instanceof Uint16Array ? gatherU16(atlas.colorValues, atlas.anchorPos).subarray(first) : null, histAnchors, first),
    ];
  } else {
    const histAll = buildHistFilterValues(atlas, nA, 0);
    const radiiAnchors = buildRadii(atlas, nA, 0);
    sets = [{ id: 'anchors', layerId: 'base', positions: atlas.anchorXY, colors: atlas.colorsAnchors, length: nA, positionStride: nd, radii: radiiAnchors ?? undefined, layerOpacity: baseLO, layerBlending: baseLB }];
    filters = [filterForCodes(
      atlas.colorValues instanceof Uint16Array
        ? (atlas.prepared.needsProjection && atlas.anchorPos ? gatherU16(atlas.colorValues, atlas.anchorPos) : atlas.colorValues)
        : null,
      histAll,
    )];
  }
  atlas.renderer.setPointSets(sets, filters);
  // B5: push annotations to renderer for the leader-lines deck.gl layer.
  atlas.renderer.setAnnotations(atlas.annotations);
  // Re-apply any active search highlight after the point sets change (A7).
  if (atlas.searchMask && atlas.searchQuery) {
    const col = searchColumn(atlas);
    if (col !== null) runSearch(atlas, atlas.searchQuery, col);
  }
  atlas._renderTick++;
  // A12: invalidate glow when point data changes (2D only).
  if (atlas.view.glow && nd === 2) atlas.glowVersion++;
  // In 3D mode, invalidate the screen-space hit index while layout data is
  // actively changing (projection is running or stale).  'done' and 'none' both
  // mean data is settled ('none' covers coords mode where no UMAP projection
  // is needed); in those states the existing screen positions remain valid and
  // on3DViewChange handles the camera-movement case.
  if (nd === 3 && (atlas.projection === 'running' || atlas.projection === 'stale')) atlas._3dScreenXY = null;
  atlas.scheduleLabels();
  if (atlas.autoFit) {
    if (nd === 3) {
      // 3D: use bounds3D and let OrbitView handle fitting.
      atlas.renderer.fit3D(bounds3D(atlas.anchorXY, nA), false);
    } else {
      // A11: leave extra margin when around-labels are active so the ring of labels
      // lands outside the visible cloud (20 % on each side → cloud uses 60 % of viewport).
      const isAround = atlas.labels.labelStyle === 'around';
      atlas.renderer.fit(bounds(atlas.anchorXY, nA), false, atlas.legendWidth(), isAround ? 0.2 : 0);
      atlas.fittedZoom = atlas.renderer.fittedZoom; // A8: track for zoom-dependent fine labels
    }
    // Treat autoFit as "fit on the next render then stop" so that repeated render()
    // calls (e.g. from recolor, toggleCategory) don't keep resetting the camera.
    // Code that wants a re-fit (new UMAP result, fitView button) must re-set autoFit=true.
    atlas.autoFit = false;
  }
}

export function fitView(atlas: Atlas): void {
  if (atlas.anchorXY && atlas.prepared) {
    atlas.autoFit = true;
    if (atlas.dims === 3) {
      atlas.renderer?.fit3D(bounds3D(atlas.anchorXY, atlas.prepared.nAnchors), true);
    } else {
      const isAround = atlas.labels.labelStyle === 'around';
      atlas.renderer?.fit(bounds(atlas.anchorXY, atlas.prepared.nAnchors), true, atlas.legendWidth(), isAround ? 0.2 : 0);
      if (atlas.renderer) atlas.fittedZoom = atlas.renderer.fittedZoom; // A8
    }
  }
}

/**
 * Re-fit the view when the around-labels mode changes.
 * Called from labels.ts when switching between 'around' and 'over'.
 * Respects userMoved (force = false).
 */
export function fitForLabelStyle(atlas: Atlas, isAround: boolean): void {
  if (atlas.anchorXY && atlas.prepared && atlas.renderer && atlas.dims === 2) {
    const padExtra = isAround ? 0.2 : 0;
    atlas.renderer.fit(bounds(atlas.anchorXY, atlas.prepared.nAnchors), false, atlas.legendWidth(), padExtra);
    atlas.fittedZoom = atlas.renderer.fittedZoom;
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
