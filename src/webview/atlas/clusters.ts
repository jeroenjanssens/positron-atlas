/**
 * Automatic cluster detection, naming, and write-back.
 */

import type { Atlas } from '../atlas.svelte';
import { DETAIL_THRESHOLDS, assignToClusters, densityGrid } from '../labels/clusters';
import { ClusterFinder } from '../labels/clusterWorker';
import { KMeans3DWorker } from '../workers/KMeans3DWorker';
import { vscode, typedArrayToBytes } from '../vscode';
import { gatherU16, dominantNames } from './utils';
import { updateLabels } from './labels';
import { recolorByClusters } from './colors';
import { MAX_LABELS } from './types';
import { CLUSTERS_3D_K } from './clusters3d';

/** Re-cluster the current layout (when it has settled; labels follow the points meanwhile). */
export function refreshClusters(atlas: Atlas): void {
  if (atlas.labels.clusters && (atlas.phase === 'ready' || atlas.paused)) {
    if (atlas.dims === 3) {
      // B2/item16: 3D automatic clusters via k-means.
      void runClustering3D(atlas);
    } else {
      void runClustering(atlas);
    }
  }
}

/** Run the fine (secondary) clustering for multi-level labels (A8). */
export async function runFineClustering(atlas: Atlas): Promise<void> {
  if (!atlas.labels.clusters || !atlas.labels.multiLevel || !atlas.prepared || !atlas.anchorXY || !atlas.anchorPos) {
    return;
  }
  const prepared = atlas.prepared;
  const anchorPos = atlas.anchorPos;
  const onAll = !!prepared.needsProjection && atlas.projection === 'done' && !!atlas.allXY;
  const xy = onAll ? atlas.allXY! : atlas.anchorXY.slice();
  const n = onAll ? atlas.nKept : prepared.nAnchors;
  const grid = densityGrid(xy, n);
  if (!grid) return;

  // Fine level: detail + 2 (capped at 5)
  const fineDetail = Math.min(5, Math.round(atlas.labels.detail) + 2);
  let found;
  try {
    atlas.clusterFinder ??= new ClusterFinder();
    found = await atlas.clusterFinder.find(grid, DETAIL_THRESHOLDS[fineDetail - 1]);
  } catch {
    return;
  }

  if (!atlas.labels.multiLevel || prepared !== atlas.prepared) return;

  const a = assignToClusters(grid, found, xy, n);
  let codes: Uint16Array;
  if (onAll || !prepared.needsProjection) {
    codes = a.codes;
  } else {
    codes = new Uint16Array(atlas.nKept).fill(a.k);
    for (let i = 0; i < anchorPos.length; i++) codes[anchorPos[i]] = a.codes[i];
  }
  atlas.clusterFine = {
    codes,
    codesAnchors: prepared.needsProjection ? gatherU16(codes, anchorPos) : codes,
    k: a.k,
    counts: a.counts,
    outlines: a.outlines,
  };
  // Name fine clusters by number.
  atlas.clusterFineNames = a.counts.map((_, i) => `Cluster ${i + 1}`);
  updateLabels(atlas);
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
  // A8: also run fine clustering if multiLevel is enabled.
  if (atlas.labels.multiLevel) {
    void runFineClustering(atlas);
  } else {
    atlas.clusterFine = null;
    atlas.clusterFineNames = [];
  }
  // If colour-by-cluster is active, refresh the colours with the new cluster codes (A6).
  if (atlas.colorByCluster) {
    recolorByClusters(atlas);
  }
}

/**
 * Run k-means clustering on the 3D layout off the main thread (B2 / item 16).
 *
 * Strategy:
 *   - Transfer all xyz positions to the worker (zero-copy).
 *   - The worker sub-samples up to 100 k rows for the k++ fit, then
 *     assigns ALL n rows to the nearest centroid — also off the main thread.
 *   - Cancellation via atlas.clusterSeq: if the seq changes while the
 *     worker is running we discard the result.
 */
export async function runClustering3D(atlas: Atlas): Promise<void> {
  if (!atlas.labels.clusters || !atlas.prepared || !atlas.anchorXY || atlas.dims !== 3) return;
  const seq = ++atlas.clusterSeq;
  const prepared = atlas.prepared;
  const anchorPos = atlas.anchorPos;

  // Use all placed rows (allXY) or just anchors.
  const onAll = !!prepared.needsProjection && atlas.projection === 'done' && !!atlas.allXY;
  const srcXyz = onAll ? atlas.allXY! : atlas.anchorXY;
  const n = onAll ? atlas.nKept : prepared.nAnchors;

  if (n < 2) return;

  atlas.clustering = true;
  atlas.clusterRunning = seq;

  const detail = Math.min(5, Math.max(1, Math.round(atlas.labels.detail)));
  const k = CLUSTERS_3D_K[detail] ?? 16;

  // Transfer a copy of xyz to the worker (the original is still needed by the renderer).
  const xyzCopy = srcXyz.slice(0, n * 3);

  // Create or reuse the per-atlas k-means worker.
  atlas.kmeans3dWorker ??= new KMeans3DWorker();

  let result;
  try {
    result = await atlas.kmeans3dWorker.run(xyzCopy, n, k, { seed: seq });
  } catch (e) {
    // "cancelled" means a newer run superseded this one — silent discard.
    if (e instanceof Error && e.message === 'cancelled') return;
    if (atlas.clusterRunning === seq) atlas.clustering = false;
    if (seq === atlas.clusterSeq) {
      atlas.showError(e instanceof Error ? e.message : String(e));
    }
    return;
  }

  // Check if this run is still the latest.
  if (seq !== atlas.clusterSeq || prepared !== atlas.prepared || !atlas.labels.clusters) {
    if (atlas.clusterRunning === seq) atlas.clustering = false;
    return;
  }

  // The worker assigned all n rows; we may need to expand anchor codes to all rows.
  let codes: Uint16Array;
  if (onAll || !prepared.needsProjection) {
    codes = result.codes;
  } else {
    // Worker ran on anchors; scatter back to all rows.
    codes = new Uint16Array(atlas.nKept).fill(result.k);
    if (anchorPos) {
      for (let i = 0; i < anchorPos.length; i++) codes[anchorPos[i]] = result.codes[i];
    }
  }

  atlas.cluster = {
    codes,
    codesAnchors: (prepared.needsProjection && anchorPos) ? gatherU16(codes, anchorPos) : codes,
    k: result.k,
    counts: result.counts,
    outlines: [], // no hull outlines in 3D; boxes are used instead
  };
  atlas.clusterCount = result.k;
  atlas.clustering = false;
  atlas.nameClusters();
  updateLabels(atlas);
  // No multi-level support for 3D clusters yet.
  atlas.clusterFine = null;
  atlas.clusterFineNames = [];
  if (atlas.colorByCluster) {
    recolorByClusters(atlas);
  }
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
