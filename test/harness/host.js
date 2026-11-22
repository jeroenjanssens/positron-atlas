// Stand-in for the extension host (src/extension/atlasPanel.ts) in the browser harness.
// Implements acquireVsCodeApi() and answers the webview's messages by calling the real kernel
// helper through test/harness/server.py. Keep the message handling in step with AtlasPanel.
//
// Differences from Positron, on purpose:
// - Modal confirmations are accepted automatically (and recorded in window.__harness.log).
// - Save dialogs are skipped: PNG exports are kept in window.__harness.png.
// - The clipboard is window.__harness.clipboard.

(() => {
  const harness = { log: [], clipboard: '', png: '', state: undefined, posted: [], fullscreen: false,
    // C3: Python API comm simulation.
    commApiDir: '', commOnMsg: null, pendingCommCmds: new Map(), lastSelectionChanged: null };
  window.__harness = harness;
  const params = new URLSearchParams(location.search);
  let info;
  let jobId;
  let jobDir;
  let fileVersion = 0;
  let generation = 0;
  let projectionCurrent = false;
  let anchorXYPath = null; // B3: kept for overlay projection after base project

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
    // bytes may be a Uint8Array (binary path) or a base64 string (legacy fallback).
    const body = typeof bytes === 'string' ? base64ToBytes(bytes) : bytes;
    harness.log.push(`payload:${name}:${body instanceof Uint8Array ? 'binary' : 'base64'}:${body.byteLength ?? body.length}`);
    const res = await fetch(`/write?name=${encodeURIComponent(`${jobDir}/${name}`)}`, { method: 'POST', body });
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
      delay = Math.min(150, delay * 1.5);
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
      harness.lastProjectResult = s.result || {};  // exposes cached/waitedForNeighbours etc. to scenarios
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
      maxLazyRows: s.maxLazyRows ?? 10000000,
      neighborCacheMB: s.neighborCacheMB ?? 1024,
    };
  }

  async function init() {
    info = await (await fetch('/info')).json();
    const variable = params.get('variable') || info.variable;
    const describe = await call('describe', variable, JSON.stringify({ maxLazyRows: settings().maxLazyRows }));
    jobDir = `job-${Date.now()}`;
    const job = await call('create_job', variable, `${info.jobRoot}/${jobDir}`, JSON.stringify({ maxLazyRows: settings().maxLazyRows }));
    jobId = job.jobId;
    post({ type: 'init', variable, sessionId: 'harness', describe, settings: settings(), state: harness.state, platform: 'linux', userKeybindings: null, showHint: false });
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
        const cfg = settings();
        await call('prepare', jobId, JSON.stringify({ ...m.options, native: cfg.nativeCore, neighborCacheMB: cfg.neighborCacheMB }));
        const s = await waitForJob(
          jobId,
          (st) => {
            post({ type: 'status', task: 'prepare', status: st });
          },
          gen,
        );
        if (s.stage === 'done') {
          const anchors = s.outputs.find((o) => o.kind === 'anchors');
          const anchorPos = s.outputs.find((o) => o.kind === 'anchorPos');
          const result = s.result;
          post({ type: 'prepared', result, anchors: fileRef(anchors), anchorPos: fileRef(anchorPos) });
          // coords mode: stream xy outputs after 'prepared' so the webview has
          // allocated allXY first, then signal projection done.
          if (result && result.coordsMode) {
            for (const o of s.outputs) {
              if (o.kind === 'xy') {
                post({ type: 'xyChunk', file: fileRef(o), total: result.nKept || 0 });
              }
            }
            projectionCurrent = true;
            post({ type: 'projected', seconds: 0, exact: true });
          }
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
        const xyPath = await writeJobFile(name, m.anchorXY);
        // B3: keep the anchor XY path so overlay projection can reuse it.
        anchorXYPath = xyPath;
        // T2: pass dims so the kernel places into 2D or 3D output space.
        await runXYTask('project', () => call('project', jobId, xyPath, JSON.stringify({ metric: m.metric, seed: m.seed, native: settings().nativeCore, dims: m.dims ?? 2 })), false);
        break;
      }
      case 'exact':
        // T2: pass dims so the kernel uses n_components=3 for 3D UMAP.
        await runXYTask('exact', () => call('exact_umap', jobId, JSON.stringify({ ...m.params, engine: m.engine, dims: m.dims ?? 2 })), true);
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
      case 'sizes': {
        const r = await call('sizes', jobId, m.column);
        post({ type: 'sizes', column: m.column, file: fileRef({ file: r.file, dtype: r.dtype, shape: [r.length] }), meta: r.meta });
        break;
      }
      case 'histValues': {
        const r = await call('hist_values', jobId, m.column);
        post({ type: 'histValues', column: m.column, file: fileRef({ file: r.file, dtype: r.dtype, shape: [r.length] }) });
        break;
      }
      case 'histogram': {
        const r = await call('histogram', jobId, m.column, m.nBins ?? 50);
        post({ type: 'histogram', column: m.column, data: r.data });
        break;
      }
      case 'anchorUmap': {
        const gen = ++generation;
        // T2: pass dims so anchor UMAP uses n_components=3 for 3D.
        const r = await call('anchor_umap', jobId, JSON.stringify({ ...m.params, dims: m.dims ?? 2 }));
        if (gen !== generation) break;
        // Use r.shape if available (supports 3D [n, 3] shapes).
        const anchorShape = r.shape ?? [r.length];
        post({ type: 'anchorXY', file: fileRef({ file: r.file, dtype: r.dtype, shape: anchorShape }), seconds: r.seconds });
        break;
      }
      case 'writeLabels': {
        if (!confirmModal(`${m.description} in column ${m.column}`)) return;
        const name = `labels_${Date.now()}.u16`;
        const codesPath = await writeJobFile(name, m.codes);
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
        const codesPath = await writeJobFile(name, m.codes);
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
        const maskPath = await writeJobFile(name, m.mask);
        try {
          if (m.type === 'compareSelection') {
            const result = await call('compare_selection', jobId, maskPath);
            post({ type: 'comparison', seq: m.seq, result });
          } else {
            const r = await call('selection_frame', jobId, maskPath);
            harness.log.push(`info: Created ${r.variable} with ${r.rows} selected rows.`);
            // B3: also create overlay selection frames.
            const overlayFrames = [];
            if (m.overlayMasks?.length) {
              for (const om of m.overlayMasks) {
                const ovName = `ov_sel_${Date.now()}.bits`;
                const ovPath = await writeJobFile(ovName, om.mask);
                try {
                  const ovr = await call('overlay_selection_frame', jobId, om.layerId, ovPath).catch(() => null);
                  if (ovr?.ok) {
                    overlayFrames.push({ variable: ovr.variable, rows: ovr.rows });
                    harness.log.push(`info: Created overlay selection ${ovr.variable} with ${ovr.rows} rows.`);
                  }
                } finally {
                  await rmJobFile(ovName);
                }
              }
            }
            post({ type: 'selectionFrame', variable: r.variable, rows: r.rows, overlayFrames: overlayFrames.length ? overlayFrames : undefined });
            harness.log.push(`view: ${r.variable}`);
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
      case 'rows': {
        const r = await call('rows', jobId, m.indices, m.columns ?? null, m.imageColumns ?? null);
        const values = {};
        for (const [k, v] of Object.entries(r.values)) values[Number(k)] = v;
        if (r.images) {
          const images = {};
          for (const [k, v] of Object.entries(r.images)) images[Number(k)] = v;
          post({ type: 'rows', seq: m.seq, values, images });
        } else {
          post({ type: 'rows', seq: m.seq, values });
        }
        break;
      }
      case 'texts': {
        // Scenarios can delay the titles (h.delayTextsMs) to test cards opened before they arrive.
        if (harness.delayTextsMs) await sleep(harness.delayTextsMs);
        const r = await call('texts', jobId, m.column, m.maxChars);
        if (r.ok && r.utf8File && r.offsetsFile) {
          post({
            type: 'texts',
            column: m.column,
            uri: `/job/${jobDir}/${r.utf8File}?v=${++fileVersion}`,
            offsetsUri: `/job/${jobDir}/${r.offsetsFile}?v=${++fileVersion}`,
            count: r.count || 0,
          });
        }
        break;
      }
      case 'openLink': {
        // In the harness, record the link click and open in the host browser.
        harness.log.push(`openLink: ${m.url}`);
        // Validate scheme (matches atlasPanel.ts).
        if (/^(https?:|mailto:)/i.test(m.url)) {
          window.open(m.url, '_blank', 'noopener');
        }
        break;
      }
      case 'openCommand': {
        // In the harness, record the command execution (no VS Code to run it).
        harness.log.push(`openCommand: ${m.command}${m.args ? ' ' + JSON.stringify(m.args) : ''}`);
        break;
      }
      case 'image': {
        // In the harness, resolve local paths relative to window.location or the job root.
        harness.log.push(`image: row=${m.row} src=${m.src}`);
        // For local file paths in test scenarios, serve them from the /images route.
        const src = m.src;
        let uri = null;
        if (/^https?:/.test(src)) {
          // External URLs: serve directly (harness allows all; real host asks permission).
          uri = src;
        } else {
          // Local path: serve from /images if the server supports it.
          uri = `/images/${encodeURIComponent(src)}`;
        }
        if (uri) post({ type: 'imageUri', row: m.row, uri });
        break;
      }
      case 'cancel':
        generation++;
        if (jobId) await call('cancel', jobId).catch(() => undefined);
        break;
      case 'addCoordinates': {
        // T6: in 3D mode also confirm umap_z.
        const coordCols = m.dims === 3 ? 'umap_x, umap_y, and umap_z' : 'umap_x and umap_y';
        if (!confirmModal(`Add columns ${coordCols}`)) return;
        let xyPath = '';
        let name = '';
        if (m.anchorXY && !m.useProjection) {
          name = `coords_${Date.now()}.f32`;
          xyPath = await writeJobFile(name, m.anchorXY);
        } else if (!projectionCurrent) {
          throw new Error('Place all rows first, then add the coordinates.');
        }
        const r = await call('add_coordinates', jobId, xyPath);
        if (name) await rmJobFile(name);
        post({ type: 'coordsAdded', variable: r.variable, columns: r.columns });
        break;
      }
      case 'savePng':
        // Store as a data URL for harness compatibility (convert bytes → base64 data URL).
        // Use chunked btoa to avoid call-stack overflow on large PNGs.
        {
          const bytes = m.bytes;
          let b64 = '';
          const step = 0x8000;
          for (let i = 0; i < bytes.length; i += step) {
            b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
          }
          harness.png = `data:image/png;base64,${btoa(b64)}`;
        }
        break;
      case 'copyText':
        harness.clipboard = m.text;
        break;
      case 'search': {
        // A7: kernel search — call helper and return matching kept-row indices as a u32 file.
        const r = await call('search', jobId, m.column, m.query, m.limit ?? 100000, JSON.stringify({ regex: m.regex ?? false }));
        if (r.ok && r.file && r.count > 0) {
          post({ type: 'searchResults', column: m.column, query: m.query,
            file: fileRef({ file: r.file, dtype: 'u32', shape: [r.count] }), count: r.count });
        } else {
          post({ type: 'searchEmpty', column: m.column, query: m.query });
        }
        break;
      }
      case 'exportDataMapPlot': {
        // D3/D12: export with DataMapPlot — write to a temp file in the job dir.
        const outName = `datamapplot_${Date.now()}.html`;
        const outPath = `${info.jobRoot}/${jobDir}/${outName}`;
        const opts = JSON.stringify({ labelColumn: m.labelColumn, titleColumn: m.titleColumn, title: m.title, labelColorMap: m.labelColorMap });
        // The browser UMAP runs entirely in-browser; pass XY coords as a temp file
        // so the kernel can use them even when job.xy was never set server-side.
        let xyPath = null;
        let xyName = null;
        if (m.anchorXY && m.anchorXY.length > 0) {
          xyName = `dmp_xy_${Date.now()}.f32`;
          xyPath = await writeJobFile(xyName, m.anchorXY);
        }
        const r = await call('export_datamapplot', jobId, outPath, opts, xyPath);
        if (xyName) await rmJobFile(xyName);
        if (r.ok) {
          harness.log.push(`datamapplotExported: path=${r.path}`);
          harness.datamapplotExport = r;
          post({ type: 'datamapplotSaved', path: r.path });
        }
        break;
      }
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
      // --- HTML export (X2) step 1/2: fetch kernel text, send assembly data to webview ---
      case 'exportHtml': {
        // Store the pending export filename so exportHtmlReady can write it.
        harness._pendingExportName = `atlas_export_${Date.now()}.html`;
        harness._pendingNPoints = m.nPoints;
        try {
          // Fetch text for each tooltip column from the kernel (same as the real host).
          const textSections = [];
          for (const col of m.tooltipColumns) {
            try {
              const r = await call('texts', jobId, col.index, m.maxChars);
              if (r && r.ok !== false && r.utf8File && r.offsetsFile) {
                const [utf8Res, offsetsRes] = await Promise.all([
                  fetch(`/job/${jobDir}/${r.utf8File}`).then(x => x.arrayBuffer()),
                  fetch(`/job/${jobDir}/${r.offsetsFile}`).then(x => x.arrayBuffer()),
                ]);
                textSections.push({ column: col.index, utf8: new Uint8Array(utf8Res), offsets: new Uint32Array(offsetsRes) });
              }
            } catch (e) {
              harness.log.push(`texts for col ${col.index}: ${e.message}`);
            }
          }

          // Build combined textUtf8 / textOffsets (mirrors atlasPanel.ts)
          let textUtf8 = null, textOffsets = null;
          if (textSections.length > 0) {
            const nCols = m.tooltipColumns.length;
            const nPoints = m.nPoints;
            const offsetsPerCol = nPoints + 1;
            textOffsets = new Uint32Array(nCols * offsetsPerCol);
            const utf8Parts = [];
            let globalOffset = 0;
            for (let ci = 0; ci < nCols; ci++) {
              const colIdx = m.tooltipColumns[ci].index;
              const sec = textSections.find(s => s.column === colIdx);
              const colOffsets = new Uint32Array(offsetsPerCol);
              if (sec) {
                const srcOffsets = sec.offsets; // already Uint32Array
                const colBase = Math.min(srcOffsets.length - 1, nPoints);
                for (let i = 0; i <= colBase; i++) {
                  colOffsets[i] = globalOffset + (i < srcOffsets.length ? srcOffsets[i] : srcOffsets[srcOffsets.length - 1]);
                }
                const lastSrc = srcOffsets.length > 0 ? srcOffsets[Math.min(nPoints, srcOffsets.length - 1)] : 0;
                for (let i = colBase + 1; i <= nPoints; i++) colOffsets[i] = globalOffset + lastSrc;
                globalOffset += sec.utf8.byteLength;
                utf8Parts.push(sec.utf8);
              } else {
                colOffsets.fill(globalOffset);
              }
              textOffsets.set(colOffsets, ci * offsetsPerCol);
            }
            const totalLen = utf8Parts.reduce((s, u) => s + u.byteLength, 0);
            const combined = new Uint8Array(totalLen);
            let pos = 0;
            for (const u of utf8Parts) { combined.set(u, pos); pos += u.byteLength; }
            textUtf8 = combined;
          }

          post({ type: 'exportHtmlAssembly', viewerJsUri: '/viewer-dist/viewer.js', textUtf8, textOffsets });
        } catch (e) {
          harness.log.push(`exportHtml error: ${e.message}`);
          harness.htmlExport = { ok: false, error: e.message };
          post({ type: 'htmlExportSaved', path: '' });
        }
        break;
      }
      // --- HTML export (X2) step 2/2: receive assembled bytes, write to job dir ---
      case 'exportHtmlReady': {
        try {
          const outName = harness._pendingExportName ?? `atlas_export_${Date.now()}.html`;
          const nPoints = harness._pendingNPoints ?? 0;
          const bytes = m.htmlBytes instanceof Uint8Array ? m.htmlBytes : new Uint8Array(m.htmlBytes);
          const absPath = await writeJobFile(outName, bytes);
          harness.log.push(`htmlExported: path=${absPath}, size=${bytes.length}, nPoints=${nPoints}`);
          harness.htmlExport = { ok: true, path: absPath, url: `/job/${jobDir}/${outName}`, size: bytes.length, nPoints };
          post({ type: 'htmlExportSaved', path: absPath });
        } catch (e) {
          harness.log.push(`exportHtmlReady error: ${e.message}`);
          harness.htmlExport = { ok: false, error: e.message };
          post({ type: 'htmlExportSaved', path: '' });
        }
        break;
      }
      // --- Full-screen toggle (N5 / F1) ---
      case 'fullscreen':
        // In the harness, the webview is not in Positron, so isPositron is false and
        // PlotToolbar.svelte uses requestFullscreen() directly. This case handles the
        // (unlikely) path where isPositron was true in a harness run.
        harness.log.push(`fullscreen: ${m.on ? 'on' : 'off'}`);
        harness.fullscreen = !!m.on;
        break;
      // --- Navigation focus tracking (item 1) ---
      case 'webviewFocused':
        harness.webviewFocused = true;
        harness.log.push('webviewFocused');
        break;
      case 'webviewBlurred':
        harness.webviewFocused = false;
        harness.log.push('webviewBlurred');
        break;
      // --- Navigation preset context key (item 1) ---
      case 'navPresetChanged':
        harness.log.push(`navPreset: ${m.preset}`);
        break;
      // --- Annotate sub-tool changed (item 7+8, B4) ---
      case 'annotateToolChanged':
        harness.annotateTool = m.tool;
        harness.log.push(`annotateToolChanged: ${m.tool}`);
        break;
      // --- First-run hint dismissed (item 2) ---
      case 'hintSeen':
        harness.log.push('hintSeen');
        break;
      // --- C2: Time slider (item 10) ---
      case 'timeValues': {
        const r = await call('time_values', jobId, m.column);
        if (r.ok && r.file !== undefined) {
          post({ type: 'timeValues', column: m.column, file: fileRef({ file: r.file, dtype: 'f32', shape: [r.length] }), min: r.min, max: r.max, length: r.length });
        }
        break;
      }
      // --- C2: Tracks (item 11) ---
      case 'tracks': {
        // Write anchorXY to a temp file so the kernel can use it when job.xy is not set.
        let xyPath = null;
        if (m.anchorXY) {
          const xyName = `anchor_xy_tracks_${Date.now()}.f32`;
          xyPath = await writeJobFile(xyName, m.anchorXY);
        }
        try {
          const r = await call('tracks', jobId, m.idColumn, m.timeColumn, m.nd, xyPath || '');
          if (r.ok && r.xy_file !== undefined) {
            const nd2 = m.nd;
            post({ type: 'tracks', result: {
              xyFile: fileRef({ file: r.xy_file, dtype: 'f32', shape: [r.n_points * nd2] }),
              startsFile: fileRef({ file: r.starts_file, dtype: 'u32', shape: [r.n_tracks] }),
              lengthsFile: fileRef({ file: r.lengths_file, dtype: 'u32', shape: [r.n_tracks] }),
              timeFile: fileRef({ file: r.time_file, dtype: 'f32', shape: [r.n_points] }),
              idFile: fileRef({ file: r.id_file, dtype: 'u32', shape: [r.n_points] }),
              idColors: r.id_colors,
              nTracks: r.n_tracks,
              nPoints: r.n_points,
              nd: nd2,
            } });
          }
        } finally {
          if (xyPath) rmJobFile(xyPath.split('/').pop()).catch(() => undefined);
        }
        break;
      }
      // --- C2: Animate context key (no-op in harness; real host calls setContext) ---
      case 'animatingChanged':
        break;
      // --- C2: Save video (item 10) ---
      case 'saveVideo': {
        harness.video = m.bytes;
        harness.log.push('saveVideo');
        post({ type: 'videoSaved', path: '/tmp/' + m.filename });
        break;
      }
      // --- C3: Python API comm replies ---
      case 'apiReply': {
        // Write a status file to api_dir/<cmdId>.json so Python can poll for it.
        const pending = harness.pendingCommCmds?.get(m.commandId);
        if (pending && harness.commApiDir) {
          harness.pendingCommCmds.delete(m.commandId);
          const statusPath = `${harness.commApiDir}/${m.commandId}.json`;
          if (pending.name === 'savePng' && m.ok && m.bytes) {
            const pngPath = pending.args?.path;
            if (pngPath) {
              try {
                // Write PNG bytes to the requested path.
                await fetch(`/write-abs?path=${encodeURIComponent(pngPath)}`, { method: 'POST', body: m.bytes });
                await fetch(`/write-abs?path=${encodeURIComponent(statusPath)}`, {
                  method: 'POST', body: new TextEncoder().encode(JSON.stringify({ ok: true, error: '' })),
                });
              } catch (e) {
                await fetch(`/write-abs?path=${encodeURIComponent(statusPath)}`, {
                  method: 'POST', body: new TextEncoder().encode(JSON.stringify({ ok: false, error: String(e) })),
                });
              }
            }
          } else {
            await fetch(`/write-abs?path=${encodeURIComponent(statusPath)}`, {
              method: 'POST',
              body: new TextEncoder().encode(JSON.stringify({ ok: m.ok, error: m.error ?? '' })),
            });
          }
          harness.log.push(`apiReply:${m.commandId}:ok=${m.ok}`);
        }
        // Like the extension host: failed commands are shown as a warning.
        if (!m.ok) harness.log.push(`warning: Atlas (Python API): ${m.error ?? 'failed'}`);
        break;
      }
      case 'selectionChanged': {
        // Store the selection mask for test assertions.
        harness.lastSelectionChanged = { mask: m.mask, nKept: m.nKept };
        harness.log.push(`selectionChanged:nKept=${m.nKept}:hasMask=${m.mask != null}`);
        // If a comm on_msg callback is registered (Python API simulation), call it.
        if (harness.commOnMsg) {
          // Use snake_case for the wire: Python's _on_msg reads "mask_b64".
          let mask_b64 = null;
          if (m.mask) {
            let b64 = '';
            const step = 0x8000;
            for (let i = 0; i < m.mask.length; i += step) {
              b64 += String.fromCharCode.apply(null, m.mask.subarray(i, i + step));
            }
            mask_b64 = btoa(b64);
          }
          harness.commOnMsg({ content: { data: { type: 'selectionChanged', mask_b64, nKept: m.nKept } } });
        }
        break;
      }
      // --- B3: overlay layers ---
      case 'prepareOverlay': {
        const gen = ++generation;
        await call('prepare_overlay', jobId, m.variable, m.layerId);
        const s = await waitForJob(
          jobId,
          (st) => { post({ type: 'status', task: 'overlay-prepare', status: st }); },
          gen,
        );
        if (s.stage === 'done') {
          const r = s.result || {};
          post({ type: 'overlayPrepared', layerId: r.layerId || m.layerId, variable: m.variable, nRows: r.nRows || 0, nKept: r.nKept || 0, dims: r.dims || 0 });
        } else if (s.stage === 'error') {
          const err = new Error(s.error || 'Overlay prepare failed');
          err.detail = s.result && s.result.traceback;
          throw err;
        }
        break;
      }
      case 'projectOverlay': {
        if (!anchorXYPath) throw new Error('No anchor XY available. Run the base projection first.');
        const gen = ++generation;
        const layerId = m.layerId;
        await call('project_overlay', jobId, layerId, anchorXYPath, JSON.stringify({ metric: m.metric, seed: m.seed, native: settings().nativeCore }));
        const seen = new Set();
        const s = await waitForJob(
          jobId,
          (st) => {
            post({ type: 'status', task: 'overlay-project', status: st });
            for (const o of st.outputs) {
              if (o.kind === 'overlayXy' && !seen.has(o.file)) {
                seen.add(o.file);
                post({ type: 'xyChunk', file: fileRef(o), total: (st.result && st.result.nRows) || 0, layerId });
              }
            }
          },
          gen,
        );
        if (s.stage === 'done') {
          for (const o of s.outputs) {
            if (o.kind === 'overlayXy' && !seen.has(o.file)) {
              seen.add(o.file);
              post({ type: 'xyChunk', file: fileRef(o), total: (s.result && s.result.nRows) || 0, layerId });
            }
          }
        } else if (s.stage === 'error') {
          const err = new Error(s.error || 'Overlay projection failed');
          err.detail = s.result && s.result.traceback;
          throw err;
        }
        break;
      }
      case 'removeOverlay': {
        if (jobId) {
          await call('remove_overlay', jobId, m.layerId).catch(() => undefined);
        }
        post({ type: 'overlayRemoved', layerId: m.layerId });
        break;
      }
      case 'overlayRows': {
        if (!jobId) break;
        const r = await call('overlay_rows', jobId, m.layerId, m.indices, m.columns ?? null).catch(() => null);
        if (!r || !r.ok) break;
        const values = {};
        for (const [k, v] of Object.entries(r.values)) values[Number(k)] = v;
        post({ type: 'overlayRows', seq: m.seq, layerId: m.layerId, values });
        break;
      }
      // --- B3/Item 9: Symbol-by-column codes ---
      case 'symbolCodes': {
        if (!jobId) break;
        const r = await call('colors', jobId, m.column, true, 8).catch(() => null);
        if (!r) break;
        const categories = r.meta?.categories ?? [];
        post({ type: 'symbolCodes', column: m.column, file: fileRef({ file: r.file, dtype: r.dtype, shape: [r.length] }), categories });
        break;
      }
      // --- B3: overlay column descriptions ---
      case 'describeOverlay': {
        if (!jobId) break;
        const r = await call('describe_overlay', jobId, m.layerId).catch(() => null);
        if (r?.ok) post({ type: 'overlayDescribe', layerId: m.layerId, columns: r.columns });
        break;
      }
      // --- B3: overlay search ---
      case 'searchOverlay': {
        if (!jobId) break;
        const r = await call('search_overlay', jobId, m.layerId, m.column, m.query, m.limit ?? 100000).catch(() => null);
        if (r?.ok && r.file && r.count > 0) {
          post({ type: 'searchOverlayResults', layerId: m.layerId, query: m.query, file: fileRef({ file: r.file, dtype: 'u32', shape: [r.count] }), count: r.count });
        } else {
          post({ type: 'searchOverlayEmpty', layerId: m.layerId, query: m.query });
        }
        break;
      }
      // --- B3: overlay histogram values ---
      case 'histValuesOverlay': {
        if (!jobId) break;
        const r = await call('hist_values_overlay', jobId, m.layerId, m.column).catch(() => null);
        if (r?.ok) post({ type: 'histValuesOverlay', layerId: m.layerId, column: m.column, file: fileRef({ file: r.file, dtype: r.dtype, shape: [r.length] }) });
        break;
      }
    }
  }

  /**
   * Dispatch a navigation action id to the webview (item 1).
   * Useful from scenario scripts: window.__harness.dispatch('view.reset')
   */
  harness.dispatch = (id) => post({ type: 'command', id });

  /**
   * C3: Simulate a Python API comm command arriving at the host.
   * Stores the command in pendingCommCmds and posts apiCommand to the webview.
   * The status result is written to commApiDir/<cmdId>.json when apiReply arrives.
   * Usage: window.__harness.dispatchCommCommand('cmd-1', 'colorBy', {column: 0})
   */
  harness.dispatchCommCommand = (cmdId, name, args) => {
    harness.pendingCommCmds.set(cmdId, { name, args: args ?? {} });
    post({ type: 'apiCommand', commandId: cmdId, name, args: args ?? {} });
  };

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
