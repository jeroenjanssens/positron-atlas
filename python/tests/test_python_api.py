"""Tests for the Python API (C3 — _AtlasHandle and comm helpers).

Uses a fake comm that never touches Positron so the tests run without a kernel.
"""
from __future__ import annotations

import base64
import json
import pathlib
import tempfile
import threading
import time
from typing import Any
from unittest.mock import MagicMock

import numpy as np
import pandas as pd
import pytest

# Import the C3 helpers directly from the kernel module.
import sys, importlib, types

# We need to load the module but stub out some imports it expects.
# The kernel is not a package so we import from its file path.
import importlib.util as _ilu

_KERNEL_PATH = pathlib.Path(__file__).parent.parent / "positron_atlas_kernel.py"


def _load_kernel():
    spec = _ilu.spec_from_file_location("positron_atlas_kernel", _KERNEL_PATH)
    mod = _ilu.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture(scope="module")
def kernel():
    return _load_kernel()


# ---------------------------------------------------------------------------
# Fake comm helpers
# ---------------------------------------------------------------------------

class _FakeComm:
    """Minimal comm stub — records sent messages and allows injecting on_msg events."""

    def __init__(self, comm_id: str = "fake-comm-001"):
        self.comm_id = comm_id
        self.sent: list[dict] = []
        self._on_msg_cb = None
        self._opened = False

    def open(self, data: dict | None = None) -> None:
        self._opened = True

    def send(self, data: Any) -> None:
        self.sent.append(data)

    def on_msg(self, cb) -> None:
        self._on_msg_cb = cb

    def inject_msg(self, data: dict) -> None:
        """Simulate a host→kernel message (selectionChanged, closed, etc.)."""
        if self._on_msg_cb is not None:
            self._on_msg_cb({"content": {"data": data}})


# ---------------------------------------------------------------------------
# _AtlasHandle unit tests
# ---------------------------------------------------------------------------

def _make_handle(kernel, tmp_path: pathlib.Path, comm_id: str = "fake-001"):
    comm = _FakeComm(comm_id)
    api_dir = tmp_path / "api"
    api_dir.mkdir(parents=True, exist_ok=True)
    handle = kernel._AtlasHandle(comm, "my_df", api_dir)
    return handle, comm, api_dir


def test_color_by_sends_command_by_index(kernel, tmp_path):
    handle, comm, _ = _make_handle(kernel, tmp_path)
    handle.color_by(3)
    assert len(comm.sent) == 1
    msg = comm.sent[0]
    assert msg["name"] == "colorBy"
    assert msg["args"]["column"] == 3


def test_label_by_sends_command_by_index(kernel, tmp_path):
    handle, comm, _ = _make_handle(kernel, tmp_path)
    handle.label_by(1)
    assert comm.sent[0]["name"] == "labelBy"
    assert comm.sent[0]["args"]["column"] == 1


def test_dims_setter_sends_setDims(kernel, tmp_path):
    handle, comm, _ = _make_handle(kernel, tmp_path)
    handle.dims = 3
    assert handle.dims == 3
    assert comm.sent[0]["name"] == "setDims"
    assert comm.sent[0]["args"]["dims"] == 3


def test_dims_setter_validates(kernel, tmp_path):
    handle, comm, _ = _make_handle(kernel, tmp_path)
    with pytest.raises(ValueError, match="dims must be 2 or 3"):
        handle.dims = 4


def test_annotate_sends_command(kernel, tmp_path):
    handle, comm, _ = _make_handle(kernel, tmp_path)
    handle.annotate(42, "hello")
    assert comm.sent[0]["name"] == "annotate"
    assert comm.sent[0]["args"]["row"] == 42
    assert comm.sent[0]["args"]["text"] == "hello"


def test_on_select_callback_fires_on_selection_changed(kernel, tmp_path):
    handle, comm, _ = _make_handle(kernel, tmp_path)
    received = []
    handle.on_select(lambda rows: received.append(rows.tolist()))

    # Simulate selection: rows 0 and 2 selected (n_kept=4).
    # Bit mask for kept rows 0 and 2: byte 0b00000101 = 5.
    mask_bytes = bytes([0b00000101])
    mask_b64 = base64.b64encode(mask_bytes).decode()
    comm.inject_msg({"type": "selectionChanged", "mask_b64": mask_b64, "nKept": 4})

    assert len(received) == 1
    assert received[0] == [0, 2]


def test_selected_rows_returns_array(kernel, tmp_path):
    handle, comm, _ = _make_handle(kernel, tmp_path)
    # No selection yet.
    assert handle.selected_rows.tolist() == []

    # Inject a selection.
    mask_bytes = bytes([0b00000011])  # rows 0 and 1 of 4 kept
    mask_b64 = base64.b64encode(mask_bytes).decode()
    comm.inject_msg({"type": "selectionChanged", "mask_b64": mask_b64, "nKept": 4})
    assert handle.selected_rows.tolist() == [0, 1]


def test_selected_rows_clears_on_null_mask(kernel, tmp_path):
    handle, comm, _ = _make_handle(kernel, tmp_path)
    mask_b64 = base64.b64encode(bytes([0b00000001])).decode()
    comm.inject_msg({"type": "selectionChanged", "mask_b64": mask_b64, "nKept": 4})
    assert handle.selected_rows.tolist() == [0]

    comm.inject_msg({"type": "selectionChanged", "mask_b64": "", "nKept": 4})
    assert handle.selected_rows.tolist() == []


def test_save_png_returns_at_once_and_reports_success(kernel, tmp_path):
    # save_png must never block: the map it waits for is prepared by this same kernel.
    handle, comm, api_dir = _make_handle(kernel, tmp_path)
    png_path = tmp_path / "out.png"
    t0 = time.monotonic()
    req = handle.save_png(str(png_path))
    assert time.monotonic() - t0 < 0.1
    assert comm.sent[0]["name"] == "savePng"
    assert comm.sent[0]["args"]["path"] == str(png_path)
    assert not req.done and req.error is None
    (api_dir / f"{comm.sent[0]['cmdId']}.json").write_text(json.dumps({"ok": True, "error": ""}))
    assert req.done and req.error is None
    assert "saved" in repr(req)


def test_save_png_reports_errors(kernel, tmp_path):
    handle, comm, api_dir = _make_handle(kernel, tmp_path)
    req = handle.save_png(str(tmp_path / "out.png"))
    (api_dir / f"{comm.sent[0]['cmdId']}.json").write_text(json.dumps({"ok": False, "error": "renderer not ready"}))
    assert req.done and req.error == "renderer not ready"


def test_save_html_returns_at_once(kernel, tmp_path):
    handle, comm, _ = _make_handle(kernel, tmp_path)
    req = handle.save_html(str(tmp_path / "out.html"))
    assert comm.sent[0]["name"] == "saveHtml" and not req.done


def test_close_sends_close_and_marks_closed(kernel, tmp_path):
    handle, comm, _ = _make_handle(kernel, tmp_path)
    assert not handle._closed
    handle.close()
    assert handle._closed
    assert comm.sent[0]["name"] == "close"


def test_close_prevents_further_commands(kernel, tmp_path):
    handle, comm, _ = _make_handle(kernel, tmp_path)
    handle.close()
    with pytest.raises(RuntimeError, match="closed"):
        handle.color_by(0)


def test_on_msg_ignores_unknown_type(kernel, tmp_path):
    handle, comm, _ = _make_handle(kernel, tmp_path)
    # Should not raise on unknown message type.
    comm.inject_msg({"type": "unknownEvent", "data": 42})


def test_send_generates_unique_cmd_ids(kernel, tmp_path):
    handle, comm, _ = _make_handle(kernel, tmp_path)
    for i in range(10):
        handle.color_by(i)
    ids = [msg["cmdId"] for msg in comm.sent]
    assert len(set(ids)) == 10, "cmdIds must be unique"


def test_mask_to_rows_all_set(kernel, tmp_path):
    handle, comm, _ = _make_handle(kernel, tmp_path)
    # 4 rows, all selected: byte 0b00001111
    mask = bytes([0b00001111])
    mask_b64 = base64.b64encode(mask).decode()
    comm.inject_msg({"type": "selectionChanged", "mask_b64": mask_b64, "nKept": 4})
    assert handle.selected_rows.tolist() == [0, 1, 2, 3]


def test_multiple_callbacks_all_fire(kernel, tmp_path):
    handle, comm, _ = _make_handle(kernel, tmp_path)
    results = [[], []]
    handle.on_select(lambda rows: results[0].append(len(rows)))
    handle.on_select(lambda rows: results[1].append(len(rows)))
    mask_b64 = base64.b64encode(bytes([0b00000111])).decode()
    comm.inject_msg({"type": "selectionChanged", "mask_b64": mask_b64, "nKept": 4})
    assert results[0] == [3]
    assert results[1] == [3]


# ---------------------------------------------------------------------------
# _ensure_atlas_module
# ---------------------------------------------------------------------------

def test_ensure_atlas_module_registers_module(kernel, tmp_path):
    # Remove positron_atlas if already registered from a previous test run.
    sys.modules.pop("positron_atlas", None)
    handle, comm, _ = _make_handle(kernel, tmp_path)
    kernel._ensure_atlas_module(handle)
    import positron_atlas  # type: ignore[import]
    assert hasattr(positron_atlas, "open")
    assert hasattr(positron_atlas, "handles")
    assert positron_atlas.last is handle


def test_ensure_atlas_module_idempotent(kernel, tmp_path):
    sys.modules.pop("positron_atlas", None)
    handle1, _, _ = _make_handle(kernel, tmp_path, "h1")
    handle2, _, _ = _make_handle(kernel, tmp_path, "h2")
    kernel._ensure_atlas_module(handle1)
    kernel._ensure_atlas_module(handle2)
    import positron_atlas  # type: ignore[import]
    # 'last' should be the most recently passed handle.
    assert positron_atlas.last is handle2
    sys.modules.pop("positron_atlas", None)


def test_selected_rows_map_prepared_rows_to_frame_rows(kernel, tmp_path):
    # The mask is over prepared rows; with sampling or dropped rows, kept_idx maps them back.
    handle, comm, _ = _make_handle(kernel, tmp_path)

    class _FakeJob:
        kept_idx = np.array([2, 5, 7, 9])

    kernel._JOBS["job-x"] = _FakeJob()
    try:
        mask_b64 = base64.b64encode(bytes([0b00001010])).decode()  # prepared rows 1 and 3
        comm.inject_msg({"type": "selectionChanged", "mask_b64": mask_b64, "nKept": 4, "jobId": "job-x"})
        assert handle.selected_rows.tolist() == [5, 9]
    finally:
        del kernel._JOBS["job-x"]


def test_every_host_message_is_answered(kernel, tmp_path):
    # performRpc on the host waits for a reply; an unanswered message stalls the next one.
    handle, comm, _ = _make_handle(kernel, tmp_path)
    n = len(comm.sent)
    comm.inject_msg({"type": "selectionChanged", "mask_b64": "", "nKept": 4})
    assert comm.sent[n:] == [{"type": "ack"}]


def test_color_by_and_label_by_send_column_names(kernel, tmp_path):
    # Names are resolved by the webview (it knows the frame's columns).
    handle, comm, _ = _make_handle(kernel, tmp_path)
    handle.color_by("phase")
    handle.label_by("cluster")
    assert comm.sent[0]["name"] == "colorBy" and comm.sent[0]["args"]["columnName"] == "phase"
    assert comm.sent[1]["name"] == "labelBy" and comm.sent[1]["args"]["columnName"] == "cluster"
