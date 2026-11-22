//! `_positron_atlas_core`: the Python binding of atlas-core.
//!
//! Loaded by path by the kernel helper (python/positron_atlas_kernel.py), never installed. The
//! heavy work runs with the GIL released, so the user's console stays responsive; Python is only
//! called between blocks of rows, for cancellation and progress.

use atlas_core::{column_moments, neighbors, place_from_neighbors as pfn, place_rows, scale_columns, AnchorIndex, IndexOptions};
use numpy::{PyArray1, PyArray2, PyArrayMethods, PyReadonlyArray1, PyReadonlyArray2, PyReadwriteArray2, PyUntypedArrayMethods};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::thread::available_parallelism;

/// An index over the anchors (feature vectors of the rows UMAP ran on).
#[pyclass(frozen, module = "_positron_atlas_core")]
struct Index {
    inner: AnchorIndex,
}

/// The array's data as a row-major slice. `as_slice` also accepts Fortran-ordered (column-major)
/// arrays, which would be read in the wrong order, so require C order explicitly.
fn contiguous<'a>(name: &str, a: &'a PyReadonlyArray2<'_, f32>) -> PyResult<&'a [f32]> {
    let err = || PyValueError::new_err(format!("{name} must be a C-contiguous float32 array"));
    if !a.is_c_contiguous() {
        return Err(err());
    }
    a.as_slice().map_err(|_| err())
}

#[pymethods]
impl Index {
    /// Index(anchors: float32[n, d], seed=0, nprobe=4, cosine=False)
    #[new]
    #[pyo3(signature = (anchors, seed = 0, nprobe = 4, cosine = false))]
    fn new(py: Python<'_>, anchors: PyReadonlyArray2<'_, f32>, seed: u64, nprobe: usize, cosine: bool) -> PyResult<Self> {
        let [n, d] = [anchors.shape()[0], anchors.shape()[1]];
        if n == 0 || d == 0 {
            return Err(PyValueError::new_err("anchors must be a non-empty 2D array"));
        }
        let data = contiguous("anchors", &anchors)?;
        let opts = IndexOptions { seed, nprobe, cosine };
        let inner = py.detach(|| AnchorIndex::new(data, d, &opts));
        Ok(Index { inner })
    }

    #[getter]
    fn n_anchors(&self) -> usize {
        self.inner.len()
    }

    #[getter]
    fn dims(&self) -> usize {
        self.inner.dims()
    }

    #[getter]
    fn n_cells(&self) -> usize {
        self.inner.n_cells()
    }

    #[getter]
    fn exact(&self) -> bool {
        self.inner.is_exact()
    }

    /// neighbors(q: float32[m, d], k) -> (int64[m, k], float32[m, k]): nearest anchors and
    /// squared distances, ascending; -1 and inf where there are fewer than k anchors.
    #[pyo3(signature = (q, k = 10))]
    fn neighbors<'py>(&self, py: Python<'py>, q: PyReadonlyArray2<'py, f32>, k: usize) -> PyResult<(Bound<'py, PyArray2<i64>>, Bound<'py, PyArray2<f32>>)> {
        if q.shape()[1] != self.inner.dims() {
            return Err(PyValueError::new_err(format!("q has {} columns, the index {}", q.shape()[1], self.inner.dims())));
        }
        let m = q.shape()[0];
        let data = contiguous("q", &q)?;
        let (idx, sqd) = py.detach(|| neighbors(&self.inner, data, k));
        let idx: Vec<i64> = idx.into_iter().map(|i| if i == u32::MAX { -1 } else { i as i64 }).collect();
        let idx = numpy::PyArray1::from_vec(py, idx).reshape([m, k])?;
        let sqd = numpy::PyArray1::from_vec(py, sqd).reshape([m, k])?;
        Ok((idx, sqd))
    }

    /// neighbors_u32(q: float32[m, d], k=10, num_threads=0, cancel=None, block_rows=65536)
    ///   -> (uint32[m, k], float32[m, k]):
    /// nearest anchors and squared distances, ascending; u32::MAX and inf for unused slots.
    /// `num_threads=0` uses all available threads; set to cores-1 when UMAP runs concurrently.
    /// `cancel` is an optional Python callable () -> bool; checked between blocks of `block_rows`
    /// rows; raises ValueError("cancelled") when True.
    #[pyo3(signature = (q, k = 10, num_threads = 0, cancel = None, block_rows = 65_536))]
    fn neighbors_u32<'py>(
        &self,
        py: Python<'py>,
        q: PyReadonlyArray2<'py, f32>,
        k: usize,
        num_threads: usize,
        cancel: Option<Py<PyAny>>,
        block_rows: usize,
    ) -> PyResult<(Bound<'py, PyArray2<u32>>, Bound<'py, PyArray2<f32>>)> {
        if q.shape()[1] != self.inner.dims() {
            return Err(PyValueError::new_err(format!("q has {} columns, the index {}", q.shape()[1], self.inner.dims())));
        }
        let m = q.shape()[0];
        let dims = self.inner.dims();
        let data = contiguous("q", &q)?;
        let block = block_rows.max(1);

        // Build the thread pool once so it is reused across blocks.
        let pool: Option<rayon::ThreadPool> = if num_threads > 0 {
            Some(
                rayon::ThreadPoolBuilder::new()
                    .num_threads(num_threads)
                    .build()
                    .map_err(|e| PyValueError::new_err(format!("thread pool: {e}")))?,
            )
        } else {
            None
        };

        let mut all_idx: Vec<u32> = Vec::with_capacity(m * k);
        let mut all_sqd: Vec<f32> = Vec::with_capacity(m * k);

        for start in (0..m).step_by(block) {
            let end = m.min(start + block);
            let chunk = &data[start * dims..end * dims];

            // Release the GIL while Rust searches neighbours; reacquire between blocks.
            let (idx_chunk, sqd_chunk) = py.detach(|| {
                if let Some(ref p) = pool {
                    p.install(|| neighbors(&self.inner, chunk, k))
                } else {
                    neighbors(&self.inner, chunk, k)
                }
            });
            all_idx.extend_from_slice(&idx_chunk);
            all_sqd.extend_from_slice(&sqd_chunk);

            // Check cancel between blocks (GIL held here).
            if let Some(ref c) = cancel {
                if c.call0(py)?.is_truthy(py)? {
                    return Err(PyValueError::new_err("cancelled"));
                }
            }
        }

        let idx = numpy::PyArray1::from_vec(py, all_idx).reshape([m, k])?;
        let sqd = numpy::PyArray1::from_vec(py, all_sqd).reshape([m, k])?;
        Ok((idx, sqd))
    }

    /// place(x: float32[m, d], rows: int64[r], anchor_xy: float32[n, out_dims], out: float32[m, out_dims],
    ///       k=10, cancel=None, progress=None, block_rows=262144) -> bool
    ///
    /// Place rows `rows` of `x` from their k nearest anchors and write their positions into
    /// `out[rows]`. `out_dims` (2 or 3) is inferred from `anchor_xy.shape[1]`.
    /// Between blocks of rows, calls `cancel()` (stop when true) and `progress(rows_done)`;
    /// exceptions they raise propagate. Returns False when cancelled.
    #[pyo3(signature = (x, rows, anchor_xy, out, k = 10, cancel = None, progress = None, block_rows = 262_144))]
    #[allow(clippy::too_many_arguments)]
    fn place(
        &self,
        py: Python<'_>,
        x: PyReadonlyArray2<'_, f32>,
        rows: PyReadonlyArray1<'_, i64>,
        anchor_xy: PyReadonlyArray2<'_, f32>,
        mut out: PyReadwriteArray2<'_, f32>,
        k: usize,
        cancel: Option<Py<PyAny>>,
        progress: Option<Py<PyAny>>,
        block_rows: usize,
    ) -> PyResult<bool> {
        let d = self.inner.dims();
        let m = x.shape()[0];
        let out_dims = anchor_xy.shape()[1];
        if x.shape()[1] != d {
            return Err(PyValueError::new_err(format!("x has {} columns, the index {d}", x.shape()[1])));
        }
        if out_dims != 2 && out_dims != 3 {
            return Err(PyValueError::new_err("anchor_xy must have 2 or 3 columns (out_dims)"));
        }
        if anchor_xy.shape()[0] != self.inner.len() {
            return Err(PyValueError::new_err(format!(
                "anchor_xy has {} rows, expected {} (n_anchors)",
                anchor_xy.shape()[0],
                self.inner.len()
            )));
        }
        if out.shape() != [m, out_dims] {
            return Err(PyValueError::new_err(format!(
                "out must have shape ({m}, {out_dims}), got {:?}",
                out.shape()
            )));
        }
        let xs = contiguous("x", &x)?;
        let axy = contiguous("anchor_xy", &anchor_xy)?;
        let rows = rows.as_slice().map_err(|_| PyValueError::new_err("rows must be a contiguous int64 array"))?;
        let rows: Vec<usize> = rows
            .iter()
            .map(|&r| if r >= 0 && (r as usize) < m { Ok(r as usize) } else { Err(PyValueError::new_err(format!("row {r} is out of range"))) })
            .collect::<PyResult<_>>()?;
        if !out.is_c_contiguous() {
            return Err(PyValueError::new_err("out must be a C-contiguous float32 array"));
        }
        let out = out.as_slice_mut().map_err(|_| PyValueError::new_err("out must be a C-contiguous float32 array"))?;
        let never = AtomicBool::new(false);
        let done = AtomicUsize::new(0);
        for block in rows.chunks(block_rows.max(1)) {
            if let Some(c) = &cancel {
                if c.call0(py)?.is_truthy(py)? {
                    return Ok(false);
                }
            }
            let pos = py
                .detach(|| place_rows(&self.inner, xs, block, axy, out_dims, k, &never, &done))
                .map_err(|_| PyValueError::new_err("cancelled"))?;
            for (&r, p) in block.iter().zip(pos.chunks_exact(out_dims)) {
                out[out_dims * r..out_dims * (r + 1)].copy_from_slice(p);
            }
            if let Some(p) = &progress {
                p.call1(py, (done.load(std::sync::atomic::Ordering::Relaxed),))?;
            }
        }
        Ok(true)
    }
}

/// place_from_neighbors(nbr_idx: uint32[n, k], nbr_sqd: float32[n, k],
///                      anchor_xy: float32[a, out_dims], num_threads=0) -> float32[n, out_dims]:
/// Place rows from pre-computed neighbor indices and squared distances. Parallel (rayon).
/// `out_dims` (2 or 3) is inferred from `anchor_xy.shape[1]`.
/// `u32::MAX` indices and `inf` distances are ignored (zero weight). `num_threads=0` uses all
/// available threads; pass cores-1 when the browser UMAP runs concurrently on the CPU.
#[pyfunction(name = "place_from_neighbors")]
#[pyo3(signature = (nbr_idx, nbr_sqd, anchor_xy, num_threads = 0))]
fn place_from_neighbors_py<'py>(
    py: Python<'py>,
    nbr_idx: PyReadonlyArray2<'py, u32>,
    nbr_sqd: PyReadonlyArray2<'py, f32>,
    anchor_xy: PyReadonlyArray2<'py, f32>,
    num_threads: usize,
) -> PyResult<Bound<'py, PyArray2<f32>>> {
    let [n, k] = [nbr_idx.shape()[0], nbr_idx.shape()[1]];
    let out_dims = anchor_xy.shape()[1];
    if nbr_sqd.shape() != [n, k] {
        return Err(PyValueError::new_err("nbr_idx and nbr_sqd must have the same shape"));
    }
    if out_dims != 2 && out_dims != 3 {
        return Err(PyValueError::new_err("anchor_xy must have 2 or 3 columns (out_dims)"));
    }
    if !nbr_idx.is_c_contiguous() {
        return Err(PyValueError::new_err("nbr_idx must be a C-contiguous uint32 array"));
    }
    if !nbr_sqd.is_c_contiguous() {
        return Err(PyValueError::new_err("nbr_sqd must be a C-contiguous float32 array"));
    }
    let ii = nbr_idx.as_slice().map_err(|_| PyValueError::new_err("nbr_idx not contiguous"))?;
    let dd = nbr_sqd.as_slice().map_err(|_| PyValueError::new_err("nbr_sqd not contiguous"))?;
    let axy = contiguous("anchor_xy", &anchor_xy)?;
    let out = if num_threads > 0 {
        rayon::ThreadPoolBuilder::new()
            .num_threads(num_threads)
            .build()
            .map_err(|e| PyValueError::new_err(format!("thread pool: {e}")))?
            .install(|| pfn(ii, dd, k, axy, out_dims))
    } else {
        py.detach(|| pfn(ii, dd, k, axy, out_dims))
    };
    numpy::PyArray1::from_vec(py, out).reshape([n, out_dims]).map_err(Into::into)
}

/// n_cpus() -> int: number of logical CPU cores.
#[pyfunction(name = "n_cpus")]
fn n_cpus_py() -> usize {
    available_parallelism().map(|n| n.get()).unwrap_or(1)
}

/// column_moments(x: float32[n, d]) -> (float64[d], float64[d]): per-column sums and sums of
/// squares, in float64 (for exact means and standard deviations).
#[pyfunction(name = "column_moments")]
fn column_moments_py<'py>(py: Python<'py>, x: PyReadonlyArray2<'py, f32>) -> PyResult<(Bound<'py, PyArray1<f64>>, Bound<'py, PyArray1<f64>>)> {
    let d = x.shape()[1];
    if d == 0 {
        return Err(PyValueError::new_err("x has no columns"));
    }
    let data = contiguous("x", &x)?;
    let (s1, s2) = py.detach(|| column_moments(data, d));
    Ok((PyArray1::from_vec(py, s1), PyArray1::from_vec(py, s2)))
}

/// scale_columns(x: float32[n, d], sub: float32[d], mul: float32[d]): in place,
/// x = (x - sub) * mul per column.
#[pyfunction(name = "scale_columns")]
fn scale_columns_py(py: Python<'_>, mut x: PyReadwriteArray2<'_, f32>, sub: PyReadonlyArray1<'_, f32>, mul: PyReadonlyArray1<'_, f32>) -> PyResult<()> {
    let d = x.shape()[1];
    if sub.len() != d || mul.len() != d {
        return Err(PyValueError::new_err("sub and mul must have one value per column"));
    }
    if !x.is_c_contiguous() {
        return Err(PyValueError::new_err("x must be a C-contiguous float32 array"));
    }
    let sub = sub.as_slice()?.to_vec();
    let mul = mul.as_slice()?.to_vec();
    let data = x.as_slice_mut().map_err(|_| PyValueError::new_err("x must be a C-contiguous float32 array"))?;
    if d > 0 {
        py.detach(|| scale_columns(data, d, &sub, &mul));
    }
    Ok(())
}

#[pymodule]
fn _positron_atlas_core(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("VERSION", env!("CARGO_PKG_VERSION"))?;
    // Largest output dimension the placement functions accept (2D and 3D maps). The kernel
    // helper requires this constant, so a core built before 3D support counts as outdated.
    m.add("MAX_OUT_DIMS", 3usize)?;
    m.add_class::<Index>()?;
    m.add_function(wrap_pyfunction!(place_from_neighbors_py, m)?)?;
    m.add_function(wrap_pyfunction!(n_cpus_py, m)?)?;
    m.add_function(wrap_pyfunction!(column_moments_py, m)?)?;
    m.add_function(wrap_pyfunction!(scale_columns_py, m)?)?;
    Ok(())
}
