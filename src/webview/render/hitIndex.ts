/** Uniform-grid spatial index over 2D points for nearest-point hover lookups. */
export class HitIndex {
  private readonly order: Uint32Array;
  private readonly start: Int32Array;
  private readonly minX: number;
  private readonly minY: number;
  private readonly cell: number;
  private readonly gw: number;
  private readonly gh: number;

  constructor(
    private readonly xy: Float32Array,
    readonly n: number,
  ) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = xy[2 * i];
      const y = xy[2 * i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!isFinite(minX)) {
      minX = minY = 0;
      maxX = maxY = 1;
    }
    const w = Math.max(maxX - minX, 1e-9);
    const h = Math.max(maxY - minY, 1e-9);
    const target = Math.max(1, n / 4);
    const cell = Math.sqrt((w * h) / target) || 1;
    this.gw = Math.max(1, Math.min(4096, Math.ceil(w / cell)));
    this.gh = Math.max(1, Math.min(4096, Math.ceil(h / cell)));
    this.cell = Math.max(w / this.gw, h / this.gh);
    this.minX = minX;
    this.minY = minY;
    const cells = this.gw * this.gh;
    const counts = new Int32Array(cells + 1);
    const cellOf = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const c = this.cellIndex(xy[2 * i], xy[2 * i + 1]);
      cellOf[i] = c;
      counts[c + 1]++;
    }
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    this.start = counts;
    const fill = counts.slice(0, cells);
    this.order = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.order[fill[cellOf[i]]++] = i;
  }

  private cellXY(x: number, y: number): [number, number] {
    const cx = Math.min(this.gw - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)));
    const cy = Math.min(this.gh - 1, Math.max(0, Math.floor((y - this.minY) / this.cell)));
    return [cx, cy];
  }

  private cellIndex(x: number, y: number): number {
    const [cx, cy] = this.cellXY(x, y);
    return cy * this.gw + cx;
  }

  /** Indices of the k nearest points (may be fewer if the index is small). */
  nearestK(x: number, y: number, k: number): number[] {
    const radius = this.cell * Math.ceil(Math.sqrt(k)) * 3;
    const results: { d: number; i: number }[] = [];
    const [cx, cy] = this.cellXY(x, y);
    const maxRing = Math.ceil(radius / this.cell) + 1;
    for (let r = 0; r <= maxRing; r++) {
      for (let gy = cy - r; gy <= cy + r; gy++) {
        if (gy < 0 || gy >= this.gh) continue;
        for (let gx = cx - r; gx <= cx + r; gx++) {
          if (gx < 0 || gx >= this.gw) continue;
          if (Math.max(Math.abs(gx - cx), Math.abs(gy - cy)) !== r) continue;
          const c = gy * this.gw + gx;
          for (let ki = this.start[c]; ki < this.start[c + 1]; ki++) {
            const i = this.order[ki];
            const dx = this.xy[2 * i] - x;
            const dy = this.xy[2 * i + 1] - y;
            results.push({ d: dx * dx + dy * dy, i });
          }
        }
      }
      if (results.length >= k && (r - 1) * this.cell > 0) break;
    }
    results.sort((a, b) => a.d - b.d);
    return results.slice(0, k).map((r) => r.i);
  }

  /** Index of the nearest point within maxDist (world units), or -1. */
  nearest(x: number, y: number, maxDist: number): number {
    const [cx, cy] = this.cellXY(x, y);
    let best = -1;
    let bestD = maxDist * maxDist;
    const maxRing = Math.ceil(maxDist / this.cell) + 1;
    for (let r = 0; r <= maxRing; r++) {
      // Stop when the ring is farther than the best match so far.
      if (best >= 0 && (r - 1) * this.cell > Math.sqrt(bestD)) break;
      for (let gy = cy - r; gy <= cy + r; gy++) {
        if (gy < 0 || gy >= this.gh) continue;
        for (let gx = cx - r; gx <= cx + r; gx++) {
          if (gx < 0 || gx >= this.gw) continue;
          if (Math.max(Math.abs(gx - cx), Math.abs(gy - cy)) !== r) continue;
          const c = gy * this.gw + gx;
          for (let k = this.start[c]; k < this.start[c + 1]; k++) {
            const i = this.order[k];
            const dx = this.xy[2 * i] - x;
            const dy = this.xy[2 * i + 1] - y;
            const d = dx * dx + dy * dy;
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
    }
    return best;
  }
}

export function bounds(xy: Float32Array, n: number): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = xy[2 * i];
    const y = xy[2 * i + 1];
    if (x !== x || y !== y) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!isFinite(minX)) return [-1, -1, 1, 1];
  return [minX, minY, maxX, maxY];
}
