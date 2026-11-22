/**
 * Unit tests for grid mode (C1, item 4):
 *   - gridViewRects() layout geometry
 *   - panelCount()
 *   - createGridState() / setGridLayout()
 *   - buildPanelColors() per-panel state
 *   - panelTitle()
 *   - gridLayerFilter() from gridViews.ts
 *   - viewportIdToPanel() from gridViews.ts
 */

import { describe, expect, it } from 'vitest';
import {
  gridViewRects,
  panelCount,
  createGridState,
  setGridLayout,
  buildPanelColors,
  panelTitle,
  type GridLayout,
  type GridColorCache,
} from '../src/webview/atlas/grid';
import { gridLayerFilter, viewportIdToPanel } from '../src/webview/render/gridViews';

// ---------------------------------------------------------------------------
// panelCount
// ---------------------------------------------------------------------------

describe('panelCount', () => {
  it('1x2 → 2', () => expect(panelCount('1x2')).toBe(2));
  it('2x2 → 4', () => expect(panelCount('2x2')).toBe(4));
  it('2x3 → 6', () => expect(panelCount('2x3')).toBe(6));
  it('3x3 → 9', () => expect(panelCount('3x3')).toBe(9));
});

// ---------------------------------------------------------------------------
// gridViewRects
// ---------------------------------------------------------------------------

describe('gridViewRects', () => {
  it('1x2: two panels side by side', () => {
    const rects = gridViewRects('1x2', 800, 600);
    expect(rects).toHaveLength(2);
    expect(rects[0]).toEqual({ x: 0, y: 0, w: 400, h: 600 });
    expect(rects[1]).toEqual({ x: 400, y: 0, w: 400, h: 600 });
  });

  it('2x2: four panels in 2 × 2 grid', () => {
    const rects = gridViewRects('2x2', 800, 600);
    expect(rects).toHaveLength(4);
    // Top row
    expect(rects[0]).toEqual({ x: 0, y: 0, w: 400, h: 300 });
    expect(rects[1]).toEqual({ x: 400, y: 0, w: 400, h: 300 });
    // Bottom row
    expect(rects[2]).toEqual({ x: 0, y: 300, w: 400, h: 300 });
    expect(rects[3]).toEqual({ x: 400, y: 300, w: 400, h: 300 });
  });

  it('2x3: six panels, 3 cols × 2 rows', () => {
    const rects = gridViewRects('2x3', 600, 900);
    expect(rects).toHaveLength(6);
    // cols=3, rows=2 → panelW=200, panelH=450
    expect(rects[0]).toEqual({ x: 0, y: 0, w: 200, h: 450 });
    expect(rects[5]).toEqual({ x: 400, y: 450, w: 200, h: 450 });
  });

  it('3x3: nine panels', () => {
    const rects = gridViewRects('3x3', 900, 900);
    expect(rects).toHaveLength(9);
    // Each panel: 300 × 300
    expect(rects[0]).toEqual({ x: 0, y: 0, w: 300, h: 300 });
    expect(rects[8]).toEqual({ x: 600, y: 600, w: 300, h: 300 });
  });

  it('panels are ordered left-to-right, top-to-bottom', () => {
    const rects = gridViewRects('2x2', 400, 200);
    const xs = rects.map((r) => r.x);
    const ys = rects.map((r) => r.y);
    expect(xs).toEqual([0, 200, 0, 200]);
    expect(ys).toEqual([0, 0, 100, 100]);
  });

  it('total area equals canvas area (integer widths)', () => {
    // Use dimensions divisible by panel count to avoid rounding.
    const rects = gridViewRects('2x2', 400, 400);
    const totalArea = rects.reduce((s, r) => s + r.w * r.h, 0);
    expect(totalArea).toBe(400 * 400);
  });
});

// ---------------------------------------------------------------------------
// createGridState / setGridLayout
// ---------------------------------------------------------------------------

describe('createGridState', () => {
  it('creates disabled state with correct panel count', () => {
    const s = createGridState('2x2');
    expect(s.enabled).toBe(false);
    expect(s.layout).toBe('2x2');
    expect(s.panels).toHaveLength(4);
    expect(s.panels.every((p) => p.colorColumn === null && p.title === null)).toBe(true);
  });

  it('defaults to 2×2 when layout omitted', () => {
    expect(createGridState().layout).toBe('2x2');
    expect(createGridState().panels).toHaveLength(4);
  });

  it('1×2 creates 2 panels', () => {
    expect(createGridState('1x2').panels).toHaveLength(2);
  });

  it('3×3 creates 9 panels', () => {
    expect(createGridState('3x3').panels).toHaveLength(9);
  });
});

describe('setGridLayout', () => {
  it('expanding layout fills new panels with defaults', () => {
    const s = createGridState('1x2');
    s.panels[0].colorColumn = 3;
    const s2 = setGridLayout(s, '2x2');
    expect(s2.panels).toHaveLength(4);
    expect(s2.panels[0].colorColumn).toBe(3); // preserved
    expect(s2.panels[2].colorColumn).toBeNull(); // new
  });

  it('shrinking layout drops extra panels', () => {
    const s = createGridState('3x3'); // 9 panels
    const s2 = setGridLayout(s, '1x2'); // 2 panels
    expect(s2.panels).toHaveLength(2);
  });

  it('returns a new object (immutable)', () => {
    const s = createGridState('2x2');
    const s2 = setGridLayout(s, '2x3');
    expect(s2).not.toBe(s);
    expect(s2.layout).toBe('2x3');
    expect(s.layout).toBe('2x2'); // original unchanged
  });
});

// ---------------------------------------------------------------------------
// buildPanelColors
// ---------------------------------------------------------------------------

describe('buildPanelColors', () => {
  const makeColors = (n: number, fill = 128) => new Uint8Array(n * 4).fill(fill);

  it('null colorColumn → mainColors fallback', () => {
    const state = createGridState('1x2');
    const main = makeColors(10, 100);
    const cache: GridColorCache = new Map();
    const result = buildPanelColors(state, main, cache);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(main);
    expect(result[1]).toBe(main);
  });

  it('panel with cached colorColumn → cached array', () => {
    const state = createGridState('1x2');
    state.panels[0].colorColumn = 2;
    const main = makeColors(10, 100);
    const col2Colors = makeColors(10, 200);
    const cache: GridColorCache = new Map([[2, col2Colors]]);
    const result = buildPanelColors(state, main, cache);
    expect(result[0]).toBe(col2Colors);
    expect(result[1]).toBe(main); // second panel uses main
  });

  it('panel with uncached colorColumn → mainColors fallback', () => {
    const state = createGridState('1x2');
    state.panels[1].colorColumn = 5; // not in cache
    const main = makeColors(10, 100);
    const cache: GridColorCache = new Map();
    const result = buildPanelColors(state, main, cache);
    expect(result[1]).toBe(main); // falls back to main
  });

  it('null mainColors returns null for uncached panels', () => {
    const state = createGridState('2x2');
    state.panels[0].colorColumn = 7; // not in cache
    const cache: GridColorCache = new Map();
    const result = buildPanelColors(state, null, cache);
    expect(result[0]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// panelTitle
// ---------------------------------------------------------------------------

describe('panelTitle', () => {
  const cols = [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }];

  it('returns panel.title when set', () => {
    expect(panelTitle({ colorColumn: 1, title: 'My title' }, 0, null, cols)).toBe('My title');
  });

  it('returns column name from panel.colorColumn', () => {
    expect(panelTitle({ colorColumn: 2, title: null }, 0, null, cols)).toBe('gamma');
  });

  it('falls back to main colorColumn when panel.colorColumn is null', () => {
    expect(panelTitle({ colorColumn: null, title: null }, 0, 1, cols)).toBe('beta');
  });

  it('falls back to "Panel N" when no column known', () => {
    expect(panelTitle({ colorColumn: null, title: null }, 2, null, cols)).toBe('Panel 3');
  });

  it('uses 1-based index in fallback label', () => {
    expect(panelTitle({ colorColumn: null, title: null }, 0, null, cols)).toBe('Panel 1');
  });
});

// ---------------------------------------------------------------------------
// gridLayerFilter
// ---------------------------------------------------------------------------

describe('gridLayerFilter', () => {
  it('panel-specific layer renders in its own view', () => {
    expect(gridLayerFilter({ layer: { id: 'g0-points' }, viewport: { id: 'panel-0' } })).toBe(true);
    expect(gridLayerFilter({ layer: { id: 'g3-points' }, viewport: { id: 'panel-3' } })).toBe(true);
  });

  it('panel-specific layer is filtered out of other views', () => {
    expect(gridLayerFilter({ layer: { id: 'g0-points' }, viewport: { id: 'panel-1' } })).toBe(false);
    expect(gridLayerFilter({ layer: { id: 'g2-labels' }, viewport: { id: 'panel-0' } })).toBe(false);
  });

  it('shared layers (no gN- prefix) render in every view', () => {
    expect(gridLayerFilter({ layer: { id: 'hover-ring' }, viewport: { id: 'panel-0' } })).toBe(true);
    expect(gridLayerFilter({ layer: { id: 'annotations' }, viewport: { id: 'panel-2' } })).toBe(true);
  });

  it('layer without gN- prefix is not restricted even if viewport is numbered', () => {
    expect(gridLayerFilter({ layer: { id: 'density-layer' }, viewport: { id: 'panel-99' } })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// viewportIdToPanel
// ---------------------------------------------------------------------------

describe('viewportIdToPanel', () => {
  it('parses panel-0 → 0', () => expect(viewportIdToPanel('panel-0')).toBe(0));
  it('parses panel-8 → 8', () => expect(viewportIdToPanel('panel-8')).toBe(8));
  it('returns -1 for orbit viewport', () => expect(viewportIdToPanel('orbit')).toBe(-1));
  it('returns -1 for empty string', () => expect(viewportIdToPanel('')).toBe(-1));
  it('returns -1 for partial match', () => expect(viewportIdToPanel('panel-')).toBe(-1));
});
