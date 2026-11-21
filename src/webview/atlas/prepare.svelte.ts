/**
 * Data preparation: runPrepare, onPrepared, onStatus.
 */

import type { Atlas } from '../atlas.svelte';
import type { PrepareResult, FileRef } from '../../shared/protocol';
import { vscode, fetchTyped } from '../vscode';
import { gatherU16 } from './utils';
import { setSelection } from './selection';
import { requestLabelCodes } from './labels';
import { requestColors } from './colors';
import { startUmap } from './umap.svelte';
import { AUTO_PROJECT_SECONDS } from './types';

export function runPrepare(atlas: Atlas): void {
  atlas.applied = $state.snapshot(atlas.prepare) as import('../../shared/protocol').PrepareOptions;
  setSelection(atlas, null);
  atlas.phase = 'preparing';
  atlas.error = null;
  atlas.projection = 'none';
  atlas.estimate = null;
  atlas.stopWorker();
  vscode.post({ type: 'prepare', options: atlas.applied });
}

export async function onPrepared(atlas: Atlas, result: PrepareResult, anchorsRef: FileRef, posRef: FileRef): Promise<void> {
  const t0 = performance.now();
  const [anchors, pos] = await Promise.all([fetchTyped(anchorsRef.uri, 'f32'), fetchTyped(posRef.uri, 'u32')]);
  atlas.anchors = anchors as Float32Array;
  atlas.anchorPos = pos as Uint32Array;
  atlas.prepared = result;
  atlas.allXY = result.needsProjection ? new Float32Array(result.nKept * 2) : null;
  atlas.placedRows = 0;
  atlas.anchorXY = null;
  atlas.hit = null;
  atlas.colorValues = null;
  atlas.timings = { load: (performance.now() - t0) / 1000 };
  atlas.autoFit = true;
  atlas.labelCodes = null;
  atlas.labelCodesAnchors = null;
  atlas.cluster = null;
  atlas.clusterCount = 0;
  atlas.clusterNames = [];
  atlas.nameSource = null;
  atlas.clusterSeq++;
  atlas.recolor();
  if (atlas.colorColumn !== null) {
    requestColors(atlas);
  }
  if (atlas.labels.column !== null) {
    requestLabelCodes(atlas);
  }
  startUmap(atlas);
}

export function onStatus(atlas: Atlas, task: string, s: import('../../shared/protocol').JobStatus): void {
  atlas.kernelStatus = { task, stage: s.stage, progress: s.progress, message: s.message };
  if (task === 'project') {
    atlas.projectProgress = s.progress;
  }
  if (s.stale) {
    atlas.flash('The DataFrame changed in the session. Reload to see the latest data.');
  }
}
