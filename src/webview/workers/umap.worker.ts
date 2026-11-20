/// <reference lib="webworker" />
import { createUMAP, type UMAP } from 'embedding-atlas-umap';
import { sgdRate } from './schedule';
import type { UmapParams } from '../../shared/protocol';

export type WorkerIn =
  | { type: 'start'; runId: number; data: Float32Array; n: number; d: number; params: UmapParams; gpu?: boolean; paused?: boolean }
  | { type: 'live'; runId: number; params: Partial<UmapParams>; epochs: number }
  /** Pause the running schedule (keeps its position). */
  | { type: 'pause'; runId: number }
  /** Continue a paused schedule to the end. */
  | { type: 'resume'; runId: number }
  /** Run `epochs` epochs of a paused schedule, then pause again. */
  | { type: 'step'; runId: number; epochs: number }
  /** End the schedule here and keep the current layout. */
  | { type: 'stop'; runId: number };

export type WorkerOut =
  | { type: 'progress'; runId: number; stage: string; progress: number }
  | { type: 'frame'; runId: number; embedding: Float32Array; epoch: number; total: number }
  | { type: 'paused'; runId: number; embedding: Float32Array; epoch: number; total: number }
  | { type: 'done'; runId: number; embedding: Float32Array; epoch: number; seconds: number }
  | { type: 'error'; runId: number; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let umap: UMAP | null = null;
let currentRun = 0;
let loopToken = 0;
let alpha0 = 1;
/** The step currently running inside WASM; must settle before destroy(). */
let inflight: Promise<void> = Promise.resolve();

/** The annealing schedule in progress: epochs are counted from `begin`. */
interface Schedule {
  begin: number;
  total: number;
  peak: number;
  startedAt: number;
}
let schedule: Schedule | null = null;

function post(msg: WorkerOut, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer);
}

function snapshot(): Float32Array {
  return new Float32Array(umap!.embedding);
}

function position(): { epoch: number; total: number } {
  return { epoch: umap && schedule ? umap.epoch - schedule.begin : 0, total: schedule?.total ?? 0 };
}

function postPaused(runId: number): void {
  if (!umap) return;
  const e = snapshot();
  post({ type: 'paused', runId, embedding: e, ...position() }, [e.buffer]);
}

/**
 * Advance the schedule by up to `count` epochs (Infinity = to the end). Streams frames
 * while running freely; after a finite step it reports 'paused'; at the end 'done'.
 */
async function advance(runId: number, count: number): Promise<void> {
  const token = ++loopToken;
  let lastPost = 0;
  let n = 0;
  while (umap && schedule && token === loopToken && umap.epoch - schedule.begin < schedule.total && n < count) {
    umap.setParameters({ learningRate: sgdRate(umap.epoch - schedule.begin, schedule.total, schedule.peak) });
    inflight = umap.step(1);
    await inflight;
    n++;
    if (token !== loopToken) {
      return;
    }
    const now = performance.now();
    if (count === Infinity && now - lastPost > 33) {
      lastPost = now;
      const e = snapshot();
      post({ type: 'frame', runId, embedding: e, ...position() }, [e.buffer]);
    }
  }
  if (!umap || !schedule || token !== loopToken) {
    return;
  }
  if (umap.epoch - schedule.begin >= schedule.total) {
    finish(runId);
  } else {
    postPaused(runId);
  }
}

function finish(runId: number): void {
  if (!umap || !schedule) return;
  const e = snapshot();
  const { epoch } = position();
  post({ type: 'done', runId, embedding: e, epoch, seconds: (performance.now() - schedule.startedAt) / 1000 }, [e.buffer]);
  schedule = { ...schedule, total: epoch }; // nothing left to run
}

ctx.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'start') {
      loopToken++;
      currentRun = msg.runId;
      // Never destroy an instance while a (GPU) step is still running inside WASM.
      await inflight.catch(() => undefined);
      if (currentRun !== msg.runId) {
        return;
      }
      umap?.destroy();
      umap = null;
      schedule = null;
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
      schedule = { begin: umap.epoch, total: p.nEpochs, peak: alpha0, startedAt: t0 };
      if (msg.paused) {
        postPaused(msg.runId); // show the initial (spectral) layout at epoch 0
      } else {
        const e = snapshot();
        post({ type: 'frame', runId: msg.runId, embedding: e, epoch: 0, total: p.nEpochs }, [e.buffer]);
        await advance(msg.runId, Infinity);
      }
    } else if (!umap || msg.runId !== currentRun) {
      return;
    } else if (msg.type === 'live') {
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
      schedule = { begin: umap.epoch, total: msg.epochs, peak: alpha0 * 0.5, startedAt: performance.now() };
      await advance(msg.runId, Infinity);
    } else if (msg.type === 'pause') {
      loopToken++;
      await inflight.catch(() => undefined);
      postPaused(msg.runId);
    } else if (msg.type === 'resume') {
      await advance(msg.runId, Infinity);
    } else if (msg.type === 'step') {
      await advance(msg.runId, Math.max(1, Math.floor(msg.epochs)));
    } else if (msg.type === 'stop') {
      loopToken++;
      await inflight.catch(() => undefined);
      finish(msg.runId);
    }
  } catch (err) {
    post({ type: 'error', runId: (msg as any).runId ?? 0, message: err instanceof Error ? err.message : String(err) });
  }
};
