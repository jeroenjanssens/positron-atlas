/**
 * Layer model (A2): point-layer abstraction and overlay registry.
 *
 * Point layers hold positions, colours and radii (the base map is one point layer).
 * Overlay layers (outlines, labels, shapes, boxes, …) register through a lightweight
 * descriptor so they appear in the Layers list and can be reordered without touching
 * renderer.ts.  B3 will add overlay-frame layers here.
 */

export type LayerKind = 'base' | 'overlay-frame';
export type LayerBlending = 'normal' | 'additive';

/** Persistent state for a point layer.  Serialised into PanelState. */
export interface LayerState {
  id: string;
  kind: LayerKind;
  name: string;
  visible: boolean;
  /** Opacity multiplier (0–1) applied on top of the global point-opacity setting. */
  opacity: number;
  blending: LayerBlending;
  /** Draw order: lower = drawn first (behind). */
  order: number;
}

/** Lightweight registry entry for a non-point overlay layer.
 *  Stored only in memory; visibility is wired to the controlling atlas state field. */
export interface OverlayLayerDescriptor {
  id: string;
  name: string;
  visible: boolean;
  order: number;
}

// ---------------------------------------------------------------------------
// Helpers for the point-layer list
// ---------------------------------------------------------------------------

/** Returns the initial layer list (just the base map layer). */
export function createInitialLayers(): LayerState[] {
  return [
    {
      id: 'base',
      kind: 'base',
      name: 'Base map',
      visible: true,
      opacity: 1,
      blending: 'normal',
      order: 0,
    },
  ];
}

/** Look up a layer by id. */
export function getLayer(layers: LayerState[], id: string): LayerState | undefined {
  return layers.find((l) => l.id === id);
}

/** Return a new array with one layer patched. */
export function updateLayer(layers: LayerState[], id: string, patch: Partial<LayerState>): LayerState[] {
  return layers.map((l) => (l.id === id ? { ...l, ...patch } : l));
}

/**
 * Reorder layers by moving `id` to `newIndex` in the sorted array.
 * Returns a new array sorted by order, with order values re-assigned as 0,1,2…
 */
export function reorderLayer(layers: LayerState[], id: string, newIndex: number): LayerState[] {
  const sorted = [...layers].sort((a, b) => a.order - b.order);
  const idx = sorted.findIndex((l) => l.id === id);
  if (idx < 0 || newIndex === idx) return layers;
  const [moved] = sorted.splice(idx, 1);
  sorted.splice(newIndex, 0, moved);
  return sorted.map((l, i) => ({ ...l, order: i }));
}

/** Restore layers from persisted PanelState; falls back to defaults gracefully. */
export function restoreLayers(saved: LayerState[] | undefined): LayerState[] {
  const defaults = createInitialLayers();
  if (!Array.isArray(saved) || saved.length === 0) return defaults;
  const savedMap = new Map(saved.map((l) => [l.id, l]));
  // Merge known defaults with saved overrides; unknown ids in saved are dropped.
  return defaults.map((d) => {
    const s = savedMap.get(d.id);
    if (!s) return d;
    return {
      ...d,
      visible: typeof s.visible === 'boolean' ? s.visible : d.visible,
      opacity: typeof s.opacity === 'number' ? Math.max(0, Math.min(1, s.opacity)) : d.opacity,
      blending: s.blending === 'additive' ? 'additive' : 'normal',
      order: typeof s.order === 'number' ? s.order : d.order,
    };
  });
}
