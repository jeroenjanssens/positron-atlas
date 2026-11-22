/**
 * HTML export (X2): packs the current atlas visual state and dispatches to the host.
 *
 * Flow:
 *   1. exportHtml()     — saves visual arrays in _pendingExport, posts slim exportHtml to host.
 *   2. Host fetches kernel text, resolves viewer bundle URI, posts exportHtmlAssembly.
 *   3. assembleHtmlExport() — fetches viewer.js, packs blob, gzips, builds HTML, posts exportHtmlReady.
 *   4. Host writes the bytes and posts htmlExportSaved.
 */

import type { Atlas } from '../atlas.svelte';
import { vscode } from '../vscode';
import { plotBackground } from './render';
import { getLoadedFontCss } from '../fonts';
import type {
  BlobAnnotation,
  BlobBox2D,
  BlobHeader,
  BlobLabel,
  BlobLegend,
  BlobTitle,
} from '../../shared/viewerBlob';
import {
  buildViewerHtml,
  gzipBytes,
  packBlob,
  uint8ToBase64,
} from '../../shared/viewerBlob';
import { NOISE_COLOR, OTHER_COLOR, NULL_COLOR } from '../color/colormaps';
import type { ToWebview } from '../../shared/protocol';

// ---- types ------------------------------------------------------------------

export interface HtmlExportOptions {
  /** Tooltip column indices to embed text for. */
  tooltipColumns: number[];
  /** Column index that is the link (URL), or -1. */
  linkColumn: number;
  /** Max chars per cell for text columns. */
  maxChars: number;
  /** Whether to embed image data-URLs for image annotations. */
  embedImages: boolean;
  /** Sampling percentage (1–100); only affects how many points appear in the export. */
  samplePct: number;
}

/** Visual data stored locally while we wait for the host to respond with text + viewer URI. */
interface PendingExport {
  nPoints: number;
  bg: string;
  xy: Float32Array;
  rgba: Uint8Array;
  codes: Uint16Array | null;
  radii: Float32Array | null;
  headerBase: Omit<BlobHeader, 'sections'>;
  variable: string;
}

/** Convert an RGBA byte tuple to a CSS hex color string. */
function rgbaToCssHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// ---- module-level pending state ---------------------------------------------

let _pendingExport: PendingExport | null = null;

// ---- helpers ----------------------------------------------------------------

function buildLegend(atlas: Atlas): BlobLegend {
  if (atlas.colorByCluster && atlas.cluster && atlas.clusterPalette) {
    const { k, counts } = atlas.cluster;
    const palette = atlas.clusterPalette;
    const categories: string[] = [];
    const colors: string[] = [];
    const cnts: number[] = [];
    for (let i = 0; i < k; i++) {
      categories.push(atlas.clusterNames[i] ?? `Cluster ${i + 1}`);
      colors.push(palette[i % palette.length]);
      cnts.push(counts[i] ?? 0);
    }
    categories.push('Unlabelled');
    colors.push(NOISE_COLOR);
    cnts.push(counts.slice(k).reduce((a, b) => a + b, 0));
    return { kind: 'categorical', title: 'Clusters', categories, colors, counts: cnts };
  }

  const meta = atlas.colorMeta;
  if (!meta || atlas.colorColumn === null) return null;
  const colName = atlas.describe?.columns[atlas.colorColumn]?.name ?? '';

  if (meta.kind === 'numeric') {
    return {
      kind: 'numeric',
      title: colName,
      colormap: atlas.view.colormap,
      min: atlas.colorRange?.[0] ?? meta.min ?? 0,
      max: atlas.colorRange?.[1] ?? meta.max ?? 1,
      nullColor: meta.nullCount > 0 ? NULL_COLOR : undefined,
    };
  }

  const categories: string[] = [];
  const colors: string[] = [];
  const counts: number[] = [];
  for (let i = 0; i < meta.categories.length; i++) {
    categories.push(meta.categories[i] === '' ? '(empty)' : meta.categories[i]);
    colors.push(atlas.isCategoryHidden(i) ? '#555555' : atlas.categoryColor(i));
    counts.push(meta.counts[i] ?? 0);
  }
  if (meta.otherCount) {
    categories.push(`other (${(meta.nUnique - meta.categories.length).toLocaleString()} values)`);
    colors.push(OTHER_COLOR);
    counts.push(meta.otherCount);
  }
  if (meta.nullCount) {
    categories.push('missing');
    colors.push(NULL_COLOR);
    counts.push(meta.nullCount);
  }
  return { kind: 'categorical', title: colName, categories, colors, counts };
}

function buildLabels(atlas: Atlas): BlobLabel[] {
  if (!atlas.renderer) return [];
  return atlas.renderer.labels.map((l) => ({
    text: l.text,
    x: l.position[0],
    y: l.position[1],
    size: l.size,
    color: l.color,
    priority: l.priority,
    weight: l.weight,
    badge: l.badge,
  }));
}

function buildAnnotations(atlas: Atlas): BlobAnnotation[] {
  const result: BlobAnnotation[] = [];
  for (const ann of atlas.annotations.values()) {
    result.push({
      id: ann.id,
      text: ann.text,
      style: ann.style,
      worldX: ann.worldX,
      worldY: ann.worldY,
      offsetX: ann.offsetX,
      offsetY: ann.offsetY,
      offsetVersion: ann.offsetVersion,
      color: ann.color,
      imageDataUrl: ann.imageDataUrl || undefined,
    });
  }
  return result;
}

function toHexColor(rgba: [number, number, number, number]): string {
  const [r, g, b] = rgba;
  return '#' + [r, g, b].map((v) => Math.min(255, Math.max(0, v)).toString(16).padStart(2, '0')).join('');
}

function buildBoxes(atlas: Atlas): BlobBox2D[] {
  if (!atlas.renderer || atlas.dims === 3) return [];
  // 2D only: collect from the renderer's box list (set by labels.ts via applyGroupBoxes).
  const boxes2D = (atlas.renderer as any).boxes2D as import('../render/boxes').Box2D[] | null;
  if (!boxes2D?.length) return [];
  return boxes2D.map((b) => ({
    extent: b.extent,
    color: toHexColor(b.color),
    label: b.label,
  }));
}

function buildTitle(atlas: Atlas): BlobTitle {
  const t = atlas.titleOverlay;
  return {
    title: t.title,
    subtitle: t.subtitle,
    fontFamily: t.fontFamily,
    fontSize: t.fontSize,
    color: t.color,
    logoData: t.logoData,
    logoWidth: t.logoWidth,
  };
}

// ---- public API -------------------------------------------------------------

/**
 * Step 1: Save visual data locally and post a slim `exportHtml` message to the host.
 * The host will respond with `exportHtmlAssembly`; call `assembleHtmlExport` then.
 */
export function exportHtml(atlas: Atlas, opts: HtmlExportOptions): void {
  if (!atlas.prepared || (!atlas.colorsAll && !atlas.colorsAnchors)) {
    atlas.flash('No data to export. Run UMAP first.');
    return;
  }

  const rawXY = atlas.allXY ?? atlas.anchorXY;
  const rawRgba = atlas.colorsAll ?? atlas.colorsAnchors;
  if (!rawXY || !rawRgba) {
    atlas.flash('No positions to export.');
    return;
  }

  const nBase = Math.min(rawXY.length / 2, rawRgba.length / 4);

  const rawCodes =
    atlas.colorValues instanceof Uint16Array && !atlas.colorByCluster
      ? atlas.colorValues.subarray(0, nBase)
      : null;

  const rawRadii = atlas.sizeValues ? atlas.sizeValues.subarray(0, nBase) : null;

  const colNames = atlas.describe?.columns ?? [];
  const tooltipColDescs = opts.tooltipColumns
    .filter((ci) => ci >= 0 && ci < colNames.length)
    .map((ci) => ({
      index: ci,
      name: colNames[ci]?.name ?? `col${ci}`,
      isLink: ci === opts.linkColumn,
      isTitle: ci === atlas.tooltipOpts?.titleColumn,
    }));

  // B3: collect visible overlay point sets and append them after the base points.
  const overlayDescs: NonNullable<import('../../shared/viewerBlob').BlobHeader['overlays']> = [];
  const overlayXYParts: Float32Array[] = [];
  const overlayRGBAParts: Uint8Array[] = [];
  let nTotal = nBase;
  for (const layer of atlas.layers) {
    if (layer.kind !== 'point-overlay' || !layer.visible) continue;
    const ovXY = atlas.overlayXY.get(layer.id);
    const ovRGBA = atlas.overlayColors.get(layer.id);
    const nKept = atlas.overlayNKept.get(layer.id) ?? 0;
    const nFilled = atlas.overlayFilled.get(layer.id) ?? 0;
    if (!ovXY || !ovRGBA || nFilled === 0) continue;
    const nd = atlas.dims;
    const count = nFilled;
    // Convert overlay RGBA to CSS hex (all same color; use first point).
    const color = rgbaToCssHex(ovRGBA[0], ovRGBA[1], ovRGBA[2]);
    overlayDescs.push({ name: layer.sourceName ?? layer.name, color, symbol: layer.symbol ?? 0, start: nTotal, count });
    overlayXYParts.push(ovXY.slice(0, count * nd));
    overlayRGBAParts.push(ovRGBA.slice(0, count * 4));
    nTotal += count;
  }

  // Build combined XY and RGBA arrays (base + overlays).
  const nd = atlas.dims;
  let combinedXY: Float32Array;
  let combinedRGBA: Uint8Array;
  if (nd === 2 && overlayXYParts.length > 0) {
    combinedXY = new Float32Array(nTotal * 2);
    combinedRGBA = new Uint8Array(nTotal * 4);
    combinedXY.set(rawXY.subarray(0, nBase * 2), 0);
    combinedRGBA.set(rawRgba.subarray(0, nBase * 4), 0);
    let pos2 = nBase * 2, pos4 = nBase * 4;
    for (let i = 0; i < overlayXYParts.length; i++) {
      combinedXY.set(overlayXYParts[i], pos2);
      combinedRGBA.set(overlayRGBAParts[i], pos4);
      pos2 += overlayXYParts[i].length;
      pos4 += overlayRGBAParts[i].length;
    }
  } else {
    combinedXY = rawXY.slice(0, nBase * Math.max(nd, 2));
    combinedRGBA = rawRgba.slice(0, nBase * 4);
    nTotal = nBase; // 3D overlays not yet supported in export
  }

  const nPoints = nTotal;

  // Store visual data for assembly step
  _pendingExport = {
    nPoints,
    bg: plotBackground(atlas),
    // copy so the data isn't stale if atlas changes before assembly
    xy: combinedXY,
    rgba: combinedRGBA,
    codes: rawCodes ? rawCodes.slice() : null,
    radii: rawRadii ? rawRadii.slice() : null,
    headerBase: {
      v: 1,
      n: nPoints,
      bg: plotBackground(atlas),
      tooltipCols: tooltipColDescs,
      legend: buildLegend(atlas),
      labels: buildLabels(atlas),
      annotations: buildAnnotations(atlas),
      title: buildTitle(atlas),
      fontCss: getLoadedFontCss(),
      sample: { n: atlas.prepared.nSampled, total: atlas.prepared.nRows, pct: opts.samplePct },
      // Persist 2D rotation so the HTML viewer opens at the same angle (item 14).
      rotation2D: atlas.rotation2D !== 0 ? atlas.rotation2D : undefined,
      // B2: 2D group bounding-box overlays.
      boxes: buildBoxes(atlas).length ? buildBoxes(atlas) : undefined,
      // B3: overlay descriptors (viewer uses these for the legend and future filtering).
      overlays: overlayDescs.length > 0 ? overlayDescs : undefined,
      // B4: embed shapes so the HTML viewer can render them.
      shapes: atlas.shapes.length ? (atlas.shapes as unknown as import('../../shared/viewerBlob').BlobShape[]) : undefined,
    },
    variable: atlas.variable,
  };

  // Post slim message to host (no binary data)
  vscode.post({
    type: 'exportHtml',
    nPoints,
    variable: atlas.variable,
    tooltipColumns: tooltipColDescs,
    maxChars: opts.maxChars,
    samplePct: opts.samplePct,
    total: atlas.prepared.nRows,
    sampled: atlas.prepared.nSampled,
  });
}

/**
 * Step 3: Called when the host sends `exportHtmlAssembly`.
 * Fetches viewer.js, packs the blob, gzips, builds HTML, posts `exportHtmlReady`.
 */
export async function assembleHtmlExport(
  m: Extract<ToWebview, { type: 'exportHtmlAssembly' }>,
): Promise<void> {
  const p = _pendingExport;
  if (!p) return; // no pending export

  _pendingExport = null;

  // 1. Fetch viewer JS bundle
  const viewerJsRes = await fetch(m.viewerJsUri);
  if (!viewerJsRes.ok) throw new Error(`Failed to fetch viewer bundle: ${viewerJsRes.status}`);
  const viewerJs = await viewerJsRes.text();

  // 2. Build combined text arrays from host-provided data
  const textUtf8 = m.textUtf8 ?? null;
  const textOffsets = m.textOffsets ?? null;

  // 3. Pack blob
  const header: BlobHeader = {
    ...p.headerBase,
    sections: { xy: [0, 0], rgba: [0, 0], codes: null, radii: null, textUtf8: null, textOffsets: null },
  };
  const rawBlob = packBlob({
    header,
    xy: p.xy,
    rgba: p.rgba,
    codes: p.codes,
    radii: p.radii,
    textUtf8,
    textOffsets,
  });

  // 4. Gzip + base64
  const gzipped = await gzipBytes(rawBlob);
  const b64 = uint8ToBase64(gzipped);

  // 5. Build HTML
  const html = buildViewerHtml(viewerJs, b64, p.variable, p.bg);
  const htmlBytes = new TextEncoder().encode(html);

  // 6. Post back to host for file write
  vscode.post({ type: 'exportHtmlReady', htmlBytes });
}

/** Approximate byte count for the export (before gzip). Used for the size estimate in the dialog. */
export function estimateExportBytes(
  atlas: Atlas,
  opts: Pick<HtmlExportOptions, 'tooltipColumns' | 'maxChars'>,
): number {
  const rawXY = atlas.allXY ?? atlas.anchorXY;
  if (!rawXY) return 0;
  let n = rawXY.length / 2;
  // B3: include visible overlay point counts.
  for (const layer of atlas.layers) {
    if (layer.kind === 'point-overlay' && layer.visible) {
      n += atlas.overlayFilled.get(layer.id) ?? 0;
    }
  }
  const pointBytes = n * (8 + 4 + (atlas.colorValues instanceof Uint16Array ? 2 : 0));
  const textBytes = (rawXY.length / 2) * opts.tooltipColumns.length * Math.min(opts.maxChars, 40);
  const overhead = 50_000 + (atlas.renderer?.labels.length ?? 0) * 200 + atlas.annotations.size * 500;
  return pointBytes + textBytes + overhead;
}
