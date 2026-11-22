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
  deckLayerDescriptors,
  htmlOverlayZIndex,
  DECK_LAYER_IDS,
  HTML_LAYER_IDS,
} from '../src/webview/atlas/layers';
import type { LayerState } from '../src/webview/atlas/layers';

describe('createInitialLayers', () => {
  it('returns all built-in layers', () => {
    const layers = createInitialLayers();
    expect(layers.length).toBeGreaterThanOrEqual(6);
    // base layer is first by order
    const sorted = [...layers].sort((a, b) => a.order - b.order);
    expect(sorted[0].id).toBe('base');
    expect(sorted[0].kind).toBe('base');
  });

  it('includes all expected overlay layers', () => {
    const layers = createInitialLayers();
    const ids = new Set(layers.map((l) => l.id));
    expect(ids.has('base')).toBe(true);
    expect(ids.has('outlines')).toBe(true);
    expect(ids.has('labels')).toBe(true);
    expect(ids.has('glow')).toBe(true);
    expect(ids.has('annotations')).toBe(true);
    expect(ids.has('around-labels')).toBe(true);
  });

  it('defaults all layers to visible, opacity 1, normal blending', () => {
    for (const layer of createInitialLayers()) {
      expect(layer.visible).toBe(true);
      expect(layer.opacity).toBe(1);
      expect(layer.blending).toBe('normal');
    }
  });

  it('base layer has order 0', () => {
    const layers = createInitialLayers();
    expect(getLayer(layers, 'base')?.order).toBe(0);
  });
});

describe('getLayer', () => {
  it('finds an existing layer by id', () => {
    const layers = createInitialLayers();
    expect(getLayer(layers, 'base')).toBeDefined();
    expect(getLayer(layers, 'base')?.id).toBe('base');
    expect(getLayer(layers, 'outlines')?.id).toBe('outlines');
    expect(getLayer(layers, 'glow')?.id).toBe('glow');
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
    const baseAfter = getLayer(after, 'base')!;
    expect(baseAfter.visible).toBe(false);
    expect(baseAfter.opacity).toBe(0.5);
    // Original is unchanged.
    expect(getLayer(before, 'base')!.visible).toBe(true);
  });

  it('leaves unrelated layers unchanged', () => {
    const before = createInitialLayers();
    const outlinesIndex = before.findIndex((l) => l.id === 'outlines');
    const after = updateLayer(before, 'base', { blending: 'additive' });
    expect(getLayer(after, 'base')?.blending).toBe('additive');
    expect(after[outlinesIndex]).toEqual(before[outlinesIndex]); // unchanged
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
    const base = getLayer(layers, 'base')!;
    expect(base.visible).toBe(false);
    expect(base.opacity).toBe(0.6);
    expect(base.blending).toBe('additive');
  });

  it('restores overlay layer overrides', () => {
    const saved: LayerState[] = [{ id: 'outlines', kind: 'overlay-frame', name: 'Cluster outlines', visible: false, opacity: 0.5, blending: 'normal', order: 10 }];
    const layers = restoreLayers(saved);
    const outlines = getLayer(layers, 'outlines')!;
    expect(outlines.visible).toBe(false);
    expect(outlines.opacity).toBe(0.5);
    // base layer is unaffected and defaults apply
    expect(getLayer(layers, 'base')!.visible).toBe(true);
  });

  it('clamps opacity to [0, 1]', () => {
    const saved: LayerState[] = [{ id: 'base', kind: 'base', name: 'Base map', visible: true, opacity: 2, blending: 'normal', order: 0 }];
    expect(restoreLayers(saved).find((l) => l.id === 'base')!.opacity).toBe(1);
    const saved2: LayerState[] = [{ id: 'base', kind: 'base', name: 'Base map', visible: true, opacity: -1, blending: 'normal', order: 0 }];
    expect(restoreLayers(saved2).find((l) => l.id === 'base')!.opacity).toBe(0);
  });

  it('ignores saved entries for unknown ids', () => {
    const saved: LayerState[] = [{ id: 'unknown-layer', kind: 'overlay-frame', name: 'Unknown', visible: false, opacity: 0.5, blending: 'normal', order: 0 }];
    // Should still have all default layers, with their defaults.
    const layers = restoreLayers(saved);
    expect(layers).toEqual(createInitialLayers());
  });

  it('defaults blending to normal for unrecognised values', () => {
    const saved = [{ id: 'base', kind: 'base', name: 'Base map', visible: true, opacity: 1, blending: 'unknown-mode', order: 0 }] as any;
    expect(restoreLayers(saved).find((l) => l.id === 'base')!.blending).toBe('normal');
  });

  it('restores layer order overrides', () => {
    // Simulate a user who reordered labels to come before outlines (order 5 instead of 20)
    const saved: LayerState[] = [{ id: 'labels', kind: 'overlay-frame', name: 'Labels', visible: true, opacity: 1, blending: 'normal', order: 5 }];
    const layers = restoreLayers(saved);
    const labels = getLayer(layers, 'labels')!;
    expect(labels.order).toBe(5);
  });
});

describe('deckLayerDescriptors', () => {
  it('returns only deck.gl layers sorted by order', () => {
    const layers = createInitialLayers();
    const descs = deckLayerDescriptors(layers);
    // B2 adds 'boxes' (order 15) and 'data-box' (order 5); B5 adds 'leader-lines' (order 35).
    expect(descs.map((d) => d.id)).toEqual(['base', 'data-box', 'outlines', 'boxes', 'labels', 'leader-lines']);
    // All deck.gl ids are in DECK_LAYER_IDS
    for (const d of descs) expect(DECK_LAYER_IDS.has(d.id)).toBe(true);
  });

  it('excludes HTML overlay layers', () => {
    const layers = createInitialLayers();
    const descs = deckLayerDescriptors(layers);
    for (const d of descs) expect(HTML_LAYER_IDS.has(d.id)).toBe(false);
  });

  it('reflects visibility and opacity changes', () => {
    const layers = updateLayer(createInitialLayers(), 'outlines', { visible: false, opacity: 0.5 });
    const descs = deckLayerDescriptors(layers);
    const outlines = descs.find((d) => d.id === 'outlines')!;
    expect(outlines.visible).toBe(false);
    expect(outlines.opacity).toBe(0.5);
  });

  it('respects reordered layers', () => {
    // Move labels before outlines (and before data-box which sits at order 5).
    // Use order 3 to avoid tie with data-box.
    let layers = createInitialLayers();
    layers = updateLayer(layers, 'labels', { order: 3 });
    const descs = deckLayerDescriptors(layers);
    expect(descs[0].id).toBe('base');      // base at 0
    expect(descs[1].id).toBe('labels');    // labels now at 3, before data-box (5)
    expect(descs[2].id).toBe('data-box'); // data-box at 5
    expect(descs[3].id).toBe('outlines'); // outlines at 10
  });
});

describe('htmlOverlayZIndex', () => {
  it('returns increasing z-indices for HTML layers sorted by order', () => {
    const layers = createInitialLayers();
    const glowZ = htmlOverlayZIndex(layers, 'glow');
    const annotationsZ = htmlOverlayZIndex(layers, 'annotations');
    const aroundZ = htmlOverlayZIndex(layers, 'around-labels');
    expect(glowZ).toBeLessThan(annotationsZ);
    expect(annotationsZ).toBeLessThan(aroundZ);
  });

  it('uses base z-index 20 by default', () => {
    const layers = createInitialLayers();
    const glowZ = htmlOverlayZIndex(layers, 'glow'); // first HTML layer
    expect(glowZ).toBe(20);
  });

  it('returns baseZ for unknown id', () => {
    const layers = createInitialLayers();
    expect(htmlOverlayZIndex(layers, 'unknown-html', 20)).toBe(20);
  });

  it('respects reordering of HTML layers', () => {
    let layers = createInitialLayers();
    // Move annotations before glow
    layers = updateLayer(layers, 'annotations', { order: 25 }); // glow=30, annotations now 25 < glow 30
    const glowZ = htmlOverlayZIndex(layers, 'glow');
    const annotationsZ = htmlOverlayZIndex(layers, 'annotations');
    // annotations has lower order, so it gets lower z-index
    expect(annotationsZ).toBeLessThan(glowZ);
  });
});
