"""Tests for python/positron_atlas_examples.py.

Network calls are mocked with tiny synthetic fixtures so the tests run offline
and finish in milliseconds.
"""

from __future__ import annotations

import gzip
import struct
from io import BytesIO
from pathlib import Path
from unittest.mock import patch, MagicMock

import numpy as np
import polars as pl
import pytest

import positron_atlas_examples as pae


# ---------------------------------------------------------------------------
# Fixtures: tiny synthetic IDX and CSV data
# ---------------------------------------------------------------------------


def _make_idx_images(n: int = 10, h: int = 4, w: int = 4) -> bytes:
    """Return a gzip-compressed IDX3 file with *n* images of h×w pixels."""
    buf = BytesIO()
    buf.write(b"\x00\x00\x08\x03")  # magic: ubyte images
    buf.write(struct.pack(">III", n, h, w))
    buf.write(np.zeros((n, h, w), dtype=np.uint8).tobytes())
    return gzip.compress(buf.getvalue())


def _make_idx_labels(n: int = 10, max_val: int = 9) -> bytes:
    """Return a gzip-compressed IDX1 file with *n* label bytes 0…max_val."""
    buf = BytesIO()
    buf.write(b"\x00\x00\x08\x01")  # magic: ubyte vector
    buf.write(struct.pack(">I", n))
    buf.write(bytes(i % (max_val + 1) for i in range(n)))
    return gzip.compress(buf.getvalue())


def _make_covtype_csv_gz(n: int = 20) -> bytes:
    """Return a tiny covtype.data.gz with *n* rows (all zeros, cover_type=1)."""
    rows = []
    for i in range(n):
        # 54 columns: 10 quant + 4 wilderness one-hot + 40 soil one-hot + 1 cover_type
        row = [0] * 54 + [1]  # cover_type = 1 (Spruce/Fir), wilderness = Rawah
        row[10] = 1  # first wilderness bit
        rows.append(",".join(map(str, row)))
    csv_text = "\n".join(rows) + "\n"
    return gzip.compress(csv_text.encode())


# ---------------------------------------------------------------------------
# Helper: patch _download to return synthetic data
# ---------------------------------------------------------------------------


def _make_retrieve_mock(files: dict[str, bytes]):
    """Return a mock for urllib.request.urlretrieve that writes synthetic bytes."""

    def _retrieve(url: str, dest: str) -> None:
        # Find matching bytes by suffix of cache name
        for key, data in files.items():
            if key in url:
                Path(dest).write_bytes(data)
                return
        raise ValueError(f"No mock data for URL: {url}")

    return _retrieve


# ---------------------------------------------------------------------------
# catalogue
# ---------------------------------------------------------------------------


def test_examples_catalogue():
    catalogue = pae.examples()
    assert isinstance(catalogue, list)
    assert len(catalogue) >= 1
    ids = {ex["id"] for ex in catalogue}
    assert "mnist" in ids
    assert "fashion" in ids
    assert "covtype" in ids
    for ex in catalogue:
        assert "label" in ex
        assert "description" in ex


# ---------------------------------------------------------------------------
# load_mnist — mocked network
# ---------------------------------------------------------------------------


def test_load_mnist_shape(tmp_path):
    n = 8  # very small
    mock_files = {
        "mnist-train-images": _make_idx_images(n, 28, 28),
        "mnist-t10k-images":  _make_idx_images(n, 28, 28),
        "mnist-train-labels": _make_idx_labels(n),
        "mnist-t10k-labels":  _make_idx_labels(n),
    }

    def _retrieve(url: str, dest: str) -> None:
        for key, data in mock_files.items():
            # match by the cache filename fragment that _download constructs
            # e.g. url ends with "train-images-idx3-ubyte.gz"
            if any(frag in url for frag in [
                "train-images", "t10k-images", "train-labels", "t10k-labels"
            ]):
                # determine which key to use by url content
                if "train-images" in url:
                    Path(dest).write_bytes(mock_files["mnist-train-images"])
                elif "t10k-images" in url:
                    Path(dest).write_bytes(mock_files["mnist-t10k-images"])
                elif "train-labels" in url:
                    Path(dest).write_bytes(mock_files["mnist-train-labels"])
                else:
                    Path(dest).write_bytes(mock_files["mnist-t10k-labels"])
                return
        raise ValueError(url)

    with patch.object(pae, "CACHE", tmp_path), \
         patch("urllib.request.urlretrieve", side_effect=_retrieve):
        df = pae.load_mnist()

    # 8 train + 8 test = 16 total rows, 784 pixel columns + 3 metadata
    assert df.shape == (16, 784 + 3)
    assert "label" in df.columns
    assert "split" in df.columns
    assert "ink" in df.columns
    # all values in split are "train" or "test"
    assert set(df["split"].to_list()).issubset({"train", "test"})


def test_load_mnist_uses_cache(tmp_path):
    """Second call must not hit the network at all."""
    n = 4
    call_count = {"n": 0}

    def _retrieve(url: str, dest: str) -> None:
        call_count["n"] += 1
        if "train-images" in url:
            Path(dest).write_bytes(_make_idx_images(n, 28, 28))
        elif "t10k-images" in url:
            Path(dest).write_bytes(_make_idx_images(n, 28, 28))
        elif "train-labels" in url:
            Path(dest).write_bytes(_make_idx_labels(n))
        else:
            Path(dest).write_bytes(_make_idx_labels(n))

    with patch.object(pae, "CACHE", tmp_path), \
         patch("urllib.request.urlretrieve", side_effect=_retrieve):
        pae.load_mnist()
        first_calls = call_count["n"]
        pae.load_mnist()
        second_calls = call_count["n"]

    assert first_calls == 4  # 4 files downloaded once
    assert second_calls == 4  # no additional downloads on second call


# ---------------------------------------------------------------------------
# load_fashion — mocked network
# ---------------------------------------------------------------------------


def test_load_fashion_shape(tmp_path):
    n = 6

    def _retrieve(url: str, dest: str) -> None:
        if "train-images" in url:
            Path(dest).write_bytes(_make_idx_images(n, 28, 28))
        elif "t10k-images" in url:
            Path(dest).write_bytes(_make_idx_images(n, 28, 28))
        elif "train-labels" in url:
            Path(dest).write_bytes(_make_idx_labels(n, max_val=9))
        else:
            Path(dest).write_bytes(_make_idx_labels(n, max_val=9))

    with patch.object(pae, "CACHE", tmp_path), \
         patch("urllib.request.urlretrieve", side_effect=_retrieve):
        df = pae.load_fashion()

    assert df.shape == (n * 2, 784 + 3)
    assert "label" in df.columns
    # Fashion MNIST label "0" maps to "T-shirt/top"
    labels = df["label"].to_list()
    assert all(isinstance(l, str) for l in labels)


# ---------------------------------------------------------------------------
# load_covtype — mocked network
# ---------------------------------------------------------------------------


def test_load_covtype_shape(tmp_path):
    n = 20

    def _retrieve(url: str, dest: str) -> None:
        Path(dest).write_bytes(_make_covtype_csv_gz(n))

    with patch.object(pae, "CACHE", tmp_path), \
         patch("urllib.request.urlretrieve", side_effect=_retrieve):
        df = pae.load_covtype()

    # 10 quantitative + cover_type + wilderness + soil_type = 13 columns
    assert df.shape[0] == n
    assert df.shape[1] == 13
    assert "cover_type" in df.columns
    assert "wilderness" in df.columns
    assert "soil_type" in df.columns


# ---------------------------------------------------------------------------
# load_example dispatch
# ---------------------------------------------------------------------------


def test_load_example_dispatch(tmp_path):
    n = 4

    def _retrieve(url: str, dest: str) -> None:
        if "train-images" in url or "t10k-images" in url:
            Path(dest).write_bytes(_make_idx_images(n, 28, 28))
        elif "labels" in url:
            Path(dest).write_bytes(_make_idx_labels(n))
        else:
            Path(dest).write_bytes(_make_covtype_csv_gz(n))

    with patch.object(pae, "CACHE", tmp_path), \
         patch("urllib.request.urlretrieve", side_effect=_retrieve):
        df = pae.load_example("mnist")
    assert df.shape[0] == n * 2


def test_load_example_unknown_raises():
    with pytest.raises(KeyError):
        pae.load_example("does_not_exist")
