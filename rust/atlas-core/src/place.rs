//! Placing rows: nearest anchors, then the weighted mean of their 2D positions.

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
/// (at least 1e-6), then the weighted mean of the neighbors' positions in `anchor_xy` (n × 2).
/// The same formula as `place_from_neighbors` in the numpy helper. NaN when `count` is 0.
pub fn place_point(idx: &[u32], sqd: &[f32], count: usize, anchor_xy: &[f32]) -> [f32; 2] {
    if count == 0 {
        return [f32::NAN, f32::NAN];
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
    let (mut x, mut y, mut w_sum) = (0f32, 0f32, 0f32);
    for j in 0..count {
        let w = (-(d[j] - rho) / sigma).exp();
        let a = idx[j] as usize;
        x += w * anchor_xy[2 * a];
        y += w * anchor_xy[2 * a + 1];
        w_sum += w;
    }
    let w_sum = w_sum.max(1e-12);
    [x / w_sum, y / w_sum]
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
/// anchors; returns their positions (2 per row, in the order of `rows`). Checks `cancel` between
/// tasks and adds finished rows to `progress`.
pub fn place_rows(
    index: &AnchorIndex,
    x: &[f32],
    rows: &[usize],
    anchor_xy: &[f32],
    k: usize,
    cancel: &AtomicBool,
    progress: &AtomicUsize,
) -> Result<Vec<f32>, Cancelled> {
    let d = index.dims();
    assert!(anchor_xy.len() >= 2 * index.len(), "anchor_xy must have 2 values per anchor");
    let k = k.clamp(1, 64);
    let mut out = vec![0f32; rows.len() * 2];
    let result: Result<(), Cancelled> = out.par_chunks_mut(TASK_ROWS * 2).zip(rows.par_chunks(TASK_ROWS)).try_for_each(|(out, rows)| {
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
        for (r, o) in out.chunks_exact_mut(2).enumerate() {
            let p = place_point(&ii[r * k..(r + 1) * k], &dd[r * k..(r + 1) * k], found[r], anchor_xy);
            o[0] = p[0];
            o[1] = p[1];
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
        let p = place_point(&[0, 1], &[1.0, 9.0], 2, &anchor_xy);
        let w = (-2.0f32).exp();
        assert!((p[0] - 10.0 * w / (1.0 + w)).abs() < 1e-5);
        assert_eq!(p[1], 0.0);
        // All at the same distance: equal weights (σ falls back to 1e-6, gaps are 0).
        let p = place_point(&[0, 1], &[4.0, 4.0], 2, &anchor_xy);
        assert!((p[0] - 5.0).abs() < 1e-5);
        assert!(place_point(&[], &[], 0, &anchor_xy)[0].is_nan());
    }

    #[test]
    fn rows_land_next_to_their_anchors() {
        // Anchors at x = 0..100 on a line in 3D, laid out at (x, 0).
        let anchors: Vec<f32> = (0..100).flat_map(|i| [i as f32, 0.0, 0.0]).collect();
        let anchor_xy: Vec<f32> = (0..100).flat_map(|i| [i as f32, 0.0]).collect();
        let index = AnchorIndex::new(&anchors, 3, &IndexOptions::default());
        let x: Vec<f32> = vec![10.2, 0.1, 0.0, 55.0, 0.0, 0.3];
        let out = place_rows(&index, &x, &[0, 1], &anchor_xy, 10, &AtomicBool::new(false), &AtomicUsize::new(0)).unwrap();
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
        let r = place_rows(&index, &x, &rows, &anchor_xy, 10, &AtomicBool::new(true), &AtomicUsize::new(0));
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
}
