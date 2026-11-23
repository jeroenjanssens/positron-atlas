import { describe, expect, it } from 'vitest';
import { collisionPriorities, labelSizes, placeGroupLabels } from '../src/webview/labels/place';
import { weightRange, matchDragOffsets } from '../src/webview/atlas/labels';

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

describe('placeGroupLabels modes', () => {
  /** A: a large blob, a smaller blob and a tiny one; B: one blob. */
  function threeIslands() {
    const r = rng(7);
    const xy: number[] = [];
    const codes: number[] = [];
    blob(r, 3000, -10, 0, 2, 0, xy, codes); // A main
    blob(r, 1000, 10, 0, 2, 0, xy, codes); // A second region (25 %)
    blob(r, 100, 0, -10, 1, 0, xy, codes); // A tiny region (2.4 %)
    blob(r, 2000, 0, 10, 2, 1, xy, codes); // B
    return { xy: new Float32Array(xy), codes };
  }

  it("'regions' repeats a label once per large-enough region, at each region's points", () => {
    const { xy, codes } = threeIslands();
    const labels = placeGroupLabels(xy, codes, codes.length, ['A', 'B'], { mode: 'regions' });
    const a = labels.filter((l) => l.text === 'A');
    expect(a).toHaveLength(2); // the 2.4 % island is below the default minShare (10 %)
    expect(a.map((l) => l.region)).toEqual([0, 1]);
    expect(a.map((l) => l.key)).toEqual(['A', 'A #2']);
    expect(Math.abs(a[0].x - -10)).toBeLessThan(1.5); // largest region first
    expect(Math.abs(a[1].x - 10)).toBeLessThan(1.5);
    expect(a[0].count).toBeGreaterThan(a[1].count);
    expect(labels.filter((l) => l.text === 'B')).toHaveLength(1);
  });

  it("'regions' respects maxPerGroup and minShare", () => {
    const { xy, codes } = threeIslands();
    const one = placeGroupLabels(xy, codes, codes.length, ['A', 'B'], { mode: 'regions', maxPerGroup: 1 });
    expect(one.filter((l) => l.text === 'A')).toHaveLength(1);
    const all = placeGroupLabels(xy, codes, codes.length, ['A', 'B'], { mode: 'regions', minShare: 0.01 });
    expect(all.filter((l) => l.text === 'A')).toHaveLength(3);
  });

  it("'peak' (the default) keeps one label per group", () => {
    const { xy, codes } = threeIslands();
    const labels = placeGroupLabels(xy, codes, codes.length, ['A', 'B']);
    expect(labels.map((l) => l.key)).toEqual(['A', 'B']);
    expect(labels.every((l) => l.region === 0)).toBe(true);
  });

  it("'medoid' puts the label on a point of the group, near its middle", () => {
    const r = rng(3);
    const xy: number[] = [];
    const codes: number[] = [];
    blob(r, 2000, 5, 5, 4, 0, xy, codes);
    const f = new Float32Array(xy);
    const [l] = placeGroupLabels(f, codes, codes.length, ['A'], { mode: 'medoid' });
    expect(Math.hypot(l.x - 5, l.y - 5)).toBeLessThan(0.5);
    let onPoint = false;
    for (let i = 0; i < codes.length; i++) if (f[2 * i] === l.x && f[2 * i + 1] === l.y) onPoint = true;
    expect(onPoint).toBe(true);
  });

  it('3D positions (stride 3) place like the same points in 2D, with the mean z', () => {
    const { xy, codes } = threeIslands();
    const n = codes.length;
    const xyz = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      xyz[3 * i] = xy[2 * i];
      xyz[3 * i + 1] = xy[2 * i + 1];
      xyz[3 * i + 2] = codes[i] === 0 ? 5 : -5;
    }
    const flat = placeGroupLabels(xy, codes, n, ['A', 'B'], { mode: 'regions' });
    const deep = placeGroupLabels(xyz, codes, n, ['A', 'B'], { mode: 'regions', stride: 3 });
    expect(deep.map((l) => [l.key, l.x, l.y])).toEqual(flat.map((l) => [l.key, l.x, l.y]));
    expect(deep.map((l) => l.z)).toEqual(deep.map((l) => (l.text === 'A' ? 5 : -5)));
  });

  it('maxLabels keeps the largest groups or regions', () => {
    const { xy, codes } = threeIslands();
    const labels = placeGroupLabels(xy, codes, codes.length, ['A', 'B'], { mode: 'regions', maxLabels: 2 });
    expect(labels).toHaveLength(2);
    expect(labels.map((l) => l.key).sort()).toEqual(['A', 'B']); // A main (3000) and B (2000), not A #2 (1000)
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

// ---- A2: weight range --------------------------------------------------------

describe('weightRange', () => {
  it('returns minWeight for empty counts', () => {
    expect(weightRange([], 300, 700)).toEqual([]);
  });

  it('returns uniform weight when min === max', () => {
    expect(weightRange([100, 1000, 500], 600, 600)).toEqual([600, 600, 600]);
  });

  it('assigns light weight to small groups, heavy weight to large groups', () => {
    // Three groups: tiny, medium, huge.
    const w = weightRange([10, 1000, 10000], 300, 700);
    expect(w).toHaveLength(3);
    expect(w[0]).toBeLessThanOrEqual(w[1]);
    expect(w[1]).toBeLessThanOrEqual(w[2]);
    // The largest group always gets the max weight.
    expect(w[2]).toBe(700);
    // The smallest group gets the min weight.
    expect(w[0]).toBe(300);
    // All returned weights are rounded to hundreds.
    for (const v of w) expect(v % 100).toBe(0);
  });

  it('handles single-group case', () => {
    expect(weightRange([500], 300, 700)).toEqual([700]);
  });

  it('handles all-zero counts', () => {
    const w = weightRange([0, 0], 300, 700);
    expect(w).toHaveLength(2);
    for (const v of w) expect(v).toBe(300);
  });
});

// ---- A3: matchDragOffsets after reclustering ---------------------------------

describe('matchDragOffsets', () => {
  it('returns empty object when no offsets provided', () => {
    expect(matchDragOffsets(undefined, ['A', 'B'])).toEqual({});
    expect(matchDragOffsets({}, ['A', 'B'])).toEqual({});
  });

  it('keeps offsets for names that still exist after reclustering', () => {
    const offsets = { A: [10, -5] as [number, number], B: [0, 20] as [number, number], C: [-3, 7] as [number, number] };
    // After reclustering, cluster C is gone but A and B remain.
    const result = matchDragOffsets(offsets, ['A', 'B', 'D']);
    expect(result).toEqual({ A: [10, -5], B: [0, 20] });
    expect('C' in result).toBe(false);
    expect('D' in result).toBe(false);
  });

  it('returns empty object when no names match', () => {
    const offsets = { A: [1, 2] as [number, number] };
    expect(matchDragOffsets(offsets, ['X', 'Y', 'Z'])).toEqual({});
  });

  it('handles all names matching', () => {
    const offsets = { X: [3, 4] as [number, number], Y: [5, 6] as [number, number] };
    expect(matchDragOffsets(offsets, ['X', 'Y'])).toEqual(offsets);
  });
});

// ---- A8: collisionPriorities level selection (integration) -------------------

describe('collisionPriorities with multi-level (A8)', () => {
  it('gives coarse (level 1) higher priority than fine (level 0) regardless of count', () => {
    // coarse has 3 labels (level 1), fine has 5 labels (level 0, smaller counts)
    const counts = [2000, 1500, 500, 300, 200, 100, 50, 10];
    const levels = [1, 1, 1, 0, 0, 0, 0, 0]; // first 3 are coarse, rest fine
    const p = collisionPriorities(counts, levels);
    // Every coarse label (level 1) should beat every fine label (level 0).
    const coarsePriorities = [0, 1, 2].map((i) => p[i]);
    const finePriorities = [3, 4, 5, 6, 7].map((i) => p[i]);
    for (const cp of coarsePriorities) {
      for (const fp of finePriorities) {
        expect(cp).toBeGreaterThan(fp);
      }
    }
  });
});

describe('highlight badge colours', () => {
  it('averages the colours of each group and keeps white text readable', async () => {
    const { groupMeanColors, readableBadge } = await import('../src/webview/atlas/labels');
    const codes = new Uint16Array([0, 0, 1, 2]);
    const rgba = new Uint8Array([200, 0, 0, 255, 100, 0, 0, 255, 0, 0, 200, 255, 9, 9, 9, 255]);
    const m = groupMeanColors(codes, rgba, 2);
    expect(m[0]).toEqual([150, 0, 0]);
    expect(m[1]).toEqual([0, 0, 200]);
    const b = readableBadge([240, 240, 240]);
    expect(Math.max(...b)).toBeLessThan(160); // light grey is darkened for white text
  });
});
