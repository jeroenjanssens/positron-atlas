// Label placement for groups of points (categories of a column, or clusters).

export interface GroupLabel {
  /** Group (category) index. */
  group: number;
  text: string;
  x: number;
  y: number;
  /** Number of points of the group in the input. */
  count: number;
}

export interface PlaceOptions {
  /** Grid cells along the longer side of the bounds (default 64). */
  grid?: number;
}

/**
 * Place one label per group at the group's densest spot.
 *
 * A centroid can fall between two blobs of the same group, or outside a curved one. Instead,
 * each group's points are binned on a grid over the map, the counts are smoothed with a 3×3
 * box filter, and the label goes to the mean position of the group's points in the densest
 * cell and its eight neighbors. That spot always lies on the group's points.
 *
 * `codes[i]` is the group of point i; codes >= names.length (e.g. "Other" or missing) and
 * non-finite positions are ignored. Groups without points get no label.
 */
export function placeGroupLabels(xy: Float32Array, codes: ArrayLike<number>, n: number, names: string[], opts: PlaceOptions = {}): GroupLabel[] {
  const k = names.length;
  if (k === 0 || n === 0) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = xy[2 * i];
    const y = xy[2 * i + 1];
    if (!(x === x && y === y) || codes[i] >= k) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!isFinite(minX)) return [];
  const longest = Math.max(maxX - minX, maxY - minY, 1e-9);
  const cells = Math.max(4, Math.round(opts.grid ?? 64));
  const cell = longest / cells;
  const gw = Math.max(1, Math.min(cells, Math.ceil((maxX - minX) / cell) || 1));
  const gh = Math.max(1, Math.min(cells, Math.ceil((maxY - minY) / cell) || 1));
  const cellOf = (x: number, y: number): number => {
    const cx = Math.min(gw - 1, Math.floor((x - minX) / cell));
    const cy = Math.min(gh - 1, Math.floor((y - minY) / cell));
    return cy * gw + cx;
  };

  // Pass 1: per-group histograms.
  const size = gw * gh;
  const hist = new Uint32Array(k * size);
  const count = new Uint32Array(k);
  for (let i = 0; i < n; i++) {
    const g = codes[i];
    const x = xy[2 * i];
    const y = xy[2 * i + 1];
    if (g >= k || !(x === x && y === y)) continue;
    hist[g * size + cellOf(x, y)]++;
    count[g]++;
  }

  // Densest cell per group after 3×3 box smoothing.
  const peak = new Int32Array(k).fill(-1);
  for (let g = 0; g < k; g++) {
    if (count[g] === 0) continue;
    const base = g * size;
    let best = -1;
    let bestV = -1;
    for (let cy = 0; cy < gh; cy++) {
      for (let cx = 0; cx < gw; cx++) {
        if (hist[base + cy * gw + cx] === 0) continue; // the peak must hold points itself
        let v = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = cy + dy;
          if (yy < 0 || yy >= gh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = cx + dx;
            if (xx < 0 || xx >= gw) continue;
            v += hist[base + yy * gw + xx];
          }
        }
        if (v > bestV) {
          bestV = v;
          best = cy * gw + cx;
        }
      }
    }
    peak[g] = best;
  }

  // Pass 2: mean position of each group's points around its peak.
  const sx = new Float64Array(k);
  const sy = new Float64Array(k);
  const sn = new Uint32Array(k);
  for (let i = 0; i < n; i++) {
    const g = codes[i];
    const x = xy[2 * i];
    const y = xy[2 * i + 1];
    if (g >= k || !(x === x && y === y)) continue;
    const p = peak[g];
    const c = cellOf(x, y);
    if (Math.abs((c % gw) - (p % gw)) <= 1 && Math.abs(Math.floor(c / gw) - Math.floor(p / gw)) <= 1) {
      sx[g] += x;
      sy[g] += y;
      sn[g]++;
    }
  }

  const out: GroupLabel[] = [];
  for (let g = 0; g < k; g++) {
    if (sn[g] === 0) continue;
    out.push({ group: g, text: names[g], x: sx[g] / sn[g], y: sy[g] / sn[g], count: count[g] });
  }
  return out;
}

/**
 * Font size per label: proportional to the square root of the group size relative to the largest
 * group (area-proportional), from minPx (tiny groups) to maxPx (the largest group). Groups of
 * nearly equal size get nearly equal labels.
 */
export function labelSizes(counts: number[], minPx: number, maxPx: number): number[] {
  if (counts.length === 0) return [];
  const top = Math.sqrt(Math.max(...counts, 0));
  if (top <= 0) return counts.map(() => minPx);
  return counts.map((c) => minPx + (Math.sqrt(Math.max(0, c)) / top) * (maxPx - minPx));
}

/**
 * Collision priorities for deck.gl's CollisionFilterExtension: larger groups win. Spread over
 * [-900, 900] because the extension keeps priorities in a 16-bit depth buffer, where small
 * gaps lose their order (DataMapPlot's compute_collision_priority; TutteInstitute/datamapplot#192).
 * `level` (0 = finest) dominates when labels come from several levels; coarser levels win.
 */
export function collisionPriorities(counts: number[], levels?: number[], range = 900): number[] {
  if (counts.length === 0) return [];
  const nLevels = levels && levels.length ? Math.max(...levels) + 1 : 1;
  const band = (2 * range) / nLevels;
  const lo = Math.min(...counts);
  const hi = Math.max(...counts);
  return counts.map((c, i) => {
    const t = hi > lo ? (c - lo) / (hi - lo) : 0.5;
    const level = levels ? levels[i] : 0;
    // Leave a 10% gap between level bands.
    return -range + level * band + (0.05 + 0.9 * t) * band;
  });
}
