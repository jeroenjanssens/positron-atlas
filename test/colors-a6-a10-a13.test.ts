/**
 * Tests for A6 (colour by cluster), A10 (size by column), A13 (histogram filter).
 */
import { describe, expect, it } from 'vitest';
import { CVD_SAFE, NOISE_COLOR, hexToRgb } from '../src/webview/color/colormaps';
import { buildRadii, buildHistFilterValues } from '../src/webview/atlas/colors';
import type { Atlas } from '../src/webview/atlas.svelte';

// ---- Helpers ------------------------------------------------------------------

function makeAtlas(overrides: Partial<Atlas> = {}): Atlas {
  return {
    view: { pointSize: 4, opacity: 0.8, mode: 'points', colormap: 'viridis', background: '', images: false, imageWidth: 0, imageInvert: false, palette: 'map' },
    sizeColumn: null,
    sizeValues: null,
    histFilter: null,
    histData: null,
    histRawValues: null,
    histRawColumn: null,
    nKept: 10,
    ...overrides,
  } as unknown as Atlas;
}

// ---- A6: Colour by cluster ---------------------------------------------------

describe('A6: colour by cluster', () => {
  it('CVD_SAFE palette has 8 entries and each is a valid hex color', () => {
    expect(CVD_SAFE).toHaveLength(8);
    for (const c of CVD_SAFE) {
      expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('NOISE_COLOR is a valid hex gray', () => {
    expect(NOISE_COLOR).toMatch(/^#[0-9a-fA-F]{6}$/);
    const [r, g, b] = hexToRgb(NOISE_COLOR);
    // Should be a medium grey: not too bright, not too dark, channels roughly equal
    expect(Math.abs(r - g)).toBeLessThan(20);
    expect(Math.abs(g - b)).toBeLessThan(20);
    expect(r).toBeGreaterThan(60);
    expect(r).toBeLessThan(200);
  });

  it('CVD_SAFE colors are distinct enough (pairwise RGB distance > 50)', () => {
    for (let i = 0; i < CVD_SAFE.length; i++) {
      for (let j = i + 1; j < CVD_SAFE.length; j++) {
        const [r1, g1, b1] = hexToRgb(CVD_SAFE[i]);
        const [r2, g2, b2] = hexToRgb(CVD_SAFE[j]);
        const dist = Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
        expect(dist, `CVD_SAFE[${i}] and CVD_SAFE[${j}] are too similar`).toBeGreaterThan(50);
      }
    }
  });
});

// ---- A10: Size by column -----------------------------------------------------

describe('A10: buildRadii', () => {
  it('returns null when sizeColumn is null', () => {
    const atlas = makeAtlas({ sizeColumn: null, sizeValues: null });
    expect(buildRadii(atlas as Atlas, 5)).toBeNull();
  });

  it('returns null when sizeValues is null', () => {
    const atlas = makeAtlas({ sizeColumn: 0, sizeValues: null });
    expect(buildRadii(atlas as Atlas, 5)).toBeNull();
  });

  it('maps [min, max] to [0.5, pointSize] using sqrt scale', () => {
    const vals = new Float32Array([0, 1, 4, 9, 16]); // sqrt: 0,1,2,3,4
    const atlas = makeAtlas({ sizeColumn: 0, sizeValues: vals });
    const radii = buildRadii(atlas as Atlas, 5);
    expect(radii).not.toBeNull();
    // Min value → minimum radius 0.5
    expect(radii![0]).toBe(0.5);
    // Max value → pointSize (4)
    expect(radii![4]).toBeCloseTo(4, 1);
    // Monotonically increasing
    for (let i = 1; i < 5; i++) {
      expect(radii![i]).toBeGreaterThanOrEqual(radii![i - 1]);
    }
  });

  it('handles offset correctly for placed rows', () => {
    const vals = new Float32Array([0, 4, 16, 9, 1]);
    const atlas = makeAtlas({ sizeColumn: 0, sizeValues: vals });
    const r0 = buildRadii(atlas as Atlas, 2, 0); // vals[0,1] = 0,4
    const r2 = buildRadii(atlas as Atlas, 2, 2); // vals[2,3] = 16,9
    expect(r0).not.toBeNull();
    expect(r2).not.toBeNull();
    // Radius for val=4 at offset 0 should be less than radius for val=16 at offset 2
    // Both are relative to the global min/max, so val=16 → max → pointSize
    expect(r2![0]).toBeCloseTo(4, 1); // val=16 is the global max
  });

  it('clamps small radii to 0.5', () => {
    const vals = new Float32Array([0, 0.001, 100]);
    const atlas = makeAtlas({ sizeColumn: 0, sizeValues: vals });
    const radii = buildRadii(atlas as Atlas, 3);
    expect(radii![0]).toBe(0.5);
    expect(radii![1]).toBeGreaterThanOrEqual(0.5);
  });

  it('handles NaN values by using minimum radius', () => {
    const vals = new Float32Array([NaN, 4, 9]);
    const atlas = makeAtlas({ sizeColumn: 0, sizeValues: vals });
    const radii = buildRadii(atlas as Atlas, 3);
    expect(radii).not.toBeNull();
    expect(radii![0]).toBe(0.5); // NaN → 0 → minimum radius
  });
});

// ---- A13: buildHistFilterValues ----------------------------------------------

describe('A13: buildHistFilterValues', () => {
  it('returns null when histFilter is null', () => {
    const atlas = makeAtlas({ histFilter: null, histData: null });
    expect(buildHistFilterValues(atlas as Atlas, 5)).toBeNull();
  });

  it('returns null when histData is null even if histFilter is set', () => {
    const atlas = makeAtlas({
      histFilter: { column: 0, range: [0, 1] },
      histData: null,
      histRawValues: new Float32Array([0.5, 1.5]),
      histRawColumn: 0,
    });
    expect(buildHistFilterValues(atlas as Atlas, 2)).toBeNull();
  });

  it('returns null when histRawValues column does not match', () => {
    const atlas = makeAtlas({
      histFilter: { column: 0, range: [0, 1] },
      histData: { edges: [0, 1], counts: [5], isDatetime: false },
      histRawValues: new Float32Array([0.5, 1.5]),
      histRawColumn: 1, // wrong column
    });
    expect(buildHistFilterValues(atlas as Atlas, 2)).toBeNull();
  });

  it('marks points inside the brush as 1, outside as 0', () => {
    const vals = new Float32Array([0.1, 0.5, 1.5, 2.0, 0.8]);
    const atlas = makeAtlas({
      histFilter: { column: 0, range: [0.4, 1.0] },
      histData: { edges: [0, 0.5, 1.0, 1.5, 2.0], counts: [1, 2, 1, 1], isDatetime: false },
      histRawValues: vals,
      histRawColumn: 0,
    });
    const fv = buildHistFilterValues(atlas as Atlas, 5);
    expect(fv).not.toBeNull();
    expect(Array.from(fv!)).toEqual([0, 1, 0, 0, 1]); // 0.1 out, 0.5 in, 1.5 out, 2.0 out, 0.8 in
  });

  it('marks NaN as hidden (0)', () => {
    const vals = new Float32Array([NaN, 0.5, 1.5]);
    const atlas = makeAtlas({
      histFilter: { column: 0, range: [0.0, 1.0] },
      histData: { edges: [0, 1, 2], counts: [2, 1], isDatetime: false },
      histRawValues: vals,
      histRawColumn: 0,
    });
    const fv = buildHistFilterValues(atlas as Atlas, 3);
    expect(fv![0]).toBe(0); // NaN → hidden
    expect(fv![1]).toBe(1); // 0.5 → in range
    expect(fv![2]).toBe(0); // 1.5 → out of range
  });

  it('uses offset for anchor subsets', () => {
    const vals = new Float32Array([0.1, 0.5, 0.8, 1.5]); // indices 0-3
    const atlas = makeAtlas({
      histFilter: { column: 0, range: [0.4, 1.0] },
      histData: { edges: [0, 0.5, 1.0, 1.5], counts: [1, 2, 1], isDatetime: false },
      histRawValues: vals,
      histRawColumn: 0,
    });
    // Anchors starting at index 2: vals[2]=0.8 (in), vals[3]=1.5 (out)
    const fv = buildHistFilterValues(atlas as Atlas, 2, 2);
    expect(fv).not.toBeNull();
    expect(Array.from(fv!)).toEqual([1, 0]);
  });
});
