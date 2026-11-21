/**
 * Webview font helper (D11).
 *
 * API for later waves:
 *   ensureFont(family, weights?)  – request a font, inject @font-face CSS, wait for load
 *   listFonts()                   – request the font catalogue from the host
 *
 * This module is intentionally self-contained and does NOT modify any existing
 * webview files. Import and call it from the label/title UI when it is built.
 */

import type { FontCatalogEntry } from '../shared/protocol';

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** The VS Code API (or harness stub) used to post messages to the host. */
let _vscodeApi: { postMessage(msg: unknown): void } | null = null;

/** Pending font requests: seq → { resolve, reject }. */
const _pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
let _seq = 0;

/** Fonts that have been successfully loaded (family name → true). */
const _loaded = new Set<string>();

/** Catalogue request promise (at most one outstanding). */
let _catalogPromise: Promise<FontCatalogEntry[]> | null = null;
let _catalogResolve: ((c: FontCatalogEntry[]) => void) | null = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Initialise the font module.  Call once at startup, passing the VS Code API
 * object returned by acquireVsCodeApi().
 *
 * Also register the window message handler so fontReady / fontError /
 * fontCatalog messages from the host are dispatched here.  This must be called
 * before ensureFont() or listFonts().
 */
export function initFonts(api: { postMessage(msg: unknown): void }): void {
  _vscodeApi = api;
  window.addEventListener('message', _handleMessage);
}

function _handleMessage(event: MessageEvent): void {
  const msg = event.data as { type: string; [key: string]: unknown };
  if (!msg || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'fontReady': {
      const seq = msg.seq as number;
      const css = msg.css as string;
      const family = msg.family as string;

      // Inject @font-face rules into the document
      _injectCss(family, css);

      const p = _pending.get(seq);
      if (p) {
        _pending.delete(seq);
        p.resolve();
      }
      break;
    }
    case 'fontError': {
      const seq = msg.seq as number;
      const message = msg.message as string;
      const p = _pending.get(seq);
      if (p) {
        _pending.delete(seq);
        p.reject(new Error(message));
      }
      break;
    }
    case 'fontCatalog': {
      const families = msg.families as FontCatalogEntry[];
      if (_catalogResolve) {
        _catalogResolve(families);
        _catalogResolve = null;
        _catalogPromise = null;
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// CSS injection
// ---------------------------------------------------------------------------

const _styleElements = new Map<string, HTMLStyleElement>();

function _injectCss(family: string, css: string): void {
  // Create or replace the <style> tag for this font family
  let el = _styleElements.get(family);
  if (!el) {
    el = document.createElement('style');
    el.setAttribute('data-font-family', family);
    document.head.appendChild(el);
    _styleElements.set(family, el);
  }
  el.textContent = css;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure a font family is loaded and ready to use.
 *
 * Posts a `fontRequest` to the host, waits for `fontReady` or `fontError`,
 * injects the returned @font-face CSS, then waits for `document.fonts.load()`
 * for each requested weight.
 *
 * deck.gl rasterizes glyphs once into a texture, so the font MUST be loaded
 * before the first render that uses it.
 *
 * @param family   Font family name, e.g. "Cinzel" or "Inter"
 * @param weights  Weights to pre-load (default: [400])
 * @param scripts  Script subsets to request (default: ["latin"])
 */
export async function ensureFont(
  family: string,
  weights: number[] = [400],
  scripts: string[] = ['latin'],
): Promise<void> {
  if (!_vscodeApi) {
    throw new Error('initFonts() must be called before ensureFont()');
  }

  if (_loaded.has(family)) return;

  const seq = ++_seq;

  const css = await new Promise<void>((resolve, reject) => {
    _pending.set(seq, { resolve, reject });
    _vscodeApi!.postMessage({ type: 'fontRequest', seq, family, weights, scripts });
  });

  // Wait for the browser FontFaceSet to actually load the requested weights
  const loadPromises = weights.map((w) => {
    const spec = `${w} 1em '${family}'`;
    return document.fonts.load(spec).catch(() => undefined);
  });
  await Promise.all(loadPromises);

  _loaded.add(family);
}

/**
 * Request the font catalogue from the host.
 *
 * Returns an array of FontCatalogEntry objects: bundled families first, then
 * Google Fonts families (cached ones marked accordingly).
 *
 * Later waves use this to populate the font picker.
 */
export function listFonts(): Promise<FontCatalogEntry[]> {
  if (!_vscodeApi) {
    return Promise.reject(new Error('initFonts() must be called before listFonts()'));
  }

  if (_catalogPromise) return _catalogPromise;

  _catalogPromise = new Promise<FontCatalogEntry[]>((resolve) => {
    _catalogResolve = resolve;
    _vscodeApi!.postMessage({ type: 'fontCatalog' });
  });

  return _catalogPromise;
}

/**
 * Returns true if the given font family has been loaded (ensureFont completed).
 */
export function isFontLoaded(family: string): boolean {
  return _loaded.has(family);
}
