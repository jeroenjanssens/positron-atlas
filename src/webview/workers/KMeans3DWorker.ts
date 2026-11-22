/**
 * Wrapper for the kmeans3d web worker (B2 / item 16).
 *
 * Usage:
 *   const w = new KMeans3DWorker();
 *   const result = await w.run(xyz, n, k);
 *   w.destroy();
 *
 * Each call to run() cancels any in-progress run by terminating and
 * restarting the worker (the cancelled run's promise rejects with a
 * "cancelled" error — the caller ignores this via clusterSeq checks).
 */

import KMeans3DWorkerModule from './kmeans3d.worker.ts?worker&inline';
import type { WorkerIn, WorkerOut } from './kmeans3d.worker';

export const KMEANS_SAMPLE_MAX = 100_000;

export interface KMeansWorkerResult {
  codes: Uint16Array;
  centers: Float32Array;
  counts: number[];
  k: number;
  sampleN: number;
  timeMs: number;
}

export class KMeans3DWorker {
  private worker: Worker | null = null;
  private runId = 0;
  private pending: ((v: KMeansWorkerResult) => void) | null = null;
  private reject: ((e: Error) => void) | null = null;

  private ensure(): Worker {
    if (!this.worker) {
      const w = new KMeans3DWorkerModule();
      this.worker = w;
      w.onmessage = (ev: MessageEvent<WorkerOut>) => {
        const msg = ev.data;
        if (msg.type === 'done' && msg.runId === this.runId) {
          const resolve = this.pending;
          this.pending = null;
          this.reject = null;
          resolve?.({ codes: msg.codes, centers: msg.centers, counts: msg.counts, k: msg.k, sampleN: msg.sampleN, timeMs: msg.timeMs });
        }
      };
      w.onerror = (ev) => {
        ev.preventDefault();
        const rej = this.reject;
        this.pending = null;
        this.reject = null;
        this.worker = null;
        rej?.(new Error(`KMeans3D worker error: ${ev.message}`));
      };
    }
    return this.worker;
  }

  /**
   * Run k-means on xyz[0..n*3]. The Float32Array is transferred into the
   * worker (zero-copy) and must not be used by the caller afterwards.
   * If a previous run is in progress it is cancelled (its promise rejects).
   */
  run(
    xyz: Float32Array,
    n: number,
    k: number,
    opts?: { sampleMax?: number; maxIter?: number; seed?: number },
  ): Promise<KMeansWorkerResult> {
    // Cancel any in-progress run.
    if (this.reject) {
      const rej = this.reject;
      this.pending = null;
      this.reject = null;
      rej(new Error('cancelled'));
    }
    this.runId++;
    const id = this.runId;
    const w = this.ensure();

    const msg: WorkerIn = {
      type: 'run',
      runId: id,
      xyz,
      n,
      k,
      sampleMax: opts?.sampleMax ?? KMEANS_SAMPLE_MAX,
      maxIter: opts?.maxIter ?? 15,
      seed: opts?.seed ?? (id * 2654435761),
    };

    return new Promise<KMeansWorkerResult>((resolve, reject) => {
      this.pending = resolve;
      this.reject = reject;
      w.postMessage(msg, [xyz.buffer]);
    });
  }

  destroy(): void {
    this.reject?.(new Error('destroyed'));
    this.pending = null;
    this.reject = null;
    this.worker?.terminate();
    this.worker = null;
  }
}
