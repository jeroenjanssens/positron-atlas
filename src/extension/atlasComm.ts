/**
 * C3 — Python API comm handler.
 *
 * Registers a Positron comm client handler for 'positron.atlas'.
 * When Python calls ``atlas.open(df)``, a comm_open arrives here.
 * We open (or reuse) an Atlas panel for the variable and route
 * subsequent comm messages to the panel's webview as ``apiCommand``
 * messages.  Webview replies (apiReply, selectionChanged) are forwarded
 * back to the Python handle via comm performRpc.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PositronApi } from './positron';
import { AtlasPanel, type AtlasContext, type OpenTarget } from './atlasPanel';
import type * as vscode from 'vscode';

/** comm_open data from the Python kernel. */
interface CommOpenData {
  variable: string;
  apiDir: string;
}

/** Payload sent from Python via comm.send(). */
export interface CommCommand {
  name: string;
  cmdId: string;
  args?: Record<string, unknown>;
}

/**
 * Register the Positron comm handler for 'positron.atlas'.
 * Returns a disposable to un-register.
 */
export function registerAtlasCommHandler(ctx: AtlasContext): vscode.Disposable {
  return ctx.positron.runtime.registerClientHandler({
    clientType: 'positron.atlas',
    callback(client, params) {
      const data = params as CommOpenData;
      if (!data?.variable) return false;

      const log = ctx.log;
      log.info(`atlas comm: open variable=${data.variable} apiDir=${data.apiDir}`);

      // Find or create an Atlas panel for this variable.
      // The sessionId will be resolved by KernelBridge (falls back to foreground session).
      const target: OpenTarget = {
        variable: data.variable,
        sessionId: '',
        languageId: 'python',
      };

      // Try to reuse an existing panel for the same variable.
      let panel = AtlasPanel.getAll().find(
        (p) => p.getState().variable === target.variable,
      );
      if (!panel) {
        panel = AtlasPanel.create(ctx, target);
      }

      // Store the comm client on the panel so it can route replies.
      panel.setCommClient(client, data.apiDir);

      // Route incoming comm messages (Python → host) to the webview.
      client.onDidSendEvent((event) => {
        const cmd = event.data as CommCommand;
        if (!cmd?.name || !cmd?.cmdId) return;
        log.debug(`atlas comm: message name=${cmd.name} cmdId=${cmd.cmdId}`);
        panel!.dispatchCommCommand(cmd.cmdId, cmd.name, cmd.args ?? {});
      });

      // When the comm closes, remove the client from the panel.
      client.onDidChangeClientState((state) => {
        if (state === 'closed' || state === 'closing') {
          panel!.clearCommClient();
        }
      });

      return true; // handler took ownership
    },
  });
}

/**
 * Write a status file to signal completion of a blocking command.
 * Python polls ``api_dir/<cmdId>.json`` for this.
 */
export function writeCommResult(
  apiDir: string,
  cmdId: string,
  ok: boolean,
  error?: string,
): void {
  try {
    fs.mkdirSync(apiDir, { recursive: true });
    const payload = JSON.stringify({ ok, error: error ?? '' });
    fs.writeFileSync(path.join(apiDir, `${cmdId}.json`), payload);
  } catch {
    // Best-effort; Python will time out if the write fails.
  }
}
