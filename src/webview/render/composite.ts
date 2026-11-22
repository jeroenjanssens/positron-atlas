/**
 * PNG export compositing: draws the title overlay, leader lines and annotation
 * callout boxes on top of the deck.gl canvas (A1, A4, A11).
 *
 * All coordinates are in CSS pixels; we multiply by devicePixelRatio when drawing
 * on the physical-pixel output canvas.
 */

import type { TitleOptions, AnnotationData } from '../../shared/protocol';
import type { AroundLabel } from '../labels/around';
import { imageToRgba } from '../logic';
import type { Shape } from '../atlas/shapes';
import { shapeToPolygon } from '../atlas/shapes';

export interface CompositeOptions {
  /** CSS-pixel dimensions of the visible area. */
  cssWidth: number;
  cssHeight: number;
  /** Device pixel ratio (default: window.devicePixelRatio). */
  dpr?: number;
  /** Title overlay settings. */
  title?: TitleOptions;
  /** B4 shapes to composite onto the PNG. */
  shapes?: Shape[];
  /** B4 projectWorld function to convert map → screen coords. */
  projectWorld?: (wx: number, wy: number) => [number, number] | null;
  /** Annotations with their anchor and box screen positions (B5: box position pre-projected). */
  annotations?: Array<{ ann: AnnotationData; screenX: number; screenY: number; boxX: number; boxY: number }>;
  /** A11 around-the-map labels with screen positions (computed by computeAroundLabels). */
  aroundLabels?: AroundLabel[];
  /** A11 leader line settings. */
  leaderStyle?: 'straight' | 'curved' | 'wedge';
  leaderColor?: 'cluster' | 'grey';
  leaderWidth?: number;
  /** A11 label font family for drawing text. */
  labelFontFamily?: string;
  /** Whether to invert image thumbnails (false | true | 'auto').
   *  'auto' resolves to true when the VS Code body has class vscode-dark or vscode-high-contrast. */
  imageInvert?: boolean | 'auto';
}

/**
 * Draw the title and annotations onto an already-drawn canvas (the deck.gl output).
 * Modifies `ctx` in-place. All inputs are CSS pixels; drawing is scaled by dpr.
 * Returns a promise because logo and annotation images are loaded asynchronously.
 */
export async function compositeOverlay(ctx: CanvasRenderingContext2D, opts: CompositeOptions): Promise<void> {
  const dpr = opts.dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1);
  const invertImages = resolveInvertOption(opts.imageInvert);

  // ---- B4 Shapes ---------------------------------------------------------------
  if (opts.shapes?.length && opts.projectWorld) {
    drawShapesOnCanvas(ctx, opts.shapes, opts.projectWorld, dpr);
  }

  // ---- Title / subtitle --------------------------------------------------------
  const t = opts.title;
  if (t && (t.title.trim() || t.subtitle.trim())) {
    const titleSize = (t.fontSize || 24) * dpr;
    const subtitleSize = Math.round(titleSize * 0.6);
    const fontFamily = t.fontFamily ? `'${t.fontFamily}', sans-serif` : 'sans-serif';
    const color = t.color || '#cccccc';

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 4 * dpr;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = dpr;

    let y = (36 + titleSize / dpr) * dpr; // 36 css px top padding
    const x = 12 * dpr;

    // Draw logo if present — await decode() for reliable rendering.
    if (t.logoData) {
      const logoW = (t.logoWidth > 0 ? t.logoWidth : 48) * dpr;
      const img = new Image();
      img.src = t.logoData;
      try {
        await img.decode();
        const h = (img.naturalHeight / img.naturalWidth) * logoW;
        ctx.drawImage(img, x, (36 - h / dpr / 2) * dpr, logoW, h);
        y += h + 6 * dpr;
      } catch {
        // Logo failed to decode; skip it.
      }
    }

    if (t.title.trim()) {
      ctx.font = `700 ${titleSize}px ${fontFamily}`;
      ctx.fillStyle = color;
      ctx.fillText(t.title, x, y);
      y += (titleSize * 1.2);
    }
    if (t.subtitle.trim()) {
      ctx.font = `400 ${subtitleSize}px ${fontFamily}`;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.75;
      ctx.fillText(t.subtitle, x, y);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  // ---- Annotations (leader lines + callout boxes) ------------------------------
  const anns = opts.annotations ?? [];
  if (!anns.length) return;

  for (const { ann, screenX, screenY, boxX, boxY } of anns) {
    const ax = screenX * dpr;
    const ay = screenY * dpr;
    // B5: box position is pre-projected in world coords (worldX + offsetX, worldY + offsetY).
    const bx = boxX * dpr;
    const by = boxY * dpr;

    const badgeColor = (ann.style === 'badge' && ann.color) ? ann.color : null;
    const lineColor = badgeColor ?? 'rgba(200,200,200,0.8)';

    if (ann.style === 'image' && ann.imagePixels && ann.imageShape) {
      // ---- Pixel-column image callout ------------------------------------------
      const [imgW, imgH] = ann.imageShape;
      const rgba = imageToRgba(ann.imagePixels, imgW, imgH, false);
      const imgCanvas = document.createElement('canvas');
      imgCanvas.width = imgW;
      imgCanvas.height = imgH;
      const ig = imgCanvas.getContext('2d')!;
      ig.putImageData(new ImageData(rgba, imgW, imgH), 0, 0);

      const dispSize = 64 * dpr;
      const scale = Math.min(dispSize / imgW, dispSize / imgH);
      const dw = Math.round(imgW * scale);
      const dh = Math.round(imgH * scale);
      const pad = 4 * dpr;
      const boxW = dw + pad * 2;
      const boxH = dh + pad * 2;

      // Leader line to box center.
      ctx.save();
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([4 * dpr, 3 * dpr]);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx + boxW / 2, by + boxH / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = lineColor;
      ctx.beginPath();
      ctx.arc(ax, ay, 3 * dpr, 0, Math.PI * 2);
      ctx.fill();

      // Box background.
      ctx.fillStyle = 'rgba(37,37,38,0.92)';
      ctx.strokeStyle = 'rgba(70,70,70,0.9)';
      ctx.lineWidth = 1 * dpr;
      roundRect(ctx, bx, by, boxW, boxH, 4 * dpr);
      ctx.fill();
      ctx.stroke();

      // Draw the scaled pixel image with pixelated rendering.
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(imgCanvas, bx + pad, by + pad, dw, dh);
      ctx.imageSmoothingEnabled = true;
      ctx.restore();
    } else if (ann.style === 'image' && ann.imageDataUrl) {
      // ---- Image-URL thumbnail callout (D5) ------------------------------------
      const img = new Image();
      img.src = ann.imageDataUrl;
      try {
        await img.decode();
        const dispSize = 64 * dpr;
        const scale = Math.min(dispSize / (img.naturalWidth || 1), dispSize / (img.naturalHeight || 1), 1);
        const dw = Math.max(1, Math.round(img.naturalWidth * scale));
        const dh = Math.max(1, Math.round(img.naturalHeight * scale));
        const pad = 4 * dpr;
        const boxW = dw + pad * 2;
        const boxH = dh + pad * 2;

        ctx.save();
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 1.5 * dpr;
        ctx.setLineDash([4 * dpr, 3 * dpr]);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx + boxW / 2, by + boxH / 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = lineColor;
        ctx.beginPath();
        ctx.arc(ax, ay, 3 * dpr, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = 'rgba(37,37,38,0.92)';
        ctx.strokeStyle = 'rgba(70,70,70,0.9)';
        ctx.lineWidth = 1 * dpr;
        roundRect(ctx, bx, by, boxW, boxH, 4 * dpr);
        ctx.fill();
        ctx.stroke();

        ctx.imageSmoothingEnabled = true;
        if (invertImages) {
          ctx.filter = 'invert(1)';
        }
        ctx.drawImage(img, bx + pad, by + pad, dw, dh);
        ctx.filter = 'none';
        ctx.restore();
      } catch {
        // Thumbnail unavailable; skip drawing this annotation image.
      }
    } else {
      // ---- Text callout --------------------------------------------------------
      // Leader line.
      ctx.save();
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([4 * dpr, 3 * dpr]);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      // Connect to center of callout box (approximate: 80px wide, 28px tall CSS).
      ctx.lineTo(bx + 40 * dpr, by + 14 * dpr);
      ctx.stroke();
      ctx.setLineDash([]);
      // Anchor dot.
      ctx.fillStyle = lineColor;
      ctx.beginPath();
      ctx.arc(ax, ay, 3 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Callout box.
      const label = ann.text || `Row ${ann.row}`;
      const pad = 6 * dpr;
      const fontSize = 12 * dpr;
      ctx.save();
      ctx.font = `400 ${fontSize}px sans-serif`;
      const textW = ctx.measureText(label).width;
      const boxW = textW + pad * 2;
      const boxH = fontSize * 1.4 + pad * 2;

      // Box background.
      ctx.fillStyle = badgeColor
        ? `rgba(${hexToRgb(badgeColor)},0.25)`
        : 'rgba(37,37,38,0.92)';
      ctx.strokeStyle = badgeColor ?? 'rgba(70,70,70,0.9)';
      ctx.lineWidth = 1 * dpr;
      roundRect(ctx, bx, by, boxW, boxH, 4 * dpr);
      ctx.fill();
      ctx.stroke();

      // Text.
      ctx.fillStyle = '#cccccc';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 2 * dpr;
      ctx.fillText(label, bx + pad, by + pad + fontSize);
      ctx.restore();
    }
  }

  // ---- A11 Around-the-map labels + leader lines --------------------------------
  const aroundLabels = opts.aroundLabels ?? [];
  if (aroundLabels.length) {
    const lw = (opts.leaderWidth ?? 1.5) * dpr;
    const fontFamily = opts.labelFontFamily || 'sans-serif';
    const leaderStyle = opts.leaderStyle ?? 'straight';

    for (const al of aroundLabels) {
      const ax = al.anchorX * dpr;
      const ay = al.anchorY * dpr;
      const lx = al.screenX * dpr;
      const ly = al.screenY * dpr;
      const fontSize = al.size * dpr;

      const lineColor = opts.leaderColor === 'grey'
        ? 'rgba(170,170,170,0.85)'
        : (al.clusterColor ? al.clusterColor + 'cc' : 'rgba(170,170,170,0.85)');

      // ---- Leader line ----
      ctx.save();
      ctx.strokeStyle = lineColor;
      ctx.fillStyle = lineColor;
      ctx.lineWidth = lw;

      if (leaderStyle === 'wedge') {
        // Filled isoceles triangle / wedge.
        const dx = lx - ax;
        const dy = ly - ay;
        const len = Math.hypot(dx, dy);
        if (len > 1) {
          const nx = -dy / len;
          const ny = dx / len;
          const tailW = lw * 2.2;
          ctx.beginPath();
          ctx.moveTo(ax + nx * tailW, ay + ny * tailW);
          ctx.lineTo(lx, ly);
          ctx.lineTo(ax - nx * tailW, ay - ny * tailW);
          ctx.closePath();
          ctx.fill();
        }
      } else if (leaderStyle === 'curved') {
        const mx = (ax + lx) / 2;
        const my = (ay + ly) / 2;
        const dx = lx - ax;
        const dy = ly - ay;
        const len = Math.hypot(dx, dy);
        const perp = len > 0 ? 0.2 : 0;
        const cpx = mx - dy * perp;
        const cpy = my + dx * perp;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo(cpx, cpy, lx, ly);
        ctx.stroke();
      } else {
        // Straight line.
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(lx, ly);
        ctx.stroke();
      }
      // Anchor dot.
      ctx.beginPath();
      ctx.arc(ax, ay, lw * 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // ---- Label text ----
      ctx.save();
      ctx.font = `${al.weight ?? 600} ${fontSize}px '${fontFamily}', sans-serif`;
      const tw = ctx.measureText(al.text).width;
      const pad = 5 * dpr;

      // Background halo / badge.
      if (al.badge) {
        const [br, bg, bb, ba] = al.badge;
        ctx.fillStyle = `rgba(${br},${bg},${bb},${ba / 255})`;
        roundRect(ctx, lx - tw / 2 - pad, ly - fontSize / 2 - pad / 2, tw + pad * 2, fontSize + pad, 3 * dpr);
        ctx.fill();
        ctx.fillStyle = `rgba(255,255,255,1)`;
      } else {
        // Soft shadow as halo.
        ctx.shadowColor = 'rgba(0,0,0,0.75)';
        ctx.shadowBlur = 3 * dpr;
        const [r, g, b, a] = al.color;
        ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(al.text, lx, ly);
      ctx.restore();
    }
  }
}

/** Draw B4 shapes onto the export canvas using 2D canvas operations. */
function drawShapesOnCanvas(
  ctx: CanvasRenderingContext2D,
  shapes: Shape[],
  projectWorld: (wx: number, wy: number) => [number, number] | null,
  dpr: number,
): void {
  for (const shape of shapes) {
    ctx.save();
    const sc = shape.style.strokeColor;
    const fc = shape.style.fillColor;
    ctx.strokeStyle = `rgba(${sc[0]},${sc[1]},${sc[2]},${sc[3] / 255})`;
    ctx.fillStyle = `rgba(${fc[0]},${fc[1]},${fc[2]},${fc[3] / 255})`;
    ctx.lineWidth = shape.style.strokeWidth * dpr;
    ctx.globalAlpha = shape.style.opacity;
    if (shape.style.dash?.length) ctx.setLineDash(shape.style.dash.map((d) => d * dpr));

    if (shape.kind === 'text') {
      const t = shape as any;
      const s = projectWorld(t.x, t.y);
      if (s) {
        ctx.font = `${(t.fontSize ?? 14) * dpr}px ${t.fontFamily ?? 'sans-serif'}`;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fillText(t.text, s[0] * dpr, s[1] * dpr);
      }
    } else if (shape.kind === 'line' || shape.kind === 'arrow') {
      const pts = (shape as any).points as [number, number][];
      if (pts.length >= 2) {
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const s = projectWorld(pts[i][0], pts[i][1]);
          if (!s) continue;
          if (i === 0) ctx.moveTo(s[0] * dpr, s[1] * dpr);
          else ctx.lineTo(s[0] * dpr, s[1] * dpr);
        }
        ctx.stroke();
        // Draw arrowhead for 'arrow'.
        if (shape.kind === 'arrow' && pts.length >= 2) {
          const last = pts[pts.length - 1];
          const prev = pts[pts.length - 2];
          const s1 = projectWorld(last[0], last[1]);
          const s2 = projectWorld(prev[0], prev[1]);
          if (s1 && s2) {
            const angle = Math.atan2(s1[1] - s2[1], s1[0] - s2[0]);
            const len = 10 * dpr;
            ctx.beginPath();
            ctx.moveTo(s1[0] * dpr, s1[1] * dpr);
            ctx.lineTo(
              (s1[0] - len * Math.cos(angle - Math.PI / 6)) * dpr,
              (s1[1] - len * Math.sin(angle - Math.PI / 6)) * dpr,
            );
            ctx.lineTo(
              (s1[0] - len * Math.cos(angle + Math.PI / 6)) * dpr,
              (s1[1] - len * Math.sin(angle + Math.PI / 6)) * dpr,
            );
            ctx.closePath();
            ctx.fillStyle = ctx.strokeStyle;
            ctx.fill();
          }
        }
      }
    } else {
      // Closed shapes: use shapeToPolygon to get vertices.
      const poly = shapeToPolygon(shape as any);
      if (poly && poly.length >= 3) {
        ctx.beginPath();
        for (let i = 0; i < poly.length; i++) {
          const s = projectWorld(poly[i][0], poly[i][1]);
          if (!s) continue;
          if (i === 0) ctx.moveTo(s[0] * dpr, s[1] * dpr);
          else ctx.lineTo(s[0] * dpr, s[1] * dpr);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

function resolveInvertOption(imageInvert: boolean | 'auto' | undefined): boolean {
  if (imageInvert === true) return true;
  if (imageInvert === 'auto') {
    if (typeof document === 'undefined') return false;
    const cl = document.body.classList;
    return cl.contains('vscode-dark') || cl.contains('vscode-high-contrast');
  }
  return false;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hexToRgb(color: string): string {
  // Parse #rrggbb or rgba() – return "r,g,b".
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(color);
  if (m) return `${m[1]},${m[2]},${m[3]}`;
  const hex = color.replace('#', '');
  if (hex.length === 6) {
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ].join(',');
  }
  return '128,128,128';
}
