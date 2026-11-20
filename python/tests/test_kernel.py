import json
import time

import numpy as np
import pandas as pd
import polars as pl
import pytest

import positron_atlas_kernel as pak


def J(s):
    return json.loads(s)


def wait(job_id, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = J(pak.status(job_id))
        if st["stage"] in ("done", "error", "cancelled"):
            return st
        time.sleep(0.01)
    raise TimeoutError(st)


def make_blobs(n=3000, d=20, k=4, seed=0):
    rng = np.random.default_rng(seed)
    centers = rng.normal(0, 10, size=(k, d))
    labels = rng.integers(0, k, size=n)
    x = centers[labels] + rng.normal(0, 1, size=(n, d))
    return x.astype(np.float64), labels


@pytest.fixture
def ns(monkeypatch):
    space = {}
    monkeypatch.setattr(pak, "_user_ns", lambda: space)
    return space


@pytest.fixture(params=["pandas", "polars"])
def frame_kind(request):
    return request.param


def build_df(kind, x, labels):
    cols = {f"f{i}": x[:, i] for i in range(x.shape[1])}
    cols["label"] = [f"c{v}" for v in labels]
    cols["flag"] = labels % 2 == 0
    cols["when"] = pd.date_range("2020-01-01", periods=len(labels), freq="h")
    if kind == "pandas":
        return pd.DataFrame(cols)
    return pl.DataFrame(cols)


def test_describe(ns, frame_kind):
    x, labels = make_blobs(500, 5)
    ns["df"] = build_df(frame_kind, x, labels)
    d = J(pak.describe("df"))
    assert d["ok"] and d["nRows"] == 500 and d["nCols"] == 8
    kinds = {c["name"]: c["kind"] for c in d["columns"]}
    assert kinds["f0"] == "numeric"
    assert kinds["label"] == "categorical"
    assert kinds["flag"] == "bool"
    assert kinds["when"] == "datetime"
    assert next(c for c in d["columns"] if c["name"] == "label")["n_unique_est"] == 4


def test_describe_errors(ns):
    ns["x"] = 3
    d = J(pak.describe("x"))
    assert not d["ok"] and "Unsupported" in d["error"]
    ns["lz"] = pl.DataFrame({"a": [1]}).lazy()
    assert "LazyFrame" in J(pak.describe("lz"))["error"]
    assert not J(pak.describe("nope"))["ok"]


def test_sample_rows():
    idx = pak.sample_rows(1000, 10, seed=1)
    assert len(idx) == 100 and np.all(np.diff(idx) > 0)
    assert np.array_equal(pak.sample_rows(1000, 10, seed=1), idx)
    assert len(pak.sample_rows(1000, 100, 0)) == 1000
    assert len(pak.sample_rows(1000, 0.01, 0)) == 1


def test_randomized_pca_matches_sklearn():
    from sklearn.decomposition import PCA

    # 6 blobs -> 5 signal directions; noise components are approximate by design.
    x, _ = make_blobs(2000, 30, k=6)
    mean, comps, evr = pak.randomized_pca(x, 5, seed=0)
    ref = PCA(5).fit(x)
    np.testing.assert_allclose(evr, ref.explained_variance_ratio_, rtol=1e-3)
    # components equal up to sign
    dots = np.abs(np.sum(comps * ref.components_, axis=1))
    np.testing.assert_allclose(dots, 1.0, atol=1e-3)


def prepared(ns, frame_kind, tmp_path, **opts):
    x, labels = make_blobs(3000, 20)
    ns["df"] = build_df(frame_kind, x, labels)
    jid = J(pak.create_job("df", str(tmp_path)))["jobId"]
    o = {"features": list(range(20)), "seed": 1, **opts}
    assert J(pak.prepare(jid, json.dumps(o)))["ok"]
    st = wait(jid)
    assert st["stage"] == "done", st
    return jid, st, x, labels


def test_prepare_basic(ns, frame_kind, tmp_path):
    jid, st, x, _ = prepared(ns, frame_kind, tmp_path)
    r = st["result"]
    assert r["nKept"] == 3000 and r["dims"] == 20 and r["nAnchors"] == 3000 and not r["needsProjection"]
    anchors = np.fromfile(tmp_path / "anchors.f32", dtype="<f4").reshape(3000, 20)
    z = (x - x.mean(0)) / x.std(0)
    np.testing.assert_allclose(anchors, z, atol=1e-4)


def test_prepare_sample_pca_anchors(ns, frame_kind, tmp_path):
    jid, st, _, _ = prepared(ns, frame_kind, tmp_path, samplePct=50, pca=True, pcaDims=5, maxAnchors=500)
    r = st["result"]
    assert r["nSampled"] == 1500 and r["dims"] == 5 and r["nAnchors"] == 500 and r["needsProjection"]
    assert len(r["explainedVariance"]) == 5 and r["explainedVariance"][0] > 0.1
    pos = np.fromfile(tmp_path / "anchor_pos.u32", dtype="<u4")
    assert len(pos) == 500 and pos.max() < 1500


def test_anchor_budget(ns, frame_kind, tmp_path):
    _, st, _, _ = prepared(ns, frame_kind, tmp_path, anchorBudget=20 * 100)
    assert st["result"]["nAnchors"] == 100


def test_nan_policies(ns, tmp_path):
    x, labels = make_blobs(1000, 4)
    x[::10, 1] = np.nan
    ns["df"] = pd.DataFrame(x, columns=list("abcd"))
    jid = J(pak.create_job("df", str(tmp_path / "a")))["jobId"]
    pak.prepare(jid, json.dumps({"features": [0, 1, 2, 3]}))
    assert wait(jid)["result"]["nDropped"] == 100
    jid = J(pak.create_job("df", str(tmp_path / "b")))["jobId"]
    pak.prepare(jid, json.dumps({"features": [0, 1, 2, 3], "nanPolicy": "impute"}))
    r = wait(jid)["result"]
    assert r["nDropped"] == 0 and r["nKept"] == 1000


def test_pandas_nullable(ns, tmp_path):
    ns["df"] = pd.DataFrame({"a": pd.array([1, None, 3, 4], dtype="Int64"), "b": [1.0, 2.0, 3.0, 4.0], "c": [True, False, True, None]})
    jid = J(pak.create_job("df", str(tmp_path)))["jobId"]
    pak.prepare(jid, json.dumps({"features": [0, 1, 2]}))
    st = wait(jid)
    assert st["stage"] == "done", st
    assert st["result"]["nKept"] == 2


def test_anchor_index_recall():
    rng = np.random.default_rng(0)
    a = rng.normal(size=(20000, 16)).astype(np.float32)
    q = rng.normal(size=(500, 16)).astype(np.float32)
    idx = pak.AnchorIndex(a, nprobe=8)
    ii, dd = idx.query(q, 10)
    d = pak._sqdist(q, a)
    truth = np.argsort(d, axis=1)[:, :10]
    recall = np.mean([len(set(ii[r]) & set(truth[r])) / 10 for r in range(len(q))])
    assert recall > 0.6, recall
    assert np.all(np.diff(dd, axis=1) >= -1e-4)


def test_anchor_index_exact_small():
    rng = np.random.default_rng(0)
    a = rng.normal(size=(1000, 8)).astype(np.float32)
    q = rng.normal(size=(50, 8)).astype(np.float32)
    ii, _ = pak.AnchorIndex(a).query(q, 5)
    truth = np.argsort(pak._sqdist(q, a), axis=1)[:, :5]
    assert np.array_equal(ii, truth)


def test_project_places_points_near_their_cluster(ns, frame_kind, tmp_path):
    jid, st, _, labels = prepared(ns, frame_kind, tmp_path, maxAnchors=400)
    job = pak._JOBS[jid]
    # Fake anchor layout: put each cluster's anchors at a distinct 2D location.
    anchor_labels = labels[job.kept_idx[job.anchor_pos]]
    centers = np.array([[0, 0], [100, 0], [0, 100], [100, 100]], dtype=np.float32)
    axy = centers[anchor_labels] + np.random.default_rng(0).normal(0, 1, (400, 2)).astype(np.float32)
    path = tmp_path / "axy.f32"
    axy.astype("<f4").tofile(path)
    pak.project(jid, str(path), json.dumps({"k": 10, "chunkRows": 1000}))
    st = wait(jid)
    assert st["stage"] == "done", st
    files = [o for o in st["outputs"] if o["kind"] == "xy"]
    assert len(files) == 3 and files[1]["offset"] == 1000
    xy = np.concatenate([np.fromfile(tmp_path / f["file"], dtype="<f4").reshape(-1, 2) for f in files])
    dist = np.linalg.norm(xy - centers[labels[job.kept_idx]], axis=1)
    assert np.mean(dist < 10) > 0.98
    np.testing.assert_allclose(xy[job.anchor_pos], axy)


def test_colors(ns, frame_kind, tmp_path):
    jid, _, x, labels = prepared(ns, frame_kind, tmp_path)
    c = J(pak.colors(jid, 0))
    assert c["dtype"] == "f32" and c["meta"]["kind"] == "numeric" and c["length"] == 3000
    vals = np.fromfile(tmp_path / c["file"], dtype="<f4")
    np.testing.assert_allclose(vals, x[:, 0], rtol=1e-6)
    c = J(pak.colors(jid, 20))  # label
    assert c["dtype"] == "u16" and sorted(c["meta"]["categories"]) == ["c0", "c1", "c2", "c3"]
    codes = np.fromfile(tmp_path / c["file"], dtype="<u2")
    cats = np.array(c["meta"]["categories"])
    assert np.all(cats[codes] == np.array([f"c{v}" for v in labels]))
    c = J(pak.colors(jid, 21))  # bool
    assert c["meta"]["kind"] == "categorical"
    c = J(pak.colors(jid, 22))  # datetime
    assert c["meta"]["kind"] == "numeric" and c["meta"]["isDatetime"]


def test_colors_many_categories_and_nulls(ns, tmp_path):
    vals = [f"v{i % 50}" for i in range(1000)]
    vals[0] = None
    ns["df"] = pd.DataFrame({"a": np.arange(1000.0), "s": vals})
    jid = J(pak.create_job("df", str(tmp_path)))["jobId"]
    pak.prepare(jid, json.dumps({"features": [0]}))
    wait(jid)
    c = J(pak.colors(jid, 1))
    m = c["meta"]
    assert len(m["categories"]) == pak._MAX_CATEGORIES and m["nullCount"] == 1 and m["otherCount"] > 0
    codes = np.fromfile(tmp_path / c["file"], dtype="<u2")
    assert codes[0] == pak._MAX_CATEGORIES + 1


def test_small_int_is_categorical(ns, tmp_path):
    ns["df"] = pd.DataFrame({"a": np.arange(100.0), "k": np.arange(100) % 3})
    jid = J(pak.create_job("df", str(tmp_path)))["jobId"]
    pak.prepare(jid, json.dumps({"features": [0]}))
    wait(jid)
    assert J(pak.colors(jid, 1))["meta"]["kind"] == "categorical"


def test_row_and_sampled_mapping(ns, frame_kind, tmp_path):
    jid, _, x, _ = prepared(ns, frame_kind, tmp_path, samplePct=10)
    job = pak._JOBS[jid]
    r = J(pak.row(jid, 5))
    assert r["row"] == int(job.kept_idx[5])
    assert r["values"][0][0] == "f0"
    assert float(r["values"][0][1]) == pytest.approx(x[r["row"], 0], rel=1e-5)


def test_add_coordinates(ns, frame_kind, tmp_path):
    jid, _, _, _ = prepared(ns, frame_kind, tmp_path, samplePct=50)
    xy = np.random.default_rng(0).normal(size=(1500, 2)).astype("<f4")
    p = tmp_path / "xy.f32"
    xy.tofile(p)
    r = J(pak.add_coordinates(jid, str(p)))
    assert r["ok"], r
    df = ns["df"]
    ux = df["umap_x"].to_numpy()
    assert np.isnan(ux).sum() == 1500
    job = pak._JOBS[jid]
    np.testing.assert_allclose(ux[job.kept_idx], xy[:, 0])


def test_cancel(ns, tmp_path):
    x = np.random.default_rng(0).normal(size=(400_000, 50))
    ns["df"] = pd.DataFrame(x)
    jid = J(pak.create_job("df", str(tmp_path)))["jobId"]
    pak.prepare(jid, json.dumps({"features": list(range(50)), "pca": True, "pcaDims": 10}))
    time.sleep(0.05)
    pak.cancel(jid)
    st = wait(jid)
    assert st["stage"] in ("cancelled", "done")


def test_list_frames(ns):
    ns["a"] = pd.DataFrame({"x": [1]})
    ns["b"] = pl.DataFrame({"x": [1, 2]})
    ns["c"] = 5
    ns["_hidden"] = pd.DataFrame()
    r = J(pak.list_frames())
    assert {f["name"] for f in r["frames"]} == {"a", "b"}


def test_unknown_job():
    r = J(pak.status("nope"))
    assert not r["ok"] and "Unknown job" in r["error"]


def test_exact_umap_missing_dependency_or_runs(ns, tmp_path):
    import importlib.util

    jid, _, _, _ = prepared(ns, "pandas", tmp_path)
    pak.exact_umap(jid, json.dumps({"nNeighbors": 10, "nEpochs": 20, "seed": 0}))
    st = wait(jid, timeout=300)
    if importlib.util.find_spec("umap") is None:
        assert st["stage"] == "error" and "umap-learn is not installed" in st["error"]
    else:
        assert st["stage"] == "done", st
        assert pak._JOBS[jid].xy.shape == (3000, 2)


def test_write_xy_chunks(ns, tmp_path):
    jid, _, _, _ = prepared(ns, "pandas", tmp_path)
    job = pak._JOBS[jid]
    xy = np.arange(10, dtype=np.float32).reshape(5, 2)
    assert pak._write_xy_chunks(job, xy, chunk_rows=2) == 3
    offsets = [o["offset"] for o in job.outputs if o["kind"] == "xy"]
    assert offsets == [0, 2, 4]
    np.testing.assert_array_equal(np.fromfile(tmp_path / "xy_0002.f32", dtype="<f4"), [8, 9])


def test_superseded_task_does_not_block_or_clobber(ns, tmp_path):
    """An uninterruptible task is orphaned after a short wait; its result is ignored."""
    jid, _, _, _ = prepared(ns, "pandas", tmp_path)
    job = pak._JOBS[jid]
    release = __import__("threading").Event()

    def stuck():
        release.wait(10)  # e.g. umap-learn fit: never checks for cancellation
        job.set("late")  # must raise: superseded
        return {"from": "stuck"}

    job.run("stuck", stuck)
    t0 = time.time()
    job.run("quick", lambda: {"from": "quick"})
    assert time.time() - t0 < 5
    st = wait(jid)
    assert st["stage"] == "done" and st["result"] == {"from": "quick"} and st["task"] == "quick"
    release.set()
    time.sleep(0.2)
    st = J(pak.status(jid))
    assert st["result"] == {"from": "quick"} and st["stage"] == "done"


def test_cancel_sees_own_event(ns, tmp_path):
    jid, _, _, _ = prepared(ns, "pandas", tmp_path)
    job = pak._JOBS[jid]
    started = __import__("threading").Event()

    def loop():
        started.set()
        while True:
            job.set("looping")
            time.sleep(0.01)

    job.run("loop", loop)
    started.wait(5)
    pak.cancel(jid)
    assert wait(jid)["stage"] == "cancelled"


@pytest.mark.parametrize("kind", ["pandas", "polars"])
def test_category_order(ns, tmp_path, kind):
    labels = ["b"] * 50 + ["c"] * 30 + ["a"] * 20
    order = ["c", "a", "b"]
    x = np.arange(100.0)
    if kind == "pandas":
        ns["df"] = pd.DataFrame({"x": x, "cat": pd.Categorical(labels, categories=order), "s": labels, "k": np.array([3, 1, 2] * 33 + [3])})
    else:
        ns["df"] = pl.DataFrame({"x": x, "cat": pl.Series(labels, dtype=pl.Enum(order)), "s": labels, "k": np.array([3, 1, 2] * 33 + [3])})
    jid = J(pak.create_job("df", str(tmp_path)))["jobId"]
    pak.prepare(jid, json.dumps({"features": [0]}))
    wait(jid)
    assert J(pak.colors(jid, 1))["meta"]["categories"] == order  # declared order
    assert J(pak.colors(jid, 2))["meta"]["categories"] == ["b", "c", "a"]  # by frequency
    k = J(pak.colors(jid, 3))["meta"]["categories"]  # small ints -> numeric order
    assert k in (["1", "2", "3"], ["1.0", "2.0", "3.0"])
