import { describe, expect, it } from 'vitest';
import { LruCache } from '../src/webview/hover/cache';
import {
  TextsStore,
  detectTitleColumn,
  detectLinkColumn,
  detectImageUrlColumn,
  isValidLink,
} from '../src/webview/hover/texts';

// ---- LRU cache -----------------------------------------------------------------------

describe('LruCache', () => {
  it('stores and retrieves values', () => {
    const c = new LruCache<string>(3);
    c.set(1, 'a');
    c.set(2, 'b');
    expect(c.get(1)).toBe('a');
    expect(c.get(2)).toBe('b');
    expect(c.has(1)).toBe(true);
    expect(c.has(99)).toBe(false);
  });

  it('evicts LRU entry when capacity is exceeded', () => {
    const c = new LruCache<string>(3);
    c.set(1, 'a');
    c.set(2, 'b');
    c.set(3, 'c');
    // Access 1 to make it MRU; 2 becomes LRU.
    c.get(1);
    c.set(4, 'd'); // should evict 2
    expect(c.has(2)).toBe(false);
    expect(c.has(1)).toBe(true);
    expect(c.has(3)).toBe(true);
    expect(c.has(4)).toBe(true);
  });

  it('updates existing entry and moves it to MRU', () => {
    const c = new LruCache<string>(2);
    c.set(1, 'a');
    c.set(2, 'b');
    c.set(1, 'a2'); // update — should move 1 to MRU, so 2 becomes LRU
    c.set(3, 'c'); // evicts 2
    expect(c.has(2)).toBe(false);
    expect(c.get(1)).toBe('a2');
  });

  it('reports correct size', () => {
    const c = new LruCache<number>(10);
    expect(c.size).toBe(0);
    c.set(1, 1);
    c.set(2, 2);
    expect(c.size).toBe(2);
    c.clear();
    expect(c.size).toBe(0);
  });
});

// ---- column auto-detection -----------------------------------------------------------

const cols = (specs: { name: string; kind: string }[]) =>
  specs.map((s, i) => ({ index: i, name: s.name, kind: s.kind }));

describe('detectTitleColumn', () => {
  it('prefers column named "title"', () => {
    const c = cols([
      { name: 'id', kind: 'numeric' },
      { name: 'title', kind: 'categorical' },
      { name: 'label', kind: 'categorical' },
    ]);
    expect(detectTitleColumn(c)).toBe(1);
  });

  it('falls back to "name", "label", "text" in order', () => {
    expect(detectTitleColumn(cols([{ name: 'name', kind: 'categorical' }]))).toBe(0);
    expect(detectTitleColumn(cols([{ name: 'label', kind: 'categorical' }]))).toBe(0);
    expect(detectTitleColumn(cols([{ name: 'text', kind: 'categorical' }]))).toBe(0);
  });

  it('falls back to first text/categorical column', () => {
    const c = cols([
      { name: 'x', kind: 'numeric' },
      { name: 'desc', kind: 'other' },
    ]);
    expect(detectTitleColumn(c)).toBe(1);
  });

  it('returns null when no text columns exist', () => {
    expect(detectTitleColumn(cols([{ name: 'x', kind: 'numeric' }]))).toBeNull();
  });
});

describe('detectLinkColumn', () => {
  it('detects url/link/href/uri in column name', () => {
    expect(detectLinkColumn(cols([{ name: 'page_url', kind: 'categorical' }]))).toBe(0);
    expect(detectLinkColumn(cols([{ name: 'link', kind: 'categorical' }]))).toBe(0);
    expect(detectLinkColumn(cols([{ name: 'href', kind: 'categorical' }]))).toBe(0);
    expect(detectLinkColumn(cols([{ name: 'source_uri', kind: 'categorical' }]))).toBe(0);
  });

  it('returns null when no link column', () => {
    expect(detectLinkColumn(cols([{ name: 'title', kind: 'categorical' }]))).toBeNull();
  });
});

describe('detectImageUrlColumn', () => {
  it('detects image/img/photo/picture/thumbnail/thumb in name', () => {
    expect(detectImageUrlColumn(cols([{ name: 'image_path', kind: 'categorical' }]))).toBe(0);
    expect(detectImageUrlColumn(cols([{ name: 'thumbnail_url', kind: 'categorical' }]))).toBe(0);
    expect(detectImageUrlColumn(cols([{ name: 'photo', kind: 'categorical' }]))).toBe(0);
  });

  it('returns null when no image column', () => {
    expect(detectImageUrlColumn(cols([{ name: 'title', kind: 'categorical' }]))).toBeNull();
  });
});

// ---- link validation -----------------------------------------------------------------

describe('isValidLink', () => {
  it('accepts http, https, mailto', () => {
    expect(isValidLink('https://example.com')).toBe(true);
    expect(isValidLink('http://foo.bar/baz')).toBe(true);
    expect(isValidLink('mailto:a@b.com')).toBe(true);
  });

  it('rejects other schemes and empty strings', () => {
    expect(isValidLink('')).toBe(false);
    expect(isValidLink('ftp://files.example.com')).toBe(false);
    expect(isValidLink('javascript:alert(1)')).toBe(false);
    expect(isValidLink('file:///etc/passwd')).toBe(false);
  });
});

// ---- TextsStore lazy decoding --------------------------------------------------------

describe('TextsStore', () => {
  it('returns null before loading', () => {
    const s = new TextsStore();
    expect(s.ready).toBe(false);
    expect(s.get(0)).toBeNull();
  });

  it('decodes strings from UTF-8 blob and u32 offsets', async () => {
    const strings = ['hello', 'world', ''];
    // Build UTF-8 blob and offsets.
    const enc = new TextEncoder();
    const parts = strings.map((s) => enc.encode(s));
    const totalBytes = parts.reduce((acc, p) => acc + p.length, 0);
    const utf8 = new Uint8Array(totalBytes);
    const offsets = new Uint32Array(strings.length + 1);
    let offset = 0;
    for (let i = 0; i < parts.length; i++) {
      offsets[i] = offset;
      utf8.set(parts[i], offset);
      offset += parts[i].length;
    }
    offsets[strings.length] = offset;

    // Create Blob URLs from the two typed arrays.
    const utf8Blob = URL.createObjectURL(new Blob([utf8]));
    const offBlob = URL.createObjectURL(new Blob([offsets]));

    const store = new TextsStore();
    const ok = await store.load(utf8Blob, offBlob);
    expect(ok).toBe(true);
    expect(store.ready).toBe(true);
    expect(store.get(0)).toBe('hello');
    expect(store.get(1)).toBe('world');
    expect(store.get(2)).toBe('');

    URL.revokeObjectURL(utf8Blob);
    URL.revokeObjectURL(offBlob);

    store.clear();
    expect(store.ready).toBe(false);
    expect(store.get(0)).toBeNull();
  });
});
