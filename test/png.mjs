// Minimal PNG decoder for tests (no dependencies): RGB and RGBA, 8-bit, filter types 0–4.
// Used by the browser harness (test/harness/shot.mjs) and the Positron e2e runner.
import { inflateSync } from 'node:zlib';

export function parsePngToRgba(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('Not a PNG');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  let pos = 8, w = 0, h = 0, channels = 4;
  const idatBufs = [];
  while (pos + 12 <= buf.length) {
    const len = dv.getUint32(pos, false);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    if (type === 'IHDR') {
      w = dv.getUint32(pos + 8, false);
      h = dv.getUint32(pos + 12, false);
      channels = buf[pos + 17] === 6 ? 4 : 3; // 6=RGBA 2=RGB
    } else if (type === 'IDAT') {
      idatBufs.push(buf.slice(pos + 8, pos + 8 + len));
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idatBufs));
  const rowBytes = w * channels;
  const out = new Uint8Array(w * h * channels);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const rowBase = y * (1 + rowBytes);
    const ft = raw[rowBase];
    const src = raw.subarray(rowBase + 1, rowBase + 1 + rowBytes);
    const dst = out.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prev = y > 0 ? out.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= channels ? dst[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = x >= channels && prev ? prev[x - channels] : 0;
      dst[x] = (src[x] + (ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? b : ft === 3 ? (a + b) >> 1 : paeth(a, b, c))) & 0xFF;
    }
  }
  return { w, h, channels, data: out };
}

/** Pixels that differ from the corner pixel (the background) by more than `threshold` per channel sum. */
export function drawnPixels(png, threshold = 60) {
  const { data, channels } = png;
  const [r0, g0, b0] = [data[0], data[1], data[2]];
  let n = 0;
  for (let k = 0; k < data.length; k += channels) {
    if (Math.abs(data[k] - r0) + Math.abs(data[k + 1] - g0) + Math.abs(data[k + 2] - b0) > threshold) n++;
  }
  return n;
}
