import * as vscode from 'vscode';
import type { PositronApi } from './positron';
import type { JobStatus } from '../shared/protocol';

export const KERNEL_MODULE = '_positron_atlas';

/** Python string literal for an arbitrary JS string (JSON string escapes are valid Python). */
export function pyStr(s: string): string {
  return JSON.stringify(s);
}

/** Expression that loads (or reloads) the helper module without touching the user namespace. */
export function bootstrapCode(modulePath: string, version: string): string {
  const src = [
    'import sys, importlib.util as u',
    `m = sys.modules.get(${pyStr(KERNEL_MODULE)})`,
    `if m is None or getattr(m, "VERSION", None) != ${pyStr(version)} or getattr(m, "__file__", None) != ${pyStr(modulePath)}:`,
    `    s = u.spec_from_file_location(${pyStr(KERNEL_MODULE)}, ${pyStr(modulePath)})`,
    '    m = u.module_from_spec(s)',
    `    sys.modules[${pyStr(KERNEL_MODULE)}] = m`,
    '    s.loader.exec_module(m)',
  ].join('\n');
  // exec in a throwaway dict so no names leak into the user's namespace.
  return `__import__("builtins").exec(${pyStr(src)}, {})`;
}

/** Expression calling module function `fn` with JSON-serializable positional args. */
export function callCode(fn: string, args: unknown[]): string {
  const payload = pyStr(JSON.stringify(args));
  return (
    `(lambda m: m.${fn}(*__import__("json").loads(${payload})) if m is not None ` +
    `else '{"ok": false, "error": "__not_loaded__"}')(__import__("sys").modules.get(${pyStr(KERNEL_MODULE)}))`
  );
}

export class KernelError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
  }
}

/** Talks to the kernel helper through positron.runtime.evaluateCode (silent, JSON results). */
export class KernelBridge {
  private loaded = false;

  constructor(
    private readonly positron: PositronApi,
    public sessionId: string,
    readonly languageId: string,
    private readonly modulePath: string,
    private readonly version: string,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  private async evaluate(code: string, token?: vscode.CancellationToken): Promise<unknown> {
    const res = await this.positron.runtime.evaluateCode(this.languageId, code, token, this.sessionId);
    if (res.output) {
      this.log.debug(`kernel output: ${res.output}`);
    }
    return res.result;
  }

  /** Point the bridge at another session (e.g. after a restart); the helper must be reloaded. */
  retarget(sessionId: string): void {
    if (sessionId !== this.sessionId) {
      this.sessionId = sessionId;
      this.loaded = false;
    }
  }

  async ensureLoaded(force = false): Promise<void> {
    if (this.loaded && !force) {
      return;
    }
    await this.evaluate(bootstrapCode(this.modulePath, this.version));
    this.loaded = true;
  }

  /** Call a helper function and parse its JSON result; throws KernelError when ok=false. */
  async call<T = any>(fn: string, ...args: unknown[]): Promise<T> {
    await this.ensureLoaded();
    let raw = await this.evaluate(callCode(fn, args));
    let parsed = parse(raw);
    if (parsed && parsed.ok === false && parsed.error === '__not_loaded__') {
      // Kernel restarted: the module is gone. Reload and retry once.
      await this.ensureLoaded(true);
      raw = await this.evaluate(callCode(fn, args));
      parsed = parse(raw);
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new KernelError(`Unexpected result from kernel for ${fn}: ${String(raw).slice(0, 200)}`);
    }
    if (parsed.ok === false) {
      throw new KernelError(parsed.error ?? `Kernel call ${fn} failed`, parsed.traceback);
    }
    return parsed as T;
  }

  /** Poll a job until it finishes; reports each status. */
  async waitForJob(
    jobId: string,
    onStatus: (s: JobStatus) => void,
    token?: vscode.CancellationToken,
  ): Promise<JobStatus> {
    let delay = 50;
    for (;;) {
      // A superseded wait just stops polling; the kernel cancels the old thread itself
      // when the next task starts (or on an explicit 'cancel' message).
      if (token?.isCancellationRequested) {
        return { ok: true, jobId, task: '', stage: 'superseded', progress: 0, message: '', error: null, result: {}, outputs: [], elapsed: 0, stale: false };
      }
      const s = await this.call<JobStatus>('status', jobId);
      if (token?.isCancellationRequested) {
        continue;
      }
      onStatus(s);
      if (s.stage === 'done' || s.stage === 'error' || s.stage === 'cancelled') {
        return s;
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(150, delay * 1.5);
    }
  }
}

function parse(raw: unknown): any {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  return raw;
}
