/**
 * P7 spike: measure how browser-CPU UMAP time splits between kNN (NNDescent)
 * and SGD (createUMAPFromKNN).
 *
 * Usage: node docs/spikes/scripts/p7_umap_timing.mjs
 *
 * Synthetic Gaussian blobs (50 blobs, 50 dims), nNeighbors=15, 200 epochs, CPU only.
 */

import { createNNDescent, createUMAP, createUMAPFromKNN } from "/Users/jeroen/repos/mine/positron-atlas/.claude/worktrees/agent-ac2db1a9e21da2c0e/node_modules/embedding-atlas/dist/umap.js";

const N_BLOBS = 50;
const DIMS = 50;
const N_NEIGHBORS = 15;
const N_EPOCHS = 200;
const SEED = 42;

/** Generate n Gaussian blobs with d dimensions. */
function gaussianBlobs(n, d, nBlobs) {
  const data = new Float32Array(n * d);
  const rng = mulberry32(42);
  // blob centers
  const centers = new Float32Array(nBlobs * d);
  for (let i = 0; i < nBlobs * d; i++) centers[i] = (rng() - 0.5) * 20;
  for (let i = 0; i < n; i++) {
    const blob = i % nBlobs;
    for (let j = 0; j < d; j++) {
      data[i * d + j] = centers[blob * d + j] + boxMuller(rng) * 0.5;
    }
  }
  return data;
}

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boxMuller(rng) {
  const u = rng(), v = rng();
  return Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * v);
}

async function benchmark(n) {
  const data = gaussianBlobs(n, DIMS, N_BLOBS);
  const opts = { nNeighbors: N_NEIGHBORS, nEpochs: N_EPOCHS, gpu: false, seed: SEED };

  // (a) Full createUMAP: kNN + SGD
  const t0 = performance.now();
  const umapFull = await createUMAP(n, DIMS, 2, data, opts);
  await umapFull.run();
  const tFull = (performance.now() - t0) / 1000;

  // (b) createNNDescent alone
  const t1 = performance.now();
  const nnd = await createNNDescent(n, DIMS, data, { nNeighbors: N_NEIGHBORS, seed: SEED });
  const tKnn = (performance.now() - t1) / 1000;

  // Extract kNN graph from nnd
  const knnIdx = new Int32Array(n * N_NEIGHBORS);
  const knnDist = new Float32Array(n * N_NEIGHBORS);
  for (let i = 0; i < n; i++) {
    const r = nnd.queryByIndex(i, N_NEIGHBORS);
    for (let j = 0; j < N_NEIGHBORS; j++) {
      knnIdx[i * N_NEIGHBORS + j] = r.indices[j];
      knnDist[i * N_NEIGHBORS + j] = r.distances[j];
    }
  }
  nnd.destroy();

  // Also get knnIndices from createUMAP result (embedded kNN)
  const knnIdxFromUMAP = new Int32Array(umapFull.knnIndices);
  const knnDistFromUMAP = new Float32Array(umapFull.knnDistances);
  umapFull.destroy();

  // (c) createUMAPFromKNN: SGD only (using the extracted graph)
  const fromKnnOpts = { nEpochs: N_EPOCHS, seed: SEED };
  const t2 = performance.now();
  const umapFromKnn = await createUMAPFromKNN(n, 2, knnIdx, knnDist, fromKnnOpts);
  await umapFromKnn.run();
  const tSgd = (performance.now() - t2) / 1000;
  umapFromKnn.destroy();

  return { n, tFull, tKnn, tSgd };
}

async function main() {
  const sizes = [10_000, 25_000, 100_000];
  console.log("n,full_s,knn_s,sgd_s,knn_pct");
  for (const n of sizes) {
    process.stderr.write(`Running n=${n}...\n`);
    const r = await benchmark(n);
    const knnPct = (r.tKnn / r.tFull * 100).toFixed(1);
    console.log(`${r.n},${r.tFull.toFixed(2)},${r.tKnn.toFixed(2)},${r.tSgd.toFixed(2)},${knnPct}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
