/**
 * A11 — Labels around the map: ring-based placement + overlap removal.
 *
 * Labels are placed on a per-angle ring just outside the point cloud in screen
 * space.  For each angular direction the ring radius equals the furthest anchor
 * in that direction (from a 32-sector occupancy grid of all anchors) plus a
 * constant padding.  This guarantees labels land outside the cloud at every
 * angle, including clusters near the centroid whose ring radius in their
 * direction only covers their local extent.
 *
 * Labels are sorted by their natural angle so leaders never cross (anchors are
 * always inside the ring).  A greedy angle-nudge pass resolves overlaps.
 *
 * Forbidden zones: toolbar + search box band (top ~76 px) and the legend
 * in the top-right corner.  Labels are clamped inside the viewport after
 * nudging.
 *
 * All coordinates are **screen pixels** (CSS px).
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
   * Ring radius at angle θ = cloud_extent(θ) + padding.
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
 * Build a 32-sector per-angle cloud-boundary radius array (screen pixels) from
 * projected anchor positions.  Sector i covers the angular range
 * [i·(2π/32), (i+1)·(2π/32)).  After computing per-sector max radii, one pass of
 * nearest-neighbour fill propagates values into empty sectors so every direction
 * has a finite radius.
 *
 * @param sectorR  Output array of length SECTORS (pre-allocated to 0).
 * @param pts      Screen-space anchor positions; nulls are skipped.
 * @param cx       Centroid x.
 * @param cy       Centroid y.
 */
const SECTORS = 32;

function buildSectorRadii(
  sectorR: Float32Array,
  pts: ([number, number] | null)[],
  cx: number,
  cy: number,
): void {
  const TWO_PI = 2 * Math.PI;
  for (const p of pts) {
    if (!p) continue;
    const r = Math.hypot(p[0] - cx, p[1] - cy);
    if (r < 1) continue;
    const ang = ((Math.atan2(p[1] - cy, p[0] - cx) % TWO_PI) + TWO_PI) % TWO_PI;
    const si = Math.min(Math.floor(ang / (TWO_PI / SECTORS)), SECTORS - 1);
    if (r > sectorR[si]) sectorR[si] = r;
  }
  // Fill empty sectors from neighbours (up to 3 passes to bridge large gaps).
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < SECTORS; i++) {
      if (sectorR[i] < 1) {
        const prev = sectorR[(i - 1 + SECTORS) % SECTORS];
        const next = sectorR[(i + 1) % SECTORS];
        const fill = Math.max(prev, next);
        if (fill > 0) sectorR[i] = fill * 0.95; // slight decay to avoid extrapolation artefacts
      }
    }
  }
}

/** Return the per-angle cloud extent (screen pixels) + padding for a given angle. */
function ringRadius(angle: number, sectorR: Float32Array, padding: number): number {
  const TWO_PI = 2 * Math.PI;
  const rawIdx = ((angle % TWO_PI) + TWO_PI) % TWO_PI / (TWO_PI / SECTORS);
  const s0 = Math.floor(rawIdx) % SECTORS;
  const s1 = (s0 + 1) % SECTORS;
  const frac = rawIdx - Math.floor(rawIdx);
  return sectorR[s0] * (1 - frac) + sectorR[s1] * frac + padding;
}

/**
 * Compute around-the-map label screen positions from world-space group data.
 *
 * Uses a per-angle ring layout based on the cloud's actual screen-space extent:
 *   - A 32-sector occupancy grid is built from ALL anchor positions (all points
 *     when `allAnchorXY` is supplied, falling back to group anchors only).
 *   - Each slot's ring radius = max anchor distance at that angle + padding, so
 *     labels land outside the visible point cloud in every direction.
 *   - Slots are sorted by their natural angle so leaders never cross.
 *   - A greedy angle-nudge pass resolves overlaps, preferring moves that keep
 *     labels close to their natural angle (shorter leaders).
 *   - Labels are kept away from the toolbar/search band (top fitTopPx pixels),
 *     the legend top-right corner, and the viewport edges.
 *
 * @param groups        World-space group data (one per cluster).
 * @param projectFn     Maps world (wx, wy) → screen (sx, sy) or null.
 * @param viewW         Viewport width in CSS pixels.
 * @param viewH         Viewport height in CSS pixels.
 * @param opts          Placement options.
 * @param allAnchorXY   Optional flat array of ALL anchor world positions [x0,y0,x1,y1,…].
 *                      Used to build a shape-accurate cloud boundary.  Sampled to ≤5 000
 *                      points for performance.
 * @param nAllAnchors   Number of entries in `allAnchorXY` / 2.
 * @returns             Screen-space labels ready to render, or [] if view is not ready.
 */
export function computeAroundLabels(
  groups: AroundLabelGroup[],
  projectFn: (wx: number, wy: number) => [number, number] | null,
  viewW: number,
  viewH: number,
  opts: AroundOptions = {},
  allAnchorXY?: Float32Array | null,
  nAllAnchors?: number,
): AroundLabel[] {
  if (groups.length === 0 || viewW <= 0 || viewH <= 0) return [];

  const padding      = opts.padding      ?? 60;
  const FIT_TOP      = opts.fitTopPx     ?? 76;
  const legendWidth  = opts.legendWidth  ?? 180;
  const legendHeight = opts.legendHeight ?? 300;
  const leaderStyle  = opts.leaderStyle  ?? 'straight';

  const TWO_PI = 2 * Math.PI;

  // 1. Project all group anchors to screen space.
  const pts = groups.map(g => projectFn(g.worldX, g.worldY));

  // 2. Compute centroid of all visible group anchors.
  let sumX = 0, sumY = 0, nVisible = 0;
  for (const p of pts) {
    if (p) { sumX += p[0]; sumY += p[1]; nVisible++; }
  }
  if (nVisible === 0) return [];
  const cx = sumX / nVisible;
  const cy = sumY / nVisible;

  // 3. Build per-sector max radii from all anchors (or just group anchors as fallback).
  const sectorR = new Float32Array(SECTORS); // all 0

  if (allAnchorXY && nAllAnchors && nAllAnchors > 0) {
    // Sample ≤ 5000 anchors for performance on large datasets.
    const nSample = Math.min(nAllAnchors, 5000);
    const step = Math.max(1, Math.floor(nAllAnchors / nSample));
    const sampledPts: ([number, number] | null)[] = [];
    for (let i = 0; i < nAllAnchors; i += step) {
      sampledPts.push(projectFn(allAnchorXY[i * 2], allAnchorXY[i * 2 + 1]));
    }
    buildSectorRadii(sectorR, sampledPts, cx, cy);
  } else {
    buildSectorRadii(sectorR, pts, cx, cy);
  }

  // Ensure a minimum non-degenerate ring (10 px even for a point-like cloud).
  for (let i = 0; i < SECTORS; i++) {
    if (sectorR[i] < 10) sectorR[i] = 10;
  }

  // 4. Build slots (one per visible group): natural angle + size info.
  //    Also track the natural angle separately so the nudge pass can prefer
  //    moves that keep the label closer to its original angle (shorter leader).
  type Slot = {
    idx: number;
    angle: number;        // current angle on ring (adjusted during spread)
    naturalAngle: number; // original angle from centroid to anchor
    ax: number; ay: number; // anchor in screen coords
    hw: number; hh: number; // half-width / half-height of label bbox
  };

  const slots: Slot[] = [];
  for (let i = 0; i < groups.length; i++) {
    const p = pts[i];
    if (!p) continue;
    const g = groups[i];
    const rawAngle = Math.atan2(p[1] - cy, p[0] - cx);
    const ang = ((rawAngle % TWO_PI) + TWO_PI) % TWO_PI;
    slots.push({
      idx: i,
      angle: ang,
      naturalAngle: ang,
      ax: p[0], ay: p[1],
      hw: estimateTextWidth(g.text, g.size) / 2 + 5,
      hh: (g.size + 4) / 2 + 3,
    });
  }
  if (slots.length === 0) return [];

  // 5. Sort by angle — this guarantees that labels in angular order won't have
  //    crossing leaders (anchors are always inside the ring).
  slots.sort((a, b) => a.angle - b.angle);

  // 6. Helper: compute the clamped screen position for a slot at its current angle.
  //    Uses the per-angle cloud extent + padding as ring radius.
  const footerMargin = 24;
  const legendX0 = viewW - legendWidth - 8;

  const slotPos = (s: Slot): [number, number] => {
    const R = ringRadius(s.angle, sectorR, padding);
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
  //    When both directions resolve the overlap, prefer the one that keeps the
  //    label closer to its natural angle (shorter leader).
  //    40 iterations handles ≤ 15 groups reliably.
  const STEP = 0.07; // ~4° per nudge step
  for (let iter = 0; iter < 40; iter++) {
    let changed = false;
    for (let i = 0; i < slots.length; i++) {
      const j = (i + 1) % slots.length;
      if (j === i) continue;
      const a = slots[i];
      const b = slots[j];
      const [ax, ay] = slotPos(a);
      const [bx, by] = slotPos(b);

      // Axis-aligned bounding-box overlap test.
      if (Math.abs(ax - bx) < a.hw + b.hw && Math.abs(ay - by) < a.hh + b.hh) {
        // For the wrap-around pair push b backward; otherwise prefer the direction
        // that keeps b closest to its natural angle.
        let delta: number;
        if (j === 0) {
          delta = -STEP;
        } else {
          const fwdAngle = ((b.angle + STEP) % TWO_PI + TWO_PI) % TWO_PI;
          const bwdAngle = ((b.angle - STEP) % TWO_PI + TWO_PI) % TWO_PI;
          const fwdDist = Math.abs(fwdAngle - b.naturalAngle);
          const bwdDist = Math.abs(bwdAngle - b.naturalAngle);
          delta = fwdDist <= bwdDist ? STEP : -STEP;
          // But fwd direction must stay ahead of a (preserve sorted order).
          if (delta === -STEP && ((bwdAngle - a.angle + TWO_PI) % TWO_PI) < 0.01) {
            delta = STEP;
          }
        }
        b.angle = ((b.angle + delta) % TWO_PI + TWO_PI) % TWO_PI;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 8. Build output AroundLabel array.
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
