// Automatic clusters of the 2D layout: a density map of the points, clustered with
// embedding-atlas's density clustering (see clusterWorker.ts), then points assigned to clusters.

export interface DensityGrid {
  /** Smoothed point density per cell, row-major (w × h), scaled so the maximum is 100. */
  data: Float32Array;
  w: number;
  h: number;
  /** World coordinates of the grid's corner and the size of one cell. */
  minX: number;
  minY: number;
  cell: number;
}

/**
 * Union thresholds for the "Detail" levels 1 (fewer, larger clusters) to 5 (more, smaller ones),
 * for a density map whose maximum is 100. Tuned on MNIST and synthetic blobs: on a UMAP of MNIST
 * they give about 11, 13, 20, 43 and 55 clusters.
 */
export const DETAIL_THRESHOLDS = [16, 10, 6, 3, 1.5];

/** Clusters whose total density is below this share of the largest one are dropped (as in embedding-atlas). */
const MIN_DENSITY_SHARE = 0.005;

/** Histogram of the points on a size × size grid (5% padding), Gaussian-blurred by sigma cells. */
export function densityGrid(xy: Float32Array, n: number, size = 256, sigma = 3): DensityGrid | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = xy[2 * i];
    const y = xy[2 * i + 1];
    if (!(x === x && y === y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!isFinite(minX)) return null;
  const span = Math.max(maxX - minX, maxY - minY, 1e-9);
  const pad = 0.05 * span;
  minX -= pad;
  minY -= pad;
  const cell = (span + 2 * pad) / size;
  const w = Math.max(1, Math.min(size, Math.ceil((maxX + pad - minX) / cell)));
  const h = Math.max(1, Math.min(size, Math.ceil((maxY + pad - minY) / cell)));
  const hist = new Float32Array(w * h);
  for (let i = 0; i < n; i++) {
    const x = xy[2 * i];
    const y = xy[2 * i + 1];
    if (!(x === x && y === y)) continue;
    const cx = Math.min(w - 1, Math.floor((x - minX) / cell));
    const cy = Math.min(h - 1, Math.floor((y - minY) / cell));
    hist[cy * w + cx]++;
  }
  // Separable Gaussian blur.
  const rad = Math.max(1, Math.ceil(3 * sigma));
  const kernel = new Float32Array(2 * rad + 1);
  for (let i = -rad; i <= rad; i++) kernel[i + rad] = Math.exp(-(i * i) / (2 * sigma * sigma));
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -rad; i <= rad; i++) {
        const xx = x + i;
        if (xx >= 0 && xx < w) s += hist[y * w + xx] * kernel[i + rad];
      }
      tmp[y * w + x] = s;
    }
  }
  const data = new Float32Array(w * h);
  let max = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -rad; i <= rad; i++) {
        const yy = y + i;
        if (yy >= 0 && yy < h) s += tmp[yy * w + x] * kernel[i + rad];
      }
      data[y * w + x] = s;
      if (s > max) max = s;
    }
  }
  if (max > 0) {
    for (let i = 0; i < data.length; i++) data[i] = (data[i] / max) * 100;
  }
  return { data, w, h, minX, minY, cell };
}

/** A cluster as returned by findClusters (grid-cell coordinates). */
export interface FoundCluster {
  sumDensity: number;
  meanX: number;
  meanY: number;
  boundary?: [number, number][][];
}

export interface ClusterAssignment {
  /** Cluster of each point (0..k-1, largest first), or k for points in no cluster. */
  codes: Uint16Array;
  k: number;
  /** Points per cluster. */
  counts: number[];
  /** Boundary rings per cluster, in world coordinates. */
  outlines: [number, number][][][];
}

function inRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Assign points to clusters through the grid: each cell belongs to the cluster whose boundary
 * contains the cell's center (even-odd over all of the cluster's rings, so holes stay holes).
 * Small clusters (by total density) and clusters without points are dropped; the rest are
 * numbered from the largest (most points) down.
 */
export function assignToClusters(grid: DensityGrid, found: FoundCluster[], xy: Float32Array, n: number): ClusterAssignment {
  const top = Math.max(0, ...found.map((c) => c.sumDensity));
  const kept = found.filter((c) => c.boundary && c.boundary.length && c.sumDensity >= MIN_DENSITY_SHARE * top);
  const { w, h } = grid;
  const owner = new Int32Array(w * h).fill(-1);
  kept.forEach((c, ci) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const ring of c.boundary!) {
      for (const [x, y] of ring) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
    for (let cy = Math.max(0, Math.floor(y0)); cy <= Math.min(h - 1, Math.ceil(y1)); cy++) {
      for (let cx = Math.max(0, Math.floor(x0)); cx <= Math.min(w - 1, Math.ceil(x1)); cx++) {
        if (owner[cy * w + cx] >= 0) continue;
        let inside = false;
        for (const ring of c.boundary!) if (inRing(cx + 0.5, cy + 0.5, ring)) inside = !inside;
        if (inside) owner[cy * w + cx] = ci;
      }
    }
  });
  // Count points per cluster, then renumber by size.
  const raw = new Int32Array(n).fill(-1);
  const counts = new Array(kept.length).fill(0);
  for (let i = 0; i < n; i++) {
    const x = xy[2 * i];
    const y = xy[2 * i + 1];
    if (!(x === x && y === y)) continue;
    const cx = Math.floor((x - grid.minX) / grid.cell);
    const cy = Math.floor((y - grid.minY) / grid.cell);
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
    const o = owner[cy * w + cx];
    if (o >= 0) {
      raw[i] = o;
      counts[o]++;
    }
  }
  const order = kept.map((_, i) => i).filter((i) => counts[i] > 0).sort((a, b) => counts[b] - counts[a]);
  const remap = new Int32Array(kept.length).fill(-1);
  order.forEach((ci, rank) => (remap[ci] = rank));
  const k = order.length;
  const codes = new Uint16Array(n);
  for (let i = 0; i < n; i++) codes[i] = raw[i] >= 0 ? remap[raw[i]] : k;
  const toWorld = ([x, y]: [number, number]): [number, number] => [grid.minX + x * grid.cell, grid.minY + y * grid.cell];
  return {
    codes,
    k,
    counts: order.map((ci) => counts[ci]),
    outlines: order.map((ci) => kept[ci].boundary!.map((ring) => ring.map(toWorld))),
  };
}
