// Test-only extension: drives a scenario described by $ATLAS_E2E_SCENARIO (a JSON file):
// { "interpreter": "/path/python", "setup": "python code", "variable": "df" }
// It starts the Python runtime, runs the setup code in the console, opens the Atlas view,
// and writes progress lines to $ATLAS_E2E_LOG.
const vscode = require('vscode');
const fs = require('fs');

function log(msg) {
  const f = process.env.ATLAS_E2E_LOG;
  if (f) fs.appendFileSync(f, `${new Date().toISOString()} ${msg}\n`);
}

async function activate() {
  const file = process.env.ATLAS_E2E_SCENARIO;
  if (!file) return;
  const marker = `${process.env.ATLAS_E2E_LOG}.reloaded`;
  if (fs.existsSync(marker)) {
    log('after reload');
    // Recreate the data in the (possibly new) session, as a persistent kernel would have it.
    try {
      const sc = JSON.parse(fs.readFileSync(file, 'utf8'));
      const positron = globalThis.acquirePositronApi?.();
      let session;
      for (let i = 0; i < 120 && !session; i++) {
        session = (await positron.runtime.getActiveSessions()).find((s) => s.runtimeMetadata.languageId === 'python');
        if (!session) await new Promise((r) => setTimeout(r, 500));
      }
      await positron.runtime.executeCode('python', sc.setup, false, false, undefined, undefined, undefined, session.metadata.sessionId);
      log('setup after reload done');
    } catch (e) {
      log(`ERROR after reload: ${e}`);
    }
    return;
  }
  try {
    const sc = JSON.parse(fs.readFileSync(file, 'utf8'));
    sc.interpreter = sc.interpreter || process.env.ATLAS_E2E_PYTHON;
    const positron = globalThis.acquirePositronApi?.();
    if (!positron) throw new Error('no positron api');
    let runtime;
    for (let i = 0; i < 120 && !runtime; i++) {
      const rts = await positron.runtime.getRegisteredRuntimes();
      runtime = rts.find((r) => r.languageId === 'python' && r.runtimePath === sc.interpreter);
      if (!runtime) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!runtime) throw new Error('python runtime not found');
    log(`runtime ${runtime.runtimeId} ${runtime.runtimePath}`);
    // A fresh Positron sometimes shuts the first console session down right after it
    // starts. Wait until a session has stayed alive for a few seconds.
    let session;
    for (let attempt = 0; attempt < 5 && !session; attempt++) {
      let candidate;
      if (attempt === 0) {
        await positron.runtime.selectLanguageRuntime(runtime.runtimeId);
        for (let i = 0; i < 120 && !candidate; i++) {
          candidate = (await positron.runtime.getActiveSessions()).find((s) => s.runtimeMetadata.runtimeId === runtime.runtimeId);
          if (!candidate) await new Promise((r) => setTimeout(r, 500));
        }
      } else {
        // The previous session exited: start a brand-new one.
        candidate = await positron.runtime.startLanguageRuntime(runtime.runtimeId, `Python (e2e ${attempt})`);
      }
      await new Promise((r) => setTimeout(r, 6000));
      const alive = candidate && (await positron.runtime.getActiveSessions()).some((s) => s.metadata.sessionId === candidate.metadata.sessionId);
      const state = alive && candidate.getRuntimeState ? await candidate.getRuntimeState() : undefined;
      log(`session ${candidate && candidate.metadata.sessionId} alive=${alive} state=${state}`);
      if (alive && state !== 'exited') session = candidate;
    }
    if (!session) throw new Error('no stable Python session');
    if (sc.setup) {
      await positron.runtime.executeCode('python', sc.setup, false, false, undefined, undefined, undefined, session.metadata.sessionId);
      log('setup done');
    }
    if (sc.pythonApiCode) {
      // Prepend a bootstrap snippet so `import positron_atlas` works even if
      // the Atlas extension's auto-load hasn't completed yet.
      const nodePath = require('path');
      const kernelPath = nodePath.join(__dirname, '../../../python/positron_atlas_kernel.py');
      const bootstrapLines = [
        'import sys as _sys, importlib.util as _u',
        "_m = _sys.modules.get('_positron_atlas')",
        'if _m is None:',
        `    _s = _u.spec_from_file_location('_positron_atlas', ${JSON.stringify(kernelPath)})`,
        '    _m = _u.module_from_spec(_s)',
        "    _sys.modules['_positron_atlas'] = _m",
        '    _s.loader.exec_module(_m)',
        'del _sys, _u, _m',
      ];
      const fullCode = [...bootstrapLines, sc.pythonApiCode].join('\n');
      log(`kernel path: ${kernelPath}`);

      // The Python code opens Atlas itself via comm (positron_atlas); no need to run a command.
      await positron.runtime.executeCode('python', fullCode, false, false, undefined, undefined, undefined, session.metadata.sessionId);
      log('pythonApiCode done');
      // Poll for run-cell requests so run.mjs can trigger additional Python cells.
      const out = process.env.E2E_DIR || '/tmp/positron-atlas-e2e';
      const runCellFile = `${out}/run-cell.json`;
      const intervalId = setInterval(async () => {
        if (!fs.existsSync(runCellFile)) return;
        let req;
        try { req = JSON.parse(fs.readFileSync(runCellFile, 'utf8')); } catch { return; }
        try { fs.unlinkSync(runCellFile); } catch {}
        if (req && req.code) {
          try {
            await positron.runtime.executeCode('python', req.code, false, false, undefined, undefined, undefined, session.metadata.sessionId);
            log(`run-cell done: ${req.code.slice(0, 60)}`);
          } catch (e) { log(`run-cell error: ${e}`); }
        }
      }, 300);
      log('READY');
      return;
    }
    if (sc.viaDataExplorer) {
      // Open the variable in Positron's Data Explorer, then use our toolbar command.
      await positron.runtime.executeCode('python', `%view ${sc.variable}`, false, false, undefined, undefined, undefined, session.metadata.sessionId);
      let label;
      for (let i = 0; i < 60; i++) {
        label = vscode.window.tabGroups.activeTabGroup.activeTab?.label;
        if (label && label.startsWith('Data:')) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      log(`data explorer tab: ${label}`);
      await new Promise((r) => setTimeout(r, 1500));
      if (!sc.noOpen) {
        await vscode.commands.executeCommand('positronAtlas.openFromDataExplorer');
        log('opened atlas from data explorer');
      }
    } else if (sc.variable) {
      await vscode.commands.executeCommand('positronAtlas.openDataFrame', sc.variable);
      log('opened atlas');
    }
    if (sc.reloadAfterMs) {
      await new Promise((r) => setTimeout(r, sc.reloadAfterMs));
      fs.writeFileSync(marker, '1');
      log('reloading window');
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
      return;
    }
    log('READY');
  } catch (e) {
    const detail = e ? (e.stack || e.message || JSON.stringify(e)) : String(e);
    log(`ERROR ${detail}`);
  }
}

module.exports = { activate, deactivate() {} };
