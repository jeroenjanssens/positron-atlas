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
  vscode.post({ type: 'project', anchorXY: float32ToBytes(atlas.anchorXY), metric: atlas.umap.metric, seed: atlas.umap.seed });
}

/** Exact UMAP of all prepared rows in the kernel, with the chosen engine. */
export function runExact(atlas: Atlas): void {
  const engine = atlas.computeMode;
  if (!atlas.prepared || engine === 'browser' || engine === 'kernel-anchors') {
    return;
  }
  atlas.exactEngine = engine as import('../../shared/protocol').ExactEngine;
  stopWorker(atlas);
  atlas.allXY = new Float32Array(atlas.prepared.nKept * 2);
  atlas.placedRows = 0;
  atlas.projection = 'running';
  atlas.projectProgress = 0;
  atlas.phase = 'embedding';
  atlas.umapProgress = { stage: `${engine} (kernel)`, progress: 0, epoch: 0, total: 0 };
  atlas.hit = null;
  atlas.tooltip = null;
  vscode.post({ type: 'exact', params: $state.snapshot(atlas.umap) as import('../../shared/protocol').UmapParams, engine: engine as import('../../shared/protocol').ExactEngine });
}

export function onProjected(atlas: Atlas, seconds: number, exact: boolean): void {
  atlas.projectProgress = 1;
  atlas.hit = null;
  if (exact && atlas.prepared && atlas.allXY && atlas.anchorPos) {
    const a = new Float32Array(atlas.prepared.nAnchors * 2);
    for (let i = 0; i < atlas.anchorPos.length; i++) {
      a[2 * i] = atlas.allXY[2 * atlas.anchorPos[i]];
      a[2 * i + 1] = atlas.allXY[2 * atlas.anchorPos[i] + 1];
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
  }
  updateMapColors(atlas, false);
  atlas.recolor();
  refreshClusters(atlas);
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
  vscode.post({ type: 'anchorUmap', params: $state.snapshot(atlas.umap) as import('../../shared/protocol').UmapParams });
}

/**
 * Handle the 'anchorXY' message from the kernel (P3): load anchor positions and proceed.
 */
export async function onAnchorXY(atlas: Atlas, file: FileRef, seconds: number): Promise<void> {
  const xy = (await fetchTyped(file.uri, 'f32')) as Float32Array;
  if (xy.length !== atlas.prepared!.nAnchors * 2) return; // wrong shape
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
  atlas.allXY.set(xy, offset * 2);
  atlas.placedRows = Math.max(atlas.placedRows, offset + xy.length / 2);
  atlas.render();
}
