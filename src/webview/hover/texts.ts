/**
 * Lazy TextDecoder-based title column store (H5).
 *
 * After the host sends a 'texts' message with URI + offsetsUri, the webview fetches the
 * two binary blobs once and decodes individual strings on demand via TextDecoder.
 *
 * Memory: the UTF-8 blob is kept raw (ArrayBuffer) so we decode only when needed.
 */

export class TextsStore {
  private utf8: Uint8Array | null = null;
  private offsets: Uint32Array | null = null;
  private loaded = false;
  private requested = false;
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });

  /** Whether the store has data ready. */
  get ready(): boolean {
    return this.loaded;
  }

  /**
   * Mark that a `texts` request has been posted so requestAutoTexts does not
   * re-post on every hover before the blob response arrives.
   */
  markRequested(): void {
    this.requested = true;
  }

  /** True after markRequested() or load() has been called. */
  get requested_(): boolean {
    return this.requested || this.loaded;
  }

  /**
   * Load from the two URIs supplied by the host.
   * Resolves to true on success, false on network error.
   */
  async load(uri: string, offsetsUri: string): Promise<boolean> {
    try {
      const [utf8Buf, offBuf] = await Promise.all([
        fetch(uri).then((r) => r.arrayBuffer()),
        fetch(offsetsUri).then((r) => r.arrayBuffer()),
      ]);
      this.utf8 = new Uint8Array(utf8Buf);
      this.offsets = new Uint32Array(offBuf);
      this.loaded = true;
      return true;
    } catch {
      return false;
    }
  }

  /** Decode the title for prepared-row index i, or null if not available. */
  get(i: number): string | null {
    if (!this.loaded || !this.utf8 || !this.offsets) return null;
    if (i < 0 || i + 1 >= this.offsets.length) return null;
    const start = this.offsets[i];
    const end = this.offsets[i + 1];
    if (start === end) return '';
    return this.decoder.decode(this.utf8.subarray(start, end));
  }

  clear(): void {
    this.utf8 = null;
    this.offsets = null;
    this.loaded = false;
    this.requested = false;
  }
}

/**
 * Auto-detect a title column from describe metadata.
 * Looks for columns named title, name, label, text (case-insensitive) in that order,
 * then falls back to the first text/categorical column.
 */
export function detectTitleColumn(columns: { index: number; name: string; kind: string }[]): number | null {
  const TITLE_NAMES = ['title', 'name', 'label', 'text'];
  const lower = (s: string) => s.toLowerCase();
  for (const tname of TITLE_NAMES) {
    const c = columns.find((c) => lower(c.name) === tname && (c.kind === 'categorical' || c.kind === 'other'));
    if (c) return c.index;
  }
  // Fallback: first text/categorical column.
  const first = columns.find((c) => c.kind === 'categorical' || c.kind === 'other');
  return first ? first.index : null;
}

/**
 * Auto-detect a link column: a text column whose name contains 'url', 'link', 'href',
 * or 'uri' (case-insensitive).
 */
export function detectLinkColumn(columns: { index: number; name: string; kind: string }[]): number | null {
  const LINK_NAMES = ['url', 'link', 'href', 'uri'];
  const lower = (s: string) => s.toLowerCase();
  for (const lname of LINK_NAMES) {
    const c = columns.find((c) => lower(c.name).includes(lname) && (c.kind === 'categorical' || c.kind === 'other'));
    if (c) return c.index;
  }
  return null;
}

/**
 * Auto-detect an image URL/path column: a text column whose name contains 'image',
 * 'img', 'photo', 'picture', 'thumbnail', or 'thumb'.
 */
export function detectImageUrlColumn(columns: { index: number; name: string; kind: string }[]): number | null {
  const IMG_NAMES = ['image', 'img', 'photo', 'picture', 'thumbnail', 'thumb'];
  const lower = (s: string) => s.toLowerCase();
  for (const iname of IMG_NAMES) {
    const c = columns.find((c) => lower(c.name).includes(iname) && (c.kind === 'categorical' || c.kind === 'other'));
    if (c) return c.index;
  }
  return null;
}

/**
 * Validate that a string looks like a link (http, https, mailto).
 */
export function isValidLink(s: string): boolean {
  if (!s) return false;
  return /^(https?:|mailto:)/i.test(s);
}
