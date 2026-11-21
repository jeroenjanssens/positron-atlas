/**
 * Label placement: label source, label codes, updateLabels.
 */

import type { Atlas } from '../atlas.svelte';
import type { ColorMeta, FileRef, LabelOptions } from '../../shared/protocol';
import { vscode, fetchTyped } from '../vscode';
import { collisionPriorities, labelSizes, placeGroupLabels } from '../labels/place';
import { hexToRgb } from '../color/colormaps';
import { toHex } from '../logic';
import { gatherU16, contrastText, labelTextColor, fontFamily } from './utils';
import { plotBackground } from './render';
import { MAX_LABELS, LABEL_INTERVAL_MS } from './types';

export function setLabelSource(atlas: Atlas, source: number | 'clusters' | null): void {
  const clusters = source === 'clusters';
  atlas.labels = { ...atlas.labels, column: typeof source === 'number' ? source : null, clusters };
  atlas.labelCount = 0;
  atlas.renderer?.setLabels([]);
  atlas.renderer?.setOutlines([]);
  atlas.labelMeta = null;
  atlas.labelCodes = null;
  atlas.labelCodesAnchors = null;
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

export function setLabelOptions(atlas: Atlas, o: Partial<LabelOptions>): void {
  const prev = atlas.labels;
  atlas.labels = { ...atlas.labels, ...o };
  if (atlas.labels.clusters && o.detail !== undefined && o.detail !== prev.detail) {
    atlas.refreshClusters();
  } else if (atlas.labels.clusters && o.nameBy !== undefined && o.nameBy !== prev.nameBy) {
    atlas.nameClusters();
  }
  updateLabels(atlas);
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
  const wanted = purpose === 'names' ? atlas.labels.clusters && atlas.labels.nameBy === column : !atlas.labels.clusters && column === atlas.labels.column;
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
  if (column !== atlas.labels.column || atlas.labels.clusters) {
    return;
  }
  atlas.labelCodes = codes;
  atlas.labelCodesAnchors = atlas.prepared?.needsProjection ? gatherU16(codes, atlas.anchorPos) : codes;
  atlas.labelMeta = meta;
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

/** The group codes and names that label the map right now, or null. */
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
  const placed =
    atlas.projection === 'done' && atlas.allXY
      ? placeGroupLabels(atlas.allXY, groups.all, atlas.nKept, groups.names)
      : placeGroupLabels(atlas.anchorXY, groups.anchors, atlas.prepared.nAnchors, groups.names);
  const counts = placed.map((l) => l.count);
  const sizes = labelSizes(counts, atlas.labels.minSize, atlas.labels.maxSize);
  const priorities = collisionPriorities(counts);
  const background = atlas.plotBackground();
  const plain = contrastText(background);
  const cm = atlas.colorMeta;
  const colorIndex =
    !atlas.labels.clusters && atlas.labels.colorText && atlas.labels.column === atlas.colorColumn && cm?.kind === 'categorical'
      ? new Map(cm.categories.map((c, i) => [c, i]))
      : null;
  const out: import('../render/renderer').MapLabel[] = placed.map((l, i) => {
    const ci = colorIndex?.get(l.text);
    return {
      text: l.text === '' ? '(empty)' : l.text,
      position: [l.x, l.y],
      size: sizes[i],
      color: ci !== undefined ? labelTextColor(hexToRgb(atlas.categoryColor(ci)), plain) : plain,
      priority: priorities[i],
    };
  });
  atlas.labelCount = out.length;
  atlas.renderer.setLabels(out, { outline: [...hexToRgb(toHex(background)), 220], fontFamily: fontFamily() });
  const showOutlines = atlas.labels.clusters && atlas.labels.outlines && atlas.cluster && atlas.phase !== 'embedding';
  atlas.renderer.setOutlines(showOutlines ? atlas.cluster!.outlines.flat() : [], [plain[0], plain[1], plain[2]]);
}
