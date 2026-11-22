/**
 * Tracks and vectors between rows (item 11). The kernel groups rows by an ID column and
 * orders them by a time column; this module fetches its files and draws them as the
 * 'tracks' and 'vectors' layers of the layer registry (`layers.ts`), so visibility,
 * opacity and draw order follow the Layers section.
 */

import type { Atlas } from '../atlas.svelte';
import type { ToWebview, TracksOptions } from '../../shared/protocol';
import { vscode, float32ToBytes } from '../vscode';
import { buildTrackPaths, createPathLayer, thinIndices } from './tracks';
import { buildVectors, createVectorLayer, thinVectors } from './vectors';

/** The fetched track files of each Atlas (bulk data, not reactive state). */
const trackFiles = new WeakMap<Atlas, { xy: Float32Array; starts: Uint32Array; lengths: Uint32Array; times: Float32Array }>();

export function requestTracks(atlas: Atlas, idColumn: number, timeColumn: number): void {
  atlas.tracks = { ...atlas.tracks, idColumn, timeColumn };
  // The browser computes the layout, so the kernel may not have it: send it along.
  const anchorXY = atlas.anchorXY ? float32ToBytes(atlas.anchorXY) : undefined;
  vscode.post({ type: 'tracks', idColumn, timeColumn, nd: atlas.dims, anchorXY });
}

export async function onTracks(atlas: Atlas, m: Extract<ToWebview, { type: 'tracks' }>): Promise<void> {
  atlas.trackData = m.result;
  const buf = (f: { uri: string }) => fetch(f.uri).then((r) => r.arrayBuffer());
  const [xy, starts, lengths, times] = await Promise.all([buf(m.result.xyFile), buf(m.result.startsFile), buf(m.result.lengthsFile), buf(m.result.timeFile)]);
  trackFiles.set(atlas, { xy: new Float32Array(xy), starts: new Uint32Array(starts), lengths: new Uint32Array(lengths), times: new Float32Array(times) });
  updateTracksLayer(atlas);
}

export function setTracksOptions(atlas: Atlas, opts: Partial<TracksOptions>): void {
  atlas.tracks = { ...atlas.tracks, ...opts };
  updateTracksLayer(atlas);
}

export function updateTracksLayer(atlas: Atlas): void {
  const files = trackFiles.get(atlas);
  if (!atlas.renderer) return;
  if (!atlas.trackData || !files) {
    atlas.renderer.setOverlayLayer('tracks', null);
    return;
  }
  const { idColors, nTracks, nd } = atlas.trackData;
  const paths = buildTrackPaths(files.xy, files.starts, files.lengths, idColors, nd, thinIndices(nTracks), {
    times: files.times,
    colorBy: atlas.tracks.colorBy,
    fadingTail: atlas.tracks.fadingTail,
  });
  atlas.renderer.setOverlayLayer('tracks', (opacity) => createPathLayer(paths, opacity));
}

/** Keep the current layout to compare a later one with ("Compare with a layout"). */
export function saveLayoutForComparison(atlas: Atlas): void {
  if (atlas.anchorXY) atlas.savedXY = atlas.anchorXY.slice();
  updateVectorsLayer(atlas);
}

export function setShowVectors(atlas: Atlas, show: boolean): void {
  atlas.showVectors = show;
  updateVectorsLayer(atlas);
}

export function updateVectorsLayer(atlas: Atlas): void {
  if (!atlas.renderer) return;
  const nd = atlas.dims;
  // A layout saved in the other dimensionality can't be compared point by point.
  if (!atlas.showVectors || !atlas.savedXY || !atlas.anchorXY || atlas.savedXY.length !== atlas.anchorXY.length) {
    atlas.renderer.setOverlayLayer('vectors', null);
    return;
  }
  const n = atlas.anchorXY.length / nd;
  const pairs = buildVectors(atlas.savedXY, atlas.anchorXY, nd, thinVectors(n), null);
  atlas.renderer.setOverlayLayer('vectors', (opacity) => createVectorLayer(pairs, opacity));
}
