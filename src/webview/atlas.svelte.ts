import type {
  ColorMeta,
  DescribeResult,
  FileRef,
  JobStatus,
  PanelState,
  PrepareOptions,
  PrepareResult,
  Settings,
  ToWebview,
  UmapParams,
} from '../shared/protocol';
import { fetchTyped, float32ToBase64, vscode } from './vscode';
import UmapWorker from './workers/umap.worker.ts?worker&inline';
import type { WorkerIn, WorkerOut } from './workers/umap.worker';
import { ScatterRenderer, type PointSet } from './render/renderer';
import { HitIndex, bounds } from './render/hitIndex';
import { encodeCategorical, encodeConstant, encodeNumeric, gatherRgba } from './color/encode';
import { DEFAULT_POINT_COLOR } from './color/colormaps';
import { pythonSnippet, isRebuild, liveChanges, lowerBound } from './logic';
import { DEFAULT_UMAP } from './defaults';

export { DEFAULT_UMAP };

export interface ViewOptions {
  pointSize: number;
  opacity: number;
  mode: 'points' | 'density';
  colormap: string;
}

type Phase = 'loading' | 'preparing' | 'embedding' | 'ready' | 'error';

/** Auto-place all rows after UMAP when the estimate is below this many seconds. */
const AUTO_PROJECT_SECONDS = 20;

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
  view = $state<ViewOptions>({ pointSize: 3, opacity: 0.8, mode: 'points', colormap: 'viridis' });
  colorColumn = $state<number | null>(null);
  forceCategorical = $state(false);
  colorMeta = $state.raw<ColorMeta | null>(null);
  colorRange = $state<[number, number] | null>(null);
  prepared = $state.raw<PrepareResult | null>(null);
  kernelStatus = $state.raw<{ task: string; stage: string; progress: number; message: string } | null>(null);
  umapProgress = $state.raw<{ stage: string; progress: number; epoch: number; total: number } | null>(null);
  projection = $state<'none' | 'stale' | 'running' | 'done'>('none');
  projectProgress = $state(0);
  estimate = $state.raw<{ seconds: number; rows: number } | null>(null);
  error = $state.raw<{ message: string; detail?: string; fatal?: boolean } | null>(null);
  tooltip = $state.raw<{ x: number; y: number; row: number; values: [string, string][] } | null>(null);
  timings = $state.raw<Record<string, number>>({});
  toast = $state<string | null>(null);
  useGpu = $state(false);
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
      case 'row':
        if (this.pendingHover) {
          this.tooltip = { ...this.pendingHover, row: msg.row, values: msg.values };
        }
        break;
      case 'error':
        this.error = { message: msg.message, detail: msg.detail, fatal: msg.fatal };
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
      maxAnchors: this.useGpuFor(settings) ? settings.maxAnchors : Math.min(settings.maxAnchors, settings.maxAnchorsCpu),
      anchorBudget: settings.anchorBudget,
    };
    this.useGpu = this.useGpuFor(settings);
    if (state?.umap) {
      this.umap = { ...DEFAULT_UMAP, ...state.umap };
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
    this.recolor();
    if (this.colorColumn !== null) {
      this.requestColors();
    }
    this.startUmap();
  }

  // ---- UMAP --------------------------------------------------------------------------
  startUmap(): void {
    if (!this.anchors || !this.prepared) {
      return;
    }
    this.runId++;
    this.liveRun = false;
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
    this.projection = this.prepared?.needsProjection ? 'stale' : 'none';
    this.estimate = null;
    this.hit = null;
    this.tooltip = null;
    const epochs = Math.max(60, Math.round(next.nEpochs / 2));
    this.umapProgress = { stage: 'optimizing', progress: 1, epoch: 0, total: epochs };
    this.worker.postMessage({ type: 'live', runId: this.runId, params: live, epochs } satisfies WorkerIn);
  }

  stopUmap(): void {
    this.worker?.postMessage({ type: 'stop', runId: this.runId } satisfies WorkerIn);
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
        this.umapProgress = { stage: 'optimizing', progress: 1, epoch: m.epoch, total: m.total };
        this.render();
        break;
      case 'done':
        this.anchorXY = m.embedding;
        if (m.seconds) {
          this.timings = this.liveRun ? { ...this.timings, update: m.seconds } : { ...this.timings, umap: m.seconds, update: 0 };
        }
        this.phase = 'ready';
        this.umapProgress = null;
        this.render();
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
    this.render();
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
      this.colorsAll = encodeCategorical(this.colorValues as Uint16Array, meta.categories.length, this.colorsAll ?? undefined);
    }
    this.colorsAnchors = this.prepared.needsProjection ? gatherRgba(this.colorsAll, this.anchorPos) : this.colorsAll;
    this.render();
  }

  // ---- rendering ---------------------------------------------------------------------
  setView(v: Partial<ViewOptions>): void {
    const cmapChanged = v.colormap !== undefined && v.colormap !== this.view.colormap;
    this.view = { ...this.view, ...v };
    this.renderer?.setStyle(this.view);
    if (cmapChanged) {
      this.recolor();
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
    if (!p || this.phase !== 'ready' || !this.anchorXY || !this.prepared || !this.anchorPos) {
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
        vscode.post({ type: 'row', i: kept });
      }
    }, 120);
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
    const bg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e';
    vscode.post({ type: 'savePng', dataUrl: this.renderer.toDataURL(bg) });
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
