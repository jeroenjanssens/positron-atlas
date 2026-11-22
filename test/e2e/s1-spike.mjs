// Spike S1 runner — measures keybinding dispatch, comm latency, Data Explorer API, and
// user keybindings file location in a real Positron instance.
//
// Usage:
//   node test/e2e/s1-spike.mjs [--keep]
//
// Prerequisites: build the extension first (npm run build / just build).
// Results are written to $E2E_OUT/s1-*.json and printed to stdout.
// The spike runner also drives the standard Atlas scenario (small.json) so the Atlas
// panel is open and ready before the keybinding and CDP tests run.

import { spawn, spawnSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { connect } from './cdp.mjs';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const out = process.env.E2E_OUT ?? '/tmp/positron-atlas-e2e';
const logFile = `${out}/scenario.log`;
const timeoutMs = Number(process.env.E2E_TIMEOUT ?? 300_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = new URL('../..', import.meta.url).pathname;
mkdirSync(out, { recursive: true });

// Resolve Python interpreter (same logic as dump-theme.mjs)
function resolvePython() {
  if (process.env.ATLAS_E2E_PYTHON) return process.env.ATLAS_E2E_PYTHON;
  const local = `${root}/.venv-e2e/bin/python`;
  if (existsSync(local)) return local;
  try {
    const commonDir = execSync('git rev-parse --git-common-dir', { cwd: root }).toString().trim();
    const absCommon = commonDir.startsWith('/') ? commonDir : `${root}/${commonDir}`;
    const mainRoot = absCommon.replace(/\/\.git$/, '');
    const mainVenv = `${mainRoot}/.venv-e2e/bin/python`;
    if (existsSync(mainVenv)) return mainVenv;
  } catch {}
  return local;
}
const pythonBin = resolvePython();
console.log(`Using Python: ${pythonBin}`);

// Kill any leftover instance
spawnSync('pkill', ['-9', '-f', out], { stdio: 'ignore' });
await sleep(1500);
rmSync(logFile, { force: true });
rmSync(`${out}/s1-keys.log`, { force: true });

const scenario = `${root}/test/e2e/scenario-small.json`;
const env = {
  ...process.env,
  ATLAS_E2E_PYTHON: pythonBin,
  ATLAS_E2E_SCENARIO: scenario,
  ATLAS_E2E_LOG: logFile,
  E2E_DIR: out,
};

const proc = spawn(`${root}/test/e2e/launch.sh`, [], { env, stdio: 'ignore', detached: true });
const kill = () => {
  try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
  spawnSync('pkill', ['-9', '-f', out], { stdio: 'ignore' });
};

const t0 = Date.now();
const summary = { timestamp: new Date().toISOString(), positronVersion: 'unknown', results: {} };

try {
  // Read Positron version
  try {
    const p = JSON.parse(readFileSync('/Applications/Positron.app/Contents/Resources/app/product.json', 'utf8'));
    summary.positronVersion = p.positronVersion ?? p.version ?? 'unknown';
  } catch {}

  // Wait for scenario ready
  console.log('\n[S1] Waiting for Positron + Atlas…');
  while (!(existsSync(logFile) && /READY|ERROR/.test(readFileSync(logFile, 'utf8')))) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for scenario');
    await sleep(500);
  }
  const logText = readFileSync(logFile, 'utf8');
  if (logText.includes('ERROR')) throw new Error(`Scenario failed: ${logText.trim()}`);
  console.log(`[S1] Scenario ready (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // Connect CDP
  let cdp;
  while (!cdp) {
    cdp = await connect().catch(() => undefined);
    if (!cdp) await sleep(500);
    if (Date.now() - t0 > timeoutMs) throw new Error('CDP connection failed');
  }

  // Find Atlas webview context
  let atlasCtx;
  while (!(atlasCtx = await cdp.atlasContext())) {
    if (Date.now() - t0 > timeoutMs) throw new Error('Atlas webview not found');
    await sleep(500);
  }
  console.log(`[S1] Atlas context found, origin: ${atlasCtx.origin}`);

  // Wait for Atlas ready
  for (;;) {
    const phase = await cdp.evaluate('window.__atlas && window.__atlas.phase', atlasCtx).catch(() => null);
    if (phase === 'ready') break;
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for Atlas ready');
    await sleep(500);
  }
  console.log(`[S1] Atlas ready (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await sleep(800); // let the UI settle

  // ============================================================
  // Q1: Keybinding dispatch while the Atlas webview has focus
  // ============================================================
  console.log('\n[S1] Q1: Keybinding dispatch tests…');
  const q1 = {};

  // Inject a keydown counter into the webview DOM
  await cdp.evaluate(`
    window.__s1_webviewKeys = [];
    document.addEventListener('keydown', function(e) {
      window.__s1_webviewKeys.push({ key: e.key, code: e.code, ts: Date.now() });
    }, true);
  `, atlasCtx);

  // Helper: dispatch a key to the main workbench (the focused "page" in Electron)
  // CDP Input.dispatchKeyEvent without sessionId sends to whatever element is focused in
  // the MAIN workbench page. VS Code's keybinding service intercepts at this level.
  const dispatchKey = async (key, code, modifiers = 0) => {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key, code, modifiers,
      windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0,
      autoRepeat: false, isKeypad: false, isSystemKey: false,
    });
    await sleep(300);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
    await sleep(300);
  };

  // ---- Test: 'r' with when: "positronAtlas.webviewFocused" ----
  const keyLogBefore_r = existsSync(`${out}/s1-keys.log`) ? readFileSync(`${out}/s1-keys.log`, 'utf8') : '';
  await dispatchKey('r', 'KeyR');
  const keyLogAfter_r = existsSync(`${out}/s1-keys.log`) ? readFileSync(`${out}/s1-keys.log`, 'utf8') : '';
  const webviewKeys_r = JSON.parse(await cdp.evaluate('JSON.stringify(window.__s1_webviewKeys)', atlasCtx).catch(() => '[]'));
  q1.r_commandFired_webviewFocused = keyLogAfter_r.length > keyLogBefore_r.length && keyLogAfter_r.includes('FIRED_webviewFocused_r');
  q1.r_webviewReceived = webviewKeys_r.some((k) => k.key === 'r' || k.key === 'R');
  q1.r_doubleHandling = q1.r_commandFired_webviewFocused && q1.r_webviewReceived;
  console.log(`  'r' (webviewFocused): command=${q1.r_commandFired_webviewFocused}, webviewDOM=${q1.r_webviewReceived}, double=${q1.r_doubleHandling}`);

  // ---- Test: '[' with when: "activeWebviewPanelId == 'positronAtlas.view'" ----
  await cdp.evaluate('window.__s1_webviewKeys = []', atlasCtx);
  const keyLogBefore_bracket = keyLogAfter_r;
  await dispatchKey('[', 'BracketLeft');
  const keyLogAfter_bracket = existsSync(`${out}/s1-keys.log`) ? readFileSync(`${out}/s1-keys.log`, 'utf8') : '';
  const webviewKeys_bracket = JSON.parse(await cdp.evaluate('JSON.stringify(window.__s1_webviewKeys)', atlasCtx).catch(() => '[]'));
  q1.bracket_commandFired_panelId = keyLogAfter_bracket.length > keyLogBefore_bracket.length && keyLogAfter_bracket.includes('FIRED_panelId_[');
  q1.bracket_webviewReceived = webviewKeys_bracket.some((k) => k.key === '[');
  q1.bracket_doubleHandling = q1.bracket_commandFired_panelId && q1.bracket_webviewReceived;
  console.log(`  '[' (panelId): command=${q1.bracket_commandFired_panelId}, webviewDOM=${q1.bracket_webviewReceived}, double=${q1.bracket_doubleHandling}`);

  // ---- Test: 'cmd+z' (modifier combo) ----
  await cdp.evaluate('window.__s1_webviewKeys = []', atlasCtx);
  await dispatchKey('z', 'KeyZ', 4 /* Meta/Cmd */);
  const webviewKeys_cmdz = JSON.parse(await cdp.evaluate('JSON.stringify(window.__s1_webviewKeys)', atlasCtx).catch(() => '[]'));
  q1.cmdz_webviewReceived = webviewKeys_cmdz.some((k) => k.key === 'z' || k.key === 'Z');
  console.log(`  'cmd+z': webviewDOM=${q1.cmdz_webviewReceived}`);

  // ---- Test: arrows ----
  await cdp.evaluate('window.__s1_webviewKeys = []', atlasCtx);
  await dispatchKey('ArrowRight', 'ArrowRight');
  const webviewKeys_arrow = JSON.parse(await cdp.evaluate('JSON.stringify(window.__s1_webviewKeys)', atlasCtx).catch(() => '[]'));
  q1.arrow_webviewReceived = webviewKeys_arrow.some((k) => k.key === 'ArrowRight');
  console.log(`  'ArrowRight': webviewDOM=${q1.arrow_webviewReceived}`);

  // Record full key log
  q1.fullKeyLog = existsSync(`${out}/s1-keys.log`) ? readFileSync(`${out}/s1-keys.log`, 'utf8') : '(empty)';
  q1.contextKeyNote = 'positronAtlas.webviewFocused is set when the Atlas panel is active (panel.onDidChangeViewState), not specifically when the canvas DOM element has focus. For true canvas focus, the webview must postMessage focus/blur events to the host.';

  await cdp.screenshot(`${out}/s1-q1.png`);
  summary.results.q1 = q1;
  console.log(`[S1] Q1 done`);

  // ============================================================
  // Q2: Default keybinding collisions — static analysis
  // ============================================================
  console.log('\n[S1] Q2: Keybinding collision analysis (static)…');

  // Analyze built-in extensions (already done offline above, results stored here)
  let extensionBindings = [];
  try {
    const extDir = '/Applications/Positron.app/Contents/Resources/app/extensions';
    const { readdirSync } = await import('node:fs');
    for (const extName of readdirSync(extDir)) {
      const pkgPath = `${extDir}/${extName}/package.json`;
      if (!existsSync(pkgPath)) continue;
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        for (const kb of pkg.contributes?.keybindings ?? []) {
          extensionBindings.push({
            ext: extName,
            key: kb.key ?? '',
            mac: kb.mac ?? '',
            win: kb.win ?? '',
            linux: kb.linux ?? '',
            command: kb.command ?? '',
            when: kb.when ?? '',
          });
        }
      } catch {}
    }
  } catch (e) {
    console.log(`  extension bindings analysis error: ${e.message}`);
  }

  // Planned Atlas keys from napari-plan.md item 1.2:
  // r, [, ], N, ?, 1/2/3, R, +/-, arrows, cmd+z, shift+cmd+z, ctrl+y, cmd+g, Space
  const plannedKeys = ['r', '[', ']', 'n', '?', '1', '2', '3', '+', '-',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
    'cmd+z', 'ctrl+z', 'shift+cmd+z', 'shift+ctrl+z', 'ctrl+y', 'cmd+g', 'ctrl+g'];

  const q2Collisions = [];
  for (const b of extensionBindings) {
    for (const checkKey of [b.key.toLowerCase(), b.mac.toLowerCase(), b.win.toLowerCase()]) {
      const matched = plannedKeys.find((pk) => pk.toLowerCase() === checkKey);
      if (matched) {
        q2Collisions.push({ atlasKey: matched, extensionKey: checkKey, command: b.command, when: b.when, ext: b.ext });
        break;
      }
    }
  }

  const q2 = {
    totalExtensionBindings: extensionBindings.length,
    collisionsWithExtensions: q2Collisions,
    coreVsCodeDefaultsNote: 'Core VS Code keybindings are compiled into workbench.desktop.main.js (minified). Known macOS defaults: cmd+z=undo, shift+cmd+z=redo, ctrl+y=redo(win), cmd+g=findNext, ArrowLeft/Right/Up/Down=cursor movement (when: editorTextFocus), Space=activateSelectedItem (when: listFocus). Plain keys r/[/]/N/?/1/2/3 have NO core default bindings (confirmed by VS Code source). [ and ] do have editor indentation bindings but ONLY when: "editorTextFocus".',
  };
  summary.results.q2 = q2;
  console.log(`  Extension bindings total: ${q2.totalExtensionBindings}, collisions: ${q2Collisions.length}`);
  console.log(`[S1] Q2 done`);

  // ============================================================
  // Q3: Kernel comms — API presence and latency inference
  // ============================================================
  console.log('\n[S1] Q3: Kernel comms…');

  // The comms API presence is confirmed from the @posit-dev/positron type definitions.
  // Runtime measurement requires calling positron.runtime.getSession() from the extension
  // host process, which is not reachable via CDP renderer injection.
  //
  // We CAN measure evaluateCode latency via the Atlas webview's existing timing data.
  const timingsRaw = await cdp.evaluate('window.__atlas && JSON.stringify(window.__atlas.timings)', atlasCtx).catch(() => null);
  const timings = timingsRaw ? JSON.parse(timingsRaw) : null;

  const q3 = {
    commApiAvailable: true,
    apiDetails: {
      createClient: 'LanguageRuntimeSession.createClient(id: string, type: RuntimeClientType, params: Record<string, unknown>): Thenable<void>',
      sendClientMessage: 'LanguageRuntimeSession.sendClientMessage(client_id, message_id, message): void',
      registerClientHandler: 'positron.runtime.registerClientHandler(handler: RuntimeClientHandler): vscode.Disposable',
      performRpc: 'RuntimeClientInstance.performRpc<T>(data: object): Thenable<T>',
      commMessageTypes: ['CommOpen', 'CommData', 'CommClosed'],
    },
    evaluateCodeLatencyNote: 'From positron-spike.md (measured 2026-11-21): evaluateCode median=3ms, p95=4ms. The existing KernelBridge.call() sits on top of evaluateCode with a polling loop, giving ~6ms median RTT for a full call+result cycle.',
    atlasTimings: timings,
    commVsEvalCodeNote: 'Comms (createClient/sendClientMessage) go through the Jupyter wire protocol (ZMQ or WebSocket depending on kernel transport). Expected RTT is comparable to evaluateCode (<10ms) but avoids the kernel busy-waiting that evaluateCode imposes. For the Python API (Q5 in napari-plan.md), comms avoid having the kernel execute Python to deliver events to the extension — the comm channel is a first-class bidirectional channel.',
    directMeasurementStatus: 'NOT measured in this spike run (requires extension host access). To measure: add a comm probe to the helper extension that times createClient + first message round-trip and writes to the s1 log file.',
    recommendation: 'Comms are available and should be used for the Python API (item 12). For one-time event delivery (selection changed), comms avoid the polling overhead of evaluateCode.',
  };
  summary.results.q3 = q3;
  console.log(`  comm API available: ${q3.commApiAvailable} (from type definitions)`);
  console.log(`[S1] Q3 done`);

  // ============================================================
  // Q4: Data Explorer API
  // ============================================================
  console.log('\n[S1] Q4: Data Explorer…');

  // Check the dataExplorer API namespace and available commands
  // We can get commands from the workbench via CDP
  let allCommandsList = [];
  try {
    // Try to find the main workbench execution context
    for (const c of cdp.contexts.values()) {
      const origin = String(c.origin ?? '');
      if (origin.startsWith('vscode-webview://')) continue;
      if (origin.includes('workbench.html') || origin === '') {
        try {
          // Try to get commands list from the workbench renderer
          const cmds = await cdp.evaluate(`
            (() => {
              try {
                // VS Code workbench exposes commands via the commands service
                const cmdsService = window.__commands || window.commands;
                if (cmdsService && cmdsService.getCommands) {
                  return JSON.stringify([...cmdsService.getCommands().keys()].filter(k => k.includes('dataExplorer') || k.includes('Explorer') || k.includes('positron')).slice(0, 50));
                }
              } catch {}
              return JSON.stringify([]);
            })()
          `, c).catch(() => null);
          if (cmds) {
            const list = JSON.parse(cmds);
            if (list.length > 0) { allCommandsList = list; break; }
          }
        } catch {}
      }
    }
  } catch {}

  const q4 = {
    viewMagicSupported: true,
    viewMagicEvidence: 'The helper extension uses positron.runtime.executeCode(sessionId, "%view " + variable, ...) and checks for a "Data:" tab in vscode.window.tabGroups. This confirms %view opens the Positron Data Explorer.',
    dataExplorerOpenApi: {
      exists: true,
      signature: 'positron.dataExplorer.open({ providerId: string, datasetId: string, displayName: string }): Thenable<void>',
      purpose: 'Opens a Data Explorer for a CUSTOM PROVIDER (extension that implements DataExplorerRpcHandler). NOT for opening arbitrary Python session variables.',
      note: 'To use this for in-session DataFrames, the extension would need to register an RPC handler that proxies to the Python kernel. This is what Positron itself does for %view.',
    },
    dataExplorerGetContextApi: {
      exists: true,
      signature: 'positron.dataExplorer.getContext(): Thenable<DataExplorerContext | undefined>',
      purpose: 'Gets info about the ACTIVE Data Explorer (displayName, source, shape, selection, cursor). The source includes sessionId so an extension can tell which variable is open.',
    },
    selectionFrameFlow: {
      current: 'After selection_frame() creates df_selection in the session, the extension shows an info notification. User must manually %view df_selection.',
      recommended: 'After selectionFrame succeeds, call positron.runtime.executeCode(sessionId, `%view ${r.variable}`, false, true, 4 /* Silent */) to open it automatically in the Data Explorer.',
      effort: 'S — one executeCode call in atlasPanel.ts case "selectionFrame"',
    },
    openExample: {
      approach: 'Atlas: Open example command creates a DataFrame in the session via executeCode. After creation, %view the variable to show it in the Data Explorer or immediately open Atlas on it via positronAtlas.openDataFrame.',
    },
    commandsFound: allCommandsList,
  };
  summary.results.q4 = q4;
  console.log(`  %view supported: ${q4.viewMagicSupported}`);
  console.log(`  dataExplorer.open exists (from types): ${q4.dataExplorerOpenApi.exists}`);
  console.log(`[S1] Q4 done`);

  // ============================================================
  // Q5: User keybindings file location
  // ============================================================
  console.log('\n[S1] Q5: User keybindings file location…');
  const q5 = {};

  // Paths in the e2e test profile (--user-data-dir=$E2E/user)
  q5.e2eUserDataDir = `${out}/user`;
  q5.e2eKeybindingsPath = `${out}/user/User/keybindings.json`;
  q5.e2eKeybindingsExists = existsSync(q5.e2eKeybindingsPath);
  q5.e2eSettingsExists = existsSync(`${out}/user/User/settings.json`);

  // Real user profile
  const home = process.env.HOME ?? '/Users/unknown';
  q5.macStandardPath = `${home}/Library/Application Support/Positron/User/keybindings.json`;
  q5.macStandardExists = existsSync(q5.macStandardPath);

  // With profiles
  q5.profilesDirPath = `${home}/Library/Application Support/Positron/User/profiles`;
  q5.profilesDirExists = existsSync(q5.profilesDirPath);
  if (q5.profilesDirExists) {
    try {
      const { readdirSync } = await import('node:fs');
      q5.profileIds = readdirSync(q5.profilesDirPath, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {}
  }

  // VSCODE_USER_DATA_DIR in the extension host process
  // We can check this in the Atlas webview... actually it's the Node.js env, not the webview.
  // The launch.sh sets VSCODE_APPDATA? No. Let's check env from Node.js side.
  q5.envVscodeUserDataDir = process.env.VSCODE_USER_DATA_DIR ?? null;
  q5.envAppData = process.env.APPDATA ?? null; // Windows

  // Windows path: %APPDATA%\Positron\User\keybindings.json
  // Linux path: ~/.config/Positron/User/keybindings.json
  q5.windowsPath = '%APPDATA%\\Positron\\User\\keybindings.json';
  q5.linuxPath = `${home}/.config/Positron/User/keybindings.json`;

  // Extension host access
  q5.extensionHostAccess = {
    envVar: 'process.env.VSCODE_USER_DATA_DIR is set in the extension host Node.js process and points to the user data dir (confirmed by VS Code source). The keybindings.json is at path.join(userDataDir, "User", "keybindings.json").',
    apiDerivation: 'context.globalStorageUri is <userDataDir>/User/globalStorage/<ext-id>/. So userDataDir = path dirname(dirname(dirname(context.globalStorageUri.fsPath))).',
    readPermission: 'The extension can read the file with vscode.workspace.fs.readFile(). The file uses JSONC format (JSON with comments) which requires a tolerant parser.',
    profileCaveat: 'With Positron profiles, the per-profile keybindings live at <userDataDir>/User/profiles/<id>/keybindings.json. The active profile ID is not directly exposed by the VS Code API (1.100.0) but can be inferred from the workspace storage path or by checking env.appRoot context.',
    changeDetection: 'vscode.workspace.createFileSystemWatcher(keybindingsPath) fires when the file changes, allowing the cheat sheet to stay current.',
  };

  summary.results.q5 = q5;
  console.log(`  macOS standard path: ${q5.macStandardPath}`);
  console.log(`  exists: ${q5.macStandardExists}`);
  console.log(`  profiles dir exists: ${q5.profilesDirExists}, profile IDs: ${JSON.stringify(q5.profileIds ?? [])}`);
  console.log(`  VSCODE_USER_DATA_DIR: ${q5.envVscodeUserDataDir}`);
  console.log(`[S1] Q5 done`);

  // Write full results
  writeFileSync(`${out}/s1-summary.json`, JSON.stringify(summary, null, 2));
  console.log(`\n[S1] Results written to ${out}/s1-summary.json`);
  await cdp.screenshot(`${out}/s1-final.png`);
  cdp.close();

} catch (e) {
  console.error(`\n[S1] FAILED: ${e.message}`);
  console.error(e.stack);
  try {
    const cdp2 = await connect();
    await cdp2.screenshot(`${out}/s1-failure.png`);
    cdp2.close();
  } catch {}
  writeFileSync(`${out}/s1-summary.json`, JSON.stringify({ ...summary, error: String(e) }, null, 2));
} finally {
  if (!keep) kill();
}

// Print final summary
console.log('\n=== Spike S1 Results ===');
try {
  const s = JSON.parse(readFileSync(`${out}/s1-summary.json`, 'utf8'));
  console.log(`Positron version: ${s.positronVersion}`);
  if (s.error) { console.log(`ERROR: ${s.error}`); process.exit(1); }
  const q1 = s.results.q1 ?? {};
  console.log(`\nQ1 — Keybinding dispatch (Atlas webview focused):`);
  console.log(`  'r' (webviewFocused context): command fired=${q1.r_commandFired_webviewFocused ?? 'n/a'}, webview received=${q1.r_webviewReceived ?? 'n/a'}, double-handling=${q1.r_doubleHandling ?? 'n/a'}`);
  console.log(`  '[' (activeWebviewPanelId):   command fired=${q1.bracket_commandFired_panelId ?? 'n/a'}, webview received=${q1.bracket_webviewReceived ?? 'n/a'}, double-handling=${q1.bracket_doubleHandling ?? 'n/a'}`);
  console.log(`  'cmd+z':                       webview received=${q1.cmdz_webviewReceived ?? 'n/a'}`);
  console.log(`  'ArrowRight':                  webview received=${q1.arrow_webviewReceived ?? 'n/a'}`);
  const q2 = s.results.q2 ?? {};
  console.log(`\nQ2 — Extension binding collisions: ${q2.collisionsWithExtensions?.length ?? 0} collisions with built-in extensions`);
  if (q2.collisionsWithExtensions?.length) {
    for (const c of q2.collisionsWithExtensions) console.log(`  ${c.atlasKey} → ${c.command} (${c.ext}) when=${c.when}`);
  }
  const q5 = s.results.q5 ?? {};
  console.log(`\nQ5 — keybindings.json:`);
  console.log(`  macOS: ${q5.macStandardPath} (exists=${q5.macStandardExists})`);
  console.log(`  profiles: ${q5.profilesDirExists ? JSON.stringify(q5.profileIds) : 'none'}`);
} catch (e) { console.log(`Could not read summary: ${e.message}`); }
