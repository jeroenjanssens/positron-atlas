import { describe, expect, it } from 'vitest';
import { assignToClusters, densityGrid, type FoundCluster } from '../src/webview/labels/clusters';

describe('densityGrid', () => {
  it('bins and blurs points, peaking at 100 where the points are', () => {
    const xy = new Float32Array([0, 0, 0, 0, 0, 0, 10, 10]);
    const g = densityGrid(xy, 4, 64, 2)!;
    expect(g.w).toBe(64);
    expect(g.h).toBe(64);
    let max = 0;
    let at = -1;
    g.data.forEach((v, i) => {
      if (v > max) [max, at] = [v, i];
    });
    expect(max).toBeCloseTo(100);
    // The peak is in the cell of (0, 0).
    expect(Math.floor((0 - g.minX) / g.cell)).toBe(at % g.w);
    expect(Math.floor((0 - g.minY) / g.cell)).toBe(Math.floor(at / g.w));
    expect(densityGrid(new Float32Array([NaN, NaN]), 1)).toBeNull();
  });
});

describe('assignToClusters', () => {
  it('assigns points through the cluster boundaries, largest cluster first', () => {
    // Grid 10 × 10 over [0, 10): cell = 1, corner (0, 0).
    const grid = { data: new Float32Array(100), w: 10, h: 10, minX: 0, minY: 0, cell: 1 };
    const square = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const found: FoundCluster[] = [
      { sumDensity: 50, meanX: 2, meanY: 2, boundary: [square(0, 0, 4, 4)] },
      { sumDensity: 80, meanX: 7, meanY: 7, boundary: [square(5, 5, 10, 10), square(7, 7, 8, 8)] }, // with a hole
      { sumDensity: 0.1, meanX: 1, meanY: 9, boundary: [square(0, 8, 2, 10)] }, // too small: dropped
      { sumDensity: 60, meanX: 9, meanY: 1, boundary: [square(8, 0, 10, 2)] }, // no points: dropped
    ];
    const pts = [1.5, 1.5, 2.5, 2.5, 6, 6, 9, 9, 7.5, 7.5 /* hole */, 1, 9 /* small cluster */, 4.5, 4.5 /* between */];
    const a = assignToClusters(grid, found, new Float32Array(pts), pts.length / 2);
    expect(a.k).toBe(2);
    // Two points each; the second cluster (index 1 in found) has 2 points too, ties keep input order.
    expect(a.counts).toEqual([2, 2]);
    expect([...a.codes]).toEqual([0, 0, 1, 1, 2, 2, 2]);
    // Outlines in world coordinates, holes included.
    expect(a.outlines[1]).toHaveLength(2);
    expect(a.outlines[0][0][1]).toEqual([4, 0]);
  });

  it('handles no clusters', () => {
    const grid = { data: new Float32Array(4), w: 2, h: 2, minX: 0, minY: 0, cell: 1 };
    const a = assignToClusters(grid, [], new Float32Array([0.5, 0.5]), 1);
    expect(a.k).toBe(0);
    expect([...a.codes]).toEqual([0]);
  });
});
