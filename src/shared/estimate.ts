// Shared by the extension host and tests (test/harness/host.js has a copy).

/**
 * Seconds to place the remaining rows. numpy: fitted to python/bench.py on an M4 Pro (per-row
 * top-k cost dominates). Rust core: fitted to python/bench_project.py on a 4-core Xeon, where it
 * is 8-13x faster at 20-50 dimensions and about 2x at 1,000 (docs/benchmarks.md).
 */
export function estimateSeconds(r: { flops: number; rows: number; backend?: 'rust' | 'numpy' }): number {
  return r.backend === 'rust' ? 1.2e-6 * r.rows + 6e-12 * r.flops : 1.2e-5 * r.rows + 2.2e-11 * r.flops;
}
