/**
 * Grid mode (small multiples) — C1 (item 4).
 *
 * Provides state types, layout geometry helpers, and per-panel color management.
 * The renderer (ScatterRenderer) handles the actual multi-view deck.gl configuration.
 * Atlas state fields and one-line delegations live in atlas.svelte.ts; logic is here.
 */

import type { Atlas } from '../atlas.svelte';
import { vscode, fetchTyped } from '../vscode';
import type { FileRef, ColorMeta } from '../../shared/protocol';
import { encodeCategorical, encodeConstant, encodeNumeric } from '../color/encode';
import { DEFAULT_POINT_COLOR } from '../color/colormaps';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GridLayout = '1x2' | '2x2' | '2x3' | '3x3';

/** Column selector per panel. `null` means "use the same column as the main view". */
export interface PanelConfig {
  /** Color column index (null = same as main colorColumn). */
  colorColumn: number | null;
  /** Human-readable title shown above the panel. Generated from column name if null. */
  title: string | null;
}

/** Full grid configuration, persisted in PanelState. */
export interface GridState {
  enabled: boolean;
  layout: GridLayout;
  /** One entry per panel; length must match the panel count for `layout`. */
  panels: PanelConfig[];
}

// ---------------------------------------------------------------------------
// Layout geometry
// ---------------------------------------------------------------------------

/**
 * Height reserved at the top of the canvas for the plot toolbar and search box
 * (toolbar 28 px at top:8, search box 28 px at top:44 → bottom at 72 + 4 px gap = 76).
 * Panels start at this y-offset so they never overlap the toolbar/search overlay.
 */
export const GRID_TOP_BAND_PX = 76;

/** [cols, rows] for each layout string. */
const LAYOUT_DIMS: Record<GridLayout, [number, number]> = {
  '1x2': [2, 1],
  '2x2': [2, 2],
  '2x3': [3, 2],
  '3x3': [3, 3],
};

/** Returns the number of panels for a given layout. */
export function panelCount(layout: GridLayout): number {
  const [cols, rows] = LAYOUT_DIMS[layout];
  return cols * rows;
}

/**
 * Returns viewport rects for each panel in a grid layout.
 * Values are in CSS pixels (or logical units), top-left origin, y-down.
 *
 * @param layout   Grid layout string.
 * @param width    Total canvas width in CSS pixels.
 * @param height   Total canvas height in CSS pixels.
 * @param topBand  Pixels reserved at the top for the toolbar and search box (default 0).
 *                 Panels start at y = topBand and divide the remaining (height - topBand) space.
 * @returns Array of `{x, y, w, h}` rects, one per panel, left-to-right, top-to-bottom.
 */
export function gridViewRects(
  layout: GridLayout,
  width: number,
  height: number,
  topBand = 0,
): { x: number; y: number; w: number; h: number }[] {
  const [cols, rows] = LAYOUT_DIMS[layout];
  const panelW = Math.floor(width / cols);
  const panelH = Math.floor((height - topBand) / rows);
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      rects.push({
        x: col * panelW,
        y: topBand + row * panelH,
        w: panelW,
        h: panelH,
      });
    }
  }
  return rects;
}

// ---------------------------------------------------------------------------
// Default state
// ---------------------------------------------------------------------------

/** Create a default GridState for `layout`. */
export function createGridState(layout: GridLayout = '2x2'): GridState {
  const n = panelCount(layout);
  return {
    enabled: false,
    layout,
    panels: Array.from({ length: n }, () => ({ colorColumn: null, title: null })),
  };
}

/**
 * Update the layout, resizing the panels array.
 * Extra panels are dropped; new panels default to the main colorColumn.
 */
export function setGridLayout(state: GridState, layout: GridLayout): GridState {
  const n = panelCount(layout);
  const panels = Array.from({ length: n }, (_, i) => state.panels[i] ?? { colorColumn: null, title: null });
  return { ...state, layout, panels };
}

// ---------------------------------------------------------------------------
// Per-panel color fetching and cache
// ---------------------------------------------------------------------------

/**
 * Per-panel RGBA color cache (non-reactive, managed here).
 * Key: color column index; value: RGBA Uint8Array for all kept rows.
 */
export type GridColorCache = Map<number, Uint8Array>;

/**
 * Request colors for all panel columns that are not yet cached.
 * Sends `{type: 'colors', column}` messages via vscode.post.
 *
 * @param atlas    The Atlas instance (for colorColumn, prepared state, forceCategorical).
 * @param state    Current grid state.
 * @param cache    Non-reactive color cache (modified in place when results arrive).
 */
export function requestGridColors(atlas: Atlas, state: GridState, cache: GridColorCache): void {
  if (!state.enabled || !atlas.prepared) return;
  const requested = new Set<number>();
  for (const panel of state.panels) {
    const col = panel.colorColumn;
    if (col !== null && !cache.has(col)) {
      if (!requested.has(col)) {
        requested.add(col);
        // Reuse the existing colors protocol message; host responds with {type: 'colors', ...}
        vscode.post({ type: 'colors', column: col, forceCategorical: atlas.forceCategorical });
      }
    }
  }
}

/**
 * Update the grid color cache when a `colors` response arrives.
 * Returns the full RGBA array (nKept × 4) for the given column, or null if data is unavailable.
 *
 * This mirrors the encoding logic in atlas/colors.ts (`onColors`) but stores the result
 * in the per-column grid cache rather than `atlas.colorsAll`.
 */
export async function onGridColors(
  atlas: Atlas,
  column: number,
  file: FileRef,
  meta: ColorMeta,
  cache: GridColorCache,
): Promise<Uint8Array | null> {
  if (!atlas.prepared) return null;
  const n = atlas.prepared.nKept;
  try {
    // Fetch raw values (same dtype as in atlas/colors.ts).
    const raw = await fetchTyped(file.uri, file.dtype);

    let rgba: Uint8Array;
    if (meta.kind === 'numeric') {
      // Float32Array of raw values.
      const fv = raw as Float32Array;
      const lo = meta.q02 ?? meta.min ?? 0;
      const hi = meta.q98 ?? meta.max ?? 1;
      rgba = encodeNumeric(fv, lo, hi, atlas.view.colormap);
    } else if (meta.kind === 'categorical') {
      const uv = raw as Uint16Array;
      rgba = encodeCategorical(uv, meta.categories.length, undefined, (i) => atlas.categoryColor(i));
    } else {
      rgba = encodeConstant(n, DEFAULT_POINT_COLOR);
    }
    cache.set(column, rgba);
    return rgba;
  } catch {
    return null;
  }
}

/**
 * Build the per-panel color array for the renderer.
 * Returns one Uint8Array per panel; panels using the main colorColumn get `mainColors`.
 * Panels whose column is not yet cached get `mainColors` as a fallback.
 *
 * @param state       Current grid state.
 * @param mainColors  The main atlas `colorsAll` (may be null before first render).
 * @param cache       Per-column RGBA cache.
 * @returns Array of RGBA Uint8Arrays, one per panel.
 */
export function buildPanelColors(
  state: GridState,
  mainColors: Uint8Array | null,
  cache: GridColorCache,
): (Uint8Array | null)[] {
  const fallback = mainColors;
  return state.panels.map((panel) => {
    if (panel.colorColumn === null) return fallback;
    return cache.get(panel.colorColumn) ?? fallback;
  });
}

/**
 * Returns a human-readable title for a panel.
 * Uses panel.title if set, otherwise the column name, otherwise "Panel N".
 */
export function panelTitle(
  panel: PanelConfig,
  panelIndex: number,
  mainColorColumn: number | null,
  columns: { name: string }[],
): string {
  if (panel.title) return panel.title;
  const col = panel.colorColumn ?? mainColorColumn;
  if (col !== null && columns[col]) return columns[col].name;
  return `Panel ${panelIndex + 1}`;
}
