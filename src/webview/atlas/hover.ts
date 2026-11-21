/**
 * Hover detection and tooltip management.
 */

import type { Atlas } from '../atlas.svelte';
import { HitIndex } from '../render/hitIndex';
import { vscode } from '../vscode';

export function onPointer(atlas: Atlas, p: { x: number; y: number; world: [number, number] } | null): void {
  clearTimeout(atlas.hoverTimer);
  if (!p || (atlas.phase !== 'ready' && !atlas.paused) || !atlas.anchorXY || !atlas.prepared || !atlas.anchorPos) {
    atlas.tooltip = null;
    atlas.pendingHover = null;
    return;
  }
  if (!atlas.hit) {
    if (atlas.projection === 'done' && atlas.allXY) {
      atlas.hit = { index: new HitIndex(atlas.allXY, atlas.nKept), map: (i) => i };
    } else {
      const pos = atlas.anchorPos;
      atlas.hit = { index: new HitIndex(atlas.anchorXY, atlas.prepared.nAnchors), map: (i) => pos[i] };
    }
  }
  const radius = atlas.renderer!.worldPerPixel() * Math.max(6, atlas.view.pointSize);
  const idx = atlas.hit.index.nearest(p.world[0], p.world[1], radius);
  if (idx < 0) {
    atlas.tooltip = null;
    atlas.pendingHover = null;
    return;
  }
  const kept = atlas.hit.map(idx);
  if (atlas.tooltip && atlas.tooltip.row === kept) {
    atlas.tooltip = { ...atlas.tooltip, x: p.x, y: p.y };
    return;
  }
  const seq = ++atlas.hoverSeq;
  atlas.hoverTimer = setTimeout(() => {
    if (seq === atlas.hoverSeq) {
      atlas.pendingHover = { x: p.x, y: p.y };
      const image = atlas.view.images ? atlas.imageColumns?.indices : undefined;
      vscode.post({ type: 'row', i: kept, imageColumns: image });
    }
  }, 120);
}
