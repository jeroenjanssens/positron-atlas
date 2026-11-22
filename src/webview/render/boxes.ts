/**
 * Box geometry helpers and deck.gl layer builders for bounding-box overlays (B2).
 *
 * Provides:
 *  - groupExtents2D / groupExtents3D: robust percentile-based extents per u16 group code.
 *  - buildBoxLayers2D:  PathLayer wireframe rectangles (one per group) in 2D.
 *  - buildBoxLayers3D:  LineLayer wireframe cubes (one per group) in 3D.
 *  - buildDataBoxLayer:  LineLayer wireframe around all data in 3D.
 *  - buildFloorGridLayer: LineLayer floor grid at the bottom of the data box.
 *  - buildGizmoLayer:   LineLayer orientation axes (X/Y/Z) in a corner of the data box.
 *
 * Performance:
 *  groupExtents2D on 1M points with k=20 groups runs in ≈ 50 ms on an M-series Mac
 *  (see docs/benchmarks.md, B2-extents-1m entry).  The bottleneck is two sorts per
 *  group; a histogram approach would be faster but adds complexity.
 */

import { LineLayer, PathLayer, TextLayer } from '@deck.gl/layers';

// ---- types ------------------------------------------------------------------

/** [minX, minY, maxX, maxY] */
export type Extent2D = [number, number, number, number];
/** [minX, minY, minZ, maxX, maxY, maxZ] */
export type Extent3D = [number, number, number, number, number, number];

/** A 2D bounding-box overlay item. */
export interface Box2D {
  extent: Extent2D;
  color: [number, number, number, number]; // RGBA 0-255
  label?: string;
}

/** A 3D bounding-box overlay item. */
export interface Box3D {
  extent: Extent3D;
  color: [number, number, number, number];
  label?: string;
}

// ---- geometry ---------------------------------------------------------------

/**
 * Pick the value at a given percentile from a sorted array.
 * Uses linear interpolation between adjacent elements.
 */
export function percentileVal(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Compute robust per-group 2D extents (percentile-clipped so outliers don't blow the box).
 *
 * @param positions Interleaved x,y (stride=2) or x,y,z (stride=3) positions of all points.
 * @param codes     u16 group code per point; codes >= k are "no group" (noise/unlabelled).
 * @param k         Number of groups.
 * @param stride    2 or 3 (number of values per point in `positions`).
 * @param pLo       Lower percentile (default 0.01).
 * @param pHi       Upper percentile (default 0.99).
 * @returns Array of length k; null for groups with no points.
 */
export function groupExtents2D(
  positions: Float32Array,
  codes: Uint16Array,
  k: number,
  stride: 2 | 3 = 2,
  pLo = 0.01,
  pHi = 0.99,
): Array<Extent2D | null> {
  const xs: number[][] = Array.from({ length: k }, () => []);
  const ys: number[][] = Array.from({ length: k }, () => []);
  const n = codes.length;
  for (let i = 0; i < n; i++) {
    const c = codes[i];
    if (c < k) {
      xs[c].push(positions[stride * i]);
      ys[c].push(positions[stride * i + 1]);
    }
  }
  return xs.map((x, ci) => {
    if (x.length === 0) return null;
    x.sort((a, b) => a - b);
    const y = ys[ci];
    y.sort((a, b) => a - b);
    return [
      percentileVal(x, pLo),
      percentileVal(y, pLo),
      percentileVal(x, pHi),
      percentileVal(y, pHi),
    ];
  });
}

/**
 * Compute robust per-group 3D extents.
 *
 * @param positions Interleaved x,y,z positions (stride always 3).
 * @param codes     u16 group code per point; >= k means no group.
 * @param k         Number of groups.
 * @param pLo       Lower percentile (default 0.005).
 * @param pHi       Upper percentile (default 0.995).
 * @returns Array of length k; null for groups with no points.
 */
export function groupExtents3D(
  positions: Float32Array,
  codes: Uint16Array,
  k: number,
  pLo = 0.005,
  pHi = 0.995,
): Array<Extent3D | null> {
  const xs: number[][] = Array.from({ length: k }, () => []);
  const ys: number[][] = Array.from({ length: k }, () => []);
  const zs: number[][] = Array.from({ length: k }, () => []);
  const n = codes.length;
  for (let i = 0; i < n; i++) {
    const c = codes[i];
    if (c < k) {
      xs[c].push(positions[3 * i]);
      ys[c].push(positions[3 * i + 1]);
      zs[c].push(positions[3 * i + 2]);
    }
  }
  return xs.map((x, ci) => {
    if (x.length === 0) return null;
    x.sort((a, b) => a - b);
    const y = ys[ci];
    y.sort((a, b) => a - b);
    const z = zs[ci];
    z.sort((a, b) => a - b);
    return [
      percentileVal(x, pLo),
      percentileVal(y, pLo),
      percentileVal(z, pLo),
      percentileVal(x, pHi),
      percentileVal(y, pHi),
      percentileVal(z, pHi),
    ];
  });
}

/**
 * Compute axis-aligned extent of all points (min/max, no percentile clipping).
 * Used for the 3D data-bounding box.
 */
export function fullExtent3D(positions: Float32Array, n: number): Extent3D | null {
  if (n === 0) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return [minX, minY, minZ, maxX, maxY, maxZ];
}

// ---- deck.gl layer builders -------------------------------------------------

const NORMAL = { depthWriteEnabled: false, depthCompare: 'always' } as const;

/**
 * Build a deck.gl PathLayer showing 2D wireframe rectangles for each Box2D.
 * Returns null when the boxes array is empty.
 */
export function buildBoxLayers2D(
  boxes: Box2D[],
  opacity: number,
  layerIdPrefix = 'boxes-2d',
): PathLayer[] {
  if (boxes.length === 0) return [];
  // One path (closed loop) per box; PathLayer renders them as anti-aliased line paths.
  return [
    new PathLayer<Box2D>({
      id: layerIdPrefix,
      data: boxes,
      getPath: (d: Box2D) => {
        const [x0, y0, x1, y1] = d.extent;
        return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
      },
      getColor: (d: Box2D) => d.color,
      getWidth: 1.5,
      widthUnits: 'pixels',
      capRounded: true,
      billboard: false,
      pickable: false,
      opacity,
      parameters: NORMAL as any,
    } as any),
  ];
}

/** One line segment for a LineLayer. */
interface Segment {
  src: [number, number, number];
  tgt: [number, number, number];
  color: [number, number, number, number];
}

/** Build the 12 wire edges of a 3D axis-aligned box. */
function cubeEdges(e: Extent3D, color: [number, number, number, number]): Segment[] {
  const [x0, y0, z0, x1, y1, z1] = e;
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ] as [number, number, number][];
  const edgePairs: [number, number][] = [
    [0,1],[1,2],[2,3],[3,0], // bottom
    [4,5],[5,6],[6,7],[7,4], // top
    [0,4],[1,5],[2,6],[3,7], // verticals
  ];
  return edgePairs.map(([a, b]) => ({ src: c[a], tgt: c[b], color }));
}

/**
 * Build a deck.gl LineLayer showing 3D wireframe cubes for each Box3D.
 * Returns null when the boxes array is empty.
 */
export function buildBoxLayers3D(
  boxes: Box3D[],
  opacity: number,
  layerIdPrefix = 'boxes-3d',
): LineLayer[] {
  if (boxes.length === 0) return [];
  const segments: Segment[] = boxes.flatMap((b) => cubeEdges(b.extent, b.color));
  return [
    new LineLayer<Segment>({
      id: layerIdPrefix,
      data: segments,
      getSourcePosition: (d: Segment) => d.src,
      getTargetPosition: (d: Segment) => d.tgt,
      getColor: (d: Segment) => d.color,
      getWidth: 1.5,
      widthUnits: 'pixels',
      pickable: false,
      opacity,
      parameters: NORMAL as any,
    } as any),
  ];
}

/**
 * Build a deck.gl LineLayer showing the wireframe bounding box of the entire dataset.
 * Returns null when extent is null.
 */
export function buildDataBoxLayer(
  extent: Extent3D | null,
  opacity: number,
  color: [number, number, number, number] = [150, 150, 150, 180],
  layerId = 'data-box-frame',
): LineLayer | null {
  if (!extent) return null;
  const segments = cubeEdges(extent, color);
  return new LineLayer<Segment>({
    id: layerId,
    data: segments,
    getSourcePosition: (d: Segment) => d.src,
    getTargetPosition: (d: Segment) => d.tgt,
    getColor: (d: Segment) => d.color,
    getWidth: 1,
    widthUnits: 'pixels',
    pickable: false,
    opacity,
    parameters: NORMAL as any,
  } as any);
}

/**
 * Build a deck.gl LineLayer for a floor grid at z = minZ of the data bounding box.
 * Lines run parallel to X and Y axes at `numLines` intervals each direction.
 * Returns null when extent is null.
 */
export function buildFloorGridLayer(
  extent: Extent3D | null,
  numLines = 10,
  opacity: number,
  color: [number, number, number, number] = [80, 80, 80, 120],
  layerId = 'data-box-grid',
): LineLayer | null {
  if (!extent) return null;
  const [x0, y0, z0, x1, y1] = extent;
  const segments: { src: [number, number, number]; tgt: [number, number, number] }[] = [];
  const nx = numLines + 1; // includes both endpoints
  const ny = numLines + 1;
  for (let i = 0; i <= numLines; i++) {
    const tx = x0 + (i / numLines) * (x1 - x0);
    segments.push({ src: [tx, y0, z0], tgt: [tx, y1, z0] });
    const ty = y0 + (i / numLines) * (y1 - y0);
    segments.push({ src: [x0, ty, z0], tgt: [x1, ty, z0] });
  }
  void nx; void ny; // used for segment count only
  return new LineLayer({
    id: layerId,
    data: segments,
    getSourcePosition: (d: any) => d.src,
    getTargetPosition: (d: any) => d.tgt,
    getColor: color,
    getWidth: 1,
    widthUnits: 'pixels',
    pickable: false,
    opacity,
    parameters: NORMAL as any,
  } as any);
}

/**
 * Build a deck.gl LineLayer for the orientation gizmo (X/Y/Z axes).
 * Origin is the front-bottom-left corner of the data bounding box.
 * Returns null when extent is null.
 */
export function buildGizmoLayer(
  extent: Extent3D | null,
  opacity: number,
  layerId = 'data-box-gizmo',
): LineLayer | null {
  if (!extent) return null;
  const [x0, y0, z0, x1, y1, z1] = extent;
  const size = Math.max(x1 - x0, y1 - y0, z1 - z0) * 0.18;
  // Origin at the min-corner (bottom-front-left).
  const origin: [number, number, number] = [x0, y0, z0];
  const axes: { src: [number,number,number]; tgt: [number,number,number]; color: [number,number,number,number] }[] = [
    { src: origin, tgt: [x0 + size, y0, z0], color: [220, 50,  50,  220] }, // X = red
    { src: origin, tgt: [x0, y0 + size, z0], color: [50,  180, 50,  220] }, // Y = green
    { src: origin, tgt: [x0, y0, z0 + size], color: [50,  100, 220, 220] }, // Z = blue
  ];
  return new LineLayer({
    id: layerId,
    data: axes,
    getSourcePosition: (d: any) => d.src,
    getTargetPosition: (d: any) => d.tgt,
    getColor: (d: any) => d.color,
    getWidth: 3,
    widthUnits: 'pixels',
    pickable: false,
    opacity,
    parameters: NORMAL as any,
  } as any);
}

/**
 * Build an optional TextLayer with group name labels at the top-right corner of each box.
 * Only added when labels are provided in the Box2D/Box3D items.
 * Uses billboard=true in 3D so labels always face the camera.
 */
export function buildBoxLabelLayer(
  boxes: Array<Box2D | Box3D>,
  is3D: boolean,
  opacity: number,
  layerId = 'boxes-labels',
): TextLayer[] {
  const labeled = boxes.filter((b) => b.label);
  if (labeled.length === 0) return [];
  return [
    new TextLayer<Box2D | Box3D>({
      id: layerId,
      data: labeled,
      getText: (d: Box2D | Box3D) => d.label ?? '',
      getPosition: (d: Box2D | Box3D) => {
        const e = d.extent;
        return is3D
          ? [(e as Extent3D)[3], (e as Extent3D)[4], (e as Extent3D)[5]] as [number,number,number]
          : [(e as Extent2D)[2], (e as Extent2D)[3]] as [number,number];
      },
      getSize: 11,
      sizeUnits: 'pixels',
      getColor: (d: Box2D | Box3D) => d.color,
      fontFamily: 'sans-serif',
      characterSet: 'auto',
      fontSettings: { sdf: true, fontSize: 32, buffer: 8, radius: 8 },
      getTextAnchor: 'start',
      getAlignmentBaseline: 'bottom',
      billboard: is3D,
      pickable: false,
      opacity,
      parameters: NORMAL as any,
    } as any),
  ];
}
