/**
 * Layout from precomputed coordinate columns.
 *
 * Auto-detection of default x/y[/z] column pairs and helpers for coords mode.
 */

import type { ColumnInfo } from '../../shared/protocol';

export interface CoordsColumns {
  x: number;
  y: number;
  z?: number;
}

/** Column kinds that can serve as coordinates. */
function isCoordEligible(c: ColumnInfo): boolean {
  return c.kind === 'numeric' || c.kind === 'datetime';
}

/**
 * Find the index of a column whose name matches one of the given candidates
 * (case-insensitive), restricted to coord-eligible columns.
 */
function findCol(columns: ColumnInfo[], names: string[]): number | null {
  for (const name of names) {
    const c = columns.find((col) => isCoordEligible(col) && col.name.toLowerCase() === name.toLowerCase());
    if (c !== undefined) return c.index;
  }
  return null;
}

/**
 * Auto-detect the most plausible x/y[/z] column triple from a set of DataFrame columns.
 *
 * Priority (case-insensitive):
 *  1. umap_x / umap_y / umap_z
 *  2. x / y / z
 *  3. tsne_1 / tsne_2  or  tsne_x / tsne_y
 *  4. pc1 / pc2  or  PC1 / PC2
 *
 * Returns null when no plausible pair is found.
 */
export function detectCoordsColumns(columns: ColumnInfo[]): CoordsColumns | null {
  // Define candidate triples (x names, y names, z names)
  const candidates: [string[], string[], string[]][] = [
    [['umap_x'], ['umap_y'], ['umap_z']],
    [['x'], ['y'], ['z']],
    [['tsne_1', 'tsne_x'], ['tsne_2', 'tsne_y'], []],
    [['pc1', 'PC1'], ['pc2', 'PC2'], ['pc3', 'PC3']],
  ];

  for (const [xNames, yNames, zNames] of candidates) {
    const xi = findCol(columns, xNames);
    const yi = findCol(columns, yNames);
    if (xi !== null && yi !== null && xi !== yi) {
      const zi = zNames.length > 0 ? findCol(columns, zNames) : null;
      const result: CoordsColumns = { x: xi, y: yi };
      if (zi !== null && zi !== xi && zi !== yi) result.z = zi;
      return result;
    }
  }
  return null;
}

/** Return the first coord-eligible column index (for default fallback). */
export function firstCoordColumn(columns: ColumnInfo[]): number | null {
  const c = columns.find(isCoordEligible);
  return c?.index ?? null;
}

/** Return all coord-eligible columns. */
export function coordEligibleColumns(columns: ColumnInfo[]): ColumnInfo[] {
  return columns.filter(isCoordEligible);
}
