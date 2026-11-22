import { PathLayer } from '@deck.gl/layers';

export const MAX_TRACKS = 5000;

type RGBA = [number, number, number, number];

export interface TrackPath {
  path: number[][];
  /** One colour for the whole track, or one per vertex (colour by time, fading tail). */
  color: RGBA | RGBA[];
}

export interface TrackStyle {
  /** Normalised time (0–1) per point, in the same order as the xy file. */
  times?: Float32Array;
  colorBy?: 'id' | 'time';
  /** Older points fade out along each track. */
  fadingTail?: boolean;
}

/** A compact blue → yellow ramp (viridis end points and middle) for colour by time. */
function timeColor(t: number): [number, number, number] {
  const stops: [number, number, number][] = [[68, 1, 84], [33, 145, 140], [253, 231, 37]];
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  return [0, 1, 2].map((c) => Math.round(stops[i][c] + (stops[i + 1][c] - stops[i][c]) * f)) as [number, number, number];
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
  style: TrackStyle = {},
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
    const idColor: RGBA = [idColors[ci] ?? 128, idColors[ci + 1] ?? 128, idColors[ci + 2] ?? 128, idColors[ci + 3] ?? 255];
    const byTime = style.colorBy === 'time' && style.times;
    if (!byTime && !style.fadingTail) {
      paths.push({ path: pts, color: idColor });
      continue;
    }
    const colors: RGBA[] = [];
    for (let p = 0; p < len; p++) {
      const rgb = byTime ? timeColor(style.times![starts[t] + p]) : [idColor[0], idColor[1], idColor[2]];
      // Fading tail: the oldest point is nearly transparent, the newest fully opaque.
      const alpha = style.fadingTail && len > 1 ? Math.round(idColor[3] * (0.1 + 0.9 * (p / (len - 1)))) : idColor[3];
      colors.push([rgb[0], rgb[1], rgb[2], alpha]);
    }
    paths.push({ path: pts, color: colors });
  }
  return paths;
}

/** Create a deck.gl PathLayer for the given track paths. */
export function createPathLayer(paths: TrackPath[], opacity: number): PathLayer {
  return new PathLayer({
    id: 'tracks-paths',
    data: paths,
    getPath: (d: TrackPath) => d.path as [number, number][],
    getColor: (d: TrackPath) => d.color as any,
    getWidth: 2,
    widthUnits: 'pixels',
    opacity,
    pickable: false,
  });
}
