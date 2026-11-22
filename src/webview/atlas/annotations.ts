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

/** B5: push current annotations to the renderer so the deck.gl leader-lines layer updates. */
function syncRenderer(atlas: Atlas): void {
  atlas.renderer?.setAnnotations(atlas.annotations);
}

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

/**
 * Default callout box offset in screen pixels (used only to derive a world offset).
 * B5: the stored offset is in map (world) coordinates.
 */
const DEFAULT_OFFSET_X_PX = 60;
const DEFAULT_OFFSET_Y_PX = -20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a smart default callout offset in map coordinates (B5).
 * Flips left when the annotated point is in the right 40% of the plot area,
 * and flips downward when it is in the top 30%.
 *
 * Returns a [dx, dy] in world units such that
 *   projectWorld(worldX + dx, worldY + dy) ≈ callout box top-left at the current zoom.
 * World y is up, so a positive dy moves the box up on screen.
 */
export function smartDefaultOffset(atlas: Atlas, worldX: number, worldY: number): [number, number] {
  const wpp = atlas.renderer?.worldPerPixel() ?? 1;
  const pt = atlas.renderer?.projectWorld(worldX, worldY);
  const W = (typeof window !== 'undefined' ? window.innerWidth : 800);
  const H = (typeof window !== 'undefined' ? window.innerHeight : 600);
  const legendW = atlas.legendWidth?.() ?? 0;
  const plotW = W - legendW;

  let ox_px = DEFAULT_OFFSET_X_PX;
  let oy_px = DEFAULT_OFFSET_Y_PX; // negative = up on screen

  if (pt) {
    const inRightZone = pt[0] > plotW * 0.6;
    const inTopZone = pt[1] < H * 0.3;
    ox_px = inRightZone ? -(DEFAULT_OFFSET_X_PX + 80) : DEFAULT_OFFSET_X_PX;
    oy_px = inTopZone ? 40 : DEFAULT_OFFSET_Y_PX;
  }

  // Convert screen pixels to world units.
  // Screen x right  → world x right  (+)
  // Screen y down   → world y up      (flip sign)
  return [ox_px * wpp, -oy_px * wpp];
}

/** Create a data-URL thumbnail from a loaded image URI (max maxSize px on either side). */
function makeThumbnail(uri: string, maxSize = 160): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const scale = Math.min(maxSize / (img.naturalWidth || 1), maxSize / (img.naturalHeight || 1), 1);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d')!;
        g.drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/png'));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = uri;
  });
}

/** Post an `image` message to the host for the given prepared-row's imageUrlColumn value. */
function postImageRequestForAnnotation(atlas: Atlas, prepIdx: number, values: [string, string][]): void {
  const colIdx = atlas.tooltipOpts?.imageUrlColumn;
  if (colIdx == null) return;
  const colName = atlas.describe?.columns[colIdx]?.name;
  if (!colName) return;
  const entry = values.find(([k]) => k === colName);
  if (!entry || !entry[1]) return;
  if (atlas.loadImagesFromUrls === 'never') return;
  vscode.post({ type: 'image', row: prepIdx, src: entry[1] });
}

/** Look up the world-space coordinates of a prepared-row index. */
function worldCoordsFor(atlas: Atlas, prepIdx: number): [number, number] | null {
  const nd = atlas.dims === 3 ? 3 : 2;
  if (atlas.allXY && prepIdx < atlas.placedRows) {
    return [atlas.allXY[nd * prepIdx], atlas.allXY[nd * prepIdx + 1]];
  }
  if (atlas.anchorXY) {
    // For anchor-only mode: prepIdx is the anchor index.
    return [atlas.anchorXY[nd * prepIdx], atlas.anchorXY[nd * prepIdx + 1]];
  }
  return null;
}

/** Returns [x, y, z] in 3D mode, or [x, y, 0] in 2D mode. */
function worldCoords3DFor(atlas: Atlas, prepIdx: number): [number, number, number] | null {
  const nd = atlas.dims === 3 ? 3 : 2;
  if (atlas.allXY && prepIdx < atlas.placedRows) {
    const x = atlas.allXY[nd * prepIdx];
    const y = atlas.allXY[nd * prepIdx + 1];
    const z = nd === 3 ? atlas.allXY[nd * prepIdx + 2] : 0;
    return [x, y, z];
  }
  if (atlas.anchorXY) {
    const x = atlas.anchorXY[nd * prepIdx];
    const y = atlas.anchorXY[nd * prepIdx + 1];
    const z = nd === 3 ? atlas.anchorXY[nd * prepIdx + 2] : 0;
    return [x, y, z];
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
export function addAnnotation(atlas: Atlas, prepIdx: number, row: number, worldX: number, worldY: number, text: string, worldZ?: number): AnnotationData | null {
  const key = rowKey(atlas, row);
  const id = `ann-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // Determine style: image if pixel columns are shown OR if an image-URL column is configured.
  const hasPixels = atlas.view.images && atlas.imageColumns !== null;
  const hasImageUrl = atlas.tooltipOpts?.imageUrlColumn !== null && atlas.tooltipOpts?.imageUrlColumn !== undefined;
  const style: AnnotationData['style'] = (hasPixels || hasImageUrl) ? 'image' : 'plain';

  const [ox, oy] = smartDefaultOffset(atlas, worldX, worldY);

  const ann: AnnotationData = {
    id,
    rowKey: key,
    row,
    text: text || `Row ${row}`,
    style,
    worldX,
    worldY,
    ...(worldZ !== undefined && worldZ !== 0 ? { worldZ } : {}),
    offsetX: ox,
    offsetY: oy,
    offsetVersion: 'v2map',  // B5: offsets are in map (world) coordinates
    color: pointColor(atlas, prepIdx),
  };

  const next = new Map(atlas.annotations);
  next.set(id, ann);
  atlas.annotations = next;
  syncRenderer(atlas);

  // For image-style annotations: kick off an async fetch.
  if (style === 'image') {
    if (hasPixels) {
      requestAnnotationPixels(atlas, id, prepIdx);
    } else if (hasImageUrl) {
      requestAnnotationImageUri(atlas, id, prepIdx);
    }
  }

  // Record undo: removing the annotation reverts the add.
  const label = ann.text ? `Add annotation "${ann.text}"` : 'Add annotation';
  atlas.recordHistory({
    label,
    undo: () => {
      const m = new Map(atlas.annotations);
      m.delete(id);
      atlas.annotations = m;
      syncRenderer(atlas);
    },
    redo: () => {
      const m = new Map(atlas.annotations);
      m.set(id, ann);
      atlas.annotations = m;
      syncRenderer(atlas);
    },
  });

  return ann;
}

/** Remove a single annotation by id. */
export function removeAnnotation(atlas: Atlas, id: string): void {
  const ann = atlas.annotations.get(id);
  const next = new Map(atlas.annotations);
  next.delete(id);
  atlas.annotations = next;
  syncRenderer(atlas);
  if (ann) {
    const label = ann.text ? `Remove annotation "${ann.text}"` : 'Remove annotation';
    atlas.recordHistory({
      label,
      undo: () => {
        const m = new Map(atlas.annotations);
        m.set(id, ann);
        atlas.annotations = m;
        syncRenderer(atlas);
      },
      redo: () => {
        const m = new Map(atlas.annotations);
        m.delete(id);
        atlas.annotations = m;
        syncRenderer(atlas);
      },
    });
  }
}

/** Remove all annotations. */
export function clearAnnotations(atlas: Atlas): void {
  const before = new Map(atlas.annotations);
  atlas.annotations = new Map();
  syncRenderer(atlas);
  if (before.size > 0) {
    atlas.recordHistory({
      label: 'Clear all annotations',
      undo: () => { atlas.annotations = new Map(before); syncRenderer(atlas); },
      redo: () => { atlas.annotations = new Map(); syncRenderer(atlas); },
    });
  }
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
  syncRenderer(atlas);
}

/** Update the data-URL thumbnail of an image-URL annotation. */
export function updateAnnotationImageDataUrl(atlas: Atlas, annId: string, dataUrl: string): void {
  const ann = atlas.annotations.get(annId);
  if (!ann) return;
  const next = new Map(atlas.annotations);
  next.set(annId, { ...ann, imageDataUrl: dataUrl });
  atlas.annotations = next;
  syncRenderer(atlas);
}

/**
 * Request the image URI for an image-URL annotation (D5).
 * Checks the rowCache for an already-fetched imageUri or values; otherwise requests
 * rows and chains an `image` host request.  When the imageUri arrives via `onImageUri`,
 * a thumbnail is created and stored on the annotation.
 */
export function requestAnnotationImageUri(atlas: Atlas, annId: string, prepIdx: number): void {
  // Case 1: imageUri already in row cache — create thumbnail immediately.
  const cached = atlas.rowCache.get(prepIdx);
  if (cached?.imageUri) {
    void makeThumbnail(cached.imageUri).then((url) => {
      if (url) updateAnnotationImageDataUrl(atlas, annId, url);
    });
    return;
  }

  // Register a callback to fire when imageUri arrives via onImageUri.
  const uriCbs = atlas.annotationImageUriPending.get(prepIdx) ?? [];
  uriCbs.push((uri: string) => {
    void makeThumbnail(uri).then((url) => {
      if (url) updateAnnotationImageDataUrl(atlas, annId, url);
    });
  });
  atlas.annotationImageUriPending.set(prepIdx, uriCbs);

  // Case 2: row values are in cache — post image request now.
  if (cached?.values) {
    postImageRequestForAnnotation(atlas, prepIdx, cached.values);
    return;
  }

  // Case 3: row values not cached — request rows first, then chain image request.
  const rowCbs = atlas.annotationRowsPending.get(prepIdx) ?? [];
  rowCbs.push((row) => postImageRequestForAnnotation(atlas, prepIdx, row.values));
  atlas.annotationRowsPending.set(prepIdx, rowCbs);
  const seq = ++atlas.annRowsSeq;
  const colIdx = atlas.tooltipOpts?.imageUrlColumn;
  const cols = typeof colIdx === 'number' ? [colIdx] : undefined;
  vscode.post({ type: 'rows', seq, indices: [prepIdx], columns: cols });
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

/** Update the callout box offset of an annotation (B5: offset is in map coordinates). */
export function updateAnnotationOffset(atlas: Atlas, id: string, offsetX: number, offsetY: number): void {
  const ann = atlas.annotations.get(id);
  if (!ann) return;
  const next = new Map(atlas.annotations);
  next.set(id, { ...ann, offsetX, offsetY, offsetVersion: 'v2map' });
  atlas.annotations = next;
  syncRenderer(atlas);
}

/** Update the text of an annotation. */
export function updateAnnotationText(atlas: Atlas, id: string, text: string): void {
  const ann = atlas.annotations.get(id);
  if (!ann) return;
  const oldText = ann.text;
  const next = new Map(atlas.annotations);
  next.set(id, { ...ann, text });
  atlas.annotations = next;
  syncRenderer(atlas);
  atlas.recordHistory({
    label: 'Edit annotation text',
    undo: () => {
      const a = atlas.annotations.get(id);
      if (!a) return;
      const m = new Map(atlas.annotations);
      m.set(id, { ...a, text: oldText });
      atlas.annotations = m;
      syncRenderer(atlas);
    },
    redo: () => {
      const a = atlas.annotations.get(id);
      if (!a) return;
      const m = new Map(atlas.annotations);
      m.set(id, { ...a, text });
      atlas.annotations = m;
      syncRenderer(atlas);
    },
    coalesceKey: `ann-text:${id}`,
  });
}

/** Update the style of an annotation. */
export function updateAnnotationStyle(atlas: Atlas, id: string, style: AnnotationData['style']): void {
  const ann = atlas.annotations.get(id);
  if (!ann) return;
  const oldStyle = ann.style;
  const next = new Map(atlas.annotations);
  next.set(id, { ...ann, style });
  atlas.annotations = next;
  syncRenderer(atlas);
  atlas.recordHistory({
    label: 'Change annotation style',
    undo: () => {
      const a = atlas.annotations.get(id);
      if (!a) return;
      const m = new Map(atlas.annotations);
      m.set(id, { ...a, style: oldStyle });
      atlas.annotations = m;
      syncRenderer(atlas);
    },
    redo: () => {
      const a = atlas.annotations.get(id);
      if (!a) return;
      const m = new Map(atlas.annotations);
      m.set(id, { ...a, style });
      atlas.annotations = m;
      syncRenderer(atlas);
    },
  });
}

/** Toggle the Q12 "keep box near point on screen" clamp per annotation. */
export function updateAnnotationClamp(atlas: Atlas, id: string, clamp: boolean): void {
  const ann = atlas.annotations.get(id);
  if (!ann) return;
  const oldClamp = ann.clampToAnchor ?? false;
  const next = new Map(atlas.annotations);
  next.set(id, { ...ann, clampToAnchor: clamp });
  atlas.annotations = next;
  syncRenderer(atlas);
  atlas.recordHistory({
    label: clamp ? 'Enable keep-near-point' : 'Disable keep-near-point',
    undo: () => {
      const a = atlas.annotations.get(id);
      if (!a) return;
      const m = new Map(atlas.annotations);
      m.set(id, { ...a, clampToAnchor: oldClamp });
      atlas.annotations = m;
      syncRenderer(atlas);
    },
    redo: () => {
      const a = atlas.annotations.get(id);
      if (!a) return;
      const m = new Map(atlas.annotations);
      m.set(id, { ...a, clampToAnchor: clamp });
      atlas.annotations = m;
      syncRenderer(atlas);
    },
  });
}

/**
 * Export all annotations as a JSON string (B5: includes format version).
 * Format: { v: 2, annotations: AnnotationData[] }
 */
export function exportAnnotationsJson(atlas: Atlas): string {
  const arr = [...atlas.annotations.values()];
  return JSON.stringify({ v: 2, annotations: arr }, null, 2);
}

/**
 * Import annotations from a JSON string (replaces current annotations).
 * Accepts both the new { v: 2, annotations: [...] } format and the legacy array format.
 * Legacy annotations without offsetVersion: 'v2map' have their offsets reset to defaults.
 */
export function importAnnotationsJson(atlas: Atlas, json: string): void {
  const before = new Map(atlas.annotations);
  const parsed = JSON.parse(json);

  // Support both new envelope format and legacy bare-array format.
  let arr: AnnotationData[];
  if (Array.isArray(parsed)) {
    arr = parsed as AnnotationData[];
  } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.annotations)) {
    arr = parsed.annotations as AnnotationData[];
  } else {
    arr = [];
  }

  const wpp = atlas.renderer?.worldPerPixel() ?? 1;
  const next = new Map<string, AnnotationData>();
  for (const ann of arr) {
    if (ann && typeof ann.id === 'string' && typeof ann.rowKey === 'string') {
      let a = ann;
      // Migrate legacy screen-pixel offsets: reset to a small world-unit default.
      if (a.offsetVersion !== 'v2map') {
        a = { ...a, offsetX: DEFAULT_OFFSET_X_PX * wpp, offsetY: DEFAULT_OFFSET_Y_PX * -wpp, offsetVersion: 'v2map' };
      }
      next.set(a.id, a);
    }
  }
  atlas.annotations = next;
  syncRenderer(atlas);
  atlas.recordHistory({
    label: 'Import annotations',
    undo: () => { atlas.annotations = new Map(before); syncRenderer(atlas); },
    redo: () => { atlas.annotations = new Map(next); syncRenderer(atlas); },
  });
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
  const coords3d = worldCoords3DFor(atlas, prepIdx);
  if (!coords3d) return null;
  const [wx, wy, wz] = coords3d;

  // Prefer the hover title (from texts store) or fall back to "Row N".
  let text = titleText;
  if (!text && atlas.textsStore.ready) {
    text = atlas.textsStore.get(prepIdx) ?? '';
  }
  if (!text) {
    text = `Row ${row}`;
  }
  return addAnnotation(atlas, prepIdx, row, wx, wy, text, atlas.dims === 3 ? wz : undefined);
}

/** Create an annotation from the pinned hover card data.
 *  Looks up the prepared-row index from the pinnedCard and uses its title/row.
 *  If the card has pixel image data or an imageUri, it is used directly (skips async fetch). */
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
  // If the card has an imageUri (image-URL column), create a thumbnail from it immediately.
  if (ann.style === 'image' && card.imageUri && !card.image) {
    void makeThumbnail(card.imageUri).then((url) => {
      if (url) updateAnnotationImageDataUrl(atlas, ann.id, url);
    });
  }
  return ann;
}
