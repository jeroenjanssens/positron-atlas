// Stand-in for the extension host (src/extension/atlasPanel.ts) in the browser harness.
// Implements acquireVsCodeApi() and answers the webview's messages by calling the real kernel
// helper through test/harness/server.py. Keep the message handling in step with AtlasPanel.
//
// Differences from Positron, on purpose:
// - Modal confirmations are accepted automatically (and recorded in window.__harness.log).
// - Save dialogs are skipped: PNG exports are kept in window.__harness.png.
// - The clipboard is window.__harness.clipboard.

(() => {
  const harness = { log: [], clipboard: '', png: '', state: undefined, posted: [] };
  window.__harness = harness;
  const params = new URLSearchParams(location.search);
  let info;
  let jobId;
  let jobDir;
  let fileVersion = 0;
  let generation = 0;
  let projectionCurrent = false;

  const post = (msg) => window.postMessage(msg, '*');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function call(fn, ...args) {
    const res = await fetch('/call', { method: 'POST', body: JSON.stringify({ fn, args }) });
    const parsed = await res.json();
    if (parsed && parsed.ok === false) {
      const err = new Error(parsed.error || `Kernel call ${fn} failed`);
      err.detail = parsed.traceback;
      throw err;
    }
    return parsed;
  }

  async function writeJobFile(name, bytes) {
    const res = await fetch(`/write?name=${encodeURIComponent(`${jobDir}/${name}`)}`, { method: 'POST', body: bytes });
    return (await res.json()).path;
  }

  const rmJobFile = (name) => fetch(`/rm?name=${encodeURIComponent(`${jobDir}/${name}`)}`, { method: 'POST' });

  function fileRef(out) {
    return { uri: `/job/${jobDir}/${out.file}?v=${++fileVersion}`, dtype: out.dtype, shape: out.shape, offset: out.offset };
  }

  function base64ToBytes(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function fail(e, fatal = false) {
    let message = e instanceof Error ? e.message : String(e);
    if (/Unknown job/.test(message)) {
      message = 'The Python session restarted. Reload to load the data again.';
      fatal = true;
      jobId = undefined;
    }
    harness.log.push(`error: ${message}`);
    post({ type: 'error', message, detail: e && e.detail, fatal });
  }

  function confirmModal(text) {
    harness.log.push(`confirm: ${text}`);
    return true;
  }

  // Mirrors KernelBridge.waitForJob; a newer task (generation) supersedes the wait.
  async function waitForJob(id, onStatus, gen) {
    let delay = 50;
    for (;;) {
      if (gen !== generation) return { stage: 'superseded', outputs: [], result: {} };
      const s = await call('status', id);
      if (gen !== generation) continue;
      onStatus(s);
      if (s.stage === 'done' || s.stage === 'error' || s.stage === 'cancelled') return s;
      await sleep(delay);
      delay = Math.min(500, delay * 1.5);
    }
  }

  async function runXYTask(task, start, exact) {
    const gen = ++generation;
    projectionCurrent = false;
    await start();
    const seen = new Set();
    const s = await waitForJob(
      jobId,
      (st) => {
        post({ type: 'status', task, status: st });
        for (const o of st.outputs) {
          if (o.kind === 'xy' && !seen.has(o.file)) {
            seen.add(o.file);
            post({ type: 'xyChunk', file: fileRef(o), total: (st.result && st.result.nRows) || 0 });
          }
        }
      },
      gen,
    );
    if (s.stage === 'done') {
      projectionCurrent = true;
      post({ type: 'projected', seconds: (s.result && s.result.seconds) || 0, exact, backend: s.result && s.result.backend });
    } else if (s.stage === 'error') {
      const err = new Error(s.error || `${task} failed`);
      err.detail = s.result && s.result.traceback;
      throw err;
    }
  }

  function settings() {
    const s = info.settings || {};
    return {
      maxAnchors: s.maxAnchors ?? 100000,
      maxAnchorsCpu: s.maxAnchorsCpu ?? 25000,
      useWebGpu: s.useWebGpu ?? true,
      anchorBudget: s.anchorBudget ?? 10000000,
      defaultSamplePct: s.defaultSamplePct ?? 100,
      pcaEnabled: s.pcaEnabled ?? false,
      pcaDims: s.pcaDims ?? 50,
      nativeCore: s.nativeCore ?? true,
    };
  }

  async function init() {
    info = await (await fetch('/info')).json();
    const variable = params.get('variable') || info.variable;
    const describe = await call('describe', variable);
    jobDir = `job-${Date.now()}`;
    const job = await call('create_job', variable, `${info.jobRoot}/${jobDir}`);
    jobId = job.jobId;
    post({ type: 'init', variable, sessionId: 'harness', describe, settings: settings(), state: harness.state });
  }

  async function onMessage(m) {
    harness.posted.push(m.type);
    switch (m.type) {
      case 'ready':
        await init();
        break;
      case 'reload':
        if (jobId) {
          await call('cleanup', jobId).catch(() => undefined);
          jobId = undefined;
        }
        await init();
        break;
      case 'prepare': {
        const gen = ++generation;
        projectionCurrent = false;
        await call('prepare', jobId, JSON.stringify({ ...m.options, native: settings().nativeCore }));
        const s = await waitForJob(jobId, (st) => post({ type: 'status', task: 'prepare', status: st }), gen);
        if (s.stage === 'done') {
          const anchors = s.outputs.find((o) => o.kind === 'anchors');
          const anchorPos = s.outputs.find((o) => o.kind === 'anchorPos');
          post({ type: 'prepared', result: s.result, anchors: fileRef(anchors), anchorPos: fileRef(anchorPos) });
        } else if (s.stage === 'error') {
          const err = new Error(s.error || 'Preparing the data failed');
          err.detail = s.result && s.result.traceback;
          throw err;
        }
        break;
      }
      case 'estimate': {
        const r = await call('estimate_projection', jobId, settings().nativeCore);
        // Same formulas as estimateSeconds in atlasPanel.ts.
        const seconds = r.backend === 'rust' ? 1.2e-6 * r.rows + 6e-12 * r.flops : 1.2e-5 * r.rows + 2.2e-11 * r.flops;
        post({ type: 'estimate', seconds, rows: r.rows });
        break;
      }
      case 'project': {
        const name = `anchor_xy_${Date.now()}.f32`;
        const xyPath = await writeJobFile(name, base64ToBytes(m.anchorXY));
        try {
          await runXYTask('project', () => call('project', jobId, xyPath, JSON.stringify({ metric: m.metric, seed: m.seed, native: settings().nativeCore })), false);
        } finally {
          await rmJobFile(name);
        }
        break;
      }
      case 'exact':
        await runXYTask('exact', () => call('exact_umap', jobId, JSON.stringify({ ...m.params, engine: m.engine })), true);
        break;
      case 'colors': {
        const r = await call('colors', jobId, m.column, !!m.forceCategorical);
        post({ type: 'colors', column: m.column, file: fileRef({ file: r.file, dtype: r.dtype, shape: [r.length] }), meta: r.meta, length: r.length });
        break;
      }
      case 'labelCodes': {
        const r = await call('colors', jobId, m.column, true, m.maxCategories);
        post({ type: 'labelCodes', column: m.column, file: fileRef({ file: r.file, dtype: r.dtype, shape: [r.length] }), meta: r.meta, length: r.length, purpose: m.purpose });
        break;
      }
      case 'writeLabels': {
        if (!confirmModal(`${m.description} in column ${m.column}`)) return;
        const name = `labels_${Date.now()}.u16`;
        const codesPath = await writeJobFile(name, base64ToBytes(m.codes));
        try {
          const r = await call('write_labels', jobId, codesPath, m.names, m.column, m.keepOthers);
          const describe = await call('describe', r.variable);
          harness.log.push(`info: Wrote ${r.rows} labels to ${r.variable}.${r.column}.`);
          post({ type: 'labelsWritten', variable: r.variable, column: r.column, rows: r.rows, describe });
        } finally {
          await rmJobFile(name);
        }
        break;
      }
      case 'describeGroups': {
        const name = `groups_${Date.now()}.u16`;
        const codesPath = await writeJobFile(name, base64ToBytes(m.codes));
        try {
          const r = await call('describe_groups', jobId, codesPath, m.k, m.columns);
          post({ type: 'groupNames', seq: m.seq, names: r.names });
        } finally {
          await rmJobFile(name);
        }
        break;
      }
      case 'compareSelection':
      case 'selectionFrame': {
        const name = `selection_${Date.now()}.bits`;
        const maskPath = await writeJobFile(name, base64ToBytes(m.mask));
        try {
          if (m.type === 'compareSelection') {
            const result = await call('compare_selection', jobId, maskPath);
            post({ type: 'comparison', seq: m.seq, result });
          } else {
            const r = await call('selection_frame', jobId, maskPath);
            harness.log.push(`info: Created ${r.variable} with ${r.rows} selected rows.`);
            post({ type: 'selectionFrame', variable: r.variable, rows: r.rows });
          }
        } finally {
          await rmJobFile(name);
        }
        break;
      }
      case 'row': {
        const r = await call('row', jobId, m.i, m.imageColumns ?? null);
        post({ type: 'row', i: m.i, row: r.row, values: r.values, image: r.image });
        break;
      }
      case 'cancel':
        generation++;
        if (jobId) await call('cancel', jobId).catch(() => undefined);
        break;
      case 'addCoordinates': {
        if (!confirmModal('Add columns umap_x and umap_y')) return;
        let xyPath = '';
        let name = '';
        if (m.anchorXY && !m.useProjection) {
          name = `coords_${Date.now()}.f32`;
          xyPath = await writeJobFile(name, base64ToBytes(m.anchorXY));
        } else if (!projectionCurrent) {
          throw new Error('Place all rows first, then add the coordinates.');
        }
        const r = await call('add_coordinates', jobId, xyPath);
        if (name) await rmJobFile(name);
        post({ type: 'coordsAdded', variable: r.variable, columns: r.columns });
        break;
      }
      case 'savePng':
        harness.png = m.dataUrl;
        break;
      case 'copyText':
        harness.clipboard = m.text;
        break;
      case 'state':
        harness.state = m.state;
        break;
      case 'log':
        harness.log.push(`${m.level}: ${m.message}`);
        break;
      // --- Font plumbing (D11) ---
      case 'fontRequest': {
        // The harness serves bundled fonts from /media/fonts/. For Google Fonts,
        // skip the actual download and reply with an error so callers fall back gracefully.
        const { seq, family, scripts = ['latin'] } = m;
        const css = await harnessFontCss(family, scripts);
        if (css !== null) {
          post({ type: 'fontReady', seq, family, css });
        } else {
          post({ type: 'fontError', seq, family, message: `Font "${family}" is not bundled; Google Fonts downloads are skipped in the harness.` });
        }
        break;
      }
      case 'fontCatalog': {
        const families = harnessFontCatalog();
        post({ type: 'fontCatalog', families });
        break;
      }
    }
  }

  // ---- Harness font helpers ----

  // Bundled font table mirroring src/extension/fonts.ts BUNDLED array.
  const HARNESS_BUNDLED = [
    { family: 'Cinzel',              category: 'Display',    weights: '400-900', files: { latin: 'Cinzel.woff2', 'latin-ext': 'Cinzel-LatinExt.woff2' } },
    { family: 'Playfair Display SC', category: 'Serif',      weights: [400,700,900], files: { latin: ['PlayfairDisplaySC-400.woff2','PlayfairDisplaySC-700.woff2','PlayfairDisplaySC-900.woff2'], 'latin-ext': ['PlayfairDisplaySC-400-LatinExt.woff2','PlayfairDisplaySC-700-LatinExt.woff2','PlayfairDisplaySC-900-LatinExt.woff2'] } },
    { family: 'Marcellus SC',        category: 'Serif',      weights: [400], files: { latin: 'MarcellusSC.woff2', 'latin-ext': 'MarcellusSC-LatinExt.woff2' } },
    { family: 'Montserrat',          category: 'Sans Serif', weights: '100-900', files: { latin: 'Montserrat.woff2', 'latin-ext': 'Montserrat-LatinExt.woff2' } },
    { family: 'Roboto',              category: 'Sans Serif', weights: '100-900', files: { latin: 'Roboto.woff2', 'latin-ext': 'Roboto-LatinExt.woff2' } },
    { family: 'Roboto Condensed',    category: 'Sans Serif', weights: '100-900', files: { latin: 'RobotoCondensed.woff2', 'latin-ext': 'RobotoCondensed-LatinExt.woff2' } },
    { family: 'Inter',               category: 'Sans Serif', weights: '100-900', files: { latin: 'Inter.woff2', 'latin-ext': 'Inter-LatinExt.woff2' } },
    { family: 'JetBrains Mono',      category: 'Monospace',  weights: '100-800', files: { latin: 'JetBrainsMono.woff2', 'latin-ext': 'JetBrainsMono-LatinExt.woff2' } },
  ];

  async function harnessFontCss(family, scripts) {
    const bundled = HARNESS_BUNDLED.find((b) => b.family.toLowerCase() === family.toLowerCase());
    if (!bundled) return null; // not bundled; harness doesn't download Google Fonts

    const wanted = new Set(scripts.length > 0 ? scripts : ['latin']);
    const blocks = [];

    for (const subset of ['latin', 'latin-ext']) {
      if (!wanted.has(subset)) continue;
      const fileOrFiles = bundled.files[subset];
      if (!fileOrFiles) continue;

      const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
      const weights = Array.isArray(bundled.weights) ? bundled.weights : [bundled.weights];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const weight = Array.isArray(bundled.weights) ? bundled.weights[i] : bundled.weights;
        const url = `/media/fonts/${file}`;
        blocks.push(
          `@font-face {\n  font-family: '${bundled.family}';\n  font-style: normal;\n  font-weight: ${weight};\n  font-display: swap;\n  src: url('${url}') format('woff2');\n}`,
        );
      }
    }

    return blocks.join('\n\n');
  }

  function harnessFontCatalog() {
    return HARNESS_BUNDLED.map((b) => ({
      family: b.family,
      category: b.category,
      weights: b.weights,
      source: 'bundled',
    }));
  }

  // Like webview.onDidReceiveMessage: each message starts its handler right away.
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => {
      onMessage(m).catch((e) => fail(e));
    },
    getState: () => harness.state,
    setState: (s) => {
      harness.state = s;
    },
  });
})();
