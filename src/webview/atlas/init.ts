/**
 * Atlas initialisation from an 'init' message.
 */

import type { Atlas } from '../atlas.svelte';
import type { DescribeResult, Settings, PanelState } from '../../shared/protocol';
import { vscode } from '../vscode';
import { DEFAULT_UMAP } from '../defaults';
import { DEFAULT_LABELS } from './labels-defaults';
import { runPrepare } from './prepare.svelte';
import { detectTitleColumn, detectLinkColumn, detectImageUrlColumn } from '../hover/texts';

export function onInit(atlas: Atlas, d: DescribeResult, settings: Settings, variable: string, state?: PanelState): void {
  atlas.describe = d;
  atlas.settings = settings;
  atlas.variable = variable;
  if ((atlas.computeMode === 'polars-umap' && !d.deps?.polars_umap) || (atlas.computeMode === 'umap-learn' && !d.deps?.umap)) {
    atlas.computeMode = 'browser';
  }
  atlas.dataVariable = '';
  atlas.error = null;
  const numeric = d.columns.filter((c) => c.kind === 'numeric' || c.kind === 'bool').map((c) => c.index);
  const valid = new Set(d.columns.map((c) => c.index));
  const saved = state?.prepare;
  atlas.prepare = {
    features: saved?.features?.filter((i) => valid.has(i)).length ? saved.features.filter((i) => valid.has(i)) : numeric,
    samplePct: saved?.samplePct ?? settings.defaultSamplePct,
    standardize: saved?.standardize ?? true,
    pca: saved?.pca ?? settings.pcaEnabled,
    pcaDims: saved?.pcaDims ?? settings.pcaDims,
    nanPolicy: saved?.nanPolicy ?? 'drop',
    seed: saved?.seed ?? 42,
    maxAnchors: saved?.maxAnchors ?? (useGpuFor(atlas, settings) ? settings.maxAnchors : Math.min(settings.maxAnchors, settings.maxAnchorsCpu)),
    anchorBudget: settings.anchorBudget,
  };
  atlas.useGpu = useGpuFor(atlas, settings);
  if (state?.umap) {
    atlas.umap = { ...DEFAULT_UMAP, ...state.umap };
  }
  if (state?.ui) {
    const tab = state.ui.tab;
    atlas.ui = {
      tab: tab === 'map' || tab === 'explore' || tab === 'annotate' || tab === 'export' ? tab : 'map',
      closed: Array.isArray(state.ui.closed) ? state.ui.closed.filter((x) => typeof x === 'string') : [],
    };
  }
  if (state?.labels) {
    const l = state.labels;
    const col = l.column !== null && l.column !== undefined && valid.has(l.column) ? l.column : null;
    const minSize = Number.isFinite(l.minSize) ? Math.min(48, Math.max(6, l.minSize)) : 12;
    const maxSize = Number.isFinite(l.maxSize) ? Math.min(64, Math.max(minSize, l.maxSize)) : Math.max(minSize, 26);
    const detail = Number.isFinite(l.detail) ? Math.min(5, Math.max(1, Math.round(l.detail))) : DEFAULT_LABELS.detail;
    const nameBy = l.nameBy === 'features' || l.nameBy === 'number' ? l.nameBy : typeof l.nameBy === 'number' && valid.has(l.nameBy) ? l.nameBy : 'number';
    const fineColumn = typeof l.fineColumn === 'number' && valid.has(l.fineColumn) ? l.fineColumn : null;
    // Validate dragOffsets: only keep entries with numeric [dx,dy] arrays.
    const dragOffsets: Record<string, [number, number]> = {};
    if (l.dragOffsets) {
      for (const [k, v] of Object.entries(l.dragOffsets)) {
        if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number') {
          dragOffsets[k] = [v[0], v[1]];
        }
      }
    }
    atlas.labels = {
      column: col, minSize, maxSize, colorText: l.colorText !== false,
      clusters: l.clusters === true && col === null, detail, nameBy, outlines: l.outlines !== false,
      // A2 typography
      fontFamily: typeof l.fontFamily === 'string' ? l.fontFamily : '',
      fontWeight: Number.isFinite(l.fontWeight) ? Math.min(900, Math.max(100, l.fontWeight!)) : 600,
      minFontWeight: Number.isFinite(l.minFontWeight) ? Math.min(900, Math.max(100, l.minFontWeight!)) : 400,
      maxFontWeight: Number.isFinite(l.maxFontWeight) ? Math.min(900, Math.max(100, l.maxFontWeight!)) : 700,
      wrapWidth: Number.isFinite(l.wrapWidth) ? Math.min(80, Math.max(0, l.wrapWidth!)) : 9,
      lineSpacing: Number.isFinite(l.lineSpacing) ? Math.min(3, Math.max(0.5, l.lineSpacing!)) : 0.95,
      haloWidth: Number.isFinite(l.haloWidth) ? Math.min(30, Math.max(0, l.haloWidth!)) : 10,
      haloColor: typeof l.haloColor === 'string' ? l.haloColor : '',
      textCase: l.textCase === 'upper' ? 'upper' : 'asis',
      // A3 draggable
      dragOffsets,
      // A8 multi-level
      fineColumn,
      multiLevel: l.multiLevel === true,
      // A9 highlighted
      highlightGroups: Array.isArray(l.highlightGroups) ? l.highlightGroups.filter((g) => typeof g === 'string') : [],
    };
  }
  if (state?.view) {
    atlas.view = { ...atlas.view, ...state.view };
    atlas.renderer?.setStyle(atlas.view);
  }
  if (state && 'colorColumn' in state && (state.colorColumn === null || valid.has(state.colorColumn!))) {
    atlas.colorColumn = state.colorColumn ?? null;
  } else {
    const cat = d.columns.find((c) => (c.kind === 'categorical' || c.kind === 'bool') && (c.n_unique_est ?? 99) <= 20);
    atlas.colorColumn = cat ? cat.index : null;
  }
  // Restore tooltip options (H6), or auto-detect smart defaults for a fresh load.
  if (state?.tooltip) {
    atlas.tooltipOpts = {
      titleColumn: typeof state.tooltip.titleColumn === 'number' ? state.tooltip.titleColumn : undefined,
      fieldMode: state.tooltip.fieldMode === 'none' || state.tooltip.fieldMode === 'chosen' || state.tooltip.fieldMode === 'all'
        ? state.tooltip.fieldMode : 'all',
      fieldColumns: Array.isArray(state.tooltip.fieldColumns) ? state.tooltip.fieldColumns.filter((i) => valid.has(i)) : [],
      linkColumn: typeof state.tooltip.linkColumn === 'number' ? state.tooltip.linkColumn : undefined,
      imageUrlColumn: typeof state.tooltip.imageUrlColumn === 'number' ? state.tooltip.imageUrlColumn : undefined,
    };
  } else {
    // On a fresh load with no saved state, auto-detect useful columns (H3/H5).
    // detectTitleColumn returns null if nothing qualifies; we keep undefined (auto-detect) in that
    // case so the user can still configure it manually. When a title column IS found, default
    // fieldMode to 'none' so the card heading is prominent without a wall of fields.
    const titleCol = detectTitleColumn(d.columns);
    const linkCol = detectLinkColumn(d.columns);
    const imgCol = detectImageUrlColumn(d.columns);
    atlas.tooltipOpts = {
      titleColumn: titleCol !== null ? titleCol : undefined,
      fieldMode: titleCol !== null ? 'none' : 'all',
      fieldColumns: [],
      linkColumn: linkCol !== null ? linkCol : undefined,
      imageUrlColumn: imgCol !== null ? imgCol : undefined,
    };
  }
  // Restore hidden categories (L1).
  if (state?.hiddenCategories) {
    const map = new Map<number, Set<number>>();
    for (const [k, v] of Object.entries(state.hiddenCategories)) {
      if (Array.isArray(v)) map.set(Number(k), new Set(v as number[]));
    }
    atlas.hiddenCategories = map;
  } else {
    atlas.hiddenCategories = new Map();
  }
  // Restore image permission (H8).
  if (state?.loadImagesFromUrls === 'always' || state?.loadImagesFromUrls === 'never') {
    atlas.loadImagesFromUrls = state.loadImagesFromUrls;
  }
  // Reset hover state from prior session.
  atlas.rowCache.clear();
  atlas.hoverInflight = 0;
  atlas.pinnedCard = null;
  atlas.textsStore.clear();
  // Reset search state.
  atlas.searchQuery = '';
  atlas.searchMask = null;
  atlas.searchMatchCount = 0;
  atlas.searchPending = false;
  atlas.searchCache.clear();
  atlas.renderer?.setSearch(null);

  if (atlas.prepare.features.length === 0) {
    atlas.phase = 'error';
    atlas.error = { message: 'This DataFrame has no numeric columns to embed.' };
    return;
  }
  runPrepare(atlas);
}

export function useGpuFor(atlas: Atlas, settings: Settings): boolean {
  return settings.useWebGpu && atlas.gpuAvailable;
}
