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
    await positron.runtime.selectLanguageRuntime(runtime.runtimeId);
    let session;
    for (let i = 0; i < 120 && !session; i++) {
      session = (await positron.runtime.getActiveSessions()).find((s) => s.runtimeMetadata.runtimeId === runtime.runtimeId);
      if (!session) await new Promise((r) => setTimeout(r, 500));
    }
    log(`session ${session && session.metadata.sessionId}`);
    if (sc.setup) {
      await positron.runtime.executeCode('python', sc.setup, false, false, undefined, undefined, undefined, session.metadata.sessionId);
      log('setup done');
    }
    if (sc.variable) {
      await vscode.commands.executeCommand('positronAtlas.openDataFrame', sc.variable);
      log('opened atlas');
    }
    log('READY');
  } catch (e) {
    log(`ERROR ${e && e.stack ? e.stack : e}`);
  }
}

module.exports = { activate, deactivate() {} };
