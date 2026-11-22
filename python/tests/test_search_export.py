"""Tests for search() and export_datamapplot() kernel functions (A7, D3/D12)."""
from __future__ import annotations

import json
import sys
import types

import numpy as np
import pandas as pd
import polars as pl
import pytest

import positron_atlas_kernel as pak


def J(s):
    return json.loads(s)


def wait(job_id, timeout=60):
    import time
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


def _prepare_text_frame(ns, kind, tmp_path, n=200):
    """Prepare a simple n-row frame with a 'title' text column."""
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


# ---- search() -----------------------------------------------------------------------


@pytest.mark.parametrize("kind", ["pandas", "polars", "pyarrow"])
def test_search_basic(ns, tmp_path, kind):
    """search() finds rows whose title matches the query (case-insensitive substring)."""
    jid, nkept = _prepare_text_frame(ns, kind, tmp_path)
    # Column 6 is "title" (values "Item 0" … "Item N-1").
    r = J(pak.search(jid, 6, "item 0"))
    assert r["ok"], r
    # "item 0" matches "Item 0", "Item 10", "Item 100", etc.
    assert r["count"] >= 1
    assert r["file"] is not None
    job = pak._JOBS[jid]
    from pathlib import Path
    idx = np.fromfile(Path(job.path(r["file"])), dtype="<u4")
    assert len(idx) == r["count"]
    # All returned kept-row indices are valid.
    assert idx.max() < nkept


@pytest.mark.parametrize("kind", ["pandas", "polars", "pyarrow"])
def test_search_no_match(ns, tmp_path, kind):
    """search() returns count=0 and file=None when nothing matches."""
    jid, _ = _prepare_text_frame(ns, kind, tmp_path)
    r = J(pak.search(jid, 6, "zzzznotfound"))
    assert r["ok"], r
    assert r["count"] == 0
    assert r["file"] is None


@pytest.mark.parametrize("kind", ["pandas", "polars", "pyarrow"])
def test_search_case_insensitive(ns, tmp_path, kind):
    """search() treats the query as case-insensitive."""
    jid, _ = _prepare_text_frame(ns, kind, tmp_path)
    r_lower = J(pak.search(jid, 6, "item"))
    r_upper = J(pak.search(jid, 6, "ITEM"))
    assert r_lower["ok"] and r_upper["ok"]
    assert r_lower["count"] == r_upper["count"] > 0


@pytest.mark.parametrize("kind", ["pandas", "polars", "pyarrow"])
def test_search_regex(ns, tmp_path, kind):
    """search() supports regex mode."""
    jid, _ = _prepare_text_frame(ns, kind, tmp_path)
    # Regex: items ending with "5" (e.g. "Item 5", "Item 15", "Item 25", ...)
    r = J(pak.search(jid, 6, r"Item \d*5$", 100_000, json.dumps({"regex": True})))
    assert r["ok"], r
    assert r["count"] >= 1  # at least "Item 5"


def test_search_limit(ns, tmp_path):
    """search() caps results at the given limit."""
    jid, nkept = _prepare_text_frame(ns, "pandas", tmp_path)
    # "Item" matches all nkept rows; cap at 5.
    r = J(pak.search(jid, 6, "Item", limit=5))
    assert r["ok"], r
    assert r["count"] == 5


def test_search_empty_query(ns, tmp_path):
    """search() with empty query returns count=0 immediately."""
    jid, _ = _prepare_text_frame(ns, "pandas", tmp_path)
    r = J(pak.search(jid, 6, ""))
    assert r["ok"], r
    assert r["count"] == 0
    assert r["file"] is None


# ---- export_datamapplot() with stub -------------------------------------------------


def _install_stub():
    """Install a minimal datamapplot stub and return the calls list."""
    calls = []

    def create_interactive_plot(coords, *label_layers, **kwargs):
        coords = np.asarray(coords)
        if coords.ndim != 2 or coords.shape[1] != 2:
            raise ValueError(f"bad coords shape: {coords.shape}")
        for la in label_layers:
            la = np.asarray(la)
            if la.shape != (coords.shape[0],):
                raise ValueError("label length mismatch")
        calls.append({
            "n": int(coords.shape[0]),
            "n_layers": len(label_layers),
            "kwargs": sorted(kwargs),
            "label_color_map": kwargs.get("label_color_map"),
        })

        def _save(path):
            import os
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(f"<html>stub n={calls[-1]['n']}</html>\n")

        return types.SimpleNamespace(save=_save)

    stub = types.ModuleType("datamapplot")
    stub.create_interactive_plot = create_interactive_plot
    sys.modules["datamapplot"] = stub
    return calls


def test_export_datamapplot_basic(ns, tmp_path):
    """export_datamapplot() saves an HTML file and passes correct args to stub."""
    calls = _install_stub()
    try:
        jid, nkept = _prepare_text_frame(ns, "pandas", tmp_path)
        # Fake xy (no projection needed for the test).
        job = pak._JOBS[jid]
        rng = np.random.default_rng(0)
        job.xy = rng.normal(size=(nkept, 2)).astype(np.float32)

        out_html = str(tmp_path / "export.html")
        # labelColumn=5 (label), titleColumn=6 (title), plus a label_color_map
        label_colors = {"c0": "#4e79a7", "c1": "#f28e2b", "c2": "#e15759", "c3": "#76b7b2"}
        opts = json.dumps({"labelColumn": 5, "titleColumn": 6, "labelColorMap": label_colors})
        r = J(pak.export_datamapplot(jid, out_html, opts))
        assert r["ok"], r
        assert r["path"] == out_html

        from pathlib import Path
        assert Path(out_html).exists()

        assert len(calls) == 1
        assert calls[0]["n"] == nkept
        assert calls[0]["n_layers"] == 1  # one label layer
        assert "hover_text" in calls[0]["kwargs"]
        assert "noise_label" in calls[0]["kwargs"]
        # label_color_map should be forwarded from opts to datamapplot kwargs.
        assert calls[0]["label_color_map"] == label_colors
    finally:
        sys.modules.pop("datamapplot", None)


def test_export_datamapplot_no_label_or_title(ns, tmp_path):
    """export_datamapplot() works without label or title columns."""
    calls = _install_stub()
    try:
        jid, nkept = _prepare_text_frame(ns, "pandas", tmp_path)
        job = pak._JOBS[jid]
        rng = np.random.default_rng(0)
        job.xy = rng.normal(size=(nkept, 2)).astype(np.float32)

        out_html = str(tmp_path / "export_bare.html")
        r = J(pak.export_datamapplot(jid, out_html, "{}"))
        assert r["ok"], r
        assert len(calls) == 1
        assert calls[0]["n_layers"] == 0  # no label layer
        assert "hover_text" not in calls[0]["kwargs"]
    finally:
        sys.modules.pop("datamapplot", None)


def test_export_datamapplot_no_coords(ns, tmp_path):
    """export_datamapplot() fails gracefully when xy is None."""
    _install_stub()
    try:
        jid, _ = _prepare_text_frame(ns, "pandas", tmp_path)
        # Do NOT set job.xy → it stays None.
        r = J(pak.export_datamapplot(jid, str(tmp_path / "out.html")))
        assert not r["ok"]
        assert "coordinates" in r["error"].lower() or "No coord" in r["error"] or "xy" in r["error"].lower()
    finally:
        sys.modules.pop("datamapplot", None)


def test_describe_reports_datamapplot_dep(ns):
    """describe() includes 'datamapplot' in deps."""
    rng = np.random.default_rng(0)
    ns["df"] = pd.DataFrame(rng.normal(size=(50, 5)), columns=list("abcde"))
    d = J(pak.describe("df"))
    assert "datamapplot" in d["deps"]
