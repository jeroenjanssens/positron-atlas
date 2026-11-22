/**
 * B3 / Item 9: Marker symbol atlas for point-overlay layers.
 *
 * Eight symbols drawn on a canvas (white shapes on transparent background).
 * deck.gl IconLayer with mask:true applies per-point RGBA colors to the shapes.
 *
 * Symbol codes:
 *   0 = circle   (default; ScatterplotLayer fast path)
 *   1 = square
 *   2 = triangle (up)
 *   3 = diamond
 *   4 = cross (+)
 *   5 = star (6-point)
 *   6 = hexagon
 *   7 = x-mark
 */

export const SYMBOL_NAMES = ['circle', 'square', 'triangle', 'diamond', 'cross', 'star', 'hexagon', 'x'] as const;
export type SymbolName = (typeof SYMBOL_NAMES)[number];

/** Size of each icon cell in the atlas (pixels). */
const CELL = 32;
/** Number of symbols. */
export const N_SYMBOLS = SYMBOL_NAMES.length;

/** Lazy singleton: created once, reused. */
let _atlasCanvas: HTMLCanvasElement | null = null;
let _atlasMapping: Record<string, { x: number; y: number; width: number; height: number; anchorX: number; anchorY: number; mask: boolean }> | null = null;

/** Build (or return cached) the symbol atlas canvas and icon mapping. */
export function getSymbolAtlas(): {
  iconAtlas: HTMLCanvasElement;
  iconMapping: Record<string, { x: number; y: number; width: number; height: number; anchorX: number; anchorY: number; mask: boolean }>;
} {
  if (_atlasCanvas && _atlasMapping) {
    return { iconAtlas: _atlasCanvas, iconMapping: _atlasMapping };
  }

  const canvas = document.createElement('canvas');
  canvas.width = CELL * N_SYMBOLS;
  canvas.height = CELL;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const mapping: typeof _atlasMapping = {};
  const r = CELL / 2 - 2; // radius with 2px margin
  const cx = CELL / 2;
  const cy = CELL / 2;

  for (let i = 0; i < N_SYMBOLS; i++) {
    const name = SYMBOL_NAMES[i];
    const ox = i * CELL; // x offset in atlas

    ctx.save();
    ctx.translate(ox, 0);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();

    switch (name) {
      case 'circle':
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'square': {
        const s = r * 1.6;
        ctx.rect(cx - s / 2, cy - s / 2, s, s);
        ctx.fill();
        break;
      }
      case 'triangle': {
        const h = r * 1.8;
        ctx.moveTo(cx, cy - h / 2);
        ctx.lineTo(cx + h * 0.866, cy + h / 2);
        ctx.lineTo(cx - h * 0.866, cy + h / 2);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'diamond': {
        const d = r * 1.4;
        ctx.moveTo(cx, cy - d);
        ctx.lineTo(cx + d * 0.65, cy);
        ctx.lineTo(cx, cy + d);
        ctx.lineTo(cx - d * 0.65, cy);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'cross': {
        const w = r * 0.5;
        const e = r * 1.1;
        ctx.rect(cx - w, cy - e, w * 2, e * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.rect(cx - e, cy - w, e * 2, w * 2);
        ctx.fill();
        break;
      }
      case 'star': {
        // 6-pointed star
        const outer = r * 1.1;
        const inner = r * 0.5;
        for (let p = 0; p < 12; p++) {
          const ang = (p * Math.PI) / 6 - Math.PI / 2;
          const rr = p % 2 === 0 ? outer : inner;
          if (p === 0) ctx.moveTo(cx + rr * Math.cos(ang), cy + rr * Math.sin(ang));
          else ctx.lineTo(cx + rr * Math.cos(ang), cy + rr * Math.sin(ang));
        }
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'hexagon': {
        const rh = r * 1.1;
        for (let p = 0; p < 6; p++) {
          const ang = (p * Math.PI) / 3 - Math.PI / 6;
          if (p === 0) ctx.moveTo(cx + rh * Math.cos(ang), cy + rh * Math.sin(ang));
          else ctx.lineTo(cx + rh * Math.cos(ang), cy + rh * Math.sin(ang));
        }
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'x': {
        const lw = r * 0.42;
        const le = r * 1.0;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(Math.PI / 4);
        ctx.rect(-lw, -le, lw * 2, le * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.rect(-le, -lw, le * 2, lw * 2);
        ctx.fill();
        ctx.restore();
        break;
      }
    }
    ctx.restore();

    mapping[name] = {
      x: i * CELL,
      y: 0,
      width: CELL,
      height: CELL,
      anchorX: CELL / 2,
      anchorY: CELL / 2,
      mask: true,
    };
  }

  _atlasCanvas = canvas;
  _atlasMapping = mapping;
  return { iconAtlas: canvas, iconMapping: mapping };
}

/** Return the symbol name for a code (default: 'circle'). */
export function symbolName(code: number): SymbolName {
  return SYMBOL_NAMES[code % N_SYMBOLS];
}

/** Assign symbol codes in rotation to overlay layers (index 0 = square, 1 = triangle, etc.). */
export function overlaySymbolCode(overlayIndex: number): number {
  // Start from 1 (skip circle which is used by the base map).
  return 1 + (overlayIndex % (N_SYMBOLS - 1));
}
