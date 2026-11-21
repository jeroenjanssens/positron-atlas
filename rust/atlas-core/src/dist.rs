//! Distances. Written so the compiler vectorizes them for the baseline target (SSE2 / NEON).

/// Squared euclidean distance. Uses 16 independent accumulators so the loop vectorizes.
#[inline]
pub fn sqdist(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    let ca = a.chunks_exact(16);
    let cb = b.chunks_exact(16);
    let (ra, rb) = (ca.remainder(), cb.remainder());
    let mut acc = [0f32; 16];
    for (x, y) in ca.zip(cb) {
        for l in 0..16 {
            let t = x[l] - y[l];
            acc[l] += t * t;
        }
    }
    let mut s = 0f32;
    for v in acc {
        s += v;
    }
    for (x, y) in ra.iter().zip(rb) {
        let t = x - y;
        s += t * t;
    }
    s
}

/// `out` (m × n, row-major) = `a` (m × k, row-major) · `b`ᵀ, with `b` n × k row-major.
/// Uses the `gemm` crate (SIMD kernels chosen at runtime: AVX2, AVX-512, NEON), single-threaded:
/// callers parallelize over blocks of rows.
pub fn matmul_abt(a: &[f32], m: usize, b: &[f32], n: usize, k: usize, out: &mut [f32]) {
    assert!(a.len() >= m * k && b.len() >= n * k && out.len() >= m * n, "matmul_abt: slices too short");
    if m == 0 || n == 0 {
        return;
    }
    if k == 0 {
        out[..m * n].fill(0.0);
        return;
    }
    // SAFETY: the asserts above guarantee that every element addressed by these shapes and
    // strides lies inside the slices; `out` is exclusively borrowed and does not alias `a` or `b`.
    unsafe {
        gemm::gemm(
            m,
            n,
            k,
            out.as_mut_ptr(),
            1,
            n as isize,
            false,
            a.as_ptr(),
            1,
            k as isize,
            b.as_ptr(),
            k as isize,
            1,
            0.0,
            1.0,
            false,
            false,
            false,
            gemm::Parallelism::None,
        );
    }
}

/// Squared norms of the rows of `x` (row-major, `d` columns).
pub fn row_sq_norms(x: &[f32], d: usize) -> Vec<f32> {
    x.chunks_exact(d).map(|r| r.iter().map(|v| v * v).sum()).collect()
}

/// Scale a vector to unit length (no-op for the zero vector). For the cosine metric.
pub fn normalize(v: &mut [f32]) {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 1e-12 {
        for x in v {
            *x /= n;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqdist_matches_naive() {
        for d in [1usize, 3, 15, 16, 17, 50, 784] {
            let a: Vec<f32> = (0..d).map(|i| (i as f32 * 0.37).sin()).collect();
            let b: Vec<f32> = (0..d).map(|i| (i as f32 * 0.11).cos()).collect();
            let naive: f32 = a.iter().zip(&b).map(|(x, y)| (x - y) * (x - y)).sum();
            assert!((sqdist(&a, &b) - naive).abs() <= 1e-4 * naive.max(1.0), "d={d}");
        }
    }

    #[test]
    fn matmul_matches_naive() {
        let (m, n, k) = (7, 5, 33);
        let a: Vec<f32> = (0..m * k).map(|i| (i as f32 * 0.13).sin()).collect();
        let b: Vec<f32> = (0..n * k).map(|i| (i as f32 * 0.29).cos()).collect();
        let mut out = vec![0f32; m * n];
        matmul_abt(&a, m, &b, n, k, &mut out);
        for i in 0..m {
            for j in 0..n {
                let want: f32 = (0..k).map(|t| a[i * k + t] * b[j * k + t]).sum();
                assert!((out[i * n + j] - want).abs() < 1e-4, "{i} {j}");
            }
        }
    }

    #[test]
    fn normalize_unit_length() {
        let mut v = vec![3.0, 4.0];
        normalize(&mut v);
        assert!((v[0] - 0.6).abs() < 1e-6 && (v[1] - 0.8).abs() < 1e-6);
        let mut z = vec![0.0, 0.0];
        normalize(&mut z);
        assert_eq!(z, vec![0.0, 0.0]);
    }
}
