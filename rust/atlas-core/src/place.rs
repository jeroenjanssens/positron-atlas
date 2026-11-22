//! Placing rows: nearest anchors, then the weighted mean of their positions.
//!
//! Supports 2- or 3-dimensional output (`out_dims`).

use crate::dist::normalize;
use crate::index::AnchorIndex;
use rayon::prelude::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

/// Returned when placement was cancelled.
#[derive(Debug, PartialEq, Eq)]
pub struct Cancelled;

/// Rows per parallel task.
const TASK_ROWS: usize = 2048;

/// Position of a row from its neighbors (`count` of them, ascending squared distances `sqd`):
/// UMAP-style membership weights exp(-(d - ρ)/σ), ρ the nearest distance and σ the mean gap
/// (at least 1e-6), then the weighted mean of the neighbors' positions in `anchor_xy`
/// (n × `out_dims`). The same formula as `place_from_neighbors` in the numpy helper.
/// Returns `[f32; 3]` — only the first `out_dims` elements are meaningful; the rest are 0.
/// Returns NaN in element 0 when `count` is 0.
pub fn place_point(idx: &[u32], sqd: &[f32], count: usize, anchor_xy: &[f32], out_dims: usize) -> [f32; 3] {
    debug_assert!(out_dims == 2 || out_dims == 3, "out_dims must be 2 or 3");
    if count == 0 {
        return [f32::NAN; 3];
    }
    let mut d = [0f32; 64];
    let count = count.min(64);
    for j in 0..count {
        d[j] = sqd[j].max(0.0).sqrt();
    }
    let rho = d[0];
    let mut gap_sum = 0f32;
    for &dj in &d[..count] {
        gap_sum += dj - rho;
    }
    let sigma = (gap_sum / count as f32).max(1e-6);
    let mut pos = [0f32; 3];
    let mut w_sum = 0f32;
    for j in 0..count {
        let w = (-(d[j] - rho) / sigma).exp();
        let a = idx[j] as usize;
        let base = out_dims * a;
        for c in 0..out_dims {
            pos[c] += w * anchor_xy[base + c];
        }
        w_sum += w;
    }
    let w_sum = w_sum.max(1e-12);
    for c in 0..out_dims {
        pos[c] /= w_sum;
    }
    pos
}

/// Place all rows from pre-computed neighbor indices and squared distances (parallel).
///
/// `nbr_idx` and `nbr_sqd` are row-major with `k` values per row; unused slots have
/// index `u32::MAX` and distance `+inf`, which get zero weight naturally.
/// `anchor_xy` is row-major `n_anchors × out_dims`.
/// Returns positions (`n × out_dims` flat).
pub fn place_from_neighbors(
    nbr_idx: &[u32],
    nbr_sqd: &[f32],
    k: usize,
    anchor_xy: &[f32],
    out_dims: usize,
) -> Vec<f32> {
    debug_assert!(out_dims == 2 || out_dims == 3, "out_dims must be 2 or 3");
    let n = if k == 0 { 0 } else { nbr_idx.len() / k };
    let mut out = vec![0f32; n * out_dims];
    if n == 0 {
        return out;
    }
    out.par_chunks_mut(TASK_ROWS * out_dims)
        .zip(nbr_idx.par_chunks(TASK_ROWS * k))
        .zip(nbr_sqd.par_chunks(TASK_ROWS * k))
        .for_each(|((out, ii), dd)| {
            for (r, o) in out.chunks_exact_mut(out_dims).enumerate() {
                // Count valid slots (u32::MAX marks unused; INFINITY distance → zero weight).
                let count = k.min(ii[r * k..(r + 1) * k].iter().position(|&v| v == u32::MAX).unwrap_or(k));
                let p = place_point(&ii[r * k..(r + 1) * k], &dd[r * k..(r + 1) * k], count, anchor_xy, out_dims);
                o.copy_from_slice(&p[..out_dims]);
            }
        });
    out
}

/// Nearest anchors of the rows of `queries` (row-major): indices and squared distances,
/// `k` per row (unused slots: index u32::MAX, distance +inf).
pub fn neighbors(index: &AnchorIndex, queries: &[f32], k: usize) -> (Vec<u32>, Vec<f32>) {
    let d = index.dims();
    let m = queries.len() / d;
    let mut idx = vec![u32::MAX; m * k];
    let mut sqd = vec![f32::INFINITY; m * k];
    if k == 0 {
        return (idx, sqd);
    }
    idx.par_chunks_mut(TASK_ROWS * k)
        .zip(sqd.par_chunks_mut(TASK_ROWS * k))
        .zip(queries.par_chunks(TASK_ROWS * d))
        .for_each(|((ii, dd), q)| {
            let q = prepare_block(index, q);
            let mut found = vec![0usize; q.len() / d];
            index.search_batch(&q, k, ii, dd, &mut found);
            for (r, &f) in found.iter().enumerate() {
                ii[r * k + f..(r + 1) * k].fill(u32::MAX);
                dd[r * k + f..(r + 1) * k].fill(f32::INFINITY);
            }
        });
    (idx, sqd)
}

/// A block of query rows, scaled to unit length for the cosine metric.
fn prepare_block<'a>(index: &AnchorIndex, q: &'a [f32]) -> std::borrow::Cow<'a, [f32]> {
    if index.cosine() {
        let mut v = q.to_vec();
        v.chunks_exact_mut(index.dims()).for_each(normalize);
        std::borrow::Cow::Owned(v)
    } else {
        std::borrow::Cow::Borrowed(q)
    }
}

/// Place the rows `rows` of `x` (row-major, `index.dims()` columns) from their `k` nearest
/// anchors. `anchor_xy` is row-major `n_anchors × out_dims` (2 or 3).
/// Returns positions (`rows.len() × out_dims` flat). Checks `cancel` between tasks; adds
/// finished rows to `progress`.
pub fn place_rows(
    index: &AnchorIndex,
    x: &[f32],
    rows: &[usize],
    anchor_xy: &[f32],
    out_dims: usize,
    k: usize,
    cancel: &AtomicBool,
    progress: &AtomicUsize,
) -> Result<Vec<f32>, Cancelled> {
    debug_assert!(out_dims == 2 || out_dims == 3, "out_dims must be 2 or 3");
    let d = index.dims();
    assert!(
        anchor_xy.len() >= out_dims * index.len(),
        "anchor_xy must have out_dims values per anchor"
    );
    let k = k.clamp(1, 64);
    let mut out = vec![0f32; rows.len() * out_dims];
    let result: Result<(), Cancelled> =
        out.par_chunks_mut(TASK_ROWS * out_dims).zip(rows.par_chunks(TASK_ROWS)).try_for_each(|(out, rows)| {
            if cancel.load(Ordering::Relaxed) {
                return Err(Cancelled);
            }
            let b = rows.len();
            let mut q = Vec::with_capacity(b * d);
            for &r in rows {
                q.extend_from_slice(&x[r * d..(r + 1) * d]);
            }
            if index.cosine() {
                q.chunks_exact_mut(d).for_each(normalize);
            }
            let mut ii = vec![0u32; b * k];
            let mut dd = vec![0f32; b * k];
            let mut found = vec![0usize; b];
            index.search_batch(&q, k, &mut ii, &mut dd, &mut found);
            for (r, o) in out.chunks_exact_mut(out_dims).enumerate() {
                let p = place_point(&ii[r * k..(r + 1) * k], &dd[r * k..(r + 1) * k], found[r], anchor_xy, out_dims);
                o.copy_from_slice(&p[..out_dims]);
            }
            progress.fetch_add(b, Ordering::Relaxed);
            Ok(())
        });
    result.map(|_| out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::IndexOptions;

    #[test]
    fn weights_match_the_reference_formula() {
        // Two neighbors at distances 1 and 3: ρ = 1, σ = (0 + 2) / 2 = 1, weights 1 and e^-2.
        let anchor_xy = [0.0, 0.0, 10.0, 0.0];
        let p = place_point(&[0, 1], &[1.0, 9.0], 2, &anchor_xy, 2);
        let w = (-2.0f32).exp();
        assert!((p[0] - 10.0 * w / (1.0 + w)).abs() < 1e-5);
        assert_eq!(p[1], 0.0);
        // All at the same distance: equal weights (σ falls back to 1e-6, gaps are 0).
        let p = place_point(&[0, 1], &[4.0, 4.0], 2, &anchor_xy, 2);
        assert!((p[0] - 5.0).abs() < 1e-5);
        assert!(place_point(&[], &[], 0, &anchor_xy, 2)[0].is_nan());
    }

    #[test]
    fn rows_land_next_to_their_anchors() {
        // Anchors at x = 0..100 on a line in 3D, laid out at (x, 0).
        let anchors: Vec<f32> = (0..100).flat_map(|i| [i as f32, 0.0, 0.0]).collect();
        let anchor_xy: Vec<f32> = (0..100).flat_map(|i| [i as f32, 0.0]).collect();
        let index = AnchorIndex::new(&anchors, 3, &IndexOptions::default());
        let x: Vec<f32> = vec![10.2, 0.1, 0.0, 55.0, 0.0, 0.3];
        let out = place_rows(&index, &x, &[0, 1], &anchor_xy, 2, 10, &AtomicBool::new(false), &AtomicUsize::new(0)).unwrap();
        assert!((out[0] - 10.2).abs() < 1.0, "{out:?}");
        assert!((out[2] - 55.0).abs() < 1.0, "{out:?}");
    }

    #[test]
    fn cancel_stops() {
        let anchors: Vec<f32> = (0..100).flat_map(|i| [i as f32, 0.0]).collect();
        let anchor_xy = anchors.clone();
        let index = AnchorIndex::new(&anchors, 2, &IndexOptions::default());
        let x = vec![1.0f32; 2 * 100_000];
        let rows: Vec<usize> = (0..100_000).collect();
        let r = place_rows(&index, &x, &rows, &anchor_xy, 2, 10, &AtomicBool::new(true), &AtomicUsize::new(0));
        assert_eq!(r, Err(Cancelled));
    }

    #[test]
    fn neighbors_pads_missing_slots() {
        let anchors = vec![0.0f32, 0.0, 1.0, 0.0];
        let index = AnchorIndex::new(&anchors, 2, &IndexOptions::default());
        let (ii, dd) = neighbors(&index, &[0.9, 0.0], 3);
        assert_eq!(ii, vec![1, 0, u32::MAX]);
        assert!(dd[2].is_infinite());
    }

    #[test]
    fn place_from_neighbors_matches_place_rows() {
        let anchors: Vec<f32> = (0..20).flat_map(|i| [i as f32, 0.0]).collect();
        let anchor_xy: Vec<f32> = (0..20).flat_map(|i| [i as f32, 0.0]).collect();
        let index = AnchorIndex::new(&anchors, 2, &IndexOptions::default());
        let queries: Vec<f32> = vec![3.5, 0.0, 10.1, 0.0, 15.9, 0.0];
        // Get neighbors via neighbors()
        let (ii, dd) = neighbors(&index, &queries, 4);
        // Place via place_from_neighbors
        let out1 = place_from_neighbors(&ii, &dd, 4, &anchor_xy, 2);
        // Place via place_rows (the reference)
        let out2 = place_rows(&index, &queries, &[0, 1, 2], &anchor_xy, 2, 4,
            &AtomicBool::new(false), &AtomicUsize::new(0)).unwrap();
        for i in 0..3 {
            assert!((out1[2 * i] - out2[2 * i]).abs() < 1e-4, "row {i}: {out1:?} vs {out2:?}");
        }
    }

    #[test]
    fn place_from_neighbors_handles_max_sentinel() {
        // Only 2 anchors, requesting k=5: slots 2..4 get u32::MAX / inf
        let anchors = vec![0.0f32, 0.0, 1.0, 0.0];
        let anchor_xy = vec![0.0f32, 0.0, 1.0, 0.0];
        let index = AnchorIndex::new(&anchors, 2, &IndexOptions::default());
        let (ii, dd) = neighbors(&index, &[0.5f32, 0.0], 5);
        assert_eq!(ii[2..5], [u32::MAX, u32::MAX, u32::MAX]);
        let out = place_from_neighbors(&ii, &dd, 5, &anchor_xy, 2);
        // Result should be near 0.5 (midpoint between the two anchors)
        assert!((out[0] - 0.5).abs() < 0.01, "out={out:?}");
    }

    // ── 3D tests ──────────────────────────────────────────────────────────────

    #[test]
    fn place_point_3d_weighted_mean() {
        // Two anchors in 3D UMAP space. Verify weighted mean of all 3 coordinates.
        // anchor 0 at (0,0,0), anchor 1 at (10,10,10).
        let anchor_xyz = [0.0f32, 0.0, 0.0, 10.0, 10.0, 10.0];
        // Equal weights (same distance): expect midpoint (5,5,5).
        let p = place_point(&[0, 1], &[4.0, 4.0], 2, &anchor_xyz, 3);
        assert!((p[0] - 5.0).abs() < 1e-4, "x: {}", p[0]);
        assert!((p[1] - 5.0).abs() < 1e-4, "y: {}", p[1]);
        assert!((p[2] - 5.0).abs() < 1e-4, "z: {}", p[2]);
        // count=0 → NaN in first slot.
        assert!(place_point(&[], &[], 0, &anchor_xyz, 3)[0].is_nan());
    }

    #[test]
    fn place_rows_3d_lands_near_anchor() {
        // Anchors at (i, 0, 0) in feature space, laid out at (i, 0, i) in UMAP space.
        let n_anchors = 50usize;
        let anchors: Vec<f32> = (0..n_anchors).flat_map(|i| [i as f32, 0.0, 0.0]).collect();
        let anchor_xyz: Vec<f32> = (0..n_anchors).flat_map(|i| [i as f32, 0.0, i as f32]).collect();
        let index = AnchorIndex::new(&anchors, 3, &IndexOptions::default());
        // Query row near anchor 25.
        let x: Vec<f32> = vec![25.1, 0.0, 0.0];
        let out = place_rows(&index, &x, &[0], &anchor_xyz, 3, 5, &AtomicBool::new(false), &AtomicUsize::new(0)).unwrap();
        assert_eq!(out.len(), 3);
        assert!((out[0] - 25.0).abs() < 1.5, "x: {}", out[0]);
        assert!((out[2] - 25.0).abs() < 1.5, "z: {}", out[2]);
    }

    #[test]
    fn place_from_neighbors_3d_matches_place_rows_3d() {
        // 10 anchors evenly spaced, feature dim=3, out_dims=3.
        let n = 10usize;
        let anchors: Vec<f32> = (0..n).flat_map(|i| [i as f32, 0.0, 0.0]).collect();
        let anchor_xyz: Vec<f32> = (0..n).flat_map(|i| [i as f32, 0.0, i as f32 * 2.0]).collect();
        let index = AnchorIndex::new(&anchors, 3, &IndexOptions::default());
        let queries: Vec<f32> = vec![3.5, 0.0, 0.0, 7.2, 0.0, 0.0];
        let (ii, dd) = neighbors(&index, &queries, 4);
        let out1 = place_from_neighbors(&ii, &dd, 4, &anchor_xyz, 3);
        let out2 = place_rows(&index, &queries, &[0, 1], &anchor_xyz, 3, 4,
            &AtomicBool::new(false), &AtomicUsize::new(0)).unwrap();
        assert_eq!(out1.len(), 6);
        assert_eq!(out2.len(), 6);
        for i in 0..6 {
            assert!((out1[i] - out2[i]).abs() < 1e-4, "dim {i}: pfn={} vs pr={}", out1[i], out2[i]);
        }
    }

    #[test]
    fn place_rows_3d_cancel_works() {
        let n_anchors = 10usize;
        let anchors: Vec<f32> = (0..n_anchors).flat_map(|i| [i as f32, 0.0]).collect();
        let anchor_xyz: Vec<f32> = vec![0f32; n_anchors * 3];
        let index = AnchorIndex::new(&anchors, 2, &IndexOptions::default());
        let x = vec![0.5f32; 2 * 100_000];
        let rows: Vec<usize> = (0..100_000).collect();
        let r = place_rows(&index, &x, &rows, &anchor_xyz, 3, 5, &AtomicBool::new(true), &AtomicUsize::new(0));
        assert_eq!(r, Err(Cancelled));
    }
}
