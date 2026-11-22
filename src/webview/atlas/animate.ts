export const DEFAULT_WINDOW_SIZE = 0.2;
export const DEFAULT_ANIMATE_SPEED = 0.05;

/** Normalise a numeric column to [0, 1]. */
export function normaliseValues(raw: Float64Array | Float32Array): Float32Array {
  const n = raw.length;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    if (isFinite(raw[i])) {
      if (raw[i] < lo) lo = raw[i];
      if (raw[i] > hi) hi = raw[i];
    }
  }
  if (lo === hi) {
    const out = new Float32Array(n);
    out.fill(0.5);
    return out;
  }
  const range = hi - lo;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (raw[i] - lo) / range;
  return out;
}

/**
 * Compute a gate filter (1=visible, 0=hidden) based on a sliding window.
 * windowPos and windowSize are fractions of [0, 1].
 */
export function computeTimeFilter(vals: Float32Array, windowPos: number, windowSize: number): Float32Array {
  const lo = windowPos;
  const hi = windowPos + windowSize;
  const out = new Float32Array(vals.length);
  for (let i = 0; i < vals.length; i++) {
    out[i] = (vals[i] >= lo && vals[i] <= hi) ? 1 : 0;
  }
  return out;
}

/** Advance windowPos by speed (fraction). Clamps or wraps. */
export function stepWindow(pos: number, speed: number, loop: boolean): number {
  const next = pos + speed;
  if (next >= 1) return loop ? 0 : 1 - 0.0001;
  return next;
}
