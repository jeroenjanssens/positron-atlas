import { describe, it, expect } from 'vitest';
import { normaliseValues, computeTimeFilter, stepWindow, DEFAULT_WINDOW_SIZE, DEFAULT_ANIMATE_SPEED } from '../src/webview/atlas/animate';

describe('normaliseValues', () => {
  it('maps min to 0 and max to 1', () => {
    const raw = new Float32Array([0, 5, 10]);
    const out = normaliseValues(raw);
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(0.5);
    expect(out[2]).toBeCloseTo(1);
  });

  it('handles constant input gracefully', () => {
    const raw = new Float32Array([7, 7, 7]);
    const out = normaliseValues(raw);
    for (const v of out) expect(v).toBeCloseTo(0.5);
  });

  it('outputs length equal to input', () => {
    const raw = new Float32Array([1, 2, 3, 4, 5]);
    expect(normaliseValues(raw).length).toBe(5);
  });
});

describe('computeTimeFilter', () => {
  it('passes points inside window and blocks outside', () => {
    const vals = new Float32Array([0.1, 0.5, 0.9]);
    const f = computeTimeFilter(vals, 0.4, 0.2);
    expect(f[0]).toBe(0); // 0.1 < 0.4
    expect(f[1]).toBe(1); // 0.5 in [0.4, 0.6]
    expect(f[2]).toBe(0); // 0.9 > 0.6
  });

  it('narrow window shows fewer points than wide window', () => {
    const vals = new Float32Array(Array.from({ length: 100 }, (_, i) => i / 100));
    const narrow = computeTimeFilter(vals, 0.3, 0.05);
    const wide = computeTimeFilter(vals, 0.3, 0.4);
    const narrowCount = narrow.reduce((s, v) => s + v, 0);
    const wideCount = wide.reduce((s, v) => s + v, 0);
    expect(narrowCount).toBeLessThan(wideCount);
    expect(narrowCount).toBeGreaterThan(0);
    expect(wideCount).toBeGreaterThan(0);
  });

  it('zero-width window matches no points', () => {
    const vals = new Float32Array([0.1, 0.5, 0.9]);
    const f = computeTimeFilter(vals, 0.5, 0);
    expect(f[1]).toBe(1); // exactly 0.5 is at boundary lo=0.5, hi=0.5
    expect(f[0]).toBe(0);
    expect(f[2]).toBe(0);
  });
});

describe('stepWindow', () => {
  it('advances window position by speed', () => {
    expect(stepWindow(0.3, 0.1, false)).toBeCloseTo(0.4);
  });

  it('wraps when loop=true and pos >= 1', () => {
    expect(stepWindow(0.95, 0.1, true)).toBe(0);
  });

  it('clamps when loop=false and pos >= 1', () => {
    const r = stepWindow(0.95, 0.1, false);
    expect(r).toBeLessThan(1);
    expect(r).toBeGreaterThan(0.9);
  });

  it('does not wrap when loop=false', () => {
    const r = stepWindow(0.5, 0.6, false);
    expect(r).toBeLessThan(1);
  });
});

describe('constants', () => {
  it('DEFAULT_WINDOW_SIZE is in (0, 1)', () => {
    expect(DEFAULT_WINDOW_SIZE).toBeGreaterThan(0);
    expect(DEFAULT_WINDOW_SIZE).toBeLessThan(1);
  });

  it('DEFAULT_ANIMATE_SPEED is positive', () => {
    expect(DEFAULT_ANIMATE_SPEED).toBeGreaterThan(0);
  });
});
