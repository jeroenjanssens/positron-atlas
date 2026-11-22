/**
 * Unit tests for the A2 layer model (src/webview/atlas/layers.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  createInitialLayers,
  getLayer,
  updateLayer,
  reorderLayer,
  restoreLayers,
} from '../src/webview/atlas/layers';
import type { LayerState } from '../src/webview/atlas/layers';

describe('createInitialLayers', () => {
  it('returns a single base layer', () => {
    const layers = createInitialLayers();
    expect(layers).toHaveLength(1);
    expect(layers[0].id).toBe('base');
    expect(layers[0].kind).toBe('base');
  });

  it('defaults to visible, opacity 1, normal blending', () => {
    const [base] = createInitialLayers();
    expect(base.visible).toBe(true);
    expect(base.opacity).toBe(1);
    expect(base.blending).toBe('normal');
    expect(base.order).toBe(0);
  });
});

describe('getLayer', () => {
  it('finds an existing layer by id', () => {
    const layers = createInitialLayers();
    expect(getLayer(layers, 'base')).toBeDefined();
    expect(getLayer(layers, 'base')?.id).toBe('base');
  });

  it('returns undefined for an unknown id', () => {
    const layers = createInitialLayers();
    expect(getLayer(layers, 'unknown')).toBeUndefined();
  });
});

describe('updateLayer', () => {
  it('patches a matching layer immutably', () => {
    const before = createInitialLayers();
    const after = updateLayer(before, 'base', { visible: false, opacity: 0.5 });
    expect(after[0].visible).toBe(false);
    expect(after[0].opacity).toBe(0.5);
    // Original is unchanged.
    expect(before[0].visible).toBe(true);
  });

  it('leaves unrelated layers unchanged', () => {
    const extra: LayerState = { id: 'overlay', kind: 'overlay-frame', name: 'Overlay', visible: true, opacity: 1, blending: 'normal', order: 1 };
    const before = [...createInitialLayers(), extra];
    const after = updateLayer(before, 'base', { blending: 'additive' });
    expect(after[0].blending).toBe('additive');
    expect(after[1]).toEqual(extra); // unchanged
  });

  it('is a no-op for an unknown id', () => {
    const before = createInitialLayers();
    const after = updateLayer(before, 'does-not-exist', { visible: false });
    expect(after).toEqual(before);
  });
});

describe('reorderLayer', () => {
  it('moves a layer to the specified position and re-assigns order values', () => {
    const a: LayerState = { id: 'a', kind: 'base', name: 'A', visible: true, opacity: 1, blending: 'normal', order: 0 };
    const b: LayerState = { id: 'b', kind: 'overlay-frame', name: 'B', visible: true, opacity: 1, blending: 'normal', order: 1 };
    const c: LayerState = { id: 'c', kind: 'overlay-frame', name: 'C', visible: true, opacity: 1, blending: 'normal', order: 2 };
    const result = reorderLayer([a, b, c], 'c', 0);
    // Sorted by new order: c, a, b
    const sorted = [...result].sort((x, y) => x.order - y.order);
    expect(sorted[0].id).toBe('c');
    expect(sorted[1].id).toBe('a');
    expect(sorted[2].id).toBe('b');
    // Order values are 0,1,2
    expect(sorted.map((l) => l.order)).toEqual([0, 1, 2]);
  });

  it('is a no-op when moving to the same position', () => {
    const layers = createInitialLayers();
    const result = reorderLayer(layers, 'base', 0);
    expect(result).toEqual(layers);
  });

  it('is a no-op for an unknown id', () => {
    const layers = createInitialLayers();
    const result = reorderLayer(layers, 'unknown', 0);
    expect(result).toEqual(layers);
  });
});

describe('restoreLayers', () => {
  it('returns defaults when saved is undefined', () => {
    const layers = restoreLayers(undefined);
    expect(layers).toEqual(createInitialLayers());
  });

  it('returns defaults when saved is empty array', () => {
    const layers = restoreLayers([]);
    expect(layers).toEqual(createInitialLayers());
  });

  it('applies saved visibility', () => {
    const saved: LayerState[] = [{ id: 'base', kind: 'base', name: 'Base map', visible: false, opacity: 0.6, blending: 'additive', order: 0 }];
    const layers = restoreLayers(saved);
    expect(layers[0].visible).toBe(false);
    expect(layers[0].opacity).toBe(0.6);
    expect(layers[0].blending).toBe('additive');
  });

  it('clamps opacity to [0, 1]', () => {
    const saved: LayerState[] = [{ id: 'base', kind: 'base', name: 'Base map', visible: true, opacity: 2, blending: 'normal', order: 0 }];
    expect(restoreLayers(saved)[0].opacity).toBe(1);
    const saved2: LayerState[] = [{ id: 'base', kind: 'base', name: 'Base map', visible: true, opacity: -1, blending: 'normal', order: 0 }];
    expect(restoreLayers(saved2)[0].opacity).toBe(0);
  });

  it('ignores saved entries for unknown ids', () => {
    const saved: LayerState[] = [{ id: 'unknown-layer', kind: 'overlay-frame', name: 'Unknown', visible: false, opacity: 0.5, blending: 'normal', order: 0 }];
    // Should still have the default base layer.
    const layers = restoreLayers(saved);
    expect(layers).toEqual(createInitialLayers());
  });

  it('defaults blending to normal for unrecognised values', () => {
    const saved = [{ id: 'base', kind: 'base', name: 'Base map', visible: true, opacity: 1, blending: 'unknown-mode', order: 0 }] as any;
    expect(restoreLayers(saved)[0].blending).toBe('normal');
  });
});
