/**
 * Shape model and geometry (plan item 8, wave B4).
 *
 * Shapes live in map coordinates so they move with pan, zoom and rotation.
 * Supported types: rect, ellipse, polygon, freehand (closed polygon), line, arrow, text.
 *
 * Persistence: shapes are stored in PanelState.shapes (JSON-serialisable) and are
 * included in the HTML export and PNG export.
 *
 * JSON format: versioned with `version: 1`.  Round-trip through JSON is safe (all
 * fields are plain numbers, strings or arrays of numbers).
 *
 * Geometry helpers:
 *   shapeToPolygon(shape)   – convert to a closed polygon (vertices for even-odd test)
 *   pointInShape(x, y, s)   – test whether a map point is inside the shape
 *   pointsInShape(xy, n, s) – bulk test for all kept rows
 *
 * Uses the same `pointInPolygon` / `pointsInPolygon` functions from `select/lasso.ts`
 * for the actual inside test.
 */

import { pointInPolygon, pointsInPolygon as lassoPointsInPolygon } from '../select/lasso';

/** Supported shape types (item 8). */
export type ShapeType = 'rect' | 'ellipse' | 'polygon' | 'freehand' | 'line' | 'arrow' | 'text';

/** Visual style for a shape. */
export interface ShapeStyle {
  /** RGBA stroke colour (0-255 each). */
  strokeColor: [number, number, number, number];
  /** RGBA fill colour (0-255 each). */
  fillColor: [number, number, number, number];
  /** Stroke width in screen pixels. */
  strokeWidth: number;
  /** Overall opacity multiplier 0-1 (applied on top of alpha). */
  opacity: number;
  /** Dash pattern in pixels, e.g. [6, 3]. Empty = solid. */
  dash: number[];
  /** Arrowhead placement (for line/arrow shapes). */
  arrowHead: 'none' | 'start' | 'end' | 'both';
}

export function defaultStyle(): ShapeStyle {
  return {
    strokeColor: [0, 120, 255, 220],
    fillColor: [0, 120, 255, 40],
    strokeWidth: 2,
    opacity: 1,
    dash: [],
    arrowHead: 'none',
  };
}

// --- Individual shape interfaces ---

export interface RectShape {
  kind: 'rect';
  id: string;
  /** Top-left corner in map coordinates. */
  x: number;
  y: number;
  /** Width in map units (always positive). */
  w: number;
  /** Height in map units (always positive). */
  h: number;
  /** Rotation in degrees, counter-clockwise. */
  rotation: number;
  style: ShapeStyle;
  selected: boolean;
}

export interface EllipseShape {
  kind: 'ellipse';
  id: string;
  /** Centre in map coordinates. */
  cx: number;
  cy: number;
  /** Half-axis lengths in map units (always positive). */
  rx: number;
  ry: number;
  /** Rotation in degrees, counter-clockwise. */
  rotation: number;
  style: ShapeStyle;
  selected: boolean;
}

export interface PolygonShape {
  kind: 'polygon' | 'freehand';
  id: string;
  /** Closed polygon vertices in map coordinates. */
  vertices: [number, number][];
  style: ShapeStyle;
  selected: boolean;
}

export interface LineShape {
  kind: 'line' | 'arrow';
  id: string;
  /** Path points in map coordinates (at least 2). */
  points: [number, number][];
  style: ShapeStyle;
  selected: boolean;
}

export interface TextShape {
  kind: 'text';
  id: string;
  /** Anchor position in map coordinates. */
  x: number;
  y: number;
  text: string;
  fontSize: number;
  /** CSS font-family string. */
  fontFamily: string;
  style: ShapeStyle;
  selected: boolean;
}

export type Shape = RectShape | EllipseShape | PolygonShape | LineShape | TextShape;

/** Versioned JSON container for shapes (export/import). */
export interface ShapesExport {
  version: 1;
  shapes: Shape[];
}

// --- Geometry helpers ---

const TWO_PI = Math.PI * 2;
/** Default number of line segments for ellipse approximation. */
export const ELLIPSE_SEGMENTS = 64;

/**
 * Convert a rectangle to a closed polygon in map coordinates.
 * Rotation is in degrees (counter-clockwise).
 */
export function rectToPolygon(rect: RectShape): [number, number][] {
  const { x, y, w, h, rotation } = rect;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const ang = (rotation * Math.PI) / 180;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const half = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ] as [number, number][];
  return half.map(([dx, dy]) => [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]);
}

/**
 * Convert an ellipse to a closed polygon (approximated with `segments` line segments).
 * Rotation is in degrees (counter-clockwise).
 */
export function ellipseToPolygon(ellipse: EllipseShape, segments = ELLIPSE_SEGMENTS): [number, number][] {
  const { cx, cy, rx, ry, rotation } = ellipse;
  const ang = (rotation * Math.PI) / 180;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const pts: [number, number][] = [];
  for (let i = 0; i < segments; i++) {
    const t = (TWO_PI * i) / segments;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    pts.push([cx + ex * cos - ey * sin, cy + ex * sin + ey * cos]);
  }
  return pts;
}

/**
 * Convert any closed shape to a polygon suitable for `pointInPolygon`.
 * Returns `null` for open shapes (line, arrow, text).
 */
export function shapeToPolygon(shape: Shape): [number, number][] | null {
  switch (shape.kind) {
    case 'rect':
      return rectToPolygon(shape);
    case 'ellipse':
      return ellipseToPolygon(shape);
    case 'polygon':
    case 'freehand':
      return shape.vertices.length >= 3 ? shape.vertices.slice() : null;
    default:
      return null; // line, arrow, text are open shapes
  }
}

/**
 * Test whether map point (x, y) lies inside `shape`.
 * Returns false for open shapes (line, arrow, text).
 */
export function pointInShape(x: number, y: number, shape: Shape): boolean {
  const poly = shapeToPolygon(shape);
  if (!poly) return false;
  const flat = poly.flatMap(([px, py]) => [px, py]);
  return pointInPolygon(x, y, flat);
}

/**
 * Find indices (0..n-1) of points in `xy` (interleaved x/y, length `n*2`) that lie
 * inside `shape`.  Uses `pointsInPolygon` from lasso.ts (bounding-box + even-odd).
 * Returns an empty array for open shapes.
 */
export function pointsInShape(xy: Float32Array, n: number, shape: Shape): Uint32Array {
  const poly = shapeToPolygon(shape);
  if (!poly) return new Uint32Array(0);
  const flat = poly.flatMap(([px, py]) => [px, py]);
  return lassoPointsInPolygon(xy, n, flat);
}

/** Compute an axis-aligned bounding box of a polygon. */
export function polyBounds(poly: [number, number][]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [px, py] of poly) {
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  return { minX, minY, maxX, maxY };
}

/** Compute an axis-aligned bounding box for any shape. */
export function shapeBounds(shape: Shape): { minX: number; minY: number; maxX: number; maxY: number } {
  switch (shape.kind) {
    case 'rect':
      return polyBounds(rectToPolygon(shape));
    case 'ellipse':
      return polyBounds(ellipseToPolygon(shape, 32));
    case 'polygon':
    case 'freehand':
      return polyBounds(shape.vertices);
    case 'line':
    case 'arrow':
      return polyBounds(shape.points);
    case 'text': {
      const s = 50; // approximate half-extent
      return { minX: shape.x - s, minY: shape.y - s, maxX: shape.x + s, maxY: shape.y + s };
    }
  }
}

// --- Factory helpers ---

let _nextId = 0;
export function nextShapeId(): string {
  return `shape-${Date.now()}-${_nextId++}`;
}

export function makeRect(x: number, y: number, w: number, h: number, style?: Partial<ShapeStyle>): RectShape {
  return { kind: 'rect', id: nextShapeId(), x, y, w, h, rotation: 0, style: { ...defaultStyle(), ...style }, selected: false };
}

export function makeEllipse(cx: number, cy: number, rx: number, ry: number, style?: Partial<ShapeStyle>): EllipseShape {
  return { kind: 'ellipse', id: nextShapeId(), cx, cy, rx, ry, rotation: 0, style: { ...defaultStyle(), ...style }, selected: false };
}

export function makePolygon(vertices: [number, number][], style?: Partial<ShapeStyle>): PolygonShape {
  return { kind: 'polygon', id: nextShapeId(), vertices, style: { ...defaultStyle(), ...style }, selected: false };
}

export function makeFreehand(vertices: [number, number][], style?: Partial<ShapeStyle>): PolygonShape {
  return { kind: 'freehand', id: nextShapeId(), vertices, style: { ...defaultStyle(), ...style }, selected: false };
}

export function makeLine(points: [number, number][], style?: Partial<ShapeStyle>): LineShape {
  return { kind: 'line', id: nextShapeId(), points, style: { ...defaultStyle(), arrowHead: 'none', ...style }, selected: false };
}

export function makeArrow(points: [number, number][], style?: Partial<ShapeStyle>): LineShape {
  return { kind: 'arrow', id: nextShapeId(), points, style: { ...defaultStyle(), arrowHead: 'end', ...style }, selected: false };
}

export function makeText(x: number, y: number, text: string, fontSize = 14, fontFamily = 'sans-serif', style?: Partial<ShapeStyle>): TextShape {
  return { kind: 'text', id: nextShapeId(), x, y, text, fontSize, fontFamily, style: { ...defaultStyle(), ...style }, selected: false };
}

// --- Geometric transforms ---

/** Move a shape by (dx, dy) in map units. Returns a new shape (immutable). */
export function moveShape<T extends Shape>(shape: T, dx: number, dy: number): T {
  switch (shape.kind) {
    case 'rect':
      return { ...shape, x: shape.x + dx, y: shape.y + dy } as T;
    case 'ellipse':
      return { ...shape, cx: shape.cx + dx, cy: shape.cy + dy } as T;
    case 'polygon':
    case 'freehand':
      return { ...shape, vertices: shape.vertices.map(([vx, vy]) => [vx + dx, vy + dy] as [number, number]) } as T;
    case 'line':
    case 'arrow':
      return { ...shape, points: shape.points.map(([px, py]) => [px + dx, py + dy] as [number, number]) } as T;
    case 'text':
      return { ...shape, x: shape.x + dx, y: shape.y + dy } as T;
  }
}

/** Scale a shape around its centroid. `scaleX` and `scaleY` default to `scale`. */
export function scaleShape<T extends Shape>(shape: T, scale: number, scaleX?: number, scaleY?: number): T {
  const sx = scaleX ?? scale;
  const sy = scaleY ?? scale;
  switch (shape.kind) {
    case 'rect':
      return { ...shape, w: shape.w * sx, h: shape.h * sy } as T;
    case 'ellipse':
      return { ...shape, rx: shape.rx * sx, ry: shape.ry * sy } as T;
    case 'polygon':
    case 'freehand': {
      const cx = shape.vertices.reduce((s, [x]) => s + x, 0) / shape.vertices.length;
      const cy = shape.vertices.reduce((s, [, y]) => s + y, 0) / shape.vertices.length;
      return {
        ...shape,
        vertices: shape.vertices.map(([vx, vy]) => [cx + (vx - cx) * sx, cy + (vy - cy) * sy] as [number, number]),
      } as T;
    }
    case 'line':
    case 'arrow': {
      const cx = shape.points.reduce((s, [x]) => s + x, 0) / shape.points.length;
      const cy = shape.points.reduce((s, [, y]) => s + y, 0) / shape.points.length;
      return {
        ...shape,
        points: shape.points.map(([px, py]) => [cx + (px - cx) * sx, cy + (py - cy) * sy] as [number, number]),
      } as T;
    }
    case 'text':
      return { ...shape, fontSize: shape.fontSize * scale } as T;
  }
}

// --- JSON export / import ---

/** Export shapes to a versioned JSON object. */
export function exportShapesJson(shapes: Shape[]): ShapesExport {
  return { version: 1, shapes: shapes.map((s) => ({ ...s })) };
}

/** Import shapes from a versioned JSON object. Returns the shapes array on success. */
export function importShapesJson(raw: unknown): Shape[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  if (obj['version'] !== 1) return [];
  if (!Array.isArray(obj['shapes'])) return [];
  // Basic validation: each item must have a `kind` and an `id`.
  return (obj['shapes'] as unknown[]).filter(
    (s) => s && typeof s === 'object' && typeof (s as any).kind === 'string' && typeof (s as any).id === 'string',
  ) as Shape[];
}
