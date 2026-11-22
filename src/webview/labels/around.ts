/**
 * A11 — Labels around the map: radial placement + overlap removal.
 *
 * Labels are placed outside the point cloud's bounding box in the radial
 * direction of each group's anchor.  A simple greedy nudge pass removes
 * overlaps by sliding labels along the arc.  The algorithm is deterministic:
 * same inputs → same output.
 *
 * All coordinates are **screen pixels** (CSS px).  The caller supplies a
 * `projectFn` that maps world coordinates to screen coordinates and is called
 * once per group.
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
  /** Extra pixels outside the bounding box before placing labels (default 50). */
  padding?: number;
  /** Additional margin between box edge and label center (default 14). */
  labelMargin?: number;
  /** Leader line style (default 'straight'). */
  leaderStyle?: 'straight' | 'curved' | 'wedge';
  /** Leader line color mode (default 'cluster'). */
  leaderColor?: 'cluster' | 'grey';
}

/** Approximate text width in pixels for a given text at a given font size. */
function estimateTextWidth(text: string, size: number): number {
  return text.length * size * 0.56;
}

/** Intersect a ray from (cx, cy) in direction `angle` with an axis-aligned box. */
function rayBoxIntersect(
  cx: number, cy: number, angle: number,
  x0: number, y0: number, x1: number, y1: number,
): [number, number] {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let tMin = Infinity;
  if (Math.abs(dx) > 1e-9) {
    const t = dx > 0 ? (x1 - cx) / dx : (x0 - cx) / dx;
    if (t > 0) tMin = Math.min(tMin, t);
  }
  if (Math.abs(dy) > 1e-9) {
    const t = dy > 0 ? (y1 - cy) / dy : (y0 - cy) / dy;
    if (t > 0) tMin = Math.min(tMin, t);
  }
  if (!isFinite(tMin)) {
    // Fallback: use a large radius
    tMin = Math.max(x1 - x0, y1 - y0);
  }
  return [cx + tMin * dx, cy + tMin * dy];
}

/** Build a leader path string for SVG. */
function buildLeaderPath(
  ax: number, ay: number,
  lx: number, ly: number,
  style: 'straight' | 'curved' | 'wedge',
  width: number,
): string {
  if (style === 'straight') {
    return `M${ax},${ay} L${lx},${ly}`;
  }
  if (style === 'curved') {
    // Mid-point with a slight perpendicular offset for the control point.
    const mx = (ax + lx) / 2;
    const my = (ay + ly) / 2;
    const dx = lx - ax;
    const dy = ly - ay;
    // Perpendicular to the line, 20% of the length.
    const len = Math.hypot(dx, dy);
    const perp = len > 0 ? 0.2 : 0;
    const cpx = mx - dy * perp;
    const cpy = my + dx * perp;
    return `M${ax},${ay} Q${cpx},${cpy} ${lx},${ly}`;
  }
  // wedge: a filled isoceles triangle from anchor to label
  const dx = lx - ax;
  const dy = ly - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1) return `M${ax},${ay} L${lx},${ly}`;
  const nx = -dy / len;
  const ny = dx / len;
  const tailW = width * 1.5;
  const p1x = ax + nx * tailW;
  const p1y = ay + ny * tailW;
  const p2x = ax - nx * tailW;
  const p2y = ay - ny * tailW;
  return `M${p1x},${p1y} L${lx},${ly} L${p2x},${p2y} Z`;
}

/**
 * Compute around-the-map label screen positions from world-space group data.
 *
 * Called every animation frame in the overlay component so labels track the
 * current view during pan/zoom.
 *
 * @param groups   World-space group data (from updateLabels in around mode).
 * @param projectFn  Maps world (wx, wy) → screen (sx, sy), or null if off-screen.
 * @param viewW    Viewport width in CSS pixels.
 * @param viewH    Viewport height in CSS pixels.
 * @param opts     Placement options.
 * @returns        Screen-space labels ready to render, or [] if the view is not ready.
 */
export function computeAroundLabels(
  groups: AroundLabelGroup[],
  projectFn: (wx: number, wy: number) => [number, number] | null,
  viewW: number,
  viewH: number,
  opts: AroundOptions = {},
): AroundLabel[] {
  if (groups.length === 0 || viewW <= 0 || viewH <= 0) return [];

  const padding = opts.padding ?? 50;
  const labelMargin = opts.labelMargin ?? 14;
  const leaderStyle = opts.leaderStyle ?? 'straight';
  const leaderColor = opts.leaderColor ?? 'cluster';

  // 1. Project all group anchors to screen space.
  const projected: ([number, number] | null)[] = groups.map(g => projectFn(g.worldX, g.worldY));

  // 2. Compute cloud bounding box from projected anchor positions.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pt of projected) {
    if (!pt) continue;
    if (pt[0] < minX) minX = pt[0];
    if (pt[0] > maxX) maxX = pt[0];
    if (pt[1] < minY) minY = pt[1];
    if (pt[1] > maxY) maxY = pt[1];
  }
  if (!isFinite(minX)) return [];

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const bx0 = minX - padding;
  const by0 = minY - padding;
  const bx1 = maxX + padding;
  const by1 = maxY + padding;

  // 3. For each group, compute its radial angle and place it at the box exterior.
  type Candidate = {
    index: number;
    angle: number;
    screenX: number;
    screenY: number;
    anchorX: number;
    anchorY: number;
    w: number; // estimated half-width
    h: number; // estimated half-height
  };

  const candidates: Candidate[] = [];
  for (let i = 0; i < groups.length; i++) {
    const pt = projected[i];
    if (!pt) continue;
    const [ax, ay] = pt;

    const dx = ax - cx;
    const dy = ay - cy;
    // If the anchor is at the cloud center (degenerate case), place it to the right.
    const angle = Math.abs(dx) + Math.abs(dy) < 1 ? 0 : Math.atan2(dy, dx);

    // Find where this ray exits the padded bounding box.
    const [ex, ey] = rayBoxIntersect(cx, cy, angle, bx0, by0, bx1, by1);

    // Offset further so the label sits outside the box.
    const g = groups[i];
    const tw = estimateTextWidth(g.text, g.size);
    const th = g.size + 4;
    // Push the label out so its near edge clears the box.
    const extra = labelMargin + (leaderStyle === 'wedge' ? 8 : 0);
    const lx = ex + extra * Math.cos(angle);
    const ly = ey + extra * Math.sin(angle);

    candidates.push({
      index: i,
      angle,
      screenX: lx,
      screenY: ly,
      anchorX: ax,
      anchorY: ay,
      w: tw / 2 + 4,
      h: th / 2 + 2,
    });
  }

  if (candidates.length === 0) return [];

  // 4. Sort by angle for deterministic output.
  candidates.sort((a, b) => a.angle - b.angle);

  // 5. Overlap removal: greedy nudge along the arc (up to 10 iterations).
  const NUDGE_DEG = 0.08; // radians (~4.6°)
  for (let iter = 0; iter < 10; iter++) {
    let changed = false;
    for (let i = 0; i < candidates.length; i++) {
      const j = (i + 1) % candidates.length;
      if (j === i) continue;
      const a = candidates[i];
      const b = candidates[j];
      const overlapX = Math.abs(a.screenX - b.screenX) < a.w + b.w;
      const overlapY = Math.abs(a.screenY - b.screenY) < a.h + b.h;
      if (overlapX && overlapY) {
        // Nudge b by increasing its angle (or decreasing for the last→first pair).
        const dAngle = j === 0 ? -NUDGE_DEG : NUDGE_DEG;
        b.angle += dAngle;
        const [ex, ey] = rayBoxIntersect(cx, cy, b.angle, bx0, by0, bx1, by1);
        b.screenX = ex + labelMargin * Math.cos(b.angle);
        b.screenY = ey + labelMargin * Math.sin(b.angle);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 6. Build the output AroundLabel array.
  const result: AroundLabel[] = candidates.map(c => {
    const g = groups[c.index];
    // Apply drag offset: same key-based lookup as in updateLabels.
    const leaderPath = buildLeaderPath(
      c.anchorX, c.anchorY,
      c.screenX, c.screenY,
      leaderStyle,
      opts.leaderColor === 'grey' ? 1 : (g.size * 0.07 + 0.8), // leader width proportional to label size
    );
    return {
      ...g,
      screenX: c.screenX,
      screenY: c.screenY,
      anchorX: c.anchorX,
      anchorY: c.anchorY,
      leaderPath,
    };
  });

  return result;
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
