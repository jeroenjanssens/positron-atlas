import { PathLayer } from '@deck.gl/layers';

export const MAX_TRACKS = 5000;

export interface TrackPath {
  path: number[][];
  color: [number, number, number, number];
}

/** Thin tracks uniformly to at most MAX_TRACKS. Returns kept track indices. */
export function thinIndices(nTracks: number): Uint32Array {
  if (nTracks <= MAX_TRACKS) {
    const idx = new Uint32Array(nTracks);
    for (let i = 0; i < nTracks; i++) idx[i] = i;
    return idx;
  }
  const step = nTracks / MAX_TRACKS;
  const idx = new Uint32Array(MAX_TRACKS);
  for (let i = 0; i < MAX_TRACKS; i++) idx[i] = Math.floor(i * step);
  return idx;
}

/**
 * Build TrackPath objects from packed binary data.
 * xy is packed by track (all points of track 0, then track 1, …).
 * starts[t] = first point index of track t; lengths[t] = number of points.
 */
export function buildTrackPaths(
  xy: Float32Array,
  starts: Uint32Array,
  lengths: Uint32Array,
  idColors: number[],
  nd: 2 | 3,
  trackIdx: Uint32Array,
): TrackPath[] {
  const paths: TrackPath[] = [];
  for (let ti = 0; ti < trackIdx.length; ti++) {
    const t = trackIdx[ti];
    const start = starts[t] * nd;
    const len = lengths[t];
    const pts: number[][] = [];
    for (let p = 0; p < len; p++) {
      const base = start + p * nd;
      pts.push(nd === 3 ? [xy[base], xy[base + 1], xy[base + 2]] : [xy[base], xy[base + 1]]);
    }
    const ci = t * 4;
    paths.push({
      path: pts,
      color: [idColors[ci] ?? 128, idColors[ci + 1] ?? 128, idColors[ci + 2] ?? 128, idColors[ci + 3] ?? 255],
    });
  }
  return paths;
}

/** Create a deck.gl PathLayer for the given track paths. */
export function createPathLayer(paths: TrackPath[], opacity: number): PathLayer {
  return new PathLayer({
    id: 'tracks-paths',
    data: paths,
    getPath: (d: TrackPath) => d.path as [number, number][],
    getColor: (d: TrackPath) => d.color,
    getWidth: 2,
    widthUnits: 'pixels',
    opacity,
    pickable: false,
  });
}
