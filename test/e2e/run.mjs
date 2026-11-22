// End-to-end check in a real Positron:
//   node test/e2e/run.mjs [scenario.json] [--keep]
// Launches an isolated Positron (test/e2e/launch.sh), lets the helper extension start Python,
// create a DataFrame and open Atlas, then waits for the layout and takes screenshots.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { connect } from './cdp.mjs';
import { parsePngToRgba, drawnPixels } from '../png.mjs';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const scenario = args.find((a) => a.endsWith('.json'));
const out = process.env.E2E_OUT ?? '/tmp/positron-atlas-e2e';
const log = `${out}/scenario.log`;
const timeoutMs = Number(process.env.E2E_TIMEOUT ?? 240_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = { ...process.env };
if (scenario) env.ATLAS_E2E_SCENARIO = new URL(scenario, `file://${process.cwd()}/`).pathname;
// A leftover instance on the same profile hijacks the launch (single-instance lock); kill it.
spawnSync('pkill', ['-9', '-f', out]);
await sleep(1000);
rmSync(log, { force: true });
const proc = spawn('test/e2e/launch.sh', [], { env, stdio: 'ignore', detached: true });
const kill = () => {
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {}
  spawnSync('pkill', ['-9', '-f', out]);
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
  console.log(`screenshot: ${out}/atlas.png`);
  // Optional scripted steps: { name, eval, until, timeout, screenshot }
  const steps = scenario ? JSON.parse(readFileSync(env.ATLAS_E2E_SCENARIO, 'utf8')).steps ?? [] : [];
  for (const step of steps) {
    const ts = Date.now();
    if (step.eval) await cdp.evaluate(`(async () => { const a = window.__atlas; ${step.eval} })()`, ctx);
    // clickMap: a real mouse click in the middle of the Atlas map (page coordinates of the
    // webview's canvas), so the webview gets keyboard focus the way a user gives it.
    if (step.clickMap) {
      // A covered window gets no requestAnimationFrame (Chromium occlusion); bring it forward.
      await cdp.send('Page.bringToFront').catch(() => undefined);
      const r = JSON.parse(await cdp.evaluate(
        `(() => { const f = [...document.querySelectorAll('iframe')].find((e) => e.getBoundingClientRect().width > 300); const b = f.getBoundingClientRect(); return JSON.stringify({ x: b.left + b.width * 0.6, y: b.top + b.height * 0.5 }); })()`,
      ));
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
      }
      await sleep(500);
    }
    // key: a real key press sent to the workbench (VS Code's keybinding service sees it),
    // e.g. { "key": "?", "code": "Slash", "modifiers": 8 } (8 = Shift).
    if (step.key) {
      const k = { key: step.key, code: step.code ?? '', modifiers: step.modifiers ?? 0 };
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k, text: step.key.length === 1 ? step.key : undefined });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
      await sleep(300);
    }
    if (step.until) {
      for (;;) {
        const v = await cdp.evaluate(`(() => { const a = window.__atlas; return !!(${step.until}); })()`, ctx);
        if (v) break;
        const err = await cdp.evaluate('window.__atlas.error && window.__atlas.error.message', ctx);
        if (err) throw new Error(`step ${step.name}: webview error: ${err}`);
        if (Date.now() - ts > (step.timeout ?? 60000)) throw new Error(`step ${step.name} timed out`);
        await sleep(250);
      }
    }
    if (step.report) console.log(`  ${step.name}: ${await cdp.evaluate(`(() => { const a = window.__atlas; return JSON.stringify(${step.report}); })()`, ctx)}`);
    if (step.checkFile) {
      while (!existsSync(step.checkFile)) {
        if (Date.now() - ts > (step.timeout ?? 30000)) throw new Error(`step ${step.name}: file not found: ${step.checkFile}`);
        await sleep(300);
      }
      await sleep(300); // let the writer finish
      const sz = statSync(step.checkFile).size;
      if (sz === 0) throw new Error(`step ${step.name}: file is empty: ${step.checkFile}`);
      console.log(`  ${step.name}: ${step.checkFile} (${sz} bytes)`);
      if (step.minDrawnPixels) {
        const n = drawnPixels(parsePngToRgba(readFileSync(step.checkFile)));
        console.log(`  ${step.name}: ${n} drawn pixels`);
        if (n < step.minDrawnPixels) throw new Error(`step ${step.name}: only ${n} drawn pixels (want ${step.minDrawnPixels})`);
      }
    }
    // checkNewestFile: { dir, ext, headerHex, minBytes } waits for a file with that
    // extension in dir and checks its first bytes (e.g. "1a45dfa3" for WebM).
    if (step.checkNewestFile) {
      const { dir, ext, headerHex = '', minBytes = 1 } = step.checkNewestFile;
      let file;
      for (;;) {
        const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)) : [];
        if (files.length) { file = `${dir}/${files.sort().at(-1)}`; break; }
        if (Date.now() - ts > (step.timeout ?? 30000)) throw new Error(`step ${step.name}: no ${ext} file in ${dir}`);
        await sleep(300);
      }
      await sleep(300);
      const buf = readFileSync(file);
      const head = buf.subarray(0, headerHex.length / 2).toString('hex');
      console.log(`  ${step.name}: ${file} (${buf.length} bytes, header ${head})`);
      if (head !== headerHex.toLowerCase() || buf.length < minBytes) throw new Error(`step ${step.name}: unexpected file ${file}`);
    }
    if (step.waitFile) {
      while (!existsSync(step.waitFile)) {
        if (Date.now() - ts > (step.timeout ?? 30000)) throw new Error(`step ${step.name}: file never appeared: ${step.waitFile}`);
        await sleep(300);
      }
      console.log(`  ${step.name}: ${step.waitFile} (${statSync(step.waitFile).size} bytes)`);
    }
    if (step.writeFile) {
      const content = typeof step.writeContent === 'string' ? step.writeContent : JSON.stringify(step.writeContent);
      writeFileSync(step.writeFile, content);
      console.log(`  ${step.name}: wrote ${step.writeFile}`);
    }
    if (step.readFile) {
      const content = existsSync(step.readFile) ? readFileSync(step.readFile, 'utf8').trim() : '(not found)';
      console.log(`  ${step.name}: ${content}`);
      if (step.expect !== undefined && content !== String(step.expect)) throw new Error(`step ${step.name}: got ${content}, want ${step.expect}`);
    }
    if (step.sleepMs) await sleep(step.sleepMs);
    console.log(`step ok: ${step.name} (${((Date.now() - ts) / 1000).toFixed(1)}s)`);
    if (step.screenshot) {
      await sleep(800);
      await cdp.screenshot(`${out}/${step.screenshot}`);
      console.log(`screenshot: ${out}/${step.screenshot}`);
    }
  }
  if (cdp.logs.length) console.log(`webview console:\n${cdp.logs.join('\n')}`);
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
