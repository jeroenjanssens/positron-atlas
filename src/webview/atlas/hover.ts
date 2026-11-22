/**
 * Hover detection, tooltip management, row fetching, and pinned card (H2–H8, A5).
 */

import type { Atlas } from '../atlas.svelte';
import type { CachedRow } from '../hover/cache';
import { HitIndex } from '../render/hitIndex';
import { isValidLink, detectTitleColumn } from '../hover/texts';
import { vscode } from '../vscode';

// ---- pointer hover (H4/A5) -------------------------------------------------------

export function onPointer(atlas: Atlas, p: { x: number; y: number; world: [number, number] } | null): void {
  clearTimeout(atlas.hoverTimer);
  if (!p || (atlas.phase !== 'ready' && !atlas.paused) || !atlas.anchorXY || !atlas.prepared || !atlas.anchorPos) {
    atlas.tooltip = null;
    atlas.pendingHover = null;
    atlas.renderer?.setHoverRing(-1, atlas.pinnedCard?.preparedIdx ?? -1);
    return;
  }
  // T4: In 3D mode use screen-space hit index (rebuilt by view3d.ts after camera stops).
  if (atlas.dims === 3) {
    if (!atlas.hit) {
      // Hit index not ready yet (camera is moving or never built); skip hover.
      atlas.tooltip = null;
      atlas.pendingHover = null;
      atlas.renderer?.setHoverRing(-1, atlas.pinnedCard?.preparedIdx ?? -1);
      return;
    }
    // Screen-space nearest: query with pixel coords; radius in pixels.
    const pixelRadius = Math.max(6, atlas.view.pointSize);
    const idx = atlas.hit.index.nearest(p.x, p.y, pixelRadius);
    if (idx < 0) {
      atlas.tooltip = null;
      atlas.pendingHover = null;
      atlas.renderer?.setHoverRing(-1, atlas.pinnedCard?.preparedIdx ?? -1);
      return;
    }
    if (isHiddenPoint(atlas, idx)) {
      atlas.tooltip = null;
      atlas.pendingHover = null;
      atlas.renderer?.setHoverRing(-1, atlas.pinnedCard?.preparedIdx ?? -1);
      return;
    }
    atlas.renderer?.setHoverRing(idx, atlas.pinnedCard?.preparedIdx ?? -1);
    requestAutoTexts(atlas);
    atlas.pendingHover = { x: p.x, y: p.y, prepIdx: idx };
    if (atlas.tooltip && atlas.tooltip.row === atlas.hit.map(idx)) {
      atlas.tooltip = { ...atlas.tooltip, x: p.x, y: p.y };
      return;
    }
    const cached3d = atlas.rowCache.get(idx);
    if (cached3d) {
      showTooltip(atlas, p.x, p.y, idx, cached3d);
      return;
    }
    showInstantTooltip(atlas, p.x, p.y, idx);
    const seq3d = ++atlas.hoverSeq;
    atlas.hoverTimer = setTimeout(() => {
      if (seq3d !== atlas.hoverSeq) return;
      requestRowsBatch(atlas, idx);
    }, 30);
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
    atlas.renderer?.setHoverRing(-1, atlas.pinnedCard?.preparedIdx ?? -1);
    return;
  }
  const prepIdx = idx;
  // Skip hidden categories (L1) — don't hover over hidden points.
  if (isHiddenPoint(atlas, prepIdx)) {
    atlas.tooltip = null;
    atlas.pendingHover = null;
    atlas.renderer?.setHoverRing(-1, atlas.pinnedCard?.preparedIdx ?? -1);
    return;
  }
  // Update hover ring immediately (A5).
  atlas.renderer?.setHoverRing(prepIdx, atlas.pinnedCard?.preparedIdx ?? -1);
  // Auto-request the title-column texts blob on first hover when phase is ready (H3/H5).
  // We do this lazily (not in init) so the kernel's prepare has definitely finished.
  requestAutoTexts(atlas);
  // Always record pendingHover so onClick always has a valid prepIdx to reference.
  atlas.pendingHover = { x: p.x, y: p.y, prepIdx };
  // If we already have a tooltip for this same row, just update position.
  if (atlas.tooltip && atlas.tooltip.row === atlas.hit.map(prepIdx)) {
    atlas.tooltip = { ...atlas.tooltip, x: p.x, y: p.y };
    return;
  }
  const cached = atlas.rowCache.get(prepIdx);
  if (cached) {
    // Show from cache immediately (H2/H3).
    showTooltip(atlas, p.x, p.y, prepIdx, cached);
    return;
  }
  // H2: show partial tooltip immediately (title from texts, color, cluster name, row #).
  showInstantTooltip(atlas, p.x, p.y, prepIdx);
  // H3/H4: debounce 30 ms, then request rows (batch prefetch of 16 neighbours).
  const seq = ++atlas.hoverSeq;
  atlas.hoverTimer = setTimeout(() => {
    if (seq !== atlas.hoverSeq) return;
    requestRowsBatch(atlas, prepIdx);
  }, 30);
}

// ---- handle `rows` message (H3) --------------------------------------------------

export function onRows(
  atlas: Atlas,
  msg: { type: 'rows'; seq: number; values: Record<number, [string, string][]>; images?: Record<number, (number | null)[]> },
): void {
  for (const [key, vals] of Object.entries(msg.values)) {
    const pIdx = Number(key);
    const existing = atlas.rowCache.get(pIdx);
    const image = msg.images?.[pIdx] ?? existing?.image;
    const updated: CachedRow = {
      row: pIdx, // corrected below
      values: vals,
      image,
      imageUri: existing?.imageUri,
    };
    // The kernel returns the prepared-row index as key; use hit.map to get the original row.
    updated.row = atlas.hit?.map(pIdx) ?? pIdx;
    atlas.rowCache.set(pIdx, updated);

    // Fire any pending annotation pixel callbacks for this row.
    if (image) {
      const cbs = atlas.annotationPixelPending.get(pIdx);
      if (cbs?.length) {
        atlas.annotationPixelPending.delete(pIdx);
        for (const cb of cbs) cb(image);
      }
    }
    // Fire any pending annotation rows callbacks (for image-URL annotations, D5).
    const rowCbs = atlas.annotationRowsPending.get(pIdx);
    if (rowCbs?.length) {
      atlas.annotationRowsPending.delete(pIdx);
      for (const cb of rowCbs) cb(updated);
    }
  }
  if (msg.seq !== atlas.hoverInflight) return;
  atlas.hoverInflight = 0;
  // Update the visible tooltip if the hovered row is now in the cache.
  const ph = atlas.pendingHover;
  if (!ph || ph.prepIdx === undefined) return;
  const pIdx = ph.prepIdx;
  const cached = atlas.rowCache.get(pIdx);
  if (cached) {
    showTooltip(atlas, ph.x, ph.y, pIdx, cached);
  }
}

// ---- handle `texts` message (H3) -------------------------------------------------

export function onTexts(
  atlas: Atlas,
  msg: { type: 'texts'; column: number; uri: string; offsetsUri: string; count: number },
): void {
  void atlas.textsStore.load(msg.uri, msg.offsetsUri);
}

// ---- handle `imageUri` message (H8) ----------------------------------------------

export function onImageUri(atlas: Atlas, row: number, uri: string): void {
  const cached = atlas.rowCache.get(row);
  if (cached) {
    atlas.rowCache.set(row, { ...cached, imageUri: uri });
  }
  if (atlas.tooltip && atlas.tooltip.row === (atlas.hit?.map(row) ?? row)) {
    atlas.tooltip = { ...atlas.tooltip, imageUri: uri };
  }
  if (atlas.pinnedCard && atlas.pinnedCard.preparedIdx === row) {
    atlas.pinnedCard = { ...atlas.pinnedCard, imageUri: uri };
  }
  // Fire any pending annotation image-URI callbacks (D5).
  const annCbs = atlas.annotationImageUriPending.get(row);
  if (annCbs?.length) {
    atlas.annotationImageUriPending.delete(row);
    for (const cb of annCbs) cb(uri);
  }
}

// ---- click to pin (H7) -----------------------------------------------------------

export function onClick(atlas: Atlas, e: MouseEvent): void {
  if (!atlas.hit || !atlas.tooltip || atlas.phase !== 'ready') return;
  const prepIdx = atlas.pendingHover?.prepIdx ?? -1;
  if (prepIdx < 0) return;
  // Cmd/Ctrl-click: open link directly (H7).
  if ((e.metaKey || e.ctrlKey) && atlas.tooltip.linkValue) {
    vscode.post({ type: 'openLink', url: atlas.tooltip.linkValue });
    return;
  }
  // Plain click: pin the tooltip as a card.
  atlas.pinnedCard = { ...atlas.tooltip, preparedIdx: prepIdx };
  atlas.renderer?.setHoverRing(prepIdx, prepIdx);
}

export function closePinnedCard(atlas: Atlas): void {
  atlas.pinnedCard = null;
  const prepIdx = atlas.pendingHover?.prepIdx ?? -1;
  atlas.renderer?.setHoverRing(prepIdx, -1);
}

export function openPinnedLink(atlas: Atlas): void {
  const url = atlas.pinnedCard?.linkValue;
  if (url) vscode.post({ type: 'openLink', url });
}

// ---- internal helpers ------------------------------------------------------------

/**
 * Post a `texts` request for the title column if texts haven't been loaded yet.
 * Called lazily on first hover (after prepare has definitely finished).
 */
function requestAutoTexts(atlas: Atlas): void {
  if (atlas.textsStore.requested_ || atlas.phase !== 'ready') return;
  const col = typeof atlas.tooltipOpts.titleColumn === 'number'
    ? atlas.tooltipOpts.titleColumn
    : detectTitleColumn(atlas.describe?.columns ?? []);
  if (typeof col === 'number') {
    // Mark before posting so concurrent hovers do not send duplicate requests.
    atlas.textsStore.markRequested();
    vscode.post({ type: 'texts', column: col, maxChars: 120 });
  }
}

/** Show an instant partial tooltip from what the webview already has (H2). */
function showInstantTooltip(atlas: Atlas, x: number, y: number, prepIdx: number): void {
  const keepIdx = atlas.hit?.map(prepIdx) ?? prepIdx;
  const title = atlas.textsStore.ready ? atlas.textsStore.get(prepIdx) : null;
  // When fieldMode is 'none' (title-focused card), skip the instant color/cluster values
  // so the card is not cluttered before the real rows arrive.
  const values: [string, string][] = [];
  if (atlas.tooltipOpts.fieldMode !== 'none') {
    const colorVal = instantColorValue(atlas, prepIdx);
    const clusterName = instantClusterName(atlas, prepIdx);
    if (colorVal !== null) values.push(['color', colorVal]);
    if (clusterName !== null) values.push(['cluster', clusterName]);
  }
  atlas.tooltip = { x, y, row: keepIdx, values, title: title ?? undefined };
}

/** Show a full tooltip from a cached row (H2/H3). */
function showTooltip(atlas: Atlas, x: number, y: number, prepIdx: number, cached: CachedRow): void {
  const title = atlas.textsStore.ready ? atlas.textsStore.get(prepIdx) : null;
  const link = getTooltipLink(atlas, cached.values);
  const imgUri = cached.imageUri;
  atlas.tooltip = {
    x,
    y,
    row: cached.row,
    values: filterTooltipValues(atlas, cached.values),
    image: cached.image,
    title: title ?? undefined,
    linkValue: link ?? undefined,
    imageUri: imgUri,
  };
  // Request image if image-URL column is configured and not yet cached (H8).
  if (!imgUri && atlas.tooltipOpts.imageUrlColumn !== null && atlas.tooltipOpts.imageUrlColumn !== undefined) {
    const imgSrc = getColumnValue(atlas, cached.values, atlas.tooltipOpts.imageUrlColumn);
    if (imgSrc && atlas.loadImagesFromUrls !== 'never') {
      vscode.post({ type: 'image', row: prepIdx, src: imgSrc });
    }
  }
}

/** Request rows in a batch including 16 neighbours for prefetching (H3/H4/H5). */
function requestRowsBatch(atlas: Atlas, prepIdx: number): void {
  if (!atlas.hit) return;
  const xy = atlas.projection === 'done' && atlas.allXY ? atlas.allXY : atlas.anchorXY;
  if (!xy) return;
  const px = xy[2 * prepIdx];
  const py = xy[2 * prepIdx + 1];
  const toFetch: number[] = [prepIdx];
  const neighbours = atlas.hit.index.nearestK(px, py, 17);
  for (const ni of neighbours) {
    if (ni !== prepIdx && !atlas.rowCache.has(ni) && toFetch.length < 17) {
      toFetch.push(ni);
    }
  }
  const seq = ++atlas.hoverRowsSeq;
  atlas.hoverInflight = seq;
  const cols = getFieldColumns(atlas);
  vscode.post({ type: 'rows', seq, indices: toFetch, columns: cols?.length ? cols : undefined });
}

/** Column indices to fetch based on fieldMode. */
function getFieldColumns(atlas: Atlas): number[] | undefined {
  const opts = atlas.tooltipOpts;
  if (opts.fieldMode === 'none') {
    const cols: number[] = [];
    if (typeof opts.titleColumn === 'number') cols.push(opts.titleColumn);
    if (typeof opts.linkColumn === 'number') cols.push(opts.linkColumn);
    if (typeof opts.imageUrlColumn === 'number') cols.push(opts.imageUrlColumn);
    return cols.length ? cols : undefined;
  }
  if (opts.fieldMode === 'chosen') {
    return opts.fieldColumns.length ? opts.fieldColumns : undefined;
  }
  return undefined; // 'all': no restriction
}

/** Filter the tooltip values list based on fieldMode. */
function filterTooltipValues(atlas: Atlas, values: [string, string][]): [string, string][] {
  const opts = atlas.tooltipOpts;
  if (opts.fieldMode === 'none') return [];
  if (opts.fieldMode === 'chosen') {
    if (!opts.fieldColumns.length) return [];
    const colNames = new Set(opts.fieldColumns.map((i) => atlas.describe?.columns[i]?.name).filter(Boolean));
    return values.filter(([k]) => colNames.has(k));
  }
  return values; // 'all'
}

/** Get a column value from a values list by column index. */
function getColumnValue(atlas: Atlas, values: [string, string][], colIndex: number): string | null {
  const colName = atlas.describe?.columns[colIndex]?.name;
  if (!colName) return null;
  const entry = values.find(([k]) => k === colName);
  return entry ? entry[1] : null;
}

/** Extract the link value from tooltip values if a link column is configured. */
function getTooltipLink(atlas: Atlas, values: [string, string][]): string | null {
  const col = atlas.tooltipOpts.linkColumn;
  if (typeof col !== 'number') return null;
  const v = getColumnValue(atlas, values, col);
  return v && isValidLink(v) ? v : null;
}

/** Quick color value string for the instant tooltip (H2). */
function instantColorValue(atlas: Atlas, prepIdx: number): string | null {
  if (atlas.colorColumn === null || !atlas.colorMeta || !atlas.colorValues) return null;
  const idx = atlas.projection === 'done' && atlas.allXY ? prepIdx : (atlas.anchorPos?.[prepIdx] ?? prepIdx);
  if (idx >= atlas.colorValues.length) return null;
  const meta = atlas.colorMeta;
  if (meta.kind === 'categorical') {
    const code = (atlas.colorValues as Uint16Array)[idx];
    return meta.categories[code] ?? null;
  }
  const v = (atlas.colorValues as Float32Array)[idx];
  if (!isFinite(v)) return null;
  const a = Math.abs(v);
  return a !== 0 && (a < 1e-3 || a >= 1e5) ? v.toExponential(2) : Number(v.toPrecision(4)).toString();
}

/** Quick cluster name for the instant tooltip (H2). */
function instantClusterName(atlas: Atlas, prepIdx: number): string | null {
  if (!atlas.cluster || !atlas.clusterNames.length) return null;
  const idx = atlas.projection === 'done' && atlas.allXY ? prepIdx : (atlas.anchorPos?.[prepIdx] ?? prepIdx);
  if (idx >= atlas.cluster.codes.length) return null;
  const code = atlas.cluster.codes[idx];
  return atlas.clusterNames[code] ?? null;
}

/** Whether a prepared-row is in a hidden category (L1). */
function isHiddenPoint(atlas: Atlas, prepIdx: number): boolean {
  if (atlas.colorColumn === null || !atlas.colorValues) return false;
  const hidden = atlas.hiddenCategories.get(atlas.colorColumn);
  if (!hidden || hidden.size === 0) return false;
  const meta = atlas.colorMeta;
  if (!meta || meta.kind !== 'categorical') return false;
  const idx = atlas.projection === 'done' && atlas.allXY ? prepIdx : (atlas.anchorPos?.[prepIdx] ?? prepIdx);
  if (idx >= atlas.colorValues.length) return false;
  return hidden.has((atlas.colorValues as Uint16Array)[idx]);
}
