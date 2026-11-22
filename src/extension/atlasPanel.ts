import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { KernelBridge, KernelError } from './kernelBridge';
import type { PositronApi } from './positron';
import { bytesFromPayload } from './binaryUtil';
import type {
  ColorMeta,
  DescribeResult,
  FileRef,
  JobStatus,
  KernelOutput,
  SelectionComparison,
  PanelState,
  PrepareResult,
  Settings,
  ToHost,
  ToWebview,
} from '../shared/protocol';
import { estimateSeconds } from '../shared/estimate';
import { FontManager } from './fonts';
import { ImageResolver, validateLinkScheme } from './images';

export const VIEW_TYPE = 'positronAtlas.view';

export interface AtlasContext {
  extension: vscode.ExtensionContext;
  positron: PositronApi;
  log: vscode.LogOutputChannel;
  jobsRoot: vscode.Uri;
}

export interface OpenTarget {
  variable: string;
  sessionId: string;
  languageId: string;
}

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('positronAtlas');
  return {
    maxAnchors: c.get('maxAnchors', 100_000),
    maxAnchorsCpu: c.get('maxAnchorsCpu', 25_000),
    useWebGpu: c.get('useWebGpu', true),
    anchorBudget: c.get('anchorBudget', 10_000_000),
    defaultSamplePct: c.get('defaultSamplePct', 100),
    pcaEnabled: c.get('pcaEnabled', false),
    pcaDims: c.get('pcaDims', 50),
    nativeCore: c.get('nativeCore', true),
    maxLazyRows: c.get('maxLazyRows', 10_000_000),
    neighborCacheMB: c.get('neighborCacheMB', 1024),
  };
}

/** One editor tab showing one DataFrame. */
export class AtlasPanel {
  private static readonly panels = new Set<AtlasPanel>();

  private readonly bridge: KernelBridge;
  private readonly jobDir: vscode.Uri;
  private readonly fontManager: FontManager;
  private jobId: string | undefined;
  private fileVersion = 0;
  private disposed = false;
  private busy: vscode.CancellationTokenSource | undefined;
  private state: PanelState;
  private projectionCurrent = false;
  private imageResolver: ImageResolver | undefined;
  private imagePermission: 'always' | 'never' | 'ask' = 'ask';
  /** URI for the in-progress HTML export; set by handleExportHtml, consumed by handleExportHtmlReady. */
  private pendingExportUri: vscode.Uri | undefined;

  static create(ctx: AtlasContext, target: OpenTarget): AtlasPanel {
    const fontManager = new FontManager(ctx.extension, ctx.log);
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, `Atlas: ${target.variable}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(ctx.extension.extensionUri, 'dist'),
        vscode.Uri.joinPath(ctx.extension.extensionUri, 'media', 'fonts'),
        ctx.jobsRoot,
        fontManager.localResourceRoot,
      ],
    });
    return new AtlasPanel(ctx, panel, { ...target }, fontManager);
  }

  static revive(ctx: AtlasContext, panel: vscode.WebviewPanel, state: PanelState): AtlasPanel {
    const fontManager = new FontManager(ctx.extension, ctx.log);
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(ctx.extension.extensionUri, 'dist'),
        vscode.Uri.joinPath(ctx.extension.extensionUri, 'media', 'fonts'),
        ctx.jobsRoot,
        fontManager.localResourceRoot,
      ],
    };
    return new AtlasPanel(ctx, panel, state, fontManager);
  }

  private constructor(
    private readonly ctx: AtlasContext,
    private readonly panel: vscode.WebviewPanel,
    state: PanelState,
    fontManager: FontManager,
  ) {
    this.state = state;
    this.fontManager = fontManager;
    if (state.loadImagesFromUrls) {
      this.imagePermission = state.loadImagesFromUrls as 'always' | 'never' | 'ask';
    }
    const modulePath = vscode.Uri.joinPath(ctx.extension.extensionUri, 'python', 'positron_atlas_kernel.py').fsPath;
    const version = String(ctx.extension.extension.packageJSON.version ?? '0.0.0');
    this.bridge = new KernelBridge(ctx.positron, state.sessionId, state.languageId, modulePath, version, ctx.log);
    this.jobDir = vscode.Uri.joinPath(ctx.jobsRoot, crypto.randomUUID());
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage((m: ToHost) => this.onMessage(m).catch((e) => this.fail(e)));
    panel.onDidDispose(() => this.dispose());
    AtlasPanel.panels.add(this);
  }

  static disposeAll(): void {
    for (const p of [...AtlasPanel.panels]) {
      p.panel.dispose();
    }
  }

  private post(msg: ToWebview): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(msg);
    }
  }

  private fileRef(out: { file: string; dtype: FileRef['dtype']; shape: number[]; offset?: number }): FileRef {
    const uri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.jobDir, out.file));
    return { uri: `${uri.toString()}?v=${++this.fileVersion}`, dtype: out.dtype, shape: out.shape, offset: out.offset };
  }

  private fail(e: unknown, fatal = false): void {
    let message = e instanceof Error ? e.message : String(e);
    if (/Unknown job/.test(message)) {
      // The kernel restarted and lost its state.
      message = 'The Python session restarted. Reload to load the data again.';
      fatal = true;
      this.jobId = undefined;
    }
    const detail = e instanceof KernelError ? e.detail : e instanceof Error ? e.stack : undefined;
    this.ctx.log.error(`[${this.state.variable}] ${message}${detail ? `\n${detail}` : ''}`);
    this.post({ type: 'error', message, detail, fatal });
  }

  /** Wait (up to a minute) for the session, or any Python session, to be available. */
  private async ensureSession(): Promise<void> {
    const rt = this.ctx.positron.runtime;
    for (let i = 0; i < 120; i++) {
      const own = await rt.getSession(this.state.sessionId).then((x) => x, () => undefined);
      if (own) {
        return;
      }
      const sessions = await rt.getActiveSessions();
      const fg = await rt.getForegroundSession();
      const candidates = [fg, ...sessions].filter((x): x is NonNullable<typeof x> => !!x && x.runtimeMetadata.languageId === 'python');
      const py = candidates[0];
      if (py) {
        this.ctx.log.info(`[${this.state.variable}] session ${this.state.sessionId} is gone; using ${py.metadata.sessionId}`);
        this.state = { ...this.state, sessionId: py.metadata.sessionId };
        this.bridge.retarget(py.metadata.sessionId);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('No Python session is running. Start one, then click Reload.');
  }

  private async init(): Promise<void> {
    await fs.mkdir(this.jobDir.fsPath, { recursive: true });
    try {
      await this.ensureSession();
    } catch (e) {
      this.fail(e, true);
      return;
    }
    let describe: DescribeResult | undefined;
    for (let attempt = 0; !describe; attempt++) {
      try {
        describe = await this.bridge.call<DescribeResult>('describe', this.state.variable, JSON.stringify({ maxLazyRows: readSettings().maxLazyRows ?? 10_000_000 }));
      } catch (e) {
        // Right after startup a session can exit and restart (possibly under the same id):
        // wait, find the live Python session, and retry.
        if (attempt >= 10 || !/session has exited|No session available/i.test(String(e))) {
          this.fail(e, true);
          return;
        }
        this.ctx.log.info(`[${this.state.variable}] ${String(e)}; retrying`);
        await new Promise((r) => setTimeout(r, 1000));
        try {
          await this.ensureSession();
        } catch (e2) {
          this.fail(e2, true);
          return;
        }
      }
    }
    const job = await this.bridge.call<{ jobId: string }>('create_job', this.state.variable, this.jobDir.fsPath, JSON.stringify({ maxLazyRows: readSettings().maxLazyRows ?? 10_000_000 }));
    const probe = await fs.readFile(path.join(this.jobDir.fsPath, '.probe'), 'utf8').catch(() => '');
    if (probe !== job.jobId) {
      this.fail(
        new Error(
          'The Python kernel writes files that this window cannot read (is the kernel running on another machine?). ' +
            'Atlas needs the kernel and the extension host on the same file system.',
        ),
        true,
      );
      return;
    }
    this.jobId = job.jobId;
    const nat = describe.native;
    this.ctx.log.info(
      `[${this.state.variable}] row placement: ${nat?.available ? `Rust core ${nat.version} (${nat.target})` : `numpy${nat?.reason ? ` (${nat.reason})` : ''}`}`,
    );
    this.post({
      type: 'init',
      variable: this.state.variable,
      sessionId: this.state.sessionId,
      describe,
      settings: readSettings(),
      state: this.state,
    });
  }

  private newToken(): vscode.CancellationToken {
    this.busy?.cancel();
    this.busy = new vscode.CancellationTokenSource();
    return this.busy.token;
  }

  private requireJob(): string {
    if (!this.jobId) {
      throw new Error('The data is not loaded yet.');
    }
    return this.jobId;
  }

  private async onMessage(m: ToHost): Promise<void> {
    switch (m.type) {
      case 'ready':
        await this.init();
        break;
      case 'reload':
        if (this.jobId) {
          await this.bridge.call('cleanup', this.jobId).catch(() => undefined);
          this.jobId = undefined;
        }
        await this.init();
        break;
      case 'prepare': {
        const job = this.requireJob();
        const token = this.newToken();
        this.projectionCurrent = false;
        const settings = readSettings();
        await this.bridge.call('prepare', job, JSON.stringify({
          ...m.options,
          native: settings.nativeCore,
          neighborCacheMB: settings.neighborCacheMB,
        }));
        const s = await this.bridge.waitForJob(
          job,
          (st) => {
            this.post({ type: 'status', task: 'prepare', status: st });
          },
          token,
        );
        if (s.stage === 'done') {
          const anchors = s.outputs.find((o) => o.kind === 'anchors')!;
          const anchorPos = s.outputs.find((o) => o.kind === 'anchorPos')!;
          const result = s.result as PrepareResult;
          this.post({ type: 'prepared', result, anchors: this.fileRef(anchors), anchorPos: this.fileRef(anchorPos) });
          // coords mode: stream xy outputs after 'prepared' so the webview has
          // allocated allXY first, then signal projection done.
          if (result.coordsMode) {
            for (const o of s.outputs) {
              if (o.kind === 'xy') {
                this.post({ type: 'xyChunk', file: this.fileRef(o as KernelOutput), total: result.nKept });
              }
            }
            this.projectionCurrent = true;
            this.post({ type: 'projected', seconds: 0, exact: true });
          }
        } else if (s.stage === 'error') {
          throw new KernelError(s.error ?? 'Preparing the data failed', s.result?.traceback);
        }
        break;
      }
      case 'estimate': {
        const native = readSettings().nativeCore;
        const r = await this.bridge.call<{ flops: number; rows: number; backend: 'rust' | 'numpy' }>('estimate_projection', this.requireJob(), native);
        this.post({ type: 'estimate', seconds: estimateSeconds(r), rows: r.rows });
        break;
      }
      case 'project': {
        const job = this.requireJob();
        const xyPath = path.join(this.jobDir.fsPath, `anchor_xy_${Date.now()}.f32`);
        await fs.writeFile(xyPath, bytesFromPayload(m.anchorXY));
        try {
          const settings = readSettings();
          // T2: pass dims to the kernel so it places into 2D or 3D output space.
          await this.runXYTask('project', () => this.bridge.call('project', job, xyPath, JSON.stringify({ metric: m.metric, seed: m.seed, native: settings.nativeCore, dims: m.dims ?? 2 })), false);
        } finally {
          await fs.rm(xyPath, { force: true });
        }
        break;
      }
      case 'exact': {
        const job = this.requireJob();
        // T2: pass dims so the kernel uses n_components=3 for 3D UMAP.
        await this.runXYTask('exact', () => this.bridge.call('exact_umap', job, JSON.stringify({ ...m.params, engine: m.engine, dims: m.dims ?? 2 })), true);
        break;
      }
      case 'colors': {
        const r = await this.bridge.call<{ file: string; dtype: 'f32' | 'u16'; meta: ColorMeta; length: number }>(
          'colors',
          this.requireJob(),
          m.column,
          !!m.forceCategorical,
        );
        this.post({
          type: 'colors',
          column: m.column,
          file: this.fileRef({ file: r.file, dtype: r.dtype, shape: [r.length] }),
          meta: r.meta,
          length: r.length,
        });
        break;
      }
      case 'labelCodes': {
        // Category codes of a column for labels: always categorical, more categories than colors.
        const r = await this.bridge.call<{ file: string; dtype: 'f32' | 'u16'; meta: ColorMeta; length: number }>(
          'colors',
          this.requireJob(),
          m.column,
          true,
          m.maxCategories,
        );
        this.post({
          type: 'labelCodes',
          column: m.column,
          file: this.fileRef({ file: r.file, dtype: r.dtype, shape: [r.length] }),
          meta: r.meta,
          length: r.length,
          purpose: m.purpose,
        });
        break;
      }
      // ---- A10: Size by column ------------------------------------------------
      case 'sizes': {
        const r = await this.bridge.call<{ file: string; dtype: 'f32'; meta: import('../shared/protocol').SizeMeta; length: number }>(
          'sizes',
          this.requireJob(),
          m.column,
        );
        this.post({
          type: 'sizes',
          column: m.column,
          file: this.fileRef({ file: r.file, dtype: r.dtype, shape: [r.length] }),
          meta: r.meta,
        });
        break;
      }
      // ---- A13: Histogram filter ----------------------------------------------
      case 'histValues': {
        const r = await this.bridge.call<{ file: string; dtype: 'f32'; length: number }>(
          'hist_values',
          this.requireJob(),
          m.column,
        );
        this.post({
          type: 'histValues',
          column: m.column,
          file: this.fileRef({ file: r.file, dtype: r.dtype, shape: [r.length] }),
        });
        break;
      }
      case 'histogram': {
        const r = await this.bridge.call<{ data: import('../shared/protocol').HistogramData }>(
          'histogram',
          this.requireJob(),
          m.column,
          m.nBins ?? 50,
        );
        this.post({ type: 'histogram', column: m.column, data: r.data });
        break;
      }
      // ---- P3: kernel-anchors compute mode ------------------------------------
      case 'anchorUmap': {
        const job = this.requireJob();
        const token = this.newToken();
        // T2: pass dims so the kernel uses n_components=3 for 3D anchor UMAP.
        const r = await this.bridge.call<{ file: string; dtype: 'f32'; length: number; shape: number[]; seconds: number }>(
          'anchor_umap',
          job,
          JSON.stringify({ ...m.params, dims: m.dims ?? 2 }),
        );
        if (!token.isCancellationRequested) {
          this.post({
            type: 'anchorXY',
            file: this.fileRef({ file: r.file, dtype: r.dtype, shape: r.shape }),
            seconds: r.seconds,
          });
        }
        break;
      }
      case 'writeLabels': {
        const pick = await vscode.window.showWarningMessage(
          `${m.description} in column ${m.column} of ${this.state.variable}? This modifies the DataFrame in your session.`,
          { modal: true },
          'Write Column',
        );
        if (pick !== 'Write Column') {
          return;
        }
        const codesPath = path.join(this.jobDir.fsPath, `labels_${Date.now()}.u16`);
        await fs.writeFile(codesPath, bytesFromPayload(m.codes));
        try {
          const r = await this.bridge.call<{ variable: string; column: string; rows: number }>(
            'write_labels',
            this.requireJob(),
            codesPath,
            m.names,
            m.column,
            m.keepOthers,
          );
          const describe = await this.bridge.call<DescribeResult>('describe', r.variable, JSON.stringify({ maxLazyRows: readSettings().maxLazyRows ?? 10_000_000 }));
          this.post({ type: 'labelsWritten', variable: r.variable, column: r.column, rows: r.rows, describe });
          void vscode.window.showInformationMessage(`Wrote ${r.rows.toLocaleString('en-US')} labels to ${r.variable}.${r.column}.`);
        } finally {
          await fs.rm(codesPath, { force: true });
        }
        break;
      }
      case 'describeGroups': {
        // Names for automatic clusters from their most distinguishing columns.
        const codesPath = path.join(this.jobDir.fsPath, `groups_${Date.now()}.u16`);
        await fs.writeFile(codesPath, bytesFromPayload(m.codes));
        try {
          const r = await this.bridge.call<{ names: string[] }>('describe_groups', this.requireJob(), codesPath, m.k, m.columns);
          this.post({ type: 'groupNames', seq: m.seq, names: r.names });
        } finally {
          await fs.rm(codesPath, { force: true });
        }
        break;
      }
      case 'compareSelection': {
        const result = await this.withMask(m.mask, (p) => this.bridge.call<SelectionComparison & { ok: true }>('compare_selection', this.requireJob(), p));
        this.post({ type: 'comparison', seq: m.seq, result });
        break;
      }
      case 'selectionFrame': {
        const r = await this.withMask(m.mask, (p) => this.bridge.call<{ variable: string; rows: number }>('selection_frame', this.requireJob(), p));
        this.post({ type: 'selectionFrame', variable: r.variable, rows: r.rows });
        void vscode.window.showInformationMessage(`Created ${r.variable} with ${r.rows.toLocaleString('en-US')} selected rows.`);
        // Open the new frame in the Data Explorer (S1-Q4: %view is the stable path for in-session variables).
        // The frame exists either way, so a failure here is only logged.
        try {
          await this.ctx.positron.runtime.executeCode('python', `%view ${r.variable}`, false, false, undefined, undefined, undefined, this.state.sessionId);
        } catch (e) {
          this.ctx.log.warn(`could not open ${r.variable} in the Data Explorer: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }
      case 'row': {
        const r = await this.bridge.call<{ row: number; values: [string, string][]; image?: (number | null)[] }>(
          'row',
          this.requireJob(),
          m.i,
          m.imageColumns ?? null,
        );
        this.post({ type: 'row', i: m.i, row: r.row, values: r.values, image: r.image });
        break;
      }
      case 'rows': {
        const r = await this.bridge.call<{ ok: boolean; values: Record<string, [string, string][]> }>(
          'rows',
          this.requireJob(),
          m.indices,
          m.columns ?? null,
        );
        const values: Record<number, [string, string][]> = {};
        for (const [k, v] of Object.entries(r.values)) values[Number(k)] = v;
        this.post({ type: 'rows', seq: m.seq, values });
        break;
      }
      case 'texts': {
        const r = await this.bridge.call<{ ok: boolean; utf8File?: string; offsetsFile?: string; count?: number }>(
          'texts',
          this.requireJob(),
          m.column,
          m.maxChars,
        );
        if (r.ok && r.utf8File && r.offsetsFile) {
          const toUri = (f: string) => `${this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.jobDir, f)).toString()}?v=${++this.fileVersion}`;
          this.post({ type: 'texts', column: m.column, uri: toUri(r.utf8File), offsetsUri: toUri(r.offsetsFile), count: r.count ?? 0 });
        }
        break;
      }
      case 'openLink': {
        if (!validateLinkScheme(m.url)) {
          this.ctx.log.warn(`[openLink] rejected unsafe URL: ${m.url}`);
          return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(m.url));
        break;
      }
      case 'image': {
        if (!this.imageResolver) {
          this.imageResolver = new ImageResolver(this.panel.webview, this.jobDir, this.ctx.log);
        }
        if (this.imagePermission === 'ask' && /^https?:/i.test(m.src)) {
          const pick = await vscode.window.showInformationMessage(
            `Positron Atlas: load images from external URLs?`,
            { modal: true },
            'Always',
            'Never',
          );
          if (pick === 'Always') {
            this.imagePermission = 'always';
          } else {
            this.imagePermission = 'never';
          }
          this.post({ type: 'imagePermission', granted: this.imagePermission === 'always' });
        }
        const uri = await this.imageResolver.resolve(m.src, this.imagePermission, this.panel);
        if (uri) {
          this.post({ type: 'imageUri', row: m.row, uri });
        }
        break;
      }
      case 'cancel':
        this.busy?.cancel();
        if (this.jobId) {
          await this.bridge.call('cancel', this.jobId).catch(() => undefined);
        }
        break;
      case 'addCoordinates': {
        const job = this.requireJob();
        // T6: in 3D mode also mention umap_z in the confirmation dialog.
        const colList = m.dims === 3 ? 'umap_x, umap_y, and umap_z' : 'umap_x and umap_y';
        const pick = await vscode.window.showWarningMessage(
          `Add columns ${colList} to ${this.state.variable}? This modifies the DataFrame in your session.`,
          { modal: true },
          'Add Columns',
        );
        if (pick !== 'Add Columns') {
          return;
        }
        let xyPath = '';
        if (m.anchorXY && !m.useProjection) {
          xyPath = path.join(this.jobDir.fsPath, `coords_${Date.now()}.f32`);
          await fs.writeFile(xyPath, bytesFromPayload(m.anchorXY));
        } else if (!this.projectionCurrent) {
          throw new Error('Place all rows first, then add the coordinates.');
        }
        const r = await this.bridge.call<{ variable: string; columns: string[] }>('add_coordinates', job, xyPath);
        if (xyPath) {
          await fs.rm(xyPath, { force: true });
        }
        this.post({ type: 'coordsAdded', variable: r.variable, columns: r.columns });
        void vscode.window.showInformationMessage(`Added ${r.columns.join(', ')} to ${r.variable}.`);
        break;
      }
      // --- Search (A7) ---
      case 'search': {
        const r = await this.bridge.call<{ ok: boolean; file?: string; count: number }>(
          'search',
          this.requireJob(),
          m.column,
          m.query,
          m.limit ?? 100_000,
          JSON.stringify({ regex: m.regex ?? false }),
        );
        if (r.ok && r.file && r.count > 0) {
          this.post({
            type: 'searchResults',
            column: m.column,
            query: m.query,
            file: this.fileRef({ file: r.file, dtype: 'u32', shape: [r.count] }),
            count: r.count,
          });
        } else {
          this.post({ type: 'searchEmpty', column: m.column, query: m.query });
        }
        break;
      }
      // --- Export with DataMapPlot (D3/D12) ---
      case 'exportDataMapPlot': {
        const job = this.requireJob();
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const uri = await vscode.window.showSaveDialog({
          filters: { 'HTML file': ['html'] },
          defaultUri: vscode.Uri.file(path.join(workspaceRoot, `${this.state.variable}-datamapplot.html`)),
        });
        if (!uri) {
          break;
        }
        let xyPath: string | null = null;
        if (m.anchorXY && m.anchorXY.length > 0) {
          xyPath = path.join(this.jobDir.fsPath, `dmp_xy_${Date.now()}.f32`);
          await fs.writeFile(xyPath, bytesFromPayload(m.anchorXY));
        }
        try {
          const opts = JSON.stringify({
            labelColumn: m.labelColumn,
            titleColumn: m.titleColumn,
            title: m.title,
            labelColorMap: m.labelColorMap,
          });
          const r = await this.bridge.call<{ ok: boolean; path: string }>(
            'export_datamapplot',
            job,
            uri.fsPath,
            opts,
            xyPath,
          );
          if (r.ok) {
            this.post({ type: 'datamapplotSaved', path: r.path });
            const open = await vscode.window.showInformationMessage(
              `DataMapPlot HTML saved to ${path.basename(r.path)}`,
              'Open',
            );
            if (open === 'Open') {
              await vscode.env.openExternal(uri);
            }
          }
        } finally {
          if (xyPath) {
            await fs.rm(xyPath, { force: true });
          }
        }
        break;
      }
      case 'savePng': {
        const uri = await vscode.window.showSaveDialog({
          filters: { 'PNG image': ['png'] },
          defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', `${this.state.variable}-umap.png`)),
        });
        if (uri) {
          await vscode.workspace.fs.writeFile(uri, m.bytes);
        }
        break;
      }
      case 'copyText':
        await vscode.env.clipboard.writeText(m.text);
        void vscode.window.showInformationMessage('Copied to clipboard.');
        break;
      case 'state':
        this.state = { ...m.state, variable: this.state.variable, sessionId: this.state.sessionId, languageId: this.state.languageId };
        break;
      case 'log':
        this.ctx.log[m.level](`[webview ${this.state.variable}] ${m.message}`);
        break;
      // --- Font plumbing (D11) ---
      case 'fontRequest': {
        const { seq, family, scripts = ['latin'] } = m;
        try {
          const css = await this.fontManager.resolveFontCss(this.panel.webview, family, scripts);
          this.post({ type: 'fontReady', seq, family, css });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          this.ctx.log.warn(`[fonts] ${family}: ${message}`);
          this.post({ type: 'fontError', seq, family, message });
        }
        break;
      }
      case 'fontCatalog': {
        try {
          const families = await this.fontManager.listFonts();
          this.post({ type: 'fontCatalog', families });
        } catch (e) {
          this.ctx.log.warn(`[fonts] listFonts: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }
      // --- HTML export (X2) ---
      case 'exportHtml': {
        await this.handleExportHtml(m);
        break;
      }
      case 'exportHtmlReady': {
        await this.handleExportHtmlReady(m);
        break;
      }
      // --- Full-screen toggle (N5 / F1) ---
      case 'fullscreen': {
        // In Positron, maximize the editor panel (hides the sidebar and status bar).
        // The same command toggles back when called again.
        const command = m.on
          ? 'workbench.action.maximizeEditorHideSidebar'
          : 'workbench.action.evenEditorWidths';
        await vscode.commands.executeCommand(command).then(undefined, () => undefined);
        break;
      }
    }
  }

  /** Write a selection mask (Uint8Array packed bits, or base64 string as fallback) into the job directory for one kernel call. */
  private async withMask<T>(mask: Uint8Array | string, fn: (path: string) => Promise<T>): Promise<T> {
    const maskPath = path.join(this.jobDir.fsPath, `selection_${Date.now()}.bits`);
    await fs.writeFile(maskPath, bytesFromPayload(mask));
    try {
      return await fn(maskPath);
    } finally {
      await fs.rm(maskPath, { force: true });
    }
  }

  /** Run a kernel task that writes xy chunk files, streaming them to the webview. */
  private async runXYTask(task: string, start: () => Promise<unknown>, exact: boolean): Promise<void> {
    const job = this.requireJob();
    const token = this.newToken();
    this.projectionCurrent = false;
    await start();
    const seen = new Set<string>();
    const s = await this.bridge.waitForJob(
      job,
      (st) => {
        this.post({ type: 'status', task, status: st });
        for (const o of st.outputs) {
          if (o.kind === 'xy' && !seen.has(o.file)) {
            seen.add(o.file);
            this.post({ type: 'xyChunk', file: this.fileRef(o as KernelOutput), total: st.result?.nRows ?? 0 });
          }
        }
      },
      token,
    );
    if (s.stage === 'done') {
      this.projectionCurrent = true;
      this.post({ type: 'projected', seconds: s.result?.seconds ?? 0, exact, backend: s.result?.backend });
    } else if (s.stage === 'error') {
      throw new KernelError(s.error ?? `${task} failed`, s.result?.traceback);
    }
  }

  /**
   * Handle `exportHtml` (X2, step 1/2 on host side):
   *   1. Show save dialog → store pending URI.
   *   2. Fetch tooltip text from kernel.
   *   3. Post `exportHtmlAssembly` back to the webview (which packs, gzips, builds HTML).
   */
  private async handleExportHtml(m: Extract<import('../shared/protocol').ToHost, { type: 'exportHtml' }>): Promise<void> {
    const job = this.requireJob();

    // 1. Show save dialog
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const uri = await vscode.window.showSaveDialog({
      filters: { 'HTML file': ['html'] },
      defaultUri: vscode.Uri.file(path.join(workspaceRoot, `${this.state.variable}-atlas.html`)),
    });
    if (!uri) {
      return;
    }
    this.pendingExportUri = uri;

    // 2. Fetch tooltip text from kernel for each requested column
    type TextSection = { column: number; utf8: Buffer; offsets: Buffer };
    const textSections: TextSection[] = [];
    for (const col of m.tooltipColumns) {
      try {
        const r = await this.bridge.call<{ ok: boolean; utf8File?: string; offsetsFile?: string; count?: number }>(
          'texts',
          job,
          col.index,
          m.maxChars,
        );
        if (r.ok && r.utf8File && r.offsetsFile) {
          const [utf8, offsets] = await Promise.all([
            fs.readFile(path.join(this.jobDir.fsPath, r.utf8File)),
            fs.readFile(path.join(this.jobDir.fsPath, r.offsetsFile)),
          ]);
          textSections.push({ column: col.index, utf8, offsets });
        }
      } catch (e) {
        this.ctx.log.warn(`[exportHtml] texts for column ${col.index}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 3. Build combined text arrays
    const nPoints = m.nPoints;
    let textUtf8: Uint8Array | null = null;
    let textOffsets: Uint32Array | null = null;
    if (textSections.length > 0 && m.tooltipColumns.length > 0) {
      const nCols = m.tooltipColumns.length;
      const offsetsPerCol = nPoints + 1;
      textOffsets = new Uint32Array(nCols * offsetsPerCol);
      const utf8Parts: Buffer[] = [];
      let globalOffset = 0;
      for (let ci = 0; ci < nCols; ci++) {
        const colIdx = m.tooltipColumns[ci].index;
        const sec = textSections.find((s) => s.column === colIdx);
        const colOffsets = new Uint32Array(offsetsPerCol);
        if (sec) {
          const srcOffsets = new Uint32Array(sec.offsets.buffer, sec.offsets.byteOffset, sec.offsets.byteLength / 4);
          const colBase = Math.min(srcOffsets.length - 1, nPoints);
          for (let i = 0; i <= colBase; i++) {
            colOffsets[i] = globalOffset + (i < srcOffsets.length ? srcOffsets[i] : srcOffsets[srcOffsets.length - 1]);
          }
          const lastSrc = srcOffsets.length > 0 ? srcOffsets[Math.min(nPoints, srcOffsets.length - 1)] : 0;
          for (let i = colBase + 1; i <= nPoints; i++) {
            colOffsets[i] = globalOffset + lastSrc;
          }
          globalOffset += sec.utf8.length;
          utf8Parts.push(sec.utf8);
        } else {
          colOffsets.fill(globalOffset);
        }
        textOffsets.set(colOffsets, ci * offsetsPerCol);
      }
      const totalLen = utf8Parts.reduce((s, b) => s + b.length, 0);
      const combined = new Uint8Array(totalLen);
      let pos = 0;
      for (const p of utf8Parts) { combined.set(p, pos); pos += p.length; }
      textUtf8 = combined;
    }

    // 4. Resolve the viewer bundle URI (webview-accessible vscode-resource: URI)
    const viewerJsUri = this.panel.webview
      .asWebviewUri(vscode.Uri.joinPath(this.ctx.extension.extensionUri, 'dist', 'viewer', 'viewer.js'))
      .toString();

    // 5. Send assembly data to webview; it will pack + gzip + post exportHtmlReady
    this.post({ type: 'exportHtmlAssembly', viewerJsUri, textUtf8, textOffsets });
  }

  /**
   * Handle `exportHtmlReady` (X2, step 2/2 on host side):
   * Write the assembled HTML bytes to the file chosen earlier, then notify.
   */
  private async handleExportHtmlReady(
    m: Extract<import('../shared/protocol').ToHost, { type: 'exportHtmlReady' }>,
  ): Promise<void> {
    const uri = this.pendingExportUri;
    this.pendingExportUri = undefined;
    if (!uri) {
      this.ctx.log.warn('[exportHtml] exportHtmlReady received but no pending save URI');
      return;
    }
    const bytes = m.htmlBytes instanceof Uint8Array ? m.htmlBytes : new Uint8Array(m.htmlBytes);
    await vscode.workspace.fs.writeFile(uri, bytes);
    this.post({ type: 'htmlExportSaved', path: uri.fsPath });
    const open = await vscode.window.showInformationMessage(
      `HTML export saved to ${path.basename(uri.fsPath)}`,
      'Open',
    );
    if (open === 'Open') {
      await vscode.env.openExternal(uri);
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const dist = vscode.Uri.joinPath(this.ctx.extension.extensionUri, 'dist', 'webview');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'main.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'main.css'));
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
      `worker-src blob:`,
      `connect-src ${webview.cspSource} data: blob:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Atlas</title>
</head>
<body>
<div id="app"></div>
<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.busy?.cancel();
    AtlasPanel.panels.delete(this);
    if (this.jobId) {
      void this.bridge.call('cleanup', this.jobId).catch(() => undefined);
    }
    void fs.rm(this.jobDir.fsPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function isStatus(x: unknown): x is JobStatus {
  return !!x && typeof x === 'object' && 'stage' in (x as object);
}

export { bytesFromPayload };

