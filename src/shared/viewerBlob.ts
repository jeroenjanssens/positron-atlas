/**
 * Binary blob format for the HTML export viewer (X1/X2).
 *
 * Layout on disk (before gzip):
 *   Bytes 0–3   : magic "ATLS"
 *   Bytes 4–7   : version u32le = 1
 *   Bytes 8–11  : headerLen u32le (byte length of JSON header)
 *   Bytes 12…   : JSON header UTF-8 (headerLen bytes)
 *   Bytes 12+headerLen…: concatenated binary sections described by header.sections
 *
 * All multi-byte integers and floats are little-endian.
 */

export const BLOB_MAGIC = 'ATLS';
export const BLOB_VERSION = 1;

/** Describes the offset + byteLength of one binary section within the blob's data region. */
export type SectionRef = [offset: number, byteLength: number];

/** Tooltip column descriptor (one column of text per point). */
export interface TooltipColumn {
  /** Column name shown in the tooltip. */
  name: string;
  /** True when links in this column should open in a new tab. */
  isLink?: boolean;
  /** True when this is the primary title column. */
  isTitle?: boolean;
}

/** Placed map label. */
export interface BlobLabel {
  text: string;
  x: number;
  y: number;
  size: number;
  color: [number, number, number, number];
  priority: number;
  weight?: number;
  badge?: [number, number, number, number];
}

/** Legend descriptor: null = no legend, or categorical/numeric. */
export type BlobLegend =
  | null
  | {
      kind: 'categorical';
      title: string;
      categories: string[];
      colors: string[];
      counts: number[];
    }
  | {
      kind: 'numeric';
      title: string;
      colormap: string;
      min: number;
      max: number;
      nullColor?: string;
    };

/** Annotation embedded in the blob. */
export interface BlobAnnotation {
  id: string;
  text: string;
  style: 'plain' | 'badge' | 'image';
  worldX: number;
  worldY: number;
  offsetX: number;
  offsetY: number;
  color?: string;
  imageDataUrl?: string;
}

/** Title overlay. */
export interface BlobTitle {
  title: string;
  subtitle: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  logoData: string;
  logoWidth: number;
}

/** JSON header embedded in the blob (before the binary sections). */
export interface BlobHeader {
  v: number;
  /** Total number of points. */
  n: number;
  /** Plot background color. */
  bg: string;
  /**
   * Section refs relative to the start of the data region (after the JSON header).
   * Each value is [offset, byteLength] or null if that section is absent.
   */
  sections: {
    /** f32[n*2]: interleaved x,y per point. */
    xy: SectionRef;
    /** u8[n*4]: RGBA per point (pre-computed, including hidden-category fade). */
    rgba: SectionRef;
    /** u16[n]: category code per point for legend filter. 0xFFFF = no code. */
    codes: SectionRef | null;
    /** f32[n]: per-point radius override. Absent = uniform. */
    radii: SectionRef | null;
    /**
     * UTF-8 blob for tooltip text: columns concatenated, offsets in textOffsets.
     * Absent when no tooltip text is embedded.
     */
    textUtf8: SectionRef | null;
    /**
     * u32[(n+1) * nTextCols] offsets into textUtf8.
     * Layout: for column c, point i: start = offsets[c*(n+1)+i], end = offsets[c*(n+1)+i+1].
     */
    textOffsets: SectionRef | null;
  };
  tooltipCols: TooltipColumn[];
  legend: BlobLegend;
  labels: BlobLabel[];
  annotations: BlobAnnotation[];
  title: BlobTitle;
  /** @font-face CSS strings with embedded data-URL sources. */
  fontCss: string[];
  /** Sampling info (informational, not rendered). */
  sample?: { n: number; total: number; pct: number };
}

// ---------------------------------------------------------------------------
// Pack helpers
// ---------------------------------------------------------------------------

export interface BlobPayload {
  header: BlobHeader;
  xy: Float32Array;
  rgba: Uint8Array;
  codes: Uint16Array | null;
  radii: Float32Array | null;
  textUtf8: Uint8Array | null;
  textOffsets: Uint32Array | null;
}

/** Assemble all parts into a single Uint8Array ready for gzip. */
export function packBlob(p: BlobPayload): Uint8Array {
  const enc = new TextEncoder();

  // 1. Build sections data buffer
  const sections: Uint8Array[] = [
    new Uint8Array(p.xy.buffer, p.xy.byteOffset, p.xy.byteLength),
    new Uint8Array(p.rgba.buffer, p.rgba.byteOffset, p.rgba.byteLength),
  ];
  const offsets: number[] = [0];
  for (const s of sections) offsets.push(offsets[offsets.length - 1] + s.byteLength);

  const xyRef: SectionRef = [offsets[0], sections[0].byteLength];
  const rgbaRef: SectionRef = [offsets[1], sections[1].byteLength];
  let codesRef: SectionRef | null = null;
  let radiiRef: SectionRef | null = null;
  let textUtf8Ref: SectionRef | null = null;
  let textOffsetsRef: SectionRef | null = null;

  if (p.codes) {
    const bytes = new Uint8Array(p.codes.buffer, p.codes.byteOffset, p.codes.byteLength);
    codesRef = [offsets[offsets.length - 1], bytes.byteLength];
    offsets.push(offsets[offsets.length - 1] + bytes.byteLength);
    sections.push(bytes);
  }
  if (p.radii) {
    const bytes = new Uint8Array(p.radii.buffer, p.radii.byteOffset, p.radii.byteLength);
    radiiRef = [offsets[offsets.length - 1], bytes.byteLength];
    offsets.push(offsets[offsets.length - 1] + bytes.byteLength);
    sections.push(bytes);
  }
  if (p.textUtf8) {
    textUtf8Ref = [offsets[offsets.length - 1], p.textUtf8.byteLength];
    offsets.push(offsets[offsets.length - 1] + p.textUtf8.byteLength);
    sections.push(p.textUtf8);
  }
  if (p.textOffsets) {
    const bytes = new Uint8Array(p.textOffsets.buffer, p.textOffsets.byteOffset, p.textOffsets.byteLength);
    textOffsetsRef = [offsets[offsets.length - 1], bytes.byteLength];
    sections.push(bytes);
  }

  // 2. Build complete header JSON
  const header: BlobHeader = {
    ...p.header,
    sections: {
      xy: xyRef,
      rgba: rgbaRef,
      codes: codesRef,
      radii: radiiRef,
      textUtf8: textUtf8Ref,
      textOffsets: textOffsetsRef,
    },
  };
  const headerJson = enc.encode(JSON.stringify(header));

  // 3. Assemble: 4 magic + 4 version + 4 headerLen + header + sections
  const totalSectionBytes = sections.reduce((s, a) => s + a.byteLength, 0);
  const total = 12 + headerJson.byteLength + totalSectionBytes;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out[0] = 0x41; out[1] = 0x54; out[2] = 0x4c; out[3] = 0x53; // "ATLS"
  dv.setUint32(4, BLOB_VERSION, true);
  dv.setUint32(8, headerJson.byteLength, true);
  out.set(headerJson, 12);
  let pos = 12 + headerJson.byteLength;
  for (const s of sections) {
    out.set(s, pos);
    pos += s.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unpack helpers
// ---------------------------------------------------------------------------

export interface UnpackedBlob {
  header: BlobHeader;
  xy: Float32Array;
  rgba: Uint8Array;
  codes: Uint16Array | null;
  radii: Float32Array | null;
  /** Decoded text for one point, all columns. Returns '' when absent. */
  getText(col: number, i: number): string;
}

/** Parse a raw (not gzipped) blob Uint8Array and return structured accessors. */
export function unpackBlob(raw: Uint8Array): UnpackedBlob {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  // Magic
  const magic = String.fromCharCode(raw[0], raw[1], raw[2], raw[3]);
  if (magic !== BLOB_MAGIC) throw new Error(`Invalid blob magic: ${magic}`);
  const version = dv.getUint32(4, true);
  if (version !== BLOB_VERSION) throw new Error(`Unsupported blob version: ${version}`);
  const headerLen = dv.getUint32(8, true);
  const headerBytes = raw.subarray(12, 12 + headerLen);
  const header: BlobHeader = JSON.parse(new TextDecoder().decode(headerBytes));

  const dataStart = 12 + headerLen;

  function section(ref: SectionRef): Uint8Array {
    return raw.subarray(dataStart + ref[0], dataStart + ref[0] + ref[1]);
  }

  /** Create a typed view, copying if the offset is not properly aligned. */
  function alignedView<T extends Float32Array | Uint16Array | Uint32Array>(
    bytes: Uint8Array,
    Ctor: new (buffer: ArrayBufferLike, byteOffset: number, length: number) => T,
    elemSize: number,
  ): T {
    const len = bytes.byteLength / elemSize;
    if (bytes.byteOffset % elemSize === 0) {
      return new Ctor(bytes.buffer, bytes.byteOffset, len);
    }
    // Unaligned: copy into a new buffer
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Ctor(copy.buffer, 0, len);
  }

  const xyBytes = section(header.sections.xy);
  const rgbaBytes = section(header.sections.rgba);
  const xy = alignedView(xyBytes, Float32Array, 4);
  const rgba = rgbaBytes;
  const codes = header.sections.codes
    ? alignedView(section(header.sections.codes), Uint16Array, 2)
    : null;
  const radiiBytes = header.sections.radii ? section(header.sections.radii) : null;
  const radii = radiiBytes ? alignedView(radiiBytes, Float32Array, 4) : null;

  let textUtf8: Uint8Array | null = null;
  let textOffsets: Uint32Array | null = null;
  if (header.sections.textUtf8 && header.sections.textOffsets) {
    textUtf8 = section(header.sections.textUtf8);
    const offBytes = section(header.sections.textOffsets);
    textOffsets = alignedView(offBytes, Uint32Array, 4);
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  function getText(col: number, i: number): string {
    if (!textUtf8 || !textOffsets) return '';
    const n = header.n;
    const base = col * (n + 1);
    const start = textOffsets[base + i];
    const end = textOffsets[base + i + 1];
    if (start === end) return '';
    return decoder.decode(textUtf8.subarray(start, end));
  }

  return { header, xy, rgba, codes, radii, getText };
}

/** Collect all chunks from a ReadableStream into one Uint8Array. */
async function readAll(stream: ReadableStream): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array);
  }
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.byteLength; }
  return out;
}

/** Gzip a Uint8Array via the browser's CompressionStream. */
export async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  void writer.write(data as unknown as Uint8Array<ArrayBuffer>);
  void writer.close();
  return readAll(cs.readable);
}

/** Decompress gzipped bytes via the browser's DecompressionStream. */
export async function gunzipBytes(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  void writer.write(data as unknown as Uint8Array<ArrayBuffer>);
  void writer.close();
  return readAll(ds.readable);
}

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

/** Escape HTML special characters for safe use in an HTML attribute or text node. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Assemble the final self-contained HTML string from the viewer JS bundle and
 * the gzip+base64 encoded blob.
 */
export function buildViewerHtml(viewerJs: string, gzippedBlobBase64: string, title: string): string {
  // Prevent </script> from closing the script tag prematurely.
  const safeJs = viewerJs.replace(/<\/script>/gi, '<\\/script>');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Atlas: ${escapeHtml(title)}</title>
<style>
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #1e1e1e; overflow: hidden; }
#app { width: 100%; height: 100%; }
</style>
</head>
<body>
<div id="app"></div>
<script id="atlas-data" type="application/octet-stream">${gzippedBlobBase64}</script>
<script type="module">${safeJs}</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Base64 helpers
// ---------------------------------------------------------------------------

/** Encode Uint8Array to base64 string. */
export function uint8ToBase64(data: Uint8Array): string {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < data.length; i += step) {
    s += String.fromCharCode(...data.subarray(i, i + step));
  }
  return btoa(s);
}

/** Decode base64 string to Uint8Array. */
export function base64ToUint8(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
