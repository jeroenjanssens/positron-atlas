/**
 * Unit tests for A11 — labels around the map.
 * Tests the radial placement algorithm, overlap removal, and leader geometry.
 */
import { describe, it, expect } from 'vitest';
import {
  computeAroundLabels,
  buildAroundLabelGroups,
  type AroundLabelGroup,
  type AroundLabel,
} from '../src/webview/labels/around';
import type { GroupLabel } from '../src/webview/labels/place';

// ---- Helpers -----------------------------------------------------------------

/** Make a simple AroundLabelGroup for testing. */
function makeGroup(
  key: string,
  worldX: number,
  worldY: number,
  text = key,
  size = 14,
): AroundLabelGroup {
  return {
    key,
    text,
    worldX,
    worldY,
    size,
    color: [235, 235, 235, 255],
    clusterColor: '#e45678',
    priority: 100,
    weight: 600,
  };
}

/**
 * A simple identity project function: world coords are the same as screen coords.
 * The "world" here is 0–800 × 0–600 screen space.
 */
function identityProject(wx: number, wy: number): [number, number] | null {
  return [wx, wy];
}

/** Returns the half-width and half-height of a label's bounding box. */
function labelHalf(l: AroundLabel): { hw: number; hh: number } {
  const hw = l.text.length * l.size * 0.56 / 2 + 5;
  const hh = (l.size + 4) / 2 + 3;
  return { hw, hh };
}

/** True if two axis-aligned boxes overlap. */
function boxesOverlap(
  ax: number, ay: number, ahw: number, ahh: number,
  bx: number, by: number, bhw: number, bhh: number,
): boolean {
  return Math.abs(ax - bx) < ahw + bhw && Math.abs(ay - by) < ahh + bhh;
}

/** True if two line segments (p1→p2) and (p3→p4) properly intersect (interiors only). */
function segmentsIntersect(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number,
): boolean {
  const d1x = x2 - x1, d1y = y2 - y1;
  const d2x = x4 - x3, d2y = y4 - y3;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return false; // parallel
  const t = ((x3 - x1) * d2y - (y3 - y1) * d2x) / denom;
  const u = ((x3 - x1) * d1y - (y3 - y1) * d1x) / denom;
  return t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99;
}

/** Viewport constants matching defaults in around.ts. */
const VIEW_W = 800;
const VIEW_H = 600;
const FIT_TOP_PX = 76;
const LEGEND_WIDTH = 180;
const LEGEND_HEIGHT = 300;

// ---- Tests -------------------------------------------------------------------

describe('computeAroundLabels', () => {
  it('returns empty array for empty input', () => {
    const result = computeAroundLabels([], identityProject, VIEW_W, VIEW_H);
    expect(result).toHaveLength(0);
  });

  it('returns empty array when viewW/viewH is 0', () => {
    const groups = [makeGroup('A', 400, 300)];
    expect(computeAroundLabels(groups, identityProject, 0, VIEW_H)).toHaveLength(0);
    expect(computeAroundLabels(groups, identityProject, VIEW_W, 0)).toHaveLength(0);
  });

  it('returns empty array when all projections return null', () => {
    const groups = [makeGroup('A', 400, 300), makeGroup('B', 200, 200)];
    const result = computeAroundLabels(groups, () => null, VIEW_W, VIEW_H);
    expect(result).toHaveLength(0);
  });

  it('places a single label outside the cloud extent + padding', () => {
    // Single group at world center (400, 300).
    const groups = [makeGroup('A', 400, 300, 'Group A')];
    const result = computeAroundLabels(groups, identityProject, VIEW_W, VIEW_H, { padding: 50 });
    expect(result).toHaveLength(1);
    const lbl = result[0];
    // The label should not be at the anchor.
    expect(Math.hypot(lbl.screenX - lbl.anchorX, lbl.screenY - lbl.anchorY)).toBeGreaterThan(10);
  });

  it('is deterministic: same inputs produce identical outputs', () => {
    const groups = [
      makeGroup('A', 200, 150),
      makeGroup('B', 600, 150),
      makeGroup('C', 400, 450),
      makeGroup('D', 100, 300),
      makeGroup('E', 700, 300),
    ];
    const r1 = computeAroundLabels(groups, identityProject, VIEW_W, VIEW_H);
    const r2 = computeAroundLabels(groups, identityProject, VIEW_W, VIEW_H);
    expect(r1).toHaveLength(r2.length);
    for (let i = 0; i < r1.length; i++) {
      expect(r1[i].screenX).toBeCloseTo(r2[i].screenX, 5);
      expect(r1[i].screenY).toBeCloseTo(r2[i].screenY, 5);
      expect(r1[i].key).toBe(r2[i].key);
    }
  });

  it('order of groups should not change the set of output keys', () => {
    const groups = [
      makeGroup('A', 200, 150),
      makeGroup('B', 600, 150),
      makeGroup('C', 400, 450),
    ];
    const shuffled = [groups[2], groups[0], groups[1]];
    const r1 = computeAroundLabels(groups, identityProject, VIEW_W, VIEW_H);
    const r2 = computeAroundLabels(shuffled, identityProject, VIEW_W, VIEW_H);
    // Both should produce 3 labels with the same keys.
    const keys1 = r1.map((l) => l.key).sort();
    const keys2 = r2.map((l) => l.key).sort();
    expect(keys1).toEqual(keys2);
  });

  it('no two labels overlap after placement (strict)', () => {
    const groups: AroundLabelGroup[] = [];
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      groups.push(makeGroup(
        `Group${i}`,
        400 + Math.cos(angle) * 50,
        300 + Math.sin(angle) * 50,
        `Group ${i}`,
        14,
      ));
    }
    const result = computeAroundLabels(groups, identityProject, VIEW_W, VIEW_H, { padding: 60 });
    expect(result.length).toBeGreaterThan(0);

    for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        const a = result[i];
        const b = result[j];
        const { hw: ahw, hh: ahh } = labelHalf(a);
        const { hw: bhw, hh: bhh } = labelHalf(b);
        expect(
          boxesOverlap(a.screenX, a.screenY, ahw, ahh, b.screenX, b.screenY, bhw, bhh),
        ).toBe(false);
      }
    }
  });

  it('no label rect intersects the toolbar/search band (top fitTopPx pixels)', () => {
    const groups: AroundLabelGroup[] = [];
    // Place all group anchors at the top of the viewport to stress the toolbar avoidance.
    for (let i = 0; i < 6; i++) {
      groups.push(makeGroup(`G${i}`, 100 + i * 100, 50, `Label ${i}`, 14));
    }
    const result = computeAroundLabels(groups, identityProject, VIEW_W, VIEW_H, {
      fitTopPx: FIT_TOP_PX,
    });
    for (const lbl of result) {
      const { hh } = labelHalf(lbl);
      // Top of label must be at or below FIT_TOP_PX.
      expect(lbl.screenY - hh).toBeGreaterThanOrEqual(FIT_TOP_PX - 0.5);
    }
  });

  it('no label rect intersects the legend (top-right corner)', () => {
    const groups: AroundLabelGroup[] = [];
    // Anchors at top-right to stress legend avoidance.
    for (let i = 0; i < 4; i++) {
      groups.push(makeGroup(`G${i}`, 650 + i * 30, 100 + i * 40, `Long label ${i}`, 14));
    }
    const result = computeAroundLabels(groups, identityProject, VIEW_W, VIEW_H, {
      legendWidth: LEGEND_WIDTH,
      legendHeight: LEGEND_HEIGHT,
    });
    const legendX0 = VIEW_W - LEGEND_WIDTH - 8;
    for (const lbl of result) {
      const { hw, hh } = labelHalf(lbl);
      // A label must NOT be in the top-right forbidden rect.
      const inLegendX = lbl.screenX + hw > legendX0;
      const inLegendY = lbl.screenY - hh < LEGEND_HEIGHT;
      // Should not be simultaneously in both legend X and Y zones.
      if (inLegendX && inLegendY) {
        throw new Error(
          `Label "${lbl.text}" at (${lbl.screenX.toFixed(0)}, ${lbl.screenY.toFixed(0)}) ` +
          `overlaps the legend forbidden zone (x>${legendX0}, y<${LEGEND_HEIGHT})`,
        );
      }
    }
  });

  it('no two leader lines cross', () => {
    const groups: AroundLabelGroup[] = [];
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      groups.push(makeGroup(
        `G${i}`,
        400 + Math.cos(angle) * 80,
        300 + Math.sin(angle) * 80,
        `Cluster ${i}`,
        14,
      ));
    }
    const result = computeAroundLabels(groups, identityProject, VIEW_W, VIEW_H);
    // Check all pairs of leaders for intersection.
    for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        const a = result[i];
        const b = result[j];
        const crosses = segmentsIntersect(
          a.anchorX, a.anchorY, a.screenX, a.screenY,
          b.anchorX, b.anchorY, b.screenX, b.screenY,
        );
        expect(crosses).toBe(false);
      }
    }
  });

  it('max leader length is bounded below viewW (no extremely long leaders)', () => {
    const groups: AroundLabelGroup[] = [];
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2;
      groups.push(makeGroup(
        `G${i}`,
        400 + Math.cos(angle) * 100,
        300 + Math.sin(angle) * 100,
        `Group ${i}`,
        14,
      ));
    }
    const result = computeAroundLabels(groups, identityProject, VIEW_W, VIEW_H);
    const maxAllowed = Math.max(VIEW_W, VIEW_H) * 0.75; // 450px for 600px viewport
    for (const lbl of result) {
      const len = Math.hypot(lbl.screenX - lbl.anchorX, lbl.screenY - lbl.anchorY);
      expect(len).toBeLessThan(maxAllowed);
    }
  });

  it('returns valid leaderPath strings for all styles', () => {
    const groups = [makeGroup('A', 350, 280), makeGroup('B', 450, 320)];
    for (const style of ['straight', 'curved', 'wedge'] as const) {
      const result = computeAroundLabels(groups, identityProject, VIEW_W, VIEW_H, { leaderStyle: style });
      for (const lbl of result) {
        expect(typeof lbl.leaderPath).toBe('string');
        expect(lbl.leaderPath.length).toBeGreaterThan(0);
        expect(lbl.leaderPath).toMatch(/^M/);
        if (style === 'straight') {
          expect(lbl.leaderPath).toMatch(/M.*L/);
        } else if (style === 'curved') {
          expect(lbl.leaderPath).toMatch(/M.*Q/);
        } else if (style === 'wedge') {
          expect(lbl.leaderPath).toMatch(/M.*L.*L.*Z/);
        }
      }
    }
  });

  it('anchor position matches the projected group position', () => {
    const groups = [makeGroup('A', 200, 100), makeGroup('B', 600, 400)];
    const result = computeAroundLabels(groups, identityProject, VIEW_W, VIEW_H);
    expect(result).toHaveLength(2);
    const aLabel = result.find((l) => l.key === 'A')!;
    const bLabel = result.find((l) => l.key === 'B')!;
    expect(aLabel).toBeDefined();
    expect(aLabel.anchorX).toBeCloseTo(200, 1);
    expect(aLabel.anchorY).toBeCloseTo(100, 1);
    expect(bLabel.anchorX).toBeCloseTo(600, 1);
    expect(bLabel.anchorY).toBeCloseTo(400, 1);
  });

  it('handles off-screen groups gracefully', () => {
    const groups = [
      makeGroup('A', 400, 300),          // on-screen
      makeGroup('B', -9999, -9999),      // off-screen → projectFn returns null
      makeGroup('C', 600, 400),          // on-screen
    ];
    // Project: B is off-screen.
    const projectFn = (wx: number, wy: number): [number, number] | null => {
      if (wx < -100 || wy < -100) return null;
      return [wx, wy];
    };
    const result = computeAroundLabels(groups, projectFn, VIEW_W, VIEW_H);
    // Should include A and C, not B.
    expect(result.map((l) => l.key).sort()).toEqual(['A', 'C'].sort());
  });

  it('no label center is within the point cloud extent (anchor clearance check)', () => {
    // Create 8 clusters spread over the viewport, provide allAnchorXY so the
    // per-angle sector radius covers the actual cloud boundary.
    const groups: AroundLabelGroup[] = [];
    const anchorPts: number[] = [];
    const PAD = 50; // padding passed to computeAroundLabels

    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const gcx = 400 + Math.cos(angle) * 120;
      const gcy = 300 + Math.sin(angle) * 120;
      groups.push(makeGroup(`G${i}`, gcx, gcy, `Cluster ${i}`, 14));
      // Simulate ~20 member points around each centroid (spread radius 30 px).
      for (let j = 0; j < 20; j++) {
        const a2 = (j / 20) * Math.PI * 2;
        anchorPts.push(gcx + Math.cos(a2) * 30, gcy + Math.sin(a2) * 30);
      }
    }
    const allAnchorXY = new Float32Array(anchorPts);
    const nAll = anchorPts.length / 2;

    const result = computeAroundLabels(
      groups, identityProject, VIEW_W, VIEW_H, { padding: PAD }, allAnchorXY, nAll,
    );

    expect(result.length).toBeGreaterThan(0);

    // Every label center must be at least 15 px away from every anchor point.
    // The absolute threshold (rather than a fraction of PAD) is robust to clamping
    // at forbidden zones (toolbar, legend, viewport edges) that can shrink the ideal
    // ring radius for labels near the boundary.
    const minClearance = 15;
    for (const lbl of result) {
      let closestDist = Infinity;
      for (let k = 0; k < anchorPts.length; k += 2) {
        const d = Math.hypot(lbl.screenX - anchorPts[k], lbl.screenY - anchorPts[k + 1]);
        if (d < closestDist) closestDist = d;
      }
      expect(closestDist).toBeGreaterThanOrEqual(minClearance);
    }
  });

  it('all labels stay inside the viewport', () => {
    const groups: AroundLabelGroup[] = [];
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      groups.push(makeGroup(
        `G${i}`,
        400 + Math.cos(angle) * 200,
        300 + Math.sin(angle) * 200,
        `Group ${i}`,
        14,
      ));
    }
    const result = computeAroundLabels(groups, identityProject, VIEW_W, VIEW_H);
    for (const lbl of result) {
      const { hw, hh } = labelHalf(lbl);
      expect(lbl.screenX - hw).toBeGreaterThan(-1);
      expect(lbl.screenX + hw).toBeLessThan(VIEW_W + 1);
      expect(lbl.screenY - hh).toBeGreaterThan(-1);
      expect(lbl.screenY + hh).toBeLessThan(VIEW_H + 1);
    }
  });
});

describe('buildAroundLabelGroups', () => {
  it('converts GroupLabel[] to AroundLabelGroup[] correctly', () => {
    const placed: GroupLabel[] = [
      { text: 'Alpha', x: 100, y: 200, count: 1000, group: 0, region: 0, key: 'Alpha' },
      { text: 'Beta', x: 300, y: 400, count: 500, group: 1, region: 0, key: 'Beta' },
    ];
    const sizes = [18, 14];
    const colors: [number, number, number, number][] = [[200, 100, 50, 255], [50, 200, 100, 255]];
    const clusterColors = ['#c86432', '#32c864'];
    const weights = [700, 500];
    const priorities = [10, 5];
    const badges: (([number, number, number, number]) | undefined)[] = [undefined, [80, 160, 80, 230]];
    const applyCase = (s: string) => s;

    const result = buildAroundLabelGroups(placed, sizes, colors, clusterColors, weights, priorities, badges, applyCase);

    expect(result).toHaveLength(2);
    expect(result[0].key).toBe('Alpha');
    expect(result[0].text).toBe('Alpha');
    expect(result[0].worldX).toBe(100);
    expect(result[0].worldY).toBe(200);
    expect(result[0].size).toBe(18);
    expect(result[0].clusterColor).toBe('#c86432');
    expect(result[0].weight).toBe(700);
    expect(result[0].badge).toBeUndefined();

    expect(result[1].key).toBe('Beta');
    expect(result[1].badge).toEqual([80, 160, 80, 230]);
  });

  it('applies textCase transformation', () => {
    const placed: GroupLabel[] = [{ text: 'hello world', x: 0, y: 0, count: 100, group: 0, region: 0, key: 'hello world' }];
    const result = buildAroundLabelGroups(
      placed, [14], [[200, 200, 200, 255]], [null], [600], [1], [undefined],
      (s) => s.toUpperCase(),
    );
    expect(result[0].text).toBe('HELLO WORLD');
    // Key should be the original (not uppercased).
    expect(result[0].key).toBe('hello world');
  });

  it('uses (empty) for empty text', () => {
    const placed: GroupLabel[] = [{ text: '', x: 0, y: 0, count: 50, group: 0, region: 0, key: '' }];
    const result = buildAroundLabelGroups(
      placed, [12], [[200, 200, 200, 255]], [null], [600], [1], [undefined],
      (s) => s,
    );
    expect(result[0].key).toBe('(empty)');
    expect(result[0].text).toBe('(empty)');
  });
});
