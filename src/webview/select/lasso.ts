// Lasso selection: which points fall inside a polygon, and how selections combine.

export type SelectMode = 'replace' | 'add' | 'remove';

/** Even-odd rule point-in-polygon test (polygon as interleaved x, y). */
export function pointInPolygon(x: number, y: number, poly: Float64Array | number[]): boolean {
  let inside = false;
  const m = poly.length / 2;
  for (let i = 0, j = m - 1; i < m; j = i++) {
    const xi = poly[2 * i];
    const yi = poly[2 * i + 1];
    const xj = poly[2 * j];
    const yj = poly[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Indices (0..n-1) of the points of `xy` inside the polygon (world coordinates). A bounding-box
 * test skips most points cheaply. Points with NaN coordinates are never inside.
 */
export function pointsInPolygon(xy: Float32Array, n: number, poly: Float64Array | number[]): Uint32Array {
  if (poly.length < 6) return new Uint32Array(0);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    minX = Math.min(minX, poly[i]);
    maxX = Math.max(maxX, poly[i]);
    minY = Math.min(minY, poly[i + 1]);
    maxY = Math.max(maxY, poly[i + 1]);
  }
  const hits: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = xy[2 * i];
    const y = xy[2 * i + 1];
    if (!(x >= minX && x <= maxX && y >= minY && y <= maxY)) continue; // also skips NaN
    if (pointInPolygon(x, y, poly)) hits.push(i);
  }
  return Uint32Array.from(hits);
}

/**
 * Combine a selection mask (1 = selected, length n) with newly hit row indices. Returns a new
 * mask, or null when nothing is selected.
 */
export function combineSelection(prev: Uint8Array | null, hits: Uint32Array, n: number, mode: SelectMode): Uint8Array | null {
  const out = mode === 'replace' || !prev ? new Uint8Array(n) : prev.slice();
  if (mode === 'remove') {
    if (!prev) return null;
    for (const i of hits) out[i] = 0;
  } else {
    for (const i of hits) out[i] = 1;
  }
  return countSelected(out) > 0 ? out : null;
}

export function countSelected(mask: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < mask.length; i++) c += mask[i];
  return c;
}

/** Invert a selection within `scope` (indices that can be selected; all rows when undefined). */
export function invertSelection(mask: Uint8Array | null, n: number, scope?: Uint32Array): Uint8Array | null {
  const out = new Uint8Array(n);
  if (scope) {
    for (const i of scope) out[i] = mask && mask[i] ? 0 : 1;
  } else {
    for (let i = 0; i < n; i++) out[i] = mask && mask[i] ? 0 : 1;
  }
  return countSelected(out) > 0 ? out : null;
}

/** Pack a 0/1 mask into bytes, least significant bit first (numpy unpackbits(bitorder="little")). */
export function packBits(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(mask.length / 8));
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) out[i >> 3] |= 1 << (i & 7);
  }
  return out;
}

/**
 * Fade the colors of unselected points: mix them 75% toward the background and lower their alpha,
 * so the selection stands out in its own colors (in place).
 */
export function fadeUnselected(rgba: Uint8Array, mask: Uint8Array, background: [number, number, number]): void {
  const n = Math.min(mask.length, rgba.length / 4);
  for (let i = 0; i < n; i++) {
    if (mask[i]) continue;
    const o = 4 * i;
    rgba[o] = Math.round(rgba[o] * 0.25 + background[0] * 0.75);
    rgba[o + 1] = Math.round(rgba[o + 1] * 0.25 + background[1] * 0.75);
    rgba[o + 2] = Math.round(rgba[o + 2] * 0.25 + background[2] * 0.75);
    rgba[o + 3] = Math.round(rgba[o + 3] * 0.5);
  }
}
