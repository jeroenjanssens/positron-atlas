"""Kernel-side helper for the Positron Atlas extension.

Loaded by the extension into ``sys.modules["_positron_atlas"]`` (never into the
user's namespace). All public functions return JSON strings and return quickly;
heavy work runs in background threads ("jobs") that write raw little-endian
binary files into a job directory that the extension's webview reads.

Only numpy is required (plus pandas or polars, whichever the DataFrame is).
"""

from __future__ import annotations

import json
import math
import os
import sys
import threading
import time
import traceback
import uuid
from typing import Any

import numpy as np

VERSION = "0.1.0"

_JOBS: dict[str, "_Job"] = {}
_CHUNK_VALUES = 1 << 23  # ~32 MB of float32 per chunk
_MAX_CATEGORIES = 20

# Geometric placement chunk sizes: first chunks are smaller so points appear sooner.
_PLACE_CHUNKS = [100_000, 200_000, 400_000, 1_000_000]


# --------------------------------------------------------------------------------------
# Native core (Rust), loaded by path; numpy is the fallback
# --------------------------------------------------------------------------------------

_NATIVE: Any = None
_NATIVE_INFO: dict[str, Any] = {}
_NATIVE_LOCK = threading.Lock()


# What the helper calls in the Rust core; a core without all of them is not used.
_NATIVE_FUNCTIONS = ("Index", "column_moments", "scale_columns", "place_from_neighbors", "n_cpus")
_NATIVE_INDEX_METHODS = ("neighbors_u32", "place")


def _native_target() -> str:
    """This machine as a VS Code platform name (darwin-arm64, linux-x64, win32-x64, ...)."""
    import platform

    machine = platform.machine().lower()
    arch = {"x86_64": "x64", "amd64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(machine, machine)
    plat = "win32" if sys.platform.startswith("win") else sys.platform
    return f"{plat}-{arch}"


def _native_core() -> Any:
    """The Rust core bundled with the extension (native/<platform>/_positron_atlas_core.*), or None.

    It is loaded by path, like this helper: nothing is installed and nothing enters the user's
    namespace. When it is missing, does not load, or has another version, the numpy code is used
    and ``_NATIVE_INFO["reason"]`` says why. Set POSITRON_ATLAS_NO_NATIVE=1 to turn it off.
    """
    with _NATIVE_LOCK:  # one load attempt, even when job threads ask at the same time
        if _NATIVE is None and not _NATIVE_INFO:
            _load_native()
        return _NATIVE


def _load_native() -> None:
    global _NATIVE
    info: dict[str, Any] = {"available": False}
    try:
        import importlib.machinery
        import importlib.util

        if os.environ.get("POSITRON_ATLAS_NO_NATIVE"):
            raise RuntimeError("turned off with POSITRON_ATLAS_NO_NATIVE")
        if sys.implementation.name != "cpython" or sys.version_info < (3, 10):
            raise RuntimeError(f"needs CPython 3.10 or newer, not {sys.implementation.name} {sys.version.split()[0]}")
        target = _native_target()
        base = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, "native", target)
        files = sorted(
            f
            for f in (os.listdir(base) if os.path.isdir(base) else [])
            if f.startswith("_positron_atlas_core.") and any(f.endswith(sfx) for sfx in importlib.machinery.EXTENSION_SUFFIXES)
        )
        if not files:
            raise RuntimeError(f"no native core for {target}")
        path = os.path.normpath(os.path.join(base, files[0]))
        name = "_positron_atlas_core"
        mod = sys.modules.get(name)
        if mod is None or os.path.normpath(getattr(mod, "__file__", "") or "") != path:
            loader = importlib.machinery.ExtensionFileLoader(name, path)
            spec = importlib.util.spec_from_file_location(name, path, loader=loader)
            mod = importlib.util.module_from_spec(spec)
            loader.exec_module(mod)
            sys.modules[name] = mod
        if getattr(mod, "VERSION", None) != VERSION:
            raise RuntimeError(f"native core version {getattr(mod, 'VERSION', None)}, helper {VERSION}")
        # A core built from older sources can carry the same version number: check that it
        # has everything this helper calls, so an outdated build falls back to numpy as a
        # whole instead of failing (silently) in one code path.
        missing = [n for n in _NATIVE_FUNCTIONS if not hasattr(mod, n)]
        missing += [f"Index.{n}" for n in _NATIVE_INDEX_METHODS if not hasattr(getattr(mod, "Index", None), n)]
        if missing:
            raise RuntimeError(f"native core is outdated (missing {', '.join(missing)}); rebuild it with npm run build:native")
        _NATIVE = mod
        info.update(available=True, version=mod.VERSION, path=path, target=target)
    except Exception as e:  # noqa: BLE001 - any failure means: use numpy
        info["reason"] = f"{type(e).__name__}: {e}"
    _NATIVE_INFO.update(info)


def _native_status() -> dict[str, Any]:
    _native_core()
    return {k: v for k, v in _NATIVE_INFO.items() if k in ("available", "version", "target", "reason")}


# --------------------------------------------------------------------------------------
# Namespace / frame access
# --------------------------------------------------------------------------------------


def _user_ns() -> dict:
    try:
        from IPython import get_ipython  # type: ignore

        ip = get_ipython()
        if ip is not None:
            return ip.user_ns
    except Exception:
        pass
    import __main__

    return __main__.__dict__


def _resolve(name: str, ns: dict | None = None) -> Any:
    ns = _user_ns() if ns is None else ns
    if name in ns:
        return ns[name]
    # Allow simple expressions such as ``obj.df`` or ``data["train"]``.
    return eval(name, ns)  # noqa: S307 - runs in the user's own kernel


def _module_name(obj: Any) -> str:
    return type(obj).__module__.split(".")[0]


def _is_pandas(obj: Any) -> bool:
    return _module_name(obj) == "pandas" and type(obj).__name__ == "DataFrame"


def _is_polars(obj: Any) -> bool:
    return _module_name(obj) == "polars" and type(obj).__name__ == "DataFrame"


def _is_polars_lazy(obj: Any) -> bool:
    return _module_name(obj) == "polars" and type(obj).__name__ == "LazyFrame"


def _try_narwhals() -> Any:
    """Return the narwhals module if importable in this Python session, else None."""
    try:
        import importlib

        return importlib.import_module("narwhals")
    except ImportError:
        return None


class _Frame:
    """Uniform access to pandas and polars DataFrames, by column position.

    Use ``_make_frame()`` for other DataFrame types (pyarrow, Modin, cuDF,
    lazy frames). The pandas and polars paths here are unchanged in behaviour
    and speed; ``_NarwhalsFrame`` is used for everything else.
    """

    def __init__(self, obj: Any):
        if _is_polars_lazy(obj):
            raise TypeError("This is a polars LazyFrame. Call .collect() first and open the result.")
        if _is_pandas(obj):
            self.kind = "pandas"
        elif _is_polars(obj):
            self.kind = "polars"
        else:
            raise TypeError(f"Unsupported type {type(obj).__module__}.{type(obj).__name__}; expected a pandas or polars DataFrame.")
        self.obj = obj
        # Set by _make_frame when a lazy frame was collected before wrapping.
        self.was_lazy: bool = False
        self.collected_rows: int | None = None

    @property
    def n_rows(self) -> int:
        return int(self.obj.shape[0])

    @property
    def n_cols(self) -> int:
        return int(self.obj.shape[1])

    def column_names(self) -> list[str]:
        return [str(c) for c in self.obj.columns]

    def column_kind(self, j: int) -> tuple[str, str]:
        """Return (dtype string, kind) where kind in numeric/bool/datetime/categorical/other."""
        if self.kind == "pandas":
            import pandas as pd

            s = self.obj.iloc[:, j]
            dt = s.dtype
            name = str(dt)
            if pd.api.types.is_bool_dtype(dt):
                return name, "bool"
            if pd.api.types.is_numeric_dtype(dt):
                return name, "numeric"
            if pd.api.types.is_datetime64_any_dtype(dt) or pd.api.types.is_timedelta64_dtype(dt):
                return name, "datetime"
            if isinstance(dt, pd.CategoricalDtype) or pd.api.types.is_string_dtype(dt) or dt == object:
                return name, "categorical"
            return name, "other"
        else:
            import polars as pl

            dt = self.obj.dtypes[j]
            name = str(dt)
            if dt == pl.Boolean:
                return name, "bool"
            if dt.is_numeric():
                return name, "numeric"
            if dt.is_temporal():
                return name, "datetime"
            if dt in (pl.Utf8, pl.Categorical) or isinstance(dt, pl.Enum) or name.startswith(("Categorical", "Enum", "String")):
                return name, "categorical"
            return name, "other"

    def column(self, j: int, rows: np.ndarray | None = None) -> np.ndarray:
        """Column j (optionally at row positions) as a numpy array (object for strings)."""
        if self.kind == "pandas":
            s = self.obj.iloc[:, j]
            if rows is not None:
                s = s.iloc[rows]
            return s.to_numpy()
        s = self.obj.to_series(j)
        if rows is not None:
            s = s.gather(rows)
        return s.to_numpy()

    def block(self, cols: list[int], rows: np.ndarray | slice) -> np.ndarray:
        """Numeric block (len(rows) x len(cols)) as C-contiguous float32 with NaN for missing."""
        if self.kind == "pandas":
            df = self.obj.iloc[rows, cols]
            # Booleans/nullable dtypes: go column-wise to handle pd.NA safely.
            out = np.empty((df.shape[0], len(cols)), dtype=np.float32)
            for k in range(len(cols)):
                s = df.iloc[:, k]
                try:
                    out[:, k] = s.to_numpy(dtype=np.float32, na_value=np.nan)
                except (TypeError, ValueError):
                    out[:, k] = s.astype("float64").to_numpy(dtype=np.float32, na_value=np.nan)
            return out
        import polars as pl

        df = self.obj
        if isinstance(rows, slice):
            df = df.slice(rows.start or 0, (rows.stop or self.n_rows) - (rows.start or 0))
        else:
            df = df[rows]
        names = [df.columns[c] for c in cols]
        sub = df.select([pl.col(n).cast(pl.Float32) for n in names])
        try:
            # Row-major straight from polars: ~25% faster than converting a column-major result.
            arr = sub.to_numpy(order="c")
        except TypeError:  # polars without the order argument
            arr = sub.to_numpy()
        return np.ascontiguousarray(arr, dtype=np.float32)

    def declared_categories(self, j: int) -> list[str] | None:
        """Categories in declared order for pandas Categorical / polars Enum columns."""
        try:
            if self.kind == "pandas":
                import pandas as pd

                dt = self.obj.iloc[:, j].dtype
                if isinstance(dt, pd.CategoricalDtype):
                    return [str(c) for c in dt.categories]
                return None
            import polars as pl

            dt = self.obj.dtypes[j]
            if isinstance(dt, pl.Enum):
                return [str(c) for c in dt.categories.to_list()]
        except Exception:  # noqa: BLE001
            return None
        return None

    def row(self, i: int) -> list[tuple[str, str]]:
        names = self.column_names()
        if self.kind == "pandas":
            values = self.obj.iloc[int(i)].tolist()
        else:
            values = list(self.obj.row(int(i)))
        return list(zip(names, [_fmt(v) for v in values]))


class _NarwhalsFrame(_Frame):
    """Frame backed by a narwhals DataFrame (pyarrow, Modin, cuDF, or collected lazy).

    The narwhals path is for correctness, not raw speed; the pandas and polars
    fast paths in ``_Frame`` are unchanged. Write-back (add_coordinates,
    write_labels) adds columns to the native object and returns it; for types
    that cannot be mutated (lazy sources turned into pyarrow Tables) the new
    frame is stored back in the user namespace.
    """

    def __init__(self, nw_df: Any, native_obj: Any, *, was_lazy: bool = False, collected_rows: int | None = None) -> None:
        # nw_df is a narwhals.DataFrame (always eager).
        # native_obj is the original pre-narwhals object (kept for type-aware write-back).
        # Do NOT call super().__init__: it would run the pandas/polars type check.
        self.kind = "narwhals"
        self.obj = nw_df          # narwhals.DataFrame
        self._native = native_obj
        self.was_lazy = was_lazy
        self.collected_rows = collected_rows

    @property
    def n_rows(self) -> int:
        return int(self.obj.shape[0])

    @property
    def n_cols(self) -> int:
        return int(self.obj.shape[1])

    def column_names(self) -> list[str]:
        return list(self.obj.columns)

    def column_kind(self, j: int) -> tuple[str, str]:
        name = self.obj.columns[j]
        dt = self.obj.schema[name]
        s = str(dt)
        if dt.is_boolean():
            return s, "bool"
        if dt.is_numeric():
            return s, "numeric"
        if dt.is_temporal():
            return s, "datetime"
        import narwhals as nw

        if isinstance(dt, (nw.String, nw.Categorical, nw.Enum)):
            return s, "categorical"
        return s, "other"

    def column(self, j: int, rows: np.ndarray | None = None) -> np.ndarray:
        name = self.obj.columns[j]
        series = self.obj.get_column(name)
        if rows is not None:
            series = series[rows.tolist()]
        try:
            return series.to_numpy()
        except Exception:  # noqa: BLE001
            return np.asarray(series.to_list(), dtype=object)

    def block(self, cols: list[int], rows: np.ndarray | slice) -> np.ndarray:
        import narwhals as nw

        col_names = [self.obj.columns[c] for c in cols]
        if isinstance(rows, slice):
            start = rows.start or 0
            stop = rows.stop if rows.stop is not None else self.n_rows
            sub = self.obj[start:stop]
        else:
            sub = self.obj[rows.tolist()]
        n = sub.shape[0]
        out = np.empty((n, len(col_names)), dtype=np.float32)
        for k, cname in enumerate(col_names):
            try:
                out[:, k] = sub.get_column(cname).cast(nw.Float32).to_numpy()
            except Exception:  # noqa: BLE001
                vals = sub.get_column(cname).to_list()
                out[:, k] = [float("nan") if v is None else float(v) for v in vals]
        return np.ascontiguousarray(out)

    def declared_categories(self, j: int) -> list[str] | None:
        try:
            import narwhals as nw

            name = self.obj.columns[j]
            dt = self.obj.schema[name]
            if isinstance(dt, nw.Enum):
                return [str(c) for c in dt.categories]
        except Exception:  # noqa: BLE001
            pass
        return None

    def row(self, i: int) -> list[tuple[str, str]]:
        names = self.column_names()
        values = self.obj.row(int(i))
        return list(zip(names, [_fmt(v) for v in values]))

    def add_column_writeback(self, col_name: str, values: np.ndarray) -> Any:
        """Add a column to the underlying native object and update ``self.obj`` / ``self._native``.

        ``values`` is a numpy array (float32 for coordinates, object for labels).
        Returns the new native object. Raises ``TypeError`` for unsupported native types.
        """
        native = self.obj.to_native()
        native_mod = type(native).__module__.split(".")[0]
        try:
            if native_mod == "pyarrow":
                import pyarrow as pa

                native = native.append_column(col_name, pa.array(values.tolist()))
            elif native_mod == "pandas":
                native = native.copy()
                native[col_name] = values
            elif native_mod == "polars":
                import polars as pl

                native = native.with_columns(pl.Series(col_name, values.tolist()))
            else:
                raise TypeError(
                    f"Cannot add columns to native type '{native_mod}'. "
                    "Convert the DataFrame to pandas or polars first."
                )
        except TypeError:
            raise
        except Exception as exc:
            raise TypeError(f"Write-back failed for native type '{native_mod}': {exc}") from exc
        import narwhals as nw

        self.obj = nw.from_native(native)
        self._native = native
        return native


def _make_frame(obj: Any, max_lazy_rows: int = 10_000_000) -> _Frame:
    """Create the right ``_Frame`` subtype for ``obj``.

    - pandas DataFrame / polars DataFrame → ``_Frame`` (native fast paths).
    - polars LazyFrame → collected with ``max_lazy_rows`` → ``_Frame`` (polars).
    - Any type narwhals can wrap → ``_NarwhalsFrame`` (pyarrow, Modin, cuDF,
      DuckDB relation, Ibis table; lazy narwhals frames are collected first).
    - Arrow PyCapsule (``__arrow_c_stream__``) without narwhals → converted via
      polars or pyarrow, then returned as a ``_Frame`` (polars or pandas kind).
    """
    # 1. Eager pandas / polars → existing fast paths.
    if _is_pandas(obj) or _is_polars(obj):
        return _Frame(obj)

    # 2. polars LazyFrame → collect with row limit (special-cased before narwhals
    #    so the limit always applies even without narwhals installed).
    if _is_polars_lazy(obj):
        import polars as pl

        collected = obj.limit(int(max_lazy_rows)).collect()
        frame = _Frame(collected)
        frame.was_lazy = True
        frame.collected_rows = len(collected)
        return frame

    # 3. Try narwhals for all other types (pyarrow, Modin, cuDF, DuckDB, Ibis …).
    nw = _try_narwhals()
    if nw is not None:
        try:
            native_obj = obj
            nw_frame = nw.from_native(obj)
            was_lazy = False
            collected_rows = None
            if isinstance(nw_frame, nw.LazyFrame):
                nw_frame = nw_frame.head(int(max_lazy_rows)).collect()
                was_lazy = True
                collected_rows = int(nw_frame.shape[0])
            return _NarwhalsFrame(nw_frame, native_obj, was_lazy=was_lazy, collected_rows=collected_rows)
        except Exception:  # noqa: BLE001
            pass

    # 4. Arrow PyCapsule without narwhals: __arrow_c_stream__ interface.
    if hasattr(obj, "__arrow_c_stream__"):
        # Try polars (RecordBatchReader gives a table → polars DataFrame).
        try:
            import pyarrow as pa
            import polars as pl

            table = pa.RecordBatchReader.from_stream(obj).read_all()
            return _Frame(pl.from_arrow(table))
        except Exception:  # noqa: BLE001
            pass
        try:
            import pyarrow as pa

            table = pa.RecordBatchReader.from_stream(obj).read_all()
            return _Frame(table.to_pandas())
        except Exception:  # noqa: BLE001
            pass

    raise TypeError(
        f"Unsupported type {type(obj).__module__}.{type(obj).__name__}. "
        "Expected a pandas or polars DataFrame, a pyarrow Table, or any type "
        "supported by narwhals (Modin, cuDF, DuckDB relation, etc.). "
        "Lazy frames (polars LazyFrame, DuckDB relation) are collected automatically "
        "up to positronAtlas.maxLazyRows rows."
    )


def _fmt(v: Any, limit: int = 120) -> str:
    if isinstance(v, float):
        if math.isnan(v):
            return "NaN"
        s = f"{v:.6g}"
    else:
        s = str(v)
    return s if len(s) <= limit else s[: limit - 1] + "…"


def _json(obj: Any) -> str:
    return json.dumps(_sanitize(obj), allow_nan=False)


def _sanitize(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {str(k): _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize(v) for v in obj]
    if isinstance(obj, (np.floating, float)):
        f = float(obj)
        return f if math.isfinite(f) else None
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.bool_):
        return bool(obj)
    return obj


def _optional_deps() -> dict[str, bool]:
    import importlib.util

    return {m: importlib.util.find_spec(m) is not None for m in ("pynndescent", "faiss", "sklearn", "umap", "polars_umap")}


# --------------------------------------------------------------------------------------
# describe
# --------------------------------------------------------------------------------------


def describe(name: str, opts_json: str = "{}") -> str:
    opts = json.loads(opts_json)
    max_lazy_rows = int(opts.get("maxLazyRows", 10_000_000))
    try:
        frame = _make_frame(_resolve(name), max_lazy_rows=max_lazy_rows)
    except Exception as e:  # noqa: BLE001
        return _json({"ok": False, "error": str(e)})
    n = frame.n_rows
    rng = np.random.default_rng(0)
    probe = np.sort(rng.choice(n, size=min(n, 10_000), replace=False)) if n > 0 else np.arange(0)
    cols = []
    for j, cname in enumerate(frame.column_names()):
        dtype, kind = frame.column_kind(j)
        info: dict[str, Any] = {"index": j, "name": cname, "dtype": dtype, "kind": kind}
        try:
            vals = frame.column(j, probe)
            if kind in ("numeric", "bool", "datetime"):
                fv = _to_float(vals, kind)
                info["null_frac"] = float(np.mean(~np.isfinite(fv))) if fv.size else 0.0
                finite = fv[np.isfinite(fv)]
                info["n_unique_est"] = int(len(np.unique(finite))) if finite.size else 0
            else:
                obj = np.asarray(vals, dtype=object)
                nulls = np.array([_is_null(v) for v in obj], dtype=bool)
                info["null_frac"] = float(nulls.mean()) if obj.size else 0.0
                info["n_unique_est"] = int(len(set(map(str, obj[~nulls])))) if obj.size else 0
        except Exception:  # noqa: BLE001
            info["null_frac"] = None
            info["n_unique_est"] = None
        cols.append(info)
    result: dict[str, Any] = {
        "ok": True,
        "version": VERSION,
        "frameKind": frame.kind,
        "nRows": n,
        "nCols": frame.n_cols,
        "columns": cols,
        "deps": _optional_deps(),
        "native": _native_status(),
    }
    if getattr(frame, "was_lazy", False):
        result["wasLazy"] = True
        result["collectedRows"] = frame.collected_rows
    return _json(result)


def _is_null(v: Any) -> bool:
    if v is None:
        return True
    try:
        return bool(v != v)  # NaN, pd.NA raises
    except Exception:  # noqa: BLE001
        return True


def _to_float(vals: np.ndarray, kind: str) -> np.ndarray:
    if kind == "datetime":
        arr = np.asarray(vals)
        if arr.dtype.kind in "mM":
            out = arr.astype("datetime64[ns]" if arr.dtype.kind == "M" else "timedelta64[ns]").astype("int64").astype(np.float64)
            out[np.isnat(arr)] = np.nan
            return out
        # Python datetimes (object, e.g. timezone-aware pandas): nanoseconds, like datetime64[ns].
        out = np.array([np.nan if _is_null(v) else v.timestamp() * 1e9 for v in arr], dtype=np.float64)
        return out
    try:
        return np.asarray(vals, dtype=np.float64)
    except (TypeError, ValueError):
        return np.array([np.nan if _is_null(v) else float(v) for v in vals], dtype=np.float64)


# --------------------------------------------------------------------------------------
# Jobs
# --------------------------------------------------------------------------------------


class _Cancelled(Exception):
    pass


class _Job:
    def __init__(self, name: str, frame: _Frame, job_dir: str):
        self.id = uuid.uuid4().hex[:12]
        self.name = name
        self.frame = frame
        self.shape_at_start = (frame.n_rows, frame.n_cols)
        self.dir = job_dir
        os.makedirs(job_dir, exist_ok=True)
        self.lock = threading.Lock()
        self.cancel_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.generation = 0
        self.task = "idle"
        self.stage = "idle"
        self.progress = 0.0
        self.message = ""
        self.error: str | None = None
        self.result: dict[str, Any] = {}
        self.outputs: list[dict[str, Any]] = []
        self.started = time.time()
        # Prepared state
        self.kept_idx: np.ndarray | None = None  # original row positions of kept rows
        self.features: np.ndarray | None = None  # kept x dims (float32)
        self.anchor_pos: np.ndarray | None = None  # positions into kept rows
        self.anchors: np.ndarray | None = None  # feature vectors of anchors (float32)
        self.xy: np.ndarray | None = None  # kept x 2 (after projection)
        # Neighbour cache (P1): reused on re-placement with same key
        self.nbr_idx: np.ndarray | None = None  # u32 (n_non_anchors, k)
        self.nbr_sqd: np.ndarray | None = None  # f32 (n_non_anchors, k)
        self.nbr_non_anchor_pos: np.ndarray | None = None  # positions of non-anchor rows
        self.nbr_key: tuple | None = None  # (metric, k) — fixed index seed 0 always
        # P2: prepare_gen increments each time prepare succeeds, so project can detect staleness
        self.prepare_gen: int = 0
        # P2: separate background thread for the neighbours search.
        # Cancelled ONLY by the next prepare, cleanup, or explicit cancel — not by project/exact.
        self.nbr_cancel_event: threading.Event = threading.Event()  # starts set (nothing running)
        self.nbr_thread: threading.Thread | None = None
        # Set when the neighbours stage is complete (or skipped), so project can wait.
        self.nbr_done: threading.Event = threading.Event()
        self.nbr_done.set()  # starts set (no pending neighbours)
        self.nbr_error: str | None = None

    def _mine(self) -> bool:
        """True unless called from a superseded (orphaned) task thread."""
        gen = getattr(threading.current_thread(), "atlas_generation", None)
        return gen is None or gen == self.generation

    def set(self, stage: str | None = None, progress: float | None = None, message: str | None = None) -> None:
        # Each task thread checks its *own* cancel event: run() replaces self.cancel_event.
        ev = getattr(threading.current_thread(), "atlas_cancel", self.cancel_event)
        if ev.is_set() or not self._mine():
            raise _Cancelled()
        with self.lock:
            if stage is not None:
                self.stage = stage
            if progress is not None:
                self.progress = float(progress)
            if message is not None:
                self.message = message

    def path(self, fname: str) -> str:
        return os.path.join(self.dir, fname)

    def run(self, task: str, fn) -> None:
        if self.thread is not None and self.thread.is_alive():
            self.cancel_event.set()
            # Don't block the kernel on work that cannot be interrupted (e.g. umap-learn's
            # fit): after a short wait the old thread is orphaned and its results ignored.
            self.thread.join(timeout=2.0)
        self.cancel_event = threading.Event()
        self.generation += 1
        gen = self.generation
        ev = self.cancel_event
        with self.lock:
            self.task = task
            self.stage = "starting"
            self.progress = 0.0
            self.message = ""
            self.error = None
            self.result = {}
            self.outputs = []
            self.started = time.time()

        def target() -> None:
            me = threading.current_thread()
            me.atlas_cancel = ev  # type: ignore[attr-defined]
            me.atlas_generation = gen  # type: ignore[attr-defined]
            try:
                res = fn()
                outcome = ("done", res or {}, None)
            except _Cancelled:
                outcome = ("cancelled", {}, None)
            except Exception as e:  # noqa: BLE001
                outcome = ("error", {"traceback": traceback.format_exc()}, f"{type(e).__name__}: {e}")
            with self.lock:
                if gen != self.generation:
                    return  # superseded by a newer task
                self.stage, self.result, self.error = outcome
                if self.stage == "done":
                    self.progress = 1.0

        self.thread = threading.Thread(target=target, name=f"positron-atlas-{self.id}-{task}", daemon=True)
        self.thread.start()

    def add_output(self, **kw: Any) -> None:
        if not self._mine():
            raise _Cancelled()
        with self.lock:
            self.outputs.append(kw)

    def status(self) -> dict[str, Any]:
        with self.lock:
            return {
                "ok": True,
                "jobId": self.id,
                "task": self.task,
                "stage": self.stage,
                "progress": self.progress,
                "message": self.message,
                "error": self.error,
                "result": self.result,
                "outputs": list(self.outputs),
                "elapsed": time.time() - self.started,
                "stale": (self.frame.n_rows, self.frame.n_cols) != self.shape_at_start,
            }


def create_job(name: str, job_dir: str, opts_json: str = "{}") -> str:
    opts = json.loads(opts_json)
    max_lazy_rows = int(opts.get("maxLazyRows", 10_000_000))
    try:
        frame = _make_frame(_resolve(name), max_lazy_rows=max_lazy_rows)
    except Exception as e:  # noqa: BLE001
        return _json({"ok": False, "error": str(e)})
    job = _Job(name, frame, job_dir)
    _JOBS[job.id] = job
    # Lets the extension verify that it sees the files the kernel writes.
    with open(job.path(".probe"), "w") as f:
        f.write(job.id)
    extra: dict[str, Any] = {}
    if getattr(frame, "was_lazy", False):
        extra["wasLazy"] = True
        extra["collectedRows"] = frame.collected_rows
    return _json({"ok": True, "jobId": job.id, **extra})


def _get(job_id: str) -> _Job:
    if job_id not in _JOBS:
        raise KeyError(f"Unknown job {job_id}; the kernel may have restarted.")
    return _JOBS[job_id]


def _require_unchanged(job: "_Job") -> None:
    """Refuse to use prepared row positions when the DataFrame's shape changed since prepare."""
    if (job.frame.n_rows, job.frame.n_cols) != job.shape_at_start:
        raise RuntimeError("The DataFrame changed since Atlas loaded it. Click Reload to use the current data.")


def _guard(fn):
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception as e:  # noqa: BLE001
            return _json({"ok": False, "error": f"{type(e).__name__}: {e}"})

    wrapper.__name__ = fn.__name__
    wrapper.__doc__ = fn.__doc__
    return wrapper


@_guard
def status(job_id: str) -> str:
    return _json(_get(job_id).status())


@_guard
def cancel(job_id: str) -> str:
    job = _get(job_id)
    job.cancel_event.set()
    job.nbr_cancel_event.set()  # explicit cancel also stops the neighbours background thread
    return _json({"ok": True})


@_guard
def cleanup(job_id: str) -> str:
    job = _JOBS.pop(job_id, None)
    if job is not None:
        job.cancel_event.set()
        job.nbr_cancel_event.set()  # stop any background neighbours thread
        job.features = None
        job.kept_idx = None
        job.anchors = None
        job.nbr_idx = None
        job.nbr_sqd = None
        job.nbr_non_anchor_pos = None
    return _json({"ok": True})


# --------------------------------------------------------------------------------------
# prepare: sample -> read -> NaN policy -> standardize -> (PCA) -> anchors
# --------------------------------------------------------------------------------------


def sample_rows(n: int, pct: float, seed: int) -> np.ndarray:
    """Sorted original row positions of a uniform random ``pct`` % sample."""
    pct = float(min(max(pct, 0.0), 100.0))
    if pct >= 100.0 or n == 0:
        return np.arange(n, dtype=np.int64)
    m = max(1, int(round(n * pct / 100.0)))
    rng = np.random.default_rng(seed)
    return np.sort(rng.choice(n, size=m, replace=False)).astype(np.int64)


def randomized_pca(x: np.ndarray, k: int, seed: int = 0, n_iter: int = 4, oversample: int = 10):
    """Randomized PCA (Halko et al.) on a centered float matrix.

    Returns (mean, components (k x d), explained_variance_ratio (k,)).
    """
    x = np.asarray(x, dtype=np.float64)
    mean = x.mean(axis=0)
    xc = x - mean
    n, d = xc.shape
    k = int(min(k, d, n))
    rng = np.random.default_rng(seed)
    l = min(d, n, k + oversample)
    q = xc @ rng.standard_normal((d, l))
    q, _ = np.linalg.qr(q)
    for _ in range(n_iter):
        z, _ = np.linalg.qr(xc.T @ q)
        q, _ = np.linalg.qr(xc @ z)
    b = q.T @ xc
    _, s, vt = np.linalg.svd(b, full_matrices=False)
    total_var = (xc**2).sum() / max(n - 1, 1)
    ev = (s[:k] ** 2) / max(n - 1, 1)
    evr = ev / total_var if total_var > 0 else np.zeros_like(ev)
    comps = vt[:k]
    # Deterministic sign: largest-magnitude loading positive.
    signs = np.sign(comps[np.arange(k), np.abs(comps).argmax(axis=1)])
    signs[signs == 0] = 1
    comps = comps * signs[:, None]
    return mean.astype(np.float32), comps.astype(np.float32), evr


def _alloc(job: _Job, fname: str, shape: tuple[int, ...], dtype=np.float32) -> np.ndarray:
    nbytes = int(np.prod(shape)) * np.dtype(dtype).itemsize
    if nbytes > (1 << 30):  # > 1 GiB: memmap into the job dir
        return np.lib.format.open_memmap(job.path(fname), mode="w+", dtype=dtype, shape=shape)
    return np.empty(shape, dtype=dtype)


def _write(job: _Job, fname: str, arr: np.ndarray) -> str:
    path = job.path(fname)
    tmp = path + ".tmp"
    np.ascontiguousarray(arr).astype(arr.dtype.newbyteorder("<"), copy=False).tofile(tmp)
    os.replace(tmp, path)
    return path


def _prepare_impl(job: _Job, opts: dict[str, Any]) -> dict[str, Any]:
    # Cancel any background neighbours thread from the previous prepare and clear the cache.
    # This event stays set until we start a new nbr_thread below.
    job.nbr_cancel_event.set()
    # Wait briefly for a running thread to notice the cancel; it will set nbr_done when done.
    if job.nbr_thread is not None and job.nbr_thread.is_alive():
        job.nbr_thread.join(timeout=0.5)
    # Fresh cancel event and cache state for this prepare.
    job.nbr_cancel_event = threading.Event()
    job.nbr_idx = None
    job.nbr_sqd = None
    job.nbr_non_anchor_pos = None
    job.nbr_key = None
    job.nbr_done.clear()  # will be set after neighbours stage (or when skipped)
    job.nbr_error = None

    frame = job.frame
    n = frame.n_rows
    cols: list[int] = [int(c) for c in opts.get("features", [])]
    if not cols:
        raise ValueError("No feature columns selected.")
    d = len(cols)
    seed = int(opts.get("seed", 42))
    nan_policy = opts.get("nanPolicy", "drop")
    standardize = bool(opts.get("standardize", True))
    pca = bool(opts.get("pca", False))
    pca_dims = int(opts.get("pcaDims", 50))
    max_anchors = int(opts.get("maxAnchors", 100_000))
    budget = int(opts.get("anchorBudget", 10_000_000))
    sample_pct = float(opts.get("samplePct", 100.0))
    nbr_cache_mb = int(opts.get("neighborCacheMB", 1024))

    job.set("sampling", 0.0, "Sampling rows")
    sample_idx = sample_rows(n, sample_pct, seed)
    m = len(sample_idx)
    if m == 0:
        raise ValueError("The DataFrame has no rows.")

    # --- read (chunked), apply NaN policy ---------------------------------------------
    chunk = max(1, _CHUNK_VALUES // d)
    raw = _alloc(job, "raw.npy", (m, d))
    keep = np.ones(m, dtype=bool)
    full = sample_pct >= 100.0
    impute = nan_policy == "impute"
    medians = None
    if impute:
        probe = sample_idx[np.sort(np.random.default_rng(seed).choice(m, size=min(m, 50_000), replace=False))]
        medians = np.nanmedian(frame.block(cols, probe), axis=0)
        medians = np.where(np.isfinite(medians), medians, 0.0).astype(np.float32)
    w = 0
    for start in range(0, m, chunk):
        stop = min(m, start + chunk)
        rows = slice(int(sample_idx[start]), int(sample_idx[stop - 1]) + 1) if full else sample_idx[start:stop]
        blk = frame.block(cols, rows)
        bad = ~np.isfinite(blk)
        if bad.any():
            if impute:
                blk[bad] = np.broadcast_to(medians, blk.shape)[bad]
            else:
                ok = ~bad.any(axis=1)
                keep[start:stop] = ok
                blk = blk[ok]
        raw[w : w + len(blk)] = blk
        w += len(blk)
        job.set("reading", 0.35 * stop / m, f"Reading rows {stop:,}/{m:,}")
    kept_idx = sample_idx[keep]
    k_rows = w
    if k_rows == 0:
        raise ValueError("All sampled rows contain missing values. Try the 'impute' NaN policy.")
    x = raw[:k_rows]

    # --- standardize (streaming exact mean/std) ---------------------------------------
    core = _native_core() if opts.get("native", True) else None
    if standardize and core is not None and x.dtype == np.float32 and x.flags.c_contiguous and x.flags.writeable:
        # The Rust core: the same sums and formula, multithreaded, with the GIL released.
        # In blocks of rows, so progress shows and cancelling stops between blocks.
        block = max(1, (1 << 26) // d)
        s1 = np.zeros(d, dtype=np.float64)
        s2 = np.zeros(d, dtype=np.float64)
        for start in range(0, k_rows, block):
            b1, b2 = core.column_moments(x[start : start + block])
            s1 += b1
            s2 += b2
            job.set("standardizing", 0.35 + 0.1 * min(1, (start + block) / k_rows), "Standardizing")
        mean = s1 / k_rows
        std = np.sqrt(np.maximum(s2 / k_rows - mean * mean, 0.0))
        std[std < 1e-12] = 1.0
        mean32, inv32 = mean.astype(np.float32), (1.0 / std).astype(np.float32)
        for start in range(0, k_rows, block):
            core.scale_columns(x[start : start + block], mean32, inv32)
            job.set("standardizing", 0.45 + 0.1 * min(1, (start + block) / k_rows))
    elif standardize:
        s1 = np.zeros(d, dtype=np.float64)
        s2 = np.zeros(d, dtype=np.float64)
        for start in range(0, k_rows, chunk):
            blk = x[start : start + chunk].astype(np.float64)
            s1 += blk.sum(axis=0)
            s2 += (blk * blk).sum(axis=0)
            job.set("standardizing", 0.35 + 0.1 * min(1, (start + chunk) / k_rows))
        mean = s1 / k_rows
        std = np.sqrt(np.maximum(s2 / k_rows - mean * mean, 0.0))
        std[std < 1e-12] = 1.0
        mean32, inv32 = mean.astype(np.float32), (1.0 / std).astype(np.float32)
        for start in range(0, k_rows, chunk):
            blk = x[start : start + chunk]
            blk -= mean32
            blk *= inv32
            job.set("standardizing", 0.45 + 0.1 * min(1, (start + chunk) / k_rows))

    # --- PCA (optional) -----------------------------------------------------------------
    evr: list[float] | None = None
    if pca and pca_dims < d:
        job.set("pca", 0.55, "Fitting PCA")
        rng = np.random.default_rng(seed)
        fit_idx = np.sort(rng.choice(k_rows, size=min(k_rows, 100_000), replace=False))
        pmean, comps, evr_arr = randomized_pca(x[fit_idx], pca_dims, seed=seed)
        evr = [float(v) for v in evr_arr]
        feats = _alloc(job, "features.npy", (k_rows, comps.shape[0]))
        ct = np.ascontiguousarray(comps.T)
        pchunk = max(1, _CHUNK_VALUES // d)
        for start in range(0, k_rows, pchunk):
            stop = min(k_rows, start + pchunk)
            feats[start:stop] = (x[start:stop] - pmean) @ ct
            job.set("pca", 0.6 + 0.3 * stop / k_rows, f"Projecting onto {comps.shape[0]} components")
        x = feats
    dims = int(x.shape[1])

    # --- anchors -------------------------------------------------------------------------
    job.set("anchors", 0.92, "Selecting anchors")
    n_live = int(max(1, min(max_anchors, budget // max(dims, 1), k_rows)))
    if n_live >= k_rows:
        anchor_pos = np.arange(k_rows, dtype=np.int64)
    else:
        rng = np.random.default_rng(seed + 1)
        anchor_pos = np.sort(rng.choice(k_rows, size=n_live, replace=False)).astype(np.int64)
    anchors = np.ascontiguousarray(x[anchor_pos], dtype=np.float32)
    _write(job, "anchors.f32", anchors)
    _write(job, "anchor_pos.u32", anchor_pos.astype(np.uint32))

    job.set("finishing", 0.99)  # raises if this task was superseded
    job.kept_idx = kept_idx
    job.features = x
    job.anchor_pos = anchor_pos
    job.anchors = anchors  # P6: reuse in project, no need to re-read x[anchor_pos]
    job.xy = None
    needs_projection = bool(n_live < k_rows)
    job.add_output(kind="anchors", file="anchors.f32", dtype="f32", shape=[n_live, dims])
    job.add_output(kind="anchorPos", file="anchor_pos.u32", dtype="u32", shape=[n_live])

    # P2 + P1: start the neighbours search in its own background thread so prepare finishes
    # 'done' immediately and the host/browser can proceed with UMAP while the Python side
    # pre-computes the nearest-anchor indices for every non-anchor row.
    # The thread is cancelled ONLY by the next prepare, cleanup, or explicit cancel —
    # NOT by project/exact/colors tasks.
    # Note: prepare has no metric (UMAP metric is chosen by the user later), so we always
    # start with euclidean. If the first project call uses cosine, it will be a cache miss
    # and project falls back to full placement; that result is not cached back (future work).
    if needs_projection:
        k_nbr = int(opts.get("k", 10))
        metric_nbr = "euclidean"  # always euclidean from prepare; cosine is a cache miss
        n_non_anchors = k_rows - n_live
        cache_bytes = n_non_anchors * k_nbr * 8  # u32 (4) + f32 (4) per slot
        if cache_bytes <= nbr_cache_mb * 1024 * 1024:
            # Snapshot the objects the thread needs; nbr_cancel belongs to this prepare.
            nbr_cancel = job.nbr_cancel_event
            use_native = bool(opts.get("native", True))

            def _nbr_target(j=job, xa=x, ap=anchor_pos, an=anchors, k=k_nbr, m=metric_nbr, c=nbr_cancel, n=use_native):
                _prepare_neighbours(j, xa, ap, an, k, m, c, n)

            t = threading.Thread(target=_nbr_target, name=f"positron-atlas-{job.id}-neighbours", daemon=True)
            job.nbr_thread = t
            t.start()
        else:
            job.nbr_done.set()  # skip neighbours stage; set done so project doesn't wait
    else:
        job.nbr_done.set()  # no projection needed; set done immediately

    job.prepare_gen += 1
    return {
        "nRows": n,
        "nSampled": int(m),
        "nKept": int(k_rows),
        "nDropped": int(m - k_rows),
        "dims": dims,
        "inputDims": d,
        "nAnchors": n_live,
        "needsProjection": needs_projection,
        "explainedVariance": evr,
        "featuresBytes": int(x.nbytes),
    }


def _prepare_neighbours(job: _Job, x: np.ndarray, anchor_pos: np.ndarray, anchors: np.ndarray, k: int, metric: str, nbr_cancel: threading.Event, use_native: bool) -> None:
    """Compute and cache nearest-anchor neighbours for all non-anchor rows (P1 + P2).

    Runs in its own background thread started at the end of prepare. ``nbr_cancel`` is a
    threading.Event that belongs to this prepare generation; it is set when the next prepare
    starts, cleanup is called, or the user explicitly cancels. It is NOT set by project/exact.

    Metric: prepare always computes euclidean (the UMAP metric is chosen later by the user).
    If project subsequently asks for cosine and there is no cosine cache, it falls back to full
    placement without storing the result (future improvement).
    """
    n = len(x)
    is_anchor = np.zeros(n, dtype=bool)
    is_anchor[anchor_pos] = True
    non_anchor_pos = np.flatnonzero(~is_anchor)
    if len(non_anchor_pos) == 0:
        job.nbr_done.set()
        return

    core = _native_core() if use_native else None
    cosine = metric == "cosine"

    try:
        if nbr_cancel.is_set():
            return  # cancelled before we even started

        if core is not None:
            anc = np.ascontiguousarray(anchors, dtype=np.float32)
            # Use cores-1 threads so the browser's UMAP thread pool is not starved.
            n_cpus = getattr(core, "n_cpus", lambda: 1)()
            num_threads = max(1, n_cpus - 1)
            index = core.Index(anc, seed=0, cosine=cosine)
            q = np.ascontiguousarray(x[non_anchor_pos], dtype=np.float32)
            if cosine:
                norms = np.linalg.norm(q, axis=1, keepdims=True)
                q = q / np.maximum(norms, 1e-12)
            # Pass nbr_cancel.is_set as the cancel callback; checked between 65k-row blocks.
            nbr_idx, nbr_sqd = index.neighbors_u32(q, k, num_threads, nbr_cancel.is_set)
        else:
            # numpy path: process in blocks so we can honour the cancel event.
            anc = np.ascontiguousarray(anchors, dtype=np.float32)
            if cosine:
                anc = anc / np.maximum(np.linalg.norm(anc, axis=1, keepdims=True), 1e-12)
            index = AnchorIndex(anc, seed=0)
            q = np.ascontiguousarray(x[non_anchor_pos], dtype=np.float32)
            if cosine:
                q = q / np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
            BLOCK = 65_536
            idx_parts: list[np.ndarray] = []
            sqd_parts: list[np.ndarray] = []
            for s in range(0, len(q), BLOCK):
                if nbr_cancel.is_set():
                    return  # cancelled between blocks
                e = min(len(q), s + BLOCK)
                ii, dd = index.query(q[s:e], k)
                idx_parts.append(ii)
                sqd_parts.append(dd)
            nbr_idx_i64 = np.concatenate(idx_parts, axis=0)
            nbr_sqd_arr = np.concatenate(sqd_parts, axis=0)
            # Convert to u32 (sentinel: int64 -1 → u32::MAX)
            nbr_idx = np.where(nbr_idx_i64 >= 0, nbr_idx_i64.astype(np.uint32), np.iinfo(np.uint32).max)
            nbr_sqd = nbr_sqd_arr.astype(np.float32)

        # Store cache only if this prepare generation was not superseded.
        if not nbr_cancel.is_set():
            job.nbr_idx = nbr_idx
            job.nbr_sqd = nbr_sqd
            job.nbr_non_anchor_pos = non_anchor_pos
            job.nbr_key = (metric, k)
    except Exception as e:  # noqa: BLE001 — includes "cancelled" from Rust
        # Cancelled, or a real error: either way there is no cache, and project searches
        # itself. Keep the error so it can be reported and tested instead of disappearing.
        if not nbr_cancel.is_set():
            job.nbr_error = f"{type(e).__name__}: {e}"
    finally:
        job.nbr_done.set()


@_guard
def prepare(job_id: str, opts_json: str) -> str:
    job = _get(job_id)
    opts = json.loads(opts_json)
    job.run("prepare", lambda: _prepare_impl(job, opts))
    return _json({"ok": True, "jobId": job.id})


# --------------------------------------------------------------------------------------
# project: place all kept rows from their nearest anchors
# --------------------------------------------------------------------------------------


def kmeans(x: np.ndarray, k: int, n_iter: int = 8, seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """Small Lloyd's k-means. Returns (centroids, labels)."""
    rng = np.random.default_rng(seed)
    n = len(x)
    k = int(max(1, min(k, n)))
    cent = x[rng.choice(n, size=k, replace=False)].astype(np.float32)
    labels = np.zeros(n, dtype=np.int64)
    for _ in range(n_iter):
        labels = _nearest_centroids(x, cent, 1)[:, 0]
        counts = np.bincount(labels, minlength=k)
        sums = np.zeros_like(cent, dtype=np.float64)
        np.add.at(sums, labels, x)
        empty = counts == 0
        cent = (sums / np.maximum(counts, 1)[:, None]).astype(np.float32)
        if empty.any():
            cent[empty] = x[rng.choice(n, size=int(empty.sum()), replace=False)]
    labels = _nearest_centroids(x, cent, 1)[:, 0]
    return cent, labels


def _sqdist(a: np.ndarray, b: np.ndarray, b_sq: np.ndarray | None = None) -> np.ndarray:
    a_sq = np.einsum("ij,ij->i", a, a)
    if b_sq is None:
        b_sq = np.einsum("ij,ij->i", b, b)
    d = a_sq[:, None] - 2.0 * (a @ b.T) + b_sq[None, :]
    np.maximum(d, 0.0, out=d)
    return d


def _nearest_centroids(x: np.ndarray, cent: np.ndarray, nprobe: int) -> np.ndarray:
    out = np.empty((len(x), nprobe), dtype=np.int64)
    step = max(1, (1 << 24) // max(len(cent), 1))
    c_sq = np.einsum("ij,ij->i", cent, cent)
    for s in range(0, len(x), step):
        d = _sqdist(np.asarray(x[s : s + step], dtype=np.float32), cent, c_sq)
        if nprobe >= d.shape[1]:
            out[s : s + step] = np.argsort(d, axis=1)[:, :nprobe]
        else:
            p = np.argpartition(d, nprobe - 1, axis=1)[:, :nprobe]
            out[s : s + step] = p
    return out


class AnchorIndex:
    """IVF-style approximate kNN index over anchors (numpy only).

    Anchors are grouped with k-means into ~sqrt(n) cells; a query searches its
    ``nprobe`` nearest cells exhaustively. For small anchor sets it is exact.
    """

    def __init__(self, anchors: np.ndarray, seed: int = 0, nprobe: int = 4):
        self.anchors = np.ascontiguousarray(anchors, dtype=np.float32)
        n = len(self.anchors)
        self.exact = n <= 4096
        if self.exact:
            self.cells = [np.arange(n)]
            self.cent = None
            self.nprobe = 1
        else:
            k = int(min(1024, max(16, round(math.sqrt(n)))))
            fit = self.anchors
            if n > 50_000:
                fit = self.anchors[np.random.default_rng(seed).choice(n, size=50_000, replace=False)]
            cent, _ = kmeans(fit, k, seed=seed)
            labels = _nearest_centroids(self.anchors, cent, 1)[:, 0]
            self.cent = cent
            self.cells = [np.flatnonzero(labels == c) for c in range(len(cent))]
            self.nprobe = int(min(nprobe, len(cent)))
        self.a_sq = np.einsum("ij,ij->i", self.anchors, self.anchors)

    def query(self, q: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
        """Return (indices (n x k), squared distances (n x k)), sorted ascending."""
        q = np.ascontiguousarray(q, dtype=np.float32)
        nq = len(q)
        k = int(min(k, len(self.anchors)))
        if self.exact:
            d = _sqdist(q, self.anchors, self.a_sq)
            return _topk(d, np.broadcast_to(np.arange(len(self.anchors)), d.shape), k)
        probes = _nearest_centroids(q, self.cent, self.nprobe)  # nq x nprobe
        cand_i = np.full((nq, self.nprobe * k), -1, dtype=np.int64)
        cand_d = np.full((nq, self.nprobe * k), np.inf, dtype=np.float32)
        q_sq = np.einsum("ij,ij->i", q, q)
        for slot in range(self.nprobe):
            order = np.argsort(probes[:, slot], kind="stable")
            cells_sorted = probes[order, slot]
            bounds = np.searchsorted(cells_sorted, np.arange(len(self.cells) + 1))
            for c in range(len(self.cells)):
                lo, hi = bounds[c], bounds[c + 1]
                if lo == hi:
                    continue
                members = self.cells[c]
                if len(members) == 0:
                    continue
                qi = order[lo:hi]
                a = self.anchors[members]
                d = q_sq[qi, None] - 2.0 * (q[qi] @ a.T) + self.a_sq[members][None, :]
                np.maximum(d, 0.0, out=d)
                kk = min(k, len(members))
                if kk < len(members):
                    p = np.argpartition(d, kk - 1, axis=1)[:, :kk]
                else:
                    p = np.broadcast_to(np.arange(len(members)), d.shape)
                cand_i[qi, slot * k : slot * k + kk] = members[p]
                cand_d[qi, slot * k : slot * k + kk] = np.take_along_axis(d, p, axis=1)
        return _topk(cand_d, cand_i, k)


def _topk(d: np.ndarray, idx: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
    if k < d.shape[1]:
        p = np.argpartition(d, k - 1, axis=1)[:, :k]
    else:
        p = np.broadcast_to(np.arange(d.shape[1]), d.shape)
    dk = np.take_along_axis(d, p, axis=1)
    ik = np.take_along_axis(np.asarray(idx), p, axis=1)
    o = np.argsort(dk, axis=1)
    return np.take_along_axis(ik, o, axis=1), np.take_along_axis(dk, o, axis=1)


def place_from_neighbors(nbr_idx: np.ndarray, nbr_sqd: np.ndarray, anchor_xy: np.ndarray) -> np.ndarray:
    """UMAP-style membership weights exp(-(d - rho)/sigma) → weighted mean of anchor positions.

    Accepts int64 indices (sentinel -1) or uint32 indices (sentinel 0xFFFFFFFF).
    """
    d = np.sqrt(np.maximum(nbr_sqd, 0.0)).astype(np.float32)
    if nbr_idx.dtype == np.uint32:
        valid = nbr_idx != np.iinfo(np.uint32).max
        idx_for_gather = np.where(valid, nbr_idx.astype(np.int64), 0)
    else:
        valid = nbr_idx >= 0
        idx_for_gather = np.where(valid, nbr_idx, 0)
    d = np.where(valid, d, np.inf)
    rho = d[:, :1]
    gap = np.where(valid, d - rho, 0.0)
    sigma = np.maximum(gap.sum(axis=1, keepdims=True) / np.maximum(valid.sum(axis=1, keepdims=True), 1), 1e-6)
    w = np.where(valid, np.exp(-gap / sigma), 0.0).astype(np.float32)
    w_sum = np.maximum(w.sum(axis=1, keepdims=True), 1e-12)
    xy = anchor_xy[idx_for_gather]  # n x k x 2
    return (xy * w[:, :, None]).sum(axis=1) / w_sum


def _chunk_sizes(n: int) -> list[int]:
    """Geometric chunk sizes for placement: 1e5, 2e5, 4e5, then 1e6 rows (P5)."""
    sizes = []
    remaining = n
    for chunk in _PLACE_CHUNKS:
        if remaining <= 0:
            break
        sizes.append(min(chunk, remaining))
        remaining -= chunk
    while remaining > 0:
        c = min(1_000_000, remaining)
        sizes.append(c)
        remaining -= c
    return sizes


def _project_impl(job: _Job, anchor_xy: np.ndarray, opts: dict[str, Any]) -> dict[str, Any]:
    if job.features is None or job.anchor_pos is None:
        raise RuntimeError("Run prepare first.")
    x = job.features
    n = len(x)
    k = int(opts.get("k", 10))
    metric = str(opts.get("metric", "euclidean"))
    cosine = metric == "cosine"
    seed = int(opts.get("seed", 0))
    # P6: reuse anchors from prepare; fall back to recomputing if not stored.
    anchors = job.anchors if job.anchors is not None else np.ascontiguousarray(x[job.anchor_pos], dtype=np.float32)
    core = _native_core() if opts.get("native", True) else None

    # P2: wait for the background neighbours thread if it is still running.
    # We wait in 1-second ticks so that the project task's own cancel event is honoured
    # (job.set raises _Cancelled when the task is cancelled or superseded).
    # The neighbours thread is cancelled only by the next prepare/cleanup/explicit-cancel,
    # not by this project call — so waiting here is safe.
    cache_key = (metric, k)
    waited_for_nbr = False
    if not job.nbr_done.is_set():
        waited_for_nbr = True
        job.set("neighbours", 0.0, "Waiting for neighbour cache…")
        while not job.nbr_done.wait(timeout=1.0):
            # Raises _Cancelled if this project task was cancelled or a newer task started.
            job.set("neighbours", 0.5, "Waiting for neighbour cache…")

    # P1: check if neighbours are cached with a matching key.
    if (job.nbr_idx is not None and job.nbr_sqd is not None and job.nbr_key == cache_key and job.nbr_non_anchor_pos is not None):
        return _project_from_cache(job, anchor_xy, k, cosine, core, waited_for_nbr)

    if core is not None:
        return _project_native(job, core, anchors, anchor_xy, k, cosine, seed)
    if cosine:  # numpy path
        anchors = anchors / np.maximum(np.linalg.norm(anchors, axis=1, keepdims=True), 1e-12)
    job.set("indexing", 0.0, f"Indexing {len(anchors):,} anchors")
    index = AnchorIndex(anchors, seed=seed)
    is_anchor = np.zeros(n, dtype=bool)
    is_anchor[job.anchor_pos] = True
    anchor_xy = np.ascontiguousarray(anchor_xy, dtype=np.float32).reshape(-1, 2)
    xy_all = np.empty((n, 2), dtype=np.float32)
    xy_all[job.anchor_pos] = anchor_xy
    q_step = max(1, (1 << 22) // max(x.shape[1], 1) * 4)
    offset = 0
    n_files = 0
    t0 = time.time()
    for chunk_size in _chunk_sizes(n):
        fstart = offset
        fstop = offset + chunk_size
        for s in range(fstart, fstop, q_step):
            e = min(fstop, s + q_step)
            sel = np.flatnonzero(~is_anchor[s:e]) + s
            if len(sel):
                q = np.asarray(x[sel], dtype=np.float32)
                if cosine:
                    q = q / np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
                ii, dd = index.query(q, k)
                xy_all[sel] = place_from_neighbors(ii, dd, anchor_xy)
            done = e / n
            el = time.time() - t0
            eta = el / done * (1 - done) if done > 0 else 0
            job.set("projecting", done, f"Placed {e:,}/{n:,} rows (≈{eta:.0f}s left)")
        fname = f"xy_{n_files:04d}.f32"
        _write(job, fname, xy_all[fstart:fstop])
        job.add_output(kind="xy", file=fname, dtype="f32", shape=[fstop - fstart, 2], offset=fstart)
        n_files += 1
        offset += chunk_size
    job.set("finishing", 1.0)  # raises if this task was superseded
    job.xy = xy_all
    return {"nRows": n, "files": n_files, "seconds": time.time() - t0, "backend": "numpy", "cached": False}


def _project_from_cache(job: _Job, anchor_xy: np.ndarray, k: int, cosine: bool, core: Any, waited: bool = False) -> dict[str, Any]:
    """Fast re-placement using cached nearest-anchor indices (P1)."""
    x = job.features
    n = len(x)
    anchor_xy = np.ascontiguousarray(anchor_xy, dtype=np.float32).reshape(-1, 2)
    xy_all = np.empty((n, 2), dtype=np.float32)
    xy_all[job.anchor_pos] = anchor_xy
    t0 = time.time()
    nbr_idx = job.nbr_idx  # u32 (n_non_anchors, k)
    nbr_sqd = job.nbr_sqd  # f32 (n_non_anchors, k)
    non_anchor_pos = job.nbr_non_anchor_pos

    job.set("projecting", 0.0, f"Placing {len(non_anchor_pos):,} rows from cache")
    if core is not None:
        # Use the Rust place_from_neighbors for parallel weighted-mean computation.
        ni = np.ascontiguousarray(nbr_idx, dtype=np.uint32)
        ns = np.ascontiguousarray(nbr_sqd, dtype=np.float32)
        placed = core.place_from_neighbors(ni, ns, anchor_xy)
        xy_all[non_anchor_pos] = placed
    else:
        placed = place_from_neighbors(nbr_idx, nbr_sqd, anchor_xy)
        xy_all[non_anchor_pos] = placed
    job.set("projecting", 0.9, f"Writing {n:,} rows")

    n_files = 0
    offset = 0
    for chunk_size in _chunk_sizes(n):
        fstart = offset
        fstop = offset + chunk_size
        fname = f"xy_{n_files:04d}.f32"
        _write(job, fname, xy_all[fstart:fstop])
        job.add_output(kind="xy", file=fname, dtype="f32", shape=[fstop - fstart, 2], offset=fstart)
        n_files += 1
        offset += chunk_size

    job.set("finishing", 1.0)
    job.xy = xy_all
    return {"nRows": n, "files": n_files, "seconds": time.time() - t0, "backend": "rust" if core else "numpy", "cached": True, "waitedForNeighbours": waited}


def _project_native(job: _Job, core: Any, anchors: np.ndarray, anchor_xy: np.ndarray, k: int, cosine: bool, seed: int) -> dict[str, Any]:
    """Place rows with the Rust core: the same algorithm, multithreaded, with the GIL released."""
    x = job.features
    n = len(x)
    if not (x.dtype == np.float32 and x.flags.c_contiguous):
        x = np.ascontiguousarray(x, dtype=np.float32)
    job.set("indexing", 0.0, f"Indexing {len(anchors):,} anchors")
    index = core.Index(anchors, seed=seed, cosine=cosine)
    anchor_xy = np.ascontiguousarray(anchor_xy, dtype=np.float32).reshape(-1, 2)
    xy_all = np.empty((n, 2), dtype=np.float32)
    xy_all[job.anchor_pos] = anchor_xy
    is_anchor = np.zeros(n, dtype=bool)
    is_anchor[job.anchor_pos] = True
    t0 = time.time()
    n_files = 0
    offset = 0
    for chunk_size in _chunk_sizes(n):
        fstart = offset
        fstop = offset + chunk_size
        rows = (np.flatnonzero(~is_anchor[fstart:fstop]) + fstart).astype(np.int64)

        def progress(done: int, fstart: int = fstart, fstop: int = fstop, total: int = len(rows)) -> None:
            e = fstart + (fstop - fstart) * done / max(total, 1)
            el = time.time() - t0
            eta = el / (e / n) * (1 - e / n) if e > 0 else 0
            # Raises _Cancelled when the job is cancelled or superseded; the core stops there.
            job.set("projecting", e / n, f"Placed {int(e):,}/{n:,} rows (≈{eta:.0f}s left)")

        if len(rows):
            core_ok = index.place(x, rows, anchor_xy, xy_all, k, progress=progress, block_rows=65_536)
            if not core_ok:
                raise _Cancelled()
        fname = f"xy_{n_files:04d}.f32"
        _write(job, fname, xy_all[fstart:fstop])
        job.add_output(kind="xy", file=fname, dtype="f32", shape=[fstop - fstart, 2], offset=fstart)
        n_files += 1
        offset += chunk_size
    job.set("finishing", 1.0)
    job.xy = xy_all
    return {"nRows": n, "files": n_files, "seconds": time.time() - t0, "backend": "rust", "cached": False}


@_guard
def project(job_id: str, anchor_xy_path: str, opts_json: str = "{}") -> str:
    job = _get(job_id)
    opts = json.loads(opts_json)
    anchor_xy = np.fromfile(anchor_xy_path, dtype="<f4")
    job.run("project", lambda: _project_impl(job, anchor_xy, opts))
    return _json({"ok": True, "jobId": job.id})


def _write_xy_chunks(job: _Job, xy: np.ndarray, chunk_rows: int = 1_000_000) -> int:
    n_files = 0
    for start in range(0, len(xy), chunk_rows):
        stop = min(len(xy), start + chunk_rows)
        fname = f"xy_{n_files:04d}.f32"
        _write(job, fname, xy[start:stop])
        job.add_output(kind="xy", file=fname, dtype="f32", shape=[stop - start, 2], offset=start)
        n_files += 1
    return n_files


def _exact_impl(job: _Job, params: dict[str, Any]) -> dict[str, Any]:
    """Full UMAP on all prepared rows with umap-learn or polars-umap (optional dependencies)."""
    if job.features is None:
        raise RuntimeError("Run prepare first.")
    if params.get("engine") == "polars-umap":
        return _exact_polars_umap(job, params)
    try:
        import umap  # type: ignore
    except ImportError as e:
        raise RuntimeError("umap-learn is not installed in this Python environment.") from e
    job.set("umap-learn", 0.05, f"Running umap-learn on {len(job.features):,} rows (no progress available)")
    t0 = time.time()
    reducer = umap.UMAP(
        n_neighbors=int(params.get("nNeighbors", 15)),
        min_dist=float(params.get("minDist", 0.1)),
        spread=float(params.get("spread", 1.0)),
        metric=str(params.get("metric", "euclidean")),
        n_epochs=int(params.get("nEpochs", 200)),
        repulsion_strength=float(params.get("repulsionStrength", 1.0)),
        negative_sample_rate=int(params.get("negativeSampleRate", 5)),
        learning_rate=float(params.get("learningRate", 1.0)),
        random_state=int(params["seed"]) if params.get("seed") is not None else None,
    )
    xy = np.ascontiguousarray(reducer.fit_transform(np.asarray(job.features)), dtype=np.float32)
    job.set("writing", 0.95, "Writing coordinates")
    job.xy = xy
    files = _write_xy_chunks(job, xy)
    return {"nRows": int(len(xy)), "files": files, "seconds": time.time() - t0, "engine": "umap-learn"}


def _polars_umap_args(params: dict[str, Any]) -> dict[str, Any]:
    """Atlas's UMAP parameters as polars_umap.umap keyword arguments (umap-learn's names)."""
    return {
        "n_components": 2,
        "n_neighbors": int(params.get("nNeighbors", 15)),
        "min_dist": float(params.get("minDist", 0.1)),
        "spread": float(params.get("spread", 1.0)),
        "metric": str(params.get("metric", "euclidean")),
        "n_epochs": int(params.get("nEpochs", 200)),
        "learning_rate": float(params.get("learningRate", 1.0)),
        "negative_sample_rate": int(params.get("negativeSampleRate", 5)),
        "repulsion_strength": float(params.get("repulsionStrength", 1.0)),
        "random_state": int(params["seed"]) if params.get("seed") is not None else None,
    }


def _exact_polars_umap(job: _Job, params: dict[str, Any]) -> dict[str, Any]:
    """Full UMAP on all prepared rows with polars-umap (Rust, embedding-atlas's implementation)."""
    try:
        import polars as pl
        import polars_umap as pu  # type: ignore
    except ImportError as e:
        raise RuntimeError("polars-umap is not installed in this Python environment.") from e
    n = len(job.features)
    job.set("polars-umap", 0.05, f"Running polars-umap on {n:,} rows (no progress available)")
    t0 = time.time()
    # One Array(Float32, d) column holding the prepared (possibly PCA'd) features.
    vectors = pl.Series("features", np.ascontiguousarray(job.features, dtype=np.float32))
    out = pl.DataFrame([vectors]).select(xy=pu.umap("features", **_polars_umap_args(params)))
    xy = np.ascontiguousarray(out["xy"].to_numpy(), dtype=np.float32).reshape(n, 2)
    job.set("writing", 0.95, "Writing coordinates")
    job.xy = xy
    files = _write_xy_chunks(job, xy)
    return {"nRows": int(n), "files": files, "seconds": time.time() - t0, "engine": "polars-umap"}


@_guard
def exact_umap(job_id: str, params_json: str = "{}") -> str:
    job = _get(job_id)
    params = json.loads(params_json)
    job.run("exact", lambda: _exact_impl(job, params))
    return _json({"ok": True, "jobId": job.id})


@_guard
def estimate_projection(job_id: str, native: bool = True) -> str:
    """Rough cost estimate (flops) for projecting; the extension turns it into seconds.

    When neighbours are cached (from the prepare stage), cost is just the weighted-mean
    computation: approximately 4·k flops per row instead of the full index search.
    New formula when cached: flops = (n − a) × 4 × k (k=10 by default).
    """
    job = _get(job_id)
    if job.features is None or job.anchor_pos is None:
        raise RuntimeError("Run prepare first.")
    n, d = job.features.shape
    a = len(job.anchor_pos)
    backend = "rust" if native and _native_core() is not None else "numpy"
    # Check if neighbours are cached with any key (the key is validated in project).
    if job.nbr_idx is not None and job.nbr_key is not None:
        k = job.nbr_key[1]  # cached k
        # Cost: just the weighted mean, ~4k ops per non-anchor row
        flops = float((n - a) * 4 * k)
        return _json({"ok": True, "flops": flops, "rows": int(n - a), "backend": backend, "cached": True})
    # If the neighbours background thread is still running, estimate as if it will finish
    # (it will be ready by the time the user clicks "Place all rows").
    if not job.nbr_done.is_set():
        k = 10  # default k (the thread uses opts.k from prepare, typically 10)
        flops = float((n - a) * 4 * k)
        return _json({"ok": True, "flops": flops, "rows": int(n - a), "backend": backend, "cached": True})
    cells = 1 if a <= 4096 else min(1024, max(16, round(math.sqrt(a))))
    per_query = (cells + 4 * a / cells) * d if a > 4096 else a * d
    return _json({"ok": True, "flops": float(2 * (n - a) * per_query), "rows": int(n - a), "backend": backend, "cached": False})


# --------------------------------------------------------------------------------------
# colors, rows, write-back
# --------------------------------------------------------------------------------------


def _factorize(frame: _Frame, col: int, rows: np.ndarray) -> tuple[np.ndarray, list[Any]] | None:
    """Vectorized codes for a column's values at ``rows``: (codes with -1 for missing, values).

    Only for dtypes whose values turn into the same text as in the general path (``str`` of the
    numpy values): text, categorical and boolean columns, and integers. Integers with missing
    values are the one difference: pandas (nullable Int64) and polars give them to numpy as
    floats, so the general path labels them "3.0"; here they are "3", as in the data. Returns None
    for other dtypes (floats, dates), which take the general path.
    """
    if frame.kind == "pandas":
        import pandas as pd

        s = frame.obj.iloc[:, col]
        dt = s.dtype
        ok = (
            isinstance(dt, pd.CategoricalDtype)
            or pd.api.types.is_bool_dtype(dt)
            or pd.api.types.is_integer_dtype(dt)
            or pd.api.types.is_string_dtype(dt)
            or dt == object
        ) and not (pd.api.types.is_datetime64_any_dtype(dt) or pd.api.types.is_timedelta64_dtype(dt))
        if not ok:
            return None
        sub = s.iloc[rows]
        if dt == object:
            # Object columns can hold anything (lists, mixed True and 1, ...): factorize their text,
            # exactly what the general path compares, so equal-but-different values (True == 1)
            # stay apart and unhashable values work.
            missing = sub.isna().to_numpy()
            codes = np.full(len(sub), -1, dtype=np.int64)
            text_codes, uniques = pd.factorize(sub[~missing].map(str), use_na_sentinel=True)
            codes[~missing] = text_codes
            return codes, list(uniques)
        codes, uniques = pd.factorize(sub, use_na_sentinel=True)
        return np.asarray(codes, dtype=np.int64), list(uniques)
    if frame.kind != "polars":
        return None  # narwhals / capsule frames take the general (slow) path
    import polars as pl

    s = frame.obj.to_series(col)
    dt = s.dtype
    if not (dt in (pl.Utf8, pl.Categorical, pl.Boolean) or isinstance(dt, pl.Enum) or dt.is_integer()):
        return None
    s = s.gather(rows)
    if dt == pl.Categorical or isinstance(dt, pl.Enum):
        s = s.cast(pl.Utf8)
    # Dense ranks number the distinct values in sorted order, matching s.unique().sort().
    values = s.drop_nulls().unique().sort()
    codes = (s.rank("dense") - 1).fill_null(-1).cast(pl.Int64).to_numpy()
    return np.asarray(codes, dtype=np.int64), values.to_list()


def _color_values(
    frame: _Frame,
    col: int,
    rows: np.ndarray,
    force_categorical: bool = False,
    max_categories: int = _MAX_CATEGORIES,
    fast_categories: bool = True,
) -> tuple[str, np.ndarray, dict[str, Any]]:
    dtype, kind = frame.column_kind(col)
    vals = None
    if kind in ("numeric", "datetime") and not force_categorical:
        vals = frame.column(col, rows)
        fv = _to_float(vals, kind)
        finite = fv[np.isfinite(fv)]
        is_int = kind == "numeric" and finite.size > 0 and np.all(finite == np.round(finite))
        uniq = np.unique(finite[: min(len(finite), 200_000)]) if finite.size else np.array([])
        if not (is_int and len(uniq) <= 12):
            meta: dict[str, Any] = {"kind": "numeric", "dtype": dtype, "isDatetime": kind == "datetime"}
            if finite.size:
                q = np.quantile(finite, [0.0, 0.02, 0.5, 0.98, 1.0])
                meta.update(min=q[0], q02=q[1], median=q[2], q98=q[3], max=q[4])
            meta["nullCount"] = int(len(fv) - finite.size)
            return "f32", fv.astype(np.float32), meta
    # categorical: distinct values as text, their counts, and each row's value
    fast = _factorize(frame, col, rows) if fast_categories else None
    if fast is not None:
        # Vectorized (pandas factorize / polars rank): codes per row (-1 = missing) and the
        # distinct values. Values with the same text are merged, as in the general path.
        raw_codes, values = fast
        nulls = raw_codes < 0
        uniq, merged = np.unique(np.array([str(v) for v in values], dtype=object), return_inverse=True)
        inverse = merged.reshape(-1)[raw_codes[~nulls]]
        counts = np.bincount(inverse, minlength=len(uniq))
        n_rows = len(raw_codes)
    else:
        obj = np.asarray(frame.column(col, rows) if vals is None else vals, dtype=object)
        nulls = np.array([_is_null(v) for v in obj], dtype=bool) if obj.size else np.zeros(0, bool)
        keys = np.array([str(v) for v in obj], dtype=object)
        keys[nulls] = ""
        uniq, inverse, counts = np.unique(keys[~nulls], return_inverse=True, return_counts=True)
        n_rows = len(obj)
    order = _category_order(frame, col, kind, uniq, counts, max_categories)
    top = order[:max_categories]
    remap = np.full(len(uniq), len(top), dtype=np.uint16)  # "Other"
    remap[top] = np.arange(len(top), dtype=np.uint16)
    codes = np.full(n_rows, len(top) + 1, dtype=np.uint16)  # null
    codes[~nulls] = remap[inverse]
    has_other = len(uniq) > len(top)
    meta = {
        "kind": "categorical",
        "dtype": dtype,
        "categories": [str(uniq[i]) for i in top],
        "counts": [int(counts[i]) for i in top],
        "otherCount": int(counts[order[max_categories:]].sum()) if has_other else 0,
        "nullCount": int(nulls.sum()),
        "nUnique": int(len(uniq)),
    }
    return "u16", codes, meta


def _category_order(frame: _Frame, col: int, kind: str, uniq: np.ndarray, counts: np.ndarray, max_categories: int = _MAX_CATEGORIES) -> np.ndarray:
    """Legend order: declared order (pandas Categorical, polars Enum), numeric order for
    numbers and booleans, otherwise most frequent first. Only for few categories."""
    by_freq = np.argsort(-counts, kind="stable")
    if len(uniq) > max_categories:
        return by_freq
    declared = frame.declared_categories(col)
    if declared:
        pos = {c: i for i, c in enumerate(declared)}
        return np.array(sorted(range(len(uniq)), key=lambda i: (pos.get(str(uniq[i]), len(pos)), -counts[i])), dtype=np.int64)
    if kind in ("numeric", "bool"):
        try:
            vals = [float(u) if u not in ("True", "False") else float(u == "True") for u in uniq]
            return np.argsort(np.array(vals), kind="stable")
        except ValueError:
            pass
    return by_freq


@_guard
def colors(job_id: str, col: int, force_categorical: bool = False, max_categories: int | None = None) -> str:
    """Color values (or category codes) of column ``col`` for the prepared rows.

    Categorical results keep the ``max_categories`` most frequent values (default 20; at most
    65,000 so the codes fit in uint16); the rest become "Other".
    """
    job = _get(job_id)
    if job.kept_idx is None:
        raise RuntimeError("Run prepare first.")
    top = _MAX_CATEGORIES if max_categories is None else max(1, min(int(max_categories), 65_000))
    dtype, arr, meta = _color_values(job.frame, int(col), job.kept_idx, bool(force_categorical), top)
    fname = f"color_{int(col)}_{uuid.uuid4().hex[:6]}.{dtype}"
    _write(job, fname, arr)
    return _json({"ok": True, "file": fname, "dtype": dtype, "meta": meta, "length": int(len(arr))})


@_guard
def row(job_id: str, i: int, image_cols: list[int] | None = None) -> str:
    """One row for the hover tooltip; optionally also the raw values of the image columns."""
    job = _get(job_id)
    if job.kept_idx is None:
        raise RuntimeError("Run prepare first.")
    orig = int(job.kept_idx[int(i)])
    out: dict[str, Any] = {"ok": True, "row": orig}
    if image_cols:
        cols = [int(c) for c in image_cols]
        skip = set(cols)
        values = job.frame.row(orig)
        out["values"] = [v for j, v in enumerate(values) if j not in skip][:200]
        out["image"] = [round(float(v), 4) for v in job.frame.block(cols, np.array([orig]))[0]]
        out["imageColumns"] = len(cols)
    else:
        out["values"] = job.frame.row(orig)[:200]
    return _json(out)


@_guard
def add_coordinates(job_id: str, xy_path: str, x_name: str = "umap_x", y_name: str = "umap_y") -> str:
    """Write coordinates back into the user's DataFrame (NaN for rows not shown)."""
    job = _get(job_id)
    if job.kept_idx is None:
        raise RuntimeError("Run prepare first.")
    _require_unchanged(job)
    if xy_path:
        xy = np.fromfile(xy_path, dtype="<f4").reshape(-1, 2)
    elif job.xy is not None:
        xy = job.xy
    else:
        raise RuntimeError("No projected coordinates available; pass a coordinate file.")
    if len(xy) != len(job.kept_idx):
        raise ValueError("Coordinate count does not match the prepared rows.")
    n = job.frame.n_rows
    full = np.full((n, 2), np.nan, dtype=np.float32)
    full[job.kept_idx] = xy
    ns = _user_ns()
    if job.frame.kind == "pandas":
        job.frame.obj[x_name] = full[:, 0]
        job.frame.obj[y_name] = full[:, 1]
        target = job.name
        # Our own change (new columns), not the user's: keep the job current.
        job.shape_at_start = (job.frame.n_rows, job.frame.n_cols)
    elif job.frame.kind == "polars":
        import polars as pl

        new = job.frame.obj.with_columns(pl.Series(x_name, full[:, 0]), pl.Series(y_name, full[:, 1]))
        target = job.name if job.name.isidentifier() else "atlas_result"
        ns[target] = new
        job.frame = _Frame(new)
        job.shape_at_start = (job.frame.n_rows, job.frame.n_cols)
    else:
        # narwhals generic path
        assert isinstance(job.frame, _NarwhalsFrame)
        native_x = job.frame.add_column_writeback(x_name, full[:, 0])
        job.frame.add_column_writeback(y_name, full[:, 1])
        target = job.name if job.name.isidentifier() else "atlas_result"
        ns[target] = job.frame._native
        job.shape_at_start = (job.frame.n_rows, job.frame.n_cols)
    return _json({"ok": True, "variable": target, "columns": [x_name, y_name]})


# --------------------------------------------------------------------------------------
# selections (lasso): comparison with all rows, new DataFrame
# --------------------------------------------------------------------------------------


def _read_mask(job: _Job, mask_path: str) -> np.ndarray:
    """Boolean mask over the prepared rows from a file of packed bits (little bit order)."""
    if job.kept_idx is None:
        raise RuntimeError("Run prepare first.")
    n = len(job.kept_idx)
    packed = np.fromfile(mask_path, dtype=np.uint8)
    if len(packed) != (n + 7) // 8:
        raise ValueError(f"The selection has {len(packed) * 8} bits for {n} prepared rows.")
    return np.unpackbits(packed, bitorder="little")[:n].astype(bool)


def _subsample(idx: np.ndarray, limit: int, seed: int = 0) -> np.ndarray:
    if len(idx) <= limit:
        return idx
    rng = np.random.default_rng(seed)
    return np.sort(rng.choice(idx, size=limit, replace=False))


@_guard
def compare_selection(job_id: str, mask_path: str, max_rows: int = 50_000, top: int = 8) -> str:
    """How the selected rows differ from all prepared rows.

    Numeric, boolean and datetime columns: the standardized mean difference
    (mean of the selection - overall mean) / overall std. Categorical columns: the values whose
    share is most over-represented in the selection. Large selections are subsampled
    (``max_rows`` rows each for the selection and for all rows).
    """
    job = _get(job_id)
    _require_unchanged(job)
    mask = _read_mask(job, mask_path)
    n_sel = int(mask.sum())
    if n_sel == 0:
        raise ValueError("Nothing is selected.")
    frame = job.frame
    kept = job.kept_idx
    rows_all = kept[_subsample(np.arange(len(kept)), max_rows, 1)]
    rows_sel = kept[_subsample(np.flatnonzero(mask), max_rows, 2)]
    numeric: list[dict[str, Any]] = []
    categorical: list[dict[str, Any]] = []
    names = frame.column_names()
    for j, name in enumerate(names):
        dtype, kind = frame.column_kind(j)
        try:
            if kind in ("numeric", "bool", "datetime"):
                a = _to_float(frame.column(j, rows_all), kind)
                b = _to_float(frame.column(j, rows_sel), kind)
                a = a[np.isfinite(a)]
                b = b[np.isfinite(b)]
                if a.size < 2 or b.size == 0:
                    continue
                sd = float(a.std())
                if not np.isfinite(sd) or sd <= 0:
                    continue
                mean_all = float(a.mean())
                mean_sel = float(b.mean())
                numeric.append(
                    {
                        "column": name,
                        # Dates are shown as dates; durations (timedelta) as numbers.
                        "isDatetime": kind == "datetime" and not any(t in dtype.lower() for t in ("timedelta", "duration")),
                        "meanSelected": mean_sel,
                        "meanAll": mean_all,
                        "effect": (mean_sel - mean_all) / sd,
                    }
                )
            elif kind == "categorical":
                a = np.array([("" if _is_null(v) else str(v)) for v in frame.column(j, rows_all)], dtype=object)
                b = np.array([("" if _is_null(v) else str(v)) for v in frame.column(j, rows_sel)], dtype=object)
                ua, ca = np.unique(a, return_counts=True)
                if len(ua) > 1000 or len(ua) < 2:
                    continue  # identifiers and constants say little
                share_all = dict(zip(ua.tolist(), (ca / len(a)).tolist()))
                ub, cb = np.unique(b, return_counts=True)
                for v, c in zip(ub.tolist(), cb.tolist()):
                    p_sel = c / len(b)
                    p_all = share_all.get(v, 0.0)
                    # Over-represented: at least 5 % of the selection, 2 points and 25 % above overall.
                    if p_sel >= 0.05 and p_sel - p_all >= 0.02 and p_sel >= 1.25 * p_all:
                        categorical.append({"column": name, "value": v, "shareSelected": p_sel, "shareAll": p_all, "effect": p_sel - p_all})
        except Exception:  # noqa: BLE001 - skip columns that cannot be summarized
            continue
    numeric.sort(key=lambda r: -abs(r["effect"]))
    categorical.sort(key=lambda r: -r["effect"])
    return _json(
        {
            "ok": True,
            "selected": n_sel,
            "total": int(len(kept)),
            "sampled": bool(n_sel > max_rows or len(kept) > max_rows),
            "numeric": numeric[:top],
            "categorical": categorical[:top],
        }
    )


@_guard
def describe_groups(job_id: str, codes_path: str, k: int, columns: list[int], max_rows: int = 100_000, top: int = 2) -> str:
    """Name groups (e.g. automatic clusters) by their most distinguishing columns.

    ``codes_path`` holds uint16 group codes per prepared row (0..k-1; k or more = no group).
    For each group, the columns whose group mean differs most from the overall mean, in
    standard deviations (at least 0.5), become a name such as "↑ income ↓ age". Uses the
    original values of ``columns`` (numeric or boolean), not PCA components, on a subsample.
    """
    job = _get(job_id)
    if job.kept_idx is None:
        raise RuntimeError("Run prepare first.")
    _require_unchanged(job)
    n = len(job.kept_idx)
    codes = np.fromfile(codes_path, dtype="<u2")
    if len(codes) != n:
        raise ValueError(f"Got {len(codes)} codes for {n} prepared rows.")
    k = int(k)
    frame = job.frame
    names = frame.column_names()
    cols = [int(c) for c in columns if 0 <= int(c) < frame.n_cols and frame.column_kind(int(c))[1] in ("numeric", "bool")]
    pos = _subsample(np.arange(n), max_rows, 3)
    rows = job.kept_idx[pos]
    g = codes[pos].astype(np.int64)
    in_group = g < k
    counts = np.bincount(g[in_group], minlength=k)[:k]
    z = np.zeros((k, len(cols)), dtype=np.float64)
    for start in range(0, len(cols), 64):
        chunk = cols[start : start + 64]
        x = frame.block(chunk, rows).astype(np.float64)
        ok = np.isfinite(x)
        x0 = np.where(ok, x, 0.0)
        cnt = ok.sum(0)
        mean = x0.sum(0) / np.maximum(cnt, 1)
        var = (np.where(ok, (x - mean) ** 2, 0.0)).sum(0) / np.maximum(cnt - 1, 1)
        sd = np.sqrt(var)
        for j in range(len(chunk)):
            if sd[j] <= 0 or not np.isfinite(sd[j]):
                continue
            m = ok[:, j] & in_group
            s_ = np.bincount(g[m], weights=x0[m, j], minlength=k)[:k]
            c_ = np.bincount(g[m], minlength=k)[:k]
            with np.errstate(invalid="ignore", divide="ignore"):
                z[:, start + j] = np.where(c_ > 0, (s_ / np.maximum(c_, 1) - mean[j]) / sd[j], 0.0)
    out = []
    for gi in range(k):
        order = np.argsort(-np.abs(z[gi]))[:top]
        parts = [f"{'↑' if z[gi, j] > 0 else '↓'} {names[cols[j]]}" for j in order if abs(z[gi, j]) >= 0.5]
        out.append(" ".join(parts))
    return _json({"ok": True, "names": out, "counts": counts.tolist(), "sampled": bool(n > max_rows)})


@_guard
def write_labels(job_id: str, codes_path: str, names: list[str], column: str, keep_others: bool = True) -> str:
    """Write text labels into a string column of the user's DataFrame (tags, cluster names).

    ``codes_path`` holds uint16 codes per prepared row: code i < len(names) writes names[i];
    other codes keep the row's current value (``keep_others``) or set it to missing. Rows that
    were not prepared (sampled out or dropped) are left unchanged, or missing in a new column.
    pandas frames are modified in place; polars frames are rebound to the same name.
    """
    job = _get(job_id)
    if job.kept_idx is None:
        raise RuntimeError("Run prepare first.")
    _require_unchanged(job)
    column = str(column).strip()
    if not column:
        raise ValueError("The column name is empty.")
    codes = np.fromfile(codes_path, dtype="<u2")
    if len(codes) != len(job.kept_idx):
        raise ValueError(f"Got {len(codes)} codes for {len(job.kept_idx)} prepared rows.")
    names = [str(x) for x in names]
    frame = job.frame
    n = frame.n_rows
    existing = column in frame.column_names()
    key: Any = column
    if existing:
        idx = frame.column_names().index(column)
        key = frame.obj.columns[idx]  # the original label (pandas labels need not be strings)
        old = frame.column(idx)
        values = np.array([None if _is_null(v) else str(v) for v in old], dtype=object)
    else:
        values = np.full(n, None, dtype=object)
    lookup = np.array(names + [None], dtype=object)
    labelled = codes < len(names)
    rows = job.kept_idx
    values[rows[labelled]] = lookup[codes[labelled]]
    if not keep_others:
        values[rows[~labelled]] = None
    written = int(labelled.sum())
    if frame.kind == "pandas":
        import pandas as pd

        frame.obj[key] = pd.array(values, dtype="string")
        target = job.name
    elif frame.kind == "polars":
        import polars as pl

        new = frame.obj.with_columns(pl.Series(column, values.tolist(), dtype=pl.String))
        target = job.name if job.name.isidentifier() else "atlas_result"
        _user_ns()[target] = new
        job.frame = _Frame(new)
    else:
        # narwhals generic path: add via native object
        assert isinstance(frame, _NarwhalsFrame)
        str_vals = np.array([None if v is None else str(v) for v in values], dtype=object)
        frame.add_column_writeback(column, str_vals)
        target = job.name if job.name.isidentifier() else "atlas_result"
        _user_ns()[target] = frame._native
    # The shape was unchanged before this call, so the only change is the column added here:
    # don't report it as a change by the user.
    job.shape_at_start = (job.frame.n_rows, job.frame.n_cols)
    return _json({"ok": True, "variable": target, "column": column, "rows": written})


def _unique_name(base: str, ns: dict) -> str:
    import keyword

    if not base.isidentifier() or keyword.iskeyword(base):
        base = "atlas_selection"
    name = base
    k = 2
    while name in ns:
        name = f"{base}_{k}"
        k += 1
    return name


@_guard
def selection_frame(job_id: str, mask_path: str, base_name: str = "") -> str:
    """Assign the selected rows (in their original order) to a new variable; never overwrites."""
    job = _get(job_id)
    _require_unchanged(job)
    mask = _read_mask(job, mask_path)
    rows = np.sort(job.kept_idx[mask])
    if len(rows) == 0:
        raise ValueError("Nothing is selected.")
    ns = _user_ns()
    name = _unique_name(base_name or (f"{job.name}_selection" if job.name.isidentifier() else "atlas_selection"), ns)
    obj = job.frame.obj
    if job.frame.kind == "pandas":
        ns[name] = obj.iloc[rows].copy()
    elif job.frame.kind == "polars":
        ns[name] = obj[rows]
    else:
        # narwhals generic: slice native object
        native = job.frame.obj.to_native()
        native_mod = type(native).__module__.split(".")[0]
        try:
            if native_mod == "pyarrow":
                import pyarrow as pa

                ns[name] = native.take(rows.tolist())
            elif native_mod == "polars":
                import polars as pl

                ns[name] = native[rows]
            elif native_mod == "pandas":
                ns[name] = native.iloc[rows].copy()
            else:
                # Generic: convert to list indexing
                ns[name] = native[rows.tolist()]
        except Exception:  # noqa: BLE001
            ns[name] = obj[rows.tolist()].to_native()
    return _json({"ok": True, "variable": name, "rows": int(len(rows))})


def _probe_generic(v: Any) -> dict[str, Any] | None:
    """Return frame metadata for a non-pandas, non-polars object, or None if unrecognised."""
    # Polars LazyFrame: list as lazy, shape unknown without collecting.
    if _is_polars_lazy(v):
        return {"kind": "polars-lazy", "shape": None, "lazy": True}
    # Try narwhals (pyarrow, Modin, cuDF, DuckDB, Ibis, …).
    nw = _try_narwhals()
    if nw is not None:
        try:
            nw_frame = nw.from_native(v)
            if isinstance(nw_frame, nw.LazyFrame):
                schema = nw_frame.collect_schema()
                return {"kind": "narwhals-lazy", "shape": [None, len(schema)], "lazy": True}
            shape = [int(nw_frame.shape[0]), int(nw_frame.shape[1])]
            return {"kind": "narwhals", "shape": shape, "lazy": False}
        except Exception:  # noqa: BLE001
            pass
    # Arrow PyCapsule without narwhals.
    if hasattr(v, "__arrow_c_stream__"):
        return {"kind": "capsule", "shape": None, "lazy": False}
    return None


@_guard
def list_frames() -> str:
    """List DataFrame-like variables in the user namespace."""
    out = []
    for k, v in list(_user_ns().items()):
        if k.startswith("_"):
            continue
        try:
            if _is_pandas(v):
                out.append({"name": k, "kind": "pandas", "shape": [int(v.shape[0]), int(v.shape[1])], "lazy": False})
            elif _is_polars(v):
                out.append({"name": k, "kind": "polars", "shape": [int(v.shape[0]), int(v.shape[1])], "lazy": False})
            else:
                meta = _probe_generic(v)
                if meta is not None:
                    out.append({"name": k, **meta})
        except Exception:  # noqa: BLE001
            continue
    return _json({"ok": True, "frames": out})


def ping() -> str:
    return _json({"ok": True, "version": VERSION})
