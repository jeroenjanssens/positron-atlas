/**
 * A12 — Glow: per-cluster blurred density halo rendered under the points.
 *
 * Strategy: draw all anchor positions (or the down-sampled all-points array)
 * onto an offscreen low-res canvas using their category colours, then scale
 * and blur that canvas onto a full-resolution output canvas.  The output
 * canvas is composited over deck.gl (z-index: 2) using normal alpha compositing.
 *
 * Performance notes
 * -----------------
 * - Works at 1/4 viewport resolution → ~75 k pixels for a 1 400 × 860 window.
 * - Uses ImageData writes (one pass through the point array) instead of
 *   per-point draw calls to avoid canvas2D call overhead.
 * - Additive colour accumulation per pixel; RGB values are clamped to 255.
 * - The CSS `filter: blur(Xpx)` is applied by drawing the low-res canvas
 *   onto the output canvas (the browser applies the filter during drawImage).
 * - Re-renders only when `atlas.glowVersion` increments.
 */

/** Render the glow to a HTMLCanvasElement. */
export function renderGlow(
  canvas: HTMLCanvasElement,
  anchorXY: Float32Array,
  nPoints: number,
  /** Per-point u16 category code (same length as positions / 2). Pass null to use rgbaPerPoint. */
  codes: Uint16Array | null,
  /** Hex colors per category (e.g. '#e45678'). null entries → grey. Ignored when rgbaPerPoint is set. */
  colors: (string | null)[],
  projectFn: (wx: number, wy: number) => [number, number] | null,
  strength: number,   // 0–1, applied as global alpha
  blurRadius: number, // CSS pixels for the blur filter
  viewW: number,
  viewH: number,
  /** Optional raw RGBA per anchor point (Uint8Array, 4 bytes per point). When set, overrides codes/colors. */
  rgbaPerPoint?: Uint8Array | null,
): void {
  if (nPoints === 0 || viewW <= 0 || viewH <= 0) {
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  // Downscale factor: 1/4 resolution keeps things fast.
  const scale = 0.25;
  const lw = Math.max(1, Math.floor(viewW * scale));
  const lh = Math.max(1, Math.floor(viewH * scale));

  // ---- Build ImageData at low resolution using additive blending ---------------
  // Use Uint16Array to accumulate without clamping, then scale down.
  const rawR = new Uint16Array(lw * lh);
  const rawG = new Uint16Array(lw * lh);
  const rawB = new Uint16Array(lw * lh);
  const rawN = new Uint16Array(lw * lh);

  // Pre-parse category colors once (only used when codes + colors path is taken).
  const useCatColors = !rgbaPerPoint && colors.length > 0;
  const catR: Uint8Array = new Uint8Array(useCatColors ? colors.length : 0);
  const catG: Uint8Array = new Uint8Array(useCatColors ? colors.length : 0);
  const catB: Uint8Array = new Uint8Array(useCatColors ? colors.length : 0);
  if (useCatColors) {
    for (let c = 0; c < colors.length; c++) {
      const hex = colors[c];
      if (hex && hex.length === 7 && hex[0] === '#') {
        catR[c] = parseInt(hex.slice(1, 3), 16);
        catG[c] = parseInt(hex.slice(3, 5), 16);
        catB[c] = parseInt(hex.slice(5, 7), 16);
      } else {
        catR[c] = 160; catG[c] = 160; catB[c] = 160;
      }
    }
  }

  // For sparse point sets (e.g. 3 k points), each point covers only ~1 pixel in the
  // 1/4-scale canvas, leaving ~95 % of pixels empty.  The subsequent blur then spreads
  // an extremely thin alpha that is nearly invisible.  To fix this we write each point
  // to a small neighbourhood so that cluster regions reach near-full coverage before
  // the blur is applied.  Denser sets already have enough coverage from raw counts alone.
  const spread = nPoints > 100_000 ? 1 : nPoints > 10_000 ? 2 : 3;

  for (let i = 0; i < nPoints; i++) {
    const wx = anchorXY[2 * i];
    const wy = anchorXY[2 * i + 1];
    const pt = projectFn(wx, wy);
    if (!pt) continue;
    const cx = Math.floor(pt[0] * scale);
    const cy = Math.floor(pt[1] * scale);

    let pr: number, pg: number, pb: number;
    if (rgbaPerPoint && i * 4 + 3 < rgbaPerPoint.length) {
      pr = rgbaPerPoint[4 * i];
      pg = rgbaPerPoint[4 * i + 1];
      pb = rgbaPerPoint[4 * i + 2];
    } else {
      const code = codes ? codes[i] : 0;
      const c = useCatColors ? (code < colors.length ? code : 0) : 0;
      pr = useCatColors ? catR[c] : 160;
      pg = useCatColors ? catG[c] : 160;
      pb = useCatColors ? catB[c] : 160;
    }

    const half = Math.floor(spread / 2);
    for (let dy = 0; dy < spread; dy++) {
      for (let dx = 0; dx < spread; dx++) {
        const sx = cx + dx - half;
        const sy = cy + dy - half;
        if (sx < 0 || sx >= lw || sy < 0 || sy >= lh) continue;
        const idx = sy * lw + sx;
        rawR[idx] += pr;
        rawG[idx] += pg;
        rawB[idx] += pb;
        rawN[idx]++;
      }
    }
  }

  // Build the RGBA ImageData: mean colour per pixel, then set alpha.
  const imgData = new Uint8ClampedArray(lw * lh * 4);
  for (let i = 0; i < lw * lh; i++) {
    const n = rawN[i];
    if (n === 0) continue;
    imgData[4 * i]     = Math.min(255, rawR[i] / n);
    imgData[4 * i + 1] = Math.min(255, rawG[i] / n);
    imgData[4 * i + 2] = Math.min(255, rawB[i] / n);
    imgData[4 * i + 3] = 255;
  }

  // ---- Draw to offscreen canvas and blur onto the output canvas ----------------
  const src = document.createElement('canvas');
  src.width = lw;
  src.height = lh;
  const srcCtx = src.getContext('2d')!;
  srcCtx.putImageData(new ImageData(imgData, lw, lh), 0, 0);

  // Set up output canvas.
  canvas.width = viewW;
  canvas.height = viewH;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, viewW, viewH);
  ctx.globalAlpha = Math.max(0, Math.min(1, strength));
  // The blur is applied by drawImage when a filter is set on the destination ctx.
  ctx.filter = `blur(${Math.round(blurRadius)}px)`;
  ctx.drawImage(src, 0, 0, viewW, viewH);
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
}

/**
 * Render the glow to a CanvasRenderingContext2D for PNG export.
 * Accepts physical (device-pixel) dimensions.
 */
export function renderGlowToCtx(
  ctx: CanvasRenderingContext2D,
  anchorXY: Float32Array,
  nPoints: number,
  codes: Uint16Array | null,
  colors: (string | null)[],
  projectFn: (wx: number, wy: number) => [number, number] | null,
  strength: number,
  blurRadius: number,
  physW: number,
  physH: number,
  dpr: number,
): void {
  const dummy = document.createElement('canvas');
  renderGlow(dummy, anchorXY, nPoints, codes, colors,
    (wx, wy) => {
      const pt = projectFn(wx, wy);
      return pt ? [pt[0] * dpr, pt[1] * dpr] : null;
    },
    strength, blurRadius * dpr, physW, physH);
  if (dummy.width > 0 && dummy.height > 0) {
    ctx.drawImage(dummy, 0, 0);
  }
}
