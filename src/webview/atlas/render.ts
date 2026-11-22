/**
 * Rendering: setView, render, fitView, plotBackground.
 */

import { on3DViewChange } from './view3d';
import type { Atlas } from '../atlas.svelte';
import type { FilterAttribute, PointSet } from '../render/renderer';
import { bounds, bounds3D } from '../render/hitIndex';
import { lowerBound } from '../logic';
import { themeBackground } from './utils';
import { gatherU16 } from './utils';
import { runSearch, searchColumn } from './search';
import { buildRadii, buildHistFilterValues } from './colors';
import { getLayer } from './layers';
import { fullExtent3D, type Extent3D } from '../render/boxes';
import { reapplyOverlaySearch, buildOverlayHistFilter } from './searchOverlay';

export function setView(atlas: Atlas, v: Partial<import('./types').ViewOptions>): void {
  const cmapChanged = v.colormap !== undefined && v.colormap !== atlas.view.colormap;
  const paletteChanged = v.palette !== undefined && v.palette !== atlas.view.palette;
  const backgroundChanged = v.background !== undefined && v.background !== atlas.view.background;
  const glowChanged = v.glow !== undefined || v.glowStrength !== undefined || v.glowRadius !== undefined;
  // B2: changing any 3D overlay flag requires a full atlas.render() so that setDataBox()
  // is called with the updated values (renderer.setStyle only triggers renderer.render()
  // which re-uses the renderer's cached dataBoxShowGrid/dataBoxShowGizmo).
  const dataBoxChanged =
    v.show3DDataBox !== undefined ||
    v.show3DFloorGrid !== undefined ||
    v.show3DGizmo !== undefined;
  // item 13: 3D view options — apply directly to the renderer.
  const orthoChanged = v.orthographic3D !== undefined && v.orthographic3D !== atlas.view.orthographic3D;
  const depthFadeChanged = v.depthFade !== undefined && v.depthFade !== atlas.view.depthFade;
  if (v.images !== undefined && v.images !== atlas.view.images) {
    atlas.tooltip = null;
  }
  atlas.view = { ...atlas.view, ...v };
  atlas.renderer?.setStyle(atlas.view);
  if (orthoChanged) {
    atlas.renderer?.setOrtho3D(atlas.view.orthographic3D ?? false);
  }
  if (depthFadeChanged) {
    atlas.renderer?.setDepthFade(atlas.view.depthFade ?? false);
  }
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
  if (dataBoxChanged && atlas.dims === 3 && (atlas.phase === 'ready' || atlas.paused)) {
    render(atlas);
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

  /**
   * Build a combined (legend + histogram + animate) FilterAttribute for one point set.
   * @param codes   Category codes for this set (already gathered to this set's row order).
   * @param histVals Histogram filter values aligned with this set (or null).
   * @param animSlice Animate-window filter values aligned with this set (or null).
   */
  const filterForCodes = (
    codes: Uint16Array | null,
    histVals: Float32Array | null,
    animSlice: Float32Array | null = null,
  ): FilterAttribute | null => {
    const hidden = (atlas.colorColumn !== null && !atlas.colorByCluster)
      ? atlas.hiddenCategories.get(atlas.colorColumn)
      : undefined;
    // Cluster colouring (A6): use cluster codes for the legend filter.
    const clusterCodes = atlas.colorByCluster && atlas.cluster
      ? (codes ?? atlas.cluster.codes)
      : null;
    const activeCodes = clusterCodes ?? (hidden && hidden.size > 0 ? codes : null);
    if (!activeCodes && !histVals && !animSlice) return null;
    const length = activeCodes ? activeCodes.length : (histVals ? histVals.length : (animSlice ? animSlice.length : 0));
    // Combined filter: 1 if visible in ALL active filters.
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
    // C2 animate filter: AND with the pre-gathered time-window slice.
    if (animSlice) {
      for (let i = 0; i < Math.min(out.length, animSlice.length); i++) {
        if (animSlice[i] < 0.5) out[i] = 0;
      }
    }
    // Wrap in a FilterAttribute with an always-empty hidden set (we pre-computed the filter).
    return { codes: activeCodes ?? new Uint16Array(length), hidden: new Set(), precomputed: out };
  };

  /** Gather a Float32Array by anchorPos indices (C2 animate filter). */
  const gatherF32 = (vals: Float32Array, pos: Uint32Array): Float32Array => {
    const out = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i++) out[i] = vals[pos[i]];
    return out;
  };

  const nd = atlas.dims;
  const animateVals = atlas.animateFilter ?? null;

  if (showingAll(atlas) && atlas.allXY && atlas.colorsAll && atlas.anchorPos) {
    const placed = atlas.placedRows;
    const first = lowerBound(atlas.anchorPos, placed);
    const histAll = buildHistFilterValues(atlas, placed, 0);
    const histAnchors = buildHistFilterValues(atlas, nA - first, first);
    const radiiAll = buildRadii(atlas, placed, 0);
    const radiiAnchors = buildRadii(atlas, nA - first, first);
    // Animate filter slices: placed rows are indices 0..placed-1 (contiguous kept rows);
    // remaining anchors are at anchorPos[first..nA-1] in kept-row space.
    const animAll = animateVals ? animateVals.subarray(0, placed) : null;
    const animAnchors = animateVals ? gatherF32(animateVals, atlas.anchorPos).subarray(first) : null;
    sets = [
      { id: 'all', layerId: 'base', positions: atlas.allXY.subarray(0, placed * nd), colors: atlas.colorsAll.subarray(0, placed * 4), length: placed, positionStride: nd, radii: radiiAll ?? undefined, layerOpacity: baseLO, layerBlending: baseLB },
      { id: 'anchors', layerId: 'base', positions: atlas.anchorXY.subarray(first * nd), colors: atlas.colorsAnchors.subarray(first * 4), length: nA - first, positionStride: nd, radii: radiiAnchors ?? undefined, layerOpacity: baseLO, layerBlending: baseLB },
    ];
    filters = [
      filterForCodes(atlas.colorValues instanceof Uint16Array ? atlas.colorValues.subarray(0, placed) : null, histAll, animAll),
      filterForCodes(atlas.colorValues instanceof Uint16Array ? gatherU16(atlas.colorValues, atlas.anchorPos).subarray(first) : null, histAnchors, animAnchors),
    ];
  } else {
    const histAll = buildHistFilterValues(atlas, nA, 0);
    const radiiAnchors = buildRadii(atlas, nA, 0);
    // Animate filter: when needsProjection=true, anchors are at anchorPos[0..nA-1];
    // when needsProjection=false, nA === nKept so direct slice is correct.
    const animAll = animateVals
      ? (atlas.prepared.needsProjection && atlas.anchorPos
          ? gatherF32(animateVals, atlas.anchorPos)
          : animateVals.subarray(0, nA))
      : null;
    sets = [{ id: 'anchors', layerId: 'base', positions: atlas.anchorXY, colors: atlas.colorsAnchors, length: nA, positionStride: nd, radii: radiiAnchors ?? undefined, layerOpacity: baseLO, layerBlending: baseLB }];
    filters = [filterForCodes(
      atlas.colorValues instanceof Uint16Array
        ? (atlas.prepared.needsProjection && atlas.anchorPos ? gatherU16(atlas.colorValues, atlas.anchorPos) : atlas.colorValues)
        : null,
      histAll,
      animAll,
    )];
  }
  // B3/Item 9: split base PointSets by symbol code when symbolValuesAnchors is set.
  if (atlas.symbolValuesAnchors) {
    const split = _splitBySymbolCode(sets, filters, atlas);
    sets = split[0];
    filters = split[1];
  }

  // B3: append overlay point sets (one per visible point-overlay layer).
  for (const layer of atlas.layers) {
    if (layer.kind !== 'point-overlay' || !layer.visible) continue;
    const xy = atlas.overlayXY.get(layer.id);
    const colors = atlas.overlayColors.get(layer.id);
    const nKept = atlas.overlayNKept.get(layer.id) ?? 0;
    if (!xy || !colors || nKept === 0) continue;
    const nd = atlas.dims;
    const nFilled = atlas.overlayFilled.get(layer.id) ?? 0;
    if (nFilled === 0) continue;
    sets.push({
      id: `overlay-${layer.id}`,
      layerId: layer.id,
      positions: xy.subarray(0, nFilled * nd),
      colors: colors.subarray(0, nFilled * 4),
      length: nFilled,
      positionStride: nd,
      layerOpacity: layer.opacity,
      layerBlending: layer.blending,
      symbolCode: layer.symbol,
    });
    // B3/Item 3: overlay histogram filter.
    filters.push(buildOverlayHistFilter(atlas, layer.id, nFilled));
  }

  atlas.renderer.setPointSets(sets, filters);
  // C1: re-apply grid per-panel colors whenever point data changes.
  if (atlas.grid.enabled) atlas.applyGridToRenderer();
  // B5: push annotations to renderer for the leader-lines deck.gl layer.
  atlas.renderer.setAnnotations(atlas.annotations);
  // Re-apply any active search highlight after the point sets change (A7).
  if (atlas.searchMask && atlas.searchQuery && !atlas.searchLayerId) {
    const col = searchColumn(atlas);
    if (col !== null) runSearch(atlas, atlas.searchQuery, col);
  }
  // B3/Item 3: re-apply overlay search mask aligned to current PointSets.
  if (atlas.searchLayerId) {
    reapplyOverlaySearch(atlas, sets);
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
  // Settled but without a screen-space index (e.g. an anchors-only 3D layout that just
  // finished): build one, or hover and lasso don't work until the camera moves.
  else if (nd === 3 && atlas._3dScreenXY === null) on3DViewChange(atlas);

  // B2: update the 3D data bounding box / floor grid / gizmo.
  if (nd === 3) {
    const posXyz = showingAll(atlas) && atlas.allXY ? atlas.allXY : atlas.anchorXY;
    const nPts = showingAll(atlas) && atlas.allXY ? atlas.placedRows : nA;
    let extent3d: Extent3D | null = null;
    if (atlas.view.show3DDataBox ?? true) {
      extent3d = fullExtent3D(posXyz, nPts);
    }
    atlas.renderer.setDataBox(
      extent3d,
      (atlas.view.show3DFloorGrid ?? false) && extent3d !== null,
      (atlas.view.show3DGizmo ?? false) && extent3d !== null,
    );
  } else {
    // Clear 3D overlays when switching to 2D.
    atlas.renderer.setDataBox(null, false, false);
  }

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

/**
 * B3/Item 9: Split base PointSets by per-point symbol code.
 *
 * Returns [newSets, newFilters] where each base PointSet is replaced by one sub-PointSet
 * per unique symbol code value (each sub-set has symbolCode set, positions/colors/radii
 * subsampled to those points, and filter values subsampled accordingly).
 * Non-base PointSets (overlays) are passed through unchanged.
 */
function _splitBySymbolCode(
  sets: PointSet[],
  filters: (FilterAttribute | null)[],
  atlas: Atlas,
): [PointSet[], (FilterAttribute | null)[]] {
  const symAll = atlas.symbolValues;
  const symAnchors = atlas.symbolValuesAnchors;
  if (!symAll && !symAnchors) return [sets, filters];

  const newSets: PointSet[] = [];
  const newFilters: (FilterAttribute | null)[] = [];

  for (let si = 0; si < sets.length; si++) {
    const s = sets[si];
    // Only split base PointSets; overlays are handled separately.
    if (s.layerId !== 'base') {
      newSets.push(s);
      newFilters.push(filters[si]);
      continue;
    }
    // Determine which symbol codes array to use for this PointSet.
    const sym = s.id === 'all' ? symAll?.subarray(0, s.length) : symAnchors;
    if (!sym || sym.length !== s.length) {
      newSets.push(s);
      newFilters.push(filters[si]);
      continue;
    }
    const nd = s.positionStride ?? 2;
    const flt = filters[si];
    const precomputed = flt?.precomputed ?? null;

    // Count per unique code.
    const counts = new Map<number, number>();
    for (let i = 0; i < s.length; i++) {
      const c = sym[i];
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }

    // Build compact sub-arrays for each code.
    for (const [code, count] of counts) {
      const pos = new Float32Array(count * nd);
      const col = new Uint8Array(count * 4);
      const rad = s.radii ? new Float32Array(count) : undefined;
      const pre = precomputed ? new Float32Array(count) : undefined;
      let j = 0;
      for (let i = 0; i < s.length; i++) {
        if (sym[i] !== code) continue;
        for (let d = 0; d < nd; d++) pos[j * nd + d] = s.positions[i * nd + d];
        col[j * 4] = s.colors[i * 4];
        col[j * 4 + 1] = s.colors[i * 4 + 1];
        col[j * 4 + 2] = s.colors[i * 4 + 2];
        col[j * 4 + 3] = s.colors[i * 4 + 3];
        if (rad && s.radii) rad[j] = s.radii[i];
        if (pre && precomputed) pre[j] = precomputed[i];
        j++;
      }
      newSets.push({
        ...s,
        id: `${s.id}-sym${code}`,
        positions: pos,
        colors: col,
        length: count,
        radii: rad,
        symbolCode: code,
      });
      newFilters.push(pre
        ? { codes: new Uint16Array(count), hidden: new Set(), precomputed: pre }
        : null,
      );
    }
  }
  return [newSets, newFilters];
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
