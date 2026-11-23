/**
 * Grid-view factory for the deck.gl multi-view renderer (C1, item 4).
 *
 * Builds an array of OrbitView instances, each occupying its panel rectangle.
 * All views share the same OrbitView settings (orthographic top-down for 2D;
 * perspective or orthographic for 3D) and are linked via a single viewState.
 */

import { OrbitView } from '@deck.gl/core';
import type { GridLayout } from '../atlas/grid';
import { gridViewRects } from '../atlas/grid';

/**
 * Build the deck.gl `views` array for a grid layout.
 *
 * Each view has id `panel-N` (0-based), positioned at its panel rect.
 * All views share the same orbit parameters (orbitAxis, orthographic).
 *
 * @param layout       Grid layout string.
 * @param width        Canvas width in CSS pixels.
 * @param height       Canvas height in CSS pixels.
 * @param orthographic Whether to use orthographic projection (true in 2D; optional in 3D).
 * @param topBand      Pixels reserved at the top for the toolbar/search overlay (default 0).
 * @returns Array of OrbitView instances, one per panel.
 */
export function buildGridViews(
  layout: GridLayout,
  width: number,
  height: number,
  orthographic: boolean,
  topBand = 0,
): OrbitView[] {
  const rects = gridViewRects(layout, width, height, topBand);
  return rects.map((r, i) =>
    new OrbitView({
      id: `panel-${i}`,
      orbitAxis: 'Z',
      orthographic,
      x: r.x,
      y: r.y,
      width: r.w,
      height: r.h,
    } as any),
  );
}

/**
 * Returns the panel index (0-based) for a given viewport id string.
 * Returns -1 when the id does not match the `panel-N` pattern.
 */
export function viewportIdToPanel(viewportId: string): number {
  const m = viewportId.match(/^panel-(\d+)$/);
  return m ? parseInt(m[1], 10) : -1;
}

/**
 * Layer-filter predicate for the deck.gl Deck instance.
 * Layers whose id starts with `g<N>-` are restricted to view `panel-<N>`.
 * All other layers render in every view.
 */
export function gridLayerFilter({ layer, viewport }: { layer: { id: string }; viewport: { id: string } }): boolean {
  const m = layer.id.match(/^g(\d+)-/);
  if (m) {
    return viewport.id === `panel-${m[1]}`;
  }
  return true;
}
