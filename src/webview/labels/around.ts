/**
 * A11 — Labels around the map: ring-based placement + overlap removal.
 *
 * Labels are placed on a circular ring just outside the point cloud in screen
 * space.  The ring radius is derived from the max distance from the cloud
 * centroid to any group anchor.  Labels are sorted by their natural angle so
 * leaders never cross (anchors are always inside the ring).  A greedy nudge
 * pass spreads overlapping labels along the ring with minimal angular movement.
 *
 * Forbidden zones: toolbar + search box band (top ~76 px) and the legend
 * in the top-right corner.  Labels are clamped inside the viewport after
 * nudging.
 *
 * All coordinates are **screen pixels** (CSS px).  The caller supplies a
 * `projectFn` that maps world coordinates to screen coordinates.
 */

import type { GroupLabel } from './place';

/** World-space group data passed from atlas/labels.ts to the overlay component. */
export interface AroundLabelGroup {
  key: string;
  text: string;
  worldX: number;
  worldY: number;
  size: number;
  color: [number, number, number, number];
  /** Hex color of the cluster, used when leaderColor === 'cluster'. */
  clusterColor: string | null;
  priority: number;
  weight: number;
  badge?: [number, number, number, number];
}

/** Screen-space result for rendering. */
export interface AroundLabel extends AroundLabelGroup {
  /** Screen position where the label text is centered. */
  screenX: number;
  screenY: number;
  /** Screen position of the group anchor (leader line start). */
  anchorX: number;
  anchorY: number;
  /** Pre-computed leader path string (for SVG <path d="...">). */
  leaderPath: string;
}

export interface AroundOptions {
  /**
   * Extra pixels beyond the cloud extent radius before placing labels (default 60).
   * Total ring radius = max_anchor_distance_from_centroid + padding.
   */
  padding?: number;
  /** Height of the top toolbar + search-box band to keep labels below (default 76). */
  fitTopPx?: number;
  /** Width of the legend panel in the top-right corner to avoid (default 180). */
  legendWidth?: number;
  /** Height of the legend panel to treat as forbidden (default 300). */
  legendHeight?: number;
  /** Leader line style (default 'straight'). */
  leaderStyle?: 'straight' | 'curved' | 'wedge';
  /** Leader line color mode (default 'cluster'). */
  leaderColor?: 'cluster' | 'grey';
}

/** Approximate text width in pixels for a given text at a given font size. */
function estimateTextWidth(text: string, size: number): number {
  return text.length * size * 0.56;
}

/** Build a leader path string for SVG. */
function buildLeaderPath(
  ax: number, ay: number,
  lx: number, ly: number,
  style: 'straight' | 'curved' | 'wedge',
  width: number,
): string {
  if (style === 'straight') {
    return `M${ax.toFixed(1)},${ay.toFixed(1)} L${lx.toFixed(1)},${ly.toFixed(1)}`;
  }
  if (style === 'curved') {
    const mx = (ax + lx) / 2;
    const my = (ay + ly) / 2;
    const dx = lx - ax;
    const dy = ly - ay;
    const len = Math.hypot(dx, dy);
    const perp = len > 0 ? 0.2 : 0;
    const cpx = mx - dy * perp;
    const cpy = my + dx * perp;
    return `M${ax.toFixed(1)},${ay.toFixed(1)} Q${cpx.toFixed(1)},${cpy.toFixed(1)} ${lx.toFixed(1)},${ly.toFixed(1)}`;
  }
  // wedge: filled isoceles triangle from anchor to label
  const dx = lx - ax;
  const dy = ly - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1) return `M${ax.toFixed(1)},${ay.toFixed(1)} L${lx.toFixed(1)},${ly.toFixed(1)}`;
  const nx = -dy / len;
  const ny = dx / len;
  const tailW = width * 1.5;
  const p1x = ax + nx * tailW;
  const p1y = ay + ny * tailW;
  const p2x = ax - nx * tailW;
  const p2y = ay - ny * tailW;
  return `M${p1x.toFixed(1)},${p1y.toFixed(1)} L${lx.toFixed(1)},${ly.toFixed(1)} L${p2x.toFixed(1)},${p2y.toFixed(1)} Z`;
}

/**
 * Compute around-the-map label screen positions from world-space group data.
 *
 * Uses a ring-based layout:
 *   - Labels sit on a circle of radius (max_anchor_distance_from_centroid + padding).
 *   - Each label's initial position on the ring is at its natural angle (angle from
 *     centroid to anchor).  Sorting by angle ensures leaders never cross.
 *   - A greedy nudge pass spreads overlapping labels along the ring.
 *   - Labels are kept away from the toolbar/search band (top fitTopPx pixels),
 *     the legend top-right corner, and the viewport edges.
 *
 * @param groups   World-space group data.
 * @param projectFn  Maps world (wx, wy) → screen (sx, sy) or null.
 * @param viewW    Viewport width in CSS pixels.
 * @param viewH    Viewport height in CSS pixels.
 * @param opts     Placement options.
 * @returns        Screen-space labels ready to render, or [] if view is not ready.
 */
export function computeAroundLabels(
  groups: AroundLabelGroup[],
  projectFn: (wx: number, wy: number) => [number, number] | null,
  viewW: number,
  viewH: number,
  opts: AroundOptions = {},
): AroundLabel[] {
  if (groups.length === 0 || viewW <= 0 || viewH <= 0) return [];

  const padding     = opts.padding     ?? 60;
  const FIT_TOP     = opts.fitTopPx    ?? 76;
  const legendWidth = opts.legendWidth  ?? 180;
  const legendHeight = opts.legendHeight ?? 300;
  const leaderStyle = opts.leaderStyle ?? 'straight';

  // 1. Project all group anchors to screen space.
  const pts = groups.map(g => projectFn(g.worldX, g.worldY));

  // 2. Compute centroid of all visible anchors.
  let sumX = 0, sumY = 0, nVisible = 0;
  for (const p of pts) {
    if (p) { sumX += p[0]; sumY += p[1]; nVisible++; }
  }
  if (nVisible === 0) return [];
  const cx = sumX / nVisible;
  const cy = sumY / nVisible;

  // 3. Ring radius = max anchor distance from centroid + padding.
  let maxR = 10; // ensure a minimum non-degenerate ring
  for (const p of pts) {
    if (p) maxR = Math.max(maxR, Math.hypot(p[0] - cx, p[1] - cy));
  }
  const R = maxR + padding;

  // 4. Build slots (one per visible group): natural angle + size info.
  type Slot = {
    idx: number;
    angle: number;    // angle on ring, in [0, 2π), adjusted during spread
    ax: number; ay: number; // anchor in screen coords
    hw: number; hh: number; // half-width / half-height of label bbox
  };
  const TWO_PI = 2 * Math.PI;

  const slots: Slot[] = [];
  for (let i = 0; i < groups.length; i++) {
    const p = pts[i];
    if (!p) continue;
    const g = groups[i];
    const rawAngle = Math.atan2(p[1] - cy, p[0] - cx);
    slots.push({
      idx: i,
      angle: ((rawAngle % TWO_PI) + TWO_PI) % TWO_PI, // normalise to [0, 2π)
      ax: p[0], ay: p[1],
      hw: estimateTextWidth(g.text, g.size) / 2 + 5,
      hh: (g.size + 4) / 2 + 3,
    });
  }
  if (slots.length === 0) return [];

  // 5. Sort by angle — this guarantees that labels in angular order won't have
  //    crossing leaders (anchors are always inside the ring).
  slots.sort((a, b) => a.angle - b.angle);

  // 6. Helper: compute the clamped screen position for a slot's current angle.
  //    Keeps the label out of the toolbar/search band, legend, and viewport edges.
  const footerMargin = 24; // footer bar height
  const legendX0 = viewW - legendWidth - 8; // left edge of legend forbidden zone

  const slotPos = (s: Slot): [number, number] => {
    let lx = cx + R * Math.cos(s.angle);
    let ly = cy + R * Math.sin(s.angle);

    // Keep below toolbar + search box band.
    if (ly - s.hh < FIT_TOP) ly = FIT_TOP + s.hh + 2;

    // Keep away from legend (top-right corner).
    if (lx + s.hw > legendX0 && ly - s.hh < legendHeight) {
      lx = legendX0 - s.hw - 2;
    }

    // Clamp to viewport edges.
    lx = Math.max(s.hw + 2, Math.min(viewW - s.hw - 2, lx));
    ly = Math.max(FIT_TOP + s.hh + 2, Math.min(viewH - s.hh - footerMargin, ly));

    return [lx, ly];
  };

  // 7. Greedy spread: nudge overlapping adjacent labels along the ring.
  //    30 iterations handles ≤ 15 groups reliably.
  const STEP = 0.07; // ~4° per nudge step
  for (let iter = 0; iter < 30; iter++) {
    let changed = false;
    for (let i = 0; i < slots.length; i++) {
      const j = (i + 1) % slots.length;
      if (j === i) continue;
      const a = slots[i];
      const b = slots[j];
      const [ax, ay] = slotPos(a);
      const [bx, by] = slotPos(b);

      // Axis-aligned bounding-box overlap test.
      const overlapX = Math.abs(ax - bx) < a.hw + b.hw;
      const overlapY = Math.abs(ay - by) < a.hh + b.hh;

      if (overlapX && overlapY) {
        // Push b's angle away from a.  For the wrap-around pair (j===0,
        // last slot → first slot), push backward to keep order intact.
        const delta = j === 0 ? -STEP : STEP;
        b.angle = ((b.angle + delta) % TWO_PI + TWO_PI) % TWO_PI;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 8. Build output AroundLabel array.
  const leaderW = 1.5; // base leader width; callers can override via leaderWidth
  return slots.map(s => {
    const g = groups[s.idx];
    const [lx, ly] = slotPos(s);
    const lw = g.size * 0.07 + 0.8;
    const leaderPath = buildLeaderPath(s.ax, s.ay, lx, ly, leaderStyle, lw);
    return {
      ...g,
      screenX: lx,
      screenY: ly,
      anchorX: s.ax,
      anchorY: s.ay,
      leaderPath,
    };
  });
}

/**
 * Build AroundLabelGroup[] from the data already computed in updateLabels.
 * Exported so atlas/labels.ts can call it without circular imports.
 */
export function buildAroundLabelGroups(
  placed: GroupLabel[],
  sizes: number[],
  colors: [number, number, number, number][],
  clusterColors: (string | null)[],
  weights: number[],
  priorities: number[],
  badges: (([number, number, number, number]) | undefined)[],
  applyCase: (s: string) => string,
): AroundLabelGroup[] {
  return placed.map((l, i) => ({
    key: l.text === '' ? '(empty)' : l.text,
    text: applyCase(l.text === '' ? '(empty)' : l.text),
    worldX: l.x,
    worldY: l.y,
    size: sizes[i] ?? 14,
    color: colors[i] ?? [235, 235, 235, 255],
    clusterColor: clusterColors[i] ?? null,
    priority: priorities[i] ?? 0,
    weight: weights[i] ?? 600,
    badge: badges[i],
  }));
}
