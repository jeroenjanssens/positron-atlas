/**
 * Color column encoding, map palette, legend data.
 */

import type { Atlas } from '../atlas.svelte';
import type { ColorMeta, FileRef } from '../../shared/protocol';
import { encodeCategorical, encodeConstant, encodeNumeric, gatherRgba } from '../color/encode';
import { CATEGORICAL, DEFAULT_POINT_COLOR, hexToRgb } from '../color/colormaps';
import { mapPalette } from '../color/mapPalette';
import { placeGroupLabels } from '../labels/place';
import { vscode } from '../vscode';
import { fetchTyped } from '../vscode';
import { gatherU16, contrastText } from './utils';
import { applySelectionFade } from './selection';
import { plotBackground } from './render';

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

/** Point color of category i of the color column. */
export function categoryColor(atlas: Atlas, i: number): string {
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
