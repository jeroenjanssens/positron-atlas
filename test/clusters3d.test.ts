/**
 * Unit tests for 3D k-means clustering (B2 / item 16).
 * See src/webview/atlas/clusters3d.ts.
 */

import { describe, it, expect } from 'vitest';
import { runKMeans3D, CLUSTERS_3D_K } from '../src/webview/atlas/clusters3d';

// ---------------------------------------------------------------------------
// CLUSTERS_3D_K constant
// ---------------------------------------------------------------------------

describe('CLUSTERS_3D_K', () => {
  it('has entries for all 5 detail levels', () => {
    for (let d = 1; d <= 5; d++) {
      expect(CLUSTERS_3D_K[d]).toBeGreaterThan(0);
    }
  });

  it('increases monotonically with detail', () => {
    for (let d = 2; d <= 5; d++) {
      expect(CLUSTERS_3D_K[d]).toBeGreaterThan(CLUSTERS_3D_K[d - 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// runKMeans3D
// ---------------------------------------------------------------------------

describe('runKMeans3D', () => {
  it('returns k=n when fewer points than requested clusters', () => {
    const xyz = new Float32Array([1, 0, 0, 0, 1, 0]); // 2 points
    const result = runKMeans3D(xyz, 2, 10); // ask for 10, only 2 points
    // codes should cover both points, effective k ≤ 2
    expect(result.k).toBeLessThanOrEqual(2);
    expect(result.codes.length).toBe(2);
  });

  it('assigns all points to k=1 cluster when k=1', () => {
    const n = 20;
    const xyz = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) xyz[i] = Math.random() * 10;
    const result = runKMeans3D(xyz, n, 1);
    expect(result.k).toBe(1);
    expect(result.counts).toHaveLength(1);
    expect(result.counts[0]).toBe(n);
    // All codes should be 0
    for (let i = 0; i < n; i++) expect(result.codes[i]).toBe(0);
  });

  it('separates two clearly distinct clusters', () => {
    // Cluster A: 50 points near (0, 0, 0)
    // Cluster B: 50 points near (100, 100, 100)
    const n = 100;
    const xyz = new Float32Array(n * 3);
    for (let i = 0; i < 50; i++) {
      xyz[i * 3]     = Math.random() * 2 - 1;   // ≈ 0
      xyz[i * 3 + 1] = Math.random() * 2 - 1;
      xyz[i * 3 + 2] = Math.random() * 2 - 1;
    }
    for (let i = 50; i < 100; i++) {
      xyz[i * 3]     = 100 + Math.random() * 2 - 1; // ≈ 100
      xyz[i * 3 + 1] = 100 + Math.random() * 2 - 1;
      xyz[i * 3 + 2] = 100 + Math.random() * 2 - 1;
    }
    const result = runKMeans3D(xyz, n, 2, 20);
    expect(result.k).toBe(2);
    // Both clusters should have exactly 50 points (well-separated → perfect assignment)
    const counts = [...result.counts].sort((a, b) => a - b);
    expect(counts).toEqual([50, 50]);
  });

  it('sorts clusters by count descending (largest cluster first)', () => {
    // Cluster A: 60 points, Cluster B: 40 points
    const nA = 60, nB = 40;
    const n = nA + nB;
    const xyz = new Float32Array(n * 3);
    for (let i = 0; i < nA; i++) {
      xyz[i * 3] = Math.random(); xyz[i * 3 + 1] = Math.random(); xyz[i * 3 + 2] = Math.random();
    }
    for (let i = nA; i < n; i++) {
      xyz[i * 3] = 100 + Math.random(); xyz[i * 3 + 1] = 100 + Math.random(); xyz[i * 3 + 2] = 100 + Math.random();
    }
    const result = runKMeans3D(xyz, n, 2, 20);
    expect(result.k).toBe(2);
    // counts should be descending
    expect(result.counts[0]).toBeGreaterThanOrEqual(result.counts[1]);
  });

  it('codes array has length equal to n', () => {
    const n = 150;
    const xyz = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) xyz[i] = Math.random();
    const result = runKMeans3D(xyz, n, 5);
    expect(result.codes.length).toBe(n);
  });

  it('all codes are in range [0, k)', () => {
    const n = 200;
    const xyz = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) xyz[i] = Math.random() * 50;
    const result = runKMeans3D(xyz, n, 8);
    for (let i = 0; i < n; i++) {
      expect(result.codes[i]).toBeGreaterThanOrEqual(0);
      expect(result.codes[i]).toBeLessThan(result.k);
    }
  });

  it('total counts sum to n', () => {
    const n = 300;
    const xyz = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) xyz[i] = Math.random() * 100;
    const result = runKMeans3D(xyz, n, 10);
    const total = result.counts.reduce((s, c) => s + c, 0);
    expect(total).toBe(n);
  });

  it('centers array has length k*3', () => {
    const n = 100;
    const xyz = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) xyz[i] = Math.random();
    const result = runKMeans3D(xyz, n, 6);
    expect(result.centers.length).toBe(result.k * 3);
  });

  it('runs in < 500 ms on 100K points with k=32 (performance smoke test)', () => {
    const n = 100_000;
    const k = 32;
    const xyz = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) xyz[i] = Math.random() * 100;
    const t0 = Date.now();
    const result = runKMeans3D(xyz, n, k, 15);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500);
    expect(result.k).toBeGreaterThan(0);
    expect(result.k).toBeLessThanOrEqual(k);
  });
});
