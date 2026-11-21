// A categorical palette that follows the map (after DataMapPlot's palette_from_datamap):
// groups that sit close together on the map get related hues, and outlying groups get more
// chroma and contrast. Colors are made in OKLCH instead of CIECAM02 JCh.

export interface MapPaletteOptions {
  /** True for dark plot backgrounds: outlying groups get lighter instead of darker. */
  dark: boolean;
  /** Hue rotation in degrees. */
  hueShift?: number;
  /** Half-width (radians) of the initial angular sector used to rank a group's radius. */
  thetaRange?: number;
  /** Exponent on the radius when spacing hues (DataMapPlot's radius_weight_power). */
  radiusWeightPower?: number;
  /** Most data points used for the radius reference (a regular subsample). */
  maxPoints?: number;
}

/**
 * Hex colors for groups located at `centers` (x, y per group; NaN = not on the map), given the
 * map's points `xy` (n points, interleaved). Groups without a location get `fallback(i)`.
 *
 * - Hue: groups are sorted by angle around the center of the map; each gets a hue proportional to
 *   the cumulative sum of radius^power up to it, so groups near each other get nearby hues and
 *   the hue circle is shared out by how far groups are from the center.
 * - Chroma and lightness: from the group's radius ranked among the radii of the points in its
 *   angular sector. Outlying groups get more chroma, and lightness moves away from the background.
 */
export function mapPalette(
  centers: Float64Array | number[],
  xy: Float32Array,
  n: number,
  opts: MapPaletteOptions,
  fallback: (i: number) => string,
): string[] {
  const k = centers.length / 2;
  const out: string[] = new Array(k);
  // Map center: the middle of the bounding box, as in DataMapPlot.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const step = Math.max(1, Math.floor(n / (opts.maxPoints ?? 20_000)));
  const sample: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = xy[2 * i];
    const y = xy[2 * i + 1];
    if (!(x === x && y === y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (i % step === 0) sample.push(i);
  }
  const valid: number[] = [];
  for (let g = 0; g < k; g++) {
    if (Number.isFinite(centers[2 * g]) && Number.isFinite(centers[2 * g + 1])) valid.push(g);
    else out[g] = fallback(g);
  }
  if (!isFinite(minX) || valid.length === 0) {
    for (const g of valid) out[g] = fallback(g);
    return out;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const power = opts.radiusWeightPower ?? 1;

  // Polar coordinates of the data sample and of the groups.
  const dataR = new Float64Array(sample.length);
  const dataT = new Float64Array(sample.length);
  sample.forEach((i, j) => {
    const dx = xy[2 * i] - cx;
    const dy = xy[2 * i + 1] - cy;
    dataR[j] = Math.hypot(dx, dy);
    dataT[j] = Math.atan2(dy, dx);
  });
  const gr = valid.map((g) => Math.hypot(centers[2 * g] - cx, centers[2 * g + 1] - cy));
  const gt = valid.map((g) => Math.atan2(centers[2 * g + 1] - cy, centers[2 * g] - cx));

  // Hue: cumulative radius weight in angular order.
  const order = valid.map((_, j) => j).sort((a, b) => gt[a] - gt[b]);
  const weight = new Float64Array(valid.length);
  let acc = 0;
  for (const j of order) {
    acc += Math.pow(Math.max(gr[j], 1e-12), power);
    weight[j] = acc;
  }
  const total = acc > 0 ? acc : 1;
  const hueShift = opts.hueShift ?? 0;

  // Chroma and lightness ranges (OKLCH). Lightness moves away from the background as groups get
  // farther from the center: lighter on dark backgrounds, darker on light ones.
  const [cLo, cHi] = [0.07, 0.18];
  const [lCenter, lOuter] = opts.dark ? [0.6, 0.86] : [0.8, 0.5];
  const thetaRange = Math.min(opts.thetaRange ?? Math.PI / 16, Math.PI * (1 - 1e-6));

  valid.forEach((g, j) => {
    const q = radiusRank(gr[j], gt[j], dataR, dataT, thetaRange);
    const hue = (((weight[j] / total) * 360 + hueShift) % 360 + 360) % 360;
    const chroma = cLo + q * (cHi - cLo);
    const lightness = lCenter + q * (lOuter - lCenter);
    out[g] = oklchToHex(lightness, chroma, hue);
  });
  return out;
}

/**
 * Rank (0..1) of radius r among the radii of the data points in the angular sector around theta.
 * The sector starts at ±thetaRange and widens up to ±π/2 until it holds points.
 */
function radiusRank(r: number, theta: number, dataR: Float64Array, dataT: Float64Array, thetaRange: number): number {
  for (let s = 0; s < 16; s++) {
    const spread = 2 * thetaRange + ((Math.PI - 2 * thetaRange) * s) / 15;
    let total = 0;
    let below = 0;
    for (let i = 0; i < dataR.length; i++) {
      let d = Math.abs(dataT[i] - theta);
      if (d > Math.PI) d = 2 * Math.PI - d;
      if (d < spread / 2) {
        total++;
        if (dataR[i] < r) below++;
      }
    }
    if (total > 0) return below / total;
  }
  return 0.5;
}

/** OKLCH (L 0..1, C, h degrees) to an sRGB hex color, reducing chroma until it fits the gamut. */
export function oklchToHex(l: number, c: number, h: number): string {
  let lo = 0;
  let hi = c;
  let rgb = oklchToLinearRgb(l, c, h);
  if (!inGamut(rgb)) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinearRgb(l, mid, h))) lo = mid;
      else hi = mid;
    }
    rgb = oklchToLinearRgb(l, lo, h);
  }
  return '#' + rgb.map((v) => Math.round(encodeSrgb(Math.min(1, Math.max(0, v))) * 255).toString(16).padStart(2, '0')).join('');
}

function inGamut(rgb: number[]): boolean {
  return rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
}

function oklchToLinearRgb(L: number, C: number, hDeg: number): number[] {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function encodeSrgb(x: number): number {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** Hue (degrees) of a hex color in OKLCH; for tests and debugging. */
export function hexHue(hex: string): number {
  const v = parseInt(hex.slice(1), 16);
  const lin = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2]);
  const m = Math.cbrt(0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2]);
  const s = Math.cbrt(0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2]);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
}
