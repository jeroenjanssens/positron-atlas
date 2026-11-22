// dump-theme.mjs — dump real --vscode-* CSS variables from Positron webviews.
//
// Usage:
//   node test/e2e/dump-theme.mjs [--keep] [--theme dark-modern|light-modern|high-contrast-dark|all]
//
// For each theme, launches an isolated Positron (via test/e2e/launch.sh) with the target
// colorTheme, opens the Atlas panel, reads every --vscode-* custom property from
// getComputedStyle(document.documentElement) inside the webview, and writes a sorted JSON
// file to test/harness/themes/<id>.json.
//
// The key "_source" records which Positron version and date produced the file; all other
// keys start with "--" so the browser harness ignores "_source" automatically.
//
// Environment variables (all optional):
//   E2E_OUT          scratch dir for logs/screenshots (default: /tmp/positron-atlas-e2e)
//   E2E_TIMEOUT      ms per theme before giving up    (default: 300000)
//   CDP_PORT         remote-debugging port             (default: 9334)
//   ATLAS_E2E_PYTHON path to python interpreter       (default: .venv-e2e/bin/python)

import { spawn, spawnSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { connect } from './cdp.mjs';

const POSITRON_APP = '/Applications/Positron.app';
const POSITRON_BIN = `${POSITRON_APP}/Contents/MacOS/Positron`;
const POSITRON_PRODUCT = `${POSITRON_APP}/Contents/Resources/app/product.json`;

if (!existsSync(POSITRON_BIN)) {
  console.error(`Positron not found at ${POSITRON_BIN}`);
  process.exit(1);
}

// Read Positron version
let positronVersion = 'unknown';
try {
  const p = JSON.parse(readFileSync(POSITRON_PRODUCT, 'utf8'));
  positronVersion = p.positronVersion ?? p.version ?? 'unknown';
} catch {}

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const themeArg = args.find((a) => !a.startsWith('-'));

const ALL_THEMES = [
  { id: 'dark-modern',       name: 'Dark Modern' },
  { id: 'light-modern',      name: 'Light Modern' },
  { id: 'high-contrast-dark', name: 'Default High Contrast' },
];

const themes = themeArg && themeArg !== 'all'
  ? ALL_THEMES.filter((t) => t.id === themeArg)
  : ALL_THEMES;

if (themes.length === 0) {
  console.error(`Unknown theme "${themeArg}". Valid: dark-modern, light-modern, high-contrast-dark, all`);
  process.exit(1);
}

const root = new URL('../..', import.meta.url).pathname;

// Resolve the Python interpreter: prefer the env var, then look in this repo root,
// then fall back to the main repo root (relevant when running from a git worktree).
function resolveVenv() {
  if (process.env.ATLAS_E2E_PYTHON) return process.env.ATLAS_E2E_PYTHON;
  const local = `${root}/.venv-e2e/bin/python`;
  if (existsSync(local)) return local;
  // For git worktrees: find the common git dir and derive the main repo root.
  try {
    const commonDir = execSync('git rev-parse --git-common-dir', { cwd: root }).toString().trim();
    // commonDir is like /main/repo/.git or .git; resolve to absolute path.
    const absCommon = commonDir.startsWith('/') ? commonDir : `${root}/${commonDir}`;
    // The main repo root is one level above .git
    const mainRoot = absCommon.replace(/\/\.git$/, '');
    const mainVenv = `${mainRoot}/.venv-e2e/bin/python`;
    if (existsSync(mainVenv)) return mainVenv;
  } catch {}
  return local; // let launch.sh fail with a clear message
}
const pythonBin = resolveVenv();
console.log(`Using Python: ${pythonBin}`);

const out = process.env.E2E_OUT ?? '/tmp/positron-atlas-e2e';
const timeoutMs = Number(process.env.E2E_TIMEOUT ?? 300_000);
const cdpPort = Number(process.env.CDP_PORT ?? 9334);
const themeDir = `${root}/test/harness/themes`;
mkdirSync(themeDir, { recursive: true });
mkdirSync(out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dumpTheme(theme) {
  console.log(`\n=== dump-theme: ${theme.name} (${theme.id}) ===`);
  const log = `${out}/scenario.log`;
  const env = {
    ...process.env,
    ATLAS_E2E_PYTHON: pythonBin,
    ATLAS_E2E_SCENARIO: `${root}/test/e2e/scenario-small.json`,
    ATLAS_E2E_COLOR_THEME: theme.name,
    E2E_DIR: out,
    CDP_PORT: String(cdpPort),
  };

  // Kill any leftover instance using the same e2e dir
  spawnSync('pkill', ['-9', '-f', out], { stdio: 'ignore' });
  await sleep(1500);

  const { rmSync } = await import('node:fs');
  rmSync(log, { force: true });

  const proc = spawn(`${root}/test/e2e/launch.sh`, [], { env, stdio: 'ignore', detached: true });
  const kill = () => {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
    spawnSync('pkill', ['-9', '-f', out], { stdio: 'ignore' });
  };

  const t0 = Date.now();
  let vars = null;
  try {
    // Wait for Positron helper to write READY or ERROR to the log
    console.log('  waiting for Positron ready…');
    while (!(existsSync(log) && /READY|ERROR/.test(readFileSync(log, 'utf8')))) {
      if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for scenario');
      await sleep(500);
    }
    const text = readFileSync(log, 'utf8');
    if (text.includes('ERROR')) throw new Error(`scenario failed: ${text.trim()}`);

    // Connect to CDP
    let cdp;
    for (let i = 0; i < 90 && !cdp; i++) {
      cdp = await connect(cdpPort).catch(() => undefined);
      if (!cdp) await sleep(1000);
    }
    if (!cdp) throw new Error('CDP connection failed');

    // Find Atlas webview context
    let ctx;
    for (let i = 0; i < 90 && !ctx; i++) {
      ctx = await cdp.atlasContext();
      if (!ctx) await sleep(1000);
      if (Date.now() - t0 > timeoutMs) throw new Error('Atlas webview not found');
    }
    if (!ctx) throw new Error('Atlas webview not found');

    // Wait for Atlas ready phase
    console.log('  waiting for Atlas ready…');
    for (;;) {
      const phase = await cdp.evaluate('window.__atlas && window.__atlas.phase', ctx).catch(() => null);
      if (phase === 'ready') break;
      if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for atlas ready');
      await sleep(500);
    }

    // Dump all --vscode-* computed properties
    console.log('  dumping CSS variables…');
    await cdp.evaluate(
      `(function() {
        var cs = getComputedStyle(document.documentElement);
        var cv = {};
        for (var i = 0; i < cs.length; i++) {
          var n = cs[i];
          if (n.startsWith('--vscode-')) cv[n] = cs.getPropertyValue(n).trim();
        }
        window.__dumpVars = cv;
        window.__dumpDone = true;
      })()`,
      ctx,
    );

    for (let i = 0; i < 20; i++) {
      const done = await cdp.evaluate('window.__dumpDone === true', ctx).catch(() => false);
      if (done) break;
      await sleep(300);
    }

    // Retrieve as sorted JSON
    const sortedJson = await cdp.evaluate(
      `JSON.stringify(Object.fromEntries(Object.entries(window.__dumpVars).sort((a,b) => a[0].localeCompare(b[0]))))`,
      ctx,
      undefined,
    ).catch(() => null);

    if (!sortedJson) throw new Error('failed to retrieve CSS vars from webview');
    vars = JSON.parse(sortedJson);

    const keys = Object.keys(vars);
    const positronKeys = keys.filter((k) => k.startsWith('--vscode-positron'));
    console.log(`  total --vscode-* vars:    ${keys.length}`);
    console.log(`  --vscode-positron* vars:  ${positronKeys.length}`);

    // Build output with _source metadata key
    const today = new Date().toISOString().slice(0, 10);
    const output = {
      _source: `dumped from Positron ${positronVersion} on ${today}`,
      ...vars,
    };

    const outPath = `${themeDir}/${theme.id}.json`;
    writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
    console.log(`  saved: ${outPath}`);

    cdp.close();
    return { theme: theme.id, total: keys.length, positronCount: positronKeys.length };
  } finally {
    if (!keep) kill();
    await sleep(2000);
  }
}

const results = [];
for (const theme of themes) {
  try {
    const r = await dumpTheme(theme);
    results.push(r);
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
    results.push({ theme: theme.id, error: e.message });
  }
}

console.log('\n=== dump-theme summary ===');
for (const r of results) {
  if (r.error) {
    console.log(`  ${r.theme}: ERROR — ${r.error}`);
  } else {
    console.log(`  ${r.theme}: ${r.total} total vars, ${r.positronCount} --vscode-positron* vars`);
  }
}
const failed = results.filter((r) => r.error);
process.exit(failed.length > 0 ? 1 : 0);
