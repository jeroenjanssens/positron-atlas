"""
B3 overlay projection tests: prepare_overlay + project_overlay.

Coverage:
- Transforms applied to overlay rows are identical to those applied to
  base rows with the same values (standardize + optional PCA).
- Overlay rows that equal base rows land at the same XY positions.
- Missing-column errors are reported clearly.
- Wrong variable-name errors are reported clearly.
"""

import json
import time

import numpy as np
import pandas as pd
import pytest

import positron_atlas_kernel as pak


def J(s):
    return json.loads(s)


def wait(job_id, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = J(pak.status(job_id))
        if st["stage"] in ("done", "error", "cancelled"):
            return st
        time.sleep(0.01)
    raise TimeoutError(st)


@pytest.fixture
def ns(monkeypatch):
    space = {}
    monkeypatch.setattr(pak, "_user_ns", lambda: space)
    return space


def make_blobs(n=500, d=10, k=4, seed=42):
    rng = np.random.default_rng(seed)
    centers = rng.normal(0, 10, size=(k, d))
    labels = rng.integers(0, k, size=n)
    x = centers[labels] + rng.normal(0, 1, size=(n, d))
    return x.astype(np.float64), labels


def pandas_df(x, name_prefix="f"):
    return pd.DataFrame({f"{name_prefix}{i}": x[:, i] for i in range(x.shape[1])})


def _do_prepare(ns, tmp_path, x, **opts):
    """Helper: put a DataFrame in ns, create a job, run prepare, wait."""
    ns["df"] = pandas_df(x)
    jid = J(pak.create_job("df", str(tmp_path)))["jobId"]
    o = {"features": list(range(x.shape[1])), "seed": 1, **opts}
    assert J(pak.prepare(jid, json.dumps(o)))["ok"], "prepare call failed"
    st = wait(jid)
    assert st["stage"] == "done", f"prepare failed: {st}"
    return jid, st


def _fake_anchor_xy(jid, nd=2, seed=0):
    """Produce a small random anchor XY array in the right shape."""
    job = pak._JOBS[jid]
    n_anchors = len(job.anchor_pos)
    rng = np.random.default_rng(seed)
    return rng.normal(0, 100, size=(n_anchors, nd)).astype(np.float32)


def _write_anchor_xy(tmp_path, jid, nd=2):
    axy = _fake_anchor_xy(jid, nd)
    path = tmp_path / "axy.f32"
    axy.astype("<f4").tofile(path)
    return str(path), axy


# ---------------------------------------------------------------------------
# Prepare-transform tests
# ---------------------------------------------------------------------------

def test_overlay_transforms_match_base(ns, tmp_path):
    """Rows from the base and overlay are identically transformed (standardize)."""
    x, _ = make_blobs(300, 8)
    jid, _ = _do_prepare(ns, tmp_path, x)
    job = pak._JOBS[jid]

    # Create an overlay with the same data (should produce identical features).
    ns["ov"] = pandas_df(x)
    r = J(pak.prepare_overlay(jid, "ov", "lay0"))
    assert r["ok"], r.get("error")
    st = wait(jid)
    assert st["stage"] == "done", st

    ov = job.overlays["lay0"]
    # Base features have been standardized; overlay should have the same values
    # for the same input rows, via the stored scale_mean/scale_inv.
    np.testing.assert_allclose(job.features[job.kept_idx.argsort()], ov.features, atol=1e-4)


def test_overlay_pca_transforms_match_base(ns, tmp_path):
    """Overlay and base use the same PCA projection when prepare used PCA."""
    x, _ = make_blobs(400, 20)
    jid, _ = _do_prepare(ns, tmp_path, x, pca=True, pcaDims=5)
    job = pak._JOBS[jid]

    ns["ov"] = pandas_df(x)
    r = J(pak.prepare_overlay(jid, "ov", "lay0"))
    assert r["ok"], r.get("error")
    st = wait(jid)
    assert st["stage"] == "done", st

    ov = job.overlays["lay0"]
    assert ov.features.shape[1] == 5, "overlay should have 5 PCA dims"
    np.testing.assert_allclose(job.features[job.kept_idx.argsort()], ov.features, atol=1e-3)


# ---------------------------------------------------------------------------
# Placement tests
# ---------------------------------------------------------------------------

def test_overlay_base_rows_land_same_position(ns, tmp_path):
    """An overlay of base rows lands near the base map positions.

    Uses a cluster structure so that overlay rows land in the same cluster
    as the base rows they come from.  Placement is approximate (k-NN weighted
    mean) so we check cluster membership rather than exact coordinates.
    """
    x, labels = make_blobs(400, 8, k=4)
    # Allow all rows to be anchors for deterministic placement.
    jid, _ = _do_prepare(ns, tmp_path, x, maxAnchors=400)
    job = pak._JOBS[jid]

    # Build a cluster-structured anchor XY: cluster c → center at (c*50, 0).
    anchor_labels = labels[job.kept_idx[job.anchor_pos]]
    centers = np.array([[c * 50.0, 0.0] for c in range(4)], dtype=np.float32)
    axy = centers[anchor_labels] + np.random.default_rng(99).normal(0, 1, (len(job.anchor_pos), 2)).astype(np.float32)
    axy_path = str(tmp_path / "axy.f32")
    axy.astype("<f4").tofile(axy_path)

    # Base project.
    r = J(pak.project(jid, axy_path))
    assert r["ok"]
    st = wait(jid)
    assert st["stage"] == "done", st

    # Prepare + project overlay with the SAME data.
    ns["ov"] = pandas_df(x)
    r = J(pak.prepare_overlay(jid, "ov", "lay0"))
    assert r["ok"]
    st = wait(jid)
    assert st["stage"] == "done", st

    r = J(pak.project_overlay(jid, "lay0", axy_path))
    assert r["ok"]
    st = wait(jid)
    assert st["stage"] == "done", st

    overlay_xy_files = [o for o in st["outputs"] if o["kind"] == "overlayXy" and o.get("layerId") == "lay0"]
    assert len(overlay_xy_files) > 0, f"no overlayXy outputs; got {st['outputs']}"
    ov_xy = np.concatenate([
        np.fromfile(tmp_path / f["file"], dtype="<f4").reshape(-1, 2)
        for f in overlay_xy_files
    ])

    # Each overlay row should land in the correct cluster (within 10 units of its center).
    expected_centers = centers[labels[job.kept_idx]]
    dist_to_expected = np.linalg.norm(ov_xy - expected_centers, axis=1)
    assert np.mean(dist_to_expected < 10) > 0.95, f"bad placement: mean dist={dist_to_expected.mean():.2f}"


# ---------------------------------------------------------------------------
# Error handling tests
# ---------------------------------------------------------------------------

def test_prepare_overlay_missing_columns(ns, tmp_path):
    """prepare_overlay raises a clear ValueError when feature columns are missing."""
    x, _ = make_blobs(100, 8)
    jid, _ = _do_prepare(ns, tmp_path, x)

    # Overlay has only 4 of the 8 required feature columns.
    ns["ov"] = pd.DataFrame({f"f{i}": x[:, i] for i in range(4)})
    r = J(pak.prepare_overlay(jid, "ov", "lay_missing"))
    assert not r["ok"], "should fail with missing columns"
    assert "missing" in r["error"].lower() or "feature column" in r["error"].lower(), r["error"]


def test_prepare_overlay_unknown_variable(ns, tmp_path):
    """prepare_overlay gives a clear error for a variable that does not exist."""
    x, _ = make_blobs(100, 4)
    jid, _ = _do_prepare(ns, tmp_path, x)
    r = J(pak.prepare_overlay(jid, "no_such_df", "lay0"))
    assert not r["ok"], "should fail for unknown variable"


def test_prepare_overlay_before_prepare(ns, tmp_path):
    """prepare_overlay fails gracefully when called before base prepare."""
    x, _ = make_blobs(50, 4)
    ns["df"] = pandas_df(x)
    jid = J(pak.create_job("df", str(tmp_path)))["jobId"]
    # No prepare run yet — feature_names is None.
    ns["ov"] = pandas_df(x)
    r = J(pak.prepare_overlay(jid, "ov", "lay0"))
    assert not r["ok"]
    assert "prepare" in r["error"].lower(), r["error"]


def test_project_overlay_before_prepare_overlay(ns, tmp_path):
    """project_overlay fails gracefully when overlay was never prepared."""
    x, _ = make_blobs(50, 4)
    jid, _ = _do_prepare(ns, tmp_path, x, maxAnchors=50)
    axy_path, _ = _write_anchor_xy(tmp_path, jid)
    r = J(pak.project_overlay(jid, "lay_nonexistent", axy_path))
    assert not r["ok"]


# ---------------------------------------------------------------------------
# Remove overlay
# ---------------------------------------------------------------------------

def test_remove_overlay(ns, tmp_path):
    """remove_overlay cleans up and returns removed=True."""
    x, _ = make_blobs(100, 4)
    jid, _ = _do_prepare(ns, tmp_path, x)

    ns["ov"] = pandas_df(x)
    r = J(pak.prepare_overlay(jid, "ov", "layA"))
    assert r["ok"]
    wait(jid)

    job = pak._JOBS[jid]
    assert "layA" in job.overlays

    r = J(pak.remove_overlay(jid, "layA"))
    assert r["ok"] and r["removed"] is True
    assert "layA" not in job.overlays

    # Calling again returns removed=False (idempotent).
    r = J(pak.remove_overlay(jid, "layA"))
    assert r["ok"] and r["removed"] is False


# ---------------------------------------------------------------------------
# Overlay nKept in result
# ---------------------------------------------------------------------------

def test_prepare_overlay_result_fields(ns, tmp_path):
    """overlayPrepared result includes nRows, nKept, dims, layerId."""
    x, _ = make_blobs(200, 6)
    jid, _ = _do_prepare(ns, tmp_path, x)

    ns["ov"] = pandas_df(x)
    r = J(pak.prepare_overlay(jid, "ov", "layB"))
    assert r["ok"]
    st = wait(jid)
    assert st["stage"] == "done"
    res = st["result"]
    assert res["layerId"] == "layB"
    assert res["nRows"] == 200
    assert res["nKept"] == 200
    assert res["dims"] == 6  # no PCA


# ---------------------------------------------------------------------------
# overlay_rows — hover row-value fetching
# ---------------------------------------------------------------------------

def _prepare_and_project_overlay(ns, tmp_path, x):
    """Helper: prepare base + overlay and project overlay; returns jid, layer_id."""
    jid, _ = _do_prepare(ns, tmp_path, x)
    xy_path, _ = _write_anchor_xy(tmp_path, jid)
    ns["ov"] = pandas_df(x[:100])
    layer_id = "hover-lay"
    r = J(pak.prepare_overlay(jid, "ov", layer_id))
    assert r["ok"], r.get("error")
    wait(jid)
    rp = J(pak.project_overlay(jid, layer_id, xy_path, '{"metric":"euclidean","seed":0}'))
    assert rp["ok"], rp.get("error")
    wait(jid)
    return jid, layer_id


def test_overlay_rows_basic(ns, tmp_path):
    """overlay_rows returns values for given position indices."""
    x, _ = make_blobs(200, 6)
    jid, layer_id = _prepare_and_project_overlay(ns, tmp_path, x)

    r = J(pak.overlay_rows(jid, layer_id, [0, 1, 2]))
    assert r["ok"], r.get("error")
    assert "values" in r
    # Three rows requested, three returned.
    assert set(int(k) for k in r["values"].keys()) == {0, 1, 2}
    # Each row is a list of (name, value) pairs.
    for vals in r["values"].values():
        assert isinstance(vals, list)
        assert all(isinstance(pair, list) and len(pair) == 2 for pair in vals)


def test_overlay_rows_column_names(ns, tmp_path):
    """Returned column names match the overlay DataFrame column names."""
    x, _ = make_blobs(200, 6)
    jid, layer_id = _prepare_and_project_overlay(ns, tmp_path, x)

    r = J(pak.overlay_rows(jid, layer_id, [0]))
    assert r["ok"]
    names = [pair[0] for pair in r["values"]["0"]]
    df = ns["ov"]
    assert names == list(df.columns), f"expected {list(df.columns)}, got {names}"


def test_overlay_rows_unknown_layer(ns, tmp_path):
    """overlay_rows returns ok=False for an unknown layer id."""
    x, _ = make_blobs(100, 6)
    jid, _ = _do_prepare(ns, tmp_path, x)

    r = J(pak.overlay_rows(jid, "nonexistent-layer", [0]))
    assert not r["ok"]
    assert "error" in r


def test_overlay_rows_out_of_bounds(ns, tmp_path):
    """Out-of-bounds position indices are silently skipped."""
    x, _ = make_blobs(200, 6)
    jid, layer_id = _prepare_and_project_overlay(ns, tmp_path, x)

    overlay = pak._JOBS[jid].overlays[layer_id]
    n_kept = len(overlay.kept_idx)
    # Indices: one valid, one out-of-bounds.
    r = J(pak.overlay_rows(jid, layer_id, [0, n_kept + 999]))
    assert r["ok"]
    # Only the in-bounds index returns values.
    assert "0" in r["values"]
    assert str(n_kept + 999) not in r["values"]
