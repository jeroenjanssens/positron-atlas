// embedding-atlas's density clustering (findClusters, WASM) in its own worker. The worker ships
// with the embedding-atlas npm package; it answers {id, name, payload} messages.
import ClusteringWorker from 'embedding-atlas-clustering-worker?worker&inline';
import type { DensityGrid, FoundCluster } from './clusters';

/** The embedding-atlas clustering worker (one per Atlas tab, started on first use). */
export class ClusterFinder {
  private worker: Worker | null = null;
  private ready: Promise<Worker> | null = null;
  private pending = new Map<number, (v: FoundCluster[]) => void>();
  private nextId = 1;

  private start(): Promise<Worker> {
    this.ready ??= new Promise((resolve, reject) => {
      const w = new ClusteringWorker();
      this.worker = w;
      w.onmessage = (ev: MessageEvent) => {
        const m = ev.data;
        if (m?.ready) {
          resolve(w);
        } else if (m?.id != null) {
          const done = this.pending.get(m.id);
          this.pending.delete(m.id);
          done?.(m.payload ?? []);
        }
      };
      w.onerror = (ev) => {
        ev.preventDefault();
        reject(new Error(`Clustering failed: ${ev.message}`));
        for (const done of this.pending.values()) done([]);
        this.pending.clear();
        this.ready = null;
        this.worker = null;
      };
    });
    return this.ready;
  }

  async find(grid: DensityGrid, unionThreshold: number): Promise<FoundCluster[]> {
    const w = await this.start();
    const id = this.nextId++;
    const data = grid.data.slice();
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      w.postMessage({ id, name: 'findClusters', payload: [data, grid.w, grid.h, { unionThreshold }] }, [data.buffer]);
    });
  }

  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }
}
