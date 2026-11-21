//! A small seeded random generator (PCG32), so results are the same on every platform and do not
//! depend on the `rand` crate's API or algorithms.

pub struct Pcg32 {
    state: u64,
    inc: u64,
}

impl Pcg32 {
    pub fn new(seed: u64) -> Self {
        let mut r = Pcg32 { state: 0, inc: (0xda3e_39cb_94b9_5bdb_u64 << 1) | 1 };
        r.next_u32();
        r.state = r.state.wrapping_add(seed);
        r.next_u32();
        r
    }

    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(self.inc);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        xorshifted.rotate_right((old >> 59) as u32)
    }

    /// Uniform integer in [0, n) without bias (Lemire's method). `n` must be > 0.
    pub fn below(&mut self, n: u32) -> u32 {
        assert!(n > 0);
        let mut m = self.next_u32() as u64 * n as u64;
        let mut low = m as u32;
        if low < n {
            let threshold = n.wrapping_neg() % n;
            while low < threshold {
                m = self.next_u32() as u64 * n as u64;
                low = m as u32;
            }
        }
        (m >> 32) as u32
    }

    /// `k` distinct indices from [0, n), in random order (partial Fisher-Yates).
    pub fn sample(&mut self, n: usize, k: usize) -> Vec<usize> {
        let k = k.min(n);
        let mut pool: Vec<usize> = (0..n).collect();
        for i in 0..k {
            let j = i + self.below((n - i) as u32) as usize;
            pool.swap(i, j);
        }
        pool.truncate(k);
        pool
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_in_range() {
        let a: Vec<u32> = {
            let mut r = Pcg32::new(7);
            (0..100).map(|_| r.below(10)).collect()
        };
        let b: Vec<u32> = {
            let mut r = Pcg32::new(7);
            (0..100).map(|_| r.below(10)).collect()
        };
        assert_eq!(a, b);
        assert!(a.iter().all(|&v| v < 10));
        let mut counts = [0usize; 10];
        let mut r = Pcg32::new(1);
        for _ in 0..100_000 {
            counts[r.below(10) as usize] += 1;
        }
        assert!(counts.iter().all(|&c| (9_000..11_000).contains(&c)), "{counts:?}");
    }

    #[test]
    fn sample_is_distinct() {
        let mut r = Pcg32::new(3);
        let s = r.sample(1000, 500);
        let mut u = s.clone();
        u.sort_unstable();
        u.dedup();
        assert_eq!(u.len(), 500);
        assert_eq!(r.sample(5, 10).len(), 5);
    }
}
