/**
 * Projection (placing all rows): project, runExact, onProjected, cancelKernel, onXYChunk.
 */

import type { Atlas } from '../atlas.svelte';
import type { FileRef } from '../../shared/protocol';
import { vscode, fetchTyped, float32ToBytes } from '../vscode';
import { updateMapColors } from './colors';
import { refreshClusters } from './clusters';
import { stopWorker } from './umap.svelte';

export function project(atlas: Atlas): void {
  if (!atlas.anchorXY || !atlas.prepared?.needsProjection) {
    return;
  }
  atlas.projection = 'running';
  atlas.projectProgress = 0;
  atlas.placedRows = 0;
  // Always (re)allocate allXY for the current dims so 2D→3D (or 3D→2D) transitions
  // don't leave a stale buffer from the previous run (e.g. nKept*2 when dims=3).
  atlas.allXY = new Float32Array(atlas.prepared.nKept * atlas.dims);
  vscode.post({ type: 'project', anchorXY: float32ToBytes(atlas.anchorXY), metric: atlas.umap.metric, seed: atlas.umap.seed, dims: atlas.dims });
}

/** Exact UMAP of all prepared rows in the kernel, with the chosen engine. */
export function runExact(atlas: Atlas): void {
  const engine = atlas.computeMode;
  if (!atlas.prepared || engine === 'browser' || engine === 'kernel-anchors') {
    return;
  }
  atlas.exactEngine = engine as import('../../shared/protocol').ExactEngine;
  stopWorker(atlas);
  atlas.allXY = new Float32Array(atlas.prepared.nKept * atlas.dims);
  atlas.placedRows = 0;
  atlas.projection = 'running';
  atlas.projectProgress = 0;
  atlas.phase = 'embedding';
  atlas.umapProgress = { stage: `${engine} (kernel)`, progress: 0, epoch: 0, total: 0 };
  atlas.hit = null;
  atlas.tooltip = null;
  vscode.post({ type: 'exact', params: $state.snapshot(atlas.umap) as import('../../shared/protocol').UmapParams, engine: engine as import('../../shared/protocol').ExactEngine, dims: atlas.dims });
}

export function onProjected(atlas: Atlas, seconds: number, exact: boolean): void {
  atlas.projectProgress = 1;
  atlas.hit = null;
  atlas._3dScreenXY = null;
  if (exact && atlas.prepared && atlas.allXY && atlas.anchorPos) {
    const nd = atlas.dims;
    const a = new Float32Array(atlas.prepared.nAnchors * nd);
    for (let i = 0; i < atlas.anchorPos.length; i++) {
      for (let j = 0; j < nd; j++) {
        a[nd * i + j] = atlas.allXY[nd * atlas.anchorPos[i] + j];
      }
    }
    atlas.anchorXY = a;
    atlas.placedRows = atlas.prepared.nKept;
    atlas.phase = 'ready';
    atlas.umapProgress = null;
    atlas.autoFit = true;
    atlas.timings = { ...atlas.timings, umap: seconds, project: 0 };
    atlas.layoutEngine = atlas.exactEngine;
    atlas.projection = atlas.prepared.needsProjection ? 'done' : 'none';
  } else {
    atlas.timings = { ...atlas.timings, project: seconds };
    atlas.projection = 'done';
    // Re-enable autoFit so the camera fits to the freshly placed 3D (or 2D) data.
    // This is needed because render.ts resets autoFit to false after each fit to
    // prevent repeated re-fitting; onProjected must re-arm it for new data.
    atlas.autoFit = true;
  }
  updateMapColors(atlas, false);
  atlas.recolor();
  refreshClusters(atlas);
  // In 3D mode, the screen-space hit index must be rebuilt after projection
  // completes. Camera movement normally triggers on3DViewChange, but when the
  // camera is static the callback never fires.  Kick the rebuild directly here.
  // Also trigger for coords mode (exact=true, needsProjection=false → projection='none').
  if (atlas.dims === 3 && (atlas.projection === 'done' || exact)) {
    atlas.rebuild3DHitIndex();
  }
}

export function cancelKernel(atlas: Atlas): void {
  vscode.post({ type: 'cancel' });
  if (atlas.projection === 'running') {
    atlas.projection = 'stale';
  }
}

/**
 * Run polars-umap on the anchors in the kernel (P3).
 * Sets the phase to 'embedding' and waits for 'anchorXY' message.
 */
export function runKernelAnchors(atlas: Atlas): void {
  if (!atlas.prepared) return;
  stopWorker(atlas);
  atlas.phase = 'embedding';
  atlas.umapProgress = { stage: 'kernel-polars-umap (anchors)', progress: 0, epoch: 0, total: 0 };
  atlas.projection = atlas.prepared.needsProjection ? 'stale' : 'none';
  atlas.estimate = null;
  atlas.hit = null;
  atlas.tooltip = null;
  vscode.post({ type: 'anchorUmap', params: $state.snapshot(atlas.umap) as import('../../shared/protocol').UmapParams, dims: atlas.dims });
}

/**
 * Handle the 'anchorXY' message from the kernel (P3): load anchor positions and proceed.
 */
export async function onAnchorXY(atlas: Atlas, file: FileRef, seconds: number): Promise<void> {
  const xy = (await fetchTyped(file.uri, 'f32')) as Float32Array;
  // Shape may be [nAnchors * 2] (2D) or [nAnchors * 3] (3D); accept either.
  const nd = xy.length / atlas.prepared!.nAnchors;
  if (nd !== 2 && nd !== 3) return; // wrong shape
  if (nd === 3) atlas.dims = 3;
  if (xy.length !== atlas.prepared!.nAnchors * atlas.dims) return; // wrong shape after update
  atlas.anchorXY = xy;
  atlas.phase = 'ready';
  atlas.umapProgress = null;
  atlas.autoFit = true;
  atlas.timings = { ...atlas.timings, umap: seconds };
  atlas.layoutEngine = 'polars-umap (anchors)';
  if (atlas.prepared?.needsProjection) {
    atlas.projection = 'stale';
    atlas.project();
  }
  updateMapColors(atlas, false);
  atlas.recolor();
  refreshClusters(atlas);
}

export async function onXYChunk(atlas: Atlas, file: FileRef): Promise<void> {
  if (!atlas.allXY || atlas.projection !== 'running') {
    return;
  }
  const xy = (await fetchTyped(file.uri, 'f32')) as Float32Array;
  const offset = file.offset ?? 0;
  // Detect dims from the chunk shape (shape[1] = 2 or 3).
  const nd = file.shape.length >= 2 ? file.shape[1] : 2;
  if (nd !== atlas.dims && (nd === 2 || nd === 3)) {
    // Dims changed mid-flight (kernel reported different dims); update.
    atlas.dims = nd as 2 | 3;
    atlas.allXY = new Float32Array(atlas.prepared!.nKept * nd);
    atlas.renderer?.setDims(nd as 2 | 3);
  }
  atlas.allXY.set(xy, offset * atlas.dims);
  atlas.placedRows = Math.max(atlas.placedRows, offset + xy.length / atlas.dims);
  atlas.render();
}
