// Colormaps as evenly spaced stops (matplotlib / Tableau), linearly interpolated.

export const SEQUENTIAL: Record<string, string[]> = {
  viridis: ['#440154', '#482475', '#414487', '#355f8d', '#2a788e', '#21918c', '#22a884', '#44bf70', '#7ad151', '#bddf26', '#fde725'],
  cividis: ['#00224e', '#123570', '#3b496c', '#575d6d', '#707173', '#8a8779', '#a69d75', '#c4b56c', '#e4cf5b', '#fee838'],
  magma: ['#000004', '#140e36', '#3b0f70', '#641a80', '#8c2981', '#b73779', '#de4968', '#f7705c', '#fe9f6d', '#fecf92', '#fcfdbf'],
  plasma: ['#0d0887', '#41049d', '#6a00a8', '#8f0da4', '#b12a90', '#cc4778', '#e16462', '#f2844b', '#fca636', '#fcce25', '#f0f921'],
  inferno: ['#000004', '#160b39', '#420a68', '#6a176e', '#932667', '#bc3754', '#dd513a', '#f37819', '#fca50a', '#f6d746', '#fcffa4'],
  'blue-red (diverging)': ['#053061', '#2166ac', '#4393c3', '#92c5de', '#d1e5f0', '#f7f7f7', '#fddbc7', '#f4a582', '#d6604d', '#b2182b', '#67001f'],
};

/** Tableau 10 followed by the Tableau 20 companions: 20 distinct categorical colors. */
export const CATEGORICAL = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
  '#a0cbe8', '#ffbe7d', '#ff9d9a', '#86bcb6', '#8cd17d', '#f1ce63', '#d4a6c8', '#fabfd2', '#d7b5a6', '#79706e',
];

export const OTHER_COLOR = '#9a9a9a';
export const NULL_COLOR = '#5a5a5a';
export const DEFAULT_POINT_COLOR = '#4e79a7';

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** 256-entry RGB lookup table for a colormap. */
export function lut(name: string): Uint8Array {
  const stops = (SEQUENTIAL[name] ?? SEQUENTIAL.viridis).map(hexToRgb);
  const out = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(t));
    const f = t - k;
    for (let c = 0; c < 3; c++) {
      out[i * 3 + c] = Math.round(stops[k][c] * (1 - f) + stops[k + 1][c] * f);
    }
  }
  return out;
}

export function cssGradient(name: string): string {
  const stops = SEQUENTIAL[name] ?? SEQUENTIAL.viridis;
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
