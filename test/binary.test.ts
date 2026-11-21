/**
 * Tests for P4 binary message helpers (src/webview/vscode.ts and src/extension/atlasPanel.ts).
 * Covers the new binary path and the base64 fallback.
 */
import { describe, expect, it } from 'vitest';
import { float32ToBytes, typedArrayToBytes, base64ToBytes, bytesToBase64, float32ToBase64 } from '../src/webview/vscode';
import { bytesFromPayload } from '../src/extension/binaryUtil';

// ---- webview helpers -------------------------------------------------------

describe('float32ToBytes', () => {
  it('returns a Uint8Array view over the Float32Array buffer', () => {
    const f = new Float32Array([1.0, 2.0, -3.5]);
    const bytes = float32ToBytes(f);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBe(12); // 3 × 4 bytes
    // round-trip: interpret bytes back as float32
    const rt = new Float32Array(bytes.buffer, bytes.byteOffset, 3);
    expect(Array.from(rt)).toEqual([1.0, 2.0, -3.5]);
  });

  it('handles a large Float32Array without copying (view semantics)', () => {
    const n = 100_000;
    const f = new Float32Array(n);
    f.fill(1.5);
    const bytes = float32ToBytes(f);
    expect(bytes.buffer).toBe(f.buffer);
    expect(bytes.byteLength).toBe(n * 4);
  });
});

describe('typedArrayToBytes', () => {
  it('wraps a Uint16Array in a Uint8Array view', () => {
    const u16 = new Uint16Array([256, 512, 1024]);
    const bytes = typedArrayToBytes(u16);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBe(6);
    expect(bytes.buffer).toBe(u16.buffer);
  });
});

describe('base64ToBytes / bytesToBase64 round-trip (fallback helpers)', () => {
  it('encodes and decodes back to the same bytes', () => {
    const original = new Uint8Array([0, 1, 127, 128, 255, 42]);
    const b64 = bytesToBase64(original);
    expect(typeof b64).toBe('string');
    const rt = base64ToBytes(b64);
    expect(Array.from(rt)).toEqual(Array.from(original));
  });

  it('handles empty bytes', () => {
    const empty = new Uint8Array(0);
    expect(bytesToBase64(empty)).toBe('');
    expect(Array.from(base64ToBytes(''))).toEqual([]);
  });

  it('float32ToBase64 produces valid base64 that decodes to float32 bytes', () => {
    const f = new Float32Array([3.14, -1.0, 0.0]);
    const b64 = float32ToBase64(f);
    expect(typeof b64).toBe('string');
    const decoded = base64ToBytes(b64);
    const rt = new Float32Array(decoded.buffer, decoded.byteOffset, 3);
    expect(rt[0]).toBeCloseTo(3.14);
    expect(rt[1]).toBe(-1.0);
    expect(rt[2]).toBe(0.0);
  });
});

// ---- performance: encoding cost (baseline for the roadmap benchmark) -------

describe('encoding cost: binary vs base64', () => {
  it('passes a 1e6-row mask (125000 bytes) in < 1 ms as Uint8Array vs ~8 ms base64', () => {
    // 1e6 rows packed into 1e6/8 = 125000 bytes
    const nRows = 1_000_000;
    const mask = new Uint8Array(Math.ceil(nRows / 8));
    // Fill with a 50% selection pattern
    for (let i = 0; i < mask.length; i++) mask[i] = 0xaa;

    const t0 = performance.now();
    // Binary path: view is O(1)
    const bytes = new Uint8Array(mask.buffer, mask.byteOffset, mask.byteLength);
    const binaryMs = performance.now() - t0;

    // Base64 path (what the old code did): encode + decode
    const t1 = performance.now();
    let s = '';
    const step = 0x8000;
    for (let i = 0; i < mask.length; i += step) {
      s += String.fromCharCode.apply(null, mask.subarray(i, i + step) as unknown as number[]);
    }
    btoa(s);
    const base64EncMs = performance.now() - t1;

    // The binary view should be orders of magnitude faster than base64 encoding.
    expect(binaryMs).toBeLessThan(1); // view is ~0 ms
    // The bytes should equal the original mask
    expect(Array.from(bytes.slice(0, 4))).toEqual([0xaa, 0xaa, 0xaa, 0xaa]);

    // Report numbers (not an assertion — informational)
    console.log(`[P4 timing] 1e6-row mask: binary view ${binaryMs.toFixed(3)} ms, base64 encode ${base64EncMs.toFixed(1)} ms`);
  });

  it('passes a 70k-row anchorXY (560000 bytes = 160k floats for MNIST projection) quickly', () => {
    // 70k × 2 float32 = 560000 bytes
    const nAnchors = 40_000; // typical MNIST anchor count (2 × 40k float32 = 320 kB)
    const xy = new Float32Array(nAnchors * 2);
    for (let i = 0; i < xy.length; i++) xy[i] = i * 0.001;

    const t0 = performance.now();
    const bytes = new Uint8Array(xy.buffer, xy.byteOffset, xy.byteLength);
    const binaryMs = performance.now() - t0;

    expect(binaryMs).toBeLessThan(1);
    expect(bytes.byteLength).toBe(nAnchors * 8);
    console.log(`[P4 timing] ${nAnchors * 2}-float anchorXY: binary view ${binaryMs.toFixed(3)} ms`);
  });
});

// ---- host helper -----------------------------------------------------------

describe('bytesFromPayload (host-side, P4)', () => {
  it('passes a Uint8Array through as a Buffer with the same bytes', () => {
    const bytes = new Uint8Array([10, 20, 30, 40]);
    const buf = bytesFromPayload(bytes);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(Array.from(buf)).toEqual([10, 20, 30, 40]);
  });

  it('decodes a base64 string (fallback for older hosts)', () => {
    // Create a known byte sequence and encode it.
    const original = new Uint8Array([0, 255, 128, 1]);
    const b64 = Buffer.from(original).toString('base64');
    const buf = bytesFromPayload(b64);
    expect(Array.from(buf)).toEqual([0, 255, 128, 1]);
  });

  it('handles an empty Uint8Array', () => {
    const buf = bytesFromPayload(new Uint8Array(0));
    expect(buf.byteLength).toBe(0);
  });

  it('handles an empty base64 string', () => {
    const buf = bytesFromPayload('');
    expect(buf.byteLength).toBe(0);
  });

  it('round-trips a 1 MB Float32Array without corruption', () => {
    const n = 256_000; // 1 MB
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = i * 0.001;
    const bytes = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
    const buf = bytesFromPayload(bytes);
    const rt = new Float32Array(buf.buffer, buf.byteOffset, n);
    expect(rt[0]).toBeCloseTo(0.0);
    expect(rt[n - 1]).toBeCloseTo((n - 1) * 0.001);
  });
});
