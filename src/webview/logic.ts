import type { PrepareOptions, UmapParams } from '../shared/protocol';

/** Parameters that change the kNN graph or initialization and need a new UMAP instance. */
const REBUILD_KEYS: (keyof UmapParams)[] = ['nNeighbors', 'metric', 'seed', 'nEpochs'];
/** Parameters that can be applied to a running UMAP via setParameters. */
const LIVE_KEYS = ['minDist', 'spread', 'repulsionStrength', 'negativeSampleRate', 'learningRate'] as const;

export function isRebuild(prev: UmapParams, next: UmapParams): boolean {
  return REBUILD_KEYS.some((k) => prev[k] !== next[k]);
}

export function liveChanges(prev: UmapParams, next: UmapParams): Partial<UmapParams> {
  const out: Partial<UmapParams> = {};
  for (const k of LIVE_KEYS) {
    if (prev[k] !== next[k]) {
      (out as any)[k] = next[k];
    }
  }
  return out;
}

/** First index i with sorted[i] >= value. */
export function lowerBound(sorted: ArrayLike<number>, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatSeconds(s: number): string {
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  if (s < 90) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

function pyRepr(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return String(v);
}

/** Equivalent umap-learn code for the current settings. */
export function pythonSnippet(variable: string, features: string[], prep: PrepareOptions, p: UmapParams): string {
  const lines = ['import numpy as np', 'import umap', ''];
  lines.push(`features = ${'['}${features.map((f) => JSON.stringify(f)).join(', ')}${']'}`);
  if (prep.samplePct < 100) {
    lines.push(`data = ${variable}.sample(frac=${prep.samplePct / 100}, random_state=${prep.seed})  # polars: .sample(fraction=..., seed=...)`);
  } else {
    lines.push(`data = ${variable}`);
  }
  lines.push('X = data[features].to_numpy(dtype="float32")');
  lines.push(prep.nanPolicy === 'drop' ? 'X = X[~np.isnan(X).any(axis=1)]' : 'X = np.where(np.isnan(X), np.nanmedian(X, axis=0), X)');
  if (prep.standardize) {
    lines.push('X = (X - X.mean(axis=0)) / np.where(X.std(axis=0) > 0, X.std(axis=0), 1)');
  }
  if (prep.pca) {
    lines.push('from sklearn.decomposition import PCA', `X = PCA(n_components=${prep.pcaDims}, random_state=${prep.seed}).fit_transform(X)`);
  }
  const args = {
    n_neighbors: p.nNeighbors,
    min_dist: p.minDist,
    spread: p.spread,
    metric: p.metric,
    n_epochs: p.nEpochs,
    repulsion_strength: p.repulsionStrength,
    negative_sample_rate: p.negativeSampleRate,
    learning_rate: p.learningRate,
    random_state: p.seed,
  };
  lines.push(
    '',
    'reducer = umap.UMAP(',
    ...Object.entries(args).map(([k, v]) => `    ${k}=${pyRepr(v)},`),
    ')',
    'embedding = reducer.fit_transform(X)',
  );
  return lines.join('\n') + '\n';
}

/** Normalize a CSS color (#rgb, #rrggbb, #rrggbbaa, rgb()/rgba()) to #rrggbb for <input type="color">. */
export function toHex(color: string): string {
  const c = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(c)) return ('#' + c.slice(1).split('').map((x) => x + x).join('')).toLowerCase();
  if (/^#[0-9a-f]{8}$/i.test(c)) return c.slice(0, 7).toLowerCase();
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(c);
  if (m) return '#' + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('');
  return '#1e1e1e';
}

export interface ImageColumns {
  /** Column indices in pixel order. */
  indices: number[];
  prefix: string;
  first: string;
  last: string;
}

/**
 * Find the pixel columns of image data: the largest group of numeric columns whose
 * names are a common prefix plus a number (e.g. px0 … px783), sorted by that number.
 */
export function detectImageColumns(columns: { index: number; name: string; kind: string }[], minCount = 16): ImageColumns | null {
  const groups = new Map<string, { n: number; index: number; name: string }[]>();
  for (const c of columns) {
    if (c.kind !== 'numeric') continue;
    const m = /^(.*?)(\d+)$/.exec(c.name);
    if (!m) continue;
    const list = groups.get(m[1]) ?? [];
    list.push({ n: Number(m[2]), index: c.index, name: c.name });
    groups.set(m[1], list);
  }
  let best: [string, { n: number; index: number; name: string }[]] | null = null;
  for (const entry of groups) {
    if (!best || entry[1].length > best[1].length) best = entry;
  }
  if (!best || best[1].length < minCount) return null;
  const sorted = [...best[1]].sort((a, b) => a.n - b.n);
  return { indices: sorted.map((c) => c.index), prefix: best[0], first: sorted[0].name, last: sorted[sorted.length - 1].name };
}

/** Default image width for n pixels: the square root when n is a perfect square. */
export function guessImageWidth(n: number): number {
  const s = Math.round(Math.sqrt(n));
  return s * s === n ? s : Math.max(1, Math.round(Math.sqrt(n)));
}

/**
 * Grayscale pixels → RGBA. Values in [0, 1] map to black–white, values up to 255 are
 * treated as 8-bit intensities, anything else is scaled by its own range. Missing → transparent.
 * With `invert`, dark and light are swapped (e.g. black digits on white).
 */
export function imageToRgba(values: (number | null)[], width: number, height: number, invert = false): Uint8ClampedArray<ArrayBuffer> {
  const n = width * height;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < Math.min(n, values.length); i++) {
    const v = values[i];
    if (v === null || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  const low = lo >= 0 ? 0 : lo;
  const high = hi <= 1 && lo >= 0 ? 1 : hi <= 255 && lo >= 0 ? 255 : hi;
  const span = high > low ? high - low : 1;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    const level = Math.round(((v - low) / span) * 255);
    const g = invert ? 255 - level : level;
    out[4 * i] = g;
    out[4 * i + 1] = g;
    out[4 * i + 2] = g;
    out[4 * i + 3] = 255;
  }
  return out;
}

/**
 * Position (along one axis) for a tooltip of size `size` near a cursor at `at` inside
 * a container of size `container`: after the cursor, before it if that overflows, and
 * clamped to the container.
 */
export function placeTooltip(at: number, size: number, container: number, gap = 14): number {
  if (at + gap + size <= container) return at + gap;
  const before = at - gap - size;
  if (before >= 0) return before;
  return Math.max(0, Math.min(container - size, at + gap));
}
