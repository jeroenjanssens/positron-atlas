/// <reference lib="webworker" />
/**
 * Web worker for 3D k-means clustering (B2 / item 16).
 *
 * Runs entirely off the main thread:
 *   1. Optionally sub-samples up to `sampleMax` rows for the k-means fit.
 *   2. Runs k++ initialisation + Lloyd iterations on the sample.
 *   3. Assigns ALL n rows to their nearest centroid (not just the sample).
 *
 * Keeps per-run cancellation via runId: if a newer run message arrives the
 * worker discards old results.
 */

export interface WorkerIn {
  type: 'run';
  runId: number;
  /** Flat xyz positions of all n points (stride 3), transferred. */
  xyz: Float32Array;
  /** Total number of points. */
  n: number;
  /** Desired number of clusters. */
  k: number;
  /** Maximum number of points to use for k-means fitting (default 100 000). */
  sampleMax: number;
  /** Maximum Lloyd iterations (default 15). */
  maxIter: number;
  /** Seed for deterministic sampling (integer). */
  seed: number;
}

export interface WorkerOut {
  type: 'done';
  runId: number;
  /** Cluster code per row: 0..(k-1); k means unassigned. Length = n. */
  codes: Uint16Array;
  /** Final centroid positions, length = k * 3. */
  centers: Float32Array;
  /** Points per cluster, length = k. */
  counts: number[];
  /** Effective k after dropping empty clusters. */
  k: number;
  /** Number of points used for k-means fitting. */
  sampleN: number;
  /** Wall-clock milliseconds for the full run. */
  timeMs: number;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// ---------------------------------------------------------------------------
// Minimal LCG for seeded random numbers (avoid crypto overhead in a worker)
// ---------------------------------------------------------------------------
function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // Numerical Recipes LCG
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------
function sampleIndices(n: number, m: number, rand: () => number): Uint32Array {
  if (m >= n) {
    return Uint32Array.from({ length: n }, (_, i) => i);
  }
  // Fisher-Yates reservoir sampling (reservoir-based so we don't allocate an n-element array)
  const indices = new Uint32Array(m);
  for (let i = 0; i < m; i++) indices[i] = i;
  for (let i = m; i < n; i++) {
    const j = Math.floor(rand() * (i + 1));
    if (j < m) indices[j] = i;
  }
  return indices;
}

// ---------------------------------------------------------------------------
// k++ initialisation
// ---------------------------------------------------------------------------
function kPlusPlusInit(
  xyz: Float32Array,
  indices: Uint32Array,
  k: number,
  rand: () => number,
): Float32Array {
  const n = indices.length;
  k = Math.min(k, n);
  const centers = new Float32Array(k * 3);
  const minDist = new Float32Array(n).fill(Infinity);

  // Seed 0: random point.
  const first = Math.floor(rand() * n);
  const fi = indices[first];
  centers[0] = xyz[3 * fi];
  centers[1] = xyz[3 * fi + 1];
  centers[2] = xyz[3 * fi + 2];

  for (let ci = 1; ci < k; ci++) {
    const cx = centers[(ci - 1) * 3], cy = centers[(ci - 1) * 3 + 1], cz = centers[(ci - 1) * 3 + 2];
    let total = 0;
    for (let si = 0; si < n; si++) {
      const idx = indices[si];
      const dx = xyz[3 * idx] - cx, dy = xyz[3 * idx + 1] - cy, dz = xyz[3 * idx + 2] - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < minDist[si]) minDist[si] = d2;
      total += minDist[si];
    }
    let r = rand() * total;
    let chosen = indices[n - 1];
    for (let si = 0; si < n; si++) {
      r -= minDist[si];
      if (r <= 0) { chosen = indices[si]; break; }
    }
    centers[ci * 3]     = xyz[3 * chosen];
    centers[ci * 3 + 1] = xyz[3 * chosen + 1];
    centers[ci * 3 + 2] = xyz[3 * chosen + 2];
  }
  return centers;
}

// ---------------------------------------------------------------------------
// Lloyd iterations on a subset of points (the sample)
// ---------------------------------------------------------------------------
function lloyd(
  xyz: Float32Array,
  indices: Uint32Array,
  centers: Float32Array,
  k: number,
  maxIter: number,
): Float32Array {
  const n = indices.length;
  const codes = new Uint16Array(n);
  const sums = new Float32Array(k * 3);
  const cnts = new Int32Array(k);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = 0;
    for (let si = 0; si < n; si++) {
      const idx = indices[si];
      const px = xyz[3 * idx], py = xyz[3 * idx + 1], pz = xyz[3 * idx + 2];
      let bestD = Infinity, bestC = 0;
      for (let ci = 0; ci < k; ci++) {
        const dx = px - centers[ci * 3], dy = py - centers[ci * 3 + 1], dz = pz - centers[ci * 3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD) { bestD = d2; bestC = ci; }
      }
      if (codes[si] !== bestC) { codes[si] = bestC; changed++; }
    }
    if (iter > 0 && changed === 0) break;
    sums.fill(0);
    cnts.fill(0);
    for (let si = 0; si < n; si++) {
      const idx = indices[si];
      const c = codes[si];
      sums[c * 3]     += xyz[3 * idx];
      sums[c * 3 + 1] += xyz[3 * idx + 1];
      sums[c * 3 + 2] += xyz[3 * idx + 2];
      cnts[c]++;
    }
    for (let ci = 0; ci < k; ci++) {
      if (cnts[ci] > 0) {
        centers[ci * 3]     = sums[ci * 3]     / cnts[ci];
        centers[ci * 3 + 1] = sums[ci * 3 + 1] / cnts[ci];
        centers[ci * 3 + 2] = sums[ci * 3 + 2] / cnts[ci];
      }
    }
  }
  return centers;
}

// ---------------------------------------------------------------------------
// Assign ALL n rows to nearest centroid
// ---------------------------------------------------------------------------
function assignAll(xyz: Float32Array, n: number, centers: Float32Array, k: number): {
  codes: Uint16Array;
  cnts: Int32Array;
} {
  const codes = new Uint16Array(n);
  const cnts = new Int32Array(k);
  for (let i = 0; i < n; i++) {
    const px = xyz[3 * i], py = xyz[3 * i + 1], pz = xyz[3 * i + 2];
    let bestD = Infinity, bestC = 0;
    for (let ci = 0; ci < k; ci++) {
      const dx = px - centers[ci * 3], dy = py - centers[ci * 3 + 1], dz = pz - centers[ci * 3 + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD) { bestD = d2; bestC = ci; }
    }
    codes[i] = bestC;
    cnts[bestC]++;
  }
  return { codes, cnts };
}

// ---------------------------------------------------------------------------
// Compact: drop empty clusters, sort by count descending, remap codes
// ---------------------------------------------------------------------------
function compact(codes: Uint16Array, n: number, cnts: Int32Array, centers: Float32Array, k: number): WorkerOut['k'] extends number ? { codes: Uint16Array; centers: Float32Array; counts: number[] } : never {
  const order = Array.from({ length: k }, (_, i) => i)
    .filter((i) => cnts[i] > 0)
    .sort((a, b) => cnts[b] - cnts[a]);
  const kFinal = order.length;
  const remap = new Uint16Array(k).fill(kFinal);
  order.forEach((old, ni) => { remap[old] = ni; });

  const finalCodes = new Uint16Array(n);
  for (let i = 0; i < n; i++) finalCodes[i] = remap[codes[i]];

  const finalCenters = new Float32Array(kFinal * 3);
  const kCounts: number[] = [];
  order.forEach((old, ni) => {
    finalCenters[ni * 3]     = centers[old * 3];
    finalCenters[ni * 3 + 1] = centers[old * 3 + 1];
    finalCenters[ni * 3 + 2] = centers[old * 3 + 2];
    kCounts.push(cnts[old]);
  });
  return { codes: finalCodes, centers: finalCenters, counts: kCounts } as any;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
ctx.onmessage = (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  if (msg.type !== 'run') return;

  const t0 = performance.now();
  const { runId, xyz, n, seed } = msg;
  const sampleMax = msg.sampleMax ?? 100_000;
  const maxIter = msg.maxIter ?? 15;
  let k = Math.max(1, Math.min(msg.k, n));

  const rand = makeLcg(seed ^ (k * 65537));

  // 1. Sub-sample for fitting.
  const indices = sampleIndices(n, sampleMax, rand);
  const sampleN = indices.length;

  // 2. k++ init + Lloyd on sample.
  let centers = kPlusPlusInit(xyz, indices, k, rand);
  k = centers.length / 3;
  centers = lloyd(xyz, indices, centers, k, maxIter);

  // 3. Assign all n rows to nearest centroid.
  const { codes: rawCodes, cnts } = assignAll(xyz, n, centers, k);

  // 4. Compact: drop empty clusters, sort by count descending.
  const { codes, centers: finalCenters, counts } = compact(rawCodes, n, cnts, centers, k);
  const kFinal = counts.length;

  const timeMs = performance.now() - t0;
  const out: WorkerOut = { type: 'done', runId, codes, centers: finalCenters, counts, k: kFinal, sampleN, timeMs };
  ctx.postMessage(out, [codes.buffer, finalCenters.buffer]);
};
