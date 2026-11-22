/**
 * Unit tests for point annotation logic (A4):
 *   - offset math (addAnnotation sets default offset, updateAnnotationOffset updates it)
 *   - JSON export / import round-trip
 *   - annotation keying by row index and by ID column value
 */

import { describe, expect, it } from 'vitest';
import {
  addAnnotation,
  removeAnnotation,
  clearAnnotations,
  updateAnnotationOffset,
  updateAnnotationText,
  exportAnnotationsJson,
  importAnnotationsJson,
  rowKey,
  rowKeyFromValue,
  DEFAULT_TITLE,
} from '../src/webview/atlas/annotations';
import type { AnnotationData, TitleOptions } from '../src/shared/protocol';

// ---------------------------------------------------------------------------
// Minimal Atlas stub
// ---------------------------------------------------------------------------

function makeAtlas(partial: Partial<{
  annotations: Map<string, AnnotationData>;
  annotateIdColumn: number | null;
  view: { images: boolean };
  imageColumns: null;
  anchorXY: Float32Array;
  allXY: Float32Array | null;
  placedRows: number;
  colorsAnchors: Uint8Array | null;
  colorsAll: Uint8Array | null;
  hit: null;
  textsStore: { ready: boolean; get: (i: number) => string | null };
  renderer: null;
  titleOverlay: TitleOptions;
  pendingHover: null;
}> = {}) {
  return {
    annotations: new Map<string, AnnotationData>(),
    annotateIdColumn: null as number | null,
    view: { images: false },
    imageColumns: null,
    anchorXY: new Float32Array([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]),
    allXY: null as Float32Array | null,
    placedRows: 0,
    colorsAnchors: null as Uint8Array | null,
    colorsAll: null as Uint8Array | null,
    hit: null,
    textsStore: { ready: false, get: () => null },
    renderer: null,
    titleOverlay: { ...DEFAULT_TITLE },
    pendingHover: null,
    ...partial,
  } as any;
}

// ---------------------------------------------------------------------------
// addAnnotation / defaults
// ---------------------------------------------------------------------------

describe('addAnnotation', () => {
  it('adds an annotation with the given text and returns it', () => {
    const atlas = makeAtlas();
    const ann = addAnnotation(atlas, 0, 42, 1.5, 2.5, 'Hello');
    expect(ann).not.toBeNull();
    expect(ann!.text).toBe('Hello');
    expect(ann!.row).toBe(42);
    expect(ann!.worldX).toBe(1.5);
    expect(ann!.worldY).toBe(2.5);
  });

  it('assigns a default non-zero offset', () => {
    const atlas = makeAtlas();
    const ann = addAnnotation(atlas, 0, 0, 0, 0, 'Test');
    expect(ann).not.toBeNull();
    // Default offset should be non-zero (60, -20).
    expect(ann!.offsetX).not.toBe(0);
  });

  it('stores the annotation in atlas.annotations', () => {
    const atlas = makeAtlas();
    const ann = addAnnotation(atlas, 0, 5, 1, 1, 'Test');
    expect(atlas.annotations.size).toBe(1);
    expect(atlas.annotations.get(ann!.id)).toBeDefined();
  });

  it('assigns unique ids for multiple annotations', () => {
    const atlas = makeAtlas();
    const a1 = addAnnotation(atlas, 0, 1, 0, 0, 'A');
    const a2 = addAnnotation(atlas, 1, 2, 1, 1, 'B');
    expect(a1!.id).not.toBe(a2!.id);
    expect(atlas.annotations.size).toBe(2);
  });

  it('defaults style to plain when not in image mode', () => {
    const atlas = makeAtlas({ view: { images: false } });
    const ann = addAnnotation(atlas, 0, 0, 0, 0, 'txt');
    expect(ann!.style).toBe('plain');
  });
});

// ---------------------------------------------------------------------------
// removeAnnotation / clearAnnotations
// ---------------------------------------------------------------------------

describe('removeAnnotation', () => {
  it('removes the specified annotation', () => {
    const atlas = makeAtlas();
    const ann = addAnnotation(atlas, 0, 1, 0, 0, 'A')!;
    addAnnotation(atlas, 1, 2, 1, 1, 'B');
    expect(atlas.annotations.size).toBe(2);
    removeAnnotation(atlas, ann.id);
    expect(atlas.annotations.size).toBe(1);
    expect(atlas.annotations.has(ann.id)).toBe(false);
  });

  it('does nothing when id is unknown', () => {
    const atlas = makeAtlas();
    addAnnotation(atlas, 0, 1, 0, 0, 'A');
    removeAnnotation(atlas, 'nonexistent');
    expect(atlas.annotations.size).toBe(1);
  });
});

describe('clearAnnotations', () => {
  it('removes all annotations', () => {
    const atlas = makeAtlas();
    addAnnotation(atlas, 0, 1, 0, 0, 'A');
    addAnnotation(atlas, 1, 2, 1, 1, 'B');
    clearAnnotations(atlas);
    expect(atlas.annotations.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// updateAnnotationOffset
// ---------------------------------------------------------------------------

describe('updateAnnotationOffset', () => {
  it('updates offsetX and offsetY', () => {
    const atlas = makeAtlas();
    const ann = addAnnotation(atlas, 0, 1, 0, 0, 'A')!;
    updateAnnotationOffset(atlas, ann.id, 120, -40);
    const updated = atlas.annotations.get(ann.id)!;
    expect(updated.offsetX).toBe(120);
    expect(updated.offsetY).toBe(-40);
  });

  it('does not change other fields', () => {
    const atlas = makeAtlas();
    const ann = addAnnotation(atlas, 0, 1, 2, 3, 'Hello')!;
    updateAnnotationOffset(atlas, ann.id, 50, 50);
    const updated = atlas.annotations.get(ann.id)!;
    expect(updated.text).toBe('Hello');
    expect(updated.worldX).toBe(2);
    expect(updated.worldY).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// JSON export / import round-trip
// ---------------------------------------------------------------------------

describe('exportAnnotationsJson / importAnnotationsJson', () => {
  it('round-trips annotations through JSON', () => {
    const atlas = makeAtlas();
    const a1 = addAnnotation(atlas, 0, 10, 1, 2, 'First')!;
    const a2 = addAnnotation(atlas, 1, 20, 3, 4, 'Second')!;
    updateAnnotationOffset(atlas, a1.id, 100, -30);

    const json = exportAnnotationsJson(atlas);
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);

    // Import into a fresh atlas.
    const atlas2 = makeAtlas();
    importAnnotationsJson(atlas2, json);
    expect(atlas2.annotations.size).toBe(2);

    const r1 = atlas2.annotations.get(a1.id)!;
    expect(r1.text).toBe('First');
    expect(r1.offsetX).toBe(100);
    expect(r1.offsetY).toBe(-30);
    expect(r1.worldX).toBe(1);
    expect(r1.worldY).toBe(2);

    const r2 = atlas2.annotations.get(a2.id)!;
    expect(r2.text).toBe('Second');
    expect(r2.row).toBe(20);
  });

  it('replaces existing annotations on import', () => {
    const atlas = makeAtlas();
    addAnnotation(atlas, 0, 1, 0, 0, 'Old');
    const atlas2 = makeAtlas();
    addAnnotation(atlas2, 0, 2, 1, 1, 'New');
    importAnnotationsJson(atlas, exportAnnotationsJson(atlas2));
    expect(atlas.annotations.size).toBe(1);
    const ann = [...atlas.annotations.values()][0];
    expect(ann.text).toBe('New');
  });

  it('ignores malformed entries during import', () => {
    const atlas = makeAtlas();
    const badJson = JSON.stringify([
      { id: 'ok-id', rowKey: '5', row: 5, text: 'Valid', style: 'plain', worldX: 0, worldY: 0, offsetX: 0, offsetY: 0 },
      { rowKey: 'missing-id' },  // no id
      null,
    ]);
    importAnnotationsJson(atlas, badJson);
    expect(atlas.annotations.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// rowKey / rowKeyFromValue
// ---------------------------------------------------------------------------

describe('rowKey', () => {
  it('uses row index as string when no ID column configured', () => {
    const atlas = makeAtlas({ annotateIdColumn: null });
    expect(rowKey(atlas, 42)).toBe('42');
  });
});

describe('rowKeyFromValue', () => {
  it('converts a string value to a string key', () => {
    expect(rowKeyFromValue('hello')).toBe('hello');
  });

  it('converts a numeric value to a string key', () => {
    expect(rowKeyFromValue(123)).toBe('123');
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_TITLE
// ---------------------------------------------------------------------------

describe('DEFAULT_TITLE', () => {
  it('has empty title and subtitle by default', () => {
    expect(DEFAULT_TITLE.title).toBe('');
    expect(DEFAULT_TITLE.subtitle).toBe('');
  });

  it('has a positive default font size', () => {
    expect(DEFAULT_TITLE.fontSize).toBeGreaterThan(0);
  });
});
