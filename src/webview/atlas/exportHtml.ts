/**
 * HTML export (X2): packs the current atlas visual state and dispatches to the host.
 *
 * The host receives the visual arrays + options, fetches tooltip texts from the
 * kernel, assembles the full gzipped blob, and writes the self-contained HTML file.
 */

import type { Atlas } from '../atlas.svelte';
import { vscode, typedArrayToBytes } from '../vscode';
import { plotBackground } from './render';
import { getLoadedFontCss } from '../fonts';
import type { BlobAnnotation, BlobLabel, BlobLegend, BlobTitle } from '../../shared/viewerBlob';
import { NOISE_COLOR, OTHER_COLOR, NULL_COLOR } from '../color/colormaps';

// ---- state exposed to the ExportTab UI ---------------------------------------

/** Current export status (null = idle, 'packing' = in progress, 'done' = finished). */
export type HtmlExportStatus = null | 'packing' | 'done' | 'error';

// ---- helpers -----------------------------------------------------------------

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
    // Add noise category
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

  // categorical
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
      color: ann.color,
      imageDataUrl: ann.imageDataUrl || undefined,
    });
  }
  return result;
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

// ---- public API --------------------------------------------------------------

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

/**
 * Pack the current atlas state into visual arrays and dispatch `exportHtml` to the host.
 * The host assembles the full blob (adding kernel text data), gzips it, and writes the HTML.
 */
export function exportHtml(atlas: Atlas, opts: HtmlExportOptions): void {
  if (!atlas.prepared || (!atlas.colorsAll && !atlas.colorsAnchors)) {
    atlas.flash('No data to export. Run UMAP first.');
    return;
  }

  // Pick XY and RGBA from the best available source (all rows > anchors-only).
  const rawXY = atlas.allXY ?? atlas.anchorXY;
  const rawRgba = atlas.colorsAll ?? atlas.colorsAnchors;
  if (!rawXY || !rawRgba) {
    atlas.flash('No positions to export.');
    return;
  }

  const nPoints = Math.min(rawXY.length / 2, rawRgba.length / 4);

  // Category codes for legend filter (u16[n] or null).
  const rawCodes = (atlas.colorValues instanceof Uint16Array && !atlas.colorByCluster)
    ? atlas.colorValues.subarray(0, nPoints)
    : null;

  // Per-point radii (f32[n] or null).
  const rawRadii = atlas.sizeValues ? atlas.sizeValues.subarray(0, nPoints) : null;

  const legend = buildLegend(atlas);
  const labels = buildLabels(atlas);
  const annotations = buildAnnotations(atlas);
  const title = buildTitle(atlas);
  const fontCss = getLoadedFontCss();
  const bg = plotBackground(atlas);

  // Build hidden-category mask: a u16 set of hidden code values (for the host to apply).
  const hiddenCodes = (() => {
    if (!rawCodes || atlas.colorColumn === null) return [];
    const h = atlas.hiddenCategories.get(atlas.colorColumn);
    return h ? [...h] : [];
  })();

  // Tooltip column names
  const colNames = (atlas.describe?.columns ?? []);
  const tooltipColNames = opts.tooltipColumns
    .filter((ci) => ci >= 0 && ci < colNames.length)
    .map((ci) => ({
      index: ci,
      name: colNames[ci]?.name ?? `col${ci}`,
      isLink: ci === opts.linkColumn,
      isTitle: ci === atlas.tooltipOpts?.titleColumn,
    }));

  const payload = {
    nPoints,
    bg,
    positions: typedArrayToBytes(rawXY.subarray(0, nPoints * 2)),
    rgba: rawRgba.subarray(0, nPoints * 4),
    codes: rawCodes ? typedArrayToBytes(rawCodes) : null,
    radii: rawRadii ? typedArrayToBytes(rawRadii) : null,
    hiddenCodes,
    legend: JSON.stringify(legend),
    labels: JSON.stringify(labels),
    annotations: JSON.stringify(annotations),
    title: JSON.stringify(title),
    fontCss,
    tooltipColumns: tooltipColNames,
    maxChars: opts.maxChars,
    variable: atlas.variable,
    samplePct: opts.samplePct,
    total: atlas.prepared.nRows,
    sampled: atlas.prepared.nSampled,
  };

  vscode.post({ type: 'exportHtml', ...payload });
}

/** Approximate byte count for the export (before gzip). Used for the size estimate in the dialog. */
export function estimateExportBytes(atlas: Atlas, opts: Pick<HtmlExportOptions, 'tooltipColumns' | 'maxChars'>): number {
  const rawXY = atlas.allXY ?? atlas.anchorXY;
  if (!rawXY) return 0;
  const n = rawXY.length / 2;
  // positions(8) + rgba(4) + codes(2) + radii(4 optional)
  const pointBytes = n * (8 + 4 + (atlas.colorValues instanceof Uint16Array ? 2 : 0));
  // Text: rough estimate of maxChars per column × n
  const textBytes = n * opts.tooltipColumns.length * Math.min(opts.maxChars, 40);
  // JSON overhead + labels + annotations
  const overhead = 50_000 + atlas.renderer!.labels.length * 200 + atlas.annotations.size * 500;
  return pointBytes + textBytes + overhead;
}
