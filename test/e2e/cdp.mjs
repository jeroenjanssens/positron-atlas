// Minimal raw CDP client for the Positron workbench page. Webviews are out-of-process
// iframes, so we auto-attach to child targets (flattened sessions) to reach them.
export async function connect(port = Number(process.env.CDP_PORT ?? 9333)) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page' && t.url.includes('workbench.html'));
  if (!target) throw new Error('workbench page not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  /** contextId -> { sessionId, origin } */
  const contexts = new Map();
  const sessions = new Map();
  const logs = [];
  const send = (method, params = {}, sessionId, timeout = 5000) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      const timer = setTimeout(() => {
        pending.delete(i);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeout);
      pending.set(i, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const attachAll = (sessionId) =>
    send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => {});
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    const sid = msg.sessionId;
    if (msg.method === 'Target.attachedToTarget') {
      const s = msg.params.sessionId;
      sessions.set(s, msg.params.targetInfo);
      send('Runtime.enable', {}, s).catch(() => {});
      attachAll(s);
      send('Runtime.runIfWaitingForDebugger', {}, s).catch(() => {});
    } else if (msg.method === 'Runtime.executionContextCreated') {
      const c = msg.params.context;
      contexts.set(`${sid ?? ''}:${c.id}`, { sessionId: sid, id: c.id, origin: c.origin });
    } else if (msg.method === 'Runtime.consoleAPICalled' && sid) {
      logs.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    } else if (msg.method === 'Runtime.exceptionThrown' && sid) {
      const d = msg.params.exceptionDetails;
      logs.push(`[exception] ${d.exception?.description ?? d.text}`);
    }
  };
  await send('Runtime.enable');
  await attachAll(undefined);
  const evaluate = async (expression, ctx) => {
    const r = await send(
      'Runtime.evaluate',
      { expression, contextId: ctx?.id, awaitPromise: true, returnByValue: true },
      ctx?.sessionId,
      15000,
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return {
    send,
    logs,
    contexts,
    sessions,
    evaluate,
    close: () => ws.close(),
    async screenshot(path) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      (await import('node:fs')).writeFileSync(path, Buffer.from(data, 'base64'));
    },
    /** Execution context of the Atlas webview's inner frame (the one with window.__atlas). */
    async atlasContext() {
      for (const c of contexts.values()) {
        if (!String(c.origin).startsWith('vscode-webview://')) continue;
        try {
          if (await evaluate('typeof window.__atlas === "object"', c)) return c;
        } catch {}
      }
      return undefined;
    },
  };
}
