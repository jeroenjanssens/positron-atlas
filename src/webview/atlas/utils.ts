/**
 * Pure utility functions for the Atlas module.
 */

import { hexToRgb } from '../color/colormaps';
import { toHex } from '../logic';

/** Gather uint16 values at the given indices. */
export function gatherU16(values: Uint16Array, idx: Uint32Array): Uint16Array {
  const out = new Uint16Array(idx.length);
  for (let i = 0; i < idx.length; i++) out[i] = values[idx[i]];
  return out;
}

/** Near-white text on dark backgrounds, near-black on light ones. */
export function contrastText(background: string): [number, number, number, number] {
  const [r, g, b] = hexToRgb(toHex(background));
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum < 0.5 ? [235, 235, 235, 255] : [25, 25, 25, 255];
}

/**
 * Text color for a label in its group's color: mixed 40% toward the plain text color (lighter on
 * dark backgrounds, darker on light ones), so it stands out from points of the same color.
 * DataMapPlot does the same with its "deep" label palette.
 */
export function labelTextColor(rgb: [number, number, number], plain: [number, number, number, number], t = 0.4): [number, number, number, number] {
  return [0, 1, 2].map((i) => Math.round(rgb[i] * (1 - t) + plain[i] * t)).concat(255) as [number, number, number, number];
}

/** The editor's font family (for map labels). */
export function fontFamily(): string {
  return getComputedStyle(document.body).fontFamily || 'sans-serif';
}

/** The theme's editor background as a #rrggbb hex string (for <input type="color">). */
export function themeBackground(): string {
  const raw = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e';
  return toHex(raw);
}

export async function probeWebGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as any).gpu;
    if (!gpu) return false;
    const adapter = await Promise.race([gpu.requestAdapter(), new Promise((r) => setTimeout(() => r(null), 2000))]);
    return !!adapter;
  } catch {
    return false;
  }
}

/**
 * Name each group by the most common value of a column among its rows: the value alone when it
 * covers at least 80% of the group, otherwise with its share ("7 (62%)").
 */
export function dominantNames(groups: Uint16Array, k: number, values: Uint16Array, categories: string[]): string[] {
  const m = categories.length;
  const counts = new Uint32Array(k * (m + 2));
  const totals = new Uint32Array(k);
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g >= k) continue;
    totals[g]++;
    const v = values[i];
    if (v < m) counts[g * (m + 2) + v]++;
  }
  const out: string[] = [];
  for (let g = 0; g < k; g++) {
    let best = -1;
    let bestN = 0;
    for (let v = 0; v < m; v++) {
      const c = counts[g * (m + 2) + v];
      if (c > bestN) [best, bestN] = [v, c];
    }
    if (best < 0 || totals[g] === 0) {
      out.push(`Cluster ${g + 1}`);
      continue;
    }
    const share = bestN / totals[g];
    const name = categories[best] === '' ? '(empty)' : categories[best];
    out.push(share >= 0.8 ? name : `${name} (${Math.round(share * 100)}%)`);
  }
  return out;
}
