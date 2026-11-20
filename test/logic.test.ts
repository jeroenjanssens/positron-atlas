import { describe, expect, it } from 'vitest';
import { isRebuild, liveChanges, lowerBound, pctToSlider, pythonSnippet, sliderToPct, formatSeconds, toHex } from '../src/webview/logic';
import { DEFAULT_UMAP } from '../src/webview/defaults';

describe('umap param classification', () => {
  it('detects rebuild vs live', () => {
    expect(isRebuild(DEFAULT_UMAP, { ...DEFAULT_UMAP, nNeighbors: 30 })).toBe(true);
    expect(isRebuild(DEFAULT_UMAP, { ...DEFAULT_UMAP, metric: 'cosine' })).toBe(true);
    expect(isRebuild(DEFAULT_UMAP, { ...DEFAULT_UMAP, minDist: 0.5 })).toBe(false);
    expect(liveChanges(DEFAULT_UMAP, { ...DEFAULT_UMAP, minDist: 0.5, spread: 2 })).toEqual({ minDist: 0.5, spread: 2 });
    expect(liveChanges(DEFAULT_UMAP, DEFAULT_UMAP)).toEqual({});
  });
});

describe('helpers', () => {
  it('lowerBound', () => {
    const a = new Uint32Array([1, 3, 3, 7]);
    expect(lowerBound(a, 0)).toBe(0);
    expect(lowerBound(a, 3)).toBe(1);
    expect(lowerBound(a, 4)).toBe(3);
    expect(lowerBound(a, 8)).toBe(4);
  });

  it('log slider round-trips the ends and is monotonic', () => {
    expect(sliderToPct(0)).toBe(0.1);
    expect(sliderToPct(1000)).toBe(100);
    expect(sliderToPct(pctToSlider(10))).toBe(10);
    expect(sliderToPct(pctToSlider(1))).toBe(1);
    let prev = 0;
    for (let i = 0; i <= 1000; i += 10) {
      const v = sliderToPct(i);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('formats seconds', () => {
    expect(formatSeconds(0.25)).toBe('250 ms');
    expect(formatSeconds(12.34)).toBe('12.3 s');
    expect(formatSeconds(125)).toBe('2 min 5 s');
  });

  it('generates a python snippet', () => {
    const s = pythonSnippet('df', ['a', 'b'], { features: [0, 1], samplePct: 10, standardize: true, pca: true, pcaDims: 20, nanPolicy: 'drop', seed: 1, maxAnchors: 1, anchorBudget: 1 }, DEFAULT_UMAP);
    expect(s).toContain('features = ["a", "b"]');
    expect(s).toContain('frac=0.1');
    expect(s).toContain('PCA(n_components=20');
    expect(s).toContain('metric="euclidean"');
    expect(s).toContain('n_neighbors=15');
  });
});

describe('toHex', () => {
  it('normalizes theme colors for the color picker', () => {
    expect(toHex('#1E1E1E')).toBe('#1e1e1e');
    expect(toHex('#fff')).toBe('#ffffff');
    expect(toHex('#11223344')).toBe('#112233');
    expect(toHex('rgb(30, 30, 30)')).toBe('#1e1e1e');
    expect(toHex('rgba(255,0,16,0.5)')).toBe('#ff0010');
    expect(toHex('nonsense')).toBe('#1e1e1e');
  });
});
