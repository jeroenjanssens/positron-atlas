//! Column statistics and scaling for standardizing the prepared features (z-scores).

use rayon::prelude::*;

/// Rows per parallel task.
const TASK_ROWS: usize = 8192;

/// Per-column sum and sum of squares (in f64) of `x` (row-major, `d` columns): the same sums the
/// numpy helper accumulates, so mean = s1 / n and std = sqrt(max(s2 / n − mean², 0)).
pub fn column_moments(x: &[f32], d: usize) -> (Vec<f64>, Vec<f64>) {
    assert!(d > 0 && x.len() % d == 0);
    x.par_chunks(TASK_ROWS * d)
        .fold(
            || (vec![0f64; d], vec![0f64; d]),
            |(mut s1, mut s2), block| {
                for row in block.chunks_exact(d) {
                    for ((a, b), &v) in s1.iter_mut().zip(s2.iter_mut()).zip(row) {
                        let v = v as f64;
                        *a += v;
                        *b += v * v;
                    }
                }
                (s1, s2)
            },
        )
        .reduce(
            || (vec![0f64; d], vec![0f64; d]),
            |(mut a1, mut a2), (b1, b2)| {
                for (x, y) in a1.iter_mut().zip(b1) {
                    *x += y;
                }
                for (x, y) in a2.iter_mut().zip(b2) {
                    *x += y;
                }
                (a1, a2)
            },
        )
}

/// In place: x[i, j] = (x[i, j] − sub[j]) · mul[j], in f32 like the numpy helper.
pub fn scale_columns(x: &mut [f32], d: usize, sub: &[f32], mul: &[f32]) {
    assert!(d > 0 && x.len() % d == 0 && sub.len() == d && mul.len() == d);
    x.par_chunks_mut(TASK_ROWS * d).for_each(|block| {
        for row in block.chunks_exact_mut(d) {
            for ((v, s), m) in row.iter_mut().zip(sub).zip(mul) {
                *v = (*v - s) * m;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moments_and_scaling() {
        let d = 3;
        let x: Vec<f32> = (0..30_000).map(|i| ((i * 37) % 101) as f32 * 0.5 - 10.0).collect();
        let n = x.len() / d;
        let (s1, s2) = column_moments(&x, d);
        for j in 0..d {
            let col: Vec<f64> = x.iter().skip(j).step_by(d).map(|&v| v as f64).collect();
            let want1: f64 = col.iter().sum();
            let want2: f64 = col.iter().map(|v| v * v).sum();
            assert!((s1[j] - want1).abs() < 1e-6 * want1.abs().max(1.0));
            assert!((s2[j] - want2).abs() < 1e-6 * want2.max(1.0));
        }
        let mean: Vec<f32> = s1.iter().map(|s| (s / n as f64) as f32).collect();
        let inv: Vec<f32> = (0..d).map(|j| (1.0 / ((s2[j] / n as f64) - (s1[j] / n as f64).powi(2)).sqrt()) as f32).collect();
        let mut y = x.clone();
        scale_columns(&mut y, d, &mean, &inv);
        let (t1, t2) = column_moments(&y, d);
        for j in 0..d {
            assert!((t1[j] / n as f64).abs() < 1e-4, "mean {j}");
            assert!((t2[j] / n as f64 - 1.0).abs() < 1e-3, "var {j}");
        }
        assert_eq!(y[0], (x[0] - mean[0]) * inv[0]);
    }
}
