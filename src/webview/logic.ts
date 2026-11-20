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

/** Sample % slider uses a log scale from 0.1 % to 100 %: position 0..1000. */
export function sliderToPct(pos: number): number {
  const v = Math.pow(10, -1 + (3 * pos) / 1000);
  return v >= 10 ? Math.round(v) : v >= 1 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100;
}

export function pctToSlider(pct: number): number {
  return Math.round(((Math.log10(Math.min(100, Math.max(0.1, pct))) + 1) / 3) * 1000);
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
