/**
 * Point annotations (A4) and title/subtitle overlay (A1).
 *
 * Annotations are keyed by a stable string (row index, or an ID column value) so they
 * survive DataFrame sorting and filtering (D10). The callout box is positioned at a
 * screen-pixel offset from the annotated point each frame.
 */

import type { Atlas } from '../atlas.svelte';
import type { AnnotationData, TitleOptions } from '../../shared/protocol';
import { vscode } from '../vscode';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_TITLE: TitleOptions = {
  title: '',
  subtitle: '',
  fontFamily: '',
  fontSize: 24,
  color: '',
  logoData: '',
  logoWidth: 0,
};

/** Default screen-pixel offset for a new callout box: 60 px right, 0 px down. */
const DEFAULT_OFFSET_X = 60;
const DEFAULT_OFFSET_Y = -20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Look up the world-space coordinates of a prepared-row index. */
function worldCoordsFor(atlas: Atlas, prepIdx: number): [number, number] | null {
  if (atlas.allXY && prepIdx < atlas.placedRows) {
    return [atlas.allXY[2 * prepIdx], atlas.allXY[2 * prepIdx + 1]];
  }
  if (atlas.anchorXY) {
    // For anchor-only mode: prepIdx is the anchor index.
    return [atlas.anchorXY[2 * prepIdx], atlas.anchorXY[2 * prepIdx + 1]];
  }
  return null;
}

/** Build a stable rowKey string for the annotation. */
export function rowKey(atlas: Atlas, row: number): string {
  if (atlas.annotateIdColumn !== null && atlas.annotateIdColumn !== undefined) {
    // We don't have the ID column value here, fall back to row index.
    // The caller can call rowKeyFromValue when it has the value from the hover cache.
  }
  return String(row);
}

/** Build a rowKey from an ID-column value (string or number). */
export function rowKeyFromValue(value: string | number): string {
  return String(value);
}

/** Get color for a prepared-row index from colorsAnchors or colorsAll. */
function pointColor(atlas: Atlas, prepIdx: number): string {
  let r = 128;
  let g = 128;
  let b = 128;
  let arr: Uint8Array | null = null;
  if (atlas.allXY && prepIdx < atlas.placedRows && atlas.colorsAll) {
    arr = atlas.colorsAll;
  } else if (atlas.colorsAnchors) {
    arr = atlas.colorsAnchors;
  }
  if (arr && prepIdx < arr.length / 4) {
    r = arr[4 * prepIdx];
    g = arr[4 * prepIdx + 1];
    b = arr[4 * prepIdx + 2];
  }
  return `rgba(${r},${g},${b},1)`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add a point annotation for the currently hovered/clicked point.
 * Uses data from atlas.pendingHover / atlas.tooltip.
 * Returns the new annotation id, or null if no point is active.
 */
export function addAnnotation(atlas: Atlas, prepIdx: number, row: number, worldX: number, worldY: number, text: string): AnnotationData | null {
  const key = rowKey(atlas, row);
  const id = `ann-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // Determine style: image if pixel columns are shown, plain otherwise.
  const style: AnnotationData['style'] =
    atlas.view.images && atlas.imageColumns !== null ? 'image' : 'plain';

  const ann: AnnotationData = {
    id,
    rowKey: key,
    row,
    text: text || `Row ${row}`,
    style,
    worldX,
    worldY,
    offsetX: DEFAULT_OFFSET_X,
    offsetY: DEFAULT_OFFSET_Y,
    color: pointColor(atlas, prepIdx),
  };

  const next = new Map(atlas.annotations);
  next.set(id, ann);
  atlas.annotations = next;

  // For image-style annotations: kick off an async pixel fetch.
  if (style === 'image') {
    requestAnnotationPixels(atlas, id, prepIdx);
  }

  return ann;
}

/** Remove a single annotation by id. */
export function removeAnnotation(atlas: Atlas, id: string): void {
  const next = new Map(atlas.annotations);
  next.delete(id);
  atlas.annotations = next;
}

/** Remove all annotations. */
export function clearAnnotations(atlas: Atlas): void {
  atlas.annotations = new Map();
}

/** Update the pixel data of an image annotation (called async when rows response arrives). */
export function updateAnnotationPixels(
  atlas: Atlas,
  annId: string,
  pixels: (number | null)[],
  imageShape: [number, number] | null | undefined,
): void {
  const ann = atlas.annotations.get(annId);
  if (!ann) return;
  const next = new Map(atlas.annotations);
  next.set(annId, { ...ann, imagePixels: pixels, imageShape: imageShape ?? undefined });
  atlas.annotations = next;
}

/**
 * Request pixel data for an image annotation.
 * Checks the rowCache first; if not available, sends a targeted `rows` request and
 * registers a callback to update the annotation when the response arrives.
 */
export function requestAnnotationPixels(atlas: Atlas, annId: string, prepIdx: number): void {
  // Check the row cache first (the hover may have already fetched it).
  const cached = atlas.rowCache.get(prepIdx);
  if (cached?.image) {
    updateAnnotationPixels(atlas, annId, cached.image, atlas.imageShape);
    return;
  }
  // Register callback so onRows can fire it when the response arrives.
  const existing = atlas.annotationPixelPending.get(prepIdx) ?? [];
  existing.push((pixels) => updateAnnotationPixels(atlas, annId, pixels, atlas.imageShape));
  atlas.annotationPixelPending.set(prepIdx, existing);
  // Send a targeted rows request with imageColumns so the kernel returns pixel data.
  // We do NOT touch hoverInflight; this seq won't trigger a tooltip update.
  const seq = ++atlas.annRowsSeq;
  const imageCols = atlas.imageColumns?.indices;
  vscode.post({ type: 'rows', seq, indices: [prepIdx], imageColumns: imageCols?.length ? imageCols : undefined });
}

/** Update the drag offset of an annotation. */
export function updateAnnotationOffset(atlas: Atlas, id: string, offsetX: number, offsetY: number): void {
  const ann = atlas.annotations.get(id);
  if (!ann) return;
  const next = new Map(atlas.annotations);
  next.set(id, { ...ann, offsetX, offsetY });
  atlas.annotations = next;
}

/** Update the text of an annotation. */
export function updateAnnotationText(atlas: Atlas, id: string, text: string): void {
  const ann = atlas.annotations.get(id);
  if (!ann) return;
  const next = new Map(atlas.annotations);
  next.set(id, { ...ann, text });
  atlas.annotations = next;
}

/** Update the style of an annotation. */
export function updateAnnotationStyle(atlas: Atlas, id: string, style: AnnotationData['style']): void {
  const ann = atlas.annotations.get(id);
  if (!ann) return;
  const next = new Map(atlas.annotations);
  next.set(id, { ...ann, style });
  atlas.annotations = next;
}

/** Export all annotations as a JSON string. */
export function exportAnnotationsJson(atlas: Atlas): string {
  const arr = [...atlas.annotations.values()];
  return JSON.stringify(arr, null, 2);
}

/** Import annotations from a JSON string (replaces current annotations). */
export function importAnnotationsJson(atlas: Atlas, json: string): void {
  const arr = JSON.parse(json) as AnnotationData[];
  const next = new Map<string, AnnotationData>();
  for (const ann of arr) {
    if (ann && typeof ann.id === 'string' && typeof ann.rowKey === 'string') {
      next.set(ann.id, ann);
    }
  }
  atlas.annotations = next;
}

/** Project world coordinates to CSS-pixel screen coordinates.
 *  Returns null when the renderer is not ready. */
export function projectToScreen(atlas: Atlas, wx: number, wy: number): [number, number] | null {
  return atlas.renderer ? atlas.renderer.projectWorld(wx, wy) : null;
}

/** Handle a click in annotate tool mode.
 *  Returns the new annotation, or null when no point is under the cursor. */
export function handleAnnotateClick(atlas: Atlas, titleText: string): AnnotationData | null {
  const ph = atlas.pendingHover;
  if (!ph || ph.prepIdx === undefined) return null;
  const prepIdx = ph.prepIdx;
  const row = atlas.hit?.map(prepIdx) ?? prepIdx;
  const coords = worldCoordsFor(atlas, prepIdx);
  if (!coords) return null;
  const [wx, wy] = coords;

  // Prefer the hover title (from texts store) or fall back to "Row N".
  let text = titleText;
  if (!text && atlas.textsStore.ready) {
    text = atlas.textsStore.get(prepIdx) ?? '';
  }
  if (!text) {
    text = `Row ${row}`;
  }
  return addAnnotation(atlas, prepIdx, row, wx, wy, text);
}

/** Create an annotation from the pinned hover card data.
 *  Looks up the prepared-row index from the pinnedCard and uses its title/row.
 *  If the card has pixel image data, it is copied directly to the annotation. */
export function addAnnotationFromCard(
  atlas: Atlas,
  card: {
    row: number;
    title?: string;
    preparedIdx: number;
    x: number;
    y: number;
    image?: (number | null)[];
    imageUri?: string;
  },
): AnnotationData | null {
  const prepIdx = card.preparedIdx;
  const row = card.row;
  const coords = worldCoordsFor(atlas, prepIdx);
  if (!coords) return null;
  const [wx, wy] = coords;
  const text = card.title || `Row ${row}`;
  const ann = addAnnotation(atlas, prepIdx, row, wx, wy, text);
  if (!ann) return null;

  // If the card already has pixel data, store it immediately (skips the async fetch).
  if (ann.style === 'image' && card.image) {
    updateAnnotationPixels(atlas, ann.id, card.image, atlas.imageShape);
  }
  return ann;
}
