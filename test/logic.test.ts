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

import { detectImageColumns, guessImageWidth, imageToRgba } from '../src/webview/logic';

describe('image helpers', () => {
  const cols = [
    ...Array.from({ length: 784 }, (_, i) => ({ index: i + 1, name: `px${i}`, kind: 'numeric' })),
    { index: 0, name: 'id', kind: 'numeric' },
    { index: 785, name: 'label', kind: 'categorical' },
    { index: 786, name: 'ink', kind: 'numeric' },
    { index: 787, name: 'f1', kind: 'numeric' },
  ];

  it('detects pixel columns in numeric order', () => {
    const shuffled = [...cols].reverse();
    const d = detectImageColumns(shuffled)!;
    expect(d.indices.length).toBe(784);
    expect(d.indices[0]).toBe(1);
    expect(d.indices[783]).toBe(784);
    expect(d.prefix).toBe('px');
    expect([d.first, d.last]).toEqual(['px0', 'px783']);
    expect(detectImageColumns([{ index: 0, name: 'a1', kind: 'numeric' }])).toBeNull();
  });

  it('guesses the width', () => {
    expect(guessImageWidth(784)).toBe(28);
    expect(guessImageWidth(64)).toBe(8);
    expect(guessImageWidth(100 * 50)).toBe(71);
  });

  it('converts pixels to RGBA', () => {
    const px = imageToRgba([0, 255, 127.5, null], 2, 2);
    expect(Array.from(px.slice(0, 4))).toEqual([0, 0, 0, 255]);
    expect(Array.from(px.slice(4, 8))).toEqual([255, 255, 255, 255]);
    expect(px[8]).toBe(128);
    expect(px[15]).toBe(0); // missing → transparent
    expect(Array.from(imageToRgba([0, 1], 2, 1).slice(4, 7))).toEqual([255, 255, 255]); // [0, 1] range
    expect(Array.from(imageToRgba([-1, 1], 2, 1).slice(0, 3))).toEqual([0, 0, 0]); // own range
  });
});

import { placeTooltip } from '../src/webview/logic';

describe('placeTooltip', () => {
  it('stays inside the container', () => {
    expect(placeTooltip(100, 50, 400)).toBe(114); // after the cursor
    expect(placeTooltip(380, 50, 400)).toBe(316); // flipped before the cursor
    expect(placeTooltip(20, 300, 320)).toBe(20); // too big on both sides: clamped
    expect(placeTooltip(200, 500, 320)).toBe(0);
  });
});

describe('imageToRgba invert', () => {
  it('swaps dark and light but keeps missing transparent', () => {
    const px = imageToRgba([0, 255, 51, null], 2, 2, true);
    expect(Array.from(px.slice(0, 4))).toEqual([255, 255, 255, 255]);
    expect(Array.from(px.slice(4, 8))).toEqual([0, 0, 0, 255]);
    expect(px[8]).toBe(204);
    expect(px[15]).toBe(0);
  });
});
