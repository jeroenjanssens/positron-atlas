//! Lloyd's k-means for the IVF cells (the same procedure as the numpy helper's `kmeans`).

use crate::dist::sqdist;
use crate::rng::Pcg32;
use rayon::prelude::*;

/// Index of the nearest of `k` centroids (row-major, `d` columns) to `x`.
pub fn nearest_centroid(x: &[f32], centroids: &[f32], d: usize) -> usize {
    let mut best = 0;
    let mut best_d = f32::INFINITY;
    for (c, cent) in centroids.chunks_exact(d).enumerate() {
        let dd = sqdist(x, cent);
        if dd < best_d {
            best_d = dd;
            best = c;
        }
    }
    best
}

/// `k` centroids (row-major) for the `n` rows of `data` after `iters` iterations.
/// Empty clusters are re-seeded with random rows.
pub fn kmeans(data: &[f32], n: usize, d: usize, k: usize, iters: usize, rng: &mut Pcg32) -> Vec<f32> {
    let k = k.clamp(1, n.max(1));
    let mut cent = Vec::with_capacity(k * d);
    for i in rng.sample(n, k) {
        cent.extend_from_slice(&data[i * d..(i + 1) * d]);
    }
    for _ in 0..iters {
        let labels: Vec<usize> = data.par_chunks_exact(d).map(|row| nearest_centroid(row, &cent, d)).collect();
        let (sums, counts) = data
            .par_chunks_exact(d)
            .zip(labels.par_iter())
            .fold(
                || (vec![0f64; k * d], vec![0usize; k]),
                |(mut s, mut c), (row, &l)| {
                    for (acc, v) in s[l * d..(l + 1) * d].iter_mut().zip(row) {
                        *acc += *v as f64;
                    }
                    c[l] += 1;
                    (s, c)
                },
            )
            .reduce(
                || (vec![0f64; k * d], vec![0usize; k]),
                |(mut s1, mut c1), (s2, c2)| {
                    for (a, b) in s1.iter_mut().zip(s2) {
                        *a += b;
                    }
                    for (a, b) in c1.iter_mut().zip(c2) {
                        *a += b;
                    }
                    (s1, c1)
                },
            );
        for c in 0..k {
            if counts[c] == 0 {
                let i = rng.below(n as u32) as usize;
                cent[c * d..(c + 1) * d].copy_from_slice(&data[i * d..(i + 1) * d]);
            } else {
                for j in 0..d {
                    cent[c * d + j] = (sums[c * d + j] / counts[c] as f64) as f32;
                }
            }
        }
    }
    cent
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_separated_clusters() {
        // Three tight clusters on a line.
        let mut data = Vec::new();
        for c in [0.0f32, 10.0, 20.0] {
            for i in 0..50 {
                data.push(c + (i as f32) * 0.01);
                data.push(0.0);
            }
        }
        let mut rng = Pcg32::new(0);
        let cent = kmeans(&data, 150, 2, 3, 10, &mut rng);
        let mut xs: Vec<f32> = cent.chunks_exact(2).map(|c| c[0]).collect();
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        for (x, want) in xs.iter().zip([0.245f32, 10.245, 20.245]) {
            assert!((x - want).abs() < 0.01, "{xs:?}");
        }
    }
}
