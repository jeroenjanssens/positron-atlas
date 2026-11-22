import * as vscode from 'vscode';
import { getPositron, type PositronApi } from './positron';
import { AtlasPanel, VIEW_TYPE, type AtlasContext, type OpenTarget, readNavSettings } from './atlasPanel';
import { KernelBridge, pyStr } from './kernelBridge';
import type { PanelState } from '../shared/protocol';
import type { ActionId } from '../webview/input/bindings';
import { isPlainName, parseDataExplorerTabLabel } from './tabLabel';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Positron Atlas', { log: true });
  context.subscriptions.push(log);
  const positron = getPositron();
  const jobsRoot = vscode.Uri.joinPath(context.globalStorageUri, 'jobs');
  void sweepJobs(jobsRoot);

  const requirePositron = (): PositronApi | undefined => {
    if (!positron) {
      void vscode.window.showErrorMessage('Positron Atlas requires Positron (https://positron.posit.co).');
    }
    return positron;
  };
  const ctx = (p: PositronApi): AtlasContext => ({ extension: context, positron: p, log, jobsRoot });

  context.subscriptions.push(
    vscode.commands.registerCommand('positronAtlas.openFromDataExplorer', async () => {
      const p = requirePositron();
      if (!p) {
        return;
      }
      try {
        const target = await targetFromDataExplorer(p, ctx(p));
        if (target) {
          openAtlas(ctx(p), target);
        }
      } catch (e) {
        void vscode.window.showErrorMessage(`Atlas: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
    vscode.commands.registerCommand('positronAtlas.openDataFrame', async (variable?: string) => {
      const p = requirePositron();
      if (!p) {
        return;
      }
      try {
        const target = await pickDataFrame(p, ctx(p), typeof variable === 'string' ? variable : undefined);
        if (target) {
          openAtlas(ctx(p), target);
        }
      } catch (e) {
        void vscode.window.showErrorMessage(`Atlas: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
    vscode.commands.registerCommand('positronAtlas.openExample', async () => {
      const p = requirePositron();
      if (!p) {
        return;
      }
      try {
        await runOpenExample(p, ctx(p), context);
      } catch (e) {
        void vscode.window.showErrorMessage(`Atlas: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
    // ---- Navigation commands (item 1) -------------------------------------------
    // Forwarded to the focused (or active) Atlas tab only.
    ...(([
      'view.reset', 'view.zoomIn', 'view.zoomOut',
      'view.panLeft', 'view.panRight', 'view.panUp', 'view.panDown',
      'view.rotateLeft', 'view.rotateRight', 'view.resetRotation',
      'view.top', 'view.front', 'view.side',
      'view.toggle3D', 'view.toggleFullScreen', 'view.showControls',
      'tool.pan', 'tool.lasso', 'tool.annotate',
      'edit.undo', 'edit.redo',
      'select.all', 'select.clear',
    ] as ActionId[]).map((actionId) =>
      vscode.commands.registerCommand(`positronAtlas.nav.${actionId}`, () => {
        AtlasPanel.commandTarget()?.forwardCommand(actionId);
      }),
    )),
    // ---- Configuration change listener (item 1) ----------------------------------
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('positronAtlas.navigation')) {
        const nav = readNavSettings();
        for (const panel of AtlasPanel.getAll()) {
          panel.postNavSettings(nav);
        }
      }
    }),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: PanelState | undefined) {
        log.info(`restoring Atlas tab: ${JSON.stringify({ variable: state?.variable, sessionId: state?.sessionId })}`);
        if (!positron || !state?.variable) {
          panel.dispose();
          return;
        }
        // The session may be gone after a restart; fall back to the foreground Python session.
        let sessionId = state.sessionId;
        const existing = await positron.runtime.getSession(sessionId).then(
          (s) => s,
          () => undefined,
        );
        if (!existing) {
          const fg = await foregroundPython(positron);
          if (fg) {
            sessionId = fg.sessionId;
          }
        }
        AtlasPanel.revive(ctx(positron), panel, { ...state, sessionId });
      },
    }),
    { dispose: () => AtlasPanel.disposeAll() },
  );
}

export function deactivate(): void {}

/** Single entry point used by every UI affordance. */
export function openAtlas(ctx: AtlasContext, target: OpenTarget): AtlasPanel {
  return AtlasPanel.create(ctx, target);
}

async function foregroundPython(p: PositronApi): Promise<{ sessionId: string; languageId: string } | undefined> {
  const fg = await p.runtime.getForegroundSession();
  if (fg && fg.runtimeMetadata.languageId === 'python') {
    return { sessionId: fg.metadata.sessionId, languageId: 'python' };
  }
  const sessions = await p.runtime.getActiveSessions();
  const py = sessions.find((s) => s.runtimeMetadata.languageId === 'python');
  return py ? { sessionId: py.metadata.sessionId, languageId: 'python' } : undefined;
}

function bridgeFor(ctx: AtlasContext, sessionId: string): KernelBridge {
  const modulePath = vscode.Uri.joinPath(ctx.extension.extensionUri, 'python', 'positron_atlas_kernel.py').fsPath;
  const version = String(ctx.extension.extension.packageJSON.version ?? '0.0.0');
  return new KernelBridge(ctx.positron, sessionId, 'python', modulePath, version, ctx.log);
}

interface FrameInfo {
  name: string;
  kind: string;
  shape: [number, number] | null;
}

async function listFrames(ctx: AtlasContext, sessionId: string): Promise<FrameInfo[]> {
  const r = await bridgeFor(ctx, sessionId).call<{ frames: FrameInfo[] }>('list_frames');
  return r.frames;
}

async function targetFromDataExplorer(p: PositronApi, ctx: AtlasContext): Promise<OpenTarget | undefined> {
  let variable: string | undefined;
  let sessionId: string | undefined;
  // Newer Positron builds expose the active Data Explorer's context directly.
  const de = (p as any).dataExplorer;
  if (typeof de?.getContext === 'function') {
    const c = await de.getContext();
    if (c) {
      variable = c.displayName;
      sessionId = c.source?.sessionId;
      if (!sessionId && (c.source?.fileUri || c.source?.connectionName)) {
        throw new Error('Atlas works with DataFrames in a Python session, not with files or connections.');
      }
    }
  }
  if (!variable) {
    variable = parseDataExplorerTabLabel(vscode.window.tabGroups.activeTabGroup.activeTab?.label);
  }
  if (!variable) {
    return pickDataFrame(p, ctx);
  }
  if (!isPlainName(variable)) {
    // Display names may be expressions or file names; never evaluate those implicitly.
    throw new Error(`"${variable}" is not a variable name. Use "Atlas: Open DataFrame…" to enter an expression.`);
  }
  if (sessionId) {
    const s = await p.runtime.getSession(sessionId);
    if (s && s.runtimeMetadata.languageId !== 'python') {
      throw new Error(`Only Python sessions are supported for now (this is ${s.runtimeMetadata.languageName}).`);
    }
    return { variable, sessionId, languageId: 'python' };
  }
  // Older builds: find the Python session that has this variable, foreground first.
  const fg = await foregroundPython(p);
  const sessions = (await p.runtime.getActiveSessions()).filter((s) => s.runtimeMetadata.languageId === 'python');
  const ids = [...new Set([fg?.sessionId, ...sessions.map((s) => s.metadata.sessionId)].filter(Boolean) as string[])];
  for (const id of ids) {
    try {
      const frames = await listFrames(ctx, id);
      if (frames.some((f) => f.name === variable)) {
        return { variable, sessionId: id, languageId: 'python' };
      }
    } catch (e) {
      ctx.log.warn(`list_frames failed in session ${id}: ${String(e)}`);
    }
  }
  if (fg) {
    // Could be an expression (e.g. nested attribute); let describe() decide.
    return { variable, sessionId: fg.sessionId, languageId: 'python' };
  }
  throw new Error('No running Python session found.');
}

async function pickDataFrame(p: PositronApi, ctx: AtlasContext, preset?: string): Promise<OpenTarget | undefined> {
  const fg = await foregroundPython(p);
  if (!fg) {
    throw new Error('Start a Python console first.');
  }
  if (preset) {
    return { variable: preset, sessionId: fg.sessionId, languageId: 'python' };
  }
  const frames = await listFrames(ctx, fg.sessionId);
  const editor = vscode.window.activeTextEditor;
  let wordAtCursor: string | undefined;
  if (editor) {
    const sel = editor.selection;
    const range = sel.isEmpty ? editor.document.getWordRangeAtPosition(sel.active) : sel;
    wordAtCursor = range ? editor.document.getText(range) : undefined;
  }
  type Item = vscode.QuickPickItem & { variable?: string; custom?: boolean };
  const items: Item[] = frames
    .filter((f) => f.kind !== 'polars-lazy')
    .map((f) => ({
      label: f.name,
      description: `${f.kind} ${f.shape ? `${f.shape[0].toLocaleString()} × ${f.shape[1].toLocaleString()}` : ''}`,
      variable: f.name,
      picked: f.name === wordAtCursor,
    }));
  items.sort((a, b) => Number(b.picked) - Number(a.picked));
  items.push({ label: '$(edit) Enter an expression…', custom: true, alwaysShow: true });
  const pick = await vscode.window.showQuickPick(items, { title: 'Atlas: Open DataFrame', placeHolder: 'Select a pandas or polars DataFrame' });
  if (!pick) {
    return undefined;
  }
  let variable = pick.variable;
  if (pick.custom) {
    variable = await vscode.window.showInputBox({ prompt: 'Python expression that evaluates to a DataFrame', value: wordAtCursor });
  }
  return variable ? { variable, sessionId: fg.sessionId, languageId: 'python' } : undefined;
}

// ---------------------------------------------------------------------------
// "Atlas: Open example" command helpers
// ---------------------------------------------------------------------------

/** Metadata for one example dataset shown in the quick pick. */
interface ExampleEntry {
  id: string;
  label: string;
  description: string;
}

/**
 * Example datasets available via "Atlas: Open example".
 * Keep in sync with the loaders in python/positron_atlas_examples.py.
 */
const EXAMPLES: ExampleEntry[] = [
  { id: 'mnist',   label: 'MNIST — handwritten digits',  description: '70,000 rows × 784 pixels  |  ~11 MB download' },
  { id: 'fashion', label: 'Fashion MNIST — clothing images', description: '70,000 rows × 784 pixels  |  ~11 MB download' },
  { id: 'covtype', label: 'Forest Cover Type',            description: '581,012 rows × 10 features  |  ~11 MB download' },
];

/**
 * Build the Python code that loads one example into the user's namespace.
 * Loads positron_atlas_examples.py by path (same approach as the kernel helper),
 * calls load_example(id) and assigns the result to a variable named after the id.
 * Cleanup names (_u, _s, _m) are prefixed to avoid colliding with user variables.
 */
function buildExampleCode(modulePath: string, exampleId: string): string {
  const lines = [
    'import importlib.util as _u',
    `_s = _u.spec_from_file_location("_positron_atlas_examples", ${pyStr(modulePath)})`,
    '_m = _u.module_from_spec(_s)',
    '_s.loader.exec_module(_m)',
    `${exampleId} = _m.load_example(${pyStr(exampleId)})`,
    'del _u, _s, _m',
  ];
  return lines.join('\n');
}

async function runOpenExample(
  p: PositronApi,
  ctx: AtlasContext,
  extensionCtx: vscode.ExtensionContext,
): Promise<void> {
  const examplesPath = vscode.Uri.joinPath(extensionCtx.extensionUri, 'python', 'positron_atlas_examples.py').fsPath;

  const items = EXAMPLES.map((ex) => ({ label: ex.label, description: ex.description, _id: ex.id }));
  const pick = await vscode.window.showQuickPick(items, {
    title: 'Atlas: Open example',
    placeHolder: 'Select an example dataset to download and open',
  });
  if (!pick) {
    return;
  }

  const exampleId = pick._id;
  const fg = await foregroundPython(p);
  if (!fg) {
    throw new Error('Start a Python console first.');
  }

  const code = buildExampleCode(examplesPath, exampleId);

  // Run with a progress notification.  Download/build output goes to the Python console.
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Atlas: loading ${pick.label}…`,
      cancellable: false,
    },
    async () => {
      await p.runtime.executeCode('python', code, false, false, undefined, undefined, undefined, fg.sessionId);
    },
  );

  openAtlas(ctx, { variable: exampleId, sessionId: fg.sessionId, languageId: 'python' });
}

async function sweepJobs(root: vscode.Uri): Promise<void> {
  // Remove job directories left behind by previous windows (older than a day).
  try {
    const fs = await import('node:fs/promises');
    const entries = await fs.readdir(root.fsPath, { withFileTypes: true });
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const e of entries) {
      const p = vscode.Uri.joinPath(root, e.name).fsPath;
      const st = await fs.stat(p);
      if (st.mtimeMs < cutoff) {
        await fs.rm(p, { recursive: true, force: true });
      }
    }
  } catch {
    // root may not exist yet
  }
}
