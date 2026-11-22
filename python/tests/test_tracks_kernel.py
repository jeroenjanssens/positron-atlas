"""time_values and tracks (items 10 and 11) through the real kernel functions."""

import json
import os
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


def _frame(kind="pandas"):
    # 3 tracks of 4 visits each, rows shuffled, times out of order within each track.
    rng = np.random.default_rng(0)
    ids = np.repeat(["a", "b", "c"], 4)
    t = np.tile([30.0, 10.0, 40.0, 20.0], 3)
    order = rng.permutation(12)
    data = {"f0": rng.normal(size=12), "f1": rng.normal(size=12), "pid": ids[order], "visit": t[order]}
    if kind == "polars":
        pl = pytest.importorskip("polars")
        return pl.DataFrame(data)
    return pd.DataFrame(data)


def _job(ns, tmp_path, kind="pandas"):
    ns["df"] = _frame(kind)
    jid = J(pak.create_job("df", str(tmp_path)))["jobId"]
    assert J(pak.prepare(jid, json.dumps({"features": [0, 1], "seed": 1, "maxAnchors": 1000})))["ok"]
    assert wait(jid)["stage"] == "done"
    job = pak._JOBS[jid]
    # A known layout: row r of the frame sits at (r, -r).
    rows = job.kept_idx if job.kept_idx is not None else np.arange(12)
    job.xy = np.stack([rows, -rows], axis=1).astype(np.float32)
    return jid, job


def _read(job, name, dtype):
    return np.fromfile(os.path.join(job.dir, name), dtype=dtype)


@pytest.mark.parametrize("kind", ["pandas", "polars"])
def test_tracks_group_by_id_and_order_by_time(ns, tmp_path, kind):
    jid, job = _job(ns, tmp_path, kind)
    r = J(pak.tracks(jid, 2, 3, 2))
    assert r["ok"] and r["n_tracks"] == 3 and r["n_points"] == 12
    starts = _read(job, r["starts_file"], "<u4")
    lengths = _read(job, r["lengths_file"], "<u4")
    times = _read(job, r["time_file"], "<f4")
    xy = _read(job, r["xy_file"], "<f4").reshape(-1, 2)
    assert lengths.tolist() == [4, 4, 4]
    frame = ns["df"].to_pandas() if kind == "polars" else ns["df"]
    for s, n in zip(starts, lengths):
        seg = times[s : s + n]
        assert np.all(np.diff(seg) > 0), "visits are ordered by time within a track"
        # Each point is the row the layout put there: same track id throughout.
        rows = xy[s : s + n, 0].astype(int)
        assert len(set(frame["pid"].iloc[rows])) == 1


def test_track_times_are_normalised(ns, tmp_path):
    jid, job = _job(ns, tmp_path)
    r = J(pak.tracks(jid, 2, 3, 2))
    times = _read(job, r["time_file"], "<f4")
    assert times.min() == pytest.approx(0.0) and times.max() == pytest.approx(1.0)
    assert sorted(set(np.round(times, 4))) == pytest.approx([0.0, 1 / 3, 2 / 3, 1.0], abs=1e-3)


def test_time_values_normalised_with_nan(ns, tmp_path):
    df = _frame()
    df.loc[0, "visit"] = np.nan
    ns["df"] = df
    jid = J(pak.create_job("df", str(tmp_path)))["jobId"]
    assert J(pak.prepare(jid, json.dumps({"features": [0, 1], "seed": 1, "maxAnchors": 1000})))["ok"]
    assert wait(jid)["stage"] == "done"
    r = J(pak.time_values(jid, 3))
    vals = np.fromfile(os.path.join(pak._JOBS[jid].dir, r["file"]), dtype="<f4")
    assert len(vals) == r["length"] == 12
    finite = vals[np.isfinite(vals)]
    assert finite.min() == pytest.approx(0.0) and finite.max() == pytest.approx(1.0)
    assert r["min"] == 10.0 and r["max"] == 40.0
