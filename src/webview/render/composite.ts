/**
 * PNG export compositing: draws the title overlay, leader lines and annotation
 * callout boxes on top of the deck.gl canvas (A1, A4).
 *
 * All coordinates are in CSS pixels; we multiply by devicePixelRatio when drawing
 * on the physical-pixel output canvas.
 */

import type { TitleOptions, AnnotationData } from '../../shared/protocol';
import { imageToRgba } from '../logic';

export interface CompositeOptions {
  /** CSS-pixel dimensions of the visible area. */
  cssWidth: number;
  cssHeight: number;
  /** Device pixel ratio (default: window.devicePixelRatio). */
  dpr?: number;
  /** Title overlay settings. */
  title?: TitleOptions;
  /** Annotations with their current screen positions. */
  annotations?: Array<{ ann: AnnotationData; screenX: number; screenY: number }>;
}

/**
 * Draw the title and annotations onto an already-drawn canvas (the deck.gl output).
 * Modifies `ctx` in-place. All inputs are CSS pixels; drawing is scaled by dpr.
 * Returns a promise because logo and annotation images are loaded asynchronously.
 */
export async function compositeOverlay(ctx: CanvasRenderingContext2D, opts: CompositeOptions): Promise<void> {
  const dpr = opts.dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1);

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

  for (const { ann, screenX, screenY } of anns) {
    const ax = screenX * dpr;
    const ay = screenY * dpr;
    const bx = (screenX + ann.offsetX) * dpr;
    const by = (screenY + ann.offsetY) * dpr;

    const badgeColor = (ann.style === 'badge' && ann.color) ? ann.color : null;
    const lineColor = badgeColor ?? 'rgba(200,200,200,0.8)';

    if (ann.style === 'image' && ann.imagePixels && ann.imageShape) {
      // ---- Image callout -------------------------------------------------------
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
