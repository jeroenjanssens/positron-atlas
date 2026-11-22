/**
 * B3/Item 9: "Symbol by" a categorical column (≤ 8 categories).
 *
 * Per-point u16 category codes drive symbol shape selection in the renderer.
 * setSymbolColumn() posts a symbolCodes request; onSymbolCodes() stores the
 * result.  reapplySymbols() rebuilds the per-anchor subset after prepare/recolor.
 */

import type { Atlas } from '../atlas.svelte';
import type { FileRef } from '../../shared/protocol';
import { vscode, fetchTyped } from '../vscode';
import { gatherU16 } from './utils';

export function setSymbolColumn(atlas: Atlas, col: number | null): void {
  atlas.symbolColumn = col;
  atlas.symbolValues = null;
  atlas.symbolValuesAnchors = null;
  atlas.symbolCategories = [];
  if (col === null) {
    atlas.render();
  } else {
    vscode.post({ type: 'symbolCodes', column: col });
  }
}

export async function onSymbolCodes(
  atlas: Atlas,
  column: number,
  file: FileRef,
  categories: string[],
): Promise<void> {
  if (column !== atlas.symbolColumn) return; // stale
  const values = await fetchTyped(file.uri, file.dtype);
  if (!(values instanceof Uint16Array) || values.length !== atlas.nKept) return;
  atlas.symbolValues = values;
  atlas.symbolCategories = categories;
  reapplySymbols(atlas);
}

/** Rebuild the anchor-only subset of symbolValues (mirrors gatherU16 for colorsAnchors). */
export function reapplySymbols(atlas: Atlas): void {
  if (!atlas.symbolValues || !atlas.prepared || !atlas.anchorPos) {
    atlas.symbolValuesAnchors = null;
    atlas.render();
    return;
  }
  atlas.symbolValuesAnchors = atlas.prepared.needsProjection
    ? gatherU16(atlas.symbolValues, atlas.anchorPos)
    : atlas.symbolValues;
  atlas.render();
}
