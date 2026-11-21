/**
 * Font plumbing for Positron Atlas (D11).
 *
 * Resolves a font request { family, weights, scripts } to @font-face CSS for the webview:
 *   - Bundled families → CSS pointing at media/fonts/ via webview.asWebviewUri
 *   - Google families  → fetch CSS2 API, download woff2 files for requested scripts,
 *                        cache in context.globalStorageUri/fonts/<family>/, rewrite URIs
 *
 * Permission: positronAtlas.downloadGoogleFonts (ask | always | never)
 *   - ask   → one-time modal per family, can promote to "always"
 *   - always → download silently
 *   - never  → reply with an error
 *
 * Security:
 *   - All downloaded URLs must be https://fonts.gstatic.com/...
 *   - woff2 files are capped at MAX_WOFF2_BYTES
 *   - CSS response is capped at MAX_CSS_BYTES
 *   - Neither is ever executed
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as https from 'node:https';
import type { FontCatalogEntry } from '../shared/protocol';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CSS2_API = 'https://fonts.googleapis.com/css2';
const MAX_CSS_BYTES = 128 * 1024; // 128 KB
const MAX_WOFF2_BYTES = 2 * 1024 * 1024; // 2 MB
const FETCH_TIMEOUT_MS = 15_000;
const GSTATIC_ORIGIN = 'https://fonts.gstatic.com';

// ---------------------------------------------------------------------------
// Bundled font catalogue
// ---------------------------------------------------------------------------

/** All bundled font families: family name → array of @font-face source objects. */
interface BundledFace {
  weight: string; // e.g. "400 900" (variable range) or "400"
  latinFile: string; // filename in media/fonts/
  latinExtFile?: string;
  unicodeRangeLatin: string;
  unicodeRangeLatinExt?: string;
}

interface BundledFamily {
  family: string;
  category: FontCatalogEntry['category'];
  faces: BundledFace[];
}

const BUNDLED: BundledFamily[] = [
  {
    family: 'Cinzel',
    category: 'Display',
    faces: [
      {
        weight: '400 900',
        latinFile: 'Cinzel.woff2',
        latinExtFile: 'Cinzel-LatinExt.woff2',
        unicodeRangeLatin:
          'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
        unicodeRangeLatinExt:
          'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF',
      },
    ],
  },
  {
    family: 'Playfair Display SC',
    category: 'Serif',
    faces: [
      {
        weight: '400',
        latinFile: 'PlayfairDisplaySC-400.woff2',
        latinExtFile: 'PlayfairDisplaySC-400-LatinExt.woff2',
        unicodeRangeLatin:
          'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
        unicodeRangeLatinExt:
          'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF',
      },
      {
        weight: '700',
        latinFile: 'PlayfairDisplaySC-700.woff2',
        latinExtFile: 'PlayfairDisplaySC-700-LatinExt.woff2',
        unicodeRangeLatin:
          'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
        unicodeRangeLatinExt:
          'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF',
      },
      {
        weight: '900',
        latinFile: 'PlayfairDisplaySC-900.woff2',
        latinExtFile: 'PlayfairDisplaySC-900-LatinExt.woff2',
        unicodeRangeLatin:
          'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
        unicodeRangeLatinExt:
          'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF',
      },
    ],
  },
  {
    family: 'Marcellus SC',
    category: 'Serif',
    faces: [
      {
        weight: '400',
        latinFile: 'MarcellusSC.woff2',
        latinExtFile: 'MarcellusSC-LatinExt.woff2',
        unicodeRangeLatin:
          'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
        unicodeRangeLatinExt:
          'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF',
      },
    ],
  },
  {
    family: 'Montserrat',
    category: 'Sans Serif',
    faces: [
      {
        weight: '100 900',
        latinFile: 'Montserrat.woff2',
        latinExtFile: 'Montserrat-LatinExt.woff2',
        unicodeRangeLatin:
          'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
        unicodeRangeLatinExt:
          'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF',
      },
    ],
  },
  {
    family: 'Roboto',
    category: 'Sans Serif',
    faces: [
      {
        weight: '100 900',
        latinFile: 'Roboto.woff2',
        latinExtFile: 'Roboto-LatinExt.woff2',
        unicodeRangeLatin:
          'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
        unicodeRangeLatinExt:
          'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF',
      },
    ],
  },
  {
    family: 'Roboto Condensed',
    category: 'Sans Serif',
    faces: [
      {
        weight: '100 900',
        latinFile: 'RobotoCondensed.woff2',
        latinExtFile: 'RobotoCondensed-LatinExt.woff2',
        unicodeRangeLatin:
          'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
        unicodeRangeLatinExt:
          'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF',
      },
    ],
  },
  {
    family: 'Inter',
    category: 'Sans Serif',
    faces: [
      {
        weight: '100 900',
        latinFile: 'Inter.woff2',
        latinExtFile: 'Inter-LatinExt.woff2',
        unicodeRangeLatin:
          'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
        unicodeRangeLatinExt:
          'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF',
      },
    ],
  },
  {
    family: 'JetBrains Mono',
    category: 'Monospace',
    faces: [
      {
        weight: '100 800',
        latinFile: 'JetBrainsMono.woff2',
        latinExtFile: 'JetBrainsMono-LatinExt.woff2',
        unicodeRangeLatin:
          'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
        unicodeRangeLatinExt:
          'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF',
      },
    ],
  },
];

const BUNDLED_NAMES = new Set(BUNDLED.map((b) => b.family.toLowerCase()));

// ---------------------------------------------------------------------------
// Google Fonts catalogue
// ---------------------------------------------------------------------------

interface GoogleFontsCatalog {
  schema: string[];
  categories: Record<string, string>;
  families: Array<[string, string, number | string]>;
}

/** Loaded lazily. */
let _catalog: GoogleFontsCatalog | null = null;

function loadCatalog(extensionUri: vscode.Uri): GoogleFontsCatalog {
  if (_catalog) return _catalog;
  const catalogPath = vscode.Uri.joinPath(extensionUri, 'media', 'fonts', 'google-fonts-catalog.json').fsPath;
  try {
    const raw = require('node:fs').readFileSync(catalogPath, 'utf8');
    _catalog = JSON.parse(raw) as GoogleFontsCatalog;
  } catch {
    _catalog = { schema: [], categories: {}, families: [] };
  }
  return _catalog;
}

function isGoogleFont(extensionUri: vscode.Uri, family: string): boolean {
  const cat = loadCatalog(extensionUri);
  const lower = family.toLowerCase();
  return cat.families.some((f) => f[0].toLowerCase() === lower);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch a URL over https with timeout and byte limit. Never follows to non-https. */
function httpsGet(url: string, maxBytes: number, extraHeaders: Record<string, string> = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!url.startsWith('https://')) {
      reject(new Error(`Refusing non-https URL: ${url}`));
      return;
    }
    const req = https.get(url, { headers: { 'User-Agent': CHROME_UA, ...extraHeaders } }, (res) => {
      if (res.statusCode !== 200) {
        req.destroy();
        reject(new Error(`HTTP ${res.statusCode ?? '?'} for ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy();
          reject(new Error(`Response too large (>${maxBytes} bytes) for ${url}`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// CSS2 response parsing
// ---------------------------------------------------------------------------

interface FontFaceBlock {
  /** The comment before the block, e.g. "latin", "latin-ext", "cyrillic". */
  subset: string;
  /** Full font-weight value from the @font-face rule, e.g. "400 900" or "400". */
  weight: string;
  /** Validated woff2 URL (must be on fonts.gstatic.com). */
  url: string;
  /** unicode-range from the @font-face rule. */
  unicodeRange: string;
}

/** Parse all @font-face blocks from a Google Fonts CSS2 response. */
export function parseFontFaceBlocks(css: string): FontFaceBlock[] {
  const blocks: FontFaceBlock[] = [];

  // Split the CSS into chunks separated by @font-face
  // Each chunk may be preceded by a /* subset */ comment
  const regex =
    /\/\*\s*([a-zA-Z0-9_\- ]+?)\s*\*\/\s*@font-face\s*\{([^}]+)\}/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(css)) !== null) {
    const subset = match[1].trim();
    const body = match[2];

    const urlMatch = body.match(/src:\s*url\(([^)]+\.woff2)\)/);
    const weightMatch = body.match(/font-weight:\s*([^\n;]+)/);
    const rangeMatch = body.match(/unicode-range:\s*([^\n;]+)/);

    if (!urlMatch || !weightMatch) continue;
    const url = urlMatch[1].trim();
    const weight = weightMatch[1].trim();
    const unicodeRange = rangeMatch ? rangeMatch[1].trim() : '';

    // Security: only accept https://fonts.gstatic.com URLs
    if (!url.startsWith(GSTATIC_ORIGIN + '/')) continue;

    blocks.push({ subset, weight, url, unicodeRange });
  }

  return blocks;
}

/** Filter @font-face blocks to the requested scripts.
 *
 * @param blocks  All parsed blocks.
 * @param scripts Script subset names to include (e.g. ["latin", "latin-ext"]).
 *                Defaults to ["latin"] if empty.
 */
export function filterByScripts(blocks: FontFaceBlock[], scripts: string[]): FontFaceBlock[] {
  const wanted = new Set(scripts.length > 0 ? scripts.map((s) => s.toLowerCase()) : ['latin']);
  return blocks.filter((b) => wanted.has(b.subset.toLowerCase()));
}

/** Build a @font-face CSS block pointing at a local webview URI. */
function buildFontFaceCss(family: string, weight: string, url: string, unicodeRange: string): string {
  return [
    `@font-face {`,
    `  font-family: '${family.replace(/'/g, "\\'")}';`,
    `  font-style: normal;`,
    `  font-weight: ${weight};`,
    `  font-display: swap;`,
    `  src: url('${url}') format('woff2');`,
    unicodeRange ? `  unicode-range: ${unicodeRange};` : '',
    `}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

export class FontManager {
  private readonly fontsDir: vscode.Uri;
  private readonly extensionUri: vscode.Uri;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.extensionUri = ctx.extensionUri;
    this.fontsDir = vscode.Uri.joinPath(ctx.globalStorageUri, 'fonts');
  }

  /**
   * The globalStorageUri fonts directory must be added to localResourceRoots
   * so the webview can load cached font files. Call this when constructing
   * the webview panel options.
   */
  get localResourceRoot(): vscode.Uri {
    return this.fontsDir;
  }

  /**
   * Resolve a font request to @font-face CSS.
   * - Bundled: CSS with webview URIs from media/fonts/
   * - Google:  download (with permission), cache, return rewritten CSS
   */
  async resolveFontCss(
    webview: vscode.Webview,
    family: string,
    scripts: string[],
  ): Promise<string> {
    const lower = family.toLowerCase();

    // --- Bundled ---
    const bundled = BUNDLED.find((b) => b.family.toLowerCase() === lower);
    if (bundled) {
      return this.bundledCss(webview, bundled, scripts);
    }

    // --- Google ---
    return this.googleFontCss(webview, family, scripts);
  }

  // ---- Bundled ----

  private bundledCss(webview: vscode.Webview, bundled: BundledFamily, scripts: string[]): string {
    const wanted = new Set(scripts.length > 0 ? scripts.map((s) => s.toLowerCase()) : ['latin']);
    const includeLatinExt = wanted.has('latin-ext');
    const fontsBaseUri = vscode.Uri.joinPath(this.extensionUri, 'media', 'fonts');

    const blocks: string[] = [];

    for (const face of bundled.faces) {
      // latin
      if (wanted.has('latin')) {
        const uri = webview.asWebviewUri(vscode.Uri.joinPath(fontsBaseUri, face.latinFile));
        blocks.push(buildFontFaceCss(bundled.family, face.weight, uri.toString(), face.unicodeRangeLatin));
      }
      // latin-ext
      if (includeLatinExt && face.latinExtFile && face.unicodeRangeLatinExt) {
        const uri = webview.asWebviewUri(vscode.Uri.joinPath(fontsBaseUri, face.latinExtFile));
        blocks.push(buildFontFaceCss(bundled.family, face.weight, uri.toString(), face.unicodeRangeLatinExt));
      }
    }

    return blocks.join('\n\n');
  }

  // ---- Google Fonts ----

  /** Sanitise family name to a filesystem-safe directory name. */
  private static safeFamilyDir(family: string): string {
    return family.replace(/[^a-zA-Z0-9 _\-]/g, '').replace(/\s+/g, '_');
  }

  private cachedCssPath(family: string): string {
    return path.join(
      this.fontsDir.fsPath,
      FontManager.safeFamilyDir(family),
      'font-faces.css',
    );
  }

  private cachedWoff2Dir(family: string): string {
    return path.join(this.fontsDir.fsPath, FontManager.safeFamilyDir(family));
  }

  private async loadFromCache(webview: vscode.Webview, family: string): Promise<string | null> {
    const cssPath = this.cachedCssPath(family);
    try {
      const css = await fs.readFile(cssPath, 'utf8');
      // Rewrite file:// paths in the cached CSS to current webview URIs
      return this.rewriteCachedCss(webview, css, family);
    } catch {
      return null;
    }
  }

  /**
   * The cached CSS stores placeholder paths like `__FONTS_DIR__/<file>`.
   * Rewrite them to actual webview URIs for the current webview instance.
   */
  private rewriteCachedCss(webview: vscode.Webview, css: string, family: string): string {
    const dir = FontManager.safeFamilyDir(family);
    return css.replace(/__FONTS_DIR__\/([^'")\s]+)/g, (_match, file) => {
      const uri = webview.asWebviewUri(vscode.Uri.joinPath(this.fontsDir, dir, file));
      return uri.toString();
    });
  }

  private buildPlaceholderCss(family: string, blocks: FontFaceBlock[]): string {
    const dir = FontManager.safeFamilyDir(family);
    return blocks
      .map((b) => {
        const file = b.url.split('/').pop()!;
        return buildFontFaceCss(family, b.weight, `__FONTS_DIR__/${dir}/${file}`, b.unicodeRange);
      })
      .join('\n\n');
  }

  private async googleFontCss(webview: vscode.Webview, family: string, scripts: string[]): Promise<string> {
    // Try cache first
    const cached = await this.loadFromCache(webview, family);
    if (cached) {
      this.log.info(`[fonts] cache hit for ${family}`);
      return cached;
    }

    // Check permission
    await this.checkPermission(family);

    // Fetch CSS2 response
    const params = encodeURIComponent(family) + ':wght@100..900';
    const cssUrl = `${CSS2_API}?family=${params}&display=swap`;
    this.log.info(`[fonts] fetching CSS2 for ${family}`);
    const cssBytes = await httpsGet(cssUrl, MAX_CSS_BYTES);
    const rawCss = cssBytes.toString('utf8');

    // Parse and filter blocks
    const allBlocks = parseFontFaceBlocks(rawCss);
    if (allBlocks.length === 0) {
      throw new Error(`No @font-face blocks found for ${family}. The font may not be available on Google Fonts.`);
    }

    const wanted = scripts.length > 0 ? scripts : ['latin'];
    const filtered = filterByScripts(allBlocks, wanted);
    if (filtered.length === 0) {
      throw new Error(`No @font-face blocks found for ${family} with scripts: ${wanted.join(', ')}`);
    }

    // Download woff2 files
    const cacheDir = this.cachedWoff2Dir(family);
    await fs.mkdir(cacheDir, { recursive: true });

    for (const block of filtered) {
      const filename = block.url.split('?')[0].split('/').pop() ?? '';
      // Only plain file names (no '..', no separators) end up in the cache directory.
      if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*\.woff2$/.test(filename)) {
        continue;
      }
      const dest = path.join(cacheDir, filename);
      try {
        await fs.access(dest); // already cached
      } catch {
        this.log.info(`[fonts] downloading ${block.url}`);
        const data = await httpsGet(block.url, MAX_WOFF2_BYTES);
        await fs.writeFile(dest, data);
      }
    }

    // Build and cache CSS with placeholder paths
    const placeholderCss = this.buildPlaceholderCss(family, filtered);
    await fs.writeFile(this.cachedCssPath(family), placeholderCss);

    // Return with webview URIs
    return this.rewriteCachedCss(webview, placeholderCss, family);
  }

  // ---- Permission ----

  private async checkPermission(family: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('positronAtlas');
    const perm = config.get<string>('downloadGoogleFonts', 'ask');

    if (perm === 'always') return;
    if (perm === 'never') {
      throw new Error(
        `Downloading fonts from Google Fonts is disabled (positronAtlas.downloadGoogleFonts = "never"). ` +
          `Change the setting to enable it.`,
      );
    }

    // perm === 'ask': show a one-time modal
    const pick = await vscode.window.showInformationMessage(
      `Download "${family}" from Google Fonts? This sends the font name and your IP address to Google.`,
      { modal: true },
      'Download',
      'Always Download',
      'Not now',
    );

    if (pick === 'Always Download') {
      await config.update('downloadGoogleFonts', 'always', vscode.ConfigurationTarget.Global);
      return;
    }
    if (pick === 'Download') return;

    // "Not now" or dismissed
    throw new Error(
      `Download of "${family}" was cancelled. ` +
        `You can change this in Settings: positronAtlas.downloadGoogleFonts.`,
    );
  }

  // ---- Catalogue ----

  /**
   * Return the full font catalogue: bundled families first, then
   * Google Fonts families from the snapshot.
   */
  async listFonts(): Promise<FontCatalogEntry[]> {
    const entries: FontCatalogEntry[] = [];

    // Bundled families
    for (const b of BUNDLED) {
      const weights = b.faces.map((f) => {
        const parts = f.weight.split(' ');
        return parts.length === 2 ? `${parts[0]}-${parts[1]}` : f.weight;
      });
      // For the entry weight field: use the range string or array
      const wts = b.faces.length === 1 && b.faces[0].weight.includes(' ')
        ? b.faces[0].weight.replace(' ', '-')
        : b.faces.map((f) => parseInt(f.weight, 10)).filter((n) => !isNaN(n));
      entries.push({
        family: b.family,
        category: b.category,
        weights: Array.isArray(wts) ? wts : (wts as string),
        source: 'bundled',
      });
    }

    // Google Fonts catalogue
    const cat = loadCatalog(this.extensionUri);
    // Track which are cached
    const cachedFamilies = await this.listCachedFamilies();

    for (const [family, catCode, weights] of cat.families) {
      // Skip if already in bundled (case-insensitive)
      if (BUNDLED_NAMES.has(family.toLowerCase())) continue;

      const catLabel = cat.categories[catCode] ?? 'Display';
      const source: FontCatalogEntry['source'] = cachedFamilies.has(family.toLowerCase()) ? 'cached' : 'google';

      entries.push({
        family,
        category: catLabel as FontCatalogEntry['category'],
        weights: typeof weights === 'number' ? [weights] : (weights as string | number[]),
        source,
      });
    }

    return entries;
  }

  private async listCachedFamilies(): Promise<Set<string>> {
    const result = new Set<string>();
    try {
      const dirs = await fs.readdir(this.fontsDir.fsPath, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const cssPath = path.join(this.fontsDir.fsPath, d.name, 'font-faces.css');
        try {
          await fs.access(cssPath);
          result.add(d.name.replace(/_/g, ' ').toLowerCase());
        } catch {
          // no css cache = not fully cached
        }
      }
    } catch {
      // fonts dir doesn't exist yet
    }
    return result;
  }
}
