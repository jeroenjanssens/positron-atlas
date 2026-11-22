/**
 * Label placement: label source, label codes, updateLabels.
 * Implements A2 (typography), A3 (draggable labels), A8 (multi-level), A9 (highlighted badges),
 * A11 (labels around the map with leader lines).
 */

import { clusterOutlines } from './colors';
import type { Atlas } from '../atlas.svelte';
import type { ColorMeta, FileRef, LabelOptions } from '../../shared/protocol';
import { vscode, fetchTyped } from '../vscode';
import { collisionPriorities, labelSizes, placeGroupLabels } from '../labels/place';
import { hexToRgb } from '../color/colormaps';
import { toHex } from '../logic';
import { gatherU16, contrastText, labelTextColor, fontFamily as editorFontFamily } from './utils';
import { plotBackground, fitForLabelStyle } from './render';
import { MAX_LABELS, LABEL_INTERVAL_MS } from './types';
import { ensureFont } from '../fonts';
import type { MapLabel } from '../render/renderer';
import { buildAroundLabelGroups } from '../labels/around';

// ---------------------------------------------------------------------------
// Weight range helpers (A2)
// ---------------------------------------------------------------------------

/**
 * Per-label font weight interpolated from minWeight (smallest group) to maxWeight (largest group),
 * proportional to the square root of the count. Only 3 distinct buckets are exposed to deck.gl
 * since each TextLayer weight generates a separate glyph atlas.
 *
 * Exported so vitest can test it.
 */
export function weightRange(counts: number[], minWeight: number, maxWeight: number): number[] {
  if (counts.length === 0) return [];
  if (minWeight === maxWeight) return counts.map(() => minWeight);
  const top = Math.sqrt(Math.max(...counts, 0));
  if (top <= 0) return counts.map(() => minWeight);
  // Quantize into 3 buckets to limit the number of TextLayers.
  const buckets = [minWeight, Math.round((minWeight + maxWeight) / 2 / 100) * 100, maxWeight];
  return counts.map((c) => {
    const t = Math.sqrt(Math.max(0, c)) / top;
    const idx = t < 0.33 ? 0 : t < 0.67 ? 1 : 2;
    return buckets[idx];
  });
}

// ---------------------------------------------------------------------------
// Drag offset helpers (A3)
// ---------------------------------------------------------------------------

/**
 * Match stored drag offsets (keyed by group name) to new group names after reclustering.
 * Exact name matches are retained; unmatched names are dropped.
 */
export function matchDragOffsets(
  offsets: Record<string, [number, number]> | undefined,
  newNames: string[],
): Record<string, [number, number]> {
  if (!offsets) return {};
  const result: Record<string, [number, number]> = {};
  for (const name of newNames) {
    if (offsets[name]) result[name] = offsets[name];
  }
  return result;
}

/** Set or clear the drag offset for a label (A3/B5). Called from atlas methods.
 *  Offsets are in map coordinates (world units) since B5. */
export function setDragOffset(atlas: Atlas, key: string, offset: [number, number] | null): void {
  const existing = atlas.labels.dragOffsets ?? {};
  if (offset === null) {
    const next = { ...existing };
    delete next[key];
    atlas.labels = { ...atlas.labels, dragOffsets: next, dragOffsetsVersion: 'v2map' };
  } else {
    atlas.labels = { ...atlas.labels, dragOffsets: { ...existing, [key]: offset }, dragOffsetsVersion: 'v2map' };
  }
  atlas.persist();
  updateLabels(atlas);
}

/** Clear all drag offsets (A3/B5). Called from "Reset all label positions" button. */
export function resetAllDragOffsets(atlas: Atlas): void {
  atlas.labels = { ...atlas.labels, dragOffsets: {}, dragOffsetsVersion: 'v2map' };
  atlas.persist();
  updateLabels(atlas);
}

/**
 * Freeze the current around-label layout (Q14 / B5).
 * Stores the current on-screen around-label positions as absolute world coordinates.
 * After freezing, the labels don't move with the auto-computed ring; they behave like dragged labels.
 * @param aroundLabelGroups – the current computed around-label data from atlas.aroundLabelGroups
 * @param projectWorld – the renderer's projectWorld function (inverse: unproject is passed separately)
 * @param unproject – the renderer's unproject function
 */
export function freezeAroundLayout(
  atlas: Atlas,
  screenPositions: Record<string, [number, number]>,
): void {
  if (Object.keys(screenPositions).length === 0) return;
  const renderer = atlas.renderer;
  if (!renderer) return;
  const frozen: Record<string, [number, number]> = {};
  for (const [key, [sx, sy]] of Object.entries(screenPositions)) {
    const world = renderer.unproject(sx, sy);
    frozen[key] = world;
  }
  atlas.labels = { ...atlas.labels, frozenAroundLayout: frozen };
  atlas.persist();
}

/** Clear the frozen around-label layout (Q14). */
export function thawAroundLayout(atlas: Atlas): void {
  atlas.labels = { ...atlas.labels, frozenAroundLayout: undefined };
  atlas.persist();
}

// ---------------------------------------------------------------------------
// Fine-column codes (A8)
// ---------------------------------------------------------------------------

/** Fetch and store label codes for the secondary (fine) column (A8). */
export function requestFineLabelCodes(atlas: Atlas): void {
  const fc = atlas.labels.fineColumn;
  if (fc !== null && fc !== undefined && !atlas.labels.clusters && atlas.prepared) {
    vscode.post({ type: 'labelCodes', column: fc, maxCategories: MAX_LABELS, purpose: 'labels' });
  }
}

// ---------------------------------------------------------------------------
// Source / options setters
// ---------------------------------------------------------------------------

export function setLabelSource(atlas: Atlas, source: number | 'clusters' | null): void {
  const clusters = source === 'clusters';
  atlas.labels = { ...atlas.labels, column: typeof source === 'number' ? source : null, clusters };
  atlas.labelCount = 0;
  atlas.renderer?.setLabels([]);
  atlas.renderer?.setOutlines([]);
  atlas.labelMeta = null;
  atlas.labelCodes = null;
  atlas.labelCodesAnchors = null;
  atlas.fineLabelCodes = null;
  atlas.fineLabelCodesAnchors = null;
  atlas.fineLabelMeta = null;
  if (typeof source === 'number') {
    requestLabelCodes(atlas);
  } else if (clusters) {
    atlas.refreshClusters();
  }
  updateLabels(atlas);
}

export function setLabelColumn(atlas: Atlas, c: number | null): void {
  setLabelSource(atlas, c);
}

/**
 * Label option keys that are purely display-only (do not trigger kernel requests or
 * cluster recomputation that is hard to undo).  Changes to these keys are recorded
 * in the undo history.
 */
const UNDOABLE_LABEL_OPTION_KEYS = new Set<keyof LabelOptions>([
  'minSize', 'maxSize', 'fontFamily', 'fontWeight', 'minFontWeight', 'maxFontWeight',
  'haloWidth', 'haloColor', 'lineSpacing', 'wrapWidth', 'textCase', 'colorText',
  'outlines', 'labelStyle', 'leaderStyle', 'leaderColor', 'leaderWidth', 'highlightGroups',
  'detail', 'multiLevel',
]);

export function setLabelOptions(atlas: Atlas, o: Partial<LabelOptions>): void {
  const prev = atlas.labels;

  // Decide whether to record history before applying the change.
  const changedKeys = (Object.keys(o) as (keyof LabelOptions)[]).filter(k => (o as unknown as Record<string, unknown>)[k] !== (prev as unknown as Record<string, unknown>)[k]);
  const isUndoable = changedKeys.length > 0 && changedKeys.every(k => UNDOABLE_LABEL_OPTION_KEYS.has(k));
  const beforeLabels = isUndoable ? { ...prev } : null;

  atlas.labels = { ...atlas.labels, ...o };
  if (atlas.labels.clusters && o.detail !== undefined && o.detail !== prev.detail) {
    atlas.refreshClusters();
  } else if (atlas.labels.clusters && o.multiLevel !== undefined && o.multiLevel !== prev.multiLevel) {
    atlas.refreshClusters();
  } else if (atlas.labels.clusters && o.nameBy !== undefined && o.nameBy !== prev.nameBy) {
    atlas.nameClusters();
  } else if (!atlas.labels.clusters && o.fineColumn !== undefined && o.fineColumn !== prev.fineColumn) {
    requestFineLabelCodes(atlas);
  }
  updateLabels(atlas);

  if (isUndoable && beforeLabels) {
    const afterLabels = { ...atlas.labels };
    const firstKey = changedKeys[0]!;
    atlas.recordHistory({
      label: labelOptionHistoryLabel(firstKey, changedKeys),
      undo: () => { atlas.labels = beforeLabels; updateLabels(atlas); },
      redo: () => { atlas.labels = afterLabels; updateLabels(atlas); },
      coalesceKey: `labelOptions:${changedKeys.sort().join(',')}`,
    });
  }
}

function labelOptionHistoryLabel(firstKey: keyof LabelOptions, keys: (keyof LabelOptions)[]): string {
  if (keys.length > 1) return 'Change label options';
  const map: Partial<Record<keyof LabelOptions, string>> = {
    minSize: 'Change smallest label size',
    maxSize: 'Change largest label size',
    fontFamily: 'Change label font',
    fontWeight: 'Change label font weight',
    minFontWeight: 'Change label min font weight',
    maxFontWeight: 'Change label max font weight',
    haloWidth: 'Change label halo width',
    haloColor: 'Change label halo color',
    lineSpacing: 'Change label line spacing',
    wrapWidth: 'Change label wrap width',
    textCase: 'Change label case',
    colorText: 'Change colored labels',
    outlines: 'Toggle cluster outlines',
    labelStyle: 'Change label style',
    leaderStyle: 'Change leader style',
    leaderColor: 'Change leader color',
    leaderWidth: 'Change leader width',
    highlightGroups: 'Change highlighted labels',
    detail: 'Change cluster detail',
    multiLevel: 'Toggle multi-level labels',
  };
  return map[firstKey] ?? 'Change label options';
}

export function requestLabelCodes(atlas: Atlas): void {
  if (atlas.labels.column !== null && !atlas.labels.clusters && atlas.prepared) {
    vscode.post({ type: 'labelCodes', column: atlas.labels.column, maxCategories: MAX_LABELS });
  }
}

export async function onLabelCodes(atlas: Atlas, column: number, file: FileRef, meta: ColorMeta, purpose: 'labels' | 'names'): Promise<void> {
  if (meta.kind !== 'categorical') {
    return;
  }
  const wanted = purpose === 'names' ? atlas.labels.clusters && atlas.labels.nameBy === column : !atlas.labels.clusters && (column === atlas.labels.column || column === atlas.labels.fineColumn);
  if (!wanted) {
    return;
  }
  const codes = (await fetchTyped(file.uri, 'u16')) as Uint16Array;
  if (codes.length !== atlas.nKept || !atlas.anchorPos) {
    return; // stale
  }
  if (purpose === 'names') {
    if (atlas.labels.clusters && atlas.labels.nameBy === column) {
      atlas.nameSource = { column, codes, meta };
      atlas.nameClusters();
      updateLabels(atlas);
    }
    return;
  }
  if (atlas.labels.clusters) return;

  const isFine = column === atlas.labels.fineColumn && column !== atlas.labels.column;
  if (isFine) {
    atlas.fineLabelCodes = codes;
    atlas.fineLabelCodesAnchors = atlas.prepared?.needsProjection ? gatherU16(codes, atlas.anchorPos) : codes;
    atlas.fineLabelMeta = meta;
  } else if (column === atlas.labels.column) {
    atlas.labelCodes = codes;
    atlas.labelCodesAnchors = atlas.prepared?.needsProjection ? gatherU16(codes, atlas.anchorPos) : codes;
    atlas.labelMeta = meta;
  }
  updateLabels(atlas);
}

/** Recompute labels now, or soon (throttled) while the layout animates. */
export function scheduleLabels(atlas: Atlas): void {
  if (atlas.labels.column === null && !atlas.labels.clusters && atlas.labelCount === 0) {
    return;
  }
  const wait = atlas.labelAt + LABEL_INTERVAL_MS - performance.now();
  if (atlas.phase !== 'embedding' || wait <= 0) {
    updateLabels(atlas);
  } else if (atlas.labelTimer === undefined) {
    atlas.labelTimer = setTimeout(() => updateLabels(atlas), wait);
  }
}

// ---------------------------------------------------------------------------
// labelGroups: returns the main group codes/names for the current label mode
// ---------------------------------------------------------------------------

function labelGroups(atlas: Atlas): { all: Uint16Array; anchors: Uint16Array; names: string[] } | null {
  if (atlas.labels.clusters) {
    const c = atlas.cluster;
    return c && atlas.clusterNames.length === c.k ? { all: c.codes, anchors: c.codesAnchors, names: atlas.clusterNames } : null;
  }
  if (atlas.labels.column !== null && atlas.labelMeta && atlas.labelCodes && atlas.labelCodesAnchors) {
    return { all: atlas.labelCodes, anchors: atlas.labelCodesAnchors, names: atlas.labelMeta.categories };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Font resolution (A2)
// ---------------------------------------------------------------------------

function resolvedFontFamily(atlas: Atlas): string {
  const ff = atlas.labels.fontFamily;
  return ff && ff !== '' ? ff : editorFontFamily();
}

/** Ensure the configured font is loaded before we render labels. */
async function ensureLabelFont(atlas: Atlas): Promise<void> {
  const ff = atlas.labels.fontFamily;
  if (!ff || ff === '') return; // editor font is already available
  try {
    const weight = atlas.labels.fontWeight ?? 600;
    const minW = atlas.labels.minFontWeight ?? weight;
    const maxW = atlas.labels.maxFontWeight ?? weight;
    const weights = Array.from(new Set([minW, Math.round((minW + maxW) / 2 / 100) * 100, maxW, weight])).filter((w) => w >= 100 && w <= 900);
    await ensureFont(ff, weights);
  } catch {
    // Font unavailable: fall back to editor font silently.
  }
}

// ---------------------------------------------------------------------------
// updateLabels: main placement + render call
// ---------------------------------------------------------------------------

/** Place the labels on the points currently shown and hand them to the renderer. */
export function updateLabels(atlas: Atlas): void {
  clearTimeout(atlas.labelTimer);
  atlas.labelTimer = undefined;
  atlas.labelAt = performance.now();
  if (!atlas.renderer) {
    return;
  }
  const groups = labelGroups(atlas);
  if (!groups || !atlas.prepared || !atlas.anchorXY) {
    if (atlas.labels.column === null && !atlas.labels.clusters) {
      atlas.labelCount = 0;
      atlas.renderer.setLabels([]);
      atlas.renderer.setOutlines([]);
    }
    return;
  }

  const opts = atlas.labels;
  const background = atlas.plotBackground();
  const plain = contrastText(background);
  const cm = atlas.colorMeta;
  const colorIndex =
    !opts.clusters && opts.colorText && opts.column === atlas.colorColumn && cm?.kind === 'categorical'
      ? new Map(cm.categories.map((c, i) => [c, i]))
      : null;

  // ---- Place main (coarse) labels ----
  const placed =
    atlas.projection === 'done' && atlas.allXY
      ? placeGroupLabels(atlas.allXY, groups.all, atlas.nKept, groups.names)
      : placeGroupLabels(atlas.anchorXY, groups.anchors, atlas.prepared.nAnchors, groups.names);

  const counts = placed.map((l) => l.count);
  const sizes = labelSizes(counts, opts.minSize, opts.maxSize);
  const weights = weightRange(counts, opts.minFontWeight ?? (opts.fontWeight ?? 600), opts.maxFontWeight ?? (opts.fontWeight ?? 600));

  // ---- Place fine labels (A8) ----
  let finePlaced: ReturnType<typeof placeGroupLabels> = [];
  let fineSizes: number[] = [];
  let fineWeights: number[] = [];

  if (opts.clusters && opts.multiLevel && atlas.clusterFine) {
    // Fine cluster labels from the second (finer) clustering.
    const fc = atlas.clusterFine;
    const fineNames = atlas.clusterFineNames;
    if (fineNames.length === fc.k) {
      const fineGroups = {
        all: fc.codes,
        anchors: fc.codesAnchors,
        names: fineNames,
      };
      finePlaced =
        atlas.projection === 'done' && atlas.allXY
          ? placeGroupLabels(atlas.allXY, fineGroups.all, atlas.nKept, fineGroups.names)
          : placeGroupLabels(atlas.anchorXY, fineGroups.anchors, atlas.prepared.nAnchors, fineGroups.names);
      const fineCounts = finePlaced.map((l) => l.count);
      fineSizes = labelSizes(fineCounts, Math.max(6, opts.minSize - 2), opts.minSize + 4);
      fineWeights = weightRange(fineCounts, opts.minFontWeight ?? 400, opts.fontWeight ?? 600);
    }
  } else if (!opts.clusters && opts.fineColumn !== null && opts.fineColumn !== undefined && atlas.fineLabelMeta && atlas.fineLabelCodes && atlas.fineLabelCodesAnchors) {
    // Fine column labels.
    const fineGroups = {
      all: atlas.fineLabelCodes,
      anchors: atlas.fineLabelCodesAnchors,
      names: atlas.fineLabelMeta.categories,
    };
    finePlaced =
      atlas.projection === 'done' && atlas.allXY
        ? placeGroupLabels(atlas.allXY, fineGroups.all, atlas.nKept, fineGroups.names)
        : placeGroupLabels(atlas.anchorXY, fineGroups.anchors, atlas.prepared.nAnchors, fineGroups.names);
    const fineCounts = finePlaced.map((l) => l.count);
    fineSizes = labelSizes(fineCounts, Math.max(6, opts.minSize - 2), opts.minSize + 4);
    fineWeights = weightRange(fineCounts, opts.minFontWeight ?? 400, opts.fontWeight ?? 600);
  }

  // ---- Collision priorities with levels for multi-level (A8) ----
  const allCounts = [...counts, ...finePlaced.map((l) => l.count)];
  const allLevels = [...counts.map(() => 1), ...finePlaced.map(() => 0)]; // coarse = level 1 (wins), fine = level 0
  const allPriorities = finePlaced.length > 0
    ? collisionPriorities(allCounts, allLevels)
    : collisionPriorities(counts);

  // ---- Drag offsets (A3/B5: map-coordinate offsets) ----
  const dragOffsets = opts.dragOffsets ?? {};

  // ---- Zoom-dependent fine label opacity (A8) ----
  // Fine labels fade in between fittedZoom+1 and fittedZoom+1.5.
  // At the overview zoom, fine labels are invisible; they appear as the user zooms in.
  let fineAlpha = 1; // 0=invisible, 1=fully visible
  if (finePlaced.length > 0) {
    const fz = atlas.fittedZoom; // atlas.fittedZoom is preserved (harness-accessible)
    const cz = atlas.renderer.currentZoom();
    if (Number.isFinite(fz)) {
      const delta = cz - (fz + 1.0); // positive once zoomed in past threshold
      fineAlpha = Math.min(1, Math.max(0, delta / 0.5)); // fade over 0.5 zoom levels
    }
  }

  // ---- Highlight groups (A9) ----
  const highlightSet = new Set(opts.highlightGroups ?? []);
  // Badge fill for groups without a category colour (e.g. automatic clusters): the mean colour
  // of the group's points, darkened until white text on it is readable.
  const groupColor =
    highlightSet.size > 0 && atlas.colorsAnchors
      ? groupMeanColors(groups.anchors, atlas.colorsAnchors, groups.names.length)
      : null;

  // ---- Apply text case (A2) ----
  const applyCase = (text: string): string => opts.textCase === 'upper' ? text.toUpperCase() : text;

  // ---- A11: around mode ----
  // When labelStyle === 'around', build world-space group data for the AroundLabelsOverlay
  // and skip the deck.gl TextLayer.  Fine labels are not shown in around mode.
  const isAround = opts.labelStyle === 'around';
  const wasAround = atlas.aroundLabelGroups !== null;

  if (isAround) {
    // Per-label cluster hex color (for leader lines colored like the cluster).
    const clusterColors: (string | null)[] = placed.map((l) => {
      const ci = colorIndex?.get(l.text);
      if (ci !== undefined) return atlas.categoryColor(ci);
      const gi = groups.names.indexOf(l.text);
      if (atlas.labels.clusters && atlas.clusterPalette && gi >= 0) {
        return atlas.clusterPalette[gi] ?? null;
      }
      return null;
    });
    const rawColors: [number, number, number, number][] = placed.map((l) => {
      const ci = colorIndex?.get(l.text);
      return ci !== undefined ? labelTextColor(hexToRgb(atlas.categoryColor(ci)), plain) : plain;
    });
    const rawBadges: (([number, number, number, number]) | undefined)[] = placed.map((l) => {
      const rawText = l.text === '' ? '(empty)' : l.text;
      const isHighlighted = highlightSet.has(rawText) || highlightSet.has(l.text);
      if (!isHighlighted) return undefined;
      const ci = colorIndex?.get(l.text);
      const gi = groups.names.indexOf(l.text);
      return ci !== undefined
        ? [...readableBadge(hexToRgb(atlas.categoryColor(ci))), 230] as [number, number, number, number]
        : groupColor && gi >= 0 && groupColor[gi]
          ? [...readableBadge(groupColor[gi]!), 230] as [number, number, number, number]
          : [...readableBadge([110, 110, 110]), 230] as [number, number, number, number];
    });
    atlas.aroundLabelGroups = buildAroundLabelGroups(
      placed, sizes, rawColors, clusterColors, weights, allPriorities.slice(0, placed.length), rawBadges, applyCase,
    );
    atlas.labelCount = placed.length;

    // Clear deck.gl labels (around mode uses the HTML overlay instead).
    atlas.renderer.setLabels([], undefined);

    // Re-fit with extra margin when first switching to around mode so the ring of
    // labels lands outside the visible cloud (respects userMoved via force=false).
    if (!wasAround) fitForLabelStyle(atlas, true);

    // Show outlines as normal.
    const showOutlines = opts.clusters && opts.outlines && atlas.cluster && atlas.phase !== 'embedding';
    const coloured = showOutlines ? clusterOutlines(atlas) : null;
    if (coloured) {
      atlas.renderer.setOutlines(coloured.rings, undefined, coloured.colors);
    } else {
      atlas.renderer.setOutlines(showOutlines ? atlas.cluster!.outlines.flat() : [], [plain[0], plain[1], plain[2]]);
    }
    return;
  }

  // ---- 'over' mode: clear around labels if switching back ----
  if (atlas.aroundLabelGroups !== null) {
    atlas.aroundLabelGroups = null;
    // Restore normal fit (no extra margin) when leaving around mode.
    fitForLabelStyle(atlas, false);
  }

  // ---- Build MapLabel array ----
  const out: MapLabel[] = [];

  for (let i = 0; i < placed.length; i++) {
    const l = placed[i];
    const rawText = l.text === '' ? '(empty)' : l.text;
    const text = applyCase(rawText);
    const ci = colorIndex?.get(l.text);
    const baseColor = ci !== undefined ? labelTextColor(hexToRgb(atlas.categoryColor(ci)), plain) : plain;

    // Apply drag offset (B5: offset is in map/world coordinates, applied directly).
    const offset = dragOffsets[rawText] ?? dragOffsets[l.text];
    const position: [number, number] = offset
      ? [l.x + offset[0], l.y + offset[1]]
      : [l.x, l.y];

    const isHighlighted = highlightSet.has(rawText) || highlightSet.has(l.text);
    const gi = groups.names.indexOf(l.text);
    const badge: [number, number, number, number] | undefined = !isHighlighted
      ? undefined
      : ci !== undefined
      ? [...readableBadge(hexToRgb(atlas.categoryColor(ci))), 230]
      : groupColor && gi >= 0 && groupColor[gi]
      ? [...readableBadge(groupColor[gi]!), 230]
      : [...readableBadge([110, 110, 110]), 230];

    out.push({
      text,
      position,
      size: sizes[i],
      color: isHighlighted ? [255, 255, 255, 255] : baseColor,
      priority: allPriorities[i],
      weight: weights[i],
      badge,
      key: rawText,
    });
  }

  // ---- Add fine labels (A8) ----
  // Skip entirely when alpha is 0 (at overview zoom, avoids polluting collision budget).
  if (fineAlpha > 0) {
    const fineA = Math.round(255 * fineAlpha);
    for (let i = 0; i < finePlaced.length; i++) {
      const l = finePlaced[i];
      const rawText = l.text === '' ? '(empty)' : l.text;
      const text = applyCase(rawText);
      const offset = dragOffsets[rawText];
      const position: [number, number] = offset
        ? [l.x + offset[0], l.y + offset[1]]
        : [l.x, l.y];

      const isHighlighted = highlightSet.has(rawText);
      const baseColor: [number, number, number, number] = [plain[0], plain[1], plain[2], fineA];
      out.push({
        text,
        position,
        size: fineSizes[i],
        color: isHighlighted ? [255, 255, 255, fineA] : baseColor,
        priority: allPriorities[counts.length + i],
        weight: fineWeights[i],
        badge: isHighlighted ? ([...plain.slice(0, 3), Math.round(200 * fineAlpha)] as [number, number, number, number]) : undefined,
        key: rawText,
      });
    }
  }

  atlas.labelCount = out.length;

  // ---- Halo color (A2) ----
  const haloColor = opts.haloColor && opts.haloColor !== ''
    ? [...hexToRgb(opts.haloColor), 220] as [number, number, number, number]
    : [...hexToRgb(toHex(background)), 220] as [number, number, number, number];

  const labelStyle = {
    outline: haloColor,
    fontFamily: resolvedFontFamily(atlas),
    fontWeight: opts.fontWeight ?? 600,
    haloWidth: opts.haloWidth ?? 10,
    lineHeight: opts.lineSpacing ?? 0.95,
    maxWidth: opts.wrapWidth ?? 9,
    // B5 (Q13): 'common' scales text with zoom; 'pixels' keeps size constant.
    sizeUnits: (opts.scaleTextWithZoom ? 'common' : 'pixels') as 'pixels' | 'common',
  };

  // Font must be loaded before deck.gl rasterizes glyphs; ensureFont is async so we
  // set labels immediately with whatever is loaded, then re-render after the font loads.
  atlas.renderer.setLabels(out, labelStyle);

  const showOutlines = opts.clusters && opts.outlines && atlas.cluster && atlas.phase !== 'embedding';
  const coloured = showOutlines ? clusterOutlines(atlas) : null;
  if (coloured) {
    atlas.renderer.setOutlines(coloured.rings, undefined, coloured.colors);
  } else {
    atlas.renderer.setOutlines(showOutlines ? atlas.cluster!.outlines.flat() : [], [plain[0], plain[1], plain[2]]);
  }

  // Async font load: re-render once the font is ready (A2).
  void ensureLabelFont(atlas).then(() => {
    if (atlas.renderer) {
      atlas.renderer.setLabels(out, { ...labelStyle, fontFamily: resolvedFontFamily(atlas) });
    }
  });
}


/** Mean RGB of the points in each group (codes per point, RGBA colours per point); null for empty groups. */
export function groupMeanColors(codes: ArrayLike<number>, rgba: ArrayLike<number>, k: number): ([number, number, number] | null)[] {
  const sum = new Float64Array(k * 3);
  const n = new Uint32Array(k);
  const m = Math.min(codes.length, Math.floor(rgba.length / 4));
  for (let i = 0; i < m; i++) {
    const c = codes[i];
    if (c >= k) continue; // noise / other
    sum[3 * c] += rgba[4 * i];
    sum[3 * c + 1] += rgba[4 * i + 1];
    sum[3 * c + 2] += rgba[4 * i + 2];
    n[c]++;
  }
  return Array.from({ length: k }, (_, c) =>
    n[c] ? ([sum[3 * c] / n[c], sum[3 * c + 1] / n[c], sum[3 * c + 2] / n[c]].map(Math.round) as [number, number, number]) : null,
  );
}

/** Darken a colour until white text on it reaches a contrast ratio of at least 3:1. */
export function readableBadge(rgb: [number, number, number]): [number, number, number] {
  const lum = (c: number[]) => {
    const f = (v: number) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  let c = [...rgb];
  for (let i = 0; i < 20 && 1.05 / (lum(c) + 0.05) < 3; i++) c = c.map((v) => v * 0.85);
  return c.map(Math.round) as [number, number, number];
}
