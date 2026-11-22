/**
 * Unit tests for the box geometry helpers in src/webview/render/boxes.ts (B2).
 */

import { describe, it, expect } from 'vitest';
import {
  percentileVal,
  groupExtents2D,
  groupExtents3D,
  fullExtent3D,
} from '../src/webview/render/boxes';

// ---------------------------------------------------------------------------
// percentileVal
// ---------------------------------------------------------------------------

describe('percentileVal', () => {
  it('returns 0 for empty array', () => {
    expect(percentileVal([], 0.5)).toBe(0);
  });

  it('returns the only element for a single-element array', () => {
    expect(percentileVal([7], 0)).toBe(7);
    expect(percentileVal([7], 0.5)).toBe(7);
    expect(percentileVal([7], 1)).toBe(7);
  });

  it('returns the first element at p=0', () => {
    expect(percentileVal([1, 2, 3, 4, 5], 0)).toBe(1);
  });

  it('returns the last element at p=1', () => {
    expect(percentileVal([1, 2, 3, 4, 5], 1)).toBe(5);
  });

  it('returns the median for p=0.5 on an odd-length array', () => {
    expect(percentileVal([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });

  it('interpolates correctly between two elements', () => {
    // Array [0, 10]: p=0.5 → idx = 0.5 → 0 + 10*0.5 = 5
    expect(percentileVal([0, 10], 0.5)).toBe(5);
  });

  it('computes 2nd percentile (p=0.02) on 100 sorted values', () => {
    const a = Array.from({ length: 100 }, (_, i) => i); // 0..99
    // idx = 0.02 * 99 = 1.98 → between 1 and 2: 1 + 1*0.98 = 1.98
    expect(percentileVal(a, 0.02)).toBeCloseTo(1.98);
  });

  it('computes 98th percentile (p=0.98) on 100 sorted values', () => {
    const a = Array.from({ length: 100 }, (_, i) => i);
    // idx = 0.98 * 99 = 97.02 → 97 + 1*0.02 = 97.02
    expect(percentileVal(a, 0.98)).toBeCloseTo(97.02);
  });
});

// ---------------------------------------------------------------------------
// groupExtents2D
// ---------------------------------------------------------------------------

describe('groupExtents2D', () => {
  it('returns null for a group with no points', () => {
    // 2 groups (k=2), only group 0 has points
    const positions = new Float32Array([1, 2, 3, 4]); // 2 points stride=2
    const codes = new Uint16Array([0, 0]);
    const extents = groupExtents2D(positions, codes, 2);
    expect(extents[0]).not.toBeNull();
    expect(extents[1]).toBeNull();
  });

  it('returns exact bounds when all points are identical', () => {
    const positions = new Float32Array([5, 7, 5, 7, 5, 7]);
    const codes = new Uint16Array([0, 0, 0]);
    const extents = groupExtents2D(positions, codes, 1);
    expect(extents[0]).toEqual([5, 7, 5, 7]);
  });

  it('clips outliers with percentile clipping', () => {
    // 100 points near [0,0], one outlier at [1000,1000] (code 0)
    const n = 101;
    const positions = new Float32Array(n * 2);
    for (let i = 0; i < 100; i++) { positions[i * 2] = i; positions[i * 2 + 1] = i; }
    positions[100 * 2] = 1000; positions[100 * 2 + 1] = 1000; // outlier
    const codes = new Uint16Array(n).fill(0);
    const extents = groupExtents2D(positions, codes, 1, 2, 0.02, 0.98);
    // With 101 points sorted, the outlier at 1000 is at index 100 (p=100/100=1.0 → inside 98th)
    // 98th percentile index = 0.98 * 100 = 98 → value = 98
    expect(extents[0]![2]).toBeCloseTo(98, 0); // maxX ≈ 98 (not 1000)
  });

  it('handles noise codes (>= k) by ignoring them', () => {
    const positions = new Float32Array([1, 2, 3, 4, 100, 200]); // 3 points
    const codes = new Uint16Array([0, 1, 2]); // code 2 >= k=2 → noise
    const extents = groupExtents2D(positions, codes, 2);
    expect(extents.length).toBe(2);
    // group 0 has point (1,2), group 1 has point (3,4), point with code 2 is noise
    expect(extents[0]).toEqual([1, 2, 1, 2]);
    expect(extents[1]).toEqual([3, 4, 3, 4]);
  });

  it('works with stride=3 (3D positions, only reads x and y)', () => {
    const positions = new Float32Array([1, 2, 99, 3, 4, 99]); // 2 points, stride=3
    const codes = new Uint16Array([0, 0]);
    const extents = groupExtents2D(positions, codes, 1, 3);
    expect(extents[0]).not.toBeNull();
    const [x0, y0, x1, y1] = extents[0]!;
    // 2 points, sorted x = [1, 3]: default percentiles 0.01 and 0.99 interpolate to 1.02 and 2.98.
    expect(x0).toBeCloseTo(1.02, 5);
    expect(y0).toBeCloseTo(2.02, 5);
    expect(x1).toBeCloseTo(2.98, 5);
    expect(y1).toBeCloseTo(3.98, 5);
  });

  it('handles 1M points in < 2 seconds (performance smoke test)', () => {
    const n = 1_000_000;
    const k = 20;
    const positions = new Float32Array(n * 2);
    const codes = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      positions[i * 2]     = Math.random() * 100;
      positions[i * 2 + 1] = Math.random() * 100;
      codes[i] = Math.floor(Math.random() * (k + 1)); // includes noise
    }
    const t0 = Date.now();
    const extents = groupExtents2D(positions, codes, k);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(extents.length).toBe(k);
  });
});

// ---------------------------------------------------------------------------
// groupExtents3D
// ---------------------------------------------------------------------------

describe('groupExtents3D', () => {
  it('returns null for empty groups', () => {
    const positions = new Float32Array([1, 2, 3]);
    const codes = new Uint16Array([0]);
    const extents = groupExtents3D(positions, codes, 2);
    expect(extents[0]).not.toBeNull();
    expect(extents[1]).toBeNull();
  });

  it('returns correct 3D extents for a single point', () => {
    const positions = new Float32Array([4, 5, 6]);
    const codes = new Uint16Array([0]);
    const extents = groupExtents3D(positions, codes, 1);
    expect(extents[0]).toEqual([4, 5, 6, 4, 5, 6]);
  });

  it('returns correct 3D extents for two distinct points', () => {
    const positions = new Float32Array([0, 0, 0, 10, 10, 10]);
    const codes = new Uint16Array([0, 0]);
    const extents = groupExtents3D(positions, codes, 1);
    // sorted x = [0, 10]: default 3D percentiles 0.005 and 0.995 interpolate to 0.05 and 9.95.
    const [x0, y0, z0, x1, y1, z1] = extents[0]!;
    expect(x0).toBeCloseTo(0.05);
    expect(y0).toBeCloseTo(0.05);
    expect(z0).toBeCloseTo(0.05);
    expect(x1).toBeCloseTo(9.95);
    expect(y1).toBeCloseTo(9.95);
    expect(z1).toBeCloseTo(9.95);
  });

  it('ignores points with codes >= k', () => {
    const positions = new Float32Array([1, 2, 3, 100, 100, 100]);
    const codes = new Uint16Array([0, 1]); // code 1 >= k=1 → noise
    const extents = groupExtents3D(positions, codes, 1);
    expect(extents[0]).toEqual([1, 2, 3, 1, 2, 3]);
  });

  it('handles 1M points in 3D in < 3 seconds (performance smoke test)', () => {
    const n = 1_000_000;
    const k = 20;
    const positions = new Float32Array(n * 3);
    const codes = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      positions[i * 3]     = Math.random() * 100;
      positions[i * 3 + 1] = Math.random() * 100;
      positions[i * 3 + 2] = Math.random() * 100;
      codes[i] = Math.floor(Math.random() * (k + 1));
    }
    const t0 = Date.now();
    const extents = groupExtents3D(positions, codes, k);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(3000);
    expect(extents.length).toBe(k);
  });
});

// ---------------------------------------------------------------------------
// fullExtent3D
// ---------------------------------------------------------------------------

describe('fullExtent3D', () => {
  it('returns null for n=0', () => {
    const positions = new Float32Array(0);
    expect(fullExtent3D(positions, 0)).toBeNull();
  });

  it('returns exact min/max for a simple set of points', () => {
    // 3 points: (0,0,0), (5,3,2), (-1,4,10)
    const positions = new Float32Array([0, 0, 0, 5, 3, 2, -1, 4, 10]);
    const result = fullExtent3D(positions, 3);
    expect(result).toEqual([-1, 0, 0, 5, 4, 10]);
  });

  it('returns single-point extents (min == max) for n=1', () => {
    const positions = new Float32Array([3, 7, -2]);
    const result = fullExtent3D(positions, 1);
    expect(result).toEqual([3, 7, -2, 3, 7, -2]);
  });

  it('only reads the first n points even if array is longer', () => {
    const positions = new Float32Array([1, 2, 3,   999, 999, 999]);
    const result = fullExtent3D(positions, 1); // n=1 → only first point
    expect(result).toEqual([1, 2, 3, 1, 2, 3]);
  });
});
