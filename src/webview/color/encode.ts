import { CATEGORICAL, NULL_COLOR, OTHER_COLOR, hexToRgb, lut } from './colormaps';

/** Map numeric values to RGBA using [lo, hi] (clamped) and a colormap. NaN → null color. */
export function encodeNumeric(values: Float32Array, lo: number, hi: number, cmap: string, out?: Uint8Array): Uint8Array {
  const n = values.length;
  const rgba = out && out.length === n * 4 ? out : new Uint8Array(n * 4);
  const table = lut(cmap);
  const nul = hexToRgb(NULL_COLOR);
  const span = hi > lo ? hi - lo : 1;
  const scale = 255 / span;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    const o = i * 4;
    if (v !== v) {
      rgba[o] = nul[0];
      rgba[o + 1] = nul[1];
      rgba[o + 2] = nul[2];
      rgba[o + 3] = 160;
      continue;
    }
    let k = Math.round((v - lo) * scale);
    k = k < 0 ? 0 : k > 255 ? 255 : k;
    rgba[o] = table[k * 3];
    rgba[o + 1] = table[k * 3 + 1];
    rgba[o + 2] = table[k * 3 + 2];
    rgba[o + 3] = 255;
  }
  return rgba;
}

/** Map category codes (0..n-1, n = Other, n+1 = null) to RGBA. */
export function encodeCategorical(codes: Uint16Array, nCategories: number, out?: Uint8Array): Uint8Array {
  const n = codes.length;
  const rgba = out && out.length === n * 4 ? out : new Uint8Array(n * 4);
  const palette = new Uint8Array((nCategories + 2) * 4);
  for (let c = 0; c < nCategories + 2; c++) {
    const hex = c < nCategories ? CATEGORICAL[c % CATEGORICAL.length] : c === nCategories ? OTHER_COLOR : NULL_COLOR;
    const [r, g, b] = hexToRgb(hex);
    palette.set([r, g, b, c <= nCategories ? 255 : 160], c * 4);
  }
  const maxCode = nCategories + 1;
  for (let i = 0; i < n; i++) {
    const c = Math.min(codes[i], maxCode) * 4;
    const o = i * 4;
    rgba[o] = palette[c];
    rgba[o + 1] = palette[c + 1];
    rgba[o + 2] = palette[c + 2];
    rgba[o + 3] = palette[c + 3];
  }
  return rgba;
}

export function encodeConstant(n: number, hex: string): Uint8Array {
  const [r, g, b] = hexToRgb(hex);
  const rgba = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/** Gather RGBA rows at the given indices. */
export function gatherRgba(rgba: Uint8Array, idx: Uint32Array): Uint8Array {
  const out = new Uint8Array(idx.length * 4);
  const src = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length / 4);
  const dst = new Uint32Array(out.buffer);
  for (let i = 0; i < idx.length; i++) {
    dst[i] = src[idx[i]];
  }
  return out;
}
