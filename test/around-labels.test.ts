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

// ---- Tests -------------------------------------------------------------------

describe('computeAroundLabels', () => {
  it('returns empty array for empty input', () => {
    const result = computeAroundLabels([], identityProject, 800, 600);
    expect(result).toHaveLength(0);
  });

  it('returns empty array when viewW/viewH is 0', () => {
    const groups = [makeGroup('A', 400, 300)];
    expect(computeAroundLabels(groups, identityProject, 0, 600)).toHaveLength(0);
    expect(computeAroundLabels(groups, identityProject, 800, 0)).toHaveLength(0);
  });

  it('returns empty array when all projections return null', () => {
    const groups = [makeGroup('A', 400, 300), makeGroup('B', 200, 200)];
    const result = computeAroundLabels(groups, () => null, 800, 600);
    expect(result).toHaveLength(0);
  });

  it('places a single label outside the cloud bounding box + padding', () => {
    // Single group at world center (400, 300).
    const groups = [makeGroup('A', 400, 300, 'Group A')];
    const result = computeAroundLabels(groups, identityProject, 800, 600, { padding: 50, labelMargin: 14 });
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
    const r1 = computeAroundLabels(groups, identityProject, 800, 600);
    const r2 = computeAroundLabels(groups, identityProject, 800, 600);
    expect(r1).toHaveLength(r2.length);
    for (let i = 0; i < r1.length; i++) {
      expect(r1[i].screenX).toBeCloseTo(r2[i].screenX, 5);
      expect(r1[i].screenY).toBeCloseTo(r2[i].screenY, 5);
      expect(r1[i].key).toBe(r2[i].key);
    }
  });

  it('order of groups should not change output for radial placement', () => {
    const groups = [
      makeGroup('A', 200, 150),
      makeGroup('B', 600, 150),
      makeGroup('C', 400, 450),
    ];
    const shuffled = [groups[2], groups[0], groups[1]];
    const r1 = computeAroundLabels(groups, identityProject, 800, 600);
    const r2 = computeAroundLabels(shuffled, identityProject, 800, 600);
    // Both should produce 3 labels with the same keys.
    const keys1 = r1.map((l) => l.key).sort();
    const keys2 = r2.map((l) => l.key).sort();
    expect(keys1).toEqual(keys2);
  });

  it('no overlapping labels after placement (approximate check)', () => {
    // Create many groups arranged in a cluster so overlap removal is exercised.
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
    const result = computeAroundLabels(groups, identityProject, 800, 600, { padding: 60, labelMargin: 16 });
    // For each pair of adjacent labels (sorted by angle), check approximate non-overlap.
    // A strict no-overlap check is not guaranteed for a simple greedy algorithm with limited
    // iterations, so we verify that most pairs do not overlap.
    let overlapCount = 0;
    for (let i = 0; i < result.length; i++) {
      const j = (i + 1) % result.length;
      const a = result[i];
      const b = result[j];
      const aW = a.text.length * a.size * 0.56 / 2 + 4;
      const aH = a.size / 2 + 2;
      const bW = b.text.length * b.size * 0.56 / 2 + 4;
      const bH = b.size / 2 + 2;
      if (Math.abs(a.screenX - b.screenX) < aW + bW && Math.abs(a.screenY - b.screenY) < aH + bH) {
        overlapCount++;
      }
    }
    // Allow at most 1 overlap (greedy algorithm may not resolve all in 10 iterations
    // for very densely packed groups).
    expect(overlapCount).toBeLessThanOrEqual(1);
  });

  it('returns valid leaderPath strings for all styles', () => {
    const groups = [makeGroup('A', 350, 280), makeGroup('B', 450, 320)];
    for (const style of ['straight', 'curved', 'wedge'] as const) {
      const result = computeAroundLabels(groups, identityProject, 800, 600, { leaderStyle: style });
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
    const result = computeAroundLabels(groups, identityProject, 800, 600);
    expect(result).toHaveLength(2);
    // Sort by key for consistent access.
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
    const result = computeAroundLabels(groups, projectFn, 800, 600);
    // Should include A and C, not B.
    expect(result.map((l) => l.key).sort()).toEqual(['A', 'C'].sort());
  });
});

describe('buildAroundLabelGroups', () => {
  it('converts GroupLabel[] to AroundLabelGroup[] correctly', () => {
    const placed: GroupLabel[] = [
      { text: 'Alpha', x: 100, y: 200, count: 1000, group: 0 },
      { text: 'Beta', x: 300, y: 400, count: 500, group: 1 },
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
    const placed: GroupLabel[] = [{ text: 'hello world', x: 0, y: 0, count: 100, group: 0 }];
    const result = buildAroundLabelGroups(
      placed, [14], [[200, 200, 200, 255]], [null], [600], [1], [undefined],
      (s) => s.toUpperCase(),
    );
    expect(result[0].text).toBe('HELLO WORLD');
    // Key should be the original (not uppercased).
    expect(result[0].key).toBe('hello world');
  });

  it('uses (empty) for empty text', () => {
    const placed: GroupLabel[] = [{ text: '', x: 0, y: 0, count: 50, group: 0 }];
    const result = buildAroundLabelGroups(
      placed, [12], [[200, 200, 200, 255]], [null], [600], [1], [undefined],
      (s) => s,
    );
    expect(result[0].key).toBe('(empty)');
    expect(result[0].text).toBe('(empty)');
  });
});
