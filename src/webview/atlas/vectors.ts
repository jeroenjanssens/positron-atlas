import { LineLayer } from '@deck.gl/layers';

export const MAX_VECTORS = 8000;

export interface VectorPair {
  source: [number, number] | [number, number, number];
  target: [number, number] | [number, number, number];
  color: [number, number, number, number];
}

/** Thin vector list uniformly to at most MAX_VECTORS. */
export function thinVectors(n: number): Uint32Array {
  if (n <= MAX_VECTORS) {
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    return idx;
  }
  const step = n / MAX_VECTORS;
  const idx = new Uint32Array(MAX_VECTORS);
  for (let i = 0; i < MAX_VECTORS; i++) idx[i] = Math.floor(i * step);
  return idx;
}

/**
 * Compute median vector length from source/target pairs.
 * Used to validate that vectors are non-degenerate.
 */
export function medianVectorLength(pairs: VectorPair[]): number {
  if (pairs.length === 0) return 1;
  const lens = pairs.map((p) => {
    const dx = p.target[0] - p.source[0];
    const dy = p.target[1] - p.source[1];
    return Math.sqrt(dx * dx + dy * dy);
  });
  lens.sort((a, b) => a - b);
  return lens[Math.floor(lens.length / 2)];
}

/**
 * Build VectorPair objects from two position arrays (current and next-step positions).
 * Both xy arrays are Float32Array with nd columns per point.
 */
export function buildVectors(
  xyCurr: Float32Array,
  xyNext: Float32Array,
  nd: 2 | 3,
  idx: Uint32Array,
  colors: Uint8Array | null,
): VectorPair[] {
  const pairs: VectorPair[] = [];
  for (let ii = 0; ii < idx.length; ii++) {
    const i = idx[ii];
    const base = i * nd;
    // 3D vectors keep their z (they were drawn flat at z = 0).
    const src = (nd === 3 ? [xyCurr[base], xyCurr[base + 1], xyCurr[base + 2]] : [xyCurr[base], xyCurr[base + 1]]) as VectorPair['source'];
    const tgt = (nd === 3 ? [xyNext[base], xyNext[base + 1], xyNext[base + 2]] : [xyNext[base], xyNext[base + 1]]) as VectorPair['target'];
    const ci = i * 4;
    const color: [number, number, number, number] = colors
      ? [colors[ci], colors[ci + 1], colors[ci + 2], colors[ci + 3] ?? 255]
      : [100, 149, 237, 220];
    pairs.push({ source: src, target: tgt, color });
  }
  return pairs;
}

/** Create a deck.gl LineLayer for the given vector pairs. */
export function createVectorLayer(pairs: VectorPair[], opacity: number): LineLayer {
  return new LineLayer({
    id: 'vectors-lines',
    data: pairs,
    getSourcePosition: (d: VectorPair) => d.source as any,
    getTargetPosition: (d: VectorPair) => d.target as any,
    getColor: (d: VectorPair) => d.color,
    getWidth: 2,
    widthUnits: 'pixels',
    opacity,
    pickable: false,
  });
}
