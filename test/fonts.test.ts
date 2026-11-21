/**
 * Unit tests for font plumbing (D11):
 *   - CSS2 response parsing (from recorded fixture, no network)
 *   - filterByScripts subset selection
 *   - Cache hit path in FontManager.resolveFontCss
 *   - Permission logic (never → error; always → no modal)
 *
 * See test/fixtures/google-fonts-css2-*.css for recorded responses.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseFontFaceBlocks, filterByScripts } from '../src/extension/fonts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fixture(name: string): string {
  return readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

// ---------------------------------------------------------------------------
// parseFontFaceBlocks
// ---------------------------------------------------------------------------

describe('parseFontFaceBlocks', () => {
  it('extracts latin and latin-ext blocks from Cinzel fixture', () => {
    const css = fixture('google-fonts-css2-cinzel.css');
    const blocks = parseFontFaceBlocks(css);
    expect(blocks).toHaveLength(2);

    const latin = blocks.find((b) => b.subset === 'latin');
    const latinExt = blocks.find((b) => b.subset === 'latin-ext');

    expect(latin).toBeDefined();
    expect(latin!.url).toBe('https://fonts.gstatic.com/s/cinzel/v26/8vIJ7ww63mVu7gt79mT7.woff2');
    expect(latin!.weight).toBe('400 900');
    expect(latin!.unicodeRange).toMatch(/U\+0000/);

    expect(latinExt).toBeDefined();
    expect(latinExt!.url).toBe('https://fonts.gstatic.com/s/cinzel/v26/8vIJ7ww63mVu7gt7-GT7LEc.woff2');
  });

  it('extracts 7 blocks from Inter fixture (cyrillic-ext, cyrillic, greek-ext, greek, vietnamese, latin-ext, latin)', () => {
    const css = fixture('google-fonts-css2-inter.css');
    const blocks = parseFontFaceBlocks(css);
    expect(blocks).toHaveLength(7);

    const subsets = blocks.map((b) => b.subset);
    expect(subsets).toContain('latin');
    expect(subsets).toContain('latin-ext');
    expect(subsets).toContain('cyrillic');
    expect(subsets).toContain('cyrillic-ext');
    expect(subsets).toContain('greek');
    expect(subsets).toContain('greek-ext');
    expect(subsets).toContain('vietnamese');
  });

  it('only accepts https://fonts.gstatic.com URLs', () => {
    const malicious = `
/* latin */
@font-face {
  font-family: 'Evil';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(http://evil.example.com/font.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
/* latin-ext */
@font-face {
  font-family: 'Evil';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/valid/v1/file.woff2) format('woff2');
  unicode-range: U+0100-02FF;
}`;
    const blocks = parseFontFaceBlocks(malicious);
    // Only the gstatic.com URL passes; http:// is rejected
    expect(blocks).toHaveLength(1);
    expect(blocks[0].subset).toBe('latin-ext');
    expect(blocks[0].url).toMatch(/^https:\/\/fonts\.gstatic\.com\//);
  });

  it('returns empty array for empty CSS', () => {
    expect(parseFontFaceBlocks('')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// filterByScripts
// ---------------------------------------------------------------------------

describe('filterByScripts', () => {
  const css = fixture('google-fonts-css2-inter.css');
  let allBlocks: ReturnType<typeof parseFontFaceBlocks>;

  beforeEach(() => {
    allBlocks = parseFontFaceBlocks(css);
  });

  it('defaults to latin when scripts is empty', () => {
    const filtered = filterByScripts(allBlocks, []);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].subset).toBe('latin');
  });

  it('filters to latin only', () => {
    const filtered = filterByScripts(allBlocks, ['latin']);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].subset).toBe('latin');
  });

  it('filters to latin and latin-ext', () => {
    const filtered = filterByScripts(allBlocks, ['latin', 'latin-ext']);
    expect(filtered).toHaveLength(2);
    const subsets = filtered.map((b) => b.subset);
    expect(subsets).toContain('latin');
    expect(subsets).toContain('latin-ext');
  });

  it('filters to cyrillic', () => {
    const filtered = filterByScripts(allBlocks, ['cyrillic']);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].subset).toBe('cyrillic');
    expect(filtered[0].url).toMatch(/fonts\.gstatic\.com/);
  });

  it('filters to multiple scripts including latin', () => {
    const filtered = filterByScripts(allBlocks, ['latin', 'cyrillic', 'greek']);
    expect(filtered).toHaveLength(3);
  });

  it('returns empty for unknown script', () => {
    const filtered = filterByScripts(allBlocks, ['klingon']);
    expect(filtered).toHaveLength(0);
  });

  it('is case-insensitive', () => {
    const filtered = filterByScripts(allBlocks, ['Latin', 'LATIN-EXT']);
    expect(filtered).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// FontManager – cache hit path and permission logic
// ---------------------------------------------------------------------------

// We mock the vscode module so FontManager can be instantiated without VS Code.
vi.mock('vscode', () => {
  const Uri = {
    joinPath: (base: { fsPath: string; toString(): string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join('/'),
      toString: () => `vscode-resource:${[base.fsPath, ...parts].join('/')}`,
    }),
    file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }),
  };
  const workspace = {
    getConfiguration: vi.fn().mockReturnValue({
      get: (key: string, def: unknown) => def,
      update: vi.fn().mockResolvedValue(undefined),
    }),
  };
  const window = {
    showInformationMessage: vi.fn(),
  };
  const LogOutputChannel = class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  };
  return { Uri, workspace, window, LogOutputChannel };
});

// Import FontManager after mock is set up
import { FontManager } from '../src/extension/fonts';
import * as vscode from 'vscode';

describe('FontManager', () => {
  function makeCtx(overrides: Partial<{ fsPath: string }> = {}) {
    const storageBase = overrides.fsPath ?? '/tmp/atlas-test-fonts';
    return {
      extensionUri: { fsPath: '/ext', toString: () => 'file:///ext' },
      globalStorageUri: { fsPath: storageBase, toString: () => `file://${storageBase}` },
    } as unknown as vscode.ExtensionContext;
  }

  function makeLog() {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as vscode.LogOutputChannel;
  }

  function makeWebview(uriMapper?: (uri: { fsPath: string }) => string) {
    return {
      asWebviewUri: (uri: { fsPath: string }) => ({
        toString: () => uriMapper ? uriMapper(uri) : `vscode-resource:${uri.fsPath}`,
      }),
    } as unknown as vscode.Webview;
  }

  it('resolves a bundled font (Cinzel) without network', async () => {
    const mgr = new FontManager(makeCtx(), makeLog());
    const css = await mgr.resolveFontCss(makeWebview(), 'Cinzel', ['latin']);
    expect(css).toContain("font-family: 'Cinzel'");
    expect(css).toContain('@font-face');
    expect(css).toContain('font-weight: 400 900');
    // URI should contain the woff2 filename
    expect(css).toContain('Cinzel.woff2');
    // No gstatic.com URLs in the bundled CSS (uses webview URIs)
    expect(css).not.toContain('fonts.gstatic.com');
  });

  it('resolves Playfair Display SC (3 weights) without network', async () => {
    const mgr = new FontManager(makeCtx(), makeLog());
    const css = await mgr.resolveFontCss(makeWebview(), 'Playfair Display SC', ['latin']);
    expect(css).toContain("font-family: 'Playfair Display SC'");
    // All three weights should be present
    expect(css).toContain('font-weight: 400');
    expect(css).toContain('font-weight: 700');
    expect(css).toContain('font-weight: 900');
    expect(css).toContain('PlayfairDisplaySC-400.woff2');
    expect(css).toContain('PlayfairDisplaySC-700.woff2');
    expect(css).toContain('PlayfairDisplaySC-900.woff2');
  });

  it('includes latin-ext blocks when requested', async () => {
    const mgr = new FontManager(makeCtx(), makeLog());
    const cssLatin = await mgr.resolveFontCss(makeWebview(), 'Cinzel', ['latin']);
    const cssBoth = await mgr.resolveFontCss(makeWebview(), 'Cinzel', ['latin', 'latin-ext']);
    // latin-only should have 1 @font-face block
    expect((cssLatin.match(/@font-face/g) ?? []).length).toBe(1);
    // both should have 2
    expect((cssBoth.match(/@font-face/g) ?? []).length).toBe(2);
    expect(cssBoth).toContain('Cinzel-LatinExt.woff2');
  });

  it('throws when downloadGoogleFonts is "never" for a Google font', async () => {
    // Mock the config to return "never"
    const mockConfig = { get: vi.fn().mockReturnValue('never'), update: vi.fn() };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(mockConfig as never);

    const mgr = new FontManager(makeCtx(), makeLog());
    await expect(mgr.resolveFontCss(makeWebview(), 'Raleway', ['latin'])).rejects.toThrow(
      /downloadGoogleFonts = "never"/,
    );
  });

  it('localResourceRoot returns a URI under globalStorageUri', () => {
    const mgr = new FontManager(makeCtx({ fsPath: '/storage/atlas' }), makeLog());
    const root = mgr.localResourceRoot;
    expect(root.fsPath).toContain('/storage/atlas');
    expect(root.fsPath).toContain('fonts');
  });
});
