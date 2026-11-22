/**
 * "Animate by column" (item 10): a row filter over a time or number column, played back
 * on requestAnimationFrame. The window logic lives in `animate.ts` (pure, unit-tested).
 */

import type { Atlas } from '../atlas.svelte';
import type { ToWebview, VideoExportOptions } from '../../shared/protocol';
import { VideoRecorder, isVideoSupported } from '../render/videoExport';
import { vscode } from '../vscode';
import { computeTimeFilter, stepWindow } from './animate';

/** The playback loop of each Atlas (not reactive state). */
const loops = new WeakMap<Atlas, { raf: number | null; lastTs: number | null; onHidden: () => void }>();

function loop(atlas: Atlas) {
  let l = loops.get(atlas);
  if (!l) {
    l = { raf: null, lastTs: null, onHidden: () => { if (document.hidden) stopAnimation(atlas); } };
    loops.set(atlas, l);
  }
  return l;
}

export function requestTimeValues(atlas: Atlas, column: number): void {
  atlas.animate = { ...atlas.animate, column };
  vscode.post({ type: 'timeValues', column });
}

export async function onTimeValues(atlas: Atlas, m: Extract<ToWebview, { type: 'timeValues' }>): Promise<void> {
  atlas.animateMin = m.min;
  atlas.animateMax = m.max;
  const values = new Float32Array(await (await fetch(m.file.uri)).arrayBuffer());
  atlas.animateValues = values;
  atlas.animateFilter = computeTimeFilter(values, atlas.animate.windowPos, atlas.animate.windowSize);
  // Space plays and pauses only while there is something to animate.
  vscode.post({ type: 'animatingChanged', animating: true });
  atlas.render();
}

export function setAnimateWindow(atlas: Atlas, windowPos: number, windowSize: number): void {
  atlas.animate = { ...atlas.animate, windowPos, windowSize };
  if (atlas.animateValues !== null) {
    atlas.animateFilter = computeTimeFilter(atlas.animateValues, windowPos, windowSize);
    atlas.render();
  }
}

export function togglePlay(atlas: Atlas): void {
  if (atlas.animatePlaying) stopAnimation(atlas);
  else startAnimation(atlas);
}

export function startAnimation(atlas: Atlas): void {
  if (atlas.animateValues === null || atlas.animatePlaying) return;
  const l = loop(atlas);
  atlas.animatePlaying = true;
  l.lastTs = null;
  const step = (ts: number) => {
    if (!atlas.animatePlaying) return;
    if (l.lastTs !== null) {
      const dt = (ts - l.lastTs) / 1000;
      const next = stepWindow(atlas.animate.windowPos, atlas.animate.speed * dt, atlas.animate.loop);
      if (next >= 1 - 0.0002 && !atlas.animate.loop) {
        stopAnimation(atlas);
        return;
      }
      setAnimateWindow(atlas, next, atlas.animate.windowSize);
    }
    l.lastTs = ts;
    l.raf = requestAnimationFrame(step);
  };
  l.raf = requestAnimationFrame(step);
  // requestAnimationFrame stops in a hidden tab: pause cleanly instead of freezing mid-step.
  document.addEventListener('visibilitychange', l.onHidden);
}

export function stopAnimation(atlas: Atlas): void {
  const l = loop(atlas);
  atlas.animatePlaying = false;
  if (l.raf !== null) cancelAnimationFrame(l.raf);
  l.raf = null;
  document.removeEventListener('visibilitychange', l.onHidden);
}

/** Record a WebM clip of the time animation or a 3D turntable and send it to the host to save. */
export async function exportVideo(atlas: Atlas, opts: VideoExportOptions): Promise<void> {
  const canvas = atlas.renderer?.getCanvas();
  if (!canvas || !isVideoSupported()) return;
  const rec = new VideoRecorder();
  rec.start(canvas, opts.fps);
  atlas.videoRecording = true;
  try {
    if (opts.mode === 'time' && atlas.animateValues !== null) startAnimation(atlas);
    else if (opts.mode === 'turntable' && !atlas.autoRotate) atlas.toggleAutoRotate();
    await new Promise<void>((r) => setTimeout(r, (opts.durationSecs ?? 3) * 1000));
    if (opts.mode === 'time') stopAnimation(atlas);
    else if (opts.mode === 'turntable' && atlas.autoRotate) atlas.toggleAutoRotate();
  } finally {
    atlas.videoRecording = false;
  }
  const bytes = await rec.stop();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  vscode.post({ type: 'saveVideo', bytes, filename: `atlas-${opts.mode}-${ts}.webm` });
}
