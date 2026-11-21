import { describe, expect, it } from 'vitest';
import { collisionPriorities, labelSizes, placeGroupLabels } from '../src/webview/labels/place';

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Points around (cx, cy) with group code g. */
function blob(r: () => number, n: number, cx: number, cy: number, spread: number, g: number, xy: number[], codes: number[]) {
  for (let i = 0; i < n; i++) {
    xy.push(cx + (r() - 0.5) * spread, cy + (r() - 0.5) * spread);
    codes.push(g);
  }
}

describe('placeGroupLabels', () => {
  it('puts a split group at its larger blob, not at the centroid between blobs', () => {
    const r = rng(1);
    const xy: number[] = [];
    const codes: number[] = [];
    blob(r, 3000, -10, 0, 2, 0, xy, codes); // A, large
    blob(r, 1000, 10, 0, 2, 0, xy, codes); // A, small
    blob(r, 2000, 0, 10, 2, 1, xy, codes); // B
    const labels = placeGroupLabels(new Float32Array(xy), codes, codes.length, ['A', 'B']);
    expect(labels.map((l) => l.text)).toEqual(['A', 'B']);
    const [a, b] = labels;
    expect(a.count).toBe(4000);
    expect(Math.abs(a.x - -10)).toBeLessThan(1.5);
    expect(Math.abs(a.y)).toBeLessThan(1.5);
    expect(Math.abs(b.x)).toBeLessThan(1.5);
    expect(Math.abs(b.y - 10)).toBeLessThan(1.5);
  });

  it('keeps a curved group label on its points', () => {
    const xy: number[] = [];
    const codes: number[] = [];
    // A half ring: its centroid (0, ~6.4) has no points nearby.
    for (let i = 0; i < 2000; i++) {
      const t = (i / 2000) * Math.PI;
      xy.push(10 * Math.cos(t), 10 * Math.sin(t));
      codes.push(0);
    }
    const [l] = placeGroupLabels(new Float32Array(xy), codes, codes.length, ['ring']);
    expect(Math.abs(Math.hypot(l.x, l.y) - 10)).toBeLessThan(1);
  });

  it('ignores other/missing codes and NaN positions, and skips empty groups', () => {
    const xy = new Float32Array([0, 0, 1, 1, NaN, NaN, 5, 5, 100, 100]);
    const codes = [0, 0, 0, 2, 3]; // 2 = Other, 3 = missing (2 names)
    const labels = placeGroupLabels(xy, codes, 5, ['a', 'empty']);
    expect(labels).toHaveLength(1);
    expect(labels[0].text).toBe('a');
    expect(labels[0].count).toBe(2);
    // Two points far apart on the grid: the label sits on one of them, not between them.
    expect([0, 1]).toContain(labels[0].x);
    expect(labels[0].y).toBe(labels[0].x);
    expect(placeGroupLabels(xy, codes, 0, ['a'])).toEqual([]);
    expect(placeGroupLabels(new Float32Array([1, 1]), [0], 1, ['single'])[0]).toMatchObject({ x: 1, y: 1, count: 1 });
  });
});

describe('labelSizes', () => {
  it('scales with the square root of the count, relative to the largest group', () => {
    expect(labelSizes([100, 400, 2500], 10, 30)).toEqual([14, 18, 30]);
    expect(labelSizes([0, 2500], 10, 30)).toEqual([10, 30]);
    // Nearly equal groups get nearly equal sizes.
    const [a, b] = labelSizes([6300, 7900], 12, 26);
    expect(b - a).toBeLessThan(1.6);
    expect(labelSizes([7, 7], 10, 20)).toEqual([20, 20]);
    expect(labelSizes([0, 0], 10, 20)).toEqual([10, 10]);
    expect(labelSizes([], 10, 20)).toEqual([]);
  });
});

describe('collisionPriorities', () => {
  it('orders by count within [-900, 900]', () => {
    const p = collisionPriorities([10, 1000, 100]);
    expect(p[1]).toBeGreaterThan(p[2]);
    expect(p[2]).toBeGreaterThan(p[0]);
    for (const v of p) expect(Math.abs(v)).toBeLessThanOrEqual(900);
    // Gaps stay large enough for deck.gl's 16-bit collision depth.
    expect(p[1] - p[0]).toBeGreaterThan(1000);
  });

  it('lets coarser levels win regardless of count', () => {
    const p = collisionPriorities([5000, 10], [0, 1]);
    expect(p[1]).toBeGreaterThan(p[0]);
    expect(p[0]).toBeGreaterThanOrEqual(-900);
    expect(p[1]).toBeLessThanOrEqual(900);
  });
});
