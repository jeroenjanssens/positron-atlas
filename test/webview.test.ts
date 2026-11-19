import { describe, expect, it } from 'vitest';
import { HitIndex, bounds } from '../src/webview/render/hitIndex';
import { encodeCategorical, encodeNumeric, gatherRgba } from '../src/webview/color/encode';
import { lut, hexToRgb, CATEGORICAL, NULL_COLOR } from '../src/webview/color/colormaps';
import { sgdRate } from '../src/webview/workers/schedule';

describe('HitIndex', () => {
  it('finds the true nearest point', () => {
    const n = 5000;
    const xy = new Float32Array(n * 2);
    let s = 1;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n * 2; i++) xy[i] = rnd() * 100 - 50;
    const idx = new HitIndex(xy, n);
    for (let t = 0; t < 200; t++) {
      const qx = rnd() * 100 - 50;
      const qy = rnd() * 100 - 50;
      let best = -1;
      let bd = Infinity;
      for (let i = 0; i < n; i++) {
        const d = (xy[2 * i] - qx) ** 2 + (xy[2 * i + 1] - qy) ** 2;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      expect(idx.nearest(qx, qy, 1000)).toBe(best);
    }
  });

  it('respects maxDist and handles degenerate input', () => {
    const xy = new Float32Array([0, 0, 0, 0, 10, 10]);
    const idx = new HitIndex(xy, 3);
    expect(idx.nearest(10.1, 10, 0.5)).toBe(2);
    expect(idx.nearest(5, 5, 0.5)).toBe(-1);
    expect(new HitIndex(new Float32Array(0), 0).nearest(0, 0, 1)).toBe(-1);
  });

  it('computes bounds ignoring NaN', () => {
    expect(bounds(new Float32Array([1, 2, NaN, NaN, -3, 5]), 3)).toEqual([-3, 2, 1, 5]);
  });
});

describe('color encoding', () => {
  it('builds LUTs that hit the end stops', () => {
    const t = lut('viridis');
    expect([t[0], t[1], t[2]]).toEqual(hexToRgb('#440154'));
    expect([t[765], t[766], t[767]]).toEqual(hexToRgb('#fde725'));
  });

  it('encodes numeric with clamping and NaN', () => {
    const rgba = encodeNumeric(new Float32Array([-10, 0, 1, 10, NaN]), 0, 1, 'viridis');
    expect(Array.from(rgba.slice(0, 3))).toEqual(hexToRgb('#440154'));
    expect(Array.from(rgba.slice(4, 7))).toEqual(hexToRgb('#440154'));
    expect(Array.from(rgba.slice(8, 11))).toEqual(hexToRgb('#fde725'));
    expect(Array.from(rgba.slice(16, 19))).toEqual(hexToRgb(NULL_COLOR));
  });

  it('encodes categorical incl. other and null', () => {
    const rgba = encodeCategorical(new Uint16Array([0, 1, 2, 3]), 2);
    expect(Array.from(rgba.slice(0, 3))).toEqual(hexToRgb(CATEGORICAL[0]));
    expect(Array.from(rgba.slice(4, 7))).toEqual(hexToRgb(CATEGORICAL[1]));
    expect(rgba[11]).toBe(255);
    expect(Array.from(rgba.slice(12, 15))).toEqual(hexToRgb(NULL_COLOR));
  });

  it('gathers rows', () => {
    const rgba = new Uint8Array([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
    expect(Array.from(gatherRgba(rgba, new Uint32Array([2, 0])))).toEqual([3, 3, 3, 3, 1, 1, 1, 1]);
  });
});

describe('sgd schedule', () => {
  it('decays linearly from alpha0 to 0', () => {
    expect(sgdRate(0, 200, 1)).toBe(1);
    expect(sgdRate(100, 200, 1)).toBeCloseTo(0.5);
    expect(sgdRate(200, 200, 1)).toBe(0);
    expect(sgdRate(500, 200, 1)).toBe(0);
    expect(sgdRate(50, 200, 2)).toBeCloseTo(1.5);
  });
});
