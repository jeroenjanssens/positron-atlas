/**
 * Layer model (A2): point-layer abstraction and overlay registry.
 *
 * Point layers hold positions, colours and radii (the base map is one point layer).
 * Overlay layers (outlines, labels, shapes, boxes, …) are registered here with an id,
 * name, visibility, opacity, blending and draw order so the renderer and HTML components
 * can respect them.
 *
 * Layer ids and their rendering zone:
 *   'base'          – ScatterplotLayers inside deck.gl (always first by default)
 *   'outlines'      – PolygonLayer inside deck.gl (cluster boundary rings)
 *   'labels'        – TextLayers inside deck.gl (cluster / column labels + badges)
 *   'glow'          – HTML canvas overlay (A12 blurred halo, z-index ~20)
 *   'leader-lines'  – deck.gl LineLayer in map space (callout leaders, B5, orbits correctly in 3D)
 *   'annotations'   – HTML overlay (callout boxes, A4, z-index ~21)
 *   'around-labels' – HTML overlay (labels ring + leaders, A11, z-index ~22)
 *
 * System layers (not persisted, always rendered, non-reorderable):
 *   hover/pin ring  – always last in the deck.gl layer array
 *   search highlight – rendered as an extra pass within the base ScatterplotLayers
 *
 * Justification for system status:
 *   The hover/pin ring must be on top of everything so it is always visible; allowing
 *   users to draw it behind points or labels would make it disappear. The search
 *   highlight re-colours the base point set and therefore cannot be detached from it.
 */

export type LayerKind = 'base' | 'overlay-frame' | 'point-overlay';
export type LayerBlending = 'normal' | 'additive';

/** Persistent state for a point or overlay layer.  Serialised into PanelState. */
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
  /** B3: Python variable name the overlay was loaded from. */
  sourceName?: string;
  /** B3 / Item 9: symbol code for point-overlay layers (0 = circle, 1–7 = other shapes). */
  symbol?: number;
}

// ---------------------------------------------------------------------------
// Well-known layer ids and their rendering zones
// ---------------------------------------------------------------------------

/** Layer ids that are rendered as deck.gl layers (WebGL canvas). */
export const DECK_LAYER_IDS = new Set(['base', 'outlines', 'labels', 'leader-lines', 'boxes', 'data-box']);

/** Layer ids that are rendered as HTML canvas/SVG overlays. */
export const HTML_LAYER_IDS = new Set(['glow', 'annotations', 'around-labels']);

// ---------------------------------------------------------------------------
// Helpers for the layer list
// ---------------------------------------------------------------------------

/** Returns the initial layer list (base map + all built-in overlay layers). */
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
    {
      id: 'outlines',
      kind: 'overlay-frame',
      name: 'Cluster outlines',
      visible: true,
      opacity: 1,
      blending: 'normal',
      order: 10,
    },
    {
      id: 'labels',
      kind: 'overlay-frame',
      name: 'Labels',
      visible: true,
      opacity: 1,
      blending: 'normal',
      order: 20,
    },
    {
      id: 'glow',
      kind: 'overlay-frame',
      name: 'Glow',
      visible: true,
      opacity: 1,
      blending: 'normal',
      order: 30,
    },
    {
      id: 'leader-lines',
      kind: 'overlay-frame',
      name: 'Leader lines',
      visible: true,
      opacity: 1,
      blending: 'normal',
      order: 35,
    },
    {
      id: 'annotations',
      kind: 'overlay-frame',
      name: 'Annotations',
      visible: true,
      opacity: 1,
      blending: 'normal',
      order: 40,
    },
    {
      id: 'around-labels',
      kind: 'overlay-frame',
      name: 'Around-map labels',
      visible: true,
      opacity: 1,
      blending: 'normal',
      order: 50,
    },
    {
      id: 'boxes',
      kind: 'overlay-frame',
      name: 'Group boxes',
      visible: true,
      opacity: 1,
      blending: 'normal',
      order: 15, // between outlines (10) and labels (20)
    },
    {
      id: 'data-box',
      kind: 'overlay-frame',
      name: '3D data box / grid / gizmo',
      visible: true,
      opacity: 1,
      blending: 'normal',
      order: 5, // behind everything else
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

/** Remove a layer by id. No-op when id is not found. */
export function removeLayer(layers: LayerState[], id: string): LayerState[] {
  return layers.filter((l) => l.id !== id);
}

/** Add a new point-overlay layer at the top of the stack (highest order). */
export function addOverlayLayer(layers: LayerState[], id: string, name: string, sourceName: string, symbol?: number): LayerState[] {
  const maxOrder = layers.reduce((m, l) => Math.max(m, l.order), 0);
  const layer: LayerState = {
    id,
    kind: 'point-overlay',
    name,
    visible: true,
    opacity: 1,
    blending: 'normal',
    order: maxOrder + 10,
    sourceName,
    symbol,
  };
  return [...layers, layer];
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
  const restored = defaults.map((d) => {
    const s = savedMap.get(d.id);
    if (!s) return d;
    return {
      ...d,
      visible: typeof s.visible === 'boolean' ? s.visible : d.visible,
      opacity: typeof s.opacity === 'number' ? Math.max(0, Math.min(1, s.opacity)) : d.opacity,
      blending: (s.blending === 'additive' ? 'additive' : 'normal') as LayerBlending,
      order: typeof s.order === 'number' ? s.order : d.order,
    };
  });
  // B3: re-attach persisted point-overlay layers (not in defaults; added dynamically).
  for (const s of saved) {
    if (s.kind === 'point-overlay' && typeof s.id === 'string' && s.id.length > 0) {
      restored.push({
        id: s.id,
        kind: 'point-overlay',
        name: typeof s.name === 'string' ? s.name : s.id,
        visible: typeof s.visible === 'boolean' ? s.visible : true,
        opacity: typeof s.opacity === 'number' ? Math.max(0, Math.min(1, s.opacity)) : 1,
        blending: (s.blending === 'additive' ? 'additive' : 'normal') as LayerBlending,
        order: typeof s.order === 'number' ? s.order : 100,
        sourceName: typeof s.sourceName === 'string' ? s.sourceName : undefined,
        symbol: typeof s.symbol === 'number' ? s.symbol : undefined,
      });
    }
  }
  return restored;
}

// ---------------------------------------------------------------------------
// Renderer helpers
// ---------------------------------------------------------------------------

/**
 * Sorted overlay descriptors for the deck.gl renderer.
 * Only includes layers whose id is in DECK_LAYER_IDS, sorted by order.
 */
export function deckLayerDescriptors(
  layers: LayerState[],
): { id: string; visible: boolean; opacity: number }[] {
  return [...layers]
    .filter((l) => DECK_LAYER_IDS.has(l.id))
    .sort((a, b) => a.order - b.order)
    .map((l) => ({ id: l.id, visible: l.visible, opacity: l.opacity }));
}

/**
 * Compute the CSS z-index for an HTML overlay layer.
 * Layers are ranked within the HTML_LAYER_IDS set only; the base z-index is 20
 * so they don't conflict with deck.gl (auto/0) or other fixed elements.
 *
 * @param baseZ Base z-index (default 20). Adjacent HTML overlays get baseZ, baseZ+1, …
 */
export function htmlOverlayZIndex(layers: LayerState[], id: string, baseZ = 20): number {
  const sorted = [...layers]
    .filter((l) => HTML_LAYER_IDS.has(l.id))
    .sort((a, b) => a.order - b.order);
  const idx = sorted.findIndex((l) => l.id === id);
  return baseZ + (idx < 0 ? 0 : idx);
}
