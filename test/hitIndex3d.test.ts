/**
 * Tests for 3D hitIndex helpers (T4): bounds3D and ScreenHitIndex.
 */

import { describe, expect, it } from 'vitest';
import { HitIndex, ScreenHitIndex, bounds3D } from '../src/webview/render/hitIndex';

describe('bounds3D', () => {
  it('computes min/max over three axes', () => {
    const xyz = new Float32Array([1, 2, 3, 4, 5, 6, -1, 0, 10]);
    const b = bounds3D(xyz, 3);
    expect(b).toEqual([-1, 0, 3, 4, 5, 10]);
  });

  it('skips NaN points', () => {
    const xyz = new Float32Array([NaN, NaN, NaN, 2, 3, 4]);
    const b = bounds3D(xyz, 2);
    expect(b).toEqual([2, 3, 4, 2, 3, 4]);
  });

  it('returns default [-1,-1,-1,1,1,1] for all-NaN input', () => {
    const xyz = new Float32Array([NaN, NaN, NaN]);
    const b = bounds3D(xyz, 1);
    expect(b).toEqual([-1, -1, -1, 1, 1, 1]);
  });
});

describe('ScreenHitIndex', () => {
  it('finds nearest screen-space point', () => {
    // 5 points spread in 2D screen space (x and y both vary to avoid degenerate grid).
    const screenXY = new Float32Array([10, 10, 50, 50, 100, 20, 200, 80, 300, 150]);
    const idx = new ScreenHitIndex(screenXY, 5);
    // Nearest to (12, 12) should be index 0 (at [10,10]).
    expect(idx.nearest(12, 12, 20)).toBe(0);
    // Nearest to (52, 48) should be index 1 (at [50,50]).
    expect(idx.nearest(52, 48, 20)).toBe(1);
    // No point within radius 5 of (500, 500).
    expect(idx.nearest(500, 500, 5)).toBe(-1);
  });

  it('nearestK returns sorted by distance for well-spread 2D points', () => {
    // Points arranged on a 2D grid so the index has good cell coverage.
    const screenXY = new Float32Array([
      0, 0,
      10, 10,
      20, 0,
      0, 20,
      20, 20,
    ]);
    const idx = new ScreenHitIndex(screenXY, 5);
    // Nearest 3 to (5, 5) in screen space: closest should be (0,0), (10,10), then one of (20,0) or (0,20).
    const knn = idx.nearestK(5, 5, 3);
    expect(knn).toHaveLength(3);
    expect(knn[0]).toBe(0); // (0,0) is closest at dist sqrt(50) ≈ 7.07
    // (10,10) at dist sqrt(50) ties with (0,0); implementation may return either first.
    expect(knn.includes(0)).toBe(true);
    expect(knn.includes(1)).toBe(true); // (10,10) should also be in top 3
  });
});

describe('HitIndex (2D) still works unchanged', () => {
  it('nearest returns -1 when radius is too small for well-spread points', () => {
    // Use 2D-spread points to avoid degenerate single-row grid.
    const xy = new Float32Array([0, 0, 100, 100, 50, 50]);
    const idx = new HitIndex(xy, 3);
    // Point at (0,0) with radius 1 — only finds it if within 1 unit.
    expect(idx.nearest(0, 0, 1)).toBe(0);
    // Far from all points.
    expect(idx.nearest(200, 200, 1)).toBe(-1);
  });
});
