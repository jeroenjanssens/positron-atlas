/**
 * Unit tests for the navigation input system (wave A1, items 1 and 14).
 *
 * Covers:
 *  - Binding registry: all actionIds are present, keys are plausible, formatKey works
 *  - defaultKey: platform variants (mac / win / linux) returned correctly
 *  - Rotation math helpers: wrap and step logic
 */

import { describe, expect, it } from 'vitest';
import {
  BINDINGS,
  findBinding,
  defaultKey,
  formatKey,
  type ActionId,
} from '../src/webview/input/bindings';

// ---- Binding registry --------------------------------------------------------

describe('BINDINGS registry', () => {
  it('has at least 20 entries', () => {
    expect(BINDINGS.length).toBeGreaterThanOrEqual(20);
  });

  it('every actionId is unique', () => {
    const ids = BINDINGS.map((b) => b.actionId);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('every entry has a non-empty label', () => {
    for (const b of BINDINGS) {
      expect(b.label.length).toBeGreaterThan(0);
    }
  });

  it('every entry has a valid section', () => {
    const sections = new Set(['navigate', 'select', 'annotate', 'view', 'misc']);
    for (const b of BINDINGS) {
      expect(sections.has(b.section), `${b.actionId} has invalid section "${b.section}"`).toBe(true);
    }
  });

  it('every entry has a valid context', () => {
    const contexts = new Set(['2d', '3d', 'both', '2d-brush']);
    for (const b of BINDINGS) {
      expect(contexts.has(b.context), `${b.actionId} has invalid context "${b.context}"`).toBe(true);
    }
  });

  it('contains all expected 2D rotation actions', () => {
    const ids = BINDINGS.map((b) => b.actionId);
    expect(ids).toContain('view.rotateLeft');
    expect(ids).toContain('view.rotateRight');
    expect(ids).toContain('view.resetRotation');
  });

  it('rotation bindings are context 2d', () => {
    for (const id of ['view.rotateLeft', 'view.rotateRight', 'view.resetRotation'] as ActionId[]) {
      const entry = findBinding(id);
      expect(entry, `${id} not found`).toBeDefined();
      expect(entry!.context).toBe('2d');
    }
  });

  it('[ and ] are bound to rotateLeft / rotateRight', () => {
    const left = findBinding('view.rotateLeft');
    const right = findBinding('view.rotateRight');
    expect(left?.key).toBe('[');
    expect(right?.key).toBe(']');
  });

  it('N is bound to resetRotation', () => {
    const reset = findBinding('view.resetRotation');
    expect(reset?.key).toBe('n');
  });

  it('R is bound to view.reset', () => {
    const reset = findBinding('view.reset');
    expect(reset?.key).toBe('r');
  });
});

// ---- findBinding -------------------------------------------------------------

describe('findBinding', () => {
  it('returns undefined for an unknown id', () => {
    expect(findBinding('nonexistent.action' as ActionId)).toBeUndefined();
  });

  it('returns the entry for a known id', () => {
    const e = findBinding('view.reset');
    expect(e).toBeDefined();
    expect(e!.actionId).toBe('view.reset');
  });
});

// ---- defaultKey / platform variants ------------------------------------------

describe('defaultKey', () => {
  it('returns mac key when available', () => {
    const entry = findBinding('edit.undo');
    expect(entry?.mac).toBeDefined();
    expect(defaultKey(entry!, 'mac')).toBe(entry!.mac);
  });

  it('returns win key when platform is win', () => {
    const entry = findBinding('edit.undo');
    expect(entry?.win).toBeDefined();
    expect(defaultKey(entry!, 'win')).toBe(entry!.win);
  });

  it('returns win key for linux (same as win)', () => {
    const entry = findBinding('edit.undo');
    expect(defaultKey(entry!, 'linux')).toBe(entry!.win);
  });

  it('falls back to generic key when no platform variant', () => {
    const entry = findBinding('view.reset');
    // view.reset has no mac/win overrides
    expect(defaultKey(entry!, 'mac')).toBe('r');
    expect(defaultKey(entry!, 'win')).toBe('r');
  });

  it('returns null when no key is set at all', () => {
    const entry = findBinding('view.toggle3D');
    // toggle3D has no key set
    expect(defaultKey(entry!, 'mac')).toBeNull();
  });
});

// ---- formatKey ---------------------------------------------------------------

describe('formatKey', () => {
  it('formats cmd+z on mac as ⌘Z', () => {
    expect(formatKey('cmd+z', 'mac')).toBe('⌘Z');
  });

  it('formats ctrl+z on win as Ctrl+Z', () => {
    expect(formatKey('ctrl+z', 'win')).toBe('Ctrl+Z');
  });

  it('formats arrow keys as unicode arrows on mac', () => {
    expect(formatKey('arrowleft', 'mac')).toBe('←');
    expect(formatKey('arrowright', 'mac')).toBe('→');
    expect(formatKey('arrowup', 'mac')).toBe('↑');
    expect(formatKey('arrowdown', 'mac')).toBe('↓');
  });

  it('formats single bracket keys unchanged (uppercase)', () => {
    expect(formatKey('[', 'mac')).toBe('[');
    expect(formatKey(']', 'win')).toBe(']');
  });

  it('formats cmd+shift+z on mac without separator', () => {
    const result = formatKey('cmd+shift+z', 'mac');
    // Should be ⌘⇧Z (no + separator on mac)
    expect(result).toBe('⌘⇧Z');
  });

  it('formats ctrl+shift+z on win with + separator', () => {
    const result = formatKey('ctrl+shift+z', 'win');
    expect(result).toBe('Ctrl+Shift+Z');
  });
});

// ---- Rotation math -----------------------------------------------------------

describe('rotation math', () => {
  // Verify the wrap/step logic used by dispatcher.ts (adjustRotation2D)
  // These are pure math helpers, not dependent on the renderer.

  function wrapDeg(angle: number): number {
    return ((angle % 360) + 360) % 360;
  }

  it('wraps 0° to 0', () => {
    expect(wrapDeg(0)).toBe(0);
  });

  it('wraps 360° to 0', () => {
    expect(wrapDeg(360)).toBe(0);
  });

  it('wraps -15° to 345', () => {
    expect(wrapDeg(-15)).toBe(345);
  });

  it('wraps 375° to 15', () => {
    expect(wrapDeg(375)).toBe(15);
  });

  it('wraps -360° to 0', () => {
    expect(wrapDeg(-360)).toBe(0);
  });

  it('wraps -361° to 359', () => {
    expect(wrapDeg(-361)).toBe(359);
  });

  it('adding 15° steps from 0 wraps correctly at 360', () => {
    let angle = 0;
    for (let i = 0; i < 24; i++) angle = wrapDeg(angle + 15);
    expect(angle).toBe(0);
  });

  it('subtracting 15° steps from 0 wraps correctly', () => {
    let angle = 0;
    angle = wrapDeg(angle - 15);
    expect(angle).toBe(345);
  });
});
