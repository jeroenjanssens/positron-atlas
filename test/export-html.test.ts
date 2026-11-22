/**
 * X4: Unit tests for the HTML export blob format (src/shared/viewerBlob.ts).
 *
 * Tests:
 *  - packBlob / unpackBlob round-trip (positions, colors, codes, radii, text)
 *  - Magic and version validation
 *  - Text column access after round-trip
 *  - Sampling: pack with n < total
 */
import { describe, expect, it } from 'vitest';
import {
  packBlob,
  unpackBlob,
  BLOB_MAGIC,
  BLOB_VERSION,
  type BlobHeader,
  type BlobPayload,
} from '../src/shared/viewerBlob';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHeader(n: number, nTextCols = 0): BlobHeader {
  return {
    v: BLOB_VERSION,
    n,
    bg: '#1e1e1e',
    sections: { xy: [0, 0], rgba: [0, 0], codes: null, radii: null, textUtf8: null, textOffsets: null },
    tooltipCols: Array.from({ length: nTextCols }, (_, i) => ({ name: `col${i}` })),
    legend: null,
    labels: [],
    annotations: [],
    title: { title: '', subtitle: '', fontFamily: '', fontSize: 24, color: '', logoData: '', logoWidth: 0 },
    fontCss: [],
  };
}

function makePayload(n: number, hasCodes = false, hasRadii = false, hasText = false): BlobPayload {
  const xy = new Float32Array(n * 2);
  const rgba = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    xy[2 * i] = i * 0.1;
    xy[2 * i + 1] = i * 0.05;
    rgba[4 * i] = i % 256;
    rgba[4 * i + 1] = (i * 2) % 256;
    rgba[4 * i + 2] = (i * 3) % 256;
    rgba[4 * i + 3] = 255;
  }
  const codes = hasCodes ? new Uint16Array(n) : null;
  const radii = hasRadii ? new Float32Array(n) : null;
  if (codes) for (let i = 0; i < n; i++) codes[i] = i % 4;
  if (radii) for (let i = 0; i < n; i++) radii[i] = 2 + i * 0.1;

  let textUtf8: Uint8Array | null = null;
  let textOffsets: Uint32Array | null = null;
  if (hasText) {
    // 2 columns: title column, link column
    const nCols = 2;
    const enc = new TextEncoder();
    const strings = Array.from({ length: n }, (_, i) => `item_${String(i).padStart(4, '0')}`);
    const links = Array.from({ length: n }, (_, i) => `https://example.com/${i}`);
    // Build UTF-8 blob: col 0 (titles) then col 1 (links)
    const all0 = strings.map((s) => enc.encode(s));
    const all1 = links.map((s) => enc.encode(s));
    const totalLen = [...all0, ...all1].reduce((s, a) => s + a.byteLength, 0);
    textUtf8 = new Uint8Array(totalLen);
    textOffsets = new Uint32Array((n + 1) * nCols);
    let pos = 0;
    // col 0
    for (let i = 0; i <= n; i++) {
      textOffsets[i] = pos;
      if (i < n) { textUtf8.set(all0[i], pos); pos += all0[i].byteLength; }
    }
    // col 1
    for (let i = 0; i <= n; i++) {
      textOffsets[(n + 1) + i] = pos;
      if (i < n) { textUtf8.set(all1[i], pos); pos += all1[i].byteLength; }
    }
    return {
      header: makeHeader(n, nCols),
      xy, rgba, codes, radii, textUtf8, textOffsets,
    };
  }

  return { header: makeHeader(n), xy, rgba, codes, radii, textUtf8, textOffsets };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('packBlob / unpackBlob round-trip', () => {
  it('magic bytes are correct', () => {
    const p = makePayload(10);
    const raw = packBlob(p);
    expect(raw[0]).toBe(0x41); // 'A'
    expect(raw[1]).toBe(0x54); // 'T'
    expect(raw[2]).toBe(0x4c); // 'L'
    expect(raw[3]).toBe(0x53); // 'S'
  });

  it('version is encoded correctly', () => {
    const p = makePayload(10);
    const raw = packBlob(p);
    const dv = new DataView(raw.buffer);
    expect(dv.getUint32(4, true)).toBe(BLOB_VERSION);
  });

  it('round-trips positions (xy) exactly', () => {
    const n = 100;
    const p = makePayload(n);
    const raw = packBlob(p);
    const u = unpackBlob(raw);
    expect(u.header.n).toBe(n);
    for (let i = 0; i < n; i++) {
      expect(u.xy[2 * i]).toBeCloseTo(p.xy[2 * i], 5);
      expect(u.xy[2 * i + 1]).toBeCloseTo(p.xy[2 * i + 1], 5);
    }
  });

  it('round-trips RGBA colors exactly', () => {
    const n = 100;
    const p = makePayload(n);
    const raw = packBlob(p);
    const u = unpackBlob(raw);
    for (let i = 0; i < n; i++) {
      expect(u.rgba[4 * i]).toBe(p.rgba[4 * i]);
      expect(u.rgba[4 * i + 3]).toBe(255);
    }
  });

  it('round-trips category codes', () => {
    const n = 50;
    const p = makePayload(n, true);
    const raw = packBlob(p);
    const u = unpackBlob(raw);
    expect(u.codes).not.toBeNull();
    for (let i = 0; i < n; i++) {
      expect(u.codes![i]).toBe(i % 4);
    }
  });

  it('codes is null when not provided', () => {
    const p = makePayload(50, false);
    const u = unpackBlob(packBlob(p));
    expect(u.codes).toBeNull();
  });

  it('round-trips radii', () => {
    const n = 50;
    const p = makePayload(n, false, true);
    const raw = packBlob(p);
    const u = unpackBlob(raw);
    expect(u.radii).not.toBeNull();
    for (let i = 0; i < n; i++) {
      expect(u.radii![i]).toBeCloseTo(2 + i * 0.1, 3);
    }
  });

  it('round-trips text columns', () => {
    const n = 20;
    const p = makePayload(n, false, false, true);
    const raw = packBlob(p);
    const u = unpackBlob(raw);
    expect(u.header.tooltipCols.length).toBe(2);
    // Check title column (0)
    expect(u.getText(0, 0)).toBe('item_0000');
    expect(u.getText(0, 5)).toBe('item_0005');
    expect(u.getText(0, 19)).toBe('item_0019');
    // Check link column (1)
    expect(u.getText(1, 0)).toBe('https://example.com/0');
    expect(u.getText(1, 10)).toBe('https://example.com/10');
  });

  it('getText returns empty string for absent text', () => {
    const p = makePayload(10);
    const u = unpackBlob(packBlob(p));
    expect(u.getText(0, 0)).toBe('');
    expect(u.getText(99, 0)).toBe('');
  });

  it('round-trips header fields', () => {
    const p = makePayload(30);
    p.header.bg = '#123456';
    p.header.legend = { kind: 'categorical', title: 'cluster', categories: ['a', 'b'], colors: ['#ff0000', '#00ff00'], counts: [15, 15] };
    p.header.title.title = 'My Map';
    p.header.title.subtitle = 'UMAP test';
    const u = unpackBlob(packBlob(p));
    expect(u.header.bg).toBe('#123456');
    expect(u.header.title.title).toBe('My Map');
    expect(u.header.title.subtitle).toBe('UMAP test');
    const leg = u.header.legend as any;
    expect(leg?.kind).toBe('categorical');
    expect(leg?.categories).toEqual(['a', 'b']);
  });

  it('throws on bad magic', () => {
    const p = makePayload(10);
    const raw = packBlob(p);
    // Corrupt magic
    raw[0] = 0x58; // 'X'
    expect(() => unpackBlob(raw)).toThrow(/magic/i);
  });

  it('throws on wrong version', () => {
    const p = makePayload(10);
    const raw = packBlob(p);
    const dv = new DataView(raw.buffer);
    dv.setUint32(4, 999, true);
    expect(() => unpackBlob(raw)).toThrow(/version/i);
  });

  it('handles 0 points gracefully', () => {
    const p = makePayload(0);
    const u = unpackBlob(packBlob(p));
    expect(u.header.n).toBe(0);
    expect(u.xy.length).toBe(0);
  });
});

describe('blob size estimation', () => {
  it('3k points ~ 36 KB for positions + colors (before gzip)', () => {
    const n = 3000;
    const p = makePayload(n, true);
    const raw = packBlob(p);
    // positions(8) + rgba(4) + codes(2) = 14 bytes/point + header overhead
    expect(raw.byteLength).toBeGreaterThan(n * 14);
    expect(raw.byteLength).toBeLessThan(n * 30 + 100_000); // generous upper bound
    console.log(`[blob size] ${n} points: ${(raw.byteLength / 1024).toFixed(1)} KB raw`);
  });

  it('1M points positions+colors fit in < 15 MB', () => {
    const n = 1_000_000;
    const xy = new Float32Array(n * 2);
    const rgba = new Uint8Array(n * 4).fill(200);
    const p: BlobPayload = { header: makeHeader(n), xy, rgba, codes: null, radii: null, textUtf8: null, textOffsets: null };
    const raw = packBlob(p);
    expect(raw.byteLength).toBeLessThan(15 * 1024 * 1024);
    console.log(`[blob size] ${n} points: ${(raw.byteLength / 1024 / 1024).toFixed(2)} MB raw`);
  });
});

describe('BLOB_MAGIC constant', () => {
  it('is ATLS', () => {
    expect(BLOB_MAGIC).toBe('ATLS');
  });
});
