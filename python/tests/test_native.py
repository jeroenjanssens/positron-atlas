"""The Rust core (_positron_atlas_core) against the numpy code it replaces."""

import json
import os
import threading
import time

import numpy as np
import pytest

import positron_atlas_kernel as pak

core = pak._native_core()
pytestmark = pytest.mark.skipif(core is None, reason=f"native core not available: {pak._NATIVE_INFO.get('reason')}")


def blobs(n, d, seed=0, centers=50):
    rng = np.random.default_rng(seed)
    c = rng.normal(0, 4, (centers, d)).astype(np.float32)
    x = c[rng.integers(0, centers, n)]
    x += rng.normal(0, 1, (n, d)).astype(np.float32)
    return x


def brute(q, a, k=10):
    d = pak._sqdist(q, a)
    return np.argsort(d, axis=1, kind="stable")[:, :k], np.sort(d, axis=1)[:, :k]


def recall(ii, truth):
    return float(np.mean([len(np.intersect1d(ii[r], truth[r])) / truth.shape[1] for r in range(len(truth))]))


def test_version_and_status():
    assert core.VERSION == pak.VERSION
    st = pak._native_status()
    assert st["available"] is True and st["target"] == pak._native_target()


def test_exact_small_index_matches_numpy():
    a = blobs(1000, 8, 1)
    q = blobs(300, 8, 2)
    idx = core.Index(a)
    assert idx.exact and idx.n_anchors == 1000 and idx.dims == 8
    ii, dd = idx.neighbors(q, 5)
    t_i, t_d = brute(q, a, 5)
    assert recall(ii, t_i) == 1.0
    np.testing.assert_allclose(dd, t_d, rtol=1e-4, atol=1e-3)
    assert np.all(np.diff(dd, axis=1) >= 0)


@pytest.mark.parametrize("d", [16, 50, 300])
def test_ivf_quality_matches_numpy(d):
    a = blobs(20_000, d, 3)
    q = blobs(2_000, d, 4)
    truth_i, truth_d = brute(q, a)
    r_rust = recall(core.Index(a, seed=0).neighbors(q, 10)[0], truth_i)
    r_numpy = recall(pak.AnchorIndex(a, seed=0).query(q, 10)[0], truth_i)
    assert r_rust >= r_numpy - 0.02, (r_rust, r_numpy)
    # Placement error against exact neighbors, relative to the layout's spread.
    axy = np.random.default_rng(5).normal(size=(len(a), 2)).astype(np.float32)
    exact = pak.place_from_neighbors(truth_i, truth_d, axy)
    out = np.zeros((len(q), 2), dtype=np.float32)
    assert core.Index(a, seed=0).place(q, np.arange(len(q), dtype=np.int64), axy, out, 10)
    ii, dd = pak.AnchorIndex(a, seed=0).query(q, 10)
    via_numpy = pak.place_from_neighbors(ii, dd, axy)
    err_rust = np.linalg.norm(out - exact, axis=1).mean()
    err_numpy = np.linalg.norm(via_numpy - exact, axis=1).mean()
    assert err_rust <= 1.5 * err_numpy + 0.01, (err_rust, err_numpy)


def test_placement_formula_matches_numpy():
    # Exact index: the same neighbors, so the same positions up to float rounding.
    a = blobs(2_000, 10, 6)
    q = blobs(500, 10, 7)
    axy = np.random.default_rng(8).normal(size=(len(a), 2)).astype(np.float32)
    out = np.zeros((len(q), 2), dtype=np.float32)
    core.Index(a).place(q, np.arange(len(q), dtype=np.int64), axy, out, 10)
    ii, dd = pak.AnchorIndex(a).query(q, 10)
    np.testing.assert_allclose(out, pak.place_from_neighbors(ii, dd, axy), rtol=1e-3, atol=1e-4)


def test_cosine_matches_normalized_euclidean():
    a = blobs(3_000, 12, 9)
    q = blobs(200, 12, 10)
    ii, _ = core.Index(a, cosine=True).neighbors(q, 10)
    an = a / np.linalg.norm(a, axis=1, keepdims=True)
    qn = q / np.linalg.norm(q, axis=1, keepdims=True)
    assert recall(ii, brute(qn, an)[0]) == 1.0


def test_writes_only_the_given_rows_and_validates_input():
    a = blobs(500, 4, 11)
    axy = np.zeros((500, 2), dtype=np.float32)
    x = blobs(100, 4, 12)
    out = np.full((100, 2), 7.0, dtype=np.float32)
    rows = np.array([3, 50, 99], dtype=np.int64)
    idx = core.Index(a)
    assert idx.place(x, rows, axy, out, 10)
    assert np.all(out[rows] == 0.0)
    mask = np.ones(100, dtype=bool)
    mask[rows] = False
    assert np.all(out[mask] == 7.0)
    with pytest.raises(ValueError, match="out of range"):
        idx.place(x, np.array([100], dtype=np.int64), axy, out, 10)
    with pytest.raises(ValueError, match="columns"):
        idx.place(blobs(10, 5), rows[:1], axy, out[:10], 10)
    with pytest.raises(ValueError, match="anchor_xy"):
        idx.place(x, rows, axy[:10], out, 10)
    # Fortran order (column-major) would be read wrongly: refused, for every array.
    with pytest.raises(ValueError, match="x must be a C-contiguous"):
        idx.place(np.asfortranarray(x), rows, axy, out, 10)
    with pytest.raises(ValueError, match="anchor_xy must be a C-contiguous"):
        idx.place(x, rows, np.asfortranarray(axy), out, 10)
    with pytest.raises(ValueError, match="out must be a C-contiguous"):
        idx.place(x, rows, axy, np.asfortranarray(out), 10)
    with pytest.raises(ValueError, match="anchors must be a C-contiguous"):
        core.Index(np.asfortranarray(a))
    with pytest.raises(ValueError, match="q must be a C-contiguous"):
        idx.neighbors(np.asfortranarray(x[:5]), 3)
    # Read-only input (e.g. a memmap opened read-only) is fine.
    ro = x.copy()
    ro.setflags(write=False)
    assert idx.place(ro, rows, axy, out, 10)


def test_cancel_and_progress_callbacks():
    a = blobs(5_000, 8, 13)
    x = blobs(50_000, 8, 14)
    axy = np.zeros((5_000, 2), dtype=np.float32)
    out = np.zeros((50_000, 2), dtype=np.float32)
    rows = np.arange(50_000, dtype=np.int64)
    idx = core.Index(a)
    seen = []
    assert idx.place(x, rows, axy, out, 10, progress=seen.append, block_rows=10_000)
    assert seen == [10_000, 20_000, 30_000, 40_000, 50_000]
    calls = []

    def cancel():
        calls.append(1)
        return len(calls) > 2

    assert idx.place(x, rows, axy, out, 10, cancel=cancel, block_rows=10_000) is False
    assert len(calls) == 3

    class Stop(Exception):
        pass

    def boom(done):
        raise Stop()

    with pytest.raises(Stop):
        idx.place(x, rows, axy, out, 10, progress=boom, block_rows=10_000)


def test_gil_is_released():
    a = blobs(100_000, 32, 15)
    x = blobs(400_000, 32, 16)
    axy = np.zeros((len(a), 2), dtype=np.float32)
    out = np.zeros((len(x), 2), dtype=np.float32)
    idx = core.Index(a)
    ticks = 0
    done = threading.Event()

    def work():
        idx.place(x, np.arange(len(x), dtype=np.int64), axy, out, 10)
        done.set()

    t0 = time.perf_counter()
    th = threading.Thread(target=work)
    th.start()
    while not done.is_set():
        ticks += 1
        time.sleep(0.001)
    th.join()
    elapsed = time.perf_counter() - t0
    # The Python thread kept running while the core worked (it gets ~1 tick per ms when free).
    assert elapsed > 0.05 and ticks > 0.3 * elapsed * 1000, (ticks, elapsed)


def test_project_job_uses_the_core_and_reports_it(tmp_path, monkeypatch):
    import pandas as pd

    x = blobs(30_000, 20, 17)
    space = {"df": pd.DataFrame(x)}
    monkeypatch.setattr(pak, "_user_ns", lambda: space)
    jid = json.loads(pak.create_job("df", str(tmp_path)))["jobId"]
    pak.prepare(jid, json.dumps({"features": list(range(20)), "maxAnchors": 5_000}))
    while json.loads(pak.status(jid))["stage"] not in ("done", "error"):
        time.sleep(0.01)
    job = pak._JOBS[jid]
    axy = np.random.default_rng(0).normal(size=(5_000, 2)).astype("<f4")
    axy.tofile(tmp_path / "axy.f32")
    results = {}
    for native in (True, False):
        pak.project(jid, str(tmp_path / "axy.f32"), json.dumps({"native": native}))
        while (st := json.loads(pak.status(jid)))["stage"] not in ("done", "error"):
            time.sleep(0.01)
        assert st["stage"] == "done", st
        assert st["result"]["backend"] == ("rust" if native else "numpy")
        results[native] = job.xy.copy()
    # Both place every row; positions agree closely (different k-means seeds, same algorithm).
    diff = np.linalg.norm(results[True] - results[False], axis=1)
    spread = np.sqrt(((axy - axy.mean(0)) ** 2).sum(1).mean())
    assert np.isfinite(results[True]).all()
    assert np.median(diff) / spread < 0.02
    assert json.loads(pak.estimate_projection(jid))["backend"] == "rust"
    assert json.loads(pak.estimate_projection(jid, False))["backend"] == "numpy"


def test_falls_back_to_numpy(monkeypatch):
    monkeypatch.setattr(pak, "_NATIVE", None)
    monkeypatch.setattr(pak, "_NATIVE_INFO", {})
    monkeypatch.setenv("POSITRON_ATLAS_NO_NATIVE", "1")
    assert pak._native_core() is None
    st = pak._native_status()
    assert st["available"] is False and "POSITRON_ATLAS_NO_NATIVE" in st["reason"]
    monkeypatch.delenv("POSITRON_ATLAS_NO_NATIVE")
    monkeypatch.setattr(pak, "_NATIVE_INFO", {})
    monkeypatch.setattr(pak, "_native_target", lambda: "nowhere-x99")
    assert pak._native_core() is None
    assert "no native core for nowhere-x99" in pak._native_status()["reason"]
