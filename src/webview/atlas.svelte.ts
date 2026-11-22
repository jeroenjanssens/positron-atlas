/**
 * Atlas: the top-level reactive state container and public API.
 *
 * This file holds all $state declarations and thin method delegates.
 * Business logic lives in the atlas/* sub-modules.
 */

import type {
  AnnotationData,
  CategoricalColorMeta,
  ColorMeta,
  ExactEngine,
  LabelOptions,
  SelectionComparison,
  PanelState,
  PrepareOptions,
  PrepareResult,
  Settings,
  TitleOptions,
  ToWebview,
  TooltipOptions,
  UmapParams,
  DescribeResult,
  JobStatus,
} from '../shared/protocol';
import { vscode, isVsCodeWebview } from './vscode';
import { initFonts } from './fonts';
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
  runKernelAnchors as runKernelAnchorsImpl,
  onAnchorXY as onAnchorXYImpl,
} from './atlas/projection.svelte';
import {
  setColorColumn as setColorColumnImpl,
  requestColors as requestColorsImpl,
  onColors as onColorsImpl,
  recolor as recolorImpl,
  categoryColor as categoryColorImpl,
  updateMapColors as updateMapColorsImpl,
  toggleCategory as toggleCategoryImpl,
  setColorByCluster as setColorByClusterImpl,
  recolorByClusters as recolorByClustersImpl,
  setSizeColumn as setSizeColumnImpl,
  requestSizes as requestSizesImpl,
  onSizes as onSizesImpl,
  setHistColumn as setHistColumnImpl,
  requestHistogram as requestHistogramImpl,
  onHistogram as onHistogramImpl,
  onHistValues as onHistValuesImpl,
  setHistRange as setHistRangeImpl,
} from './atlas/colors';
import {
  setLabelSource as setLabelSourceImpl,
  setLabelColumn as setLabelColumnImpl,
  setLabelOptions as setLabelOptionsImpl,
  requestLabelCodes as requestLabelCodesImpl,
  onLabelCodes as onLabelCodesImpl,
  scheduleLabels as scheduleLabelsImpl,
  updateLabels as updateLabelsImpl,
  setDragOffset as setDragOffsetImpl,
  resetAllDragOffsets as resetAllDragOffsetsImpl,
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
  addAnnotation as addAnnotationImpl,
  addAnnotationFromCard as addAnnotationFromCardImpl,
  removeAnnotation as removeAnnotationImpl,
  clearAnnotations as clearAnnotationsImpl,
  updateAnnotationOffset as updateAnnotationOffsetImpl,
  updateAnnotationText as updateAnnotationTextImpl,
  updateAnnotationStyle as updateAnnotationStyleImpl,
  exportAnnotationsJson as exportAnnotationsJsonImpl,
  importAnnotationsJson as importAnnotationsJsonImpl,
  handleAnnotateClick as handleAnnotateClickImpl,
  DEFAULT_TITLE,
} from './atlas/annotations';
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
  exportDataMapPlot as exportDataMapPlotImpl,
  reload as reloadImpl,
  persist as persistImpl,
  setSession as setSessionImpl,
  showError as showErrorImpl,
  flash as flashImpl,
} from './atlas/actions.svelte';
import {
  exportHtml as exportHtmlImpl,
  assembleHtmlExport,
  estimateExportBytes as estimateExportBytesImpl,
  type HtmlExportOptions,
} from './atlas/exportHtml';
import {
  runSearch as runSearchImpl,
  clearSearch as clearSearchImpl,
  zoomToSearchMatches as zoomToSearchMatchesImpl,
  onSearchResults as onSearchResultsImpl,
  onSearchEmpty as onSearchEmptyImpl,
  searchColumn as searchColumnImpl,
} from './atlas/search';
import { probeWebGpu } from './atlas/utils';
import type { SelectMode } from './select/lasso';
import {
  startAutoRotate as startAutoRotateImpl,
  stopAutoRotate as stopAutoRotateImpl,
  on3DViewChange as on3DViewChangeImpl,
  setCameraPreset as setCameraPresetImpl,
  rebuild3DHitIndex as rebuild3DHitIndexImpl,
  type CameraPreset,
} from './atlas/view3d';

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
  tool = $state<'pan' | 'lasso' | 'annotate'>('pan');
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
  /** True when coloring by automatic cluster codes (A6). */
  colorByCluster = $state(false);
  /**
   * The k-length colour palette computed by recolorByClusters (A6).
   * Single source of truth for cluster colours used by legend, labels, and outlines.
   */
  clusterPalette = $state.raw<string[] | null>(null);
  /**
   * Incremented each time render() calls renderer.setPointSets so that the ExploreTab's
   * `renderVisibleCount` expression re-evaluates (the renderer's internal state is not
   * reactive; this tick gives Svelte a reactive dependency to track).
   */
  _renderTick = $state(0);
  /** Column index for size-by-column (A10), or null for uniform size. */
  sizeColumn = $state<number | null>(null);
  /** Per-kept-row float32 sizes (A10), scaled to pixel radii. Null = uniform. */
  sizeValues = $state.raw<Float32Array | null>(null);
  /** Active histogram column + brush range (A13). */
  histFilter = $state.raw<{ column: number; range: [number, number] } | null>(null);
  /** Pre-computed histogram bins for the histFilter column (A13). */
  histData = $state.raw<import('../shared/protocol').HistogramData | null>(null);
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
  /** Whether the HTML export dialog is open. */
  htmlExportOpen = $state(false);
  useGpu = $state(false);
  paused = $state(false);
  placementBackend = $state<'rust' | 'numpy' | null>(null);
  gpuAvailable = $state(false);
  computeMode = $state<'browser' | ExactEngine | 'kernel-anchors'>('browser');
  layoutEngine = $state<string>('');
  /** Output dimensionality of the UMAP layout: 2 (default, full features) or 3 (T2). */
  dims = $state<2 | 3>(2);
  /** True when 3D auto-rotate is active (T3). */
  autoRotate = $state(false);
  /** True when running inside VS Code / Positron (acquireVsCodeApi was available). */
  readonly isPositron = isVsCodeWebview;

  // ---- overlay / annotation state (A1, A4) ------------------------------------
  titleOverlay = $state<TitleOptions>({ ...DEFAULT_TITLE });
  annotations = $state.raw<Map<string, AnnotationData>>(new Map());
  /** Column index used as the annotation ID key; null = row index. */
  annotateIdColumn = $state<number | null>(null);

  // ---- A11: around-the-map labels ---------------------------------------------
  /** World-space group data for the AroundLabelsOverlay; null when labelStyle is 'over'. */
  aroundLabelGroups = $state.raw<import('./labels/around').AroundLabelGroup[] | null>(null);

  // ---- A12: glow overlay -------------------------------------------------------
  /**
   * Incremented each time the glow overlay should redraw (view change, settings change,
   * or new point data).  The GlowOverlay component watches this value.
   */
  glowVersion = $state(0);

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

  // ---- search state (A7) -------------------------------------------------------
  /** Current search query string (empty = no search). */
  searchQuery = $state('');
  /** Number of matching rows for the current search. */
  searchMatchCount = $state(0);
  /** True while waiting for the kernel search response. */
  searchPending = $state(false);

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
  /** Raw float32 values for the histogram filter column (A13). */
  histRawValues: Float32Array | null = null;
  histRawColumn: number | null = null;
  colorsAnchors: Uint8Array | null = null;
  labelCodes: Uint16Array | null = null;
  labelCodesAnchors: Uint16Array | null = null;
  labelTimer: ReturnType<typeof setTimeout> | undefined;
  /** Fine (secondary) label codes for A8 column multi-level. */
  fineLabelCodes: Uint16Array | null = null;
  fineLabelCodesAnchors: Uint16Array | null = null;
  fineLabelMeta: import('../shared/protocol').CategoricalColorMeta | null = null;
  cluster: { codes: Uint16Array; codesAnchors: Uint16Array; k: number; counts: number[]; outlines: [number, number][][][] } | null = null;
  /** Fine (second level) cluster result for A8 multi-level cluster labels. */
  clusterFine: { codes: Uint16Array; codesAnchors: Uint16Array; k: number; counts: number[]; outlines: [number, number][][][] } | null = null;
  clusterFineNames: string[] = [];
  clusterFinder: ClusterFinder | null = null;
  clusterSeq = 0;
  nameSeq = 0;
  compareSeq = 0;
  clusterRunning = 0;
  nameSource: { column: number; codes: Uint16Array; meta: CategoricalColorMeta } | null = null;
  labelAt = 0;
  hit: { index: HitIndex; map: (i: number) => number } | null = null;
  /**
   * Screen-space XY coordinates of all points in 3D mode (n*2 flat Float32Array),
   * populated by view3d.ts when the camera stops. Null in 2D mode.
   */
  _3dScreenXY: Float32Array | null = null;
  hoverTimer: ReturnType<typeof setTimeout> | undefined;
  hoverSeq = 0;
  /** Extended: includes prepIdx for hover ring and cache lookups. */
  pendingHover: { x: number; y: number; prepIdx?: number } | null = null;
  autoFit = true;
  /** Overview zoom set by the last fit() call; used for zoom-dependent fine-label visibility (A8). */
  fittedZoom: number = -Infinity;
  liveRun = false;
  inbox: Promise<void> = Promise.resolve();
  gpuProbe: Promise<boolean> = probeWebGpu();

  // ---- search non-reactive state (A7) -----------------------------------------
  /** Per-prepared-row search mask (1 = match, 0 = no match).  Null = no search. */
  searchMask: Uint8Array | null = null;
  /** Cache of search masks by "column:query" key. */
  searchCache = new Map<string, Uint8Array>();

  // ---- hover non-reactive state (H2–H8) ----------------------------------------
  /** LRU cache of fetched row values, keyed by prepared-row index (H2). */
  rowCache = new LruCache<CachedRow>(1000);
  /** Sequence number of the in-flight `rows` request (0 = none). */
  hoverInflight = 0;
  /** Monotonically increasing sequence for `rows` requests. */
  hoverRowsSeq = 0;
  /** Sequence counter for annotation-image rows requests (separate from hover). */
  annRowsSeq = 0;
  /** Callbacks waiting for pixel data for a given prepared-row index (A4 image annotations). */
  annotationPixelPending = new Map<number, Array<(pixels: (number | null)[]) => void>>();
  /** Callbacks waiting for imageUri for a given prepared-row index (D5 image-URL annotations). */
  annotationImageUriPending = new Map<number, Array<(uri: string) => void>>();
  /** Callbacks waiting for row values for a given prepared-row index (D5 image-URL annotations). */
  annotationRowsPending = new Map<number, Array<(cached: import('./hover/cache').CachedRow) => void>>();
  /** Lazy UTF-8 title decoder (H3). */
  textsStore = new TextsStore();

  // ---- lifecycle ---------------------------------------------------------------
  attach(container: HTMLElement): void {
    // D11 + A1: initialise the font module once; bridge vscode.post → postMessage interface.
    initFonts({ postMessage: (msg: unknown) => vscode.post(msg as import('../shared/protocol').ToHost) });
    this.renderer = new ScatterRenderer(container);
    this.renderer.setStyle(this.view);
    this.renderer.onPointer((p) => this.onPointer(p));
    // A3: wire up label drag callbacks.
    this.renderer.onLabelDrag({
      onEnd: (label, delta) => {
        // Accumulate the new offset on top of any existing one.
        const key = label.key ?? label.text;
        const existing = this.labels.dragOffsets?.[key] ?? [0, 0];
        setDragOffsetImpl(this, key, [existing[0] + delta[0], existing[1] + delta[1]]);
      },
      onRightClick: (label, _pos) => {
        const key = label.key ?? label.text;
        setDragOffsetImpl(this, key, null);
      },
    });
    // A8: re-schedule labels when zoom changes.  A12: also invalidate glow.
    this.renderer.onViewChange((_zoom) => {
      scheduleLabelsImpl(this);
      if (this.view.glow && this.dims === 2) this.glowVersion++;
      if (this.dims === 3) on3DViewChangeImpl(this);
    });
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
   * CPU-side count of points that pass the current filter (legend + histogram).
   * Returns the total anchor count when no filter is active.
   * Useful for scenario assertions without needing GPU pixel reads.
   * Reads _renderTick to create a reactive dependency so the ExploreTab UI updates (A13).
   */
  get renderVisibleCount(): number {
    void this._renderTick; // reactive dependency; incremented by render()
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
      case 'sizes':
        await onSizesImpl(this, msg.column, msg.file, msg.meta);
        break;
      case 'histValues':
        await onHistValuesImpl(this, msg.column, msg.file);
        break;
      case 'histogram':
        onHistogramImpl(this, msg.column, msg.data);
        break;
      case 'anchorXY':
        await onAnchorXYImpl(this, msg.file, msg.seconds);
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
      case 'searchResults':
        await onSearchResultsImpl(this, msg);
        break;
      case 'searchEmpty':
        onSearchEmptyImpl(this, msg);
        break;
      case 'datamapplotSaved':
        this.flash(`Saved to ${msg.path}`);
        break;
      case 'exportHtmlAssembly':
        // Assemble the final HTML in the webview (packing, gzip, base64, HTML string)
        // then post exportHtmlReady back to the host.
        assembleHtmlExport(msg).catch((e: unknown) => {
          this.flash(`HTML export failed: ${e instanceof Error ? e.message : String(e)}`);
          this.htmlExportOpen = false;
        });
        break;
      case 'htmlExportSaved':
        this.htmlExportOpen = false;
        if (msg.path) this.flash(`HTML export saved to ${msg.path}`);
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
  /** Set the output dimensionality (2D/3D) and rebuild the layout (T2). */
  setDims(d: 2 | 3): void {
    if (this.dims === d) return;
    this.dims = d;
    this.renderer?.setDims(d);
    // Clear 3D-specific state when switching to 2D.
    if (d === 2) this._3dScreenXY = null;
    if (this.phase === 'ready' || this.phase === 'embedding') {
      this.startUmap();
    }
  }
  stopUmap(): void { stopUmapImpl(this); }
  pauseUmap(): void { pauseUmapImpl(this); }
  resumeUmap(): void { resumeUmapImpl(this); }
  stepUmap(epochs: number): void { stepUmapImpl(this, epochs); }
  stopWorker(): void { stopWorkerImpl(this); }

  // ---- projection --------------------------------------------------------------
  project(): void { projectImpl(this); }
  runExact(): void { runExactImpl(this); }
  cancelKernel(): void { cancelKernelImpl(this); }
  /** Run polars-umap on anchors only in the kernel (P3). */
  runKernelAnchors(): void { runKernelAnchorsImpl(this); }

  // ---- colors ------------------------------------------------------------------
  setColorColumn(c: number | null): void { setColorColumnImpl(this, c); }
  requestColors(): void { requestColorsImpl(this); }
  recolor(): void { recolorImpl(this); }
  categoryColor(i: number): string { return categoryColorImpl(this, i); }
  updateMapColors(recolor = true): void { updateMapColorsImpl(this, recolor); }
  /** Toggle color-by-cluster mode (A6). When on, cluster codes drive the color. */
  setColorByCluster(on: boolean): void { setColorByClusterImpl(this, on); }
  /** Recolor using the current cluster codes (A6). */
  recolorByClusters(): void { recolorByClustersImpl(this); }
  // ---- size by column (A10) ----------------------------------------------------
  setSizeColumn(c: number | null): void { setSizeColumnImpl(this, c); }
  requestSizes(): void { requestSizesImpl(this); }
  // ---- histogram filter (A13) --------------------------------------------------
  setHistColumn(c: number | null): void { setHistColumnImpl(this, c); }
  requestHistogram(): void { requestHistogramImpl(this); }
  setHistRange(range: [number, number] | null): void { setHistRangeImpl(this, range); }

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
  /** Set/clear a drag offset for a label group (A3). key = group name. */
  setDragOffset(key: string, offset: [number, number] | null): void { setDragOffsetImpl(this, key, offset); }
  /** Clear all drag offsets (A3). */
  resetAllDragOffsets(): void { resetAllDragOffsetsImpl(this); }

  // ---- clusters ----------------------------------------------------------------
  refreshClusters(): void { refreshClustersImpl(this); }
  nameClusters(): void { nameClustersImpl(this); }

  // ---- hover -------------------------------------------------------------------
  /** @internal Accessible via a['onPointer'] in harness tests. */
  onPointer(p: { x: number; y: number; world: [number, number] } | null): void { onPointerImpl(this, p); }
  onClick(e: MouseEvent): void {
    // Suppress click if it follows a label drag (the mouse-up after dragging a label would
    // otherwise be treated as a point click and pin a hover card — H7).
    if (this.renderer?.consumeSuppressClick()) return;
    onClickImpl(this, e);
  }
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

  // ---- 3D camera (T3) ----------------------------------------------------------
  /** Toggle auto-rotation in 3D mode. */
  toggleAutoRotate(): void {
    this.autoRotate = !this.autoRotate;
    if (this.autoRotate) startAutoRotateImpl(this);
    else stopAutoRotateImpl();
  }
  /** Set a camera preset (top/front/side) in 3D mode. */
  setCameraPreset(preset: CameraPreset): void { setCameraPresetImpl(this, preset); }
  /** Rebuild the screen-space hit index for 3D hover (T4). */
  rebuild3DHitIndex(): void { rebuild3DHitIndexImpl(this); }

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

  // ---- annotations (A1, A4) ----------------------------------------------------
  addAnnotation(prepIdx: number, row: number, worldX: number, worldY: number, text: string): AnnotationData | null { return addAnnotationImpl(this, prepIdx, row, worldX, worldY, text); }
  removeAnnotation(id: string): void { removeAnnotationImpl(this, id); }
  clearAnnotations(): void { clearAnnotationsImpl(this); }
  updateAnnotationOffset(id: string, offsetX: number, offsetY: number): void { updateAnnotationOffsetImpl(this, id, offsetX, offsetY); }
  updateAnnotationText(id: string, text: string): void { updateAnnotationTextImpl(this, id, text); }
  updateAnnotationStyle(id: string, style: AnnotationData['style']): void { updateAnnotationStyleImpl(this, id, style); }
  exportAnnotationsJson(): string { return exportAnnotationsJsonImpl(this); }
  importAnnotationsJson(json: string): void { importAnnotationsJsonImpl(this, json); }
  /** Handle a click in annotate-tool mode; returns the new annotation or null. */
  handleAnnotateClick(titleText = ''): AnnotationData | null { return handleAnnotateClickImpl(this, titleText); }
  /** Create an annotation from the pinned hover card. */
  addAnnotationFromCard(card: { row: number; title?: string; preparedIdx: number; x: number; y: number; image?: (number | null)[]; imageUri?: string }): AnnotationData | null { return addAnnotationFromCardImpl(this, card); }

  // ---- actions -----------------------------------------------------------------
  addCoordinates(): void { addCoordinatesImpl(this); }
  savePng(): void { savePngImpl(this); }
  copyPython(): void { copyPythonImpl(this); }
  copyPolarsUmap(): void { copyPolarsUmapImpl(this); }
  copyDataMapPlot(): void { copyDataMapPlotImpl(this); }
  exportDataMapPlot(): void { exportDataMapPlotImpl(this); }
  exportHtml(opts: HtmlExportOptions): void { exportHtmlImpl(this, opts); }
  estimateExportBytes(opts: Pick<HtmlExportOptions, 'tooltipColumns' | 'maxChars'>): number { return estimateExportBytesImpl(this, opts); }
  reload(): void { reloadImpl(this); }
  persist(): void { persistImpl(this); }
  setSession(sessionId: string, languageId: string, variable: string): void { setSessionImpl(this, sessionId, languageId, variable); }
  showError(message: string): void { showErrorImpl(this, message); }
  flash(message: string): void { flashImpl(this, message); }

  // ---- search (A7) -------------------------------------------------------------
  /** The column to search (title column, or first text column). */
  get searchColumnIndex(): number | null { return searchColumnImpl(this); }
  /** Run a search for `query`. Pass empty string to clear. */
  search(query: string, regex = false): void {
    const col = this.searchColumnIndex;
    if (!query.trim()) { clearSearchImpl(this); return; }
    if (col === null) return;
    runSearchImpl(this, query, col, regex);
  }
  /** Clear the search and restore normal rendering. */
  clearSearch(): void { clearSearchImpl(this); }
  /** Zoom the view to the matching points (called on Enter). */
  zoomToSearchMatches(): void { zoomToSearchMatchesImpl(this); }

  /** Request full-screen mode (N5 / F1).  In Positron, posts a ToHost message so the host
   *  runs workbench.action.maximizeEditorHideSidebar.  In a plain browser the caller uses
   *  the browser Fullscreen API instead (PlotToolbar.svelte checks isPositron). */
  setFullscreen(on: boolean): void {
    vscode.post({ type: 'fullscreen', on });
  }
}
