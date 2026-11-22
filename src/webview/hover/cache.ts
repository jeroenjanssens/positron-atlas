/**
 * LRU cache for hover row values (H3).
 *
 * Keyed by prepared-row index. Entries are evicted when the cache exceeds capacity.
 */
export class LruCache<V> {
  private readonly map = new Map<number, V>();

  constructor(private readonly capacity: number) {}

  get(key: number): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      // Move to tail (most-recently-used).
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: number, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      // Evict the oldest entry (first in Map iteration order).
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(key, value);
  }

  has(key: number): boolean {
    return this.map.has(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/** Row entry in the hover cache. */
export interface CachedRow {
  /** Original (DataFrame) row index. */
  row: number;
  /** Column name → formatted value pairs. */
  values: [string, string][];
  /** Pixel column values when "points are images". */
  image?: (number | null)[];
  /** Resolved image URI when an image-URL column is configured. */
  imageUri?: string;
}
