/**
 * Brush tagging tests (plan item 7, wave B4).
 *
 * Each assertion is designed to fail without the hitBrush / paintBrush /
 * eraseBrush / buildBrushOverlayColors logic.
 */

import { describe, expect, it } from 'vitest';
import {
  hitBrush,
  paintBrush,
  eraseBrush,
  fillBrushCluster,
  fillBrushCategory,
  buildBrushOverlayColors,
  brushWorldRadius,
  adjustBrushSize,
  brushCodesToWriteLabels,
  BRUSH_ERASER_CODE,
  BRUSH_PALETTE,
  BRUSH_SIZE_MIN,
  BRUSH_SIZE_MAX,
  BRUSH_SIZE_STEP,
} from '../src/webview/atlas/brush';

// ---------------------------------------------------------------------------
// hitBrush
// ---------------------------------------------------------------------------

describe('hitBrush', () => {
  it('returns empty array when no points are within radius', () => {
    const xy = new Float32Array([10, 10, 20, 20, 30, 30]);
    const hits = hitBrush(xy, 3, 0, 0, 1);
    expect(hits).toHaveLength(0);
  });

  it('returns all points within the radius', () => {
    // 5 points arranged at known distances from (0, 0)
    const xy = new Float32Array([
      0, 0,   // 0: at centre, distance 0
      1, 0,   // 1: distance 1
      2, 0,   // 2: distance 2
      3, 0,   // 3: distance 3
      5, 0,   // 4: distance 5
    ]);
    const hits = hitBrush(xy, 5, 0, 0, 2);
    expect([...hits].sort()).toEqual([0, 1, 2]);
  });

  it('uses world coordinates (not pixel)', () => {
    const xy = new Float32Array([0.5, 0.5, 100, 100]);
    const hits = hitBrush(xy, 2, 0, 0, 1); // radius 1 world unit
    expect([...hits]).toEqual([0]);
  });

  it('skips NaN coordinates', () => {
    const xy = new Float32Array([NaN, NaN, 0, 0]);
    const hits = hitBrush(xy, 2, 0, 0, 1);
    expect([...hits]).toEqual([1]);
  });

  it('uses exact circle (not bounding box)', () => {
    // Point at (1, 1) is at distance sqrt(2) ≈ 1.41 from origin
    const xy = new Float32Array([1, 1]);
    expect(hitBrush(xy, 1, 0, 0, 1.0)).toHaveLength(0);  // just outside
    expect(hitBrush(xy, 1, 0, 0, 1.5)).toHaveLength(1);  // just inside
  });
});

// ---------------------------------------------------------------------------
// paintBrush / eraseBrush
// ---------------------------------------------------------------------------

describe('paintBrush', () => {
  it('assigns classIdx to hits and leaves others unchanged', () => {
    const codes = new Uint16Array([BRUSH_ERASER_CODE, BRUSH_ERASER_CODE, BRUSH_ERASER_CODE]);
    const hits = Uint32Array.from([0, 2]);
    const result = paintBrush(codes, hits, 1);
    expect([...result]).toEqual([1, BRUSH_ERASER_CODE, 1]);
  });

  it('does not mutate the input array', () => {
    const codes = new Uint16Array([0, 0, 0]);
    const hits = Uint32Array.from([1]);
    paintBrush(codes, hits, 2);
    expect([...codes]).toEqual([0, 0, 0]); // original unchanged
  });

  it('overwrites previously painted codes', () => {
    const codes = new Uint16Array([0, 1, 2]);
    const hits = Uint32Array.from([0, 1, 2]);
    const result = paintBrush(codes, hits, 3);
    expect([...result]).toEqual([3, 3, 3]);
  });
});

describe('eraseBrush', () => {
  it('sets hit rows to BRUSH_ERASER_CODE', () => {
    const codes = new Uint16Array([0, 1, 2]);
    const hits = Uint32Array.from([0, 2]);
    const result = eraseBrush(codes, hits);
    expect(result[0]).toBe(BRUSH_ERASER_CODE);
    expect(result[1]).toBe(1); // untouched
    expect(result[2]).toBe(BRUSH_ERASER_CODE);
  });

  it('does not mutate the input', () => {
    const codes = new Uint16Array([0, 1]);
    eraseBrush(codes, Uint32Array.from([0]));
    expect(codes[0]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fillBrushCluster / fillBrushCategory
// ---------------------------------------------------------------------------

describe('fillBrushCluster', () => {
  it('assigns classIdx to all rows with the matching cluster code', () => {
    const pending = new Uint16Array(5).fill(BRUSH_ERASER_CODE);
    const clusters = new Uint16Array([0, 1, 0, 2, 1]);
    const result = fillBrushCluster(pending, clusters, 1, 3);
    expect([...result]).toEqual([BRUSH_ERASER_CODE, 3, BRUSH_ERASER_CODE, BRUSH_ERASER_CODE, 3]);
  });
});

describe('fillBrushCategory', () => {
  it('assigns classIdx to all rows with the matching color category', () => {
    const pending = new Uint16Array(4).fill(BRUSH_ERASER_CODE);
    const colorCodes = new Uint16Array([2, 0, 2, 1]);
    const result = fillBrushCategory(pending, colorCodes, 2, 7);
    expect([...result]).toEqual([7, BRUSH_ERASER_CODE, 7, BRUSH_ERASER_CODE]);
  });
});

// ---------------------------------------------------------------------------
// buildBrushOverlayColors
// ---------------------------------------------------------------------------

describe('buildBrushOverlayColors', () => {
  it('maps class 0 to the first palette color with alpha 200', () => {
    const codes = new Uint16Array([0]);
    const rgba = buildBrushOverlayColors(codes, 1, BRUSH_PALETTE);
    const [r, g, b, a] = rgba;
    expect([r, g, b]).toEqual(BRUSH_PALETTE[0]);
    expect(a).toBe(200);
  });

  it('maps BRUSH_ERASER_CODE to transparent (alpha 0)', () => {
    const codes = new Uint16Array([BRUSH_ERASER_CODE]);
    const rgba = buildBrushOverlayColors(codes, 1, BRUSH_PALETTE);
    expect(rgba[3]).toBe(0); // alpha = 0
  });

  it('handles mixed painted and unpainted rows', () => {
    const codes = new Uint16Array([0, BRUSH_ERASER_CODE, 1]);
    const rgba = buildBrushOverlayColors(codes, 3, BRUSH_PALETTE);
    expect(rgba[3]).toBe(200);  // row 0: painted
    expect(rgba[7]).toBe(0);    // row 1: erased
    expect(rgba[11]).toBe(200); // row 2: painted
  });

  it('outputs length n*4 rgba bytes', () => {
    const codes = new Uint16Array(10).fill(BRUSH_ERASER_CODE);
    const rgba = buildBrushOverlayColors(codes, 10, BRUSH_PALETTE);
    expect(rgba.length).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// adjustBrushSize / brushWorldRadius
// ---------------------------------------------------------------------------

describe('adjustBrushSize', () => {
  it('increases and decreases size within bounds', () => {
    expect(adjustBrushSize(20, 5)).toBe(25);
    expect(adjustBrushSize(20, -5)).toBe(15);
  });

  it('clamps at min and max', () => {
    expect(adjustBrushSize(BRUSH_SIZE_MIN, -100)).toBe(BRUSH_SIZE_MIN);
    expect(adjustBrushSize(BRUSH_SIZE_MAX, 100)).toBe(BRUSH_SIZE_MAX);
  });
});

describe('brushWorldRadius', () => {
  it('converts pixel radius to world units', () => {
    // 20 px * 0.1 world/px = 2 world units
    expect(brushWorldRadius(20, 0.1)).toBeCloseTo(2.0);
  });

  it('scales proportionally with zoom', () => {
    const r1 = brushWorldRadius(10, 0.5);
    const r2 = brushWorldRadius(10, 1.0);
    expect(r2 / r1).toBeCloseTo(2.0);
  });
});

// ---------------------------------------------------------------------------
// brushCodesToWriteLabels
// ---------------------------------------------------------------------------

describe('brushCodesToWriteLabels', () => {
  it('returns copies of codes and class names', () => {
    const codes = new Uint16Array([0, BRUSH_ERASER_CODE, 1]);
    const classes = ['A', 'B'];
    const { codes: out, names } = brushCodesToWriteLabels(codes, classes);
    // Should be a copy
    expect(out).not.toBe(codes);
    expect([...out]).toEqual([0, BRUSH_ERASER_CODE, 1]);
    expect(names).not.toBe(classes);
    expect(names).toEqual(['A', 'B']);
  });
});

// ---------------------------------------------------------------------------
// Constants sanity checks
// ---------------------------------------------------------------------------

describe('brush constants', () => {
  it('BRUSH_ERASER_CODE is 65535', () => {
    expect(BRUSH_ERASER_CODE).toBe(65535);
  });

  it('BRUSH_PALETTE has at least 4 entries', () => {
    expect(BRUSH_PALETTE.length).toBeGreaterThanOrEqual(4);
  });

  it('BRUSH_SIZE_MIN < BRUSH_SIZE_MAX', () => {
    expect(BRUSH_SIZE_MIN).toBeLessThan(BRUSH_SIZE_MAX);
  });

  it('BRUSH_SIZE_STEP is positive', () => {
    expect(BRUSH_SIZE_STEP).toBeGreaterThan(0);
  });
});
