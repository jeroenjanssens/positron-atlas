"""Unit tests for C2 animate/tracks logic (pure numpy, no Atlas job required)."""
import numpy as np
import pytest


def _normalise(vals: np.ndarray) -> np.ndarray:
    lo, hi = np.nanmin(vals), np.nanmax(vals)
    if hi == lo:
        return np.full_like(vals, 0.5, dtype=np.float32)
    return np.clip(((vals - lo) / (hi - lo)).astype(np.float32), 0.0, 1.0)


def _window_filter(vals: np.ndarray, pos: float, size: float) -> np.ndarray:
    lo, hi = pos, pos + size
    return ((vals >= lo) & (vals <= hi)).astype(np.float32)


def test_normalise_min_max():
    vals = np.array([2.0, 4.0, 6.0, 8.0], dtype=np.float64)
    out = _normalise(vals)
    assert out.min() >= 0.0
    assert out.max() <= 1.0
    np.testing.assert_allclose(out[0], 0.0, atol=1e-6)
    np.testing.assert_allclose(out[-1], 1.0, atol=1e-6)


def test_normalise_constant():
    vals = np.full(5, 7.0)
    out = _normalise(vals)
    np.testing.assert_allclose(out, 0.5, atol=1e-6)


def test_window_filter_narrow_vs_wide():
    vals = np.linspace(0.0, 1.0, 100, dtype=np.float32)
    pos = 0.3
    narrow = _window_filter(vals, pos, 0.05)
    wide = _window_filter(vals, pos, 0.4)
    assert narrow.sum() < wide.sum()
    assert narrow.sum() > 0
    assert wide.sum() > 0


def test_window_filter_excludes_outside():
    vals = np.array([0.1, 0.5, 0.9], dtype=np.float32)
    f = _window_filter(vals, 0.4, 0.2)
    assert f[0] == 0  # 0.1 outside
    assert f[1] == 1  # 0.5 inside [0.4, 0.6]
    assert f[2] == 0  # 0.9 outside


def test_lexsort_groups_by_id_then_time():
    ids = np.array([0, 1, 0, 1, 0], dtype=np.int64)
    times = np.array([3.0, 2.0, 1.0, 4.0, 2.0], dtype=np.float64)
    order = np.lexsort((times, ids))
    ids_s = ids[order]
    times_s = times[order]
    # All id=0 come before id=1
    assert np.all(ids_s[:3] == 0)
    assert np.all(ids_s[3:] == 1)
    # Within id=0: ascending time
    assert list(times_s[:3]) == sorted(times_s[:3])


def test_unique_counts_sum_to_total():
    ids = np.array([2, 2, 1, 1, 1, 0])
    _, starts, lengths = np.unique(ids, return_index=True, return_counts=True)
    assert lengths.sum() == len(ids)


def test_thinning_max_tracks():
    n_tracks = 10000
    max_tracks = 5000
    step = n_tracks / max_tracks
    idx = np.array([int(i * step) for i in range(max_tracks)], dtype=np.uint32)
    assert len(idx) == max_tracks
    assert idx[0] == 0
    assert idx[-1] < n_tracks


def test_step_window_clamp():
    pos = 0.95
    speed = 0.1
    next_pos = pos + speed
    if next_pos >= 1:
        next_pos = 1 - 0.0001
    assert next_pos < 1.0
    assert next_pos > 0.9


def test_step_window_loop():
    pos = 0.95
    speed = 0.1
    next_pos = pos + speed
    if next_pos >= 1:
        next_pos = 0.0
    assert next_pos == 0.0
