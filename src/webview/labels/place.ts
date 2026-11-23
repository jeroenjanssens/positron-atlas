// Label placement for groups of points (categories of a column, or clusters).

export interface GroupLabel {
  /** Group (category) index. */
  group: number;
  text: string;
  x: number;
  y: number;
  /** Number of points of the group in the input (of the region, in 'regions' mode). */
  count: number;
  /** 0 for the group's main label; 1, 2, … for its further regions ('regions' mode). */
  region: number;
  /** Stable key for dragged-label offsets: the text, plus " #2", " #3", … for further regions. */
  key: string;
  /** 3D layouts (stride 3): the mean z of the same points. */
  z?: number;
}

/** How labels are placed for each group. */
export type LabelPlacement = 'peak' | 'medoid' | 'regions';

export interface PlaceOptions {
  /** Grid cells along the longer side of the bounds (default 64). */
  grid?: number;
  /**
   * 'peak' (default): one label per group at its densest spot.
   * 'medoid': one label per group at its medoid (DataMapPlot's choice; can fall between blobs).
   * 'regions': one label per separate region of the group's points, so a label can repeat.
   */
  mode?: LabelPlacement;
  /** 'regions': at most this many labels per group (default 3). */
  maxPerGroup?: number;
  /** 'regions': a region needs at least this share of its group's points (default 0.1). */
  minShare?: number;
  /** At most this many labels in total, largest groups/regions first (0 or undefined: all). */
  maxLabels?: number;
  /** Values per point in `xy`: 2 (x, y) or 3 (x, y, z). Placement uses x and y. */
  stride?: 2 | 3;
}

/** 'regions': a cell belongs to a region when its smoothed count is at least this share of the group's peak. */
const REGION_DENSITY = 0.05;

/** Points per group used to find a medoid (exact on the sample, O(m²)). */
const MEDOID_SAMPLE = 800;

/**
 * Place labels for groups of points.
 *
 * A centroid can fall between two blobs of the same group, or outside a curved one. Instead,
 * each group's points are binned on a grid over the map and the counts are smoothed with a
 * 3×3 box filter. 'peak' puts one label at the mean position of the group's points in its
 * densest cell and the eight neighbours (always on the group's points). 'regions' splits the
 * group's occupied cells into connected regions and labels each region that holds at least
 * `minShare` of the group, at the region's own peak. 'medoid' uses the point with the
 * smallest total distance to the group's (sampled) points.
 *
 * `codes[i]` is the group of point i; codes >= names.length (e.g. "Other" or missing) and
 * non-finite positions are ignored. Groups without points get no label.
 */
export function placeGroupLabels(xy: Float32Array, codes: ArrayLike<number>, n: number, names: string[], opts: PlaceOptions = {}): GroupLabel[] {
  const k = names.length;
  if (k === 0 || n === 0) return [];
  const mode = opts.mode ?? 'peak';
  const d = opts.stride ?? 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = xy[d * i];
    const y = xy[d * i + 1];
    if (!(x === x && y === y) || codes[i] >= k) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!isFinite(minX)) return [];

  const out = mode === 'medoid' ? placeMedoids(xy, codes, n, names, d) : placePeaks(xy, codes, n, names, opts, d, minX, minY, maxX, maxY);
  const maxLabels = opts.maxLabels ?? 0;
  if (maxLabels > 0 && out.length > maxLabels) {
    // Keep the largest; ties keep group order.
    const kept = new Set([...out].sort((a, b) => b.count - a.count || a.group - b.group).slice(0, maxLabels));
    return out.filter((l) => kept.has(l));
  }
  return out;
}

function labelKey(text: string, region: number): string {
  return region === 0 ? text : `${text} #${region + 1}`;
}

function placePeaks(
  xy: Float32Array,
  codes: ArrayLike<number>,
  n: number,
  names: string[],
  opts: PlaceOptions,
  d: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): GroupLabel[] {
  const k = names.length;
  const regions = opts.mode === 'regions';
  const maxPerGroup = regions ? Math.max(1, Math.round(opts.maxPerGroup ?? 3)) : 1;
  const minShare = Math.min(1, Math.max(0, opts.minShare ?? 0.1));
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
    const x = xy[d * i];
    const y = xy[d * i + 1];
    if (g >= k || !(x === x && y === y)) continue;
    hist[g * size + cellOf(x, y)]++;
    count[g]++;
  }

  // Peaks: per group, the densest occupied cell (3×3-smoothed) of each kept region.
  const smooth = new Uint32Array(size);
  const comp = new Int32Array(size);
  const stack: number[] = [];
  const peaks: number[][] = [];
  const masses: number[][] = [];
  for (let g = 0; g < k; g++) {
    peaks.push([]);
    masses.push([]);
    if (count[g] === 0) continue;
    const base = g * size;
    for (let cy = 0; cy < gh; cy++) {
      for (let cx = 0; cx < gw; cx++) {
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
        smooth[cy * gw + cx] = v;
      }
    }
    if (!regions) {
      let best = -1;
      let bestV = -1;
      for (let c = 0; c < size; c++) {
        if (hist[base + c] > 0 && smooth[c] > bestV) {
          bestV = smooth[c];
          best = c;
        }
      }
      peaks[g].push(best);
      masses[g].push(count[g]);
      continue;
    }
    // Regions: 8-connected components of the cells that hold points and are dense enough;
    // the threshold keeps a few stray points from bridging two separate islands.
    let peakV = 0;
    for (let c = 0; c < size; c++) if (hist[base + c] > 0 && smooth[c] > peakV) peakV = smooth[c];
    const dense = (c: number) => hist[base + c] > 0 && smooth[c] >= REGION_DENSITY * peakV;
    comp.fill(-1);
    const found: { peak: number; mass: number }[] = [];
    for (let c0 = 0; c0 < size; c0++) {
      if (!dense(c0) || comp[c0] >= 0) continue;
      const id = found.length;
      let mass = 0;
      let best = c0;
      comp[c0] = id;
      stack.push(c0);
      while (stack.length) {
        const c = stack.pop()!;
        mass += hist[base + c];
        if (smooth[c] > smooth[best]) best = c;
        const cx = c % gw;
        const cy = (c - cx) / gw;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = cy + dy;
          if (yy < 0 || yy >= gh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = cx + dx;
            if (xx < 0 || xx >= gw) continue;
            const nc = yy * gw + xx;
            if (dense(nc) && comp[nc] < 0) {
              comp[nc] = id;
              stack.push(nc);
            }
          }
        }
      }
      found.push({ peak: best, mass });
    }
    found.sort((a, b) => b.mass - a.mass);
    // The largest region is always labelled; the others need minShare of the group.
    for (let r = 0; r < found.length && peaks[g].length < maxPerGroup; r++) {
      if (r > 0 && found[r].mass < minShare * count[g]) break;
      peaks[g].push(found[r].peak);
      masses[g].push(found[r].mass);
    }
  }

  // Pass 2: mean position of each group's points around each of its peaks.
  const offset: number[] = [];
  let total = 0;
  for (let g = 0; g < k; g++) {
    offset.push(total);
    total += peaks[g].length;
  }
  const sx = new Float64Array(total);
  const sy = new Float64Array(total);
  const sn = new Uint32Array(total);
  const sz = new Float64Array(total);
  for (let i = 0; i < n; i++) {
    const g = codes[i];
    const x = xy[d * i];
    const y = xy[d * i + 1];
    if (g >= k || !(x === x && y === y)) continue;
    const c = cellOf(x, y);
    const cx = c % gw;
    const cy = (c - cx) / gw;
    const ps = peaks[g];
    for (let r = 0; r < ps.length; r++) {
      const p = ps[r];
      if (Math.abs(cx - (p % gw)) <= 1 && Math.abs(cy - Math.floor(p / gw)) <= 1) {
        const j = offset[g] + r;
        sx[j] += x;
        sy[j] += y;
        if (d === 3) sz[j] += xy[3 * i + 2];
        sn[j]++;
        break;
      }
    }
  }

  const out: GroupLabel[] = [];
  for (let g = 0; g < k; g++) {
    for (let r = 0; r < peaks[g].length; r++) {
      const j = offset[g] + r;
      if (sn[j] === 0) continue;
      const l: GroupLabel = { group: g, text: names[g], x: sx[j] / sn[j], y: sy[j] / sn[j], count: regions ? masses[g][r] : count[g], region: r, key: labelKey(names[g], r) };
      if (d === 3) l.z = sz[j] / sn[j];
      out.push(l);
    }
  }
  return out;
}

function placeMedoids(xy: Float32Array, codes: ArrayLike<number>, n: number, names: string[], d: number): GroupLabel[] {
  const k = names.length;
  const members: number[][] = names.map(() => []);
  for (let i = 0; i < n; i++) {
    const g = codes[i];
    const x = xy[d * i];
    const y = xy[d * i + 1];
    if (g < k && x === x && y === y) members[g].push(i);
  }
  const out: GroupLabel[] = [];
  for (let g = 0; g < k; g++) {
    const m = members[g];
    if (m.length === 0) continue;
    // A deterministic, evenly spread sample keeps this O(MEDOID_SAMPLE²) per group.
    const step = Math.max(1, m.length / MEDOID_SAMPLE);
    const sample: number[] = [];
    for (let t = 0; t < m.length && sample.length < MEDOID_SAMPLE; t += step) sample.push(m[Math.floor(t)]);
    let best = sample[0];
    let bestD = Infinity;
    for (const a of sample) {
      const ax = xy[d * a];
      const ay = xy[d * a + 1];
      let total = 0;
      for (const b of sample) total += Math.hypot(xy[d * b] - ax, xy[d * b + 1] - ay);
      if (total < bestD) {
        bestD = total;
        best = a;
      }
    }
    const l: GroupLabel = { group: g, text: names[g], x: xy[d * best], y: xy[d * best + 1], count: m.length, region: 0, key: names[g] };
    if (d === 3) l.z = xy[3 * best + 2];
    out.push(l);
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
