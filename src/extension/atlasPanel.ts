import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { KernelBridge, KernelError } from './kernelBridge';
import type { PositronApi } from './positron';
import type {
  ColorMeta,
  DescribeResult,
  FileRef,
  JobStatus,
  KernelOutput,
  PanelState,
  PrepareResult,
  Settings,
  ToHost,
  ToWebview,
} from '../shared/protocol';

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
  };
}

/** One editor tab showing one DataFrame. */
export class AtlasPanel {
  private static readonly panels = new Set<AtlasPanel>();

  private readonly bridge: KernelBridge;
  private readonly jobDir: vscode.Uri;
  private jobId: string | undefined;
  private fileVersion = 0;
  private disposed = false;
  private busy: vscode.CancellationTokenSource | undefined;
  private state: PanelState;
  private projectionCurrent = false;

  static create(ctx: AtlasContext, target: OpenTarget): AtlasPanel {
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, `Atlas: ${target.variable}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extension.extensionUri, 'dist'), ctx.jobsRoot],
    });
    return new AtlasPanel(ctx, panel, { ...target });
  }

  static revive(ctx: AtlasContext, panel: vscode.WebviewPanel, state: PanelState): AtlasPanel {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extension.extensionUri, 'dist'), ctx.jobsRoot],
    };
    return new AtlasPanel(ctx, panel, state);
  }

  private constructor(
    private readonly ctx: AtlasContext,
    private readonly panel: vscode.WebviewPanel,
    state: PanelState,
  ) {
    this.state = state;
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
        describe = await this.bridge.call<DescribeResult>('describe', this.state.variable);
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
    const job = await this.bridge.call<{ jobId: string }>('create_job', this.state.variable, this.jobDir.fsPath);
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
        await this.bridge.call('prepare', job, JSON.stringify(m.options));
        const s = await this.bridge.waitForJob(job, (st) => this.post({ type: 'status', task: 'prepare', status: st }), token);
        if (s.stage === 'done') {
          const res = s.result as PrepareResult;
          const anchors = s.outputs.find((o) => o.kind === 'anchors')!;
          const anchorPos = s.outputs.find((o) => o.kind === 'anchorPos')!;
          this.post({ type: 'prepared', result: res, anchors: this.fileRef(anchors), anchorPos: this.fileRef(anchorPos) });
        } else if (s.stage === 'error') {
          throw new KernelError(s.error ?? 'Preparing the data failed', s.result?.traceback);
        }
        break;
      }
      case 'estimate': {
        const r = await this.bridge.call<{ flops: number; rows: number }>('estimate_projection', this.requireJob());
        // Fitted to python/bench.py on an M4 Pro (numpy only): per-row top-k cost dominates.
        this.post({ type: 'estimate', seconds: 1.2e-5 * r.rows + 2.2e-11 * r.flops, rows: r.rows });
        break;
      }
      case 'project': {
        const job = this.requireJob();
        const xyPath = path.join(this.jobDir.fsPath, `anchor_xy_${Date.now()}.f32`);
        await fs.writeFile(xyPath, Buffer.from(m.anchorXY, 'base64'));
        try {
          await this.runXYTask('project', () => this.bridge.call('project', job, xyPath, JSON.stringify({ metric: m.metric, seed: m.seed })), false);
        } finally {
          await fs.rm(xyPath, { force: true });
        }
        break;
      }
      case 'exact': {
        const job = this.requireJob();
        await this.runXYTask('exact', () => this.bridge.call('exact_umap', job, JSON.stringify(m.params)), true);
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
      case 'row': {
        const r = await this.bridge.call<{ row: number; values: [string, string][] }>('row', this.requireJob(), m.i);
        this.post({ type: 'row', i: m.i, row: r.row, values: r.values });
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
        const pick = await vscode.window.showWarningMessage(
          `Add columns umap_x and umap_y to ${this.state.variable}? This modifies the DataFrame in your session.`,
          { modal: true },
          'Add Columns',
        );
        if (pick !== 'Add Columns') {
          return;
        }
        let xyPath = '';
        if (m.anchorXY && !m.useProjection) {
          xyPath = path.join(this.jobDir.fsPath, `coords_${Date.now()}.f32`);
          await fs.writeFile(xyPath, Buffer.from(m.anchorXY, 'base64'));
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
      case 'savePng': {
        const uri = await vscode.window.showSaveDialog({
          filters: { 'PNG image': ['png'] },
          defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', `${this.state.variable}-umap.png`)),
        });
        if (uri) {
          const b64 = m.dataUrl.replace(/^data:image\/png;base64,/, '');
          await vscode.workspace.fs.writeFile(uri, Buffer.from(b64, 'base64'));
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
      this.post({ type: 'projected', seconds: s.result?.seconds ?? 0, exact });
    } else if (s.stage === 'error') {
      throw new KernelError(s.error ?? `${task} failed`, s.result?.traceback);
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
