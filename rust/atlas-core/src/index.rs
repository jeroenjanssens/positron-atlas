//! IVF index over the anchors: k-means cells, each query scans its `nprobe` nearest cells.
//! For small anchor sets (≤ 4,096) the index is exact (one cell, scanned completely).

use crate::dist::{matmul_abt, normalize, row_sq_norms, sqdist};
use crate::kmeans::{kmeans, nearest_centroid};
use crate::rng::Pcg32;

/// Anchor sets up to this size are searched exhaustively.
pub const EXACT_MAX: usize = 4096;

#[derive(Clone, Debug)]
pub struct IndexOptions {
    pub seed: u64,
    /// Number of nearest cells scanned per query.
    pub nprobe: usize,
    /// Cosine metric: anchors and queries are scaled to unit length (then euclidean).
    pub cosine: bool,
}

impl Default for IndexOptions {
    fn default() -> Self {
        IndexOptions { seed: 0, nprobe: 4, cosine: false }
    }
}

pub struct AnchorIndex {
    d: usize,
    n: usize,
    cosine: bool,
    nprobe: usize,
    /// Anchors reordered so that each cell's anchors are contiguous (row-major, d columns).
    data: Vec<f32>,
    /// Original anchor index of each reordered row.
    ids: Vec<u32>,
    /// Cell c holds reordered rows cell_start[c]..cell_start[c + 1].
    cell_start: Vec<usize>,
    /// Cell centroids (row-major); empty when exact.
    centroids: Vec<f32>,
    /// Squared norms of the reordered anchors and of the centroids.
    data_sq: Vec<f32>,
    cent_sq: Vec<f32>,
}

/// Anchors per block when an exact index is searched with matrix products.
const EXACT_BLOCK: usize = 1024;

impl AnchorIndex {
    /// Build the index for `anchors` (row-major, `d` columns).
    pub fn new(anchors: &[f32], d: usize, opts: &IndexOptions) -> Self {
        assert!(d > 0 && anchors.len() % d == 0, "anchors must be n × d");
        let n = anchors.len() / d;
        let mut data = anchors.to_vec();
        if opts.cosine {
            data.chunks_exact_mut(d).for_each(normalize);
        }
        if n <= EXACT_MAX {
            let data_sq = row_sq_norms(&data, d);
            return AnchorIndex {
                d,
                n,
                cosine: opts.cosine,
                nprobe: 1,
                data,
                ids: (0..n as u32).collect(),
                cell_start: vec![0, n],
                centroids: Vec::new(),
                data_sq,
                cent_sq: Vec::new(),
            };
        }
        // About √n cells (16 to 1,024), fitted on at most 50,000 anchors, as in the numpy helper.
        let k = ((n as f64).sqrt().round() as usize).clamp(16, 1024);
        let mut rng = Pcg32::new(opts.seed);
        let fit: Vec<f32> = if n > 50_000 {
            let mut f = Vec::with_capacity(50_000 * d);
            for i in rng.sample(n, 50_000) {
                f.extend_from_slice(&data[i * d..(i + 1) * d]);
            }
            f
        } else {
            data.clone()
        };
        let centroids = kmeans(&fit, fit.len() / d, d, k, 8, &mut rng);
        let k = centroids.len() / d;
        let labels: Vec<usize> = {
            use rayon::prelude::*;
            data.par_chunks_exact(d).map(|row| nearest_centroid(row, &centroids, d)).collect()
        };
        let mut counts = vec![0usize; k + 1];
        for &l in &labels {
            counts[l + 1] += 1;
        }
        for c in 0..k {
            counts[c + 1] += counts[c];
        }
        let cell_start = counts.clone();
        let mut fill = counts;
        let mut reordered = vec![0f32; n * d];
        let mut ids = vec![0u32; n];
        for (i, &l) in labels.iter().enumerate() {
            let p = fill[l];
            fill[l] += 1;
            reordered[p * d..(p + 1) * d].copy_from_slice(&data[i * d..(i + 1) * d]);
            ids[p] = i as u32;
        }
        let data_sq = row_sq_norms(&reordered, d);
        let cent_sq = row_sq_norms(&centroids, d);
        AnchorIndex {
            d,
            n,
            cosine: opts.cosine,
            nprobe: opts.nprobe.clamp(1, k).min(64),
            data: reordered,
            ids,
            cell_start,
            centroids,
            data_sq,
            cent_sq,
        }
    }

    pub fn len(&self) -> usize {
        self.n
    }

    pub fn is_empty(&self) -> bool {
        self.n == 0
    }

    pub fn dims(&self) -> usize {
        self.d
    }

    pub fn is_exact(&self) -> bool {
        self.centroids.is_empty()
    }

    pub fn cosine(&self) -> bool {
        self.cosine
    }

    pub fn n_cells(&self) -> usize {
        self.cell_start.len() - 1
    }

    /// The `k` nearest anchors of `q` (already unit length for cosine): writes original anchor
    /// indices and squared distances, ascending, into `idx` and `sqd` (length ≥ k). Returns how
    /// many were found (less than k when there are fewer anchors, or for non-finite queries).
    pub fn search(&self, q: &[f32], k: usize, idx: &mut [u32], sqd: &mut [f32]) -> usize {
        debug_assert_eq!(q.len(), self.d);
        let k = k.min(self.n);
        let mut found = 0usize;
        let mut scan = |cell: usize, found: &mut usize| {
            let (lo, hi) = (self.cell_start[cell], self.cell_start[cell + 1]);
            for p in lo..hi {
                let dd = sqdist(q, &self.data[p * self.d..(p + 1) * self.d]);
                insert(dd, self.ids[p], k, found, idx, sqd);
            }
        };
        if self.is_exact() {
            scan(0, &mut found);
            return found;
        }
        // The nprobe nearest cells (insertion into a small sorted buffer).
        let np = self.nprobe;
        let mut probe_c = [usize::MAX; 64];
        let mut probe_d = [f32::INFINITY; 64];
        let np = np.min(64);
        for (c, cent) in self.centroids.chunks_exact(self.d).enumerate() {
            let dd = sqdist(q, cent);
            if dd < probe_d[np - 1] {
                let mut j = np - 1;
                while j > 0 && probe_d[j - 1] > dd {
                    probe_d[j] = probe_d[j - 1];
                    probe_c[j] = probe_c[j - 1];
                    j -= 1;
                }
                probe_d[j] = dd;
                probe_c[j] = c;
            }
        }
        for &c in &probe_c[..np] {
            if c != usize::MAX {
                scan(c, &mut found);
            }
        }
        found
    }
}

impl AnchorIndex {
    /// `search` for a block of `b` queries at once (row-major `q`, already unit length for
    /// cosine), with distances from matrix products: ‖q‖² − 2 q·a + ‖a‖² (clamped at 0), as the
    /// numpy helper computes them. Queries are grouped by probed cell, so each cell's anchors are
    /// multiplied with all the queries that probe it. Writes `k` results per query into `idx`,
    /// `sqd` (b × k) and the number found into `found` (b).
    pub fn search_batch(&self, q: &[f32], k: usize, idx: &mut [u32], sqd: &mut [f32], found: &mut [usize]) {
        let d = self.d;
        let b = q.len() / d;
        let k = k.min(self.n);
        found[..b].fill(0);
        if b == 0 || k == 0 {
            return;
        }
        let q_sq = row_sq_norms(q, d);
        let kk = idx.len() / b; // stride of the result rows
        let mut push_block = |rows: &[usize], q_rows_sq: &[f32], lo: usize, cols: usize, g: &[f32]| {
            for (li, &r) in rows.iter().enumerate() {
                let qs = q_rows_sq[li];
                let (ii, dd) = (&mut idx[r * kk..r * kk + kk], &mut sqd[r * kk..r * kk + kk]);
                let f = &mut found[r];
                for j in 0..cols {
                    let dist = (qs - 2.0 * g[li * cols + j] + self.data_sq[lo + j]).max(0.0);
                    insert(dist, self.ids[lo + j], k, f, ii, dd);
                }
            }
        };
        if self.is_exact() {
            let all: Vec<usize> = (0..b).collect();
            let mut g = vec![0f32; b * EXACT_BLOCK.min(self.n)];
            let mut lo = 0;
            while lo < self.n {
                let cols = EXACT_BLOCK.min(self.n - lo);
                matmul_abt(q, b, &self.data[lo * d..(lo + cols) * d], cols, d, &mut g);
                push_block(&all, &q_sq, lo, cols, &g[..b * cols]);
                lo += cols;
            }
            return;
        }
        // Probes: the nprobe nearest cells of each query.
        let nc = self.n_cells();
        let np = self.nprobe;
        let mut g = vec![0f32; b * nc];
        matmul_abt(q, b, &self.centroids, nc, d, &mut g);
        let mut probes = vec![usize::MAX; b * np];
        for i in 0..b {
            let mut pd = [f32::INFINITY; 64];
            let pc = &mut probes[i * np..(i + 1) * np];
            for c in 0..nc {
                let dist = q_sq[i] - 2.0 * g[i * nc + c] + self.cent_sq[c];
                if dist < pd[np - 1] {
                    let mut j = np - 1;
                    while j > 0 && pd[j - 1] > dist {
                        pd[j] = pd[j - 1];
                        pc[j] = pc[j - 1];
                        j -= 1;
                    }
                    pd[j] = dist;
                    pc[j] = c;
                }
            }
        }
        // Group the queries by cell.
        let mut start = vec![0usize; nc + 1];
        for &c in &probes {
            if c != usize::MAX {
                start[c + 1] += 1;
            }
        }
        for c in 0..nc {
            start[c + 1] += start[c];
        }
        let mut fill = start.clone();
        let mut members = vec![0usize; start[nc]];
        for (p, &c) in probes.iter().enumerate() {
            if c != usize::MAX {
                members[fill[c]] = p / np;
                fill[c] += 1;
            }
        }
        // Each probed cell: gather its queries, multiply with its anchors, keep the best k.
        let mut qc: Vec<f32> = Vec::new();
        let mut qc_sq: Vec<f32> = Vec::new();
        for c in 0..nc {
            let rows = &members[start[c]..start[c + 1]];
            let (lo, hi) = (self.cell_start[c], self.cell_start[c + 1]);
            if rows.is_empty() || lo == hi {
                continue;
            }
            qc.clear();
            qc_sq.clear();
            for &r in rows {
                qc.extend_from_slice(&q[r * d..(r + 1) * d]);
                qc_sq.push(q_sq[r]);
            }
            let cols = hi - lo;
            g.resize(rows.len() * cols, 0.0);
            matmul_abt(&qc, rows.len(), &self.data[lo * d..hi * d], cols, d, &mut g);
            push_block(rows, &qc_sq, lo, cols, &g[..rows.len() * cols]);
        }
    }
}

/// Insert (d, id) into the ascending top-k lists of length `found` (≤ k).
#[inline]
fn insert(dd: f32, id: u32, k: usize, found: &mut usize, idx: &mut [u32], sqd: &mut [f32]) {
    if !(dd == dd) || k == 0 {
        return; // NaN
    }
    if *found == k && dd >= sqd[k - 1] {
        return;
    }
    let mut j = if *found < k {
        *found += 1;
        *found - 1
    } else {
        k - 1
    };
    while j > 0 && sqd[j - 1] > dd {
        sqd[j] = sqd[j - 1];
        idx[j] = idx[j - 1];
        j -= 1;
    }
    sqd[j] = dd;
    idx[j] = id;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::Pcg32;

    pub(crate) fn blobs(n: usize, d: usize, seed: u64) -> Vec<f32> {
        let mut r = Pcg32::new(seed);
        let mut unif = || r.next_u32() as f32 / u32::MAX as f32;
        let centers: Vec<f32> = (0..20 * d).map(|_| unif() * 20.0 - 10.0).collect();
        let mut out = Vec::with_capacity(n * d);
        for i in 0..n {
            let c = i % 20;
            for j in 0..d {
                out.push(centers[c * d + j] + (unif() - 0.5) * 2.0);
            }
        }
        out
    }

    pub(crate) fn brute(anchors: &[f32], d: usize, q: &[f32], k: usize) -> Vec<u32> {
        let mut all: Vec<(f32, u32)> = anchors.chunks_exact(d).enumerate().map(|(i, a)| (sqdist(q, a), i as u32)).collect();
        all.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(a.1.cmp(&b.1)));
        all.truncate(k);
        all.into_iter().map(|x| x.1).collect()
    }

    #[test]
    fn exact_index_equals_brute_force() {
        let d = 7;
        let anchors = blobs(1000, d, 1);
        let idx = AnchorIndex::new(&anchors, d, &IndexOptions::default());
        assert!(idx.is_exact());
        let queries = blobs(200, d, 2);
        for q in queries.chunks_exact(d) {
            let mut ii = [0u32; 10];
            let mut dd = [0f32; 10];
            assert_eq!(idx.search(q, 10, &mut ii, &mut dd), 10);
            assert!(dd.windows(2).all(|w| w[0] <= w[1]));
            let want = brute(&anchors, d, q, 10);
            // Equal sets (ties may order differently).
            let mut a = ii.to_vec();
            let mut b = want.clone();
            a.sort_unstable();
            b.sort_unstable();
            assert_eq!(a, b);
        }
    }

    fn recall(idx: &AnchorIndex, anchors: &[f32], d: usize, queries: &[f32]) -> f64 {
        let mut hits = 0;
        let mut total = 0;
        for q in queries.chunks_exact(d) {
            let mut ii = [0u32; 10];
            let mut dd = [0f32; 10];
            idx.search(q, 10, &mut ii, &mut dd);
            let want = brute(anchors, d, q, 10);
            hits += ii.iter().filter(|i| want.contains(i)).count();
            total += 10;
        }
        hits as f64 / total as f64
    }

    #[test]
    fn ivf_recall() {
        // Blobs filling boxes: hard for IVF (no cluster structure inside a blob).
        let d = 16;
        let anchors = blobs(20_000, d, 3);
        let queries = blobs(300, d, 4);
        let idx = AnchorIndex::new(&anchors, d, &IndexOptions::default());
        assert!(!idx.is_exact());
        assert_eq!(idx.n_cells(), 141);
        let r4 = recall(&idx, &anchors, d, &queries);
        let idx8 = AnchorIndex::new(&anchors, d, &IndexOptions { nprobe: 8, ..Default::default() });
        let r8 = recall(&idx8, &anchors, d, &queries);
        let all = AnchorIndex::new(&anchors, d, &IndexOptions { nprobe: 1024, ..Default::default() });
        let r_all = recall(&all, &anchors, d, &queries);
        assert!(r4 > 0.85, "recall with 4 probes {r4}");
        assert!(r8 >= r4, "{r8} < {r4}");
        // Probing every cell is exact.
        assert_eq!(r_all, 1.0);
    }

    #[test]
    fn batch_search_matches_single_search() {
        let d = 24;
        for (n, nprobe) in [(3_000usize, 4usize), (30_000, 4), (30_000, 9)] {
            let anchors = blobs(n, d, 21);
            let idx = AnchorIndex::new(&anchors, d, &IndexOptions { nprobe, ..Default::default() });
            let queries = blobs(500, d, 22);
            let b = 500;
            let mut bi = vec![0u32; b * 10];
            let mut bd = vec![0f32; b * 10];
            let mut bf = vec![0usize; b];
            idx.search_batch(&queries, 10, &mut bi, &mut bd, &mut bf);
            let mut same = 0;
            for (r, q) in queries.chunks_exact(d).enumerate() {
                let mut ii = [0u32; 10];
                let mut dd = [0f32; 10];
                let f = idx.search(q, 10, &mut ii, &mut dd);
                assert_eq!(bf[r], f);
                let mut a = ii.to_vec();
                let mut c = bi[r * 10..r * 10 + 10].to_vec();
                a.sort_unstable();
                c.sort_unstable();
                same += (a == c) as usize;
                for j in 0..10 {
                    assert!((bd[r * 10 + j] - dd[j]).abs() <= 1e-3 * dd[j].max(1.0), "n={n} r={r} j={j}");
                }
            }
            // The same probed cells and distances up to rounding: near-ties may swap the 10th.
            assert!(same >= 495, "n={n}: {same}/500 identical neighbor sets");
        }
    }

    #[test]
    fn small_and_degenerate_inputs() {
        // Fewer anchors than k.
        let anchors = vec![0.0, 0.0, 1.0, 1.0, 2.0, 2.0];
        let idx = AnchorIndex::new(&anchors, 2, &IndexOptions::default());
        let mut ii = [0u32; 10];
        let mut dd = [0f32; 10];
        assert_eq!(idx.search(&[1.9, 2.1], 10, &mut ii, &mut dd), 3);
        assert_eq!(&ii[..3], &[2, 1, 0]);
        // A NaN query finds nothing.
        assert_eq!(idx.search(&[f32::NAN, 0.0], 10, &mut ii, &mut dd), 0);
        // Duplicates.
        let dup = vec![1.0f32; 2 * 50];
        let idx = AnchorIndex::new(&dup, 2, &IndexOptions::default());
        assert_eq!(idx.search(&[1.0, 1.0], 10, &mut ii, &mut dd), 10);
        assert!(dd.iter().all(|&v| v == 0.0));
    }

    #[test]
    fn cosine_normalizes() {
        let anchors = vec![1.0, 0.0, 0.0, 1.0, 10.0, 0.1];
        let idx = AnchorIndex::new(&anchors, 2, &IndexOptions { cosine: true, ..Default::default() });
        let mut q = vec![5.0, 0.0];
        crate::dist::normalize(&mut q);
        let mut ii = [0u32; 1];
        let mut dd = [0f32; 1];
        idx.search(&q, 1, &mut ii, &mut dd);
        assert_eq!(ii[0], 0);
        assert!(dd[0] < 1e-6);
    }

    #[test]
    fn deterministic_for_a_seed() {
        let d = 8;
        let anchors = blobs(10_000, d, 5);
        let a = AnchorIndex::new(&anchors, d, &IndexOptions { seed: 9, ..Default::default() });
        let b = AnchorIndex::new(&anchors, d, &IndexOptions { seed: 9, ..Default::default() });
        assert_eq!(a.ids, b.ids);
        assert_eq!(a.centroids, b.centroids);
    }
}
