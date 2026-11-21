/**
 * Actions: addCoordinates, savePng, copyPython, copyPolarsUmap, copyDataMapPlot,
 * reload, persist, setSession, showError, flash.
 */

import type { Atlas } from '../atlas.svelte';
import type { PanelState, PrepareOptions, UmapParams } from '../../shared/protocol';
import { vscode, float32ToBase64 } from '../vscode';
import { dataMapPlotSnippet, formatCount, polarsUmapSnippet, pythonSnippet } from '../logic';
import { plotBackground } from './render';

export function addCoordinates(atlas: Atlas): void {
  if (!atlas.prepared || !atlas.anchorXY) {
    return;
  }
  if (!atlas.prepared.needsProjection) {
    vscode.post({ type: 'addCoordinates', anchorXY: float32ToBase64(atlas.anchorXY), useProjection: false });
  } else if (atlas.projection === 'done') {
    vscode.post({ type: 'addCoordinates', anchorXY: null, useProjection: true });
  } else {
    atlas.flash('Place all rows first, then add the coordinates.');
  }
}

export function savePng(atlas: Atlas): void {
  if (!atlas.renderer) {
    return;
  }
  vscode.post({ type: 'savePng', dataUrl: atlas.renderer.toDataURL(plotBackground(atlas)) });
}

export function copyPython(atlas: Atlas): void {
  const names = (atlas.describe?.columns ?? []).filter((c) => atlas.prepare.features.includes(c.index)).map((c) => c.name);
  const kind = atlas.describe?.frameKind ?? 'pandas';
  vscode.post({ type: 'copyText', text: pythonSnippet(atlas.variable, names, $state.snapshot(atlas.prepare) as PrepareOptions, $state.snapshot(atlas.umap) as UmapParams, kind) });
}

export function copyPolarsUmap(atlas: Atlas): void {
  const names = (atlas.describe?.columns ?? []).filter((c) => atlas.prepare.features.includes(c.index)).map((c) => c.name);
  const kind = atlas.describe?.frameKind ?? 'pandas';
  vscode.post({ type: 'copyText', text: polarsUmapSnippet(atlas.variable, names, $state.snapshot(atlas.prepare) as PrepareOptions, $state.snapshot(atlas.umap) as UmapParams, kind) });
}

/** Python that draws this map with DataMapPlot (to the clipboard). */
export function copyDataMapPlot(atlas: Atlas): void {
  const d = atlas.describe;
  if (!d) return;
  const label = !atlas.labels.clusters && atlas.labels.column !== null ? (d.columns[atlas.labels.column]?.name ?? null) : atlas.labels.clusters ? 'atlas_cluster' : null;
  vscode.post({ type: 'copyText', text: dataMapPlotSnippet(atlas.dataVariable || atlas.variable, d.frameKind, label) });
}

export function reload(atlas: Atlas): void {
  atlas.error = null;
  atlas.phase = 'loading';
  vscode.post({ type: 'reload' });
}

export function persist(atlas: Atlas): void {
  const prev = vscode.getState();
  const state: PanelState = {
    variable: atlas.variable || prev?.variable || '',
    sessionId: prev?.sessionId ?? '',
    languageId: prev?.languageId ?? 'python',
    prepare: $state.snapshot(atlas.prepare) as PrepareOptions,
    umap: $state.snapshot(atlas.umap) as UmapParams,
    colorColumn: atlas.colorColumn,
    view: $state.snapshot(atlas.view) as import('./types').ViewOptions,
    ui: $state.snapshot(atlas.ui) as import('./types').UiState,
    labels: $state.snapshot(atlas.labels) as import('../../shared/protocol').LabelOptions,
  };
  vscode.setState(state);
  vscode.post({ type: 'state', state });
}

export function setSession(atlas: Atlas, sessionId: string, languageId: string, variable: string): void {
  const prev = vscode.getState();
  vscode.setState({ ...(prev ?? ({} as PanelState)), sessionId, languageId, variable });
}

export function showError(atlas: Atlas, message: string): void {
  atlas.error = { message };
}

export function flash(atlas: Atlas, message: string): void {
  atlas.toast = message;
  setTimeout(() => {
    if (atlas.toast === message) {
      atlas.toast = null;
    }
  }, 4000);
}
