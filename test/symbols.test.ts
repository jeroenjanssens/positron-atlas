/**
 * Unit tests for the B3 / Item 9 symbol utilities (src/webview/atlas/symbols.ts).
 *
 * Tests cover only the pure helper functions; getSymbolAtlas() requires a DOM
 * canvas context and is exercised by the harness integration tests.
 */
import { describe, expect, it } from 'vitest';
import { SYMBOL_NAMES, N_SYMBOLS, symbolName, overlaySymbolCode } from '../src/webview/atlas/symbols';

describe('SYMBOL_NAMES / N_SYMBOLS', () => {
  it('has 8 symbols', () => {
    expect(N_SYMBOLS).toBe(8);
    expect(SYMBOL_NAMES).toHaveLength(8);
  });

  it('first symbol is circle', () => {
    expect(SYMBOL_NAMES[0]).toBe('circle');
  });

  it('contains the expected set of names', () => {
    const expected = ['circle', 'square', 'triangle', 'diamond', 'cross', 'star', 'hexagon', 'x'];
    expect([...SYMBOL_NAMES]).toEqual(expected);
  });

  it('all names are non-empty strings', () => {
    for (const name of SYMBOL_NAMES) {
      expect(typeof name).toBe('string');
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

describe('symbolName', () => {
  it('returns the name for valid codes 0–7', () => {
    for (let i = 0; i < N_SYMBOLS; i++) {
      expect(symbolName(i)).toBe(SYMBOL_NAMES[i]);
    }
  });

  it('wraps around for codes >= N_SYMBOLS', () => {
    expect(symbolName(8)).toBe(SYMBOL_NAMES[0]);
    expect(symbolName(9)).toBe(SYMBOL_NAMES[1]);
    expect(symbolName(16)).toBe(SYMBOL_NAMES[0]);
  });

  it('code 0 returns circle', () => {
    expect(symbolName(0)).toBe('circle');
  });
});

describe('overlaySymbolCode', () => {
  it('skips circle (code 0) for the first overlay', () => {
    expect(overlaySymbolCode(0)).not.toBe(0);
  });

  it('returns codes in range 1–7', () => {
    for (let i = 0; i < 20; i++) {
      const code = overlaySymbolCode(i);
      expect(code).toBeGreaterThanOrEqual(1);
      expect(code).toBeLessThanOrEqual(7);
    }
  });

  it('cycles after 7 overlays', () => {
    expect(overlaySymbolCode(0)).toBe(overlaySymbolCode(7));
    expect(overlaySymbolCode(1)).toBe(overlaySymbolCode(8));
  });

  it('successive overlays get different codes', () => {
    const codes = Array.from({ length: 7 }, (_, i) => overlaySymbolCode(i));
    const unique = new Set(codes);
    expect(unique.size).toBe(7);
  });
});
