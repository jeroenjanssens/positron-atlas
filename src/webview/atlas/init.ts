/**
 * Atlas initialisation from an 'init' message.
 */

import type { Atlas } from '../atlas.svelte';
import type { DescribeResult, Settings, PanelState } from '../../shared/protocol';
import { vscode } from '../vscode';
import { DEFAULT_UMAP } from '../defaults';
import { DEFAULT_LABELS } from './labels-defaults';
import { runPrepare } from './prepare.svelte';

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
    atlas.labels = { column: col, minSize, maxSize, colorText: l.colorText !== false, clusters: l.clusters === true && col === null, detail, nameBy, outlines: l.outlines !== false };
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
