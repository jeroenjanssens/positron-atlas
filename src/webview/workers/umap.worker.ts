/// <reference lib="webworker" />
import { createUMAP, type UMAP } from 'embedding-atlas-umap';
import { sgdRate } from './schedule';
import type { UmapParams } from '../../shared/protocol';

export type WorkerIn =
  | { type: 'start'; runId: number; data: Float32Array; n: number; d: number; params: UmapParams; gpu?: boolean }
  | { type: 'live'; runId: number; params: Partial<UmapParams>; epochs: number }
  | { type: 'stop'; runId: number };

export type WorkerOut =
  | { type: 'progress'; runId: number; stage: string; progress: number }
  | { type: 'frame'; runId: number; embedding: Float32Array; epoch: number; total: number }
  | { type: 'done'; runId: number; embedding: Float32Array; epoch: number; seconds: number }
  | { type: 'error'; runId: number; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let umap: UMAP | null = null;
let currentRun = 0;
let loopToken = 0;
let alpha0 = 1;

function post(msg: WorkerOut, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer);
}

function snapshot(): Float32Array {
  return new Float32Array(umap!.embedding);
}

async function anneal(runId: number, epochs: number, startedAt: number, peak = alpha0): Promise<void> {
  const token = ++loopToken;
  const begin = umap!.epoch;
  let lastPost = 0;
  while (umap && token === loopToken && umap.epoch - begin < epochs) {
    umap.setParameters({ learningRate: sgdRate(umap.epoch - begin, epochs, peak) });
    await umap.step(1);
    const now = performance.now();
    if (now - lastPost > 33) {
      lastPost = now;
      const e = snapshot();
      post({ type: 'frame', runId, embedding: e, epoch: umap.epoch - begin, total: epochs }, [e.buffer]);
    }
  }
  if (umap && token === loopToken) {
    const e = snapshot();
    post({ type: 'done', runId, embedding: e, epoch: umap.epoch - begin, seconds: (performance.now() - startedAt) / 1000 }, [e.buffer]);
  }
}

ctx.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'start') {
      loopToken++;
      currentRun = msg.runId;
      umap?.destroy();
      umap = null;
      const t0 = performance.now();
      const p = msg.params;
      alpha0 = p.learningRate;
      const instance = await createUMAP(msg.n, msg.d, 2, msg.data, {
        nNeighbors: Math.max(2, Math.min(p.nNeighbors, msg.n - 1)),
        minDist: p.minDist,
        spread: p.spread,
        metric: p.metric,
        seed: p.seed,
        nEpochs: p.nEpochs,
        repulsionStrength: p.repulsionStrength,
        negativeSampleRate: p.negativeSampleRate,
        learningRate: p.learningRate,
        optimizer: 'sgd',
        initializeMethod: 'spectral',
        gpu: !!msg.gpu,
        progress: (progress: number, stage: string) => post({ type: 'progress', runId: msg.runId, stage, progress }),
      });
      if (currentRun !== msg.runId) {
        instance.destroy();
        return;
      }
      umap = instance;
      const e = snapshot();
      post({ type: 'frame', runId: msg.runId, embedding: e, epoch: 0, total: p.nEpochs }, [e.buffer]);
      await anneal(msg.runId, p.nEpochs, t0);
    } else if (msg.type === 'live') {
      if (!umap || msg.runId !== currentRun) {
        return;
      }
      const { minDist, spread, repulsionStrength, negativeSampleRate, learningRate } = msg.params;
      if (learningRate !== undefined) {
        alpha0 = learningRate;
      }
      const live: Record<string, number> = {};
      for (const [k, v] of Object.entries({ minDist, spread, repulsionStrength, negativeSampleRate })) {
        if (typeof v === 'number' && Number.isFinite(v)) {
          live[k] = v;
        }
      }
      umap.setParameters(live);
      // Re-anneal from a lower peak so a converged layout adapts without scrambling.
      await anneal(msg.runId, msg.epochs, performance.now(), alpha0 * 0.5);
    } else if (msg.type === 'stop') {
      loopToken++;
      if (umap && msg.runId === currentRun) {
        const e = snapshot();
        post({ type: 'done', runId: msg.runId, embedding: e, epoch: umap.epoch, seconds: 0 }, [e.buffer]);
      }
    }
  } catch (err) {
    post({ type: 'error', runId: (msg as any).runId ?? 0, message: err instanceof Error ? err.message : String(err) });
  }
};
