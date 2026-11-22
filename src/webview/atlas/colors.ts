/**
 * Color column encoding, map palette, legend data.
 * Also: size-by-column (A10) and histogram filter (A13).
 */

import type { Atlas } from '../atlas.svelte';
import type { ColorMeta, FileRef, SizeMeta, HistogramData } from '../../shared/protocol';
import { encodeCategorical, encodeConstant, encodeNumeric, gatherRgba } from '../color/encode';
import { CATEGORICAL, CVD_SAFE, DEFAULT_POINT_COLOR, NOISE_COLOR, hexToRgb } from '../color/colormaps';
import { mapPalette } from '../color/mapPalette';
import { placeGroupLabels } from '../labels/place';
import { vscode } from '../vscode';
import { fetchTyped } from '../vscode';
import { gatherU16, contrastText } from './utils';
import { applySelectionFade } from './selection';
import { plotBackground } from './render';

// ---- A6: Colour by cluster -------------------------------------------------------

/**
 * Enable or disable cluster colouring.  When enabled the colorColumn is unset so
 * the two paths do not conflict; when disabled a plain recolor restores the default.
 */
export function setColorByCluster(atlas: Atlas, on: boolean): void {
  atlas.colorByCluster = on;
  if (on) {
    // Suspend column-based colouring while cluster colours are active.
    atlas.colorColumn = null;
    atlas.colorMeta = null;
    atlas.colorValues = null;
    atlas.mapColors = null;
    recolorByClusters(atlas);
  } else {
    atlas.clusterPalette = null;
    atlas.recolor();
  }
}

/**
 * Encode cluster codes into RGBA, with the map palette (or CVD-safe palette),
 * grey noise points, then render.  Call after clusters are refreshed.
 */
export function recolorByClusters(atlas: Atlas): void {
  if (!atlas.colorByCluster || !atlas.cluster || !atlas.prepared || !atlas.anchorPos) {
    return;
  }
  const { codes, k } = atlas.cluster; // k = noise code
  const n = atlas.nKept;
  const palette = buildClusterPalette(atlas, k);
  // Store as single source of truth for legend, labels, and outlines.
  atlas.clusterPalette = palette;
  // codes[i] < k → cluster colour; codes[i] >= k → noise grey
  atlas.colorsAll = new Uint8Array(n * 4);
  const noiseRgb = hexToRgb(NOISE_COLOR);
  for (let i = 0; i < n; i++) {
    const c = codes[i];
    const o = i * 4;
    if (c >= k) {
      atlas.colorsAll[o] = noiseRgb[0];
      atlas.colorsAll[o + 1] = noiseRgb[1];
      atlas.colorsAll[o + 2] = noiseRgb[2];
      atlas.colorsAll[o + 3] = 200;
    } else {
      const hex = palette[c % palette.length];
      const [r, g, b] = hexToRgb(hex);
      atlas.colorsAll[o] = r;
      atlas.colorsAll[o + 1] = g;
      atlas.colorsAll[o + 2] = b;
      atlas.colorsAll[o + 3] = 255;
    }
  }
  applySelectionFade(atlas, atlas.colorsAll);
  atlas.colorsAnchors = atlas.prepared.needsProjection
    ? gatherRgba(atlas.colorsAll, atlas.anchorPos)
    : atlas.colorsAll;
  // Colour the outlines by cluster colour (each cluster may have multiple rings).
  const outlines = clusterOutlines(atlas);
  if (outlines) {
    atlas.renderer?.setOutlines(outlines.rings, undefined, outlines.colors);
  }
  atlas.render();
}

/**
 * Cluster outlines with one colour per ring (the cluster's palette colour), when points are
 * coloured by cluster; null otherwise. Used here and by the label update, which redraws outlines.
 */
export function clusterOutlines(atlas: Atlas): { rings: [number, number][][]; colors: [number, number, number, number][] } | null {
  const clusterRings = atlas.cluster?.outlines;
  if (!atlas.colorByCluster || !clusterRings || !clusterRings.length) {
    return null;
  }
  const palette = atlas.clusterPalette?.length ? atlas.clusterPalette : buildClusterPalette(atlas, clusterRings.length);
  const rings: [number, number][][] = [];
  const colors: [number, number, number, number][] = [];
  for (let ci = 0; ci < clusterRings.length; ci++) {
    const [r, g, b] = hexToRgb(palette[ci % palette.length]);
    for (const ring of clusterRings[ci]) {
      rings.push(ring);
      colors.push([r, g, b, 255]);
    }
  }
  return { rings, colors };
}

/** Build k colors for clusters using the active palette setting. */
function buildClusterPalette(atlas: Atlas, k: number): string[] {
  if (atlas.view.palette === 'cvd') {
    return Array.from({ length: k }, (_, i) => CVD_SAFE[i % CVD_SAFE.length]);
  }
  if (atlas.view.palette === 'map' && atlas.anchorXY && atlas.cluster) {
    // Use the map palette: derive centers from cluster codes on the anchor layout.
    const { codes: allCodes, codesAnchors } = atlas.cluster;
    const xy = atlas.anchorXY;
    const nA = atlas.prepared!.nAnchors;
    const centers = new Float64Array(k * 2).fill(NaN);
    for (const l of placeGroupLabels(xy, codesAnchors, nA, Array.from({ length: k }, (_, i) => String(i)))) {
      if (l.group < k) {
        centers[2 * l.group] = l.x;
        centers[2 * l.group + 1] = l.y;
      }
    }
    const dark = contrastText(plotBackground(atlas))[0] > 128;
    return mapPalette(centers, xy, nA, { dark }, (i) => CATEGORICAL[i % CATEGORICAL.length]);
  }
  // Tableau fallback.
  return Array.from({ length: k }, (_, i) => CATEGORICAL[i % CATEGORICAL.length]);
}

// ---- A10: Size by column ----------------------------------------------------------

export function setSizeColumn(atlas: Atlas, c: number | null): void {
  atlas.sizeColumn = c;
  atlas.sizeValues = null;
  if (c === null) {
    atlas.render();
  } else {
    atlas.requestSizes();
  }
}

export function requestSizes(atlas: Atlas): void {
  if (atlas.sizeColumn !== null && atlas.prepared) {
    vscode.post({ type: 'sizes', column: atlas.sizeColumn });
  }
}

export async function onSizes(atlas: Atlas, column: number, file: FileRef, _meta: SizeMeta): Promise<void> {
  if (column !== atlas.sizeColumn) return;
  const raw = (await fetchTyped(file.uri, 'f32')) as Float32Array;
  if (raw.length !== atlas.nKept) return; // stale
  // Square-root scale: radius = pointSize * sqrt(normalised(v))
  // Clamp raw to [q01, q99] from meta, then sqrt-normalise to [0.5, 1.5] * pointSize.
  atlas.sizeValues = raw;
  atlas.render();
}

/**
 * Compute per-point radii in pixels (A10): sqrt scale, clamped to [0.5, 10] × pointSize/3.
 * Returns null when no size column is active.
 */
export function buildRadii(atlas: Atlas, length: number, offset = 0): Float32Array | null {
  if (!atlas.sizeValues || atlas.sizeColumn === null) return null;
  const vals = atlas.sizeValues;
  if (vals.length < offset + length) return null;
  // Determine clamp range from the full column (simple min/max percentile scan).
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v === v && isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
  }
  const span = max > min ? max - min : 1;
  const base = atlas.view.pointSize;
  const radii = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const v = vals[offset + i];
    const norm = v !== v ? 0 : Math.max(0, Math.min(1, (v - min) / span));
    // sqrt maps [0,1] → [0,1]; scale to [0.5, 1.5] × base/2 pixel radii
    radii[i] = Math.max(0.5, Math.sqrt(norm) * base);
  }
  return radii;
}

// ---- A13: Histogram filter --------------------------------------------------------

export function setHistColumn(atlas: Atlas, c: number | null): void {
  if (c === null) {
    atlas.histFilter = null;
    atlas.histData = null;
    atlas.histRawValues = null;
    atlas.histRawColumn = null;
    atlas.render();
    return;
  }
  // Keep existing range if same column, else reset.
  if (atlas.histFilter?.column !== c) {
    atlas.histFilter = null;
  }
  // Trigger kernel histogram computation and raw value fetch.
  if (atlas.prepared) {
    vscode.post({ type: 'histogram', column: c, nBins: 50 });
    vscode.post({ type: 'histValues', column: c });
  }
}

export function requestHistogram(atlas: Atlas): void {
  const col = atlas.histFilter?.column;
  if (col !== undefined && col !== null && atlas.prepared) {
    vscode.post({ type: 'histogram', column: col, nBins: 50 });
    vscode.post({ type: 'histValues', column: col });
  }
}

export function onHistogram(atlas: Atlas, column: number, data: HistogramData): void {
  atlas.histData = data;
  // If no range is set yet, default to the full range.
  if (!atlas.histFilter || atlas.histFilter.column !== column) {
    const lo = data.edges[0];
    const hi = data.edges[data.edges.length - 1];
    atlas.histFilter = { column, range: [lo, hi] };
  }
  atlas.render();
}

export async function onHistValues(atlas: Atlas, column: number, file: FileRef): Promise<void> {
  if (atlas.histFilter?.column !== column && atlas.histRawColumn !== column) return;
  const raw = (await fetchTyped(file.uri, 'f32')) as Float32Array;
  if (raw.length !== atlas.nKept) return; // stale
  atlas.histRawValues = raw;
  atlas.histRawColumn = column;
  atlas.render();
}

export function setHistRange(atlas: Atlas, range: [number, number] | null): void {
  const before = atlas.histFilter;
  if (range === null || !atlas.histFilter) {
    atlas.histFilter = null;
  } else {
    atlas.histFilter = { ...atlas.histFilter, range };
  }
  const after = atlas.histFilter;
  atlas.render();
  atlas.recordHistory({
    label: range === null ? 'Clear histogram filter' : 'Set histogram range',
    undo: () => { atlas.histFilter = before; atlas.render(); },
    redo: () => { atlas.histFilter = after; atlas.render(); },
    coalesceKey: 'histRange',
  });
}

/**
 * Build a Float32Array of histogram filter values (1 = in brush range, 0 = outside) for a
 * point set, given the per-kept-row raw column values for the hist column (A13).
 * Returns null when no histogram filter is active or values not yet loaded.
 */
export function buildHistFilterValues(atlas: Atlas, length: number, offset = 0): Float32Array | null {
  if (!atlas.histFilter || !atlas.histData) return null;
  const { column, range } = atlas.histFilter;
  if (!atlas.histRawValues || atlas.histRawColumn !== column) return null;
  const vals = atlas.histRawValues;
  if (vals.length < offset + length) return null;
  const [lo, hi] = range;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const v = vals[offset + i];
    out[i] = v !== v ? 0 : v >= lo && v <= hi ? 1 : 0;
  }
  return out;
}

export function setColorColumn(atlas: Atlas, c: number | null): void {
  atlas.colorColumn = c;
  atlas.forceCategorical = false;
  atlas.colorMeta = null;
  atlas.colorValues = null;
  atlas.mapColors = null;
  if (c === null) {
    atlas.recolor();
  } else {
    atlas.requestColors();
  }
}

export function requestColors(atlas: Atlas): void {
  if (atlas.colorColumn !== null && atlas.prepared) {
    vscode.post({ type: 'colors', column: atlas.colorColumn, forceCategorical: atlas.forceCategorical });
  }
}

export async function onColors(atlas: Atlas, column: number, file: FileRef, meta: ColorMeta): Promise<void> {
  if (column !== atlas.colorColumn) {
    return;
  }
  const values = await fetchTyped(file.uri, file.dtype);
  if (values.length !== atlas.nKept) {
    return; // stale (from a previous prepare)
  }
  atlas.colorValues = values as Float32Array | Uint16Array;
  atlas.colorMeta = meta;
  atlas.colorRange = meta.kind === 'numeric' ? [meta.q02 ?? meta.min ?? 0, meta.q98 ?? meta.max ?? 1] : null;
  atlas.mapColors = null;
  if (atlas.phase === 'ready') {
    atlas.updateMapColors(false);
  }
  atlas.recolor();
}

export function recolor(atlas: Atlas): void {
  if (!atlas.prepared || !atlas.anchorPos) {
    return;
  }
  const n = atlas.nKept;
  const meta = atlas.colorMeta;
  if (!atlas.colorValues || !meta) {
    atlas.colorsAll = encodeConstant(n, DEFAULT_POINT_COLOR);
  } else if (meta.kind === 'numeric') {
    const [lo, hi] = atlas.colorRange ?? [meta.min ?? 0, meta.max ?? 1];
    atlas.colorsAll = encodeNumeric(atlas.colorValues as Float32Array, lo, hi, atlas.view.colormap, atlas.colorsAll ?? undefined);
  } else {
    atlas.colorsAll = encodeCategorical(atlas.colorValues as Uint16Array, meta.categories.length, atlas.colorsAll ?? undefined, (i) => atlas.categoryColor(i));
  }
  applySelectionFade(atlas, atlas.colorsAll);
  atlas.colorsAnchors = atlas.prepared.needsProjection ? gatherRgba(atlas.colorsAll, atlas.anchorPos) : atlas.colorsAll;
  atlas.render();
}

/** Point color of category i of the color column (or cluster i when colorByCluster). */
export function categoryColor(atlas: Atlas, i: number): string {
  // A6: cluster colours are the single source of truth when colorByCluster is active.
  if (atlas.colorByCluster && atlas.clusterPalette && i < atlas.clusterPalette.length) {
    return atlas.clusterPalette[i];
  }
  if (atlas.view.palette === 'map' && atlas.mapColors && i < atlas.mapColors.length) {
    return atlas.mapColors[i];
  }
  return CATEGORICAL[i % CATEGORICAL.length];
}

/**
 * Recompute the map-following palette from the current layout (when it settles, not on every
 * animation frame, so colors stay put while the layout converges), then recolor if asked.
 */
export function updateMapColors(atlas: Atlas, recolorFlag = true): void {
  const meta = atlas.colorMeta;
  if (atlas.view.palette !== 'map' || meta?.kind !== 'categorical' || !atlas.colorValues || !atlas.prepared || !atlas.anchorXY || !atlas.anchorPos) {
    return;
  }
  let xy: Float32Array;
  let codes: Uint16Array;
  let n: number;
  if (atlas.projection === 'done' && atlas.allXY) {
    [xy, codes, n] = [atlas.allXY, atlas.colorValues as Uint16Array, atlas.nKept];
  } else {
    const all = atlas.colorValues as Uint16Array;
    [xy, codes, n] = [atlas.anchorXY, atlas.prepared.needsProjection ? gatherU16(all, atlas.anchorPos) : all, atlas.prepared.nAnchors];
  }
  const k = meta.categories.length;
  const centers = new Float64Array(k * 2).fill(NaN);
  for (const l of placeGroupLabels(xy, codes, n, meta.categories)) {
    centers[2 * l.group] = l.x;
    centers[2 * l.group + 1] = l.y;
  }
  const dark = contrastText(plotBackground(atlas))[0] > 128;
  atlas.mapColors = mapPalette(centers, xy, n, { dark }, (i) => CATEGORICAL[i % CATEGORICAL.length]);
  if (recolorFlag) {
    atlas.recolor();
  }
}

// ---- legend toggles (L1) ---------------------------------------------------------

/**
 * Toggle visibility of a category in the current color column.
 * When solo=true (alt-click), isolate that category (hide all others).
 * When all are hidden after a solo, show all instead.
 */
export function toggleCategory(atlas: Atlas, catIndex: number, solo: boolean): void {
  const col = atlas.colorColumn;
  if (col === null || !atlas.colorMeta || atlas.colorMeta.kind !== 'categorical') return;
  const k = atlas.colorMeta.categories.length;
  const existing = atlas.hiddenCategories.get(col) ?? new Set<number>();
  const before = new Map(atlas.hiddenCategories);

  let next: Set<number>;
  if (solo) {
    // Alt-click: hide all except catIndex; if already isolating this one, show all.
    const allOthersHidden = existing.size === k - 1 && !existing.has(catIndex);
    if (allOthersHidden) {
      next = new Set();
    } else {
      next = new Set<number>();
      for (let i = 0; i < k; i++) {
        if (i !== catIndex) next.add(i);
      }
    }
  } else {
    // Regular click: toggle this category.
    next = new Set(existing);
    if (next.has(catIndex)) {
      next.delete(catIndex);
    } else {
      next.add(catIndex);
    }
  }

  const newMap = new Map(atlas.hiddenCategories);
  if (next.size === 0) {
    newMap.delete(col);
  } else {
    newMap.set(col, next);
  }
  atlas.hiddenCategories = newMap;
  atlas.render();

  const categoryName = atlas.colorMeta.kind === 'categorical' ? (atlas.colorMeta.categories[catIndex] ?? String(catIndex)) : String(catIndex);
  const isNowHidden = next.has(catIndex);
  const after = new Map(atlas.hiddenCategories);
  atlas.recordHistory({
    label: isNowHidden ? `Hide category "${categoryName}"` : `Show category "${categoryName}"`,
    undo: () => { atlas.hiddenCategories = new Map(before); atlas.render(); },
    redo: () => { atlas.hiddenCategories = new Map(after); atlas.render(); },
  });
}
