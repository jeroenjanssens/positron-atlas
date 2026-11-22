/**
 * Leader lines for point annotations (B5 / item 2).
 *
 * Renders callout leader lines as a deck.gl LineLayer so they live in map (world)
 * space and therefore orbit, rotate and depth-sort correctly in both 2D and 3D.
 *
 * Layer id: 'leader-lines' (deck.gl layer, registered in layers.ts).
 *
 * Each leader is a straight line from the annotated point to the callout box anchor:
 *   source = [worldX, worldY, worldZ ?? 0]
 *   target = [worldX + offsetX, worldY + offsetY, worldZ ?? 0]
 * (Offsets are in the XY plane at the point's depth in 3D.)
 */

import { LineLayer } from '@deck.gl/layers';
import type { AnnotationData } from '../../shared/protocol';

export interface LeaderLineData {
  source: [number, number] | [number, number, number];
  target: [number, number] | [number, number, number];
  color: [number, number, number, number];
}

/**
 * Build the data array for the LineLayer from the current annotations.
 * Called by the renderer each frame; cheap since annotations are few.
 */
export function buildLeaderLineData(
  annotations: Map<string, AnnotationData>,
  is3D: boolean,
): LeaderLineData[] {
  const result: LeaderLineData[] = [];
  for (const ann of annotations.values()) {
    const wz = ann.worldZ ?? 0;
    const src: [number, number] | [number, number, number] = is3D
      ? [ann.worldX, ann.worldY, wz]
      : [ann.worldX, ann.worldY];
    const tgt: [number, number] | [number, number, number] = is3D
      ? [ann.worldX + ann.offsetX, ann.worldY + ann.offsetY, wz]
      : [ann.worldX + ann.offsetX, ann.worldY + ann.offsetY];
    // Color: badge color, or neutral grey with 70% alpha.
    let color: [number, number, number, number] = [200, 200, 200, 178];
    if (ann.style === 'badge' && ann.color) {
      // Parse rgba(r,g,b,a) string.
      const m = ann.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (m) {
        const alpha = m[4] !== undefined ? Math.round(parseFloat(m[4]) * 255) : 255;
        color = [parseInt(m[1]), parseInt(m[2]), parseInt(m[3]), alpha];
      }
    }
    result.push({ source: src, target: tgt, color });
  }
  return result;
}

/**
 * Build the deck.gl LineLayer for leader lines.
 * Returned layer is included in the deck.gl layer array by the renderer.
 */
export function buildLeaderLinesLayer(
  annotations: Map<string, AnnotationData>,
  is3D: boolean,
  opacity: number,
  lineWidth = 1.5,
): LineLayer<LeaderLineData> {
  const data = buildLeaderLineData(annotations, is3D);
  return new LineLayer<LeaderLineData>({
    id: 'leader-lines',
    data,
    getSourcePosition: (d) => d.source,
    getTargetPosition: (d) => d.target,
    getColor: (d) => {
      const [r, g, b, a] = d.color;
      return [r, g, b, Math.round(a * opacity)];
    },
    getWidth: lineWidth,
    widthUnits: 'pixels',
    widthMinPixels: 1,
    pickable: false,
    updateTriggers: {
      data: [annotations.size],
    },
  });
}
