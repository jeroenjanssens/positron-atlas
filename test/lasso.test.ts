import { describe, expect, it } from 'vitest';
import { combineSelection, countSelected, fadeUnselected, invertSelection, packBits, pointInPolygon, pointsInPolygon } from '../src/webview/select/lasso';

const square = [0, 0, 10, 0, 10, 10, 0, 10];

describe('pointInPolygon', () => {
  it('handles convex and concave polygons', () => {
    expect(pointInPolygon(5, 5, square)).toBe(true);
    expect(pointInPolygon(15, 5, square)).toBe(false);
    // A U shape: the notch between the arms is outside.
    const u = [0, 0, 9, 0, 9, 9, 6, 9, 6, 3, 3, 3, 3, 9, 0, 9];
    expect(pointInPolygon(1.5, 6, u)).toBe(true);
    expect(pointInPolygon(4.5, 6, u)).toBe(false);
    expect(pointInPolygon(4.5, 1.5, u)).toBe(true);
  });
});

describe('pointsInPolygon', () => {
  it('returns the indices inside, ignoring NaN and degenerate polygons', () => {
    const xy = new Float32Array([1, 1, 20, 20, NaN, NaN, 9, 9, -1, 5]);
    expect([...pointsInPolygon(xy, 5, square)]).toEqual([0, 3]);
    expect(pointsInPolygon(xy, 5, [0, 0, 1, 1])).toHaveLength(0);
  });
});

describe('combineSelection', () => {
  it('replaces, adds and removes', () => {
    const a = combineSelection(null, Uint32Array.from([0, 2]), 5, 'replace')!;
    expect([...a]).toEqual([1, 0, 1, 0, 0]);
    const b = combineSelection(a, Uint32Array.from([3]), 5, 'add')!;
    expect([...b]).toEqual([1, 0, 1, 1, 0]);
    expect([...a]).toEqual([1, 0, 1, 0, 0]); // not modified in place
    const c = combineSelection(b, Uint32Array.from([0, 4]), 5, 'remove')!;
    expect([...c]).toEqual([0, 0, 1, 1, 0]);
    expect(combineSelection(c, Uint32Array.from([2, 3]), 5, 'remove')).toBeNull();
    expect(combineSelection(null, Uint32Array.from([1]), 5, 'remove')).toBeNull();
    expect(combineSelection(a, new Uint32Array(0), 5, 'replace')).toBeNull();
    expect(combineSelection(null, Uint32Array.from([1]), 5, 'add')).not.toBeNull();
  });

  it('inverts within a scope', () => {
    const m = Uint8Array.from([1, 0, 0, 1, 0]);
    expect([...invertSelection(m, 5)!]).toEqual([0, 1, 1, 0, 1]);
    // Only anchors 0, 1 and 3 can be selected.
    expect([...invertSelection(m, 5, Uint32Array.from([0, 1, 3]))!]).toEqual([0, 1, 0, 0, 0]);
    expect(invertSelection(Uint8Array.from([1, 1]), 2)).toBeNull();
    expect(countSelected(Uint8Array.from([1, 0, 1]))).toBe(2);
  });
});

describe('packBits', () => {
  it('packs least significant bit first, like numpy bitorder="little"', () => {
    expect([...packBits(Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 1, 1]))]).toEqual([1, 3]);
    expect([...packBits(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 1]))]).toEqual([128]);
    expect(packBits(new Uint8Array(0))).toHaveLength(0);
  });
});

describe('fadeUnselected', () => {
  it('mixes unselected colors toward the background and keeps selected ones', () => {
    const rgba = Uint8Array.from([200, 100, 0, 255, 200, 100, 0, 255]);
    fadeUnselected(rgba, Uint8Array.from([1, 0]), [0, 0, 0]);
    expect([...rgba]).toEqual([200, 100, 0, 255, 50, 25, 0, 128]);
  });
});
