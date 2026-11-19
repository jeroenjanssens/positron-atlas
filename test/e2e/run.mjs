// End-to-end check in a real Positron:
//   node test/e2e/run.mjs [scenario.json] [--keep]
// Launches an isolated Positron (test/e2e/launch.sh), lets the helper extension start Python,
// create a DataFrame and open Atlas, then waits for the layout and takes screenshots.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { connect } from './cdp.mjs';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const scenario = args.find((a) => a.endsWith('.json'));
const out = process.env.E2E_OUT ?? '/tmp/positron-atlas-e2e';
const log = `${out}/scenario.log`;
const timeoutMs = Number(process.env.E2E_TIMEOUT ?? 240_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = { ...process.env };
if (scenario) env.ATLAS_E2E_SCENARIO = new URL(scenario, `file://${process.cwd()}/`).pathname;
rmSync(log, { force: true });
const proc = spawn('test/e2e/launch.sh', [], { env, stdio: 'ignore', detached: true });
const kill = () => {
  try {
    process.kill(-proc.pid, 'SIGTERM');
  } catch {}
};

const t0 = Date.now();
let ok = false;
try {
  while (!(existsSync(log) && /READY|ERROR/.test(readFileSync(log, 'utf8')))) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for scenario');
    await sleep(500);
  }
  const text = readFileSync(log, 'utf8');
  process.stdout.write(text);
  if (text.includes('ERROR')) throw new Error('scenario failed');
  let cdp;
  while (!cdp) {
    cdp = await connect().catch(() => undefined);
    if (!cdp) await sleep(500);
  }
  let ctx;
  while (!(ctx = await cdp.atlasContext())) {
    if (Date.now() - t0 > timeoutMs) {
      console.error(cdp.logs.join('\n'));
      console.error([...cdp.contexts.values()].map((c) => c.origin).join('\n'));
      throw new Error('Atlas webview not found');
    }
    await sleep(500);
  }
  let last = '';
  for (;;) {
    const s = await cdp.evaluate(
      `(() => { const a = window.__atlas; return JSON.stringify({ phase: a.phase, projection: a.projection, error: a.error, prepared: a.prepared, umap: a.umapProgress, status: a.kernelStatus, timings: a.timings, colorMeta: a.colorMeta && a.colorMeta.kind }); })()`,
      ctx,
    );
    if (s !== last) {
      console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
      last = s;
    }
    const st = JSON.parse(s);
    if (st.error) {
      console.error(cdp.logs.join('\n'));
      throw new Error(`webview error: ${st.error.message}`);
    }
    const settled = st.phase === 'ready' && (!st.prepared?.needsProjection || st.projection === 'done' || process.env.E2E_NO_PROJECT);
    if (settled && (st.colorMeta || process.env.E2E_NO_COLOR)) break;
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for layout');
    await sleep(500);
  }
  await sleep(1000);
  await cdp.screenshot(`${out}/atlas.png`);
  if (cdp.logs.length) console.log(`webview console:\n${cdp.logs.join('\n')}`);
  console.log(`screenshot: ${out}/atlas.png`);
  cdp.close();
  ok = true;
} catch (e) {
  console.error(String(e));
  try {
    const cdp = await connect();
    await cdp.screenshot(`${out}/failure.png`);
    console.error(`screenshot: ${out}/failure.png`);
    cdp.close();
  } catch {}
} finally {
  if (!keep) kill();
}
process.exit(ok ? 0 : 1);
