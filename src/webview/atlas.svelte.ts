/**
 * Atlas: the top-level reactive state container and public API.
 *
 * This file holds all $state declarations and thin method delegates.
 * Business logic lives in the atlas/* sub-modules.
 */

import type {
  CategoricalColorMeta,
  ColorMeta,
  ExactEngine,
  LabelOptions,
  SelectionComparison,
  PanelState,
  PrepareOptions,
  PrepareResult,
  Settings,
  ToWebview,
  TooltipOptions,
  UmapParams,
  DescribeResult,
  JobStatus,
} from '../shared/protocol';
import { vscode, isVsCodeWebview } from './vscode';
import { ScatterRenderer } from './render/renderer';
import { HitIndex } from './render/hitIndex';
import { ClusterFinder } from './labels/clusterWorker';
import { detectImageColumns, guessImageWidth, type ImageColumns, formatCount } from './logic';
import { DEFAULT_UMAP } from './defaults';
import { DEFAULT_LABELS } from './atlas/labels-defaults';
import { LruCache, type CachedRow } from './hover/cache';
import { TextsStore } from './hover/texts';

// Sub-module imports
import { onInit as onInitImpl } from './atlas/init';
import { runPrepare as runPrepareImpl, onPrepared as onPreparedImpl, onStatus as onStatusImpl } from './atlas/prepare.svelte';
import {
  startUmap as startUmapImpl,
  umapChanged as umapChangedImpl,
  stopUmap as stopUmapImpl,
  pauseUmap as pauseUmapImpl,
  resumeUmap as resumeUmapImpl,
  stepUmap as stepUmapImpl,
  stopWorker as stopWorkerImpl,
  createWorker as createWorkerImpl,
} from './atlas/umap.svelte';
import {
  project as projectImpl,
  runExact as runExactImpl,
  onProjected as onProjectedImpl,
  cancelKernel as cancelKernelImpl,
  onXYChunk as onXYChunkImpl,
} from './atlas/projection.svelte';
import {
  setColorColumn as setColorColumnImpl,
  requestColors as requestColorsImpl,
  onColors as onColorsImpl,
  recolor as recolorImpl,
  categoryColor as categoryColorImpl,
  updateMapColors as updateMapColorsImpl,
  toggleCategory as toggleCategoryImpl,
} from './atlas/colors';
import {
  setLabelSource as setLabelSourceImpl,
  setLabelColumn as setLabelColumnImpl,
  setLabelOptions as setLabelOptionsImpl,
  requestLabelCodes as requestLabelCodesImpl,
  onLabelCodes as onLabelCodesImpl,
  scheduleLabels as scheduleLabelsImpl,
  updateLabels as updateLabelsImpl,
} from './atlas/labels';
import {
  refreshClusters as refreshClustersImpl,
  nameClusters as nameClustersImpl,
  onGroupNames as onGroupNamesImpl,
} from './atlas/clusters';
import {
  onPointer as onPointerImpl,
  onRows as onRowsImpl,
  onTexts as onTextsImpl,
  onImageUri as onImageUriImpl,
  onClick as onClickImpl,
  closePinnedCard as closePinnedCardImpl,
  openPinnedLink as openPinnedLinkImpl,
} from './atlas/hover';
import {
  applyLasso as applyLassoImpl,
  setSelection as setSelectionImpl,
  clearSelection as clearSelectionImpl,
  invertSelection as invertSelectionImpl,
  compareSelection as compareSelectionImpl,
  selectionToFrame as selectionToFrameImpl,
} from './atlas/selection';
import { tagSelection as tagSelectionImpl, clustersToFrame as clustersToFrameImpl, onLabelsWritten as onLabelsWrittenImpl } from './atlas/tags';
import {
  setView as setViewImpl,
  render as renderImpl,
  fitView as fitViewImpl,
  legendWidth as legendWidthImpl,
  plotBackground as plotBackgroundImpl,
} from './atlas/render';
import {
  addCoordinates as addCoordinatesImpl,
  savePng as savePngImpl,
  copyPython as copyPythonImpl,
  copyPolarsUmap as copyPolarsUmapImpl,
  copyDataMapPlot as copyDataMapPlotImpl,
  reload as reloadImpl,
  persist as persistImpl,
  setSession as setSessionImpl,
  showError as showErrorImpl,
  flash as flashImpl,
} from './atlas/actions.svelte';
import { probeWebGpu } from './atlas/utils';
import type { SelectMode } from './select/lasso';

// Re-export types and constants for backward compatibility with components
export type { ViewOptions, Phase, SidebarTab, UiState } from './atlas/types';
export { MAX_LABELS } from './atlas/types';
export { DEFAULT_LABELS };
export { DEFAULT_UMAP };
export { contrastText, labelTextColor, themeBackground, dominantNames } from './atlas/utils';

type ViewOptions = import('./atlas/types').ViewOptions;
type Phase = import('./atlas/types').Phase;
type SidebarTab = import('./atlas/types').SidebarTab;
type UiState = import('./atlas/types').UiState;

/** Auto-place all rows after UMAP when the estimate is below this many seconds. */
const AUTO_PROJECT_SECONDS = 20;

export class Atlas {
  // ---- reactive UI state -------------------------------------------------------
  phase = $state<Phase>('loading');
  variable = $state('');
  describe = $state.raw<DescribeResult | null>(null);
  settings = $state.raw<Settings | null>(null);
  prepare = $state<PrepareOptions>({
    features: [],
    samplePct: 100,
    standardize: true,
    pca: false,
    pcaDims: 50,
    nanPolicy: 'drop',
    seed: 42,
    maxAnchors: 100_000,
    anchorBudget: 10_000_000,
  });
  applied = $state.raw<PrepareOptions | null>(null);
  umap = $state<UmapParams>({ ...DEFAULT_UMAP });
  view = $state<ViewOptions>({ pointSize: 3, opacity: 0.8, mode: 'points', colormap: 'viridis', background: '', images: false, imageWidth: 0, imageInvert: false, palette: 'map' });
  ui = $state<UiState>({ tab: 'map', closed: [] });
  labels = $state<LabelOptions>({ ...DEFAULT_LABELS });
  clusterCount = $state(0);
  clusterNames = $state.raw<string[]>([]);
  clustering = $state(false);
  labelMeta = $state.raw<CategoricalColorMeta | null>(null);
  labelCount = $state(0);
  tool = $state<'pan' | 'lasso'>('pan');
  selection = $state.raw<Uint8Array | null>(null);
  selectedCount = $state(0);
  selectionOnAnchors = $state(false);
  comparison = $state.raw<SelectionComparison | null>(null);
  dataVariable = $state('');
  comparing = $state(false);
  colorColumn = $state<number | null>(null);
  forceCategorical = $state(false);
  colorMeta = $state.raw<ColorMeta | null>(null);
  mapColors = $state.raw<string[] | null>(null);
  colorRange = $state<[number, number] | null>(null);
  prepared = $state.raw<PrepareResult | null>(null);
  kernelStatus = $state.raw<{ task: string; stage: string; progress: number; message: string } | null>(null);
  umapProgress = $state.raw<{ stage: string; progress: number; epoch: number; total: number } | null>(null);
  projection = $state<'none' | 'stale' | 'running' | 'done'>('none');
  projectProgress = $state(0);
  estimate = $state.raw<{ seconds: number; rows: number } | null>(null);
  error = $state.raw<{ message: string; detail?: string; fatal?: boolean } | null>(null);
  tooltip = $state.raw<{
    x: number; y: number; row: number;
    values: [string, string][];
    image?: (number | null)[];
    title?: string;
    linkValue?: string;
    imageUri?: string;
  } | null>(null);
  timings = $state.raw<Record<string, number>>({});
  toast = $state<string | null>(null);
  useGpu = $state(false);
  paused = $state(false);
  placementBackend = $state<'rust' | 'numpy' | null>(null);
  gpuAvailable = $state(false);
  computeMode = $state<'browser' | ExactEngine>('browser');
  layoutEngine = $state<string>('');
  /** True when running inside VS Code / Positron (acquireVsCodeApi was available). */
  readonly isPositron = isVsCodeWebview;

  // ---- hover / legend reactive state (H2–H8, L1) --------------------------------
  /** Pinned hover card: set by onClick, cleared by closePinnedCard (H7). */
  pinnedCard = $state.raw<{
    x: number; y: number; row: number;
    values: [string, string][];
    image?: (number | null)[];
    title?: string;
    linkValue?: string;
    imageUri?: string;
    preparedIdx: number;
  } | null>(null);
  /** Column/field settings for the hover tooltip (H6). */
  tooltipOpts = $state<TooltipOptions>({
    titleColumn: undefined,
    fieldMode: 'all',
    fieldColumns: [],
    linkColumn: undefined,
    imageUrlColumn: undefined,
  });
  /** Hidden category indices per color column (L1). Map<colorColumn, Set<categoryIndex>>. */
  hiddenCategories = $state.raw<Map<number, Set<number>>>(new Map());
  /** Whether to load images from URLs: 'always', 'never', or 'ask' (H8). */
  loadImagesFromUrls = $state<'always' | 'never' | 'ask'>('ask');

  // ---- non-reactive data -------------------------------------------------------
  // Not marked private so atlas/* sub-modules can access them.
  // Treat as internal: do not use directly outside this module tree.
  renderer: ScatterRenderer | null = null;
  worker: Worker | null = null;
  runId = 0;
  appliedUmap: UmapParams | null = null;
  exactEngine: ExactEngine = 'umap-learn';
  anchors: Float32Array | null = null;
  anchorPos: Uint32Array | null = null;
  anchorXY: Float32Array | null = null;
  allXY: Float32Array | null = null;
  placedRows = 0;
  colorValues: Float32Array | Uint16Array | null = null;
  colorsAll: Uint8Array | null = null;
  colorsAnchors: Uint8Array | null = null;
  labelCodes: Uint16Array | null = null;
  labelCodesAnchors: Uint16Array | null = null;
  labelTimer: ReturnType<typeof setTimeout> | undefined;
  cluster: { codes: Uint16Array; codesAnchors: Uint16Array; k: number; counts: number[]; outlines: [number, number][][][] } | null = null;
  clusterFinder: ClusterFinder | null = null;
  clusterSeq = 0;
  nameSeq = 0;
  compareSeq = 0;
  clusterRunning = 0;
  nameSource: { column: number; codes: Uint16Array; meta: CategoricalColorMeta } | null = null;
  labelAt = 0;
  hit: { index: HitIndex; map: (i: number) => number } | null = null;
  hoverTimer: ReturnType<typeof setTimeout> | undefined;
  hoverSeq = 0;
  /** Extended: includes prepIdx for hover ring and cache lookups. */
  pendingHover: { x: number; y: number; prepIdx?: number } | null = null;
  autoFit = true;
  liveRun = false;
  inbox: Promise<void> = Promise.resolve();
  gpuProbe: Promise<boolean> = probeWebGpu();

  // ---- hover non-reactive state (H2–H8) ----------------------------------------
  /** LRU cache of fetched row values, keyed by prepared-row index (H2). */
  rowCache = new LruCache<CachedRow>(1000);
  /** Sequence number of the in-flight `rows` request (0 = none). */
  hoverInflight = 0;
  /** Monotonically increasing sequence for `rows` requests. */
  hoverRowsSeq = 0;
  /** Lazy UTF-8 title decoder (H3). */
  textsStore = new TextsStore();

  // ---- lifecycle ---------------------------------------------------------------
  attach(container: HTMLElement): void {
    this.renderer = new ScatterRenderer(container);
    this.renderer.setStyle(this.view);
    this.renderer.onPointer((p) => this.onPointer(p));
    createWorkerImpl(this);
    window.addEventListener('message', (ev: MessageEvent<ToWebview>) => {
      this.inbox = this.inbox
        .then(() => this.handle(ev.data))
        .catch((e) => this.showError(e instanceof Error ? e.message : String(e)));
    });
    void this.gpuProbe.then((ok) => {
      this.gpuAvailable = ok;
      vscode.post({ type: 'ready' });
    });
  }

  destroy(): void {
    clearTimeout(this.labelTimer);
    this.clusterFinder?.destroy();
    this.worker?.terminate();
    this.renderer?.destroy();
  }

  // ---- computed properties -----------------------------------------------------
  get nKept(): number {
    return this.prepared?.nKept ?? 0;
  }

  get nAnchors(): number {
    return this.prepared?.nAnchors ?? 0;
  }

  get prepareDirty(): boolean {
    return !this.applied || JSON.stringify(this.applied) !== JSON.stringify($state.snapshot(this.prepare));
  }

  /** Pixel columns detected in the DataFrame (largest prefix+number group), if any. */
  get imageColumns(): ImageColumns | null {
    return this.describe ? detectImageColumns(this.describe.columns) : null;
  }

  /** Effective image size [width, height] for the detected pixel columns. */
  get imageShape(): [number, number] | null {
    const cols = this.imageColumns;
    if (!cols) return null;
    const n = cols.indices.length;
    const w = this.view.imageWidth > 0 ? Math.min(this.view.imageWidth, n) : guessImageWidth(n);
    return [w, Math.ceil(n / w)];
  }

  get numericColumns() {
    return (this.describe?.columns ?? []).filter((c) => c.kind === 'numeric' || c.kind === 'bool');
  }

  /** True when any categories are hidden for the current color column (L1). */
  get anyHidden(): boolean {
    if (this.colorColumn === null) return false;
    const h = this.hiddenCategories.get(this.colorColumn);
    return !!(h && h.size > 0);
  }

  /**
   * CPU-side count of points that pass the current legend filter (L1).
   * Returns the total anchor count when no filter is active.
   * Useful for scenario assertions without needing GPU pixel reads.
   */
  get renderVisibleCount(): number {
    return this.renderer?.filterPassCount ?? 0;
  }

  // ---- message dispatch --------------------------------------------------------
  private async handle(msg: ToWebview): Promise<void> {
    switch (msg.type) {
      case 'init':
        setSessionImpl(this, msg.sessionId, 'python', msg.variable);
        this.onInit(msg.describe, msg.settings, msg.variable, msg.state);
        break;
      case 'status':
        onStatusImpl(this, msg.task, msg.status as JobStatus);
        break;
      case 'prepared':
        await onPreparedImpl(this, msg.result, msg.anchors, msg.anchorPos);
        break;
      case 'estimate':
        this.estimate = { seconds: msg.seconds, rows: msg.rows };
        if (msg.seconds <= AUTO_PROJECT_SECONDS && this.projection === 'stale' && this.phase === 'ready') {
          this.project();
        }
        break;
      case 'xyChunk':
        await onXYChunkImpl(this, msg.file);
        break;
      case 'projected':
        this.placementBackend = msg.backend ?? null;
        onProjectedImpl(this, msg.seconds, !!msg.exact);
        break;
      case 'colors':
        await onColorsImpl(this, msg.column, msg.file, msg.meta);
        break;
      case 'labelCodes':
        await onLabelCodesImpl(this, msg.column, msg.file, msg.meta, msg.purpose ?? 'labels');
        break;
      case 'groupNames':
        onGroupNamesImpl(this, msg.seq, msg.names);
        break;
      case 'labelsWritten':
        onLabelsWrittenImpl(this, msg.variable, msg.column, msg.rows, msg.describe);
        break;
      case 'comparison':
        if (msg.seq === this.compareSeq) {
          this.comparing = false;
          this.comparison = this.selection ? msg.result : null;
        }
        break;
      case 'selectionFrame':
        this.flash(`Created ${msg.variable} with ${formatCount(msg.rows)} rows`);
        break;
      case 'row':
        if (this.pendingHover) {
          this.tooltip = { ...this.pendingHover, row: msg.row, values: msg.values, image: msg.image };
        }
        break;
      case 'rows':
        onRowsImpl(this, msg);
        break;
      case 'texts':
        onTextsImpl(this, msg);
        break;
      case 'imageUri':
        onImageUriImpl(this, msg.row, msg.uri);
        break;
      case 'imagePermission':
        this.loadImagesFromUrls = msg.granted ? 'always' : 'never';
        break;
      case 'error':
        this.error = { message: msg.message, detail: msg.detail, fatal: msg.fatal };
        this.comparing = false;
        if (msg.fatal) {
          this.phase = 'error';
        } else if (this.phase === 'preparing' || (this.phase === 'embedding' && this.computeMode !== 'browser')) {
          this.phase = this.prepared ? 'ready' : 'error';
          this.umapProgress = null;
        }
        if (this.projection === 'running') {
          this.projection = 'stale';
        }
        break;
      case 'coordsAdded':
        this.dataVariable = msg.variable;
        this.flash(`Added ${msg.columns.join(', ')} to ${msg.variable}`);
        break;
    }
  }

  // ---- public API --------------------------------------------------------------

  /** @internal Accessible via a['onInit'] in harness tests. */
  onInit(d: DescribeResult, settings: Settings, variable: string, state?: PanelState): void {
    onInitImpl(this, d, settings, variable, state);
  }

  // ---- prepare -----------------------------------------------------------------
  runPrepare(): void { runPrepareImpl(this); }

  // ---- UMAP --------------------------------------------------------------------
  startUmap(paused = false): void { startUmapImpl(this, paused); }
  umapChanged(): void { umapChangedImpl(this); }
  stopUmap(): void { stopUmapImpl(this); }
  pauseUmap(): void { pauseUmapImpl(this); }
  resumeUmap(): void { resumeUmapImpl(this); }
  stepUmap(epochs: number): void { stepUmapImpl(this, epochs); }
  stopWorker(): void { stopWorkerImpl(this); }

  // ---- projection --------------------------------------------------------------
  project(): void { projectImpl(this); }
  runExact(): void { runExactImpl(this); }
  cancelKernel(): void { cancelKernelImpl(this); }

  // ---- colors ------------------------------------------------------------------
  setColorColumn(c: number | null): void { setColorColumnImpl(this, c); }
  requestColors(): void { requestColorsImpl(this); }
  recolor(): void { recolorImpl(this); }
  categoryColor(i: number): string { return categoryColorImpl(this, i); }
  updateMapColors(recolor = true): void { updateMapColorsImpl(this, recolor); }

  // ---- legend toggles (L1) -----------------------------------------------------
  /** Toggle visibility of a category; solo=true (alt-click) isolates that one. */
  toggleCategory(catIndex: number, solo: boolean): void { toggleCategoryImpl(this, catIndex, solo); }
  /** Whether a given category index is hidden for the current color column (L1). */
  isCategoryHidden(catIndex: number): boolean {
    if (this.colorColumn === null) return false;
    return this.hiddenCategories.get(this.colorColumn)?.has(catIndex) ?? false;
  }
  /** Show all hidden categories for the current color column. */
  showAllCategories(): void {
    if (this.colorColumn === null) return;
    const newMap = new Map(this.hiddenCategories);
    newMap.delete(this.colorColumn);
    this.hiddenCategories = newMap;
    this.render();
  }

  // ---- labels ------------------------------------------------------------------
  setLabelSource(source: number | 'clusters' | null): void { setLabelSourceImpl(this, source); }
  setLabelColumn(c: number | null): void { setLabelColumnImpl(this, c); }
  setLabelOptions(o: Partial<LabelOptions>): void { setLabelOptionsImpl(this, o); }
  requestLabelCodes(): void { requestLabelCodesImpl(this); }
  scheduleLabels(): void { scheduleLabelsImpl(this); }
  updateLabels(): void { updateLabelsImpl(this); }

  // ---- clusters ----------------------------------------------------------------
  refreshClusters(): void { refreshClustersImpl(this); }
  nameClusters(): void { nameClustersImpl(this); }

  // ---- hover -------------------------------------------------------------------
  /** @internal Accessible via a['onPointer'] in harness tests. */
  onPointer(p: { x: number; y: number; world: [number, number] } | null): void { onPointerImpl(this, p); }
  onClick(e: MouseEvent): void { onClickImpl(this, e); }
  closePinnedCard(): void { closePinnedCardImpl(this); }
  openPinnedLink(): void { openPinnedLinkImpl(this); }
  copyCardValue(value: string): void { vscode.post({ type: 'copyText', text: value }); }

  // ---- selection ---------------------------------------------------------------
  applyLasso(screen: [number, number][], mode: SelectMode): void { applyLassoImpl(this, screen, mode); }
  setSelection(mask: Uint8Array | null): void { setSelectionImpl(this, mask); }
  clearSelection(): void { clearSelectionImpl(this); }
  invertSelection(): void { invertSelectionImpl(this); }
  compareSelection(): void { compareSelectionImpl(this); }
  selectionToFrame(): void { selectionToFrameImpl(this); }

  // ---- tags / write-back -------------------------------------------------------
  tagSelection(tag: string, column: string): void { tagSelectionImpl(this, tag, column); }
  clustersToFrame(column: string): void { clustersToFrameImpl(this, column); }

  // ---- rendering ---------------------------------------------------------------
  setView(v: Partial<ViewOptions>): void { setViewImpl(this, v); }
  render(): void { renderImpl(this); }
  fitView(): void { fitViewImpl(this); }
  legendWidth(): number { return legendWidthImpl(this); }
  plotBackground(): string { return plotBackgroundImpl(this); }

  // ---- sidebar -----------------------------------------------------------------
  setTab(tab: SidebarTab): void { this.ui.tab = tab; }
  setSectionOpen(id: string, open: boolean): void {
    const closed = this.ui.closed.includes(id);
    if (open && closed) {
      this.ui.closed = this.ui.closed.filter((x) => x !== id);
    } else if (!open && !closed) {
      this.ui.closed = [...this.ui.closed, id];
    }
  }

  // ---- actions -----------------------------------------------------------------
  addCoordinates(): void { addCoordinatesImpl(this); }
  savePng(): void { savePngImpl(this); }
  copyPython(): void { copyPythonImpl(this); }
  copyPolarsUmap(): void { copyPolarsUmapImpl(this); }
  copyDataMapPlot(): void { copyDataMapPlotImpl(this); }
  reload(): void { reloadImpl(this); }
  persist(): void { persistImpl(this); }
  setSession(sessionId: string, languageId: string, variable: string): void { setSessionImpl(this, sessionId, languageId, variable); }
  showError(message: string): void { showErrorImpl(this, message); }
  flash(message: string): void { flashImpl(this, message); }

  /** Request full-screen mode (N5 / F1).  In Positron, posts a ToHost message so the host
   *  runs workbench.action.maximizeEditorHideSidebar.  In a plain browser the caller uses
   *  the browser Fullscreen API instead (PlotToolbar.svelte checks isPositron). */
  setFullscreen(on: boolean): void {
    vscode.post({ type: 'fullscreen', on });
  }
}
