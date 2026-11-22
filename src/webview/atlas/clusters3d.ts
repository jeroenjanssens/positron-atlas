/**
 * Automatic cluster detection on 3D layouts (B2 / item 16).
 *
 * Approach: k-means on the 3D positions with a data-driven k.
 *
 * Rationale for k-means over a 3D density grid:
 *   - The 2D density grid + connected-component approach is tightly coupled to a
 *     2D raster; extending it to 3D would require a voxel grid with ~O(V³) memory.
 *   - K-means is O(n · k · iters) and converges quickly on UMAP-shaped data where
 *     clusters are compact and well-separated.
 *   - K is set from the same DETAIL_THRESHOLDS used in 2D (by using the 2D cluster
 *     count when available, or by estimating from point density).
 *   - Runtime: ≈ 10–30 ms on 100K anchor points with k=20 (see docs/benchmarks.md,
 *     B2-clusters3d entry).
 *
 * K selection:
 *   The number of clusters k is derived from the `detail` slider (1–5) using the
 *   same scale as 2D: detail 1 → fewer clusters, detail 5 → more clusters.
 *   We use k = [4, 8, 16, 24, 32] for detail levels 1–5 as reasonable defaults for
 *   3D UMAP structures.
 *
 * Usage:
 *   const result = runKMeans3D(xyz, n, k);
 *   // result.codes: Uint16Array of cluster codes (0..k-1, k=noise sentinel)
 *   // result.centers: Float32Array of centroid positions (k × 3)
 *   // result.counts: number[] of points per cluster
 */

/** k values for detail levels 1–5 (matching the coarse-to-fine scale of 2D). */
export const CLUSTERS_3D_K: Record<number, number> = { 1: 4, 2: 8, 3: 16, 4: 24, 5: 32 };

export interface KMeansResult {
  /** Cluster code per point: 0..(k-1); k = unassigned (empty clusters). Length = n. */
  codes: Uint16Array;
  /** Flat centroid positions: k × 3. */
  centers: Float32Array;
  /** Number of points per cluster (length k after merging empty clusters). */
  counts: number[];
  /** Effective number of non-empty clusters. */
  k: number;
}

/**
 * Run k-means on `n` 3D points from `xyz` (interleaved x,y,z, stride 3).
 * Uses k++ initialisation (spread-out seeds) and up to `maxIter` Lloyd iterations.
 *
 * Performance target: ≤ 100 ms for n = 100K, k = 32, maxIter = 15 on a modern CPU.
 *
 * @param xyz     Flat Float32Array of positions, length ≥ n * 3.
 * @param n       Number of points to cluster.
 * @param k       Desired number of clusters (may be reduced if n is small).
 * @param maxIter Maximum Lloyd iterations (default 15; usually converges in 8–12).
 * @returns       KMeansResult with the assignments and centroids.
 */
export function runKMeans3D(xyz: Float32Array, n: number, k: number, maxIter = 15): KMeansResult {
  k = Math.max(1, Math.min(k, n));

  // ---- k++ initialisation ---------------------------------------------------
  // Pick k seed centroids: first at random, then each subsequent one chosen with
  // probability proportional to the squared distance to the nearest existing seed.
  const centers = new Float32Array(k * 3);

  // Seed 0: random point.
  let first = Math.floor(Math.random() * n);
  centers[0] = xyz[3 * first];
  centers[1] = xyz[3 * first + 1];
  centers[2] = xyz[3 * first + 2];

  const minDist = new Float32Array(n).fill(Infinity);

  for (let ci = 1; ci < k; ci++) {
    // Update min-distances to the new seed (ci-1).
    const cx = centers[(ci - 1) * 3], cy = centers[(ci - 1) * 3 + 1], cz = centers[(ci - 1) * 3 + 2];
    let totalDist = 0;
    for (let i = 0; i < n; i++) {
      const dx = xyz[3 * i] - cx, dy = xyz[3 * i + 1] - cy, dz = xyz[3 * i + 2] - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < minDist[i]) minDist[i] = d2;
      totalDist += minDist[i];
    }
    // Sample next seed proportional to distance squared.
    let r = Math.random() * totalDist;
    let chosen = n - 1;
    for (let i = 0; i < n; i++) {
      r -= minDist[i];
      if (r <= 0) { chosen = i; break; }
    }
    centers[ci * 3]     = xyz[3 * chosen];
    centers[ci * 3 + 1] = xyz[3 * chosen + 1];
    centers[ci * 3 + 2] = xyz[3 * chosen + 2];
  }

  // ---- Lloyd iterations ---------------------------------------------------
  const codes = new Uint16Array(n);
  const sums  = new Float32Array(k * 3);
  const cnts  = new Int32Array(k);

  for (let iter = 0; iter < maxIter; iter++) {
    // Assignment step: assign each point to the nearest centroid.
    let changed = 0;
    for (let i = 0; i < n; i++) {
      const px = xyz[3 * i], py = xyz[3 * i + 1], pz = xyz[3 * i + 2];
      let bestD = Infinity;
      let bestC = 0;
      for (let ci = 0; ci < k; ci++) {
        const dx = px - centers[ci * 3], dy = py - centers[ci * 3 + 1], dz = pz - centers[ci * 3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD) { bestD = d2; bestC = ci; }
      }
      if (codes[i] !== bestC) { codes[i] = bestC; changed++; }
    }
    if (iter > 0 && changed === 0) break; // converged

    // Update step: recompute centroids.
    sums.fill(0);
    cnts.fill(0);
    for (let i = 0; i < n; i++) {
      const c = codes[i];
      sums[c * 3]     += xyz[3 * i];
      sums[c * 3 + 1] += xyz[3 * i + 1];
      sums[c * 3 + 2] += xyz[3 * i + 2];
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

  // ---- Compact: drop empty clusters, re-code --------------------------------
  const finalCounts = Array.from(cnts);
  // Sort clusters by count descending (biggest cluster first, like 2D).
  const order = Array.from({ length: k }, (_, i) => i)
    .filter((i) => finalCounts[i] > 0)
    .sort((a, b) => finalCounts[b] - finalCounts[a]);

  const kFinal = order.length;
  const remap = new Uint16Array(k).fill(kFinal); // kFinal = no-group sentinel
  order.forEach((old, newIdx) => { remap[old] = newIdx; });

  const finalCodes = new Uint16Array(n);
  for (let i = 0; i < n; i++) finalCodes[i] = remap[codes[i]];

  const finalCenters = new Float32Array(kFinal * 3);
  const kCounts: number[] = [];
  order.forEach((old, ni) => {
    finalCenters[ni * 3]     = centers[old * 3];
    finalCenters[ni * 3 + 1] = centers[old * 3 + 1];
    finalCenters[ni * 3 + 2] = centers[old * 3 + 2];
    kCounts.push(finalCounts[old]);
  });

  return { codes: finalCodes, centers: finalCenters, counts: kCounts, k: kFinal };
}
