/**
 * Actions: addCoordinates, savePng, copyPython, copyPolarsUmap, copyDataMapPlot,
 * reload, persist, setSession, showError, flash.
 */

import type { Atlas } from '../atlas.svelte';
import type { OverlayState } from '../render/renderer';
import type { PanelState, PrepareOptions, UmapParams } from '../../shared/protocol';
import { vscode, float32ToBytes } from '../vscode';
import { dataMapPlotSnippet, formatCount, polarsUmapSnippet, pythonSnippet } from '../logic';
import { plotBackground } from './render';
import { computeAroundLabels } from '../labels/around';
import { renderGlow } from './glow';
import { getLayer, createInitialLayers } from './layers';

export function addCoordinates(atlas: Atlas): void {
  if (atlas.layoutMode === 'columns') {
    atlas.flash('The layout is already from columns in the DataFrame — no coordinates to add.');
    return;
  }
  if (!atlas.prepared || !atlas.anchorXY) {
    return;
  }
  if (!atlas.prepared.needsProjection) {
    vscode.post({ type: 'addCoordinates', anchorXY: float32ToBytes(atlas.anchorXY), useProjection: false, dims: atlas.dims });
  } else if (atlas.projection === 'done') {
    vscode.post({ type: 'addCoordinates', anchorXY: null, useProjection: true, dims: atlas.dims });
  } else {
    atlas.flash('Place all rows first, then add the coordinates.');
  }
}

export function savePng(atlas: Atlas): void {
  if (!atlas.renderer) {
    return;
  }
  const renderer = atlas.renderer;
  const cssW = renderer['container']?.clientWidth ?? 800;
  const cssH = renderer['container']?.clientHeight ?? 600;

  // A11: compute around-labels for PNG export (respects around-labels layer visibility).
  let aroundLabels: OverlayState['aroundLabels'];
  const aroundLabelsLayerVisible = getLayer(atlas.layers, 'around-labels')?.visible ?? true;
  if (aroundLabelsLayerVisible && (atlas.labels.labelStyle ?? 'over') === 'around' && atlas.aroundLabelGroups?.length) {
    aroundLabels = computeAroundLabels(
      atlas.aroundLabelGroups,
      (wx, wy) => renderer.projectWorld(wx, wy),
      cssW, cssH,
      {
        leaderStyle: atlas.labels.leaderStyle ?? 'straight',
        leaderColor: atlas.labels.leaderColor ?? 'cluster',
        fitTopPx: 76,
        legendWidth: atlas.legendWidth(),
      },
      atlas.anchorXY ?? undefined,
      atlas.nAnchors,
    );
  }

  // A12: render glow to an offscreen canvas for export (respects glow layer visibility).
  let glowCanvas: HTMLCanvasElement | undefined;
  const glowLayerVisible = getLayer(atlas.layers, 'glow')?.visible ?? true;
  if (glowLayerVisible && atlas.view.glow && atlas.anchorXY && atlas.nAnchors > 0) {
    const gCanvas = document.createElement('canvas');
    // Use per-anchor RGBA colors directly for maximum fidelity.
    const rgbaPerPoint = atlas.colorsAnchors ?? null;
    renderGlow(gCanvas, atlas.anchorXY, atlas.nAnchors, null, [],
      (wx, wy) => renderer.projectWorld(wx, wy),
      atlas.view.glowStrength ?? 0.4,
      atlas.view.glowRadius ?? 40,
      cssW, cssH,
      rgbaPerPoint);
    glowCanvas = gCanvas;
  }

  // Annotations layer: include callouts in export only when layer is visible.
  const annotationsLayerVisible = getLayer(atlas.layers, 'annotations')?.visible ?? true;

  const shapesLayerVisible = getLayer(atlas.layers, 'shapes')?.visible ?? true;
  const overlay: OverlayState = {
    titleOverlay: atlas.titleOverlay,
    annotations: annotationsLayerVisible ? atlas.annotations : new Map(),
    aroundLabels,
    leaderStyle: atlas.labels.leaderStyle,
    leaderColor: atlas.labels.leaderColor,
    leaderWidth: atlas.labels.leaderWidth,
    labelFontFamily: atlas.labels.fontFamily || undefined,
    glowCanvas,
    shapes: shapesLayerVisible ? atlas.shapes : [],
  };

  renderer.toPngBytesWithOverlay(plotBackground(atlas), overlay).then((bytes) => {
    vscode.post({ type: 'savePng', bytes });
  });
}

export function copyPython(atlas: Atlas): void {
  if (atlas.layoutMode === 'columns') {
    atlas.flash('Python code is not available in "From columns" layout mode.');
    return;
  }
  const names = (atlas.describe?.columns ?? []).filter((c) => atlas.prepare.features.includes(c.index)).map((c) => c.name);
  const kind = atlas.describe?.frameKind ?? 'pandas';
  vscode.post({ type: 'copyText', text: pythonSnippet(atlas.variable, names, $state.snapshot(atlas.prepare) as PrepareOptions, $state.snapshot(atlas.umap) as UmapParams, kind, atlas.dims) });
}

export function copyPolarsUmap(atlas: Atlas): void {
  if (atlas.layoutMode === 'columns') {
    atlas.flash('Python code is not available in "From columns" layout mode.');
    return;
  }
  const names = (atlas.describe?.columns ?? []).filter((c) => atlas.prepare.features.includes(c.index)).map((c) => c.name);
  const kind = atlas.describe?.frameKind ?? 'pandas';
  vscode.post({ type: 'copyText', text: polarsUmapSnippet(atlas.variable, names, $state.snapshot(atlas.prepare) as PrepareOptions, $state.snapshot(atlas.umap) as UmapParams, kind, atlas.dims) });
}

/** Python that draws this map with DataMapPlot (to the clipboard). */
export function copyDataMapPlot(atlas: Atlas): void {
  const d = atlas.describe;
  if (!d) return;
  const label = !atlas.labels.clusters && atlas.labels.column !== null ? (d.columns[atlas.labels.column]?.name ?? null) : atlas.labels.clusters ? 'atlas_cluster' : null;
  const t = $state.snapshot(atlas.titleOverlay) as import('../../shared/protocol').TitleOptions;
  const title = t.title.trim() || undefined;
  const subtitle = t.subtitle.trim() || undefined;
  vscode.post({ type: 'copyText', text: dataMapPlotSnippet(atlas.dataVariable || atlas.variable, d.frameKind, label, title, subtitle) });
}

/** Export the map as an interactive DataMapPlot HTML file (D3/D12). */
export function exportDataMapPlot(atlas: Atlas): void {
  if (!atlas.prepared || !atlas.describe) return;
  const labelColumn = !atlas.labels.clusters && atlas.labels.column !== null ? atlas.labels.column : null;
  const titleColumn = typeof atlas.tooltipOpts.titleColumn === 'number' ? atlas.tooltipOpts.titleColumn : null;
  // Include the placed XY coordinates so the kernel can use them even when the
  // browser UMAP ran (job.xy is only set by the kernel-side UMAP paths).
  const rawXY = atlas.allXY ?? atlas.anchorXY;
  const anchorXY = rawXY ? float32ToBytes(rawXY) : undefined;
  // Colors: when coloring by the label column (categorical), pass a name→hex map so
  // DataMapPlot can colour the clusters with the same palette as the Atlas map.
  let labelColorMap: Record<string, string> | undefined;
  if (
    labelColumn !== null &&
    atlas.colorColumn === labelColumn &&
    atlas.colorMeta?.kind === 'categorical'
  ) {
    labelColorMap = {};
    for (let i = 0; i < atlas.colorMeta.categories.length; i++) {
      labelColorMap[atlas.colorMeta.categories[i]] = atlas.categoryColor(i);
    }
  }
  vscode.post({ type: 'exportDataMapPlot', labelColumn, titleColumn, anchorXY, labelColorMap });
}

export function reload(atlas: Atlas): void {
  atlas.error = null;
  atlas.phase = 'loading';
  vscode.post({ type: 'reload' });
}

export function persist(atlas: Atlas): void {
  const prev = vscode.getState();
  // Serialize hiddenCategories Map → Record<number, number[]>
  const hiddenCategoriesRecord: Record<number, number[]> = {};
  for (const [col, set] of atlas.hiddenCategories) {
    hiddenCategoriesRecord[col] = [...set];
  }
  // Serialize annotations Map → Record<string, AnnotationData>
  const annotationsRecord: Record<string, import('../../shared/protocol').AnnotationData> = {};
  for (const [k, v] of atlas.annotations) {
    annotationsRecord[k] = v;
  }

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
    tooltip: $state.snapshot(atlas.tooltipOpts) as import('../../shared/protocol').TooltipOptions,
    hiddenCategories: Object.keys(hiddenCategoriesRecord).length ? hiddenCategoriesRecord : undefined,
    loadImagesFromUrls: atlas.loadImagesFromUrls !== 'ask' ? atlas.loadImagesFromUrls : undefined,
    titleOverlay: $state.snapshot(atlas.titleOverlay) as import('../../shared/protocol').TitleOptions,
    annotations: Object.keys(annotationsRecord).length ? annotationsRecord : undefined,
    annotateIdColumn: atlas.annotateIdColumn,
    colorByCluster: atlas.colorByCluster || undefined,
    sizeColumn: atlas.sizeColumn ?? undefined,
    histFilter: atlas.histFilter ?? undefined,
    dims: atlas.dims !== 2 ? atlas.dims : undefined,
    layoutMode: atlas.layoutMode !== 'umap' ? atlas.layoutMode : undefined,
    // A2: persist non-default layer settings only.  Also save when order differs from defaults.
    layers: ((): import('../../shared/protocol').PanelState['layers'] => {
      const defaults = createInitialLayers();
      const hasChanges = atlas.layers.some((l) => {
        const def = defaults.find((d) => d.id === l.id);
        if (!def) return true;
        return l.visible !== def.visible || l.opacity !== def.opacity || l.blending !== def.blending || l.order !== def.order;
      });
      return hasChanges
        ? ($state.snapshot(atlas.layers) as import('../../shared/protocol').PanelState['layers'])
        : undefined;
    })(),
    rotation2D: atlas.rotation2D !== 0 ? atlas.rotation2D : undefined,
    // B4: persist shapes and brush classes.
    shapes: atlas.shapes.length ? atlas.shapes : undefined,
    brushClasses: atlas.brush.classes.length && atlas.brush.classes[0] !== 'Class 1' ? atlas.brush.classes : undefined,
    // C1: persist grid state when non-default.
    grid: atlas.grid.enabled || atlas.grid.layout !== '2x2' || atlas.grid.panels.some((p) => p.colorColumn !== null || p.title !== null)
      ? ($state.snapshot(atlas.grid) as import('../../shared/protocol').PanelState['grid'])
      : undefined,
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
