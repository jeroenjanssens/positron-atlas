/**
 * Shape operations (plan item 8, wave B4).
 *
 * Business logic for adding, removing, updating and exporting shapes.
 * State (atlas.shapes) lives in Atlas; this module provides the operations.
 */

import type { Atlas } from '../atlas.svelte';
import { vscode, typedArrayToBytes } from '../vscode';
import { formatCount } from '../logic';
import {
  type Shape,
  pointsInShape,
  exportShapesJson,
  importShapesJson,
} from './shapes';
import { BRUSH_ERASER_CODE, BRUSH_PALETTE } from './brush';
import { recordHistory } from './undo';
import { refreshBrushOverlay } from './brushOps';

/** Add a shape and record as undoable. */
export function addShape(atlas: Atlas, shape: Shape): void {
  const before = atlas.shapes.slice();
  const after = [...before, shape];
  recordHistory(atlas, {
    label: `Add ${shape.kind} shape`,
    undo: () => { atlas.shapes = before; atlas.renderer?.setShapes(before); },
    redo: () => { atlas.shapes = after; atlas.renderer?.setShapes(after); },
  });
  atlas.shapes = after;
  atlas.renderer?.setShapes(after);
  atlas.persist();
}

/** Remove a shape by id and record as undoable. */
export function removeShape(atlas: Atlas, id: string): void {
  const before = atlas.shapes.slice();
  const after = before.filter((s) => s.id !== id);
  if (after.length === before.length) return;
  recordHistory(atlas, {
    label: 'Remove shape',
    undo: () => { atlas.shapes = before; atlas.renderer?.setShapes(before); },
    redo: () => { atlas.shapes = after; atlas.renderer?.setShapes(after); },
  });
  atlas.shapes = after;
  atlas.renderer?.setShapes(after);
  atlas.persist();
}

/**
 * Commit a shape edit that was previewed live (live previews already updated atlas.shapes).
 * Uses `origShape` as the before-state so undo correctly restores the shape to its pre-edit
 * appearance even after many intermediate live-preview updates.
 */
export function commitShapeEdit(atlas: Atlas, id: string, origShape: Shape, finalPatch: Partial<Shape>): void {
  // 'before' = current shapes array but with the ORIGINAL shape restored at this id
  const before = atlas.shapes.map((s) => s.id === id ? origShape : s);
  // 'after' = apply final patch on top of whatever the live preview left
  const after = atlas.shapes.map((s) => s.id === id ? { ...s, ...finalPatch } as Shape : s);
  recordHistory(atlas, {
    label: `Edit ${origShape.kind} shape`,
    undo: () => { atlas.shapes = before; atlas.renderer?.setShapes(before); },
    redo: () => { atlas.shapes = after; atlas.renderer?.setShapes(after); },
    coalesceKey: `shape:edit:${id}`,
  });
  atlas.shapes = after;
  atlas.renderer?.setShapes(after);
  atlas.persist();
}

/** Update a shape (move, resize, style change, etc.) and record as undoable. */
export function updateShape(atlas: Atlas, id: string, patch: Partial<Shape>): void {
  const before = atlas.shapes.slice();
  const after = before.map((s) => (s.id === id ? { ...s, ...patch } as Shape : s));
  const changed = after.find((s) => s.id === id);
  if (!changed) return;
  recordHistory(atlas, {
    label: `Edit ${changed.kind} shape`,
    undo: () => { atlas.shapes = before; atlas.renderer?.setShapes(before); },
    redo: () => { atlas.shapes = after; atlas.renderer?.setShapes(after); },
    coalesceKey: `shape:edit:${id}`,
  });
  atlas.shapes = after;
  atlas.renderer?.setShapes(after);
  atlas.persist();
}

/**
 * Tag all points inside a closed shape with the current brush class.
 * Uses the existing `writeLabels` path (via atlas.commitBrush).
 */
export function tagPointsInShape(atlas: Atlas, shapeId: string, column: string): void {
  if (!atlas.anchorXY || !atlas.prepared) return;
  const shape = atlas.shapes.find((s) => s.id === shapeId);
  if (!shape) return;

  const n = atlas.prepared.nAnchors;
  const hits = pointsInShape(atlas.anchorXY, n, shape);
  if (!hits.length) {
    atlas.flash('No points inside the selected shape.');
    return;
  }

  // Build pending codes buffer and paint the hits.
  const { BRUSH_ERASER_CODE: eraser } = { BRUSH_ERASER_CODE };
  const codes = new Uint16Array(n).fill(eraser);
  const classIdx = atlas.brush.currentClass;
  for (const i of hits) codes[i] = classIdx;

  // Store as pending and open the write dialog by calling commitBrush.
  const before = atlas.pendingBrushCodes ? atlas.pendingBrushCodes.slice() : null;
  atlas.pendingBrushCodes = codes;
  refreshBrushOverlay(atlas);

  const names = atlas.brush.classes.slice();
  vscode.post({
    type: 'writeLabels',
    codes: typedArrayToBytes(codes),
    names,
    column: column.trim() || 'shape_tag',
    keepOthers: true,
    description: `Tag ${formatCount(hits.length)} points inside ${shape.kind} shape as "${names[classIdx] ?? 'class'}"`,
  });

  // After writing (or cancelling), restore previous pending state via undo.
  recordHistory(atlas, {
    label: `Tag points in ${shape.kind} as "${names[classIdx] ?? 'class'}"`,
    undo: () => {
      atlas.pendingBrushCodes = before;
      if (before) refreshBrushOverlay(atlas); else atlas.renderer?.clearBrushOverlay();
    },
    redo: () => {
      atlas.pendingBrushCodes = codes;
      refreshBrushOverlay(atlas);
    },
  });
}

/** Move a shape to the front (top of stack) and record as undoable. */
export function bringToFront(atlas: Atlas, id: string): void {
  const before = atlas.shapes.slice();
  const idx = before.findIndex((s) => s.id === id);
  if (idx < 0 || idx === before.length - 1) return;
  const after = [...before.slice(0, idx), ...before.slice(idx + 1), before[idx]];
  recordHistory(atlas, {
    label: 'Bring to front',
    undo: () => { atlas.shapes = before; atlas.renderer?.setShapes(before); },
    redo: () => { atlas.shapes = after; atlas.renderer?.setShapes(after); },
  });
  atlas.shapes = after;
  atlas.renderer?.setShapes(after);
  atlas.persist();
}

/** Move a shape to the back (bottom of stack) and record as undoable. */
export function sendToBack(atlas: Atlas, id: string): void {
  const before = atlas.shapes.slice();
  const idx = before.findIndex((s) => s.id === id);
  if (idx <= 0) return;
  const after = [before[idx], ...before.slice(0, idx), ...before.slice(idx + 1)];
  recordHistory(atlas, {
    label: 'Send to back',
    undo: () => { atlas.shapes = before; atlas.renderer?.setShapes(before); },
    redo: () => { atlas.shapes = after; atlas.renderer?.setShapes(after); },
  });
  atlas.shapes = after;
  atlas.renderer?.setShapes(after);
  atlas.persist();
}

/** Export all shapes to a JSON string (versioned). */
export function exportShapes(atlas: Atlas): string {
  return JSON.stringify(exportShapesJson(atlas.shapes), null, 2);
}

/** Import shapes from a JSON string (versioned); merges with existing shapes. */
export function importShapes(atlas: Atlas, json: string): void {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return; }
  const imported = importShapesJson(raw);
  if (!imported.length) return;
  const before = atlas.shapes.slice();
  const after = [...before, ...imported];
  recordHistory(atlas, {
    label: `Import ${imported.length} shape(s)`,
    undo: () => { atlas.shapes = before; atlas.renderer?.setShapes(before); },
    redo: () => { atlas.shapes = after; atlas.renderer?.setShapes(after); },
  });
  atlas.shapes = after;
  atlas.renderer?.setShapes(after);
  atlas.persist();
}
