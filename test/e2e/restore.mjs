// Checks that an Atlas tab is restored (with its settings) after a window reload.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from './cdp.mjs';

const out = '/tmp/positron-atlas-e2e';
const log = `${out}/scenario.log`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = JSON.parse(readFileSync('test/e2e/scenario-small.json', 'utf8'));
writeFileSync(`${out}-restore.json`, JSON.stringify({ ...base, reloadAfterMs: 20000 }));
spawnSync('pkill', ['-9', '-f', out]);
await sleep(1000);
rmSync(log, { force: true });
rmSync(`${log}.reloaded`, { force: true });
const proc = spawn('test/e2e/launch.sh', [], { env: { ...process.env, ATLAS_E2E_SCENARIO: `${out}-restore.json` }, stdio: 'ignore', detached: true });
let ok = false;
try {
  const t0 = Date.now();
  while (!(existsSync(log) && readFileSync(log, 'utf8').includes('after reload'))) {
    if (Date.now() - t0 > 180_000) throw new Error('no reload');
    await sleep(500);
  }
  // Before the reload the helper changes nothing; the webview persisted its state itself.
  let st;
  for (let i = 0; i < (process.argv.includes('--keep') ? 20 : 120) && !st; i++) {
    await sleep(1000);
    try {
      const cdp = await connect();
      await sleep(1500);
      const ctx = await cdp.atlasContext();
      if (ctx) {
        const s = JSON.parse(await cdp.evaluate('JSON.stringify({ phase: __atlas.phase, variable: __atlas.variable, n: __atlas.prepared && __atlas.prepared.nKept, color: __atlas.colorColumn })', ctx));
        if (s.phase === 'error' && readFileSync(log, 'utf8').includes('setup after reload done')) {
          // Restored before the data existed in the new session: Reload, like a user would.
          console.log('restored tab shows an error; clicking Reload');
          await cdp.evaluate('__atlas.reload()', ctx);
        }
        if (s.phase === 'ready') {
          st = s;
          await cdp.screenshot(`${out}/restored.png`);
        }
      }
      cdp.close();
    } catch {}
  }
  if (!st) throw new Error('restored Atlas tab never became ready');
  console.log('restored:', JSON.stringify(st));
  ok = st.variable === 'df' && st.n === 20000;
} catch (e) {
  console.error(String(e));
} finally {
  if (!process.argv.includes('--keep')) {
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {}
    spawnSync('pkill', ['-9', '-f', out]);
  }
}
process.exit(ok ? 0 : 1);
