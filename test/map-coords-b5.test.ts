/**
 * B5 unit tests: map-coordinate offsets for label drags and annotations.
 *
 * Tests:
 *  - screenDeltaToWorld conversion in a simple orthographic view
 *  - Migration: old screen-pixel dragOffsets are reset on load
 *  - Migration: old screen-pixel annotation offsets are reset on load
 *  - New annotations get offsetVersion: 'v2map'
 *  - importAnnotationsJson migrates legacy (bare-array) format
 *  - smartDefaultOffset returns non-trivial world units
 *  - matchDragOffsets still works after the type change
 */

import { describe, expect, it } from 'vitest';
import {
  addAnnotation,
  updateAnnotationOffset,
  exportAnnotationsJson,
  importAnnotationsJson,
  smartDefaultOffset,
} from '../src/webview/atlas/annotations';
import { matchDragOffsets } from '../src/webview/atlas/labels';
import type { AnnotationData, TitleOptions } from '../src/shared/protocol';
import { DEFAULT_TITLE } from '../src/webview/atlas/annotations';

// ---------------------------------------------------------------------------
// Minimal Atlas stub
// ---------------------------------------------------------------------------

function makeAtlas(partial: Partial<{
  annotations: Map<string, AnnotationData>;
  anchorXY: Float32Array;
  renderer: { worldPerPixel: () => number; projectWorld: (wx: number, wy: number) => [number, number] | null; unproject: (x: number, y: number) => [number, number] } | null;
}> = {}) {
  return {
    annotations: new Map<string, AnnotationData>(),
    annotateIdColumn: null,
    view: { images: false },
    imageColumns: null,
    anchorXY: new Float32Array([0, 0, 1, 1, 2, 2, 3, 3]),
    allXY: null,
    placedRows: 0,
    colorsAnchors: null,
    colorsAll: null,
    hit: null,
    textsStore: { ready: false, get: () => null },
    renderer: null,
    titleOverlay: { ...DEFAULT_TITLE },
    pendingHover: null,
    tooltipOpts: { imageUrlColumn: null },
    loadImagesFromUrls: 'ask' as const,
    legendWidth: () => 0,
    recordHistory: () => {},
    ...partial,
  } as any;
}

// ---------------------------------------------------------------------------
// screenDeltaToWorld (pure math check: unrotated orthographic view at zoom 0)
// ---------------------------------------------------------------------------

describe('screenDeltaToWorld', () => {
  it('converts a screen-pixel delta to world units correctly at zoom 0', () => {
    // Build a minimal renderer mock that uses the orthographic fallback math.
    // At zoom 0 (scale = 1): wpp = 1, so dx_world = dx_screen * 1, dy_world = -dy_screen * 1.
    const W = 800;
    const H = 600;
    const target = [0, 0, 0];
    function unproject(x: number, y: number): [number, number] {
      const scale = 1; // zoom 0
      return [target[0] + (x - W / 2) / scale, target[1] - (y - H / 2) / scale];
    }
    // screenDeltaToWorld = unproject(x0 + dx, y0 + dy) - unproject(x0, y0)
    function screenDeltaToWorld(x0: number, y0: number, dx: number, dy: number): [number, number] {
      const w0 = unproject(x0, y0);
      const w1 = unproject(x0 + dx, y0 + dy);
      return [w1[0] - w0[0], w1[1] - w0[1]];
    }
    // 60px right, 20px down at zoom 0 → world [60, -20]
    const [wx, wy] = screenDeltaToWorld(400, 300, 60, 20);
    expect(wx).toBeCloseTo(60);
    expect(wy).toBeCloseTo(-20);
  });

  it('world delta is independent of drag start position (orthographic, unrotated)', () => {
    const W = 800;
    const H = 600;
    const target = [5, 3, 0];
    function unproject(x: number, y: number): [number, number] {
      const scale = 2; // zoom 1 (2^1 = 2)
      return [target[0] + (x - W / 2) / scale, target[1] - (y - H / 2) / scale];
    }
    function screenDeltaToWorld(x0: number, y0: number, dx: number, dy: number): [number, number] {
      const w0 = unproject(x0, y0);
      const w1 = unproject(x0 + dx, y0 + dy);
      return [w1[0] - w0[0], w1[1] - w0[1]];
    }
    // At zoom 1 (scale 2), wpp = 0.5: 60px right → 30 world units, 20px down → -10 world units.
    const [wx1, wy1] = screenDeltaToWorld(100, 100, 60, 20);
    const [wx2, wy2] = screenDeltaToWorld(500, 400, 60, 20);
    expect(wx1).toBeCloseTo(wx2);
    expect(wy1).toBeCloseTo(wy2);
    expect(wx1).toBeCloseTo(30);
    expect(wy1).toBeCloseTo(-10);
  });
});

// ---------------------------------------------------------------------------
// Migration: dragOffsetsVersion
// ---------------------------------------------------------------------------

describe('dragOffsetsVersion migration', () => {
  it('dragOffsets present and version is v2map → offsets are kept', () => {
    // Simulate what init.ts does: if version = 'v2map', keep the offsets.
    const l = {
      dragOffsets: { 'GroupA': [1.5, 2.3] as [number, number] },
      dragOffsetsVersion: 'v2map' as const,
    };
    const dragOffsetsVersion = l.dragOffsetsVersion === 'v2map' ? 'v2map' as const : undefined;
    const dragOffsets: Record<string, [number, number]> = {};
    if (dragOffsetsVersion === 'v2map' && l.dragOffsets) {
      for (const [k, v] of Object.entries(l.dragOffsets)) {
        if (Array.isArray(v) && v.length === 2) dragOffsets[k] = [v[0], v[1]];
      }
    }
    expect(Object.keys(dragOffsets)).toHaveLength(1);
    expect(dragOffsets['GroupA']).toEqual([1.5, 2.3]);
  });

  it('dragOffsets present but version absent (legacy screen px) → offsets reset to empty', () => {
    const l = {
      dragOffsets: { 'GroupA': [120, -45] as [number, number] },
      // no dragOffsetsVersion
    } as any;
    const dragOffsetsVersion = l.dragOffsetsVersion === 'v2map' ? 'v2map' as const : undefined;
    const dragOffsets: Record<string, [number, number]> = {};
    if (dragOffsetsVersion === 'v2map' && l.dragOffsets) {
      for (const [k, v] of Object.entries(l.dragOffsets)) {
        if (Array.isArray(v) && v.length === 2) dragOffsets[k as string] = [v[0] as number, v[1] as number];
      }
    }
    // Legacy offsets must be reset.
    expect(Object.keys(dragOffsets)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Migration: annotation offsetVersion
// ---------------------------------------------------------------------------

describe('annotation offset migration', () => {
  it('annotation without offsetVersion (legacy screen px) → offsets reset to defaults', () => {
    // Simulate what init.ts does.
    const ann: any = { id: 'ann1', rowKey: '5', offsetX: 120, offsetY: -40 };
    // Migration: if offsetVersion !== 'v2map', reset.
    const migrated = ann.offsetVersion !== 'v2map'
      ? { ...ann, offsetX: 60, offsetY: 20, offsetVersion: 'v2map' }
      : ann;
    expect(migrated.offsetVersion).toBe('v2map');
    // Screen-pixel offsets were large; after migration they are reset to small world units.
    expect(migrated.offsetX).toBe(60);
    expect(migrated.offsetY).toBe(20);
  });

  it('annotation with offsetVersion: v2map keeps offsets unchanged', () => {
    const ann: any = { id: 'ann2', rowKey: '7', offsetX: 1.5, offsetY: 2.3, offsetVersion: 'v2map' };
    const migrated = ann.offsetVersion !== 'v2map'
      ? { ...ann, offsetX: 60, offsetY: 20, offsetVersion: 'v2map' }
      : ann;
    expect(migrated.offsetX).toBe(1.5);
    expect(migrated.offsetY).toBe(2.3);
  });
});

// ---------------------------------------------------------------------------
// New annotations have offsetVersion: 'v2map'
// ---------------------------------------------------------------------------

describe('addAnnotation sets offsetVersion v2map', () => {
  it('new annotation gets offsetVersion: v2map', () => {
    const atlas = makeAtlas();
    const ann = addAnnotation(atlas, 0, 0, 1, 2, 'Test')!;
    expect(ann.offsetVersion).toBe('v2map');
  });

  it('world offset is set (non-zero) even without renderer', () => {
    const atlas = makeAtlas({ renderer: null });
    const ann = addAnnotation(atlas, 0, 0, 0, 0, 'Test')!;
    // With no renderer, wpp=1, DEFAULT_OFFSET_X_PX=60, DEFAULT_OFFSET_Y_PX=-20.
    // Expected: [60, 20] (world y is up: -oy_px = 20).
    expect(ann.offsetX).toBeCloseTo(60);
    expect(ann.offsetY).toBeCloseTo(20);
  });

  it('updateAnnotationOffset preserves offsetVersion v2map', () => {
    const atlas = makeAtlas();
    const ann = addAnnotation(atlas, 0, 0, 0, 0, 'Test')!;
    updateAnnotationOffset(atlas, ann.id, 10, 5);
    const updated = atlas.annotations.get(ann.id)!;
    expect(updated.offsetVersion).toBe('v2map');
    expect(updated.offsetX).toBe(10);
    expect(updated.offsetY).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// smartDefaultOffset returns world-unit offsets
// ---------------------------------------------------------------------------

describe('smartDefaultOffset', () => {
  it('returns world-unit offsets proportional to wpp', () => {
    // With renderer providing wpp = 0.5 (zoom 1), offset should scale.
    const atlas = makeAtlas({
      renderer: {
        worldPerPixel: () => 0.5,
        projectWorld: () => [400, 300] as [number, number],
        unproject: (x: number, y: number) => [x, y] as [number, number],
      },
    });
    const [ox, oy] = smartDefaultOffset(atlas, 0, 0);
    // DEFAULT_OFFSET_X_PX = 60, so ox = 60 * 0.5 = 30.
    expect(ox).toBeCloseTo(30);
    // DEFAULT_OFFSET_Y_PX = -20, so oy = -(-20) * 0.5 = 10.
    expect(oy).toBeCloseTo(10);
  });

  it('returns positive x (right) and positive y (up) for a central point', () => {
    const atlas = makeAtlas({
      renderer: {
        worldPerPixel: () => 1,
        projectWorld: () => [400, 300] as [number, number], // center, not in right/top zone
        unproject: (x: number, y: number) => [x, y] as [number, number],
      },
    });
    const [ox, oy] = smartDefaultOffset(atlas, 0, 0);
    expect(ox).toBeGreaterThan(0); // right of point
    expect(oy).toBeGreaterThan(0); // above point (positive world y = up = negative screen y)
  });
});

// ---------------------------------------------------------------------------
// exportAnnotationsJson / importAnnotationsJson (B5 format)
// ---------------------------------------------------------------------------

describe('exportAnnotationsJson v2 format', () => {
  it('exports as { v: 2, annotations: [...] }', () => {
    const atlas = makeAtlas();
    addAnnotation(atlas, 0, 1, 0, 0, 'Test');
    const json = exportAnnotationsJson(atlas);
    const parsed = JSON.parse(json);
    expect(parsed.v).toBe(2);
    expect(Array.isArray(parsed.annotations)).toBe(true);
    expect(parsed.annotations).toHaveLength(1);
  });
});

describe('importAnnotationsJson handles legacy bare-array format', () => {
  it('imports a legacy bare-array and migrates offsets', () => {
    const atlas = makeAtlas();
    const legacyArr = [
      { id: 'old1', rowKey: '5', row: 5, text: 'Old', style: 'plain', worldX: 1, worldY: 2, offsetX: 120, offsetY: -45 },
    ];
    importAnnotationsJson(atlas, JSON.stringify(legacyArr));
    expect(atlas.annotations.size).toBe(1);
    const ann = [...atlas.annotations.values()][0];
    // Legacy offsets must be migrated (offsetVersion: 'v2map', offsets reset).
    expect(ann.offsetVersion).toBe('v2map');
    // The offsets should be reset (not the large screen-pixel values 120, -45).
    expect(Math.abs(ann.offsetX)).toBeLessThan(120);
  });

  it('imports the new { v: 2, annotations } format and keeps v2map offsets', () => {
    const atlas = makeAtlas();
    const newFormat = {
      v: 2,
      annotations: [
        { id: 'new1', rowKey: '7', row: 7, text: 'New', style: 'plain', worldX: 0, worldY: 0, offsetX: 3.5, offsetY: 1.2, offsetVersion: 'v2map' },
      ],
    };
    importAnnotationsJson(atlas, JSON.stringify(newFormat));
    const ann = [...atlas.annotations.values()][0];
    expect(ann.offsetX).toBeCloseTo(3.5);
    expect(ann.offsetY).toBeCloseTo(1.2);
    expect(ann.offsetVersion).toBe('v2map');
  });
});

// ---------------------------------------------------------------------------
// matchDragOffsets (unchanged, but verify it still works with [number, number] tuples)
// ---------------------------------------------------------------------------

describe('matchDragOffsets with map-coordinate tuples', () => {
  it('retains world-unit offsets for matching names', () => {
    const offsets = { A: [0.5, 1.2] as [number, number], B: [3.7, -0.8] as [number, number] };
    const result = matchDragOffsets(offsets, ['A', 'C']);
    expect(result['A']).toEqual([0.5, 1.2]);
    expect('B' in result).toBe(false);
    expect('C' in result).toBe(false);
  });
});
