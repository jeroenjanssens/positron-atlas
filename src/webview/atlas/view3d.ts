/**
 * 3D camera state helpers (T3).
 *
 * Manages auto-rotation and camera preset (Reset, Top, Front, Side).
 * The screen-space hit index is rebuilt after the camera settles.
 */

import type { Atlas } from '../atlas.svelte';
import { HitIndex, ScreenHitIndex } from '../render/hitIndex';

/** How long (ms) the camera must be still before the screen-space hit index is rebuilt (T4). */
const HIT_REBUILD_DELAY_MS = 200;

/** Animation frame id for auto-rotation, or 0 when stopped. */
let autoRotateFrame = 0;
let autoRotateLastTime = 0;
/** Degrees per second for auto-rotation. */
const AUTO_ROTATE_SPEED = 20;

export function startAutoRotate(atlas: Atlas): void {
  stopAutoRotate();
  autoRotateLastTime = performance.now();
  function step(now: number): void {
    if (!atlas.autoRotate) return;
    const dt = (now - autoRotateLastTime) / 1000;
    autoRotateLastTime = now;
    atlas.renderer?.rotateOrbit(AUTO_ROTATE_SPEED * dt);
    autoRotateFrame = requestAnimationFrame(step);
  }
  autoRotateFrame = requestAnimationFrame(step);
}

export function stopAutoRotate(): void {
  if (autoRotateFrame) {
    cancelAnimationFrame(autoRotateFrame);
    autoRotateFrame = 0;
  }
}

/** Timer id for hit-index rebuild debounce. */
let hitRebuildTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Called whenever the 3D view changes (from renderer's onViewChange callback).
 * Debounces rebuilding the screen-space hit index.
 */
export function on3DViewChange(atlas: Atlas): void {
  // Invalidate the existing screen-space index.
  atlas._3dScreenXY = null;
  atlas.hit = null;
  clearTimeout(hitRebuildTimer);
  hitRebuildTimer = setTimeout(() => rebuild3DHitIndex(atlas), HIT_REBUILD_DELAY_MS);
}

/**
 * Project all 3D points to screen space and build a 2D HitIndex over those coordinates.
 * Called after the camera settles.
 */
export function rebuild3DHitIndex(atlas: Atlas): void {
  if (atlas.dims !== 3 || !atlas.renderer || !atlas.anchorXY || !atlas.prepared) return;
  const nA = atlas.prepared.nAnchors;
  const nd = 3;

  // Choose the XY arrays to project (all placed rows or just anchors).
  let xyz: Float32Array;
  let n: number;
  let mapFn: (i: number) => number;

  if (atlas.projection === 'done' && atlas.allXY && atlas.placedRows > 0) {
    xyz = atlas.allXY.subarray(0, atlas.placedRows * nd);
    n = atlas.placedRows;
    mapFn = (i) => i;
  } else {
    xyz = atlas.anchorXY;
    n = nA;
    const pos = atlas.anchorPos;
    mapFn = pos ? (i) => pos[i] : (i) => i;
  }

  const screenXY = atlas.renderer.projectAll3D(xyz, n);
  if (!screenXY) return;
  atlas._3dScreenXY = screenXY;
  const idx = new ScreenHitIndex(screenXY, n);
  atlas.hit = { index: idx as unknown as HitIndex, map: mapFn };
}

/**
 * Camera presets for 3D (T3).
 * Orbit axis is Z; rotationX = 0 is "top" looking down.
 */
export type CameraPreset = 'top' | 'front' | 'side';

export function setCameraPreset(atlas: Atlas, preset: CameraPreset): void {
  atlas.renderer?.setCameraPreset(preset);
}
