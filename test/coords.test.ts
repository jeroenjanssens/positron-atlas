import { describe, expect, it } from 'vitest';
import { detectCoordsColumns, coordEligibleColumns, firstCoordColumn } from '../src/webview/atlas/coords';
import type { ColumnInfo } from '../src/shared/protocol';

function col(index: number, name: string, kind: ColumnInfo['kind'] = 'numeric'): ColumnInfo {
  return { index, name, kind, dtype: 'f64', null_frac: 0, n_unique_est: null };
}

describe('detectCoordsColumns', () => {
  it('detects umap_x / umap_y pair', () => {
    const cols = [col(0, 'label', 'categorical'), col(1, 'umap_x'), col(2, 'umap_y')];
    expect(detectCoordsColumns(cols)).toEqual({ x: 1, y: 2 });
  });

  it('detects umap_x / umap_y / umap_z triple', () => {
    const cols = [col(0, 'umap_x'), col(1, 'umap_y'), col(2, 'umap_z')];
    expect(detectCoordsColumns(cols)).toEqual({ x: 0, y: 1, z: 2 });
  });

  it('detects x / y pair', () => {
    const cols = [col(0, 'x'), col(1, 'y'), col(2, 'label', 'categorical')];
    expect(detectCoordsColumns(cols)).toEqual({ x: 0, y: 1 });
  });

  it('detects x / y / z triple', () => {
    const cols = [col(0, 'x'), col(1, 'y'), col(2, 'z')];
    expect(detectCoordsColumns(cols)).toEqual({ x: 0, y: 1, z: 2 });
  });

  it('detects tsne_1 / tsne_2', () => {
    const cols = [col(0, 'tsne_1'), col(1, 'tsne_2')];
    expect(detectCoordsColumns(cols)).toEqual({ x: 0, y: 1 });
  });

  it('detects tsne_x / tsne_y', () => {
    const cols = [col(0, 'tsne_x'), col(1, 'tsne_y')];
    expect(detectCoordsColumns(cols)).toEqual({ x: 0, y: 1 });
  });

  it('detects pc1 / pc2 (lowercase)', () => {
    const cols = [col(0, 'pc1'), col(1, 'pc2')];
    expect(detectCoordsColumns(cols)).toEqual({ x: 0, y: 1 });
  });

  it('detects PC1 / PC2 (uppercase)', () => {
    const cols = [col(0, 'PC1'), col(1, 'PC2')];
    expect(detectCoordsColumns(cols)).toEqual({ x: 0, y: 1 });
  });

  it('detects pc1 / pc2 / pc3 triple', () => {
    const cols = [col(0, 'pc1'), col(1, 'pc2'), col(2, 'pc3')];
    expect(detectCoordsColumns(cols)).toEqual({ x: 0, y: 1, z: 2 });
  });

  it('is case-insensitive for umap_x', () => {
    const cols = [col(0, 'UMAP_X'), col(1, 'UMAP_Y')];
    expect(detectCoordsColumns(cols)).toEqual({ x: 0, y: 1 });
  });

  it('prefers umap_x over x when both exist', () => {
    const cols = [col(0, 'x'), col(1, 'y'), col(2, 'umap_x'), col(3, 'umap_y')];
    expect(detectCoordsColumns(cols)).toEqual({ x: 2, y: 3 });
  });

  it('returns null when no pair found', () => {
    const cols = [col(0, 'feature_a'), col(1, 'feature_b')];
    expect(detectCoordsColumns(cols)).toBeNull();
  });

  it('returns null for empty column list', () => {
    expect(detectCoordsColumns([])).toBeNull();
  });

  it('requires distinct x and y column indices', () => {
    // Only one coord-eligible column named x — y doesn't exist → no pair
    const cols = [col(0, 'x'), col(1, 'label', 'categorical')];
    expect(detectCoordsColumns(cols)).toBeNull();
  });

  it('accepts datetime columns as coord-eligible', () => {
    const cols = [col(0, 'x', 'datetime'), col(1, 'y', 'datetime')];
    expect(detectCoordsColumns(cols)).toEqual({ x: 0, y: 1 });
  });

  it('ignores non-coord-eligible columns even if name matches', () => {
    // 'x' and 'y' are categorical — should not be picked
    const cols = [col(0, 'x', 'categorical'), col(1, 'y', 'categorical')];
    expect(detectCoordsColumns(cols)).toBeNull();
  });
});

describe('coordEligibleColumns', () => {
  it('returns numeric and datetime columns', () => {
    const cols = [
      col(0, 'a', 'numeric'),
      col(1, 'b', 'categorical'),
      col(2, 'c', 'datetime'),
      col(3, 'd', 'bool'),
    ];
    const result = coordEligibleColumns(cols);
    expect(result.map((c) => c.index)).toEqual([0, 2]);
  });

  it('returns empty for no eligible columns', () => {
    const cols = [col(0, 'cat', 'categorical')];
    expect(coordEligibleColumns(cols)).toHaveLength(0);
  });
});

describe('firstCoordColumn', () => {
  it('returns index of first eligible column', () => {
    const cols = [col(0, 'cat', 'categorical'), col(1, 'num', 'numeric')];
    expect(firstCoordColumn(cols)).toBe(1);
  });

  it('returns null when no eligible columns', () => {
    const cols = [col(0, 'cat', 'categorical')];
    expect(firstCoordColumn(cols)).toBeNull();
  });
});
