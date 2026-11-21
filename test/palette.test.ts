import { describe, expect, it } from 'vitest';
import { hexHue, mapPalette, oklchToHex } from '../src/webview/color/mapPalette';

const hueDist = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};
const lum = (hex: string) => {
  const v = parseInt(hex.slice(1), 16);
  return 0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255);
};

/** Points on a ring of radius 10 plus a dense core, and 8 group centers around the ring. */
function ring() {
  const pts: number[] = [];
  for (let i = 0; i < 4000; i++) {
    const t = (i / 4000) * 2 * Math.PI;
    pts.push(10 * Math.cos(t), 10 * Math.sin(t));
    pts.push(2 * Math.cos(t * 7), 2 * Math.sin(t * 3));
  }
  const centers: number[] = [];
  for (let g = 0; g < 8; g++) {
    const t = (g / 8) * 2 * Math.PI + 0.1;
    centers.push(10 * Math.cos(t), 10 * Math.sin(t));
  }
  return { xy: new Float32Array(pts), n: pts.length / 2, centers };
}

describe('oklchToHex', () => {
  it('converts known colors', () => {
    expect(oklchToHex(0.627955, 0.257683, 29.2339)).toBe('#ff0000');
    expect(oklchToHex(1, 0, 0)).toBe('#ffffff');
    expect(oklchToHex(0, 0, 0)).toBe('#000000');
  });
  it('clips out-of-gamut chroma but keeps the hue', () => {
    const hex = oklchToHex(0.7, 0.4, 140);
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(hueDist(hexHue(hex), 140)).toBeLessThan(3);
  });
});

describe('mapPalette', () => {
  it('gives neighboring groups nearby hues and opposite groups distant hues', () => {
    const { xy, n, centers } = ring();
    const p = mapPalette(centers, xy, n, { dark: true }, () => '#000000');
    expect(p).toHaveLength(8);
    for (const c of p) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    const h = p.map(hexHue);
    // Equal radii: the hue circle is shared equally (45° apart), in angular order.
    for (let g = 0; g < 8; g++) {
      expect(hueDist(h[g], h[(g + 1) % 8])).toBeGreaterThan(25);
      expect(hueDist(h[g], h[(g + 1) % 8])).toBeLessThan(hueDist(h[g], h[(g + 4) % 8]));
    }
  });

  it('makes outlying groups lighter on dark backgrounds and darker on light ones', () => {
    const { xy, n } = ring();
    // Same direction, one near the center, one at the rim.
    const centers = [1, 0.1, 10, 0.1];
    const dark = mapPalette(centers, xy, n, { dark: true }, () => '#000000');
    const light = mapPalette(centers, xy, n, { dark: false }, () => '#000000');
    expect(lum(dark[1])).toBeGreaterThan(lum(dark[0]));
    expect(lum(light[1])).toBeLessThan(lum(light[0]));
  });

  it('uses the fallback for groups that are not on the map, and is deterministic', () => {
    const { xy, n } = ring();
    const centers = [NaN, NaN, 5, 5];
    const p = mapPalette(centers, xy, n, { dark: false }, (i) => `#00000${i}`);
    expect(p[0]).toBe('#000000');
    expect(p[1]).toMatch(/^#[0-9a-f]{6}$/);
    expect(mapPalette(centers, xy, n, { dark: false }, () => '#000000')).toEqual(mapPalette(centers, xy, n, { dark: false }, () => '#000000'));
    expect(mapPalette([1, 1], new Float32Array(0), 0, { dark: true }, () => '#123456')).toEqual(['#123456']);
  });
});
