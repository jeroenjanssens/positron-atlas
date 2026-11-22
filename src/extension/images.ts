/**
 * Image resolution for the hover tooltip (H8).
 *
 * Handles two sources:
 *   1. http(s) URLs — downloaded once per URL after a one-time per-panel permission check.
 *   2. Local file paths — resolved relative to the first workspace folder or absolutely.
 *
 * Results are cached in the job directory (small LRU-like map keyed by row).  The webview
 * receives a webview-safe URI produced with panel.webview.asWebviewUri.
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/** Maximum response body for a downloaded image (10 MB). */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Download timeout in milliseconds. */
const FETCH_TIMEOUT_MS = 15_000;

/** LRU-ish in-memory cache: maps url/path → job-dir filename. */
const MAX_CACHE_ENTRIES = 200;

export class ImageResolver {
  private readonly cache = new Map<string, string>(); // key → filename in jobDir

  constructor(
    private readonly webview: vscode.Webview,
    private readonly jobDir: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /**
   * Resolve an image identified by a URL or file path string.
   * Returns a webview URI string, or null on failure.
   */
  async resolve(src: string, permission: 'always' | 'never' | 'ask', panel: vscode.WebviewPanel): Promise<string | null> {
    if (!src) return null;

    // Validate — only allow safe schemes and local paths.
    let isUrl = false;
    try {
      const u = new URL(src);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        isUrl = true;
      } else if (u.protocol === 'file:') {
        // treat as local path
      } else {
        this.log.warn(`[images] rejected scheme ${u.protocol} for ${src}`);
        return null;
      }
    } catch {
      // Not a URL — treat as a file path.
    }

    if (isUrl && permission === 'never') {
      return null;
    }
    if (isUrl && permission === 'ask') {
      const pick = await vscode.window.showInformationMessage(
        `Positron Atlas: download images from external URLs?`,
        { modal: true },
        'Allow for this panel',
        'Never',
      );
      if (pick === 'Allow for this panel') {
        // The caller will update its own permission state to 'always'.
        // We proceed.
      } else {
        return null;
      }
    }

    // Check cache.
    if (this.cache.has(src)) {
      const fname = this.cache.get(src)!;
      const uri = this.webview.asWebviewUri(vscode.Uri.joinPath(this.jobDir, fname));
      return uri.toString();
    }

    try {
      const fname = isUrl ? await this.downloadUrl(src) : await this.copyLocal(src);
      if (!fname) return null;
      // Evict oldest entry when cache is full.
      if (this.cache.size >= MAX_CACHE_ENTRIES) {
        const first = this.cache.keys().next().value;
        if (first) this.cache.delete(first);
      }
      this.cache.set(src, fname);
      const uri = this.webview.asWebviewUri(vscode.Uri.joinPath(this.jobDir, fname));
      return uri.toString();
    } catch (e) {
      this.log.warn(`[images] failed to resolve ${src}: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  private async downloadUrl(url: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        this.log.warn(`[images] HTTP ${res.status} for ${url}`);
        return null;
      }
      const contentType = res.headers.get('content-type') ?? '';
      const ext = this.extFromContentType(contentType) ?? this.extFromUrl(url) ?? 'bin';
      const reader = res.body?.getReader();
      if (!reader) return null;
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.length;
          if (total > MAX_IMAGE_BYTES) {
            reader.cancel();
            this.log.warn(`[images] ${url} exceeds ${MAX_IMAGE_BYTES} bytes`);
            return null;
          }
          chunks.push(value);
        }
      }
      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      return this.writeToJobDir(buf, ext);
    } finally {
      clearTimeout(timer);
    }
  }

  private async copyLocal(src: string): Promise<string | null> {
    // Resolve relative to workspace root, or use absolute.
    let resolved = src;
    if (!path.isAbsolute(src)) {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (ws) {
        resolved = path.join(ws, src);
      } else {
        return null;
      }
    }
    // Guard against path traversal outside the workspace / absolute roots.
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    if (ws && !resolved.startsWith(ws) && !path.isAbsolute(src)) {
      this.log.warn(`[images] path traversal rejected: ${src}`);
      return null;
    }
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) return null;
      if (stat.size > MAX_IMAGE_BYTES) {
        this.log.warn(`[images] local file too large (${stat.size}): ${resolved}`);
        return null;
      }
      const buf = await fs.readFile(resolved);
      const ext = path.extname(resolved).replace(/^\./, '') || 'bin';
      return this.writeToJobDir(buf, ext);
    } catch {
      return null;
    }
  }

  private async writeToJobDir(buf: Buffer, ext: string): Promise<string> {
    const fname = `img_${crypto.randomBytes(8).toString('hex')}.${ext}`;
    const dest = vscode.Uri.joinPath(this.jobDir, fname);
    await vscode.workspace.fs.writeFile(dest, buf);
    return fname;
  }

  private extFromContentType(ct: string): string | null {
    if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
    if (ct.includes('png')) return 'png';
    if (ct.includes('gif')) return 'gif';
    if (ct.includes('webp')) return 'webp';
    if (ct.includes('svg')) return 'svg';
    return null;
  }

  private extFromUrl(url: string): string | null {
    try {
      const p = new URL(url).pathname;
      const ext = path.extname(p).replace(/^\./, '').toLowerCase();
      return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext) ? ext : null;
    } catch {
      return null;
    }
  }
}

/**
 * Detect whether a column looks like it contains image URLs or file paths.
 * Samples up to 50 non-null string values.
 */
export function isImageUrlColumn(values: string[]): boolean {
  const sample = values.filter(Boolean).slice(0, 50);
  if (sample.length === 0) return false;
  const IMG_EXTS = /\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?.*)?$/i;
  const URL_RX = /^https?:\/\//i;
  let matches = 0;
  for (const v of sample) {
    if ((URL_RX.test(v) && IMG_EXTS.test(v)) || IMG_EXTS.test(v)) {
      matches++;
    }
  }
  return matches / sample.length >= 0.5;
}

/**
 * Detect whether a column looks like it contains http/https/mailto URLs.
 */
export function isLinkColumn(values: string[]): boolean {
  const sample = values.filter(Boolean).slice(0, 50);
  if (sample.length === 0) return false;
  const URL_RX = /^(https?:|mailto:)/i;
  let matches = 0;
  for (const v of sample) {
    if (URL_RX.test(v)) matches++;
  }
  return matches / sample.length >= 0.5;
}

/**
 * Validate that a URL has an allowed scheme (http, https, mailto only).
 */
export function validateLinkScheme(url: string): boolean {
  try {
    const u = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol);
  } catch {
    return false;
  }
}
