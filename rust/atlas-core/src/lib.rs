//! Positron Atlas core: place rows on a 2D map from their nearest anchors.
//!
//! UMAP runs in the browser on a subset of the rows (the anchors). Every other row is placed at
//! the weighted mean of the 2D positions of its k nearest anchors in feature space. This crate
//! does that work: an IVF index over the anchors (k-means cells, a few probed cells per query,
//! exact for small anchor sets), a fixed-size top-k per row, and the UMAP-style weights. It is the
//! same algorithm as the numpy code in `python/positron_atlas_kernel.py`, multithreaded.

mod dist;
pub mod index;
mod kmeans;
pub mod place;
pub mod rng;

pub use index::{AnchorIndex, IndexOptions};
pub use place::{neighbors, place_point, place_rows, Cancelled};
