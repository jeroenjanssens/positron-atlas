// Run a scenario in the browser harness and take screenshots:
//   node test/harness/shot.mjs SCENARIO.json [--theme light] [--keep] [--out DIR] [--size 1400x860]
// Starts test/harness/server.py (the real kernel helper), opens the built webview in Chromium,
// waits for the layout and runs the scenario's steps ({ name, eval, click, drag, modifiers, press,
// until, timeout, report, screenshot, assert }). `a` is the webview's Atlas object and `h` the harness host
// (window.__harness). Fails on webview errors, page errors and failed asserts.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const scenarioPath = argv.find((a) => a.endsWith('.json'));
if (!scenarioPath) {
  console.error('usage: node test/harness/shot.mjs SCENARIO.json [--theme light] [--out DIR]');
  process.exit(2);
}
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
const out = resolve(opt('out', process.env.HARNESS_OUT ?? '/tmp/positron-atlas-harness'));
const theme = opt('theme', scenario.theme ?? 'dark');
const [width, height] = opt('size', scenario.size ?? '1400x860').split('x').map(Number);
// Port 0 lets the operating system pick a free port (several runs can share a machine);
// the server prints the port it got.
let port = Number(opt('port', '0'));
const timeoutMs = Number(process.env.HARNESS_TIMEOUT ?? 300_000);
const scale = Number(opt('scale', '1'));
mkdirSync(out, { recursive: true });
if (!existsSync('dist/webview/main.js')) {
  console.error('Build first: npm run build');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const server = spawn('uv', ['run', '--project', 'python', 'python', 'test/harness/server.py', scenarioPath, '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stderr.on('data', (d) => (serverLog += d));
await new Promise((ok, bad) => {
  server.stdout.on('data', (d) => {
    const m = /listening on http:\/\/127\.0\.0\.1:(\d+)\//.exec(String(d));
    if (m) {
      port = Number(m[1]);
      ok();
    }
  });
  server.on('exit', (code) => bad(new Error(`server exited (${code}):\n${serverLog}`)));
  setTimeout(() => bad(new Error(`server did not start:\n${serverLog}`)), 180_000);
});
console.log(`[${elapsed()}] server ready on port ${port}`);

const executablePath = process.env.CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({ executablePath, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
const pageErrors = [];
const consoleLines = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));

let ok = false;
try {
  await page.goto(`http://127.0.0.1:${port}/?theme=${theme}`);
  const evalIn = (code) => page.evaluate(`(async () => { const a = window.__atlas; const h = window.__harness; ${code} })()`);
  const check = async (code) => page.evaluate(`(() => { const a = window.__atlas; const h = window.__harness; return !!(${code}); })()`);
  const failIfError = async (where) => {
    const err = await page.evaluate('window.__atlas && window.__atlas.error && JSON.stringify(window.__atlas.error)');
    if (err) throw new Error(`${where}: webview error: ${err}`);
    if (pageErrors.length) throw new Error(`${where}: page error: ${pageErrors.join('\n')}`);
  };

  // Wait for the first layout (and all rows placed, and colors) unless the scenario says otherwise.
  const settled = scenario.settled ?? "a.phase === 'ready' && (!a.prepared.needsProjection || a.projection === 'done') && (a.colorColumn === null || a.colorMeta)";
  let last = '';
  for (;;) {
    const s = await page.evaluate(
      `(() => { const a = window.__atlas; if (!a) return '{}'; return JSON.stringify({ phase: a.phase, projection: a.projection, umap: a.umapProgress && a.umapProgress.stage }); })()`,
    );
    if (s !== last) {
      console.log(`[${elapsed()}] ${s}`);
      last = s;
    }
    await failIfError('startup');
    if (await check(`a && a.prepared && ${settled}`)) break;
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for the layout');
    await sleep(250);
  }
  await sleep(600);
  if (scenario.screenshot !== false) {
    await page.screenshot({ path: `${out}/${scenario.screenshot ?? 'atlas.png'}` });
    console.log(`screenshot: ${out}/${scenario.screenshot ?? 'atlas.png'}`);
  }

  for (const step of scenario.steps ?? []) {
    const ts = Date.now();
    if (step.eval) await evalIn(step.eval);
    if (step.click) await page.click(step.click);
    if (step.drag) {
      // A real mouse drag through page coordinates [[x, y], ...] computed in the page.
      const pts = await page.evaluate(`(() => { const a = window.__atlas; const h = window.__harness; return (${step.drag}); })()`);
      for (const k of step.modifiers ?? []) await page.keyboard.down(k);
      await page.mouse.move(pts[0][0], pts[0][1]);
      await page.mouse.down();
      for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y, { steps: 4 });
      await page.mouse.up();
      for (const k of step.modifiers ?? []) await page.keyboard.up(k);
    }
    if (step.press) await page.keyboard.press(step.press);
    if (step.until) {
      while (!(await check(step.until))) {
        await failIfError(`step ${step.name}`);
        if (Date.now() - ts > (step.timeout ?? 60_000)) throw new Error(`step ${step.name} timed out waiting for: ${step.until}`);
        await sleep(200);
      }
    }
    await failIfError(`step ${step.name}`);
    if (step.report) {
      const r = await page.evaluate(`(() => { const a = window.__atlas; const h = window.__harness; return JSON.stringify(${step.report}); })()`);
      console.log(`  ${step.name}: ${r}`);
    }
    if (step.assert) {
      for (const expr of [].concat(step.assert)) {
        if (!(await check(expr))) throw new Error(`step ${step.name}: assertion failed: ${expr}`);
      }
    }
    console.log(`[${elapsed()}] step ok: ${step.name} (${((Date.now() - ts) / 1000).toFixed(1)}s)`);
    if (step.screenshot) {
      await sleep(step.settle ?? 600);
      await page.screenshot({ path: `${out}/${step.screenshot}` });
      console.log(`screenshot: ${out}/${step.screenshot}`);
    }

    // openPage: open the exported HTML in a new Chromium page and run sub-steps there.
    // step.openPage is a JS expr evaluated in the main page that returns a URL path.
    if (step.openPage) {
      const urlPath = await page.evaluate(`(() => { const a = window.__atlas; const h = window.__harness; return (${step.openPage}); })()`);
      const viewerUrl = `http://127.0.0.1:${port}${urlPath}`;
      const vPage = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
      const vErrors = [];
      const vConsole = [];
      vPage.on('pageerror', (e) => vErrors.push(String(e)));
      vPage.on('console', (m) => vConsole.push(`${m.type()}: ${m.text()}`));
      try {
        const loadTs = Date.now();
        await vPage.goto(viewerUrl);
        // Wait for __viewer to be set (viewer onMount) with timeout
        const viewerTimeout = step.openPageTimeout ?? 20_000;
        while (!(await vPage.evaluate('!!(window.__viewer && window.__viewer.nPoints > 0)').catch(() => false))) {
          if (vErrors.length) throw new Error(`viewer page error: ${vErrors.join('\n')}`);
          if (Date.now() - loadTs > viewerTimeout) throw new Error('viewer page load timeout');
          await sleep(200);
        }
        const loadMs = Date.now() - loadTs;
        console.log(`  viewer loaded in ${loadMs}ms`);
        await sleep(step.settle ?? 800); // let deck.gl render
        // Run sub-steps in the viewer page
        const vEvalIn = (code) => vPage.evaluate(`(async () => { const v = window.__viewer; ${code} })()`);
        const vCheck = (code) => vPage.evaluate(`(() => { const v = window.__viewer; return !!(${code}); })()`);
        for (const ss of step.openPageSteps ?? []) {
          const sts = Date.now();
          if (ss.eval) await vEvalIn(ss.eval);
          if (ss.click) await vPage.click(ss.click);
          if (ss.fill) {
            const [sel, val] = ss.fill;
            await vPage.fill(sel, val);
          }
          if (ss.press) await vPage.keyboard.press(ss.press);
          if (ss.mousemove) {
            const [mx, my] = typeof ss.mousemove === 'string'
              ? await vPage.evaluate(ss.mousemove)
              : ss.mousemove;
            await vPage.mouse.move(mx, my);
          }
          if (ss.until) {
            while (!(await vCheck(ss.until).catch(() => false))) {
              if (vErrors.length) throw new Error(`viewer sub-step ${ss.name}: page error: ${vErrors.join('\n')}`);
              if (Date.now() - sts > (ss.timeout ?? 10_000)) throw new Error(`viewer sub-step ${ss.name} timed out`);
              await sleep(100);
            }
          }
          if (ss.assert) {
            for (const expr of [].concat(ss.assert)) {
              if (!(await vCheck(expr).catch(() => false))) throw new Error(`viewer sub-step ${ss.name}: assertion failed: ${expr}`);
            }
          }
          if (ss.report) {
            const r = await vPage.evaluate(`(() => { const v = window.__viewer; return JSON.stringify(${ss.report}); })()`);
            console.log(`    viewer ${ss.name}: ${r}`);
          }
          console.log(`[${elapsed()}] viewer step ok: ${ss.name} (${((Date.now() - sts) / 1000).toFixed(1)}s)`);
          if (ss.screenshot) {
            await sleep(ss.settle ?? 400);
            await vPage.screenshot({ path: `${out}/${ss.screenshot}` });
            console.log(`screenshot: ${out}/${ss.screenshot}`);
          }
        }
        if (step.openPageScreenshot) {
          await sleep(step.settle ?? 400);
          await vPage.screenshot({ path: `${out}/${step.openPageScreenshot}` });
          console.log(`screenshot: ${out}/${step.openPageScreenshot}`);
        }
        if (vErrors.length) throw new Error(`viewer page errors: ${vErrors.join('\n')}`);
        console.log(`  viewer console (${vConsole.length} lines):`);
        vConsole.slice(0, 5).forEach((l) => console.log(`    ${l}`));
      } finally {
        await vPage.close();
      }
    }
  }
  ok = true;
} catch (e) {
  console.error(String(e));
  await page.screenshot({ path: `${out}/failure.png` }).catch(() => undefined);
  console.error(`screenshot: ${out}/failure.png`);
  const log = await page.evaluate('window.__harness && window.__harness.log').catch(() => null);
  if (log?.length) console.error(`host log:\n${log.join('\n')}`);
  if (consoleLines.length) console.error(`console:\n${consoleLines.slice(-30).join('\n')}`);
  if (serverLog) console.error(`server stderr:\n${serverLog.slice(-3000)}`);
} finally {
  await browser.close();
  server.kill();
}
process.exit(ok ? 0 : 1);
