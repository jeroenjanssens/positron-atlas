/**
 * Automatic cluster detection, naming, and write-back.
 */

import type { Atlas } from '../atlas.svelte';
import { DETAIL_THRESHOLDS, assignToClusters, densityGrid } from '../labels/clusters';
import { ClusterFinder } from '../labels/clusterWorker';
import { vscode, typedArrayToBytes } from '../vscode';
import { gatherU16, dominantNames } from './utils';
import { updateLabels } from './labels';
import { MAX_LABELS } from './types';

/** Re-cluster the current layout (when it has settled; labels follow the points meanwhile). */
export function refreshClusters(atlas: Atlas): void {
  if (atlas.labels.clusters && (atlas.phase === 'ready' || atlas.paused)) {
    void runClustering(atlas);
  }
}

export async function runClustering(atlas: Atlas): Promise<void> {
  if (!atlas.labels.clusters || !atlas.prepared || !atlas.anchorXY || !atlas.anchorPos) {
    return;
  }
  const seq = ++atlas.clusterSeq;
  const prepared = atlas.prepared;
  const anchorPos = atlas.anchorPos;
  const onAll = !!prepared.needsProjection && atlas.projection === 'done' && !!atlas.allXY;
  const xy = onAll ? atlas.allXY! : atlas.anchorXY.slice();
  const n = onAll ? atlas.nKept : prepared.nAnchors;
  const grid = densityGrid(xy, n);
  if (!grid) {
    return;
  }
  atlas.clustering = true;
  atlas.clusterRunning = seq;
  let found;
  try {
    atlas.clusterFinder ??= new ClusterFinder();
    found = await atlas.clusterFinder.find(grid, DETAIL_THRESHOLDS[Math.min(5, Math.max(1, Math.round(atlas.labels.detail))) - 1]);
  } catch (e) {
    if (atlas.clusterRunning === seq) {
      atlas.clustering = false;
    }
    if (seq === atlas.clusterSeq) {
      atlas.showError(e instanceof Error ? e.message : String(e));
    }
    return;
  }
  if (seq !== atlas.clusterSeq || prepared !== atlas.prepared || !atlas.labels.clusters) {
    if (atlas.clusterRunning === seq) {
      atlas.clustering = false;
    }
    return;
  }
  const a = assignToClusters(grid, found, xy, n);
  let codes: Uint16Array;
  if (onAll || !prepared.needsProjection) {
    codes = a.codes;
  } else {
    codes = new Uint16Array(atlas.nKept).fill(a.k);
    for (let i = 0; i < anchorPos.length; i++) codes[anchorPos[i]] = a.codes[i];
  }
  atlas.cluster = {
    codes,
    codesAnchors: prepared.needsProjection ? gatherU16(codes, anchorPos) : codes,
    k: a.k,
    counts: a.counts,
    outlines: a.outlines,
  };
  atlas.clusterCount = a.k;
  atlas.clustering = false;
  atlas.nameClusters();
  updateLabels(atlas);
}

/** Cluster names: numbers, the most common value of a column, or distinguishing features (kernel). */
export function nameClusters(atlas: Atlas): void {
  const c = atlas.cluster;
  if (!c) {
    atlas.clusterNames = [];
    return;
  }
  const numbered = c.counts.map((_, i) => `Cluster ${i + 1}`);
  const by = atlas.labels.nameBy;
  if (by === 'features') {
    atlas.clusterNames = atlas.clusterNames.length === c.k ? atlas.clusterNames : numbered;
    const seq = ++atlas.nameSeq;
    const columns = (atlas.applied?.features ?? []).slice();
    vscode.post({ type: 'describeGroups', seq, codes: typedArrayToBytes(c.codes), k: c.k, columns });
    return;
  }
  if (typeof by === 'number') {
    const src = atlas.nameSource;
    if (!src || src.column !== by) {
      atlas.clusterNames = numbered;
      if (atlas.prepared) {
        vscode.post({ type: 'labelCodes', column: by, maxCategories: MAX_LABELS, purpose: 'names' });
      }
      return;
    }
    atlas.clusterNames = dominantNames(c.codes, c.k, src.codes, src.meta.categories);
    return;
  }
  atlas.clusterNames = numbered;
}

export function onGroupNames(atlas: Atlas, seq: number, names: string[]): void {
  const c = atlas.cluster;
  if (seq !== atlas.nameSeq || !c || names.length !== c.k || atlas.labels.nameBy !== 'features') {
    return;
  }
  atlas.clusterNames = names.map((nm, i) => nm || `Cluster ${i + 1}`);
  updateLabels(atlas);
}
