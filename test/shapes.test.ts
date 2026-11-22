/**
 * Shapes tests (plan item 8, wave B4).
 *
 * Tests for shape geometry helpers, point-in-shape, transforms and JSON round-trip.
 * Each assertion is designed to fail without the shapes.ts logic.
 */

import { describe, expect, it } from 'vitest';
import {
  rectToPolygon,
  ellipseToPolygon,
  shapeToPolygon,
  pointInShape,
  pointsInShape,
  moveShape,
  scaleShape,
  exportShapesJson,
  importShapesJson,
  makeRect,
  makeEllipse,
  makePolygon,
  makeLine,
  makeArrow,
  makeText,
  makeFreehand,
  ELLIPSE_SEGMENTS,
  shapeBounds,
} from '../src/webview/atlas/shapes';

// ---------------------------------------------------------------------------
// rectToPolygon
// ---------------------------------------------------------------------------

describe('rectToPolygon', () => {
  it('returns 4 vertices for an axis-aligned rectangle', () => {
    const rect = makeRect(0, 0, 10, 5);
    const poly = rectToPolygon(rect);
    expect(poly).toHaveLength(4);
  });

  it('vertices span the full width and height', () => {
    const rect = makeRect(1, 2, 8, 6);
    const poly = rectToPolygon(rect);
    const xs = poly.map(([x]) => x);
    const ys = poly.map(([, y]) => y);
    // Centre of rect is (5, 5); corners at ±4 and ±3 from centre.
    expect(Math.min(...xs)).toBeCloseTo(1);
    expect(Math.max(...xs)).toBeCloseTo(9);
    expect(Math.min(...ys)).toBeCloseTo(2);
    expect(Math.max(...ys)).toBeCloseTo(8);
  });

  it('rotates correctly by 90 degrees', () => {
    // 10×1 rect centred at (5, 0.5); rotating 90° should swap width and height.
    const rect = makeRect(0, 0, 10, 1);
    const polyBefore = rectToPolygon(rect);
    rect.rotation = 90;
    const polyAfter = rectToPolygon(rect);
    const widthBefore = Math.max(...polyBefore.map(([x]) => x)) - Math.min(...polyBefore.map(([x]) => x));
    const widthAfter  = Math.max(...polyAfter.map(([x]) => x))  - Math.min(...polyAfter.map(([x]) => x));
    // After 90° the x-extent (≈1) is much smaller than the y-extent (≈10).
    expect(widthAfter).toBeLessThan(widthBefore * 0.5);
  });
});

// ---------------------------------------------------------------------------
// ellipseToPolygon
// ---------------------------------------------------------------------------

describe('ellipseToPolygon', () => {
  it('returns ELLIPSE_SEGMENTS vertices by default', () => {
    const ell = makeEllipse(0, 0, 5, 3);
    const poly = ellipseToPolygon(ell);
    expect(poly).toHaveLength(ELLIPSE_SEGMENTS);
  });

  it('vertices are approximately on the ellipse boundary', () => {
    const ell = makeEllipse(0, 0, 4, 2);
    const poly = ellipseToPolygon(ell);
    for (const [x, y] of poly) {
      // For an axis-aligned ellipse (cx+rx*cos, cy+ry*sin):
      // x/rx^2 + y/ry^2 should equal 1 (or very close).
      const val = (x * x) / (4 * 4) + (y * y) / (2 * 2);
      expect(val).toBeCloseTo(1, 2);
    }
  });

  it('honours custom segment count', () => {
    const ell = makeEllipse(0, 0, 1, 1);
    expect(ellipseToPolygon(ell, 8)).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// shapeToPolygon
// ---------------------------------------------------------------------------

describe('shapeToPolygon', () => {
  it('returns null for open shapes (line, arrow)', () => {
    const line = makeLine([[0, 0], [10, 10]]);
    const arrow = makeArrow([[0, 0], [5, 5]]);
    expect(shapeToPolygon(line)).toBeNull();
    expect(shapeToPolygon(arrow)).toBeNull();
  });

  it('returns null for text shapes', () => {
    const text = makeText(0, 0, 'hello');
    expect(shapeToPolygon(text)).toBeNull();
  });

  it('returns polygon for polygon shape', () => {
    const poly = makePolygon([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const result = shapeToPolygon(poly);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(4);
  });

  it('returns null for a polygon with fewer than 3 vertices', () => {
    const poly = makePolygon([[0, 0], [1, 1]]);
    expect(shapeToPolygon(poly)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pointInShape
// ---------------------------------------------------------------------------

describe('pointInShape', () => {
  it('rect: inside', () => {
    const rect = makeRect(0, 0, 10, 10);
    expect(pointInShape(5, 5, rect)).toBe(true);
  });

  it('rect: outside', () => {
    const rect = makeRect(0, 0, 10, 10);
    expect(pointInShape(15, 5, rect)).toBe(false);
  });

  it('ellipse: inside', () => {
    const ell = makeEllipse(0, 0, 5, 5);
    expect(pointInShape(3, 0, ell)).toBe(true);
  });

  it('ellipse: outside', () => {
    const ell = makeEllipse(0, 0, 5, 5);
    expect(pointInShape(6, 0, ell)).toBe(false);
  });

  it('polygon: inside', () => {
    const poly = makePolygon([[0, 0], [10, 0], [10, 10], [0, 10]]);
    expect(pointInShape(5, 5, poly)).toBe(true);
  });

  it('polygon: outside', () => {
    const poly = makePolygon([[0, 0], [10, 0], [10, 10], [0, 10]]);
    expect(pointInShape(15, 5, poly)).toBe(false);
  });

  it('line: always false (open shape)', () => {
    const line = makeLine([[0, 0], [10, 0]]);
    expect(pointInShape(5, 0, line)).toBe(false);
  });

  it('text: always false (open shape)', () => {
    const text = makeText(5, 5, 'hi');
    expect(pointInShape(5, 5, text)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pointsInShape (bulk)
// ---------------------------------------------------------------------------

describe('pointsInShape', () => {
  it('returns indices of points inside a rect', () => {
    const rect = makeRect(0, 0, 10, 10);
    const xy = new Float32Array([5, 5, 15, 5, -1, 5, 3, 3]);
    const hits = pointsInShape(xy, 4, rect);
    expect([...hits].sort()).toEqual([0, 3]);
  });

  it('returns empty for open shapes', () => {
    const line = makeLine([[0, 0], [10, 0]]);
    const xy = new Float32Array([5, 0]);
    expect(pointsInShape(xy, 1, line)).toHaveLength(0);
  });

  it('handles NaN coordinates', () => {
    const rect = makeRect(0, 0, 10, 10);
    const xy = new Float32Array([NaN, NaN, 5, 5]);
    const hits = pointsInShape(xy, 2, rect);
    expect([...hits]).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// moveShape
// ---------------------------------------------------------------------------

describe('moveShape', () => {
  it('moves a rect', () => {
    const rect = makeRect(0, 0, 5, 5);
    const moved = moveShape(rect, 3, 4);
    expect(moved.x).toBe(3);
    expect(moved.y).toBe(4);
    expect(moved.w).toBe(5);
  });

  it('moves an ellipse', () => {
    const ell = makeEllipse(0, 0, 2, 2);
    const moved = moveShape(ell, 1, 2);
    expect(moved.cx).toBe(1);
    expect(moved.cy).toBe(2);
  });

  it('moves a polygon by translating all vertices', () => {
    const poly = makePolygon([[0, 0], [1, 0], [1, 1]]);
    const moved = moveShape(poly, 5, 10);
    expect(moved.vertices[0]).toEqual([5, 10]);
    expect(moved.vertices[1]).toEqual([6, 10]);
    expect(moved.vertices[2]).toEqual([6, 11]);
  });

  it('moves a line', () => {
    const line = makeLine([[0, 0], [1, 1]]);
    const moved = moveShape(line, 2, 3);
    expect(moved.points[0]).toEqual([2, 3]);
    expect(moved.points[1]).toEqual([3, 4]);
  });

  it('moves a text', () => {
    const text = makeText(0, 0, 'hi');
    const moved = moveShape(text, 7, 8);
    expect(moved.x).toBe(7);
    expect(moved.y).toBe(8);
  });

  it('does not mutate original', () => {
    const rect = makeRect(1, 1, 5, 5);
    moveShape(rect, 10, 10);
    expect(rect.x).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// scaleShape
// ---------------------------------------------------------------------------

describe('scaleShape', () => {
  it('scales rect dimensions', () => {
    const rect = makeRect(0, 0, 4, 2);
    const scaled = scaleShape(rect, 2);
    expect(scaled.w).toBeCloseTo(8);
    expect(scaled.h).toBeCloseTo(4);
  });

  it('scales ellipse radii', () => {
    const ell = makeEllipse(0, 0, 3, 1);
    const scaled = scaleShape(ell, 3);
    expect(scaled.rx).toBeCloseTo(9);
    expect(scaled.ry).toBeCloseTo(3);
  });
});

// ---------------------------------------------------------------------------
// JSON export / import round-trip
// ---------------------------------------------------------------------------

describe('shapes JSON round-trip', () => {
  it('exports and re-imports a rect with all fields', () => {
    const original = makeRect(1, 2, 3, 4);
    original.rotation = 45;
    const json = exportShapesJson([original]);
    const restored = importShapesJson(json);
    expect(restored).toHaveLength(1);
    const r = restored[0] as typeof original;
    expect(r.kind).toBe('rect');
    expect(r.x).toBe(1);
    expect(r.y).toBe(2);
    expect(r.w).toBe(3);
    expect(r.h).toBe(4);
    expect(r.rotation).toBe(45);
  });

  it('exports and re-imports an ellipse', () => {
    const original = makeEllipse(5, 6, 7, 8);
    const json = exportShapesJson([original]);
    const restored = importShapesJson(json);
    expect(restored[0]).toMatchObject({ kind: 'ellipse', cx: 5, cy: 6, rx: 7, ry: 8 });
  });

  it('exports and re-imports a polygon', () => {
    const original = makePolygon([[0, 0], [1, 0], [1, 1]]);
    const json = exportShapesJson([original]);
    const restored = importShapesJson(json);
    expect(restored[0]).toMatchObject({ kind: 'polygon', vertices: [[0, 0], [1, 0], [1, 1]] });
  });

  it('exports and re-imports a text shape', () => {
    const original = makeText(3, 4, 'hello', 18, 'Arial');
    const json = exportShapesJson([original]);
    const restored = importShapesJson(json);
    expect(restored[0]).toMatchObject({ kind: 'text', text: 'hello', fontSize: 18 });
  });

  it('round-trips multiple shapes', () => {
    const shapes = [makeRect(0, 0, 1, 1), makeEllipse(5, 5, 2, 3), makeLine([[0, 0], [10, 10]])];
    const restored = importShapesJson(exportShapesJson(shapes));
    expect(restored).toHaveLength(3);
    expect(restored.map((s) => s.kind)).toEqual(['rect', 'ellipse', 'line']);
  });

  it('returns empty array for unknown version', () => {
    const result = importShapesJson({ version: 99, shapes: [] });
    expect(result).toHaveLength(0);
  });

  it('returns empty array for non-object input', () => {
    expect(importShapesJson(null)).toHaveLength(0);
    expect(importShapesJson('invalid')).toHaveLength(0);
    expect(importShapesJson(42)).toHaveLength(0);
  });

  it('filters out shapes without kind or id', () => {
    const result = importShapesJson({ version: 1, shapes: [{ noKind: 'oops' }, makeRect(0, 0, 1, 1)] });
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// shapeBounds
// ---------------------------------------------------------------------------

describe('shapeBounds', () => {
  it('rect bounds', () => {
    const rect = makeRect(1, 2, 8, 6);
    const b = shapeBounds(rect);
    expect(b.minX).toBeCloseTo(1);
    expect(b.maxX).toBeCloseTo(9);
    expect(b.minY).toBeCloseTo(2);
    expect(b.maxY).toBeCloseTo(8);
  });

  it('ellipse bounds', () => {
    const ell = makeEllipse(0, 0, 5, 3);
    const b = shapeBounds(ell);
    expect(b.minX).toBeLessThanOrEqual(-4.9);
    expect(b.maxX).toBeGreaterThanOrEqual(4.9);
    expect(b.minY).toBeLessThanOrEqual(-2.9);
    expect(b.maxY).toBeGreaterThanOrEqual(2.9);
  });
});
