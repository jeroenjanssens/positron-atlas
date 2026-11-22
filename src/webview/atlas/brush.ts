/**
 * Brush tagging (plan item 7, wave B4).
 *
 * State:
 *   - pendingCodes: Uint16Array — one entry per kept row; 65535 = no pending tag for
 *     that row; 0, 1, 2, … = class index.
 *   - classes: human-readable class names.
 *   - brushSizePx: brush radius in screen pixels (5–100).
 *   - erasing: when true, the brush removes pending tags instead of assigning one.
 *   - currentClass: index into `classes`.
 *
 * Hit logic:
 *   The 2D hit path works in world (map) coordinates: the brush centre is unprojected
 *   from screen space and compared against point positions, so it is correct at any
 *   rotation or zoom.  A bounding-box pre-filter (same as pointsInPolygon) keeps it fast.
 *
 * Fill logic:
 *   "Fill cluster / category": assigns all points that share a cluster code with the
 *   clicked point.
 */

export const BRUSH_SIZE_MIN = 5;
export const BRUSH_SIZE_MAX = 100;
export const BRUSH_SIZE_STEP = 5;
export const BRUSH_ERASER_CODE = 65535;
export const BRUSH_PALETTE: [number, number, number][] = [
  [228, 26, 28],   // class 0 — red
  [55, 126, 184],  // class 1 — blue
  [77, 175, 74],   // class 2 — green
  [152, 78, 163],  // class 3 — purple
  [255, 127, 0],   // class 4 — orange
  [255, 255, 51],  // class 5 — yellow
  [166, 86, 40],   // class 6 — brown
  [247, 129, 191], // class 7 — pink
];

/** Shared state carried in Atlas for the brush tool. */
export interface BrushState {
  /** Radius of the brush, in screen pixels (5–100). */
  sizePx: number;
  /** True when Alt is held — erases pending tags. */
  erasing: boolean;
  /** Index of the class being painted (0-based). */
  currentClass: number;
  /** Class names (human-readable; shown in the legend). */
  classes: string[];
}

export function createBrushState(): BrushState {
  return { sizePx: 20, erasing: false, currentClass: 0, classes: ['Class 1'] };
}

/** True when the tool is in erasing mode (Alt held or eraser toggle). */
export function isErasing(brush: BrushState): boolean {
  return brush.erasing;
}

/**
 * Find the indices of points (in `xy`, interleaved x/y, length `n`) within
 * `radiusWorld` world units of `(cx, cy)`.
 *
 * Uses a bounding-box pre-filter for performance; falls through to exact
 * distance for candidates.  Returns a Uint32Array of matching indices.
 */
export function hitBrush(
  xy: Float32Array,
  n: number,
  cx: number,
  cy: number,
  radiusWorld: number,
): Uint32Array {
  const r2 = radiusWorld * radiusWorld;
  const minX = cx - radiusWorld;
  const maxX = cx + radiusWorld;
  const minY = cy - radiusWorld;
  const maxY = cy + radiusWorld;
  const hits: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = xy[2 * i];
    const y = xy[2 * i + 1];
    if (!(x >= minX && x <= maxX && y >= minY && y <= maxY)) continue; // also skips NaN
    const dx = x - cx;
    const dy = y - cy;
    if (dx * dx + dy * dy <= r2) hits.push(i);
  }
  return Uint32Array.from(hits);
}

/**
 * Paint `hits` with `classIdx` in `pendingCodes`.
 * Returns a new Uint16Array (never mutates the input).
 */
export function paintBrush(
  pendingCodes: Uint16Array,
  hits: Uint32Array,
  classIdx: number,
): Uint16Array {
  const out = pendingCodes.slice();
  for (const i of hits) out[i] = classIdx;
  return out;
}

/**
 * Erase `hits` from `pendingCodes` (set to BRUSH_ERASER_CODE = 65535).
 * Returns a new Uint16Array.
 */
export function eraseBrush(pendingCodes: Uint16Array, hits: Uint32Array): Uint16Array {
  const out = pendingCodes.slice();
  for (const i of hits) out[i] = BRUSH_ERASER_CODE;
  return out;
}

/**
 * Fill all points in `clusterCodes` that share `clusterIdx` with `classIdx`.
 * Returns a new Uint16Array.
 */
export function fillBrushCluster(
  pendingCodes: Uint16Array,
  clusterCodes: Uint16Array,
  clusterIdx: number,
  classIdx: number,
): Uint16Array {
  const out = pendingCodes.slice();
  for (let i = 0; i < clusterCodes.length; i++) {
    if (clusterCodes[i] === clusterIdx) out[i] = classIdx;
  }
  return out;
}

/**
 * Fill all points whose color-column category code equals `catIdx`.
 * Returns a new Uint16Array.
 */
export function fillBrushCategory(
  pendingCodes: Uint16Array,
  colorCodes: Uint16Array,
  catIdx: number,
  classIdx: number,
): Uint16Array {
  const out = pendingCodes.slice();
  for (let i = 0; i < colorCodes.length; i++) {
    if (colorCodes[i] === catIdx) out[i] = classIdx;
  }
  return out;
}

/**
 * Build RGBA colors for the brush overlay.
 *
 * Points with pendingCodes[i] < classes.length get the class color at high alpha (200).
 * Points with pendingCodes[i] == BRUSH_ERASER_CODE (65535) get transparent (0 alpha).
 *
 * @param pendingCodes  One u16 per kept row.
 * @param n             Number of kept rows (may be < pendingCodes.length if only anchors shown).
 * @param palette       RGB palette (one entry per class).
 */
export function buildBrushOverlayColors(
  pendingCodes: Uint16Array,
  n: number,
  palette: [number, number, number][],
): Uint8Array {
  const rgba = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const code = pendingCodes[i];
    if (code === BRUSH_ERASER_CODE || code >= palette.length) {
      // transparent
      rgba[4 * i + 3] = 0;
    } else {
      const [r, g, b] = palette[code];
      rgba[4 * i] = r;
      rgba[4 * i + 1] = g;
      rgba[4 * i + 2] = b;
      rgba[4 * i + 3] = 200;
    }
  }
  return rgba;
}

/**
 * Convert pending brush codes to a writeLabels-compatible codes array.
 * Rows with BRUSH_ERASER_CODE keep their existing column value (`keepOthers=true`).
 * Rows with a valid class index get that class.
 *
 * Returns `{ codes: Uint16Array, names: string[] }` for use in the writeLabels message.
 * The returned codes array uses 0-based indices into `classes`; untagged rows are 65535.
 */
export function brushCodesToWriteLabels(
  pendingCodes: Uint16Array,
  classes: string[],
): { codes: Uint16Array; names: string[] } {
  return { codes: pendingCodes.slice(), names: classes.slice() };
}

/** Adjust brush size, clamped to [BRUSH_SIZE_MIN, BRUSH_SIZE_MAX]. */
export function adjustBrushSize(current: number, delta: number): number {
  return Math.max(BRUSH_SIZE_MIN, Math.min(BRUSH_SIZE_MAX, current + delta));
}

/** Convert a screen-pixel brush radius to a world-unit radius given `worldPerPixel`. */
export function brushWorldRadius(sizePx: number, worldPerPixel: number): number {
  return sizePx * worldPerPixel;
}
