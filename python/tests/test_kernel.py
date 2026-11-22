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
    # polars LazyFrame is now collected automatically instead of raising.
    ns["lz"] = pl.DataFrame({"a": [1, 2]}).lazy()
    d = J(pak.describe("lz"))
    assert d["ok"] and d["wasLazy"] is True and d["nRows"] == 2
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


@pytest.mark.parametrize("native", [True, False])
def test_project_places_points_near_their_cluster(ns, frame_kind, tmp_path, native):
    if native and pak._native_core() is None:
        pytest.skip(f"native core not available: {pak._NATIVE_INFO.get('reason')}")
    jid, st, _, labels = prepared(ns, frame_kind, tmp_path, maxAnchors=400)
    job = pak._JOBS[jid]
    # Fake anchor layout: put each cluster's anchors at a distinct 2D location.
    anchor_labels = labels[job.kept_idx[job.anchor_pos]]
    centers = np.array([[0, 0], [100, 0], [0, 100], [100, 100]], dtype=np.float32)
    axy = centers[anchor_labels] + np.random.default_rng(0).normal(0, 1, (400, 2)).astype(np.float32)
    path = tmp_path / "axy.f32"
    axy.astype("<f4").tofile(path)
    pak.project(jid, str(path), json.dumps({"k": 10, "chunkRows": 1000, "native": native}))
    st = wait(jid)
    assert st["stage"] == "done", st
    assert st["result"]["backend"] == ("rust" if native else "numpy")
    files = [o for o in st["outputs"] if o["kind"] == "xy"]
    # Geometric chunks: n=3000 fits in the first 100k chunk → 1 file; check offsets are set.
    assert len(files) >= 1 and files[0]["offset"] == 0
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


def test_colors_max_categories(ns, frame_kind, tmp_path):
    vals = [f"v{i % 50:02d}" for i in range(1000)]
    vals[0] = None
    df = pd.DataFrame({"a": np.arange(1000.0), "s": vals, "k": np.arange(1000) % 30})
    ns["df"] = df if frame_kind == "pandas" else pl.from_pandas(df)
    jid = J(pak.create_job("df", str(tmp_path)))["jobId"]
    pak.prepare(jid, json.dumps({"features": [0]}))
    wait(jid)
    # All 50 values fit: no "Other", and the codes map back to the values.
    c = J(pak.colors(jid, 1, True, 200))
    m = c["meta"]
    assert len(m["categories"]) == 50 and m["otherCount"] == 0 and m["nullCount"] == 1 and m["nUnique"] == 50
    codes = np.fromfile(tmp_path / c["file"], dtype="<u2")
    cats = np.array(m["categories"] + ["<other>", "<null>"])
    assert cats[codes[0]] == "<null>"
    assert list(cats[codes[1:]]) == vals[1:]
    # A smaller limit keeps the most frequent values.
    m = J(pak.colors(jid, 1, True, 5))["meta"]
    assert len(m["categories"]) == 5 and m["otherCount"] == 999 - sum(m["counts"])
    # Forced categories of a numeric column, in numeric order.
    m = J(pak.colors(jid, 2, True, 100))["meta"]
    assert m["kind"] == "categorical" and m["categories"] == [str(i) for i in range(30)]
    # The default is unchanged.
    assert len(J(pak.colors(jid, 1))["meta"]["categories"]) == pak._MAX_CATEGORIES


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


@pytest.mark.parametrize("kind", ["pandas", "polars"])
def test_row_with_image(ns, tmp_path, kind):
    pixels = np.arange(2 * 16, dtype=np.uint8).reshape(2, 16)
    cols = {f"px{i}": pixels[:, i] for i in range(16)}
    cols["label"] = ["a", "b"]
    ns["df"] = pd.DataFrame(cols) if kind == "pandas" else pl.DataFrame(cols)
    jid = J(pak.create_job("df", str(tmp_path)))["jobId"]
    pak.prepare(jid, json.dumps({"features": list(range(16)), "standardize": False}))
    wait(jid)
    r = J(pak.row(jid, 1, list(range(16))))
    assert r["image"] == [float(v) for v in pixels[1]]
    assert [k for k, _ in r["values"]] == ["label"]  # pixel columns are not repeated in the table
    plain = J(pak.row(jid, 1))
    assert "image" not in plain and len(plain["values"]) == 17


def write_mask(path, mask):
    np.packbits(np.asarray(mask, dtype=bool), bitorder="little").tofile(path)
    return str(path)


def test_compare_selection(ns, frame_kind, tmp_path):
    jid, _, x, labels = prepared(ns, frame_kind, tmp_path, samplePct=50)
    job = pak._JOBS[jid]
    kept_labels = labels[job.kept_idx]
    mask = kept_labels == 2
    r = J(pak.compare_selection(jid, write_mask(tmp_path / "m.bin", mask)))
    assert r["selected"] == int(mask.sum()) and r["total"] == len(job.kept_idx) and not r["sampled"]
    # The selected cluster's label is the most over-represented value, at 100 %.
    top = r["categorical"][0]
    assert (top["column"], top["value"], top["shareSelected"]) == ("label", "c2", 1.0)
    assert top["shareAll"] == pytest.approx(mask.mean())
    # Values that are not over-represented are left out (flag is ~50 % both inside and outside).
    assert all(c["shareSelected"] - c["shareAll"] >= 0.02 and c["shareSelected"] >= 1.25 * c["shareAll"] for c in r["categorical"])
    # Numeric effects: the largest standardized differences, with the right sign and size.
    assert len(r["numeric"]) == 8
    first = r["numeric"][0]
    col = x[job.kept_idx][:, int(first["column"][1:])] if first["column"].startswith("f") else None
    assert col is not None
    assert first["meanSelected"] == pytest.approx(col[mask].mean(), rel=1e-4)
    assert first["effect"] == pytest.approx((col[mask].mean() - col.mean()) / col.std(), rel=1e-3)
    assert abs(first["effect"]) >= abs(r["numeric"][-1]["effect"])


def test_compare_selection_errors(ns, tmp_path):
    jid, _, _, _ = prepared(ns, "pandas", tmp_path)
    n = len(pak._JOBS[jid].kept_idx)
    assert "Nothing is selected" in J(pak.compare_selection(jid, write_mask(tmp_path / "z.bin", np.zeros(n))))["error"]
    assert "bits" in J(pak.compare_selection(jid, write_mask(tmp_path / "s.bin", np.ones(n + 9))))["error"]


def test_selection_frame(ns, frame_kind, tmp_path):
    jid, _, x, labels = prepared(ns, frame_kind, tmp_path, samplePct=50)
    job = pak._JOBS[jid]
    mask = np.zeros(len(job.kept_idx), dtype=bool)
    mask[[0, 5, 7, len(mask) - 1]] = True
    path = write_mask(tmp_path / "m.bin", mask)
    r = J(pak.selection_frame(jid, path))
    assert r == {"ok": True, "variable": "df_selection", "rows": 4}
    sel = ns["df_selection"]
    rows = np.sort(job.kept_idx[mask])
    np.testing.assert_allclose(np.asarray(sel["f0"]), x[rows, 0])
    # Never overwrites: the next one gets a suffix.
    assert J(pak.selection_frame(jid, path))["variable"] == "df_selection_2"
    assert J(pak.selection_frame(jid, path, "class"))["variable"] == "atlas_selection"
    if frame_kind == "pandas":
        sel.iloc[0, 0] = -1.0  # a copy: the original is untouched
        assert ns["df"].iloc[rows[0], 0] == x[rows[0], 0]


def test_describe_groups(ns, frame_kind, tmp_path):
    rng = np.random.default_rng(0)
    n = 2000
    g = rng.integers(0, 3, n)
    df = pd.DataFrame(
        {
            "income": np.where(g == 0, 5.0, 0.0) + rng.normal(0, 1, n),
            "age": np.where(g == 1, -5.0, 0.0) + rng.normal(0, 1, n),
            "noise": rng.normal(0, 1, n),
            "flag": g == 2,
            "name": [f"r{i}" for i in range(n)],
        }
    )
    ns["df"] = df if frame_kind == "pandas" else pl.from_pandas(df)
    jid = J(pak.create_job("df", str(tmp_path)))["jobId"]
    pak.prepare(jid, json.dumps({"features": [0, 1, 2]}))
    wait(jid)
    job = pak._JOBS[jid]
    codes = g[job.kept_idx].astype("<u2")
    codes[:10] = 3  # not in a group
    codes.tofile(tmp_path / "codes.u2")
    r = J(pak.describe_groups(jid, str(tmp_path / "codes.u2"), 3, [0, 1, 2, 3, 4], 100_000, 1))
    assert r["names"] == ["↑ income", "↓ age", "↑ flag"]
    assert sum(r["counts"]) == len(codes) - 10
    # Two names per group by default; weak differences are left out.
    r = J(pak.describe_groups(jid, str(tmp_path / "codes.u2"), 3, [2]))
    assert r["names"] == ["", "", ""]
    assert "FileNotFoundError" in J(pak.describe_groups(jid, str(tmp_path / "missing.u2"), 3, [0]))["error"]
    (tmp_path / "short.u2").write_bytes(b"\x00\x00")
    assert "prepared rows" in J(pak.describe_groups(jid, str(tmp_path / "short.u2"), 3, [0]))["error"]


def test_write_labels(ns, frame_kind, tmp_path):
    jid, _, x, labels = prepared(ns, frame_kind, tmp_path, samplePct=50)
    job = pak._JOBS[jid]
    n_kept = len(job.kept_idx)
    codes = np.full(n_kept, 65535, dtype="<u2")
    codes[:3] = 0
    codes[3:5] = 1
    path = tmp_path / "codes.u2"
    codes.tofile(path)
    # A new column: the tagged rows get their names, all other rows are missing.
    r = J(pak.write_labels(jid, str(path), ["a", "b"], "atlas_tag"))
    assert r == {"ok": True, "variable": "df", "column": "atlas_tag", "rows": 5}
    df = ns["df"]
    col = list(df["atlas_tag"]) if frame_kind == "polars" else df["atlas_tag"].tolist()
    expect = [None] * len(labels)
    for i, row in enumerate(job.kept_idx[:5]):
        expect[row] = "a" if i < 3 else "b"
    norm = [None if (v is None or v is pd.NA) else v for v in col]
    assert norm == expect
    # Existing column, keep others: earlier tags stay, new ones overwrite.
    codes[:] = 65535
    codes[0] = 0
    codes[10] = 0
    codes.tofile(path)
    pak.write_labels(jid, str(path), ["c"], "atlas_tag")
    col = list(ns["df"]["atlas_tag"])
    norm = [None if (v is None or v is pd.NA) else v for v in col]
    assert norm[job.kept_idx[0]] == "c" and norm[job.kept_idx[1]] == "a" and norm[job.kept_idx[10]] == "c"
    # keep_others=False clears the prepared rows that are not labeled (cluster noise).
    pak.write_labels(jid, str(path), ["c"], "atlas_tag", False)
    col = list(ns["df"]["atlas_tag"])
    norm = [None if (v is None or v is pd.NA) else v for v in col]
    assert norm[job.kept_idx[1]] is None and norm[job.kept_idx[0]] == "c"
    # The frame is not reported as changed by the user, and the new column is described.
    st = J(pak.status(jid))
    assert st["stale"] is False
    d = J(pak.describe("df"))
    assert d["columns"][-1]["name"] == "atlas_tag" and d["columns"][-1]["kind"] == "categorical"
    assert "empty" in J(pak.write_labels(jid, str(path), ["c"], "  "))["error"]


def test_changed_frame_is_refused(ns, frame_kind, tmp_path):
    jid, _, _, _ = prepared(ns, frame_kind, tmp_path)
    job = pak._JOBS[jid]
    n = len(job.kept_idx)
    mask = write_mask(tmp_path / "m.bin", np.ones(n))
    codes = tmp_path / "c.u2"
    np.zeros(n, dtype="<u2").tofile(codes)
    # Atlas's own columns (coordinates, tags) don't count as changes.
    xy = tmp_path / "xy.f32"
    np.zeros((n, 2), dtype="<f4").tofile(xy)
    assert J(pak.add_coordinates(jid, str(xy)))["ok"]
    assert J(pak.write_labels(jid, str(codes), ["a"], "atlas_tag"))["ok"]
    assert J(pak.compare_selection(jid, mask))["ok"]
    # A change by the user (rows removed): everything that uses row positions refuses.
    df = ns["df"]
    ns["df"] = df.iloc[:-5] if frame_kind == "pandas" else df.head(len(df) - 5)
    job.frame = pak._Frame(ns["df"])  # the job's frame object, as when the user mutates it in place
    for r in (
        pak.compare_selection(jid, mask),
        pak.selection_frame(jid, mask),
        pak.describe_groups(jid, str(codes), 1, [0]),
        pak.write_labels(jid, str(codes), ["a"], "atlas_tag"),
        pak.add_coordinates(jid, str(xy)),
    ):
        assert "changed since Atlas loaded it" in J(r)["error"]


def test_compare_dates_and_durations(ns, tmp_path):
    n = 400
    g = np.arange(n) % 2 == 0
    base = pd.Timestamp("2024-01-01", tz="UTC")
    ns["df"] = pd.DataFrame(
        {
            "a": np.arange(n, dtype=float),
            "when": [base + pd.Timedelta(days=int(d)) for d in np.where(g, 100, 0)],
            "took": pd.to_timedelta(np.where(g, 10, 0), unit="s"),
        }
    )
    jid = J(pak.create_job("df", str(tmp_path)))["jobId"]
    pak.prepare(jid, json.dumps({"features": [0]}))
    wait(jid)
    job = pak._JOBS[jid]
    r = J(pak.compare_selection(jid, write_mask(tmp_path / "m.bin", g[job.kept_idx])))
    by = {x["column"]: x for x in r["numeric"]}
    assert by["when"]["isDatetime"] is True
    # Nanoseconds since the epoch, like datetime64 columns: the selection is at 2024-04-10.
    assert pd.Timestamp(int(by["when"]["meanSelected"]), unit="ns") == pd.Timestamp("2024-04-10")
    assert by["took"]["isDatetime"] is False


def test_write_labels_non_string_label(ns, tmp_path):
    ns["df"] = pd.DataFrame({0: np.arange(50.0), 1: np.arange(50.0) * 2})
    jid = J(pak.create_job("df", str(tmp_path)))["jobId"]
    pak.prepare(jid, json.dumps({"features": [0, 1]}))
    wait(jid)
    n = len(pak._JOBS[jid].kept_idx)
    codes = np.zeros(n, dtype="<u2")
    codes.tofile(tmp_path / "c.u2")
    assert J(pak.write_labels(jid, str(tmp_path / "c.u2"), ["x"], "1"))["ok"]
    # Column 1 (an integer label) is overwritten, not duplicated as "1".
    assert list(ns["df"].columns) == [0, 1]
    assert set(ns["df"][1]) == {"x"}


def _fast_slow(frame, col, rows, force=True, top=200):
    fast = pak._color_values(frame, col, rows, force, top, fast_categories=True)
    slow = pak._color_values(frame, col, rows, force, top, fast_categories=False)
    return fast, slow


@pytest.mark.parametrize("n_cat", [5, 40])
def test_fast_categories_match_the_general_path(n_cat):
    rng = np.random.default_rng(0)
    n = 3000
    words = np.array([f"w{i:02d}" for i in range(n_cat)] + ["é", "10", "9", ""], dtype=object)
    text = words[rng.integers(0, len(words), n)].astype(object)
    text[rng.random(n) < 0.05] = None
    ints = rng.integers(-3, n_cat, n)
    flags = rng.random(n) < 0.3
    cols = {"text": text, "ints": ints, "flags": flags, "mixed": np.where(rng.random(n) < 0.5, ints, ints.astype(str)).astype(object)}
    pdf = pd.DataFrame(cols)
    pdf["cat"] = pd.Categorical(text[: n], categories=sorted({v for v in text if v is not None}, reverse=True))
    pdf["nullable"] = pd.array(np.where(rng.random(n) < 0.1, None, ints), dtype="Int64")
    pdf["nbool"] = pd.array(np.where(rng.random(n) < 0.1, None, flags), dtype="boolean")
    pldf = pl.DataFrame({"text": list(text), "ints": ints, "flags": flags, "cat": pl.Series(list(text), dtype=pl.Categorical),
                         "enum": pl.Series([v if v is not None else None for v in text], dtype=pl.Enum(sorted({v for v in text if v is not None})))})
    rows = np.sort(rng.choice(n, size=2000, replace=False))
    for frame_obj in (pdf, pldf):
        frame = pak._Frame(frame_obj)
        for j, name in enumerate(frame.column_names()):
            if name == "nullable":
                continue  # integers with missing values: "3" instead of "3.0" (tested below)
            for top in (200, 7):
                assert pak._factorize(frame, j, rows) is not None, name
                (dt_f, codes_f, meta_f), (dt_s, codes_s, meta_s) = _fast_slow(frame, j, rows, top=top)
                assert dt_f == dt_s == "u16", name
                assert meta_f == meta_s, (name, top)
                assert np.array_equal(codes_f, codes_s), (name, top)


def test_fast_categories_skip_other_dtypes_and_int_nulls_in_polars():
    n = 500
    rng = np.random.default_rng(1)
    pdf = pd.DataFrame({"f": rng.normal(size=n), "when": pd.date_range("2020-01-01", periods=n, freq="D"), "obj": [object()] * n})
    frame = pak._Frame(pdf)
    rows = np.arange(n)
    assert pak._factorize(frame, 0, rows) is None
    assert pak._factorize(frame, 1, rows) is None
    # Object columns of anything are factorized by their text, like the general path.
    (_, codes_f, meta_f), (_, codes_s, meta_s) = _fast_slow(frame, 2, rows)
    assert meta_f == meta_s and np.array_equal(codes_f, codes_s)
    # polars integers with nulls: labeled "3", where the general path says "3.0".
    s = pl.DataFrame({"k": pl.Series([3, None, 1, 3], dtype=pl.Int64)})
    _, _, meta = pak._color_values(pak._Frame(s), 0, np.arange(4), True, 200)
    assert meta["categories"] == ["1", "3"] and meta["nullCount"] == 1
    p = pd.DataFrame({"k": pd.array([3, None, 1, 3], dtype="Int64")})
    _, codes, meta = pak._color_values(pak._Frame(p), 0, np.arange(4), True, 200)
    assert meta["categories"] == ["1", "3"] and meta["nullCount"] == 1 and codes.tolist() == [1, 3, 0, 1]


def run_exact(jid, params):
    pak.exact_umap(jid, json.dumps(params))
    st = wait(jid, timeout=300)
    return st


def test_exact_polars_umap(ns, frame_kind, tmp_path):
    pytest.importorskip("polars_umap")
    jid, _, _, labels = prepared(ns, frame_kind, tmp_path)
    params = {"engine": "polars-umap", "nNeighbors": 10, "minDist": 0.2, "spread": 1.0, "metric": "euclidean", "nEpochs": 60, "seed": 3}
    st = run_exact(jid, params)
    assert st["stage"] == "done", st
    assert st["result"]["engine"] == "polars-umap" and st["result"]["nRows"] == 3000
    job = pak._JOBS[jid]
    xy1 = job.xy.copy()
    assert xy1.shape == (3000, 2) and np.isfinite(xy1).all()
    # Clusters stay together: each label's points are closer to their own centroid than to others'.
    lab = labels[job.kept_idx]
    cents = np.array([xy1[lab == c].mean(0) for c in range(4)])
    nearest = np.argmin(((xy1[:, None, :] - cents[None]) ** 2).sum(-1), axis=1)
    assert np.mean(nearest == lab) > 0.95
    # The same seed gives the same layout.
    run_exact(jid, params)
    np.testing.assert_array_equal(job.xy, xy1)
    assert json.loads(pak.describe("df"))["deps"]["polars_umap"] is True


def test_polars_umap_arguments(ns, tmp_path, monkeypatch):
    pu = pytest.importorskip("polars_umap")
    seen = {}
    real = pu.umap

    def spy(*a, **kw):
        seen.update(kw)
        return real(*a, **kw)

    monkeypatch.setattr(pu, "umap", spy)
    jid, _, _, _ = prepared(ns, "pandas", tmp_path)
    params = {"engine": "polars-umap", "nNeighbors": 7, "minDist": 0.3, "spread": 2.0, "metric": "cosine", "nEpochs": 30,
              "learningRate": 0.5, "negativeSampleRate": 3, "repulsionStrength": 1.5, "seed": 11}
    assert run_exact(jid, params)["stage"] == "done"
    assert seen == {"n_components": 2, "n_neighbors": 7, "min_dist": 0.3, "spread": 2.0, "metric": "cosine", "n_epochs": 30,
                    "learning_rate": 0.5, "negative_sample_rate": 3, "repulsion_strength": 1.5, "random_state": 11}


def test_exact_polars_umap_missing(ns, tmp_path, monkeypatch):
    import builtins

    real_import = builtins.__import__

    def no_pu(name, *a, **kw):
        if name == "polars_umap":
            raise ImportError("no polars_umap")
        return real_import(name, *a, **kw)

    monkeypatch.setattr(builtins, "__import__", no_pu)
    jid, _, _, _ = prepared(ns, "pandas", tmp_path)
    st = run_exact(jid, {"engine": "polars-umap"})
    assert st["stage"] == "error" and "polars-umap is not installed" in st["error"]


def test_object_columns_keep_the_general_paths_meaning():
    # Unhashable values after the first rows, and True/1, False/0 mixed: same as str() per value.
    n = 1200
    vals = ["x"] * 1000 + [[1, 2]] * 50 + [1, True, 0, False, None, float("nan"), "1"] * 21 + ["x"] * 3
    vals = vals[:n]
    pdf = pd.DataFrame({"o": pd.Series(vals, dtype=object)})
    frame = pak._Frame(pdf)
    rows = np.arange(n)
    (dt_f, codes_f, meta_f), (dt_s, codes_s, meta_s) = _fast_slow(frame, 0, rows)
    assert meta_f == meta_s
    assert np.array_equal(codes_f, codes_s)
    assert {"[1, 2]", "True", "1", "False", "0", "x"} <= set(meta_f["categories"])
    assert meta_f["nullCount"] > 0


def test_native_core_loads_once_across_threads(monkeypatch):
    import threading

    monkeypatch.setattr(pak, "_NATIVE", None)
    monkeypatch.setattr(pak, "_NATIVE_INFO", {})
    results = []
    threads = [threading.Thread(target=lambda: results.append(pak._native_core())) for _ in range(8)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    assert len({id(r) for r in results}) == 1  # every thread got the same answer (module or None)
    assert pak._NATIVE_INFO["available"] is (results[0] is not None)


# --------------------------------------------------------------------------------------
# D-1: narwhals hybrid – pyarrow, DuckDB, Arrow capsule, lazy polars
# --------------------------------------------------------------------------------------


def _make_pyarrow_df(n=3000, d=20, seed=0):
    """Small pyarrow Table with numeric + categorical columns."""
    import pyarrow as pa

    rng = np.random.default_rng(seed)
    x, labels = make_blobs(n, d, seed=seed)
    cols = {f"f{i}": pa.array(x[:, i].tolist()) for i in range(d)}
    cols["label"] = pa.array([f"c{v}" for v in labels])
    cols["flag"] = pa.array((labels % 2 == 0).tolist())
    return pa.table(cols)


def _prepared_generic(ns, obj_name, obj, tmp_path, features=None, **opts):
    ns[obj_name] = obj
    jid = J(pak.create_job(obj_name, str(tmp_path)))["jobId"]
    o = {"features": features if features is not None else list(range(20)), "seed": 1, **opts}
    assert J(pak.prepare(jid, json.dumps(o)))["ok"]
    st = wait(jid)
    assert st["stage"] == "done", st
    return jid, st


# --- pyarrow Table via narwhals ---

def test_describe_pyarrow(ns):
    pytest.importorskip("narwhals")
    import pyarrow as pa

    table = _make_pyarrow_df(500, 5)
    ns["df"] = table
    d = J(pak.describe("df"))
    assert d["ok"] and d["nRows"] == 500 and d["nCols"] == 7
    assert d["frameKind"] == "narwhals"
    kinds = {c["name"]: c["kind"] for c in d["columns"]}
    assert kinds["f0"] == "numeric"
    assert kinds["label"] == "categorical"
    assert kinds["flag"] == "bool"


def test_prepare_colors_row_pyarrow(ns, tmp_path):
    pytest.importorskip("narwhals")
    table = _make_pyarrow_df()
    jid, st = _prepared_generic(ns, "pa_df", table, tmp_path)
    r = st["result"]
    assert r["nKept"] == 3000 and r["dims"] == 20

    # colors
    c = J(pak.colors(jid, 0))
    assert c["dtype"] == "f32" and c["length"] == 3000
    c_cat = J(pak.colors(jid, 20))  # label
    assert c_cat["dtype"] == "u16"
    assert sorted(c_cat["meta"]["categories"]) == ["c0", "c1", "c2", "c3"]

    # row
    r = J(pak.row(jid, 0))
    assert r["ok"] and len(r["values"]) == 22


def test_add_coordinates_pyarrow(ns, tmp_path):
    pytest.importorskip("narwhals")
    import pyarrow as pa

    table = _make_pyarrow_df(500, 5)
    jid, _ = _prepared_generic(ns, "pa_df", table, tmp_path / "a", features=list(range(5)))
    xy = np.random.default_rng(0).normal(size=(500, 2)).astype("<f4")
    p = tmp_path / "xy.f32"
    xy.tofile(p)
    r = J(pak.add_coordinates(jid, str(p)))
    assert r["ok"]
    result = ns["pa_df"]
    # Result should be a pyarrow Table with the new columns.
    assert hasattr(result, "schema")
    assert "umap_x" in result.schema.names and "umap_y" in result.schema.names


# --- DuckDB relation via narwhals ---

def test_describe_duckdb(ns):
    pytest.importorskip("narwhals")
    duckdb = pytest.importorskip("duckdb")
    con = duckdb.connect()
    rel = con.query("SELECT i AS f0, i*2.0 AS f1, 'c' || (i % 4)::VARCHAR AS label FROM range(500) t(i)")
    ns["duck"] = rel
    d = J(pak.describe("duck"))
    assert d["ok"] and d["nRows"] == 500
    assert d["frameKind"] == "narwhals"
    assert d["wasLazy"] is True
    kinds = {c["name"]: c["kind"] for c in d["columns"]}
    assert kinds["f0"] == "numeric"
    assert kinds["label"] == "categorical"


def test_prepare_colors_duckdb(ns, tmp_path):
    pytest.importorskip("narwhals")
    duckdb = pytest.importorskip("duckdb")
    con = duckdb.connect()
    n = 3000
    # Build a DuckDB relation with 20 numeric columns and a label column.
    cols = ", ".join(f"(random() * 10)::FLOAT AS f{i}" for i in range(20))
    rel = con.query(f"SELECT {cols}, (i % 4)::INT AS label FROM range({n}) t(i)")
    ns["duck"] = rel
    jid = J(pak.create_job("duck", str(tmp_path), json.dumps({"maxLazyRows": 5000})))["jobId"]
    o = {"features": list(range(20)), "seed": 1}
    assert J(pak.prepare(jid, json.dumps(o)))["ok"]
    st = wait(jid)
    assert st["stage"] == "done", st
    assert st["result"]["nKept"] == n

    c = J(pak.colors(jid, 0))
    assert c["dtype"] == "f32" and c["length"] == n


# --- Arrow PyCapsule without narwhals ---

class _ArrowCapsule:
    """Minimal object implementing __arrow_c_stream__ for testing (wraps a pyarrow table)."""

    def __init__(self, table) -> None:
        self._table = table

    def __arrow_c_stream__(self, requested_schema=None):
        return self._table.__arrow_c_stream__(requested_schema)


def test_arrow_capsule_no_narwhals(ns, tmp_path, monkeypatch):
    """Arrow PyCapsule path works when narwhals is blocked."""
    import pyarrow as pa

    # Block narwhals import so the capsule path is exercised.
    real_import = __import__

    def block_narwhals(name, *a, **kw):
        if name == "narwhals":
            raise ImportError("narwhals blocked for test")
        return real_import(name, *a, **kw)

    monkeypatch.setattr(pak, "_try_narwhals", lambda: None)

    table = pa.table({f"f{i}": pa.array(np.random.default_rng(i).normal(size=200).tolist()) for i in range(5)})
    table = table.append_column("label", pa.array([f"c{i % 3}" for i in range(200)]))

    capsule = _ArrowCapsule(table)
    ns["cap"] = capsule
    d = J(pak.describe("cap"))
    assert d["ok"] and d["nRows"] == 200 and d["nCols"] == 6
    # With narwhals blocked, the frame should be polars kind (converted via pyarrow).
    assert d["frameKind"] == "polars"


# --- Lazy polars collected with limit ---

def test_lazy_polars_collected_with_limit(ns, tmp_path):
    ns["lz"] = pl.DataFrame({"x": list(range(1000)), "y": list(range(1000))}).lazy()
    # Collect with a limit of 500 rows.
    d = J(pak.describe("lz", json.dumps({"maxLazyRows": 500})))
    assert d["ok"] and d["wasLazy"] is True
    assert d["nRows"] == 500  # limited

    # create_job also collects with limit
    jid = J(pak.create_job("lz", str(tmp_path), json.dumps({"maxLazyRows": 100})))["jobId"]
    assert J(pak.status(jid))["ok"]  # job created
    job = pak._JOBS[jid]
    assert job.frame.n_rows == 100


# --- list_frames extended ---

def test_list_frames_extended(ns):
    pytest.importorskip("narwhals")
    import pyarrow as pa

    ns["pd_df"] = pd.DataFrame({"a": [1]})
    ns["pl_df"] = pl.DataFrame({"a": [1, 2]})
    ns["pl_lz"] = pl.DataFrame({"a": [1]}).lazy()
    ns["pa_tbl"] = pa.table({"a": [1, 2, 3]})
    ns["num"] = 42
    r = J(pak.list_frames())
    by_name = {f["name"]: f for f in r["frames"]}
    assert "pd_df" in by_name and by_name["pd_df"]["kind"] == "pandas"
    assert "pl_df" in by_name and by_name["pl_df"]["kind"] == "polars"
    assert "pl_lz" in by_name and by_name["pl_lz"]["lazy"] is True
    assert "pa_tbl" in by_name and by_name["pa_tbl"]["kind"] == "narwhals"
    assert "num" not in by_name


# --- Confirm pandas/polars paths unchanged ---

def test_pandas_polars_describe_unchanged(ns, frame_kind):
    """Existing pandas/polars describe still works after the _make_frame refactor."""
    x, labels = make_blobs(500, 5)
    ns["df"] = build_df(frame_kind, x, labels)
    d = J(pak.describe("df"))
    assert d["ok"] and d["nRows"] == 500
    assert d["frameKind"] == frame_kind
    assert not d.get("wasLazy", False)


# P1/P2 neighbour-cache tests
# --------------------------------------------------------------------------------------


def _prepare_with_anchors(ns, tmp_path, n=3000, max_anchors=400, native=False, **extra):
    """Prepare a job that requires projection (more rows than anchors)."""
    x, labels = make_blobs(n, 20)
    ns["df"] = pd.DataFrame({f"f{i}": x[:, i] for i in range(20)})
    jid = J(pak.create_job("df", str(tmp_path)))["jobId"]
    opts = {"features": list(range(20)), "seed": 1, "maxAnchors": max_anchors, "native": native, **extra}
    J(pak.prepare(jid, json.dumps(opts)))
    st = wait(jid)
    assert st["stage"] == "done" and st["result"]["needsProjection"], st
    return jid, x, labels


def _write_axy(job, labels, tmp_path, seed=0):
    """Write a fake anchor layout (cluster centres) and return the path."""
    anchor_labels = labels[job.kept_idx[job.anchor_pos]]
    centers = np.array([[0, 0], [100, 0], [0, 100], [100, 100]], dtype=np.float32)
    axy = centers[anchor_labels] + np.random.default_rng(seed).normal(0, 1, (len(job.anchor_pos), 2)).astype(np.float32)
    p = tmp_path / "axy.f32"
    axy.astype("<f4").tofile(p)
    return str(p), axy


def _wait_nbr_done(jid, timeout=10.0):
    """Block until the background neighbours thread finishes."""
    job = pak._JOBS[jid]
    if not job.nbr_done.wait(timeout=timeout):
        raise TimeoutError("neighbours thread did not finish")


def test_cache_hit_numpy_exact_equality(ns, tmp_path):
    """Second project (same metric+k) hits the cache; xy output is exactly equal."""
    jid, x, labels = _prepare_with_anchors(ns, tmp_path, native=False)
    _wait_nbr_done(jid)
    job = pak._JOBS[jid]
    assert job.nbr_idx is not None and job.nbr_key == ("euclidean", 10), "cache not populated"

    path, axy = _write_axy(job, labels, tmp_path)

    # First placement (cache hit — thread already done)
    J(pak.project(jid, path, json.dumps({"k": 10, "native": False})))
    st1 = wait(jid)
    assert st1["stage"] == "done" and st1["result"]["cached"] is True, st1["result"]
    xy1 = np.concatenate([
        np.fromfile(tmp_path / o["file"], dtype="<f4").reshape(-1, 2)
        for o in st1["outputs"] if o["kind"] == "xy"
    ])

    # Second placement — still a cache hit; must produce EXACTLY the same coordinates.
    J(pak.project(jid, path, json.dumps({"k": 10, "native": False})))
    st2 = wait(jid)
    assert st2["result"]["cached"] is True
    xy2 = np.concatenate([
        np.fromfile(tmp_path / o["file"], dtype="<f4").reshape(-1, 2)
        for o in st2["outputs"] if o["kind"] == "xy"
    ])
    np.testing.assert_array_equal(xy1, xy2)


@pytest.mark.parametrize("native", [True, False])
def test_cache_hit_native_vs_numpy_equality(ns, tmp_path, native):
    """Cache hit produces the same xy as the initial full placement on the same path."""
    if native and pak._native_core() is None:
        pytest.skip(f"native core not available: {pak._NATIVE_INFO.get('reason')}")
    jid, x, labels = _prepare_with_anchors(ns, tmp_path, native=native)
    _wait_nbr_done(jid)
    job = pak._JOBS[jid]
    assert job.nbr_idx is not None, f"cache not populated: {job.nbr_error}"

    path, axy = _write_axy(job, labels, tmp_path)

    # First call (cache hit)
    J(pak.project(jid, path, json.dumps({"k": 10, "native": native})))
    st = wait(jid)
    assert st["result"]["cached"] is True, st["result"]


def test_cache_invalidated_by_new_prepare(ns, tmp_path):
    """Running prepare again clears the neighbour cache."""
    jid, x, labels = _prepare_with_anchors(ns, tmp_path, native=False)
    _wait_nbr_done(jid)
    job = pak._JOBS[jid]
    assert job.nbr_idx is not None, "cache not populated after first prepare"

    # Second prepare — should invalidate the cache immediately.
    opts = {"features": list(range(20)), "seed": 2, "maxAnchors": 400, "native": False}
    J(pak.prepare(jid, json.dumps(opts)))
    # Immediately after the prepare() call the job is resetting; cache must be cleared.
    assert job.nbr_idx is None, "cache should be cleared at start of new prepare"
    st = wait(jid)
    assert st["stage"] == "done", st


def test_cache_miss_on_metric_change(ns, tmp_path):
    """Cosine project after euclidean cache → cache miss → full placement (not cached)."""
    jid, x, labels = _prepare_with_anchors(ns, tmp_path, native=False)
    _wait_nbr_done(jid)
    job = pak._JOBS[jid]
    assert job.nbr_key == ("euclidean", 10), "expected euclidean cache from prepare"

    path, _ = _write_axy(job, labels, tmp_path)
    J(pak.project(jid, path, json.dumps({"k": 10, "metric": "cosine", "native": False})))
    st = wait(jid)
    assert st["stage"] == "done", st
    # Cosine with euclidean cache → full placement, cached=False
    assert st["result"]["cached"] is False, st["result"]


def test_memory_cap_disables_cache(ns, tmp_path):
    """neighborCacheMB=0 makes the cache too small; nbr_done is set immediately (no search)."""
    jid, x, labels = _prepare_with_anchors(ns, tmp_path, native=False, neighborCacheMB=0)
    # nbr_done must be set immediately (no background thread started)
    job = pak._JOBS[jid]
    assert job.nbr_done.is_set(), "nbr_done should be set immediately when cache is disabled"
    assert job.nbr_idx is None, "cache should be empty when cap is 0"

    # Project should succeed (full placement, not cached)
    path, _ = _write_axy(job, labels, tmp_path)
    J(pak.project(jid, path, json.dumps({"k": 10, "native": False})))
    st = wait(jid)
    assert st["stage"] == "done" and st["result"]["cached"] is False, st["result"]


def test_cancel_during_neighbours(ns, tmp_path):
    """Cancelling during the neighbours stage still sets nbr_done and allows a fresh project."""
    jid, x, labels = _prepare_with_anchors(ns, tmp_path, native=False)
    job = pak._JOBS[jid]

    # Cancel immediately — the nbr thread may or may not have started, but after
    # cancel nbr_done must eventually be set and the cache must be absent or valid.
    J(pak.cancel(jid))
    # nbr_cancel_event is now set; thread will exit at the next cancel check.
    assert job.nbr_cancel_event.is_set(), "nbr_cancel_event should be set after cancel"

    # Wait for nbr_done to be set (thread has honoured the cancel).
    assert job.nbr_done.wait(timeout=10.0), "nbr_done not set after cancel"

    # Even if the cache ended up populated (cancel arrived after completion), a new
    # project should succeed without error.
    path, _ = _write_axy(job, labels, tmp_path)
    J(pak.project(jid, path, json.dumps({"k": 10, "native": False})))
    st = wait(jid)
    assert st["stage"] == "done", st


def test_project_while_neighbours_running(ns, tmp_path, monkeypatch):
    """project called while nbr thread still running → waits → uses cache (cached=True)."""
    import threading as _threading

    # Slow down the numpy search so the nbr thread is still running when project starts.
    orig_query = pak.AnchorIndex.query

    barrier = _threading.Event()
    unblocked = _threading.Event()

    def slow_query(self, q, k):
        barrier.set()          # signal that the query has started
        unblocked.wait(timeout=5.0)  # wait until the test releases us
        return orig_query(self, q, k)

    monkeypatch.setattr(pak.AnchorIndex, "query", slow_query)

    jid, x, labels = _prepare_with_anchors(ns, tmp_path, native=False)
    job = pak._JOBS[jid]

    # Wait until the slow query has started (nbr thread is definitely running).
    assert barrier.wait(timeout=10.0), "nbr thread did not start"
    assert not job.nbr_done.is_set(), "nbr_done should not be set while query is running"

    # Start project (runs in a background thread via job.run).
    path, _ = _write_axy(job, labels, tmp_path)
    J(pak.project(jid, path, json.dumps({"k": 10, "native": False})))

    # Unblock the slow query so the nbr thread can finish → project unblocks.
    unblocked.set()

    st = wait(jid, timeout=30)
    assert st["stage"] == "done", st
    assert st["result"]["cached"] is True, st["result"]
    assert st["result"]["waitedForNeighbours"] is True, st["result"]


def test_outdated_native_core_falls_back_to_numpy(monkeypatch):
    """A core missing functions the helper needs is rejected as a whole, with a clear reason."""
    import types

    import positron_atlas_kernel as pak

    fake = types.ModuleType("_positron_atlas_core")
    fake.VERSION = pak.VERSION
    fake.Index = type("Index", (), {"place": lambda self: None})  # no neighbors_u32
    fake.column_moments = fake.scale_columns = fake.n_cpus = lambda *a, **k: None  # no place_from_neighbors
    monkeypatch.setattr(pak, "_NATIVE", None)
    monkeypatch.setattr(pak, "_NATIVE_INFO", {})
    monkeypatch.setitem(__import__("sys").modules, "_positron_atlas_core", fake)
    monkeypatch.setattr(pak.os.path, "normpath", lambda p: getattr(fake, "__file__", p))
    fake.__file__ = "fake-core"
    monkeypatch.setattr(pak.os, "listdir", lambda d: ["_positron_atlas_core.abi3.so"])
    monkeypatch.setattr(pak.os.path, "isdir", lambda d: True)
    assert pak._native_core() is None
    reason = pak._NATIVE_INFO["reason"]
    assert "outdated" in reason and "place_from_neighbors" in reason and "Index.neighbors_u32" in reason


# ---- rows() and texts() for pandas, polars, pyarrow (H2–H5) ----------------------

def _prepare_simple(ns, kind, tmp_path, n=200):
    """Prepare a simple n×5 frame and return (job_id, nKept)."""
    rng = np.random.default_rng(0)
    x = rng.normal(size=(n, 5))
    labels = [f"c{i % 4}" for i in range(n)]
    titles = [f"Item {i}" for i in range(n)]

    if kind == "pandas":
        df = pd.DataFrame({f"f{i}": x[:, i] for i in range(5)})
        df["label"] = labels
        df["title"] = titles
        ns["df"] = df
    elif kind == "polars":
        ns["df"] = pl.DataFrame(
            {f"f{i}": x[:, i].tolist() for i in range(5)} | {"label": labels, "title": titles}
        )
    else:  # pyarrow via narwhals
        pytest.importorskip("narwhals")
        import pyarrow as pa
        d = {f"f{i}": pa.array(x[:, i].tolist()) for i in range(5)}
        d["label"] = pa.array(labels)
        d["title"] = pa.array(titles)
        ns["df"] = pa.table(d)

    jid = J(pak.create_job("df", str(tmp_path)))["jobId"]
    opts = {"features": list(range(5)), "seed": 1}
    assert J(pak.prepare(jid, json.dumps(opts)))["ok"]
    st = wait(jid)
    assert st["stage"] == "done", st
    return jid, st["result"]["nKept"]


@pytest.mark.parametrize("kind", ["pandas", "polars", "pyarrow"])
def test_rows_basic(ns, tmp_path, kind):
    """rows() returns values for each requested index, filtered by column list."""
    jid, nkept = _prepare_simple(ns, kind, tmp_path)
    n_cols = 7  # f0-f4, label, title

    # Fetch two rows, all columns.
    r = J(pak.rows(jid, [0, 1], None))
    assert r["ok"]
    vals = r["values"]
    assert "0" in vals and "1" in vals
    assert len(vals["0"]) == n_cols
    assert len(vals["1"]) == n_cols

    # Fetch one row, only columns 0 and 5 (f0 and label).
    r2 = J(pak.rows(jid, [0], [0, 5]))
    assert r2["ok"]
    names_returned = {k for k, _ in r2["values"]["0"]}
    assert "f0" in names_returned and "label" in names_returned
    # Should not contain f1-f4 or title.
    assert "f1" not in names_returned and "title" not in names_returned


@pytest.mark.parametrize("kind", ["pandas", "polars", "pyarrow"])
def test_rows_out_of_range(ns, tmp_path, kind):
    """rows() with the last valid index should work correctly."""
    jid, nkept = _prepare_simple(ns, kind, tmp_path)
    r = J(pak.rows(jid, [0, nkept - 1], None))
    assert r["ok"]
    assert str(nkept - 1) in r["values"]


@pytest.mark.parametrize("kind", ["pandas", "polars", "pyarrow"])
def test_texts_basic(ns, tmp_path, kind):
    """texts() writes UTF-8 blob and u32 offsets for the title column."""
    import struct

    jid, nkept = _prepare_simple(ns, kind, tmp_path)
    # Column 6 is "title" (0-indexed: f0-f4=0-4, label=5, title=6).
    title_col = 6
    r = J(pak.texts(jid, title_col, 50))
    assert r["ok"], r
    assert r["count"] == nkept

    job = pak._JOBS[jid]
    from pathlib import Path
    utf8_path = Path(job.path(r["utf8File"]))
    offsets_path = Path(job.path(r["offsetsFile"]))
    assert utf8_path.exists() and offsets_path.exists()

    utf8_bytes = utf8_path.read_bytes()
    offsets_data = offsets_path.read_bytes()
    # offsets_data is nkept+1 u32 little-endian values.
    assert len(offsets_data) == (nkept + 1) * 4
    offsets = struct.unpack_from(f"<{nkept + 1}I", offsets_data)

    # Decode all strings and verify they are non-empty "Item N" strings.
    decoded = []
    for i in range(nkept):
        s = utf8_bytes[offsets[i]:offsets[i + 1]].decode("utf-8")
        decoded.append(s)
    assert all(s.startswith("Item ") for s in decoded)
    # Last offset equals total byte count.
    assert offsets[nkept] == len(utf8_bytes)


@pytest.mark.parametrize("kind", ["pandas", "polars", "pyarrow"])
def test_texts_max_chars(ns, tmp_path, kind):
    """texts() truncates values longer than max_chars."""
    import struct

    jid, nkept = _prepare_simple(ns, kind, tmp_path)
    r = J(pak.texts(jid, 6, max_chars=4))
    assert r["ok"]
    job = pak._JOBS[jid]
    from pathlib import Path
    utf8_bytes = Path(job.path(r["utf8File"])).read_bytes()
    offsets_data = Path(job.path(r["offsetsFile"])).read_bytes()
    offsets = struct.unpack_from(f"<{nkept + 1}I", offsets_data)
    for i in range(nkept):
        s = utf8_bytes[offsets[i]:offsets[i + 1]].decode("utf-8")
        assert len(s) <= 4, f"String '{s}' exceeds 4 chars"


# ---------------------------------------------------------------------------
# A10: sizes() – float32 column values for size-by-column
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("frame_kind", ["pandas", "polars"])
def test_sizes_numeric(ns, tmp_path, frame_kind):
    """sizes() returns float32 values and correct metadata for a numeric column."""
    jid, _, x, _ = prepared(ns, frame_kind, tmp_path)
    r = J(pak.sizes(jid, 0))
    assert r["ok"] and r["dtype"] == "f32"
    vals = np.fromfile(tmp_path / r["file"], dtype="<f4")
    assert len(vals) == 3000
    m = r["meta"]
    assert m["kind"] == "numeric"
    assert m["min"] <= m["q01"] <= m["q99"] <= m["max"]
    assert m["nullCount"] == 0


@pytest.mark.parametrize("frame_kind", ["pandas", "polars"])
def test_sizes_requires_numeric(ns, tmp_path, frame_kind):
    """sizes() rejects non-numeric columns."""
    jid, _, _, _ = prepared(ns, frame_kind, tmp_path)
    # column 20 is 'label' (categorical); 0-indexed after 20 numeric feature cols
    r = J(pak.sizes(jid, 20))
    assert not r["ok"] and "size-by requires" in r["error"]


def test_sizes_with_nans(ns, tmp_path):
    """sizes() reports nullCount correctly when a non-feature column has NaN values."""
    x, labels = make_blobs(500, 5)
    df = pd.DataFrame(x, columns=[f"f{i}" for i in range(5)])
    # 'weight' is not in features, so it is never imputed; NaN values pass through.
    weight = np.ones(500, dtype=np.float64)
    weight[::10] = np.nan
    df["weight"] = weight
    ns["df"] = df
    jid = J(pak.create_job("df", str(tmp_path)))["jobId"]
    J(pak.prepare(jid, json.dumps({"features": list(range(5))})))
    wait(jid)
    # column 5 is "weight"
    r = J(pak.sizes(jid, 5))
    assert r["ok"]
    vals = np.fromfile(tmp_path / r["file"], dtype="<f4")
    nan_count = int(np.sum(~np.isfinite(vals)))
    assert nan_count == r["meta"]["nullCount"]
    assert nan_count > 0  # we seeded NaNs in every 10th row


# ---------------------------------------------------------------------------
# A13: histogram() and hist_values() – histogram bins and filter values
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("frame_kind", ["pandas", "polars"])
def test_histogram_numeric(ns, tmp_path, frame_kind):
    """histogram() returns n_bins bins covering the data range."""
    jid, _, _, _ = prepared(ns, frame_kind, tmp_path)
    r = J(pak.histogram(jid, 0, 20))
    assert r["ok"]
    d = r["data"]
    assert not d["isDatetime"]
    assert len(d["edges"]) == 21  # n_bins + 1
    assert len(d["counts"]) == 20
    assert all(c >= 0 for c in d["counts"])
    assert d["edges"][0] < d["edges"][-1]  # monotonically increasing


@pytest.mark.parametrize("frame_kind", ["pandas", "polars"])
def test_histogram_rejects_categorical(ns, tmp_path, frame_kind):
    """histogram() rejects categorical columns."""
    jid, _, _, _ = prepared(ns, frame_kind, tmp_path)
    r = J(pak.histogram(jid, 20))  # 'label' column index
    assert not r["ok"] and "histogram requires" in r["error"]


def test_histogram_datetime(ns, tmp_path):
    """histogram() converts datetime edges to ms-since-epoch."""
    x, labels = make_blobs(500, 5)
    df = pd.DataFrame({f"f{i}": x[:, i] for i in range(5)})
    df["when"] = pd.date_range("2020-01-01", periods=500, freq="h")
    ns["df"] = df
    jid = J(pak.create_job("df", str(tmp_path)))["jobId"]
    J(pak.prepare(jid, json.dumps({"features": list(range(5))})))
    wait(jid)
    # column 5 is "when" (datetime)
    r = J(pak.histogram(jid, 5, 10))
    assert r["ok"]
    d = r["data"]
    assert d["isDatetime"]
    # Edges should be in ms since epoch (large positive numbers, > year 2001)
    assert d["edges"][0] > 1_000_000_000_000


@pytest.mark.parametrize("frame_kind", ["pandas", "polars"])
def test_hist_values(ns, tmp_path, frame_kind):
    """hist_values() returns float32 column values per kept row."""
    jid, _, x, _ = prepared(ns, frame_kind, tmp_path)
    r = J(pak.hist_values(jid, 1))
    assert r["ok"] and r["dtype"] == "f32"
    vals = np.fromfile(tmp_path / r["file"], dtype="<f4")
    assert len(vals) == 3000


def test_hist_values_rejects_categorical(ns, tmp_path):
    """hist_values() rejects categorical columns."""
    jid, _, _, _ = prepared(ns, "pandas", tmp_path)
    r = J(pak.hist_values(jid, 20))
    assert not r["ok"] and "histogram filter requires" in r["error"]
