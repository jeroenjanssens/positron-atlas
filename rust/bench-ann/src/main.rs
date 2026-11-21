//! Compare nearest-anchor indexes on the data shape Atlas uses (k = 10 nearest of ~100k anchors).
//!     cargo run --release -p bench-ann -- [n_anchors] [d] [n_queries]
//! Prints build time, query time and recall@10 against brute force for: atlas-core's IVF index,
//! embedding-atlas's nndescent (query API), and hnsw_rs.

use atlas_core::rng::Pcg32;
use atlas_core::{neighbors, AnchorIndex, IndexOptions};
use rayon::prelude::*;
use std::time::Instant;

fn blobs(n: usize, d: usize, seed: u64, centers: &[f32]) -> Vec<f32> {
    let mut r = Pcg32::new(seed);
    let mut gauss = || {
        let u1 = (r.next_u32() as f64 + 1.0) / (u32::MAX as f64 + 2.0);
        let u2 = r.next_u32() as f64 / u32::MAX as f64;
        ((-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()) as f32
    };
    let k = centers.len() / d;
    let mut out = Vec::with_capacity(n * d);
    for i in 0..n {
        let c = (i * 7919) % k;
        for j in 0..d {
            out.push(centers[c * d + j] + gauss());
        }
    }
    out
}

fn brute(anchors: &[f32], d: usize, q: &[f32]) -> Vec<Vec<u32>> {
    q.par_chunks_exact(d)
        .map(|q| {
            let mut all: Vec<(f32, u32)> = anchors
                .chunks_exact(d)
                .enumerate()
                .map(|(i, a)| (a.iter().zip(q).map(|(x, y)| (x - y) * (x - y)).sum(), i as u32))
                .collect();
            all.select_nth_unstable_by(10, |a, b| a.0.partial_cmp(&b.0).unwrap());
            all.truncate(10);
            all.into_iter().map(|x| x.1).collect()
        })
        .collect()
}

fn recall(found: &[Vec<u32>], truth: &[Vec<u32>]) -> f64 {
    let hits: usize = found.iter().zip(truth).map(|(f, t)| f.iter().filter(|i| t.contains(i)).count()).sum();
    hits as f64 / (10 * truth.len()) as f64
}

fn main() {
    let args: Vec<usize> = std::env::args().skip(1).map(|a| a.parse().unwrap()).collect();
    let (na, d, nq) = (*args.first().unwrap_or(&100_000), *args.get(1).unwrap_or(&20), *args.get(2).unwrap_or(&200_000));
    let mut r = Pcg32::new(42);
    let centers: Vec<f32> = (0..50 * d).map(|_| (r.next_u32() as f32 / u32::MAX as f32 - 0.5) * 16.0).collect();
    let anchors = blobs(na, d, 1, &centers);
    let queries = blobs(nq, d, 2, &centers);
    let sample = &queries[..2000 * d];
    let truth = brute(&anchors, d, sample);
    println!("anchors {na}, dims {d}, queries {nq}, threads {}", rayon::current_num_threads());

    // atlas-core IVF.
    let t = Instant::now();
    let ivf = AnchorIndex::new(&anchors, d, &IndexOptions::default());
    let build = t.elapsed().as_secs_f64();
    let t = Instant::now();
    let _ = neighbors(&ivf, &queries, 10);
    let query = t.elapsed().as_secs_f64();
    let (ii, _) = neighbors(&ivf, sample, 10);
    let found: Vec<Vec<u32>> = ii.chunks(10).map(|c| c.to_vec()).collect();
    println!("atlas-core IVF   build {build:7.2} s  query {query:7.2} s  recall@10 {:.4}", recall(&found, &truth));

    // embedding-atlas nndescent (PyNNDescent port).
    let data = ndarray::Array2::from_shape_vec((na, d), anchors.clone()).unwrap();
    let t = Instant::now();
    let mut nnd = nndescent::NNDescent::builder(data, "euclidean", 30).random_state(0).build().unwrap();
    nnd.prepare();
    let build = t.elapsed().as_secs_f64();
    let qa = ndarray::Array2::from_shape_vec((nq, d), queries.clone()).unwrap();
    let t = Instant::now();
    let _ = nnd.query(&qa, 10, 0.1);
    let query = t.elapsed().as_secs_f64();
    let sa = ndarray::Array2::from_shape_vec((2000, d), sample.to_vec()).unwrap();
    let (ii, _) = nnd.query(&sa, 10, 0.1);
    let found: Vec<Vec<u32>> = ii.rows().into_iter().map(|r| r.iter().map(|&i| i as u32).collect()).collect();
    println!("nndescent        build {build:7.2} s  query {query:7.2} s  recall@10 {:.4}", recall(&found, &truth));

    // hnsw_rs.
    use hnsw_rs::prelude::*;
    let t = Instant::now();
    let hnsw = Hnsw::<f32, DistL2>::new(16, na, 16, 200, DistL2 {});
    let rows: Vec<Vec<f32>> = anchors.chunks_exact(d).map(|c| c.to_vec()).collect();
    let refs: Vec<(&Vec<f32>, usize)> = rows.iter().enumerate().map(|(i, v)| (v, i)).collect();
    hnsw.parallel_insert(&refs);
    let build = t.elapsed().as_secs_f64();
    let qrows: Vec<Vec<f32>> = queries.chunks_exact(d).map(|c| c.to_vec()).collect();
    for ef in [32usize, 64] {
        let t = Instant::now();
        let _ = hnsw.parallel_search(&qrows, 10, ef);
        let query = t.elapsed().as_secs_f64();
        let res = hnsw.parallel_search(&qrows[..2000], 10, ef);
        let found: Vec<Vec<u32>> = res.iter().map(|v| v.iter().map(|n| n.d_id as u32).collect()).collect();
        println!("hnsw_rs (ef {ef:3}) build {build:7.2} s  query {query:7.2} s  recall@10 {:.4}", recall(&found, &truth));
    }
}
