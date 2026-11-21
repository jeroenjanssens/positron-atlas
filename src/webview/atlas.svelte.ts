import type {
  CategoricalColorMeta,
  ColorMeta,
  DescribeResult,
  FileRef,
  JobStatus,
  LabelOptions,
  SelectionComparison,
  PanelState,
  PrepareOptions,
  PrepareResult,
  Settings,
  ToWebview,
  UmapParams,
} from '../shared/protocol';
import { bytesToBase64, fetchTyped, float32ToBase64, vscode } from './vscode';
import UmapWorker from './workers/umap.worker.ts?worker&inline';
import type { WorkerIn, WorkerOut } from './workers/umap.worker';
import { ScatterRenderer, type MapLabel, type PointSet } from './render/renderer';
import { collisionPriorities, labelSizes, placeGroupLabels } from './labels/place';
import { DETAIL_THRESHOLDS, assignToClusters, densityGrid } from './labels/clusters';
import { ClusterFinder } from './labels/clusterWorker';
import { HitIndex, bounds } from './render/hitIndex';
import { encodeCategorical, encodeConstant, encodeNumeric, gatherRgba } from './color/encode';
import { CATEGORICAL, DEFAULT_POINT_COLOR, hexToRgb } from './color/colormaps';
import { mapPalette } from './color/mapPalette';
import { combineSelection, countSelected, fadeUnselected, invertSelection, packBits, pointsInPolygon, type SelectMode } from './select/lasso';
import { dataMapPlotSnippet, formatCount, pythonSnippet, isRebuild, liveChanges, lowerBound, toHex, detectImageColumns, guessImageWidth, type ImageColumns } from './logic';
import { DEFAULT_UMAP } from './defaults';

export { DEFAULT_UMAP };

export interface ViewOptions {
  pointSize: number;
  opacity: number;
  mode: 'points' | 'density';
  colormap: string;
  /** Plot background as a hex color; '' follows the theme's editor background. */
  background: string;
  /** Show each row as an image in the hover tooltip. */
  images: boolean;
  /** Image width in pixels; 0 = automatic (square). */
  imageWidth: number;
  /** Swap dark and light in the image thumbnails. */
  imageInvert: boolean;
  /** Categorical colors: 'map' follows the layout (nearby groups get related hues), 'tableau' is Tableau 20. */
  palette: 'map' | 'tableau';
}

type Phase = 'loading' | 'preparing' | 'embedding' | 'ready' | 'error';

export type SidebarTab = 'map' | 'explore' | 'annotate';

export interface UiState {
  tab: SidebarTab;
  /** Ids of collapsed sidebar sections. */
  closed: string[];
}

/** Auto-place all rows after UMAP when the estimate is below this many seconds. */
const AUTO_PROJECT_SECONDS = 20;

/** Most categories of a label column that get a label (the rest are not labeled). */
export const MAX_LABELS = 200;

/** Recompute label positions at most this often while the layout animates (ms). */
const LABEL_INTERVAL_MS = 250;

export class Atlas {
  // ---- reactive UI state -------------------------------------------------------------
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
  /** Automatic clusters: how many were found, their names, and whether clustering runs. */
  clusterCount = $state(0);
  clusterNames = $state.raw<string[]>([]);
  clustering = $state(false);
  /** Categories of the label column (null until loaded). */
  labelMeta = $state.raw<CategoricalColorMeta | null>(null);
  /** Number of labels on the map (before overlapping ones are hidden). */
  labelCount = $state(0);
  /** Plot tool: pan (drag pans, Shift/Alt-drag selects) or lasso (drag selects). */
  tool = $state<'pan' | 'lasso'>('pan');
  /** Selected prepared rows (1 = selected), or null. */
  selection = $state.raw<Uint8Array | null>(null);
  selectedCount = $state(0);
  /** The selection was made on the anchors (before all rows were placed). */
  selectionOnAnchors = $state(false);
  comparison = $state.raw<SelectionComparison | null>(null);
  comparing = $state(false);
  colorColumn = $state<number | null>(null);
  forceCategorical = $state(false);
  colorMeta = $state.raw<ColorMeta | null>(null);
  /** Colors of the color column's categories when the palette follows the map (null until the layout settles). */
  mapColors = $state.raw<string[] | null>(null);
  colorRange = $state<[number, number] | null>(null);
  prepared = $state.raw<PrepareResult | null>(null);
  kernelStatus = $state.raw<{ task: string; stage: string; progress: number; message: string } | null>(null);
  umapProgress = $state.raw<{ stage: string; progress: number; epoch: number; total: number } | null>(null);
  projection = $state<'none' | 'stale' | 'running' | 'done'>('none');
  projectProgress = $state(0);
  estimate = $state.raw<{ seconds: number; rows: number } | null>(null);
  error = $state.raw<{ message: string; detail?: string; fatal?: boolean } | null>(null);
  tooltip = $state.raw<{ x: number; y: number; row: number; values: [string, string][]; image?: (number | null)[] } | null>(null);
  timings = $state.raw<Record<string, number>>({});
  toast = $state<string | null>(null);
  useGpu = $state(false);
  /** The browser UMAP is paused mid-schedule (step through epochs). */
  paused = $state(false);
  /** Set by probing navigator.gpu.requestAdapter() at startup. */
  gpuAvailable = $state(false);
  /** 'browser': live WASM UMAP; 'kernel': exact umap-learn in the kernel (if installed). */
  computeMode = $state<'browser' | 'kernel'>('browser');

  // ---- non-reactive data -------------------------------------------------------------
  private renderer: ScatterRenderer | null = null;
  private worker: Worker | null = null;
  private runId = 0;
  private appliedUmap: UmapParams | null = null;
  private anchors: Float32Array | null = null;
  private anchorPos: Uint32Array | null = null;
  private anchorXY: Float32Array | null = null;
  private allXY: Float32Array | null = null;
  private placedRows = 0;
  private colorValues: Float32Array | Uint16Array | null = null;
  private colorsAll: Uint8Array | null = null;
  private colorsAnchors: Uint8Array | null = null;
  /** Label category codes per prepared row, and gathered at the anchors. */
  private labelCodes: Uint16Array | null = null;
  private labelCodesAnchors: Uint16Array | null = null;
  private labelTimer: ReturnType<typeof setTimeout> | undefined;
  private cluster: { codes: Uint16Array; codesAnchors: Uint16Array; k: number; counts: number[]; outlines: [number, number][][][] } | null = null;
  private clusterFinder: ClusterFinder | null = null;
  private clusterSeq = 0;
  private nameSeq = 0;
  /** Codes of the column that names the clusters (Name clusters by → a column). */
  private nameSource: { column: number; codes: Uint16Array; meta: CategoricalColorMeta } | null = null;
  private labelAt = 0;
  private hit: { index: HitIndex; map: (i: number) => number } | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | undefined;
  private hoverSeq = 0;
  private pendingHover: { x: number; y: number } | null = null;
  private autoFit = true;
  private liveRun = false;
  private inbox: Promise<void> = Promise.resolve();
  private gpuProbe: Promise<boolean> = probeWebGpu();

  attach(container: HTMLElement): void {
    this.renderer = new ScatterRenderer(container);
    this.renderer.setStyle(this.view);
    this.renderer.onPointer((p) => this.onPointer(p));
    this.createWorker();
    window.addEventListener('message', (ev: MessageEvent<ToWebview>) => {
      // Handle messages strictly in order: e.g. 'projected' must wait until the last
      // 'xyChunk' has been fetched and copied.
      this.inbox = this.inbox
        .then(() => this.handle(ev.data))
        .catch((e) => this.showError(e instanceof Error ? e.message : String(e)));
    });
    void this.gpuProbe.then((ok) => {
      this.gpuAvailable = ok;
      vscode.post({ type: 'ready' });
    });
  }

  private createWorker(): void {
    this.worker?.terminate();
    this.worker = new UmapWorker();
    this.worker.onmessage = (ev: MessageEvent<WorkerOut>) => this.onWorker(ev.data);
    this.worker.onerror = (ev) => {
      // An uncaught WASM panic leaves the instance unusable: start a fresh worker.
      ev.preventDefault();
      this.createWorker();
      if (this.useGpu) {
        this.flash(`GPU UMAP failed (${ev.message}); using the CPU.`);
        this.useGpu = false;
        this.startUmap();
      } else {
        this.showError(`UMAP worker failed: ${ev.message}`);
        this.phase = this.prepared ? 'ready' : 'error';
      }
    };
  }

  destroy(): void {
    clearTimeout(this.labelTimer);
    this.clusterFinder?.destroy();
    this.worker?.terminate();
    this.renderer?.destroy();
  }

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

  // ---- messages from the extension host ----------------------------------------------
  private async handle(msg: ToWebview): Promise<void> {
    switch (msg.type) {
      case 'init':
        this.setSession(msg.sessionId, 'python', msg.variable);
        this.onInit(msg.describe, msg.settings, msg.variable, msg.state);
        break;
      case 'status':
        this.onStatus(msg.task, msg.status);
        break;
      case 'prepared':
        await this.onPrepared(msg.result, msg.anchors, msg.anchorPos);
        break;
      case 'estimate':
        this.estimate = { seconds: msg.seconds, rows: msg.rows };
        if (msg.seconds <= AUTO_PROJECT_SECONDS && this.projection === 'stale' && this.phase === 'ready') {
          this.project();
        }
        break;
      case 'xyChunk':
        await this.onXYChunk(msg.file);
        break;
      case 'projected':
        this.onProjected(msg.seconds, !!msg.exact);
        break;
      case 'colors':
        await this.onColors(msg.column, msg.file, msg.meta);
        break;
      case 'labelCodes':
        await this.onLabelCodes(msg.column, msg.file, msg.meta, msg.purpose ?? 'labels');
        break;
      case 'groupNames':
        this.onGroupNames(msg.seq, msg.names);
        break;
      case 'labelsWritten':
        this.onLabelsWritten(msg.variable, msg.column, msg.rows, msg.describe);
        break;
      case 'comparison':
        this.comparing = false;
        // Ignore a result for a selection that has changed since.
        if (this.selection && msg.result.selected === this.selectedCount) {
          this.comparison = msg.result;
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
      case 'error':
        this.error = { message: msg.message, detail: msg.detail, fatal: msg.fatal };
        this.comparing = false;
        if (msg.fatal) {
          this.phase = 'error';
        } else if (this.phase === 'preparing' || (this.phase === 'embedding' && this.computeMode === 'kernel')) {
          this.phase = this.prepared ? 'ready' : 'error';
          this.umapProgress = null;
        }
        if (this.projection === 'running') {
          this.projection = 'stale';
        }
        break;
      case 'coordsAdded':
        this.flash(`Added ${msg.columns.join(', ')} to ${msg.variable}`);
        break;
    }
  }

  private onInit(d: DescribeResult, settings: Settings, variable: string, state?: PanelState): void {
    this.describe = d;
    this.settings = settings;
    this.variable = variable;
    this.error = null;
    const numeric = d.columns.filter((c) => c.kind === 'numeric' || c.kind === 'bool').map((c) => c.index);
    const valid = new Set(d.columns.map((c) => c.index));
    const saved = state?.prepare;
    this.prepare = {
      features: saved?.features?.filter((i) => valid.has(i)).length ? saved.features.filter((i) => valid.has(i)) : numeric,
      samplePct: saved?.samplePct ?? settings.defaultSamplePct,
      standardize: saved?.standardize ?? true,
      pca: saved?.pca ?? settings.pcaEnabled,
      pcaDims: saved?.pcaDims ?? settings.pcaDims,
      nanPolicy: saved?.nanPolicy ?? 'drop',
      seed: saved?.seed ?? 42,
      maxAnchors: saved?.maxAnchors ?? (this.useGpuFor(settings) ? settings.maxAnchors : Math.min(settings.maxAnchors, settings.maxAnchorsCpu)),
      anchorBudget: settings.anchorBudget,
    };
    this.useGpu = this.useGpuFor(settings);
    if (state?.umap) {
      this.umap = { ...DEFAULT_UMAP, ...state.umap };
    }
    if (state?.ui) {
      const tab = state.ui.tab;
      this.ui = {
        tab: tab === 'map' || tab === 'explore' || tab === 'annotate' ? tab : 'map',
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
      this.labels = { column: col, minSize, maxSize, colorText: l.colorText !== false, clusters: l.clusters === true && col === null, detail, nameBy, outlines: l.outlines !== false };
    }
    if (state?.view) {
      this.view = { ...this.view, ...state.view };
      this.renderer?.setStyle(this.view);
    }
    if (state && 'colorColumn' in state && (state.colorColumn === null || valid.has(state.colorColumn!))) {
      this.colorColumn = state.colorColumn ?? null;
    } else {
      // Default color: first low-cardinality categorical column.
      const cat = d.columns.find((c) => (c.kind === 'categorical' || c.kind === 'bool') && (c.n_unique_est ?? 99) <= 20);
      this.colorColumn = cat ? cat.index : null;
    }
    if (this.prepare.features.length === 0) {
      this.phase = 'error';
      this.error = { message: 'This DataFrame has no numeric columns to embed.' };
      return;
    }
    this.runPrepare();
  }

  private useGpuFor(settings: Settings): boolean {
    return settings.useWebGpu && this.gpuAvailable;
  }

  private onStatus(task: string, s: JobStatus): void {
    this.kernelStatus = { task, stage: s.stage, progress: s.progress, message: s.message };
    if (task === 'project') {
      this.projectProgress = s.progress;
    }
    if (s.stale) {
      this.flash('The DataFrame changed in the session. Reload to see the latest data.');
    }
  }

  // ---- prepare -----------------------------------------------------------------------
  runPrepare(): void {
    this.applied = $state.snapshot(this.prepare) as PrepareOptions;
    this.setSelection(null); // the prepared rows change
    this.phase = 'preparing';
    this.error = null;
    this.projection = 'none';
    this.estimate = null;
    this.stopWorker();
    vscode.post({ type: 'prepare', options: this.applied });
  }

  private async onPrepared(result: PrepareResult, anchorsRef: FileRef, posRef: FileRef): Promise<void> {
    const t0 = performance.now();
    const [anchors, pos] = await Promise.all([fetchTyped(anchorsRef.uri, 'f32'), fetchTyped(posRef.uri, 'u32')]);
    this.anchors = anchors as Float32Array;
    this.anchorPos = pos as Uint32Array;
    this.prepared = result;
    this.allXY = result.needsProjection ? new Float32Array(result.nKept * 2) : null;
    this.placedRows = 0;
    this.anchorXY = null;
    this.hit = null;
    this.colorValues = null;
    this.timings = { load: (performance.now() - t0) / 1000 };
    this.autoFit = true;
    this.labelCodes = null;
    this.labelCodesAnchors = null;
    this.cluster = null;
    this.clusterCount = 0;
    this.clusterNames = [];
    this.nameSource = null;
    this.clusterSeq++;
    this.recolor();
    if (this.colorColumn !== null) {
      this.requestColors();
    }
    if (this.labels.column !== null) {
      this.requestLabelCodes();
    }
    this.startUmap();
  }

  // ---- UMAP --------------------------------------------------------------------------
  startUmap(paused = false): void {
    if (!this.anchors || !this.prepared) {
      return;
    }
    this.runId++;
    this.liveRun = false;
    this.paused = false;
    this.appliedUmap = $state.snapshot(this.umap) as UmapParams;
    this.phase = 'embedding';
    this.umapProgress = { stage: 'neighbors', progress: 0, epoch: 0, total: this.umap.nEpochs };
    this.projection = this.prepared.needsProjection ? 'stale' : 'none';
    this.estimate = null;
    this.hit = null;
    this.tooltip = null;
    // A fresh worker per run: the WASM module cannot create a second WebGPU UMAP
    // instance after destroying one, and terminating also cancels in-flight work.
    this.createWorker();
    const data = this.anchors.slice();
    const msg: WorkerIn = {
      type: 'start',
      runId: this.runId,
      data,
      n: this.prepared.nAnchors,
      d: this.prepared.dims,
      params: this.appliedUmap,
      gpu: this.useGpu,
      paused,
    };
    this.worker!.postMessage(msg, [data.buffer]);
  }

  /** Called when UMAP controls change; rebuilds or applies live. */
  umapChanged(): void {
    if (this.computeMode === 'kernel' || !this.appliedUmap || !this.anchors) {
      return;
    }
    const next = $state.snapshot(this.umap) as UmapParams;
    if (isRebuild(this.appliedUmap, next)) {
      this.startUmap();
      return;
    }
    const live = liveChanges(this.appliedUmap, next);
    this.appliedUmap = next;
    if (Object.keys(live).length === 0 || !this.worker) {
      return;
    }
    this.phase = 'embedding';
    this.liveRun = true;
    this.paused = false;
    this.projection = this.prepared?.needsProjection ? 'stale' : 'none';
    this.estimate = null;
    this.hit = null;
    this.tooltip = null;
    const epochs = Math.max(60, Math.round(next.nEpochs / 2));
    this.umapProgress = { stage: 'optimizing', progress: 1, epoch: 0, total: epochs };
    this.worker.postMessage({ type: 'live', runId: this.runId, params: live, epochs } satisfies WorkerIn);
  }

  /** End the schedule now and keep the current layout. */
  stopUmap(): void {
    this.worker?.postMessage({ type: 'stop', runId: this.runId } satisfies WorkerIn);
  }

  pauseUmap(): void {
    this.worker?.postMessage({ type: 'pause', runId: this.runId } satisfies WorkerIn);
  }

  resumeUmap(): void {
    this.paused = false;
    this.worker?.postMessage({ type: 'resume', runId: this.runId } satisfies WorkerIn);
  }

  /** Run `epochs` more epochs of the paused schedule. */
  stepUmap(epochs: number): void {
    if (!this.paused) return;
    this.worker?.postMessage({ type: 'step', runId: this.runId, epochs } satisfies WorkerIn);
  }

  private stopWorker(): void {
    this.runId++;
    this.worker?.postMessage({ type: 'stop', runId: this.runId - 1 } satisfies WorkerIn);
  }

  private onWorker(m: WorkerOut): void {
    if (m.runId !== this.runId) {
      return;
    }
    switch (m.type) {
      case 'progress':
        this.umapProgress = { stage: m.stage, progress: m.progress, epoch: 0, total: this.umap.nEpochs };
        break;
      case 'frame':
        this.anchorXY = m.embedding;
        this.paused = false;
        this.umapProgress = { stage: 'optimizing', progress: 1, epoch: m.epoch, total: m.total };
        this.render();
        break;
      case 'paused':
        this.anchorXY = m.embedding;
        this.paused = true;
        this.hit = null;
        this.umapProgress = { stage: 'paused', progress: 1, epoch: m.epoch, total: m.total };
        this.render();
        break;
      case 'done':
        this.anchorXY = m.embedding;
        this.paused = false;
        if (m.seconds) {
          this.timings = this.liveRun ? { ...this.timings, update: m.seconds } : { ...this.timings, umap: m.seconds, update: 0 };
        }
        this.phase = 'ready';
        this.umapProgress = null;
        this.updateMapColors(false);
        this.recolor();
        this.refreshClusters();
        if (this.prepared?.needsProjection) {
          vscode.post({ type: 'estimate' });
        }
        break;
      case 'error':
        if (this.useGpu) {
          // WebGPU can fail on some drivers; fall back to the CPU once.
          this.flash(`WebGPU UMAP failed (${m.message}); using the CPU.`);
          this.useGpu = false;
          this.startUmap();
          return;
        }
        this.showError(`UMAP failed: ${m.message}`);
        this.phase = 'ready';
        break;
    }
  }

  // ---- projection --------------------------------------------------------------------
  project(): void {
    if (!this.anchorXY || !this.prepared?.needsProjection) {
      return;
    }
    this.projection = 'running';
    this.projectProgress = 0;
    this.placedRows = 0;
    vscode.post({ type: 'project', anchorXY: float32ToBase64(this.anchorXY), metric: this.umap.metric, seed: this.umap.seed });
  }

  /** Exact UMAP of all prepared rows with umap-learn in the kernel. */
  runExact(): void {
    if (!this.prepared) {
      return;
    }
    this.stopWorker();
    this.allXY = new Float32Array(this.prepared.nKept * 2);
    this.placedRows = 0;
    this.projection = 'running';
    this.projectProgress = 0;
    this.phase = 'embedding';
    this.umapProgress = { stage: 'umap-learn (kernel)', progress: 0, epoch: 0, total: 0 };
    this.hit = null;
    this.tooltip = null;
    vscode.post({ type: 'exact', params: $state.snapshot(this.umap) as UmapParams });
  }

  private onProjected(seconds: number, exact: boolean): void {
    this.projectProgress = 1;
    this.hit = null;
    if (exact && this.prepared && this.allXY && this.anchorPos) {
      // Keep the anchor view consistent with the kernel layout.
      const a = new Float32Array(this.prepared.nAnchors * 2);
      for (let i = 0; i < this.anchorPos.length; i++) {
        a[2 * i] = this.allXY[2 * this.anchorPos[i]];
        a[2 * i + 1] = this.allXY[2 * this.anchorPos[i] + 1];
      }
      this.anchorXY = a;
      this.placedRows = this.prepared.nKept;
      this.phase = 'ready';
      this.umapProgress = null;
      this.autoFit = true;
      this.timings = { ...this.timings, umap: seconds, project: 0 };
      this.projection = this.prepared.needsProjection ? 'done' : 'none';
    } else {
      this.timings = { ...this.timings, project: seconds };
      this.projection = 'done';
    }
    this.updateMapColors(false);
    this.recolor();
    this.refreshClusters();
  }

  cancelKernel(): void {
    vscode.post({ type: 'cancel' });
    if (this.projection === 'running') {
      this.projection = 'stale';
    }
  }

  private async onXYChunk(file: FileRef): Promise<void> {
    if (!this.allXY || this.projection !== 'running') {
      return;
    }
    const xy = (await fetchTyped(file.uri, 'f32')) as Float32Array;
    const offset = file.offset ?? 0;
    this.allXY.set(xy, offset * 2);
    this.placedRows = Math.max(this.placedRows, offset + xy.length / 2);
    this.render();
  }

  // ---- colors ------------------------------------------------------------------------
  setColorColumn(c: number | null): void {
    this.colorColumn = c;
    this.forceCategorical = false;
    this.colorMeta = null;
    this.colorValues = null;
    this.mapColors = null;
    if (c === null) {
      this.recolor();
    } else {
      this.requestColors();
    }
  }

  requestColors(): void {
    if (this.colorColumn !== null && this.prepared) {
      vscode.post({ type: 'colors', column: this.colorColumn, forceCategorical: this.forceCategorical });
    }
  }

  private async onColors(column: number, file: FileRef, meta: ColorMeta): Promise<void> {
    if (column !== this.colorColumn) {
      return;
    }
    const values = await fetchTyped(file.uri, file.dtype);
    if (values.length !== this.nKept) {
      return; // stale (from a previous prepare)
    }
    this.colorValues = values as Float32Array | Uint16Array;
    this.colorMeta = meta;
    this.colorRange = meta.kind === 'numeric' ? [meta.q02 ?? meta.min ?? 0, meta.q98 ?? meta.max ?? 1] : null;
    this.mapColors = null;
    if (this.phase === 'ready') {
      this.updateMapColors(false);
    }
    this.recolor();
  }

  recolor(): void {
    if (!this.prepared || !this.anchorPos) {
      return;
    }
    const n = this.nKept;
    const meta = this.colorMeta;
    if (!this.colorValues || !meta) {
      this.colorsAll = encodeConstant(n, DEFAULT_POINT_COLOR);
    } else if (meta.kind === 'numeric') {
      const [lo, hi] = this.colorRange ?? [meta.min ?? 0, meta.max ?? 1];
      this.colorsAll = encodeNumeric(this.colorValues as Float32Array, lo, hi, this.view.colormap, this.colorsAll ?? undefined);
    } else {
      this.colorsAll = encodeCategorical(this.colorValues as Uint16Array, meta.categories.length, this.colorsAll ?? undefined, (i) => this.categoryColor(i));
    }
    if (this.selection && this.selection.length === n) {
      fadeUnselected(this.colorsAll, this.selection, hexToRgb(toHex(this.plotBackground())));
    }
    this.colorsAnchors = this.prepared.needsProjection ? gatherRgba(this.colorsAll, this.anchorPos) : this.colorsAll;
    this.render();
  }

  // ---- labels ------------------------------------------------------------------------
  /** Label source: a column (index), automatic clusters, or none. */
  setLabelSource(source: number | 'clusters' | null): void {
    const clusters = source === 'clusters';
    this.labels = { ...this.labels, column: typeof source === 'number' ? source : null, clusters };
    // Clear the previous source's labels right away (the new ones may take a moment).
    this.labelCount = 0;
    this.renderer?.setLabels([]);
    this.renderer?.setOutlines([]);
    this.labelMeta = null;
    this.labelCodes = null;
    this.labelCodesAnchors = null;
    if (typeof source === 'number') {
      this.requestLabelCodes();
    } else if (clusters) {
      this.refreshClusters();
    }
    this.updateLabels();
  }

  /** Label by a column (null: no labels). */
  setLabelColumn(c: number | null): void {
    this.setLabelSource(c);
  }

  setLabelOptions(o: Partial<LabelOptions>): void {
    const prev = this.labels;
    this.labels = { ...this.labels, ...o };
    if (this.labels.clusters && o.detail !== undefined && o.detail !== prev.detail) {
      this.refreshClusters();
    } else if (this.labels.clusters && o.nameBy !== undefined && o.nameBy !== prev.nameBy) {
      this.nameClusters();
    }
    this.updateLabels();
  }

  private requestLabelCodes(): void {
    if (this.labels.column !== null && !this.labels.clusters && this.prepared) {
      vscode.post({ type: 'labelCodes', column: this.labels.column, maxCategories: MAX_LABELS });
    }
  }

  private async onLabelCodes(column: number, file: FileRef, meta: ColorMeta, purpose: 'labels' | 'names'): Promise<void> {
    if (meta.kind !== 'categorical') {
      return;
    }
    const wanted = purpose === 'names' ? this.labels.clusters && this.labels.nameBy === column : !this.labels.clusters && column === this.labels.column;
    if (!wanted) {
      return;
    }
    const codes = (await fetchTyped(file.uri, 'u16')) as Uint16Array;
    if (codes.length !== this.nKept || !this.anchorPos) {
      return; // stale (from a previous prepare)
    }
    if (purpose === 'names') {
      if (this.labels.clusters && this.labels.nameBy === column) {
        this.nameSource = { column, codes, meta };
        this.nameClusters();
        this.updateLabels();
      }
      return;
    }
    if (column !== this.labels.column || this.labels.clusters) {
      return;
    }
    this.labelCodes = codes;
    this.labelCodesAnchors = this.prepared?.needsProjection ? gatherU16(codes, this.anchorPos) : codes;
    this.labelMeta = meta;
    this.updateLabels();
  }

  // ---- automatic clusters -------------------------------------------------------------
  /** Re-cluster the current layout (when it has settled; labels follow the points meanwhile). */
  refreshClusters(): void {
    if (this.labels.clusters && (this.phase === 'ready' || this.paused)) {
      void this.runClustering();
    }
  }

  private async runClustering(): Promise<void> {
    if (!this.labels.clusters || !this.prepared || !this.anchorXY || !this.anchorPos) {
      return;
    }
    const seq = ++this.clusterSeq;
    const prepared = this.prepared;
    const anchorPos = this.anchorPos;
    const onAll = !!prepared.needsProjection && this.projection === 'done' && !!this.allXY;
    const xy = onAll ? this.allXY! : this.anchorXY.slice();
    const n = onAll ? this.nKept : prepared.nAnchors;
    const grid = densityGrid(xy, n);
    if (!grid) {
      return;
    }
    this.clustering = true;
    let found;
    try {
      this.clusterFinder ??= new ClusterFinder();
      found = await this.clusterFinder.find(grid, DETAIL_THRESHOLDS[Math.min(5, Math.max(1, Math.round(this.labels.detail))) - 1]);
    } catch (e) {
      if (seq === this.clusterSeq) {
        this.clustering = false;
        this.showError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (seq !== this.clusterSeq || prepared !== this.prepared || !this.labels.clusters) {
      return; // superseded
    }
    const a = assignToClusters(grid, found, xy, n);
    let codes: Uint16Array;
    if (onAll || !prepared.needsProjection) {
      codes = a.codes;
    } else {
      // Clustered on the anchors only: the other rows are in no cluster until all rows are placed.
      codes = new Uint16Array(this.nKept).fill(a.k);
      for (let i = 0; i < anchorPos.length; i++) codes[anchorPos[i]] = a.codes[i];
    }
    this.cluster = {
      codes,
      codesAnchors: prepared.needsProjection ? gatherU16(codes, anchorPos) : codes,
      k: a.k,
      counts: a.counts,
      outlines: a.outlines,
    };
    this.clusterCount = a.k;
    this.clustering = false;
    this.nameClusters();
    this.updateLabels();
  }

  /** Cluster names: numbers, the most common value of a column, or distinguishing features (kernel). */
  private nameClusters(): void {
    const c = this.cluster;
    if (!c) {
      this.clusterNames = [];
      return;
    }
    const numbered = c.counts.map((_, i) => `Cluster ${i + 1}`);
    const by = this.labels.nameBy;
    if (by === 'features') {
      this.clusterNames = this.clusterNames.length === c.k ? this.clusterNames : numbered;
      const seq = ++this.nameSeq;
      const columns = (this.applied?.features ?? []).slice();
      vscode.post({ type: 'describeGroups', seq, codes: bytesToBase64(new Uint8Array(c.codes.buffer, c.codes.byteOffset, c.codes.byteLength)), k: c.k, columns });
      return;
    }
    if (typeof by === 'number') {
      const src = this.nameSource;
      if (!src || src.column !== by) {
        this.clusterNames = numbered;
        if (this.prepared) {
          vscode.post({ type: 'labelCodes', column: by, maxCategories: MAX_LABELS, purpose: 'names' });
        }
        return;
      }
      this.clusterNames = dominantNames(c.codes, c.k, src.codes, src.meta.categories);
      return;
    }
    this.clusterNames = numbered;
  }

  private onGroupNames(seq: number, names: string[]): void {
    const c = this.cluster;
    if (seq !== this.nameSeq || !c || names.length !== c.k || this.labels.nameBy !== 'features') {
      return;
    }
    this.clusterNames = names.map((nm, i) => nm || `Cluster ${i + 1}`);
    this.updateLabels();
  }

  /** Recompute labels now, or soon (throttled) while the layout animates. */
  private scheduleLabels(): void {
    if (this.labels.column === null && !this.labels.clusters && this.labelCount === 0) {
      return;
    }
    const wait = this.labelAt + LABEL_INTERVAL_MS - performance.now();
    if (this.phase !== 'embedding' || wait <= 0) {
      this.updateLabels();
    } else if (this.labelTimer === undefined) {
      this.labelTimer = setTimeout(() => this.updateLabels(), wait);
    }
  }

  /** The group codes and names that label the map right now, or null. */
  private labelGroups(): { all: Uint16Array; anchors: Uint16Array; names: string[] } | null {
    if (this.labels.clusters) {
      const c = this.cluster;
      return c && this.clusterNames.length === c.k ? { all: c.codes, anchors: c.codesAnchors, names: this.clusterNames } : null;
    }
    if (this.labels.column !== null && this.labelMeta && this.labelCodes && this.labelCodesAnchors) {
      return { all: this.labelCodes, anchors: this.labelCodesAnchors, names: this.labelMeta.categories };
    }
    return null;
  }

  /** Place the labels on the points currently shown and hand them to the renderer. */
  updateLabels(): void {
    clearTimeout(this.labelTimer);
    this.labelTimer = undefined;
    this.labelAt = performance.now();
    if (!this.renderer) {
      return;
    }
    const groups = this.labelGroups();
    if (!groups || !this.prepared || !this.anchorXY) {
      // Keep the current labels while codes are loading; clear them when labels are off.
      if (this.labels.column === null && !this.labels.clusters) {
        this.labelCount = 0;
        this.renderer.setLabels([]);
        this.renderer.setOutlines([]);
      }
      return;
    }
    const placed =
      this.projection === 'done' && this.allXY
        ? placeGroupLabels(this.allXY, groups.all, this.nKept, groups.names)
        : placeGroupLabels(this.anchorXY, groups.anchors, this.prepared.nAnchors, groups.names);
    const counts = placed.map((l) => l.count);
    const sizes = labelSizes(counts, this.labels.minSize, this.labels.maxSize);
    const priorities = collisionPriorities(counts);
    const background = this.plotBackground();
    const plain = contrastText(background);
    // Colored text when labels and points use the same column. The two code lists can order
    // and cut categories differently (20 colors, 200 labels), so match categories by name.
    const cm = this.colorMeta;
    const colorIndex =
      !this.labels.clusters && this.labels.colorText && this.labels.column === this.colorColumn && cm?.kind === 'categorical'
        ? new Map(cm.categories.map((c, i) => [c, i]))
        : null;
    const out: MapLabel[] = placed.map((l, i) => {
      const ci = colorIndex?.get(l.text);
      return {
        text: l.text === '' ? '(empty)' : l.text,
        position: [l.x, l.y],
        size: sizes[i],
        color: ci !== undefined ? labelTextColor(hexToRgb(this.categoryColor(ci)), plain) : plain,
        priority: priorities[i],
      };
    });
    this.labelCount = out.length;
    this.renderer.setLabels(out, { outline: [...hexToRgb(toHex(background)), 220], fontFamily: fontFamily() });
    // Outlines are static polygons of the settled layout: hide them while it moves.
    const showOutlines = this.labels.clusters && this.labels.outlines && this.cluster && this.phase !== 'embedding';
    this.renderer.setOutlines(showOutlines ? this.cluster!.outlines.flat() : [], [plain[0], plain[1], plain[2]]);
  }

  /** Point color of category i of the color column. */
  categoryColor(i: number): string {
    if (this.view.palette === 'map' && this.mapColors && i < this.mapColors.length) {
      return this.mapColors[i];
    }
    return CATEGORICAL[i % CATEGORICAL.length];
  }

  /**
   * Recompute the map-following palette from the current layout (when it settles, not on every
   * animation frame, so colors stay put while the layout converges), then recolor if asked.
   */
  updateMapColors(recolor = true): void {
    const meta = this.colorMeta;
    if (this.view.palette !== 'map' || meta?.kind !== 'categorical' || !this.colorValues || !this.prepared || !this.anchorXY || !this.anchorPos) {
      return;
    }
    let xy: Float32Array;
    let codes: Uint16Array;
    let n: number;
    if (this.projection === 'done' && this.allXY) {
      [xy, codes, n] = [this.allXY, this.colorValues as Uint16Array, this.nKept];
    } else {
      const all = this.colorValues as Uint16Array;
      [xy, codes, n] = [this.anchorXY, this.prepared.needsProjection ? gatherU16(all, this.anchorPos) : all, this.prepared.nAnchors];
    }
    const k = meta.categories.length;
    const centers = new Float64Array(k * 2).fill(NaN);
    for (const l of placeGroupLabels(xy, codes, n, meta.categories)) {
      centers[2 * l.group] = l.x;
      centers[2 * l.group + 1] = l.y;
    }
    const dark = contrastText(this.plotBackground())[0] > 128;
    this.mapColors = mapPalette(centers, xy, n, { dark }, (i) => CATEGORICAL[i % CATEGORICAL.length]);
    if (recolor) {
      this.recolor();
    }
  }

  // ---- rendering ---------------------------------------------------------------------
  setView(v: Partial<ViewOptions>): void {
    const cmapChanged = v.colormap !== undefined && v.colormap !== this.view.colormap;
    const paletteChanged = v.palette !== undefined && v.palette !== this.view.palette;
    const backgroundChanged = v.background !== undefined && v.background !== this.view.background;
    if (v.images !== undefined && v.images !== this.view.images) {
      this.tooltip = null;
    }
    this.view = { ...this.view, ...v };
    this.renderer?.setStyle(this.view);
    if (paletteChanged || backgroundChanged) {
      // The map palette's lightness depends on the background (dark or light).
      this.mapColors = null;
      if (this.phase === 'ready' || this.paused) {
        this.updateMapColors(false);
      }
    }
    if (cmapChanged || paletteChanged || backgroundChanged) {
      this.recolor(); // also redraws the labels (outline color)
    }
  }

  private showingAll(): boolean {
    return !!this.prepared?.needsProjection && (this.projection === 'running' || this.projection === 'done') && this.placedRows > 0;
  }

  render(): void {
    if (!this.renderer || !this.anchorXY || !this.colorsAnchors || !this.prepared) {
      return;
    }
    const nA = this.prepared.nAnchors;
    let sets: PointSet[];
    if (this.showingAll() && this.allXY && this.colorsAll && this.anchorPos) {
      // Rows [0, placed) are fully placed; draw the remaining anchors on top until done.
      const placed = this.placedRows;
      const first = lowerBound(this.anchorPos, placed);
      sets = [
        { id: 'all', positions: this.allXY.subarray(0, placed * 2), colors: this.colorsAll.subarray(0, placed * 4), length: placed },
        { id: 'anchors', positions: this.anchorXY.subarray(first * 2), colors: this.colorsAnchors.subarray(first * 4), length: nA - first },
      ];
    } else {
      sets = [{ id: 'anchors', positions: this.anchorXY, colors: this.colorsAnchors, length: nA }];
    }
    this.renderer.setPointSets(sets);
    this.scheduleLabels();
    if (this.autoFit) {
      this.renderer.fit(bounds(this.anchorXY, nA), false, this.legendWidth());
    }
  }

  fitView(): void {
    if (this.anchorXY && this.prepared) {
      this.autoFit = true;
      this.renderer?.fit(bounds(this.anchorXY, this.prepared.nAnchors), true, this.legendWidth());
    }
  }

  private legendWidth(): number {
    const el = document.querySelector('.legend') as HTMLElement | null;
    return el ? el.offsetWidth + 20 : 0;
  }

  // ---- hover -------------------------------------------------------------------------
  private onPointer(p: { x: number; y: number; world: [number, number] } | null): void {
    clearTimeout(this.hoverTimer);
    if (!p || (this.phase !== 'ready' && !this.paused) || !this.anchorXY || !this.prepared || !this.anchorPos) {
      this.tooltip = null;
      this.pendingHover = null;
      return;
    }
    if (!this.hit) {
      if (this.projection === 'done' && this.allXY) {
        this.hit = { index: new HitIndex(this.allXY, this.nKept), map: (i) => i };
      } else {
        const pos = this.anchorPos;
        this.hit = { index: new HitIndex(this.anchorXY, this.prepared.nAnchors), map: (i) => pos[i] };
      }
    }
    const radius = this.renderer!.worldPerPixel() * Math.max(6, this.view.pointSize);
    const idx = this.hit.index.nearest(p.world[0], p.world[1], radius);
    if (idx < 0) {
      this.tooltip = null;
      this.pendingHover = null;
      return;
    }
    const kept = this.hit.map(idx);
    if (this.tooltip && this.tooltip.row === kept) {
      this.tooltip = { ...this.tooltip, x: p.x, y: p.y };
      return;
    }
    const seq = ++this.hoverSeq;
    this.hoverTimer = setTimeout(() => {
      if (seq === this.hoverSeq) {
        this.pendingHover = { x: p.x, y: p.y };
        const image = this.view.images ? this.imageColumns?.indices : undefined;
        vscode.post({ type: 'row', i: kept, imageColumns: image });
      }
    }, 120);
  }

  // ---- selection ---------------------------------------------------------------------
  /**
   * Select the points inside a lasso drawn on the plot (CSS pixels relative to the plot).
   * Before all rows are placed, only the anchors on screen can be selected.
   */
  applyLasso(screen: [number, number][], mode: SelectMode): void {
    if (!this.renderer || !this.prepared || !this.anchorXY || !this.anchorPos || screen.length < 3) {
      return;
    }
    const poly = new Float64Array(screen.length * 2);
    screen.forEach(([x, y], i) => {
      const [wx, wy] = this.renderer!.unproject(x, y);
      poly[2 * i] = wx;
      poly[2 * i + 1] = wy;
    });
    const n = this.nKept;
    let hits: Uint32Array;
    const onAnchors = !!this.prepared.needsProjection && !(this.projection === 'done' && this.allXY);
    if (!onAnchors) {
      hits = pointsInPolygon(this.prepared.needsProjection ? this.allXY! : this.anchorXY, n, poly);
    } else {
      const local = pointsInPolygon(this.anchorXY, this.prepared.nAnchors, poly);
      hits = new Uint32Array(local.length);
      for (let i = 0; i < local.length; i++) hits[i] = this.anchorPos[local[i]];
    }
    const next = combineSelection(this.selection, hits, n, mode);
    this.selectionOnAnchors = next ? (mode === 'replace' || !this.selection ? onAnchors : this.selectionOnAnchors || onAnchors) : false;
    this.setSelection(next);
  }

  setSelection(mask: Uint8Array | null): void {
    this.selection = mask;
    this.selectedCount = mask ? countSelected(mask) : 0;
    if (!mask) {
      this.selectionOnAnchors = false;
    }
    this.comparison = null;
    this.comparing = false;
    this.recolor();
  }

  clearSelection(): void {
    if (this.selection) this.setSelection(null);
  }

  invertSelection(): void {
    if (!this.prepared || !this.anchorPos) return;
    const scope = this.selectionOnAnchors ? this.anchorPos : undefined;
    this.setSelection(invertSelection(this.selection, this.nKept, scope));
  }

  compareSelection(): void {
    if (!this.selection) return;
    this.comparing = true;
    this.comparison = null;
    vscode.post({ type: 'compareSelection', mask: bytesToBase64(packBits(this.selection)) });
  }

  selectionToFrame(): void {
    if (!this.selection) return;
    vscode.post({ type: 'selectionFrame', mask: bytesToBase64(packBits(this.selection)) });
  }

  // ---- writing labels to the DataFrame (tags, clusters) ------------------------------
  /** Tag the selected rows: write `tag` into a string column; other rows keep their value. */
  tagSelection(tag: string, column: string): void {
    const t = tag.trim();
    if (!this.selection || !t || !column.trim()) return;
    const codes = new Uint16Array(this.nKept).fill(65535);
    for (let i = 0; i < codes.length; i++) if (this.selection[i]) codes[i] = 0;
    vscode.post({
      type: 'writeLabels',
      codes: bytesToBase64(new Uint8Array(codes.buffer)),
      names: [t],
      column: column.trim(),
      keepOthers: true,
      description: `Tag ${formatCount(this.selectedCount)} rows as "${t}"`,
    });
  }

  /** Write the automatic cluster names into a column (rows in no cluster: missing). */
  clustersToFrame(column: string): void {
    const c = this.cluster;
    if (!c || !column.trim() || this.clusterNames.length !== c.k) return;
    vscode.post({
      type: 'writeLabels',
      codes: bytesToBase64(new Uint8Array(c.codes.buffer, c.codes.byteOffset, c.codes.byteLength)),
      names: this.clusterNames.slice(),
      column: column.trim(),
      keepOthers: false,
      description: `Write the names of ${formatCount(c.k)} clusters`,
    });
  }

  private onLabelsWritten(variable: string, column: string, rows: number, describe: DescribeResult): void {
    this.flash(`Wrote ${formatCount(rows)} labels to ${variable}.${column}`);
    const old = this.describe;
    // Columns are only ever added (at the end) or overwritten, so existing indices stay valid.
    if (old && describe.columns.length >= old.columns.length && old.columns.every((c, i) => describe.columns[i]?.name === c.name)) {
      this.describe = describe;
      const idx = describe.columns.findIndex((c) => c.name === column);
      if (idx === this.labels.column && !this.labels.clusters) this.requestLabelCodes();
      if (idx === this.colorColumn) this.requestColors();
      if (this.nameSource?.column === idx) {
        this.nameSource = null;
        this.nameClusters();
      }
    }
  }

  /** Python that draws this map with DataMapPlot (to the clipboard). */
  copyDataMapPlot(): void {
    const d = this.describe;
    if (!d) return;
    const label = !this.labels.clusters && this.labels.column !== null ? (d.columns[this.labels.column]?.name ?? null) : this.labels.clusters ? 'atlas_cluster' : null;
    vscode.post({ type: 'copyText', text: dataMapPlotSnippet(this.variable, d.frameKind, label) });
  }

  // ---- sidebar -----------------------------------------------------------------------
  setTab(tab: SidebarTab): void {
    this.ui.tab = tab;
  }

  setSectionOpen(id: string, open: boolean): void {
    const closed = this.ui.closed.includes(id);
    if (open && closed) {
      this.ui.closed = this.ui.closed.filter((x) => x !== id);
    } else if (!open && !closed) {
      this.ui.closed = [...this.ui.closed, id];
    }
  }

  // ---- actions -----------------------------------------------------------------------
  addCoordinates(): void {
    if (!this.prepared || !this.anchorXY) {
      return;
    }
    if (!this.prepared.needsProjection) {
      vscode.post({ type: 'addCoordinates', anchorXY: float32ToBase64(this.anchorXY), useProjection: false });
    } else if (this.projection === 'done') {
      vscode.post({ type: 'addCoordinates', anchorXY: null, useProjection: true });
    } else {
      this.flash('Place all rows first, then add the coordinates.');
    }
  }

  savePng(): void {
    if (!this.renderer) {
      return;
    }
    vscode.post({ type: 'savePng', dataUrl: this.renderer.toDataURL(this.plotBackground()) });
  }

  /** The effective plot background (the custom color, or the theme's editor background). */
  plotBackground(): string {
    return this.view.background || themeBackground();
  }

  copyPython(): void {
    const names = (this.describe?.columns ?? []).filter((c) => this.prepare.features.includes(c.index)).map((c) => c.name);
    vscode.post({ type: 'copyText', text: pythonSnippet(this.variable, names, $state.snapshot(this.prepare) as PrepareOptions, $state.snapshot(this.umap) as UmapParams) });
  }

  reload(): void {
    this.error = null;
    this.phase = 'loading';
    vscode.post({ type: 'reload' });
  }

  persist(): void {
    const prev = vscode.getState();
    const state: PanelState = {
      variable: this.variable || prev?.variable || '',
      sessionId: prev?.sessionId ?? '',
      languageId: prev?.languageId ?? 'python',
      prepare: $state.snapshot(this.prepare) as PrepareOptions,
      umap: $state.snapshot(this.umap) as UmapParams,
      colorColumn: this.colorColumn,
      view: $state.snapshot(this.view) as ViewOptions,
      ui: $state.snapshot(this.ui) as UiState,
      labels: $state.snapshot(this.labels) as LabelOptions,
    };
    vscode.setState(state);
    vscode.post({ type: 'state', state });
  }

  setSession(sessionId: string, languageId: string, variable: string): void {
    const prev = vscode.getState();
    vscode.setState({ ...(prev ?? ({} as PanelState)), sessionId, languageId, variable });
  }

  showError(message: string): void {
    this.error = { message };
  }

  flash(message: string): void {
    this.toast = message;
    setTimeout(() => {
      if (this.toast === message) {
        this.toast = null;
      }
    }, 4000);
  }
}

async function probeWebGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as any).gpu;
    if (!gpu) return false;
    const adapter = await Promise.race([gpu.requestAdapter(), new Promise((r) => setTimeout(() => r(null), 2000))]);
    return !!adapter;
  } catch {
    return false;
  }
}

/** The theme's editor background as a #rrggbb hex string (for <input type="color">). */
export function themeBackground(): string {
  const raw = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e';
  return toHex(raw);
}

/** Gather uint16 values at the given indices. */
function gatherU16(values: Uint16Array, idx: Uint32Array): Uint16Array {
  const out = new Uint16Array(idx.length);
  for (let i = 0; i < idx.length; i++) out[i] = values[idx[i]];
  return out;
}

/** Near-white text on dark backgrounds, near-black on light ones. */
export function contrastText(background: string): [number, number, number, number] {
  const [r, g, b] = hexToRgb(toHex(background));
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum < 0.5 ? [235, 235, 235, 255] : [25, 25, 25, 255];
}

/**
 * Text color for a label in its group's color: mixed 40% toward the plain text color (lighter on
 * dark backgrounds, darker on light ones), so it stands out from points of the same color.
 * DataMapPlot does the same with its "deep" label palette.
 */
export function labelTextColor(rgb: [number, number, number], plain: [number, number, number, number], t = 0.4): [number, number, number, number] {
  return [0, 1, 2].map((i) => Math.round(rgb[i] * (1 - t) + plain[i] * t)).concat(255) as [number, number, number, number];
}

/** The editor's font family (for map labels). */
function fontFamily(): string {
  return getComputedStyle(document.body).fontFamily || 'sans-serif';
}

/** Default label options. */
export const DEFAULT_LABELS: LabelOptions = {
  column: null,
  minSize: 12,
  maxSize: 26,
  colorText: true,
  clusters: false,
  detail: 2,
  nameBy: 'number',
  outlines: true,
};

/**
 * Name each group by the most common value of a column among its rows: the value alone when it
 * covers at least 80% of the group, otherwise with its share ("7 (62%)").
 */
export function dominantNames(groups: Uint16Array, k: number, values: Uint16Array, categories: string[]): string[] {
  const m = categories.length;
  const counts = new Uint32Array(k * (m + 2));
  const totals = new Uint32Array(k);
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g >= k) continue;
    totals[g]++;
    const v = values[i];
    if (v < m) counts[g * (m + 2) + v]++;
  }
  const out: string[] = [];
  for (let g = 0; g < k; g++) {
    let best = -1;
    let bestN = 0;
    for (let v = 0; v < m; v++) {
      const c = counts[g * (m + 2) + v];
      if (c > bestN) [best, bestN] = [v, c];
    }
    if (best < 0 || totals[g] === 0) {
      out.push(`Cluster ${g + 1}`);
      continue;
    }
    const share = bestN / totals[g];
    const name = categories[best] === '' ? '(empty)' : categories[best];
    out.push(share >= 0.8 ? name : `${name} (${Math.round(share * 100)}%)`);
  }
  return out;
}
