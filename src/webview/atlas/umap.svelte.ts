/**
 * UMAP browser worker: start, live update, stop, pause, resume, step, worker events.
 */

import type { Atlas } from '../atlas.svelte';
import type { WorkerIn, WorkerOut } from '../workers/umap.worker';
import UmapWorker from '../workers/umap.worker.ts?worker&inline';
import { isRebuild, liveChanges } from '../logic';
import { vscode } from '../vscode';
import { updateMapColors } from './colors';
import { refreshClusters } from './clusters';

export function createWorker(atlas: Atlas): void {
  atlas.worker?.terminate();
  atlas.worker = new UmapWorker();
  atlas.worker.onmessage = (ev: MessageEvent<WorkerOut>) => onWorker(atlas, ev.data);
  atlas.worker.onerror = (ev) => {
    ev.preventDefault();
    createWorker(atlas);
    if (atlas.useGpu) {
      atlas.flash(`GPU UMAP failed (${ev.message}); using the CPU.`);
      atlas.useGpu = false;
      atlas.startUmap();
    } else {
      atlas.showError(`UMAP worker failed: ${ev.message}`);
      atlas.phase = atlas.prepared ? 'ready' : 'error';
    }
  };
}

export function startUmap(atlas: Atlas, paused = false): void {
  if (!atlas.anchors || !atlas.prepared) {
    return;
  }
  atlas.runId++;
  atlas.liveRun = false;
  atlas.paused = false;
  atlas.appliedUmap = $state.snapshot(atlas.umap) as import('../../shared/protocol').UmapParams;
  atlas.phase = 'embedding';
  atlas.umapProgress = { stage: 'neighbors', progress: 0, epoch: 0, total: atlas.umap.nEpochs };
  atlas.projection = atlas.prepared.needsProjection ? 'stale' : 'none';
  atlas.estimate = null;
  atlas.hit = null;
  atlas.tooltip = null;
  createWorker(atlas);
  const data = atlas.anchors.slice();
  const msg: WorkerIn = {
    type: 'start',
    runId: atlas.runId,
    data,
    n: atlas.prepared.nAnchors,
    d: atlas.prepared.dims,
    params: atlas.appliedUmap,
    gpu: atlas.useGpu,
    paused,
  };
  atlas.worker!.postMessage(msg, [data.buffer]);
}

/** Called when UMAP controls change; rebuilds or applies live. */
export function umapChanged(atlas: Atlas): void {
  if (atlas.computeMode !== 'browser' || !atlas.appliedUmap || !atlas.anchors) {
    return;
  }
  const next = $state.snapshot(atlas.umap) as import('../../shared/protocol').UmapParams;
  if (isRebuild(atlas.appliedUmap, next)) {
    atlas.startUmap();
    return;
  }
  const live = liveChanges(atlas.appliedUmap, next);
  atlas.appliedUmap = next;
  if (Object.keys(live).length === 0 || !atlas.worker) {
    return;
  }
  atlas.phase = 'embedding';
  atlas.liveRun = true;
  atlas.paused = false;
  atlas.projection = atlas.prepared?.needsProjection ? 'stale' : 'none';
  atlas.estimate = null;
  atlas.hit = null;
  atlas.tooltip = null;
  const epochs = Math.max(60, Math.round(next.nEpochs / 2));
  atlas.umapProgress = { stage: 'optimizing', progress: 1, epoch: 0, total: epochs };
  atlas.worker.postMessage({ type: 'live', runId: atlas.runId, params: live, epochs } satisfies WorkerIn);
}

/** End the schedule now and keep the current layout. */
export function stopUmap(atlas: Atlas): void {
  atlas.worker?.postMessage({ type: 'stop', runId: atlas.runId } satisfies WorkerIn);
}

export function pauseUmap(atlas: Atlas): void {
  atlas.worker?.postMessage({ type: 'pause', runId: atlas.runId } satisfies WorkerIn);
}

export function resumeUmap(atlas: Atlas): void {
  atlas.paused = false;
  atlas.worker?.postMessage({ type: 'resume', runId: atlas.runId } satisfies WorkerIn);
}

/** Run `epochs` more epochs of the paused schedule. */
export function stepUmap(atlas: Atlas, epochs: number): void {
  if (!atlas.paused) return;
  atlas.worker?.postMessage({ type: 'step', runId: atlas.runId, epochs } satisfies WorkerIn);
}

export function stopWorker(atlas: Atlas): void {
  atlas.runId++;
  atlas.worker?.postMessage({ type: 'stop', runId: atlas.runId - 1 } satisfies WorkerIn);
}

export function onWorker(atlas: Atlas, m: WorkerOut): void {
  if (m.runId !== atlas.runId) {
    return;
  }
  switch (m.type) {
    case 'progress':
      atlas.umapProgress = { stage: m.stage, progress: m.progress, epoch: 0, total: atlas.umap.nEpochs };
      break;
    case 'frame':
      atlas.anchorXY = m.embedding;
      atlas.paused = false;
      atlas.umapProgress = { stage: 'optimizing', progress: 1, epoch: m.epoch, total: m.total };
      atlas.render();
      break;
    case 'paused':
      atlas.anchorXY = m.embedding;
      atlas.paused = true;
      atlas.hit = null;
      atlas.umapProgress = { stage: 'paused', progress: 1, epoch: m.epoch, total: m.total };
      atlas.render();
      break;
    case 'done':
      atlas.anchorXY = m.embedding;
      atlas.paused = false;
      if (m.seconds) {
        atlas.timings = atlas.liveRun ? { ...atlas.timings, update: m.seconds } : { ...atlas.timings, umap: m.seconds, update: 0 };
        atlas.layoutEngine = atlas.useGpu ? 'GPU' : 'CPU';
      }
      atlas.phase = 'ready';
      atlas.umapProgress = null;
      updateMapColors(atlas, false);
      atlas.recolor();
      refreshClusters(atlas);
      if (atlas.prepared?.needsProjection) {
        vscode.post({ type: 'estimate' });
      }
      break;
    case 'error':
      if (atlas.useGpu) {
        atlas.flash(`WebGPU UMAP failed (${m.message}); using the CPU.`);
        atlas.useGpu = false;
        atlas.startUmap();
        return;
      }
      atlas.showError(`UMAP failed: ${m.message}`);
      atlas.phase = 'ready';
      break;
  }
}
