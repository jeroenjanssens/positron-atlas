"""Tests for the 'layout from precomputed columns' (coords mode) prepare path."""

import json
import time

import numpy as np
import pandas as pd
import polars as pl
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
    raise TimeoutError(f"Job did not finish: {st}")


@pytest.fixture
def ns(monkeypatch):
    space = {}
    monkeypatch.setattr(pak, "_user_ns", lambda: space)
    return space


def _prepare_coords(ns, var, x_col, y_col, tmp_path, z_col=None, sample_pct=100.0, nan_policy="drop"):
    job_id = J(pak.create_job(var, str(tmp_path)))["jobId"]
    cc = {"x": x_col, "y": y_col}
    if z_col is not None:
        cc["z"] = z_col
    opts = {
        "features": [],
        "samplePct": sample_pct,
        "standardize": False,
        "pca": False,
        "pcaDims": 50,
        "nanPolicy": nan_policy,
        "seed": 42,
        "maxAnchors": 50000,
        "anchorBudget": 1e7,
        "coordsColumns": cc,
    }
    r = J(pak.prepare(job_id, json.dumps(opts)))
    assert r["ok"], r
    st = wait(job_id)
    assert st["stage"] == "done", st.get("error", st)
    return job_id, st


# ---------------------------------------------------------------------------
# Pandas tests
# ---------------------------------------------------------------------------

def test_coords_2d_pandas(ns, tmp_path):
    n = 200
    df = pd.DataFrame({"umap_x": np.linspace(0, 1, n), "umap_y": np.linspace(1, 2, n), "cat": ["a"] * n})
    ns["df"] = df
    d = J(pak.describe("df"))
    name_to_idx = {c["name"]: c["index"] for c in d["columns"]}
    job_id, st = _prepare_coords(ns, "df", name_to_idx["umap_x"], name_to_idx["umap_y"], tmp_path)

    result = st["result"]
    assert result["coordsMode"] is True
    assert result["nKept"] == n
    assert result["nDropped"] == 0
    assert result["dims"] == 2
    assert result["needsProjection"] is False
    assert result["nAnchors"] == n

    # Verify xy chunks were written
    outputs = st["outputs"]
    xy_outputs = [o for o in outputs if o["kind"] == "xy"]
    assert len(xy_outputs) > 0


def test_coords_3d_pandas(ns, tmp_path):
    n = 150
    df = pd.DataFrame({
        "pc1": np.random.default_rng(0).normal(size=n),
        "pc2": np.random.default_rng(1).normal(size=n),
        "pc3": np.random.default_rng(2).normal(size=n),
        "value": np.arange(n, dtype=float),
    })
    ns["df3d"] = df
    d = J(pak.describe("df3d"))
    name_to_idx = {c["name"]: c["index"] for c in d["columns"]}
    job_id, st = _prepare_coords(
        ns, "df3d",
        name_to_idx["pc1"], name_to_idx["pc2"], tmp_path,
        z_col=name_to_idx["pc3"],
    )
    result = st["result"]
    assert result["coordsMode"] is True
    assert result["dims"] == 3
    assert result["nKept"] == n


def test_coords_nan_drop_pandas(ns, tmp_path):
    n = 100
    rng = np.random.default_rng(42)
    x = rng.normal(size=n).astype(float)
    y = rng.normal(size=n).astype(float)
    # Introduce 10 NaNs in x
    nan_rows = rng.choice(n, 10, replace=False)
    x[nan_rows] = np.nan

    df = pd.DataFrame({"x": x, "y": y})
    ns["df_nan"] = df
    d = J(pak.describe("df_nan"))
    name_to_idx = {c["name"]: c["index"] for c in d["columns"]}
    job_id, st = _prepare_coords(ns, "df_nan", name_to_idx["x"], name_to_idx["y"], tmp_path)

    result = st["result"]
    assert result["nDropped"] == 10
    assert result["nKept"] == n - 10


def test_coords_nan_drop_even_when_policy_impute_pandas(ns, tmp_path):
    """NaN in coord columns must be dropped even when nanPolicy='impute'."""
    n = 50
    x = np.ones(n, dtype=float)
    y = np.ones(n, dtype=float)
    x[0] = np.nan  # one NaN in x

    df = pd.DataFrame({"x": x, "y": y})
    ns["df_impute"] = df
    d = J(pak.describe("df_impute"))
    name_to_idx = {c["name"]: c["index"] for c in d["columns"]}
    job_id, st = _prepare_coords(
        ns, "df_impute", name_to_idx["x"], name_to_idx["y"], tmp_path,
        nan_policy="impute",
    )
    result = st["result"]
    assert result["nDropped"] == 1
    assert result["nKept"] == n - 1


def test_coords_datetime_column_pandas(ns, tmp_path):
    """Datetime columns are accepted and converted to float."""
    n = 100
    df = pd.DataFrame({
        "ts": pd.date_range("2020-01-01", periods=n, freq="h"),
        "y":  np.linspace(0, 1, n),
    })
    ns["df_dt"] = df
    d = J(pak.describe("df_dt"))
    name_to_idx = {c["name"]: c["index"] for c in d["columns"]}
    job_id, st = _prepare_coords(ns, "df_dt", name_to_idx["ts"], name_to_idx["y"], tmp_path)
    result = st["result"]
    assert result["coordsMode"] is True
    assert result["nKept"] == n


# ---------------------------------------------------------------------------
# Polars tests
# ---------------------------------------------------------------------------

def test_coords_2d_polars(ns, tmp_path):
    n = 200
    df = pl.DataFrame({
        "umap_x": np.linspace(0, 1, n).tolist(),
        "umap_y": np.linspace(1, 2, n).tolist(),
        "cat": ["a"] * n,
    })
    ns["pl_df"] = df
    d = J(pak.describe("pl_df"))
    name_to_idx = {c["name"]: c["index"] for c in d["columns"]}
    job_id, st = _prepare_coords(ns, "pl_df", name_to_idx["umap_x"], name_to_idx["umap_y"], tmp_path)

    result = st["result"]
    assert result["coordsMode"] is True
    assert result["nKept"] == n
    assert result["dims"] == 2


def test_coords_3d_polars(ns, tmp_path):
    n = 120
    rng = np.random.default_rng(7)
    df = pl.DataFrame({
        "x": rng.normal(size=n).tolist(),
        "y": rng.normal(size=n).tolist(),
        "z": rng.normal(size=n).tolist(),
    })
    ns["pl_3d"] = df
    d = J(pak.describe("pl_3d"))
    name_to_idx = {c["name"]: c["index"] for c in d["columns"]}
    job_id, st = _prepare_coords(
        ns, "pl_3d",
        name_to_idx["x"], name_to_idx["y"], tmp_path,
        z_col=name_to_idx["z"],
    )
    result = st["result"]
    assert result["dims"] == 3
    assert result["nKept"] == n


def test_coords_nan_drop_polars(ns, tmp_path):
    n = 80
    x = np.linspace(0, 1, n)
    y = np.linspace(0, 1, n)
    x[5] = float("nan")
    x[10] = float("nan")
    df = pl.DataFrame({"x": x.tolist(), "y": y.tolist()})
    ns["pl_nan"] = df
    d = J(pak.describe("pl_nan"))
    name_to_idx = {c["name"]: c["index"] for c in d["columns"]}
    job_id, st = _prepare_coords(ns, "pl_nan", name_to_idx["x"], name_to_idx["y"], tmp_path)
    result = st["result"]
    assert result["nDropped"] == 2
    assert result["nKept"] == n - 2


# ---------------------------------------------------------------------------
# PyArrow tests
# ---------------------------------------------------------------------------

def test_coords_2d_pyarrow(ns, tmp_path):
    try:
        import pyarrow as pa
    except ImportError:
        pytest.skip("pyarrow not installed")

    n = 100
    table = pa.table({
        "umap_x": np.linspace(0, 1, n).tolist(),
        "umap_y": np.linspace(0, 1, n).tolist(),
        "feat": np.arange(n, dtype=float).tolist(),
    })
    ns["pa_df"] = table
    d = J(pak.describe("pa_df"))
    name_to_idx = {c["name"]: c["index"] for c in d["columns"]}
    job_id, st = _prepare_coords(ns, "pa_df", name_to_idx["umap_x"], name_to_idx["umap_y"], tmp_path)
    result = st["result"]
    assert result["coordsMode"] is True
    assert result["nKept"] == n


# ---------------------------------------------------------------------------
# Features in coords mode
# ---------------------------------------------------------------------------

def test_coords_other_numeric_become_features(ns, tmp_path):
    """Other numeric columns are stored for compare/describe_groups."""
    n = 200
    df = pd.DataFrame({
        "x": np.linspace(0, 1, n),
        "y": np.linspace(0, 1, n),
        "score": np.random.default_rng(0).normal(size=n),
        "count": np.arange(n, dtype=float),
        "label": ["a"] * n,
    })
    ns["df_feat"] = df
    d = J(pak.describe("df_feat"))
    name_to_idx = {c["name"]: c["index"] for c in d["columns"]}
    job_id, st = _prepare_coords(ns, "df_feat", name_to_idx["x"], name_to_idx["y"], tmp_path)

    result = st["result"]
    assert result["coordsMode"] is True
    assert result["nKept"] == n
    # featuresBytes > 0 because score and count columns were stored
    assert result["featuresBytes"] > 0


def test_coords_no_extra_features(ns, tmp_path):
    """When only the coordinate columns exist, features is empty but prepare succeeds."""
    n = 50
    df = pd.DataFrame({"x": np.ones(n), "y": np.ones(n)})
    ns["df_min"] = df
    d = J(pak.describe("df_min"))
    name_to_idx = {c["name"]: c["index"] for c in d["columns"]}
    job_id, st = _prepare_coords(ns, "df_min", name_to_idx["x"], name_to_idx["y"], tmp_path)
    result = st["result"]
    assert result["coordsMode"] is True
    assert result["nKept"] == n


# ---------------------------------------------------------------------------
# Sampling in coords mode
# ---------------------------------------------------------------------------

def test_coords_sampling(ns, tmp_path):
    """Sample % is applied before reading coordinates."""
    n = 1000
    df = pd.DataFrame({"x": np.arange(n, dtype=float), "y": np.arange(n, dtype=float)})
    ns["df_samp"] = df
    d = J(pak.describe("df_samp"))
    name_to_idx = {c["name"]: c["index"] for c in d["columns"]}
    job_id, st = _prepare_coords(
        ns, "df_samp", name_to_idx["x"], name_to_idx["y"], tmp_path,
        sample_pct=50.0,
    )
    result = st["result"]
    assert result["coordsMode"] is True
    # Roughly 50% sampled (may vary slightly by rounding)
    assert 400 <= result["nSampled"] <= 600
