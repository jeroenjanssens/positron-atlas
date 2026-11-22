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
_NATIVE_FUNCTIONS = ("Index", "column_moments", "scale_columns", "place_from_neighbors", "n_cpus", "MAX_OUT_DIMS")
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

    def _has(m: str) -> bool:
        # find_spec raises ValueError when the module is already in sys.modules
        # but its __spec__ is None (e.g. a manually installed test stub).
        try:
            return importlib.util.find_spec(m) is not None
        except (ValueError, AttributeError):
            return m in sys.modules

    return {m: _has(m) for m in ("pynndescent", "faiss", "sklearn", "umap", "polars_umap", "datamapplot")}


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
        # Neighbour caches (P1): keyed by (metric, k); each value is (nbr_idx u32, nbr_sqd f32, non_anchor_pos).
        # Euclidean is pre-computed by the background thread after prepare.
        # Cosine is computed on-the-fly on the first cosine project and stored here.
        self.nbr_caches: dict[tuple, tuple[np.ndarray, np.ndarray, np.ndarray]] = {}
        # Budget (MB) from prepare opts; used in project to cache cosine neighbours on-the-fly.
        self.nbr_cache_mb: int = 1024
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
        # B3: transform parameters stored after prepare so prepare_overlay can apply the same.
        self.feature_names: list[str] | None = None
        self.scale_mean: np.ndarray | None = None   # float32 means per feature column
        self.scale_inv: np.ndarray | None = None    # float32 1/std per feature column
        self.pca_mean: np.ndarray | None = None     # float32 PCA centering mean (None if no PCA)
        self.pca_comps: np.ndarray | None = None    # float32 k×d PCA component matrix (None if no PCA)
        self.overlays: dict[str, '_OverlayState'] = {}

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
        job.nbr_caches.clear()
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
    job.nbr_caches.clear()
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
    mean32: np.ndarray | None = None
    inv32: np.ndarray | None = None
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
    pmean: np.ndarray | None = None
    comps: np.ndarray | None = None
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

    # B3: store transform parameters so prepare_overlay can apply the same pipeline.
    job.feature_names = [frame.column_names()[c] for c in cols]
    job.scale_mean = mean32
    job.scale_inv = inv32
    job.pca_mean = pmean
    job.pca_comps = comps

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

    # Store the budget so project can cache cosine neighbours on-the-fly.
    job.nbr_cache_mb = nbr_cache_mb

    # P2 + P1: start the neighbours search in its own background thread so prepare finishes
    # 'done' immediately and the host/browser can proceed with UMAP while the Python side
    # pre-computes the nearest-anchor indices for every non-anchor row.
    # The thread is cancelled ONLY by the next prepare, cleanup, or explicit cancel —
    # NOT by project/exact/colors tasks.
    # Note: prepare always starts with euclidean (UMAP metric is chosen by the user later).
    # Cosine neighbours are computed on-the-fly by project on the first cosine placement.
    if needs_projection:
        k_nbr = int(opts.get("k", 10))
        metric_nbr = "euclidean"
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
            job.nbr_caches[(metric, k)] = (nbr_idx, nbr_sqd, non_anchor_pos)
    except Exception as e:  # noqa: BLE001 — includes "cancelled" from Rust
        # Cancelled, or a real error: either way there is no cache, and project searches
        # itself. Keep the error so it can be reported and tested instead of disappearing.
        if not nbr_cancel.is_set():
            job.nbr_error = f"{type(e).__name__}: {e}"
    finally:
        job.nbr_done.set()


def _coords_col_to_float32(frame: "_Frame", col: int, rows: np.ndarray) -> np.ndarray:
    """Read a single column (numeric or datetime) as a float32 array for the given rows.

    Datetime columns are converted to float64 nanoseconds (like _to_float) then cast to float32.
    Missing values become NaN.
    """
    vals = frame.column(col, rows)
    _, kind = frame.column_kind(col)
    fv = _to_float(vals, kind)
    return fv.astype(np.float32)


def _coords_prepare_impl(job: "_Job", opts: dict) -> dict:
    """Prepare using precomputed coordinate columns (no UMAP).

    Reads the x, y and optionally z columns as the layout, samples/NaN-filters as usual,
    writes xy chunks and dummy anchor files, and stores other numeric columns as features
    for compare/describe_groups.  Missing-value policy for coordinates is always 'drop'
    (imputing coordinate positions is meaningless).
    """
    # Cancel and reset background neighbours state (same as normal prepare).
    job.nbr_cancel_event.set()
    if job.nbr_thread is not None and job.nbr_thread.is_alive():
        job.nbr_thread.join(timeout=0.5)
    job.nbr_cancel_event = threading.Event()
    job.nbr_caches.clear()
    job.nbr_done.set()   # no neighbours needed in coords mode
    job.nbr_error = None

    frame = job.frame
    n = frame.n_rows
    cc = opts["coordsColumns"]   # {x: int, y: int, z?: int}
    x_col = int(cc["x"])
    y_col = int(cc["y"])
    z_col = int(cc["z"]) if cc.get("z") is not None else None
    ndim = 3 if z_col is not None else 2
    seed = int(opts.get("seed", 42))
    sample_pct = float(opts.get("samplePct", 100.0))
    nan_policy = opts.get("nanPolicy", "drop")  # 'impute' is treated as 'drop' for coords

    coord_cols = [x_col, y_col] + ([z_col] if z_col is not None else [])

    # 1. Sample rows ----------------------------------------------------------------
    job.set("sampling", 0.0, "Sampling rows")
    sample_idx = sample_rows(n, sample_pct, seed)
    m = len(sample_idx)
    if m == 0:
        raise ValueError("The DataFrame has no rows.")

    # 2. Read coordinate columns and drop rows with missing coords -------------------
    job.set("reading", 0.1, "Reading coordinate columns")
    xy_raw = np.empty((m, ndim), dtype=np.float32)
    for k_dim, col in enumerate(coord_cols):
        xy_raw[:, k_dim] = _coords_col_to_float32(frame, col, sample_idx)

    keep = np.all(np.isfinite(xy_raw), axis=1)
    if nan_policy != "drop" and not keep.all():
        # Warn but still drop: imputing coordinates makes no geometric sense.
        # (The host will see nDropped > 0, same as normal mode.)
        pass
    kept_idx = sample_idx[keep]
    xy = np.ascontiguousarray(xy_raw[keep], dtype=np.float32)
    k_rows = len(kept_idx)
    if k_rows == 0:
        raise ValueError("All sampled rows have missing values in the coordinate columns.")

    # 3. Determine other numeric/bool columns for compare/describe_groups -----------
    job.set("features", 0.4, "Reading feature columns")
    coord_set = set(coord_cols)
    all_cols = list(range(frame.n_cols))
    feature_cols = [
        j for j in all_cols
        if j not in coord_set and frame.column_kind(j)[1] in ("numeric", "bool")
    ]
    if feature_cols:
        # Read features in a chunk-compatible way (reuse block())
        chunk = max(1, _CHUNK_VALUES // max(len(feature_cols), 1))
        feat_raw = _alloc(job, "coords_features.npy", (k_rows, len(feature_cols)))
        w = 0
        full = sample_pct >= 100.0
        for start in range(0, m, chunk):
            stop = min(m, start + chunk)
            rows_sel = slice(int(sample_idx[start]), int(sample_idx[stop - 1]) + 1) if full else sample_idx[start:stop]
            blk = frame.block(feature_cols, rows_sel)
            # Apply keep mask for this chunk
            chunk_keep = keep[start:stop]
            blk_kept = blk[chunk_keep]
            # Impute missing feature values (median); coordinates were already dropped
            if nan_policy == "impute":
                for fi in range(blk_kept.shape[1]):
                    col_data = blk_kept[:, fi]
                    nan_mask = ~np.isfinite(col_data)
                    if nan_mask.any():
                        med = float(np.nanmedian(col_data))
                        col_data[nan_mask] = med if np.isfinite(med) else 0.0
            else:
                # Drop mode: replace any remaining NaN in features with 0 so compare
                # doesn't crash (coordinates were already filtered, features are best-effort)
                nan_mask = ~np.isfinite(blk_kept)
                if nan_mask.any():
                    blk_kept[nan_mask] = 0.0
            feat_raw[w:w + len(blk_kept)] = blk_kept
            w += len(blk_kept)
            job.set("features", 0.4 + 0.3 * stop / m, f"Reading features {stop:,}/{m:,}")
        features = feat_raw[:k_rows]
    else:
        features = np.empty((k_rows, 0), dtype=np.float32)

    # 4. Write xy chunks -----------------------------------------------------------
    job.set("writing", 0.75, "Writing coordinate layout")
    n_files = _write_xy_chunks(job, xy)

    # 5. Write anchor/anchorPos stubs (all rows are "anchors" in coords mode) ------
    # We write the xy coordinates as the "anchor features" so that atlas.anchors is
    # a valid Float32Array (shape [nKept, ndim]).  The UMAP worker is never started
    # in coords mode, so this data is never used for embedding.
    anchor_pos = np.arange(k_rows, dtype=np.uint32)
    _write(job, "anchors.f32", xy)                                # [nKept, ndim]
    _write(job, "anchor_pos.u32", anchor_pos)

    # 6. Store job state -----------------------------------------------------------
    job.set("finishing", 0.99)
    job.kept_idx = kept_idx
    job.features = features
    job.anchor_pos = anchor_pos
    job.anchors = xy   # same as the layout; unused for UMAP in coords mode
    job.xy = xy

    job.add_output(kind="anchors", file="anchors.f32", dtype="f32", shape=[k_rows, ndim])
    job.add_output(kind="anchorPos", file="anchor_pos.u32", dtype="u32", shape=[k_rows])
    job.prepare_gen += 1

    return {
        "nRows": n,
        "nSampled": int(m),
        "nKept": int(k_rows),
        "nDropped": int(m - k_rows),
        "dims": ndim,
        "inputDims": ndim,
        "nAnchors": int(k_rows),
        "needsProjection": False,
        "explainedVariance": None,
        "featuresBytes": int(features.nbytes),
        "coordsMode": True,
    }


@_guard
def prepare(job_id: str, opts_json: str) -> str:
    job = _get(job_id)
    opts = json.loads(opts_json)
    cc = opts.get("coordsColumns")
    if cc and isinstance(cc, dict) and "x" in cc and "y" in cc:
        job.run("prepare", lambda: _coords_prepare_impl(job, opts))
    else:
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


def _compute_cosine_nbr(
    job: _Job,
    x: np.ndarray,
    non_anchor_pos: np.ndarray,
    anchors: np.ndarray,
    k: int,
    core: Any,
    seed: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Compute cosine nearest-anchor neighbours for non-anchor rows in-line (called from project).

    Similar to _prepare_neighbours but runs in the project task thread so it can call
    job.set() for progress and honour the project cancel event.

    Returns (nbr_idx u32, nbr_sqd f32) with shape (len(non_anchor_pos), k).
    """
    n_total = len(non_anchor_pos)
    cancel_ev = getattr(threading.current_thread(), "atlas_cancel", threading.Event())
    if core is not None:
        anc = np.ascontiguousarray(anchors, dtype=np.float32)
        n_cpus = getattr(core, "n_cpus", lambda: 1)()
        num_threads = max(1, n_cpus - 1)
        index = core.Index(anc, seed=seed, cosine=True)
        q = np.ascontiguousarray(x[non_anchor_pos], dtype=np.float32)
        q = q / np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
        nbr_idx, nbr_sqd = index.neighbors_u32(q, k, num_threads, cancel_ev.is_set)
    else:
        anc = np.ascontiguousarray(anchors, dtype=np.float32)
        anc = anc / np.maximum(np.linalg.norm(anc, axis=1, keepdims=True), 1e-12)
        index_obj = AnchorIndex(anc, seed=seed)
        q = np.ascontiguousarray(x[non_anchor_pos], dtype=np.float32)
        q = q / np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
        BLOCK = 65_536
        idx_parts: list[np.ndarray] = []
        sqd_parts: list[np.ndarray] = []
        for s in range(0, n_total, BLOCK):
            if cancel_ev.is_set():
                raise _Cancelled()
            e = min(n_total, s + BLOCK)
            job.set("neighbours", s / n_total, f"Computing cosine neighbours {s:,}/{n_total:,}")
            ii, dd = index_obj.query(q[s:e], k)
            idx_parts.append(ii)
            sqd_parts.append(dd)
        nbr_idx_i64 = np.concatenate(idx_parts, axis=0)
        nbr_sqd_arr = np.concatenate(sqd_parts, axis=0)
        nbr_idx = np.where(nbr_idx_i64 >= 0, nbr_idx_i64.astype(np.uint32), np.iinfo(np.uint32).max)
        nbr_sqd = nbr_sqd_arr.astype(np.float32)
    return nbr_idx, nbr_sqd


def _project_impl(job: _Job, anchor_xy: np.ndarray, opts: dict[str, Any]) -> dict[str, Any]:
    if job.features is None or job.anchor_pos is None:
        raise RuntimeError("Run prepare first.")
    x = job.features
    n = len(x)
    k = int(opts.get("k", 10))
    metric = str(opts.get("metric", "euclidean"))
    cosine = metric == "cosine"
    seed = int(opts.get("seed", 0))
    ndim = int(opts.get("dims", 2))  # T2: 2D or 3D output
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
    if cache_key in job.nbr_caches:
        return _project_from_cache(job, anchor_xy, k, cosine, core, waited_for_nbr, job.nbr_caches[cache_key])

    # Cache miss for cosine: compute neighbours on-the-fly and cache them.
    if cosine and job.anchor_pos is not None and job.features is not None:
        x_all = job.features
        n_all = len(x_all)
        is_anc = np.zeros(n_all, dtype=bool)
        is_anc[job.anchor_pos] = True
        non_anchor_pos = np.flatnonzero(~is_anc)
        if len(non_anchor_pos) > 0:
            cache_bytes = len(non_anchor_pos) * k * 8  # u32 (4) + f32 (4) per slot
            budget_bytes = job.nbr_cache_mb * 1024 * 1024
            if cache_bytes <= budget_bytes:
                # Evict the euclidean cache if adding cosine would exceed the budget.
                current_bytes = sum(c[0].nbytes + c[1].nbytes for c in job.nbr_caches.values())
                if current_bytes + cache_bytes > budget_bytes:
                    job.nbr_caches.clear()
                try:
                    job.set("neighbours", 0.0, f"Computing cosine neighbours for {len(non_anchor_pos):,} rows")
                    nbr_idx, nbr_sqd = _compute_cosine_nbr(job, x_all, non_anchor_pos, anchors, k, core, seed)
                    job.nbr_caches[cache_key] = (nbr_idx, nbr_sqd, non_anchor_pos)
                    return _project_from_cache(job, anchor_xy, k, cosine, core, waited_for_nbr, job.nbr_caches[cache_key])
                except _Cancelled:
                    raise
                except Exception as e:  # noqa: BLE001
                    with job.lock:
                        job.message = f"cosine neighbours not cached (error: {type(e).__name__}: {e})"
                    # Fall through to full placement.
            else:
                mb_needed = (cache_bytes + 1024 * 1024 - 1) // (1024 * 1024)
                with job.lock:
                    job.message = f"cosine neighbours not cached: needs {mb_needed} MB, neighborCacheMB={job.nbr_cache_mb}"
                # Fall through to full placement.

    # T2: Rust core now handles both 2D and 3D output via out_dims parameter.
    if core is not None:
        return _project_native(job, core, anchors, anchor_xy, k, cosine, seed)
    if cosine:  # numpy path
        anchors = anchors / np.maximum(np.linalg.norm(anchors, axis=1, keepdims=True), 1e-12)
    job.set("indexing", 0.0, f"Indexing {len(anchors):,} anchors")
    index = AnchorIndex(anchors, seed=seed)
    is_anchor = np.zeros(n, dtype=bool)
    is_anchor[job.anchor_pos] = True
    anchor_xy = np.ascontiguousarray(anchor_xy, dtype=np.float32).reshape(-1, ndim)
    xy_all = np.empty((n, ndim), dtype=np.float32)
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
        job.add_output(kind="xy", file=fname, dtype="f32", shape=[fstop - fstart, ndim], offset=fstart)
        n_files += 1
        offset += chunk_size
    job.set("finishing", 1.0)  # raises if this task was superseded
    job.xy = xy_all
    return {"nRows": n, "files": n_files, "seconds": time.time() - t0, "backend": "numpy", "cached": False}


def _project_from_cache(
    job: _Job,
    anchor_xy: np.ndarray,
    k: int,
    cosine: bool,
    core: Any,
    waited: bool = False,
    cache: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None,
) -> dict[str, Any]:
    """Fast re-placement using cached nearest-anchor indices (P1)."""
    x = job.features
    n = len(x)
    # T2: detect output dims from anchor_xy length / nAnchors; default to 2.
    ndim = int(anchor_xy.size // max(len(job.anchor_pos), 1)) if job.anchor_pos is not None and len(anchor_xy) > 0 else 2
    if ndim not in (2, 3):
        ndim = 2
    anchor_xy = np.ascontiguousarray(anchor_xy, dtype=np.float32).reshape(-1, ndim)
    xy_all = np.empty((n, ndim), dtype=np.float32)
    xy_all[job.anchor_pos] = anchor_xy
    t0 = time.time()
    nbr_idx, nbr_sqd, non_anchor_pos = cache  # (u32, f32, i64) from nbr_caches

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
        job.add_output(kind="xy", file=fname, dtype="f32", shape=[fstop - fstart, ndim], offset=fstart)
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
    # T2: detect output dims from anchor_xy (2 or 3); Rust core now supports both.
    ndim = int(anchor_xy.size // max(len(job.anchor_pos), 1)) if job.anchor_pos is not None and len(anchor_xy) > 0 else 2
    if ndim not in (2, 3):
        ndim = 2
    anchor_xy = np.ascontiguousarray(anchor_xy, dtype=np.float32).reshape(-1, ndim)
    xy_all = np.empty((n, ndim), dtype=np.float32)
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
        job.add_output(kind="xy", file=fname, dtype="f32", shape=[fstop - fstart, ndim], offset=fstart)
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


# --------------------------------------------------------------------------------------
# B3: overlay projection — another DataFrame on the map
# --------------------------------------------------------------------------------------


class _OverlayState:
    """Feature-transformed rows of an overlay DataFrame, ready for placement."""

    def __init__(self, name: str, features: np.ndarray, kept_idx: np.ndarray, n_original: int):
        self.name = name
        self.features = features        # float32, shape (n_kept, dims)
        self.kept_idx = kept_idx        # original row positions that survived NaN-drop
        self.n_original = n_original    # row count before NaN-drop
        self.xy: np.ndarray | None = None   # set after project_overlay


def _overlay_apply_transforms(
    job: _Job,
    ov_frame: "_Frame",
    name_to_col: dict[str, int],
) -> tuple[np.ndarray, np.ndarray, int]:
    """Read and transform the overlay frame using the base job's stored parameters.

    Returns (features float32, kept_idx int64, n_original).
    Raises ValueError with a human-readable message when columns are missing.
    """
    if job.feature_names is None:
        raise RuntimeError("Run prepare on the base DataFrame before adding an overlay.")

    # --- match columns by name -------------------------------------------------------
    missing = [fn for fn in job.feature_names if fn not in name_to_col]
    if missing:
        n_shown = min(5, len(missing))
        shown = ", ".join(repr(m) for m in missing[:n_shown])
        suffix = f" (and {len(missing) - n_shown} more)" if len(missing) > n_shown else ""
        raise ValueError(
            f"Overlay DataFrame '{ov_frame}' is missing feature column(s) used by the base map: "
            f"{shown}{suffix}. The overlay must have all {len(job.feature_names)} feature columns."
        )
    ov_cols = [name_to_col[fn] for fn in job.feature_names]
    d = len(ov_cols)
    n = ov_frame.n_rows

    # --- read (chunked, drop NaN rows) ------------------------------------------------
    chunk = max(1, _CHUNK_VALUES // d)
    raw = np.empty((n, d), dtype=np.float32)
    keep = np.ones(n, dtype=bool)
    all_rows = np.arange(n, dtype=np.int64)
    w = 0
    for start in range(0, n, chunk):
        stop = min(n, start + chunk)
        blk = ov_frame.block(ov_cols, all_rows[start:stop])
        bad = ~np.isfinite(blk)
        if bad.any():
            ok = ~bad.any(axis=1)
            keep[start:stop] = ok
            blk = blk[ok]
        raw[w : w + len(blk)] = blk
        w += len(blk)
    kept_idx = all_rows[keep]
    k_rows = w
    if k_rows == 0:
        raise ValueError(
            f"All {n} rows of the overlay DataFrame contain missing values in the feature columns."
        )
    x = raw[:k_rows]

    # --- apply standardization -------------------------------------------------------
    if job.scale_mean is not None and job.scale_inv is not None:
        x = x - job.scale_mean
        x *= job.scale_inv

    # --- apply PCA -------------------------------------------------------------------
    if job.pca_comps is not None and job.pca_mean is not None:
        ct = np.ascontiguousarray(job.pca_comps.T)
        feats = (x - job.pca_mean) @ ct
        x = feats.astype(np.float32)
    else:
        x = np.ascontiguousarray(x, dtype=np.float32)

    return x, kept_idx, n


@_guard
def prepare_overlay(job_id: str, overlay_name: str, layer_id: str) -> str:
    """Apply the base job's stored transforms to an overlay DataFrame.

    ``overlay_name`` is the Python variable name in the kernel namespace.
    ``layer_id`` is the unique string the host assigned to this overlay layer.
    The result is stored in ``job.overlays[layer_id]`` and status is polled via wait_for_job.
    Heavy work runs in the job thread (cancels previous project/overlay tasks).
    """
    job = _get(job_id)
    if job.feature_names is None:
        return _json({"ok": False, "error": "Run prepare on the base DataFrame before adding an overlay."})
    try:
        ov_obj = _resolve(overlay_name)
        ov_frame = _make_frame(ov_obj)
    except Exception as e:  # noqa: BLE001
        return _json({"ok": False, "error": f"Cannot load overlay variable '{overlay_name}': {type(e).__name__}: {e}"})

    name_to_col = {n: i for i, n in enumerate(ov_frame.column_names())}

    # Validate columns eagerly (before the thread) so the error surfaces immediately.
    missing = [fn for fn in job.feature_names if fn not in name_to_col]
    if missing:
        n_shown = min(5, len(missing))
        shown = ", ".join(repr(m) for m in missing[:n_shown])
        suffix = f" (and {len(missing) - n_shown} more)" if len(missing) > n_shown else ""
        return _json({
            "ok": False,
            "error": (
                f"Overlay DataFrame '{overlay_name}' is missing feature column(s) used by the base map: "
                f"{shown}{suffix}. The overlay must have all {len(job.feature_names)} feature columns."
            ),
        })

    def _run() -> dict[str, Any]:
        job.set("overlay-prepare", 0.1, f"Loading overlay '{overlay_name}'")
        features, kept_idx, n_original = _overlay_apply_transforms(job, ov_frame, name_to_col)
        job.set("overlay-prepare", 0.9, f"Stored {len(features):,} overlay rows")
        job.overlays[layer_id] = _OverlayState(overlay_name, features, kept_idx, n_original)
        return {
            "layerId": layer_id,
            "nRows": n_original,
            "nKept": int(len(features)),
            "dims": int(features.shape[1]),
        }

    job.run(f"overlay-prepare-{layer_id}", _run)
    return _json({"ok": True, "jobId": job.id})


def _write_overlay_xy_chunks(job: _Job, layer_id: str, xy: np.ndarray, chunk_rows: int = 1_000_000) -> int:
    """Write overlay xy chunks and add them to job.outputs with the layerId tag."""
    ndim = int(xy.shape[1]) if xy.ndim == 2 else 2
    n_files = 0
    safe_id = layer_id.replace("/", "_").replace("\\", "_")
    for start in range(0, len(xy), chunk_rows):
        stop = min(len(xy), start + chunk_rows)
        fname = f"overlay_{safe_id}_xy_{n_files:04d}.f32"
        _write(job, fname, xy[start:stop])
        job.add_output(kind="overlayXy", file=fname, dtype="f32", shape=[stop - start, ndim], offset=start, layerId=layer_id)
        n_files += 1
    return n_files


def _project_overlay_impl(job: _Job, layer_id: str, anchor_xy: np.ndarray, opts: dict[str, Any]) -> dict[str, Any]:
    """Place overlay rows via the base anchor index."""
    ov = job.overlays.get(layer_id)
    if ov is None:
        raise RuntimeError(f"No overlay prepared for layer '{layer_id}'. Call prepare_overlay first.")
    if job.anchors is None or job.anchor_pos is None:
        raise RuntimeError("Base job anchors not available. Run prepare and project on the base DataFrame first.")

    x = ov.features
    n = len(x)
    k = int(opts.get("k", 10))
    metric = str(opts.get("metric", "euclidean"))
    cosine = metric == "cosine"
    seed = int(opts.get("seed", 0))
    core = _native_core() if opts.get("native", True) else None

    # Detect output dimensions from anchor_xy.
    n_anchors = len(job.anchor_pos)
    ndim = int(anchor_xy.size // max(n_anchors, 1)) if n_anchors > 0 else 2
    if ndim not in (2, 3):
        ndim = 2
    anchor_xy_2d = np.ascontiguousarray(anchor_xy, dtype=np.float32).reshape(-1, ndim)
    anchors = job.anchors

    job.set("overlay-project", 0.0, f"Placing {n:,} overlay rows")
    t0 = time.time()

    if core is not None:
        if not (x.dtype == np.float32 and x.flags.c_contiguous):
            x = np.ascontiguousarray(x, dtype=np.float32)
        index = core.Index(anchors, seed=seed, cosine=cosine)
        xy_all = np.empty((n, ndim), dtype=np.float32)
        all_pos = np.arange(n, dtype=np.int64)
        core_ok = index.place(x, all_pos, anchor_xy_2d, xy_all, k)
        if not core_ok:
            raise _Cancelled()
    else:
        if cosine:
            anc_norm = anchors / np.maximum(np.linalg.norm(anchors, axis=1, keepdims=True), 1e-12)
        else:
            anc_norm = anchors
        index = AnchorIndex(anc_norm, seed=seed)
        q = np.ascontiguousarray(x, dtype=np.float32)
        if cosine:
            q = q / np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
        BLOCK = 65_536
        xy_all = np.empty((n, ndim), dtype=np.float32)
        for s in range(0, n, BLOCK):
            e = min(n, s + BLOCK)
            ii, dd = index.query(q[s:e], k)
            xy_all[s:e] = place_from_neighbors(ii, dd, anchor_xy_2d)
            job.set("overlay-project", e / n, f"Placed {e:,}/{n:,} overlay rows")

    job.set("overlay-project", 0.95, "Writing overlay coordinates")
    ov.xy = xy_all
    n_files = _write_overlay_xy_chunks(job, layer_id, xy_all)
    return {
        "layerId": layer_id,
        "nRows": n,
        "files": n_files,
        "seconds": time.time() - t0,
    }


@_guard
def project_overlay(job_id: str, layer_id: str, anchor_xy_path: str, opts_json: str = "{}") -> str:
    """Place the prepared overlay rows via the base anchor index.

    ``anchor_xy_path`` is the path to the base anchor XY file (the same file passed to project).
    Heavy work runs in the job thread.
    """
    job = _get(job_id)
    if layer_id not in job.overlays:
        return _json({"ok": False, "error": f"No overlay prepared for layer '{layer_id}'. Call prepare_overlay first."})
    opts = json.loads(opts_json)
    anchor_xy = np.fromfile(anchor_xy_path, dtype="<f4")
    job.run(f"overlay-project-{layer_id}", lambda: _project_overlay_impl(job, layer_id, anchor_xy, opts))
    return _json({"ok": True, "jobId": job.id})


@_guard
def remove_overlay(job_id: str, layer_id: str) -> str:
    """Remove an overlay layer from the job, freeing its cached features and XY data."""
    job = _get(job_id)
    removed = layer_id in job.overlays
    if removed:
        del job.overlays[layer_id]
    return _json({"ok": True, "removed": removed})


@_guard
def overlay_rows(job_id: str, layer_id: str, indices: list[int], columns: list[int] | None = None) -> str:
    """Fetch row values from an overlay DataFrame for the given overlay-position indices.

    ``indices`` are positions in the overlay's projected XY array.
    Maps them through ``kept_idx`` to original row positions, then fetches column
    values from the overlay variable (re-resolved on each call, same as the base ``rows``).

    Returns a mapping from overlay-position index (string key) to list of (name, value) pairs,
    in the same format as ``rows``.
    """
    job = _get(job_id)
    overlay = job.overlays.get(layer_id)
    if overlay is None:
        return _json({"ok": False, "error": f"Overlay layer '{layer_id}' not found."})
    try:
        ov_obj = _resolve(overlay.name)
        ov_frame = _make_frame(ov_obj)
    except Exception as e:  # noqa: BLE001
        return _json({"ok": False, "error": f"Cannot load overlay variable '{overlay.name}': {type(e).__name__}: {e}"})

    names = ov_frame.column_names()
    col_indices = ([int(c) for c in columns] if columns else list(range(len(names))))
    col_set = set(col_indices)
    result: dict[str, list[tuple[str, str]]] = {}
    for i in indices:
        idx = int(i)
        if 0 <= idx < len(overlay.kept_idx):
            orig = int(overlay.kept_idx[idx])
            all_vals = ov_frame.row(orig)
            result[str(idx)] = [(k, v) for j, (k, v) in enumerate(all_vals) if j in col_set][:200]
    return _json({"ok": True, "values": result})


def _write_xy_chunks(job: _Job, xy: np.ndarray, chunk_rows: int = 1_000_000) -> int:
    ndim = int(xy.shape[1]) if xy.ndim == 2 else 2  # T2: carry actual dims to shape metadata
    n_files = 0
    for start in range(0, len(xy), chunk_rows):
        stop = min(len(xy), start + chunk_rows)
        fname = f"xy_{n_files:04d}.f32"
        _write(job, fname, xy[start:stop])
        job.add_output(kind="xy", file=fname, dtype="f32", shape=[stop - start, ndim], offset=start)
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
        n_components=int(params.get("dims", 2)),  # T2: 2D or 3D output
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
        "n_components": int(params.get("dims", 2)),  # T2: 2D or 3D output
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
    ndim = int(params.get("dims", 2))  # T2: 2D or 3D
    out = pl.DataFrame([vectors]).select(xy=pu.umap("features", **_polars_umap_args(params)))
    xy = np.ascontiguousarray(out["xy"].to_numpy(), dtype=np.float32).reshape(n, ndim)
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
    if job.nbr_caches:
        k = next(iter(job.nbr_caches.keys()))[1]  # cached k
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
def sizes(job_id: str, col: int) -> str:
    """Float32 column values for size-by-column (A10).

    Returns the numeric column values for the prepared rows as float32, suitable for
    square-root scaling on the webview side. NaN for missing values.
    """
    job = _get(job_id)
    if job.kept_idx is None:
        raise RuntimeError("Run prepare first.")
    col = int(col)
    dtype_str, kind = job.frame.column_kind(col)
    if kind not in ("numeric", "bool"):
        raise ValueError(f"Column {col} is {kind}; size-by requires a numeric or boolean column.")
    vals = job.frame.column(col, job.kept_idx)
    fv = _to_float(vals, kind).astype(np.float32)
    finite = fv[np.isfinite(fv)]
    q01, q99 = (np.percentile(finite, [1, 99]) if len(finite) >= 2 else (float(finite[0]), float(finite[0])) if len(finite) == 1 else (0.0, 0.0))
    meta = {
        "kind": "numeric",
        "min": float(finite.min()) if len(finite) else 0.0,
        "q01": float(q01),
        "q99": float(q99),
        "max": float(finite.max()) if len(finite) else 0.0,
        "nullCount": int(len(fv) - len(finite)),
    }
    fname = f"sizes_{col}_{uuid.uuid4().hex[:6]}.f32"
    _write(job, fname, fv)
    return _json({"ok": True, "file": fname, "dtype": "f32", "meta": meta, "length": int(len(fv))})


@_guard
def hist_values(job_id: str, col: int) -> str:
    """Float32 column values for the histogram filter (A13).

    Returns the raw numeric column values for the prepared rows, allowing the webview to
    check per-point membership in the brush range.
    """
    job = _get(job_id)
    if job.kept_idx is None:
        raise RuntimeError("Run prepare first.")
    col = int(col)
    dtype_str, kind = job.frame.column_kind(col)
    if kind not in ("numeric", "bool", "datetime"):
        raise ValueError(f"Column {col} is {kind}; histogram filter requires a numeric or datetime column.")
    vals = job.frame.column(col, job.kept_idx)
    fv = _to_float(vals, kind).astype(np.float32)
    fname = f"histvals_{col}_{uuid.uuid4().hex[:6]}.f32"
    _write(job, fname, fv)
    return _json({"ok": True, "file": fname, "dtype": "f32", "length": int(len(fv))})


@_guard
def histogram(job_id: str, col: int, n_bins: int = 50) -> str:
    """Pre-compute histogram bins for a numeric or datetime column (A13).

    Returns ``n_bins`` uniform bins spanning the 1st–99th percentile of the prepared rows.
    For datetime columns the edges are ms-since-epoch (float64, as float32).
    """
    job = _get(job_id)
    if job.kept_idx is None:
        raise RuntimeError("Run prepare first.")
    col = int(col)
    n_bins = max(2, min(int(n_bins), 500))
    dtype_str, kind = job.frame.column_kind(col)
    if kind not in ("numeric", "bool", "datetime"):
        raise ValueError(f"Column {col} is {kind}; histogram requires a numeric or datetime column.")
    vals = job.frame.column(col, job.kept_idx)
    fv = _to_float(vals, kind)
    if kind == "datetime":
        # Convert ns → ms for JS Date compatibility.
        fv = fv / 1e6
    finite = fv[np.isfinite(fv)]
    if len(finite) < 2:
        edges = [0.0, 1.0]
        counts = [int(len(finite))]
    else:
        lo, hi = np.percentile(finite, [0.5, 99.5])
        if lo == hi:
            lo = float(finite.min())
            hi = float(finite.max())
        if lo == hi:
            hi = lo + 1.0
        edges_arr = np.linspace(lo, hi, n_bins + 1)
        counts_arr, _ = np.histogram(finite, bins=edges_arr)
        edges = edges_arr.tolist()
        counts = counts_arr.tolist()
    return _json({
        "ok": True,
        "data": {
            "edges": edges,
            "counts": counts,
            "isDatetime": kind == "datetime",
        },
    })


@_guard
def anchor_umap(job_id: str, params_json: str = "{}") -> str:
    """Run polars-umap on the anchor rows only (P3: kernel anchors compute mode).

    Runs polars-umap on ``job.anchors`` (shape [nAnchors, dims]) and writes the result
    as ``anchor_xy.f32`` to the job dir.  The webview then proceeds with normal placement.
    Requires polars-umap to be installed; raises RuntimeError otherwise.
    """
    job = _get(job_id)
    if job.anchors is None or job.anchor_pos is None:
        raise RuntimeError("Run prepare first.")
    try:
        import polars as pl
        import polars_umap as pu  # type: ignore
    except ImportError as e:
        raise RuntimeError("polars-umap is not installed in this Python environment.") from e
    params = json.loads(params_json)
    ndim = int(params.get("dims", 2))  # T2: 2D or 3D output
    n = len(job.anchors)
    t0 = time.time()
    vectors = pl.Series("features", np.ascontiguousarray(job.anchors, dtype=np.float32))
    out = pl.DataFrame([vectors]).select(xy=pu.umap("features", **_polars_umap_args(params)))
    xy = np.ascontiguousarray(out["xy"].to_numpy(), dtype=np.float32).reshape(n, ndim)
    fname = f"anchor_xy_{uuid.uuid4().hex[:6]}.f32"
    _write(job, fname, xy)
    return _json({"ok": True, "file": fname, "dtype": "f32", "shape": [n, ndim], "length": n * ndim, "seconds": time.time() - t0})


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
def rows(job_id: str, indices: list[int], columns: list[int] | None = None, image_columns: list[int] | None = None) -> str:
    """Fetch several rows at once for the hover cache/prefetch (H3/H4) and image annotations (A4).

    Returns a mapping from prepared-row index to list of (name, value) pairs.
    If ``columns`` is given, only those column indices are returned.
    If ``image_columns`` is given, pixel values for those columns are also returned as ``images``.
    """
    job = _get(job_id)
    if job.kept_idx is None:
        raise RuntimeError("Run prepare first.")
    frame = job.frame
    names = frame.column_names()
    col_indices = ([int(c) for c in columns] if columns else list(range(len(names))))
    col_set = set(col_indices)
    result: dict[str, list[tuple[str, str]]] = {}
    for i in indices:
        orig = int(job.kept_idx[int(i)])
        all_vals = frame.row(orig)
        filtered = [(k, v) for j, (k, v) in enumerate(all_vals) if j in col_set][:200]
        result[str(i)] = filtered
    if image_columns:
        img_cols = [int(c) for c in image_columns]
        images: dict[str, list[float]] = {}
        orig_indices = np.array([int(job.kept_idx[int(i)]) for i in indices])
        block = frame.block(img_cols, orig_indices)
        for idx, i in enumerate(indices):
            images[str(i)] = [round(float(v), 4) for v in block[idx]]
        return _json({"ok": True, "values": result, "images": images})
    return _json({"ok": True, "values": result})


@_guard
def texts(job_id: str, column: int, max_chars: int = 120) -> str:
    """Write UTF-8 text values of a column to a file for preloading (H5).

    Writes two files to the job directory:
    - ``texts_<col>_<uuid>.utf8``: concatenated UTF-8 strings (each truncated to max_chars chars)
    - ``texts_<col>_<uuid>.u32``: u32 start offsets (len = nKept + 1 for end of last string)

    Returns the file names, length (number of prepared rows) and the total byte count.
    Budget: if the total UTF-8 bytes exceed 64 MB, raises an error (the caller falls back
    to per-row fetching).
    """
    BUDGET_BYTES = 64 * 1024 * 1024
    job = _get(job_id)
    if job.kept_idx is None:
        raise RuntimeError("Run prepare first.")
    mc = max(1, int(max_chars))
    frame = job.frame
    col_vals = frame.column(int(column), job.kept_idx)
    # Encode each value as truncated UTF-8.
    parts: list[bytes] = []
    for v in col_vals:
        if _is_null(v):
            s = ""
        else:
            s = _fmt(v, mc)
        parts.append(s.encode("utf-8"))
    total_bytes = sum(len(p) for p in parts)
    if total_bytes > BUDGET_BYTES:
        return _json({"ok": False, "error": f"texts column {column} exceeds 64 MB budget ({total_bytes} bytes); will fetch per row"})
    uid = uuid.uuid4().hex[:6]
    utf8_name = f"texts_{int(column)}_{uid}.utf8"
    offsets_name = f"texts_{int(column)}_{uid}.u32"
    # Build offset array (u32, n+1 entries).
    n = len(parts)
    offsets = np.zeros(n + 1, dtype="<u4")
    pos = 0
    for i, p in enumerate(parts):
        offsets[i] = pos
        pos += len(p)
    offsets[n] = pos
    # Write raw bytes for the UTF-8 blob; use the same atomic rename pattern as _write.
    utf8_path = job.path(utf8_name)
    tmp_utf8 = utf8_path + ".tmp"
    with open(tmp_utf8, "wb") as f:
        for p in parts:
            f.write(p)
    os.replace(tmp_utf8, utf8_path)
    _write(job, offsets_name, offsets)
    return _json({"ok": True, "utf8File": utf8_name, "offsetsFile": offsets_name, "count": n, "bytes": int(total_bytes)})


@_guard
def search(job_id: str, column: int, query: str, limit: int = 100_000, opts_json: str = "{}") -> str:
    """Search a text column of the prepared rows for a substring or regex (A7).

    Returns kept-row indices (u32) of matching rows.  The result is a binary
    file of little-endian uint32 values written into the job directory.

    Vectorized per frame type:
      pandas  → Series.str.contains(case=False, na=False)
      polars  → Series.str.contains(re.IGNORECASE pattern)
      narwhals/other → numpy generic fallback

    Parameters
    ----------
    job_id  : str
    column  : int   – column index in the prepared frame
    query   : str   – search string (substring or regex)
    limit   : int   – cap on the number of returned indices (default 100 000)
    opts_json : str – ``{"regex": false}``
    """
    if not query:
        return _json({"ok": True, "file": None, "count": 0})
    opts = json.loads(opts_json)
    regex = bool(opts.get("regex", False))
    limit = int(limit)
    job = _get(job_id)
    if job.kept_idx is None:
        raise RuntimeError("Run prepare first.")
    frame = job.frame
    col = int(column)

    # Try native vectorized search per frame kind.
    if frame.kind == "pandas":
        import pandas as pd

        col_name = frame.column_names()[col]
        series = frame.obj[col_name].iloc[job.kept_idx]
        mask = series.str.contains(query, case=False, regex=regex, na=False).to_numpy(dtype=bool, na_value=False)
    elif frame.kind == "polars":
        import polars as pl
        import re as _re

        col_name = frame.column_names()[col]
        series = frame.obj[col_name].gather(job.kept_idx)
        # Polars str.contains is always regex; build a case-insensitive pattern.
        pat = query if regex else _re.escape(query)
        pat_ci = f"(?i){pat}"
        try:
            mask = series.str.contains(pat_ci).to_numpy(dtype=bool)
        except Exception:  # noqa: BLE001
            # Fallback: numpy generic
            vals = series.to_numpy(allow_copy=True)
            mask = _search_numpy(vals, query, regex)
    else:
        # narwhals / generic: fetch column values and search with numpy
        vals = frame.column(col, job.kept_idx)
        mask = _search_numpy(vals, query, regex)

    # Collect matched kept-row indices (position in the prepared rows array).
    matched = np.where(mask)[0].astype(np.uint32)
    if len(matched) > limit:
        matched = matched[:limit]
    if len(matched) == 0:
        return _json({"ok": True, "file": None, "count": 0})
    uid = uuid.uuid4().hex[:6]
    fname = f"search_{col}_{uid}.u32"
    _write(job, fname, matched)
    return _json({"ok": True, "file": fname, "count": int(len(matched))})


def _search_numpy(vals: np.ndarray, query: str, regex: bool) -> np.ndarray:
    """Case-insensitive substring/regex search on a numpy object array."""
    import re as _re

    if regex:
        try:
            pat = _re.compile(query, _re.IGNORECASE)
        except _re.error:
            pat = _re.compile(_re.escape(query), _re.IGNORECASE)
        mask = np.array([bool(pat.search(str(v))) if not _is_null(v) else False for v in vals], dtype=bool)
    else:
        q_lower = query.lower()
        mask = np.array([q_lower in str(v).lower() if not _is_null(v) else False for v in vals], dtype=bool)
    return mask


@_guard
def export_datamapplot(job_id: str, output_path: str, opts_json: str = "{}", xy_path: str | None = None) -> str:
    """Export the map as an interactive DataMapPlot HTML file (D3/D12).

    Calls ``datamapplot.create_interactive_plot()`` with the placed coordinates
    and optional label/hover-text layers, then saves the result to output_path.

    opts_json keys:
      labelColumn   : int | null  – column index for map labels (or null)
      titleColumn   : int | null  – column index for hover text (or null)
      title         : str         – map title (or omitted)

    xy_path: optional path to a little-endian float32 file of shape (nKept, 2).
      Used when the browser ran UMAP locally (job.xy is None in the kernel).
    """
    import importlib.util

    # find_spec raises ValueError when the module is in sys.modules but has __spec__ = None
    # (e.g. a manually installed stub used in tests).  Fall back to checking sys.modules.
    try:
        _dmp_available = importlib.util.find_spec("datamapplot") is not None
    except (ValueError, AttributeError):
        _dmp_available = "datamapplot" in sys.modules

    if not _dmp_available:
        raise RuntimeError("datamapplot is not installed; install it with 'pip install datamapplot'.")
    import datamapplot

    opts = json.loads(opts_json)
    job = _get(job_id)
    if job.kept_idx is None:
        raise RuntimeError("Run prepare first.")

    # Get coordinates: prefer the caller-supplied file (browser UMAP), then in-memory job.xy.
    if xy_path:
        xy = np.fromfile(xy_path, dtype="<f4").reshape(-1, 2)
    elif job.xy is not None:
        xy = job.xy  # (nKept, 2) float32
    else:
        raise RuntimeError("No coordinates available; run UMAP first.")

    label_col = opts.get("labelColumn")
    title_col = opts.get("titleColumn")
    title = opts.get("title") or None
    label_color_map = opts.get("labelColorMap")  # {category: hex} or None

    frame = job.frame
    kwargs: dict[str, Any] = {}
    if title:
        kwargs["title"] = str(title)

    label_layers: list[Any] = []
    if label_col is not None:
        raw = frame.column(int(label_col), job.kept_idx)
        labels = np.array([str(v) if not _is_null(v) else "Unlabelled" for v in raw], dtype=object)
        label_layers.append(labels)
        kwargs["noise_label"] = "Unlabelled"
        # Pass the Atlas categorical colour palette so DataMapPlot uses matching colours.
        if label_color_map and isinstance(label_color_map, dict):
            kwargs["label_color_map"] = {str(k): str(v) for k, v in label_color_map.items()}

    if title_col is not None:
        raw = frame.column(int(title_col), job.kept_idx)
        hover_texts = np.array([str(v) if not _is_null(v) else "" for v in raw], dtype=object)
        kwargs["hover_text"] = hover_texts

    plot = datamapplot.create_interactive_plot(xy, *label_layers, **kwargs)
    # Ensure the output directory exists.
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    plot.save(output_path)
    return _json({"ok": True, "path": output_path})


@_guard
def add_coordinates(job_id: str, xy_path: str, x_name: str = "umap_x", y_name: str = "umap_y", z_name: str = "umap_z") -> str:
    """Write coordinates back into the user's DataFrame (NaN for rows not shown).

    T6: When the UMAP result has 3 columns, also writes a umap_z column.
    """
    job = _get(job_id)
    if job.kept_idx is None:
        raise RuntimeError("Run prepare first.")
    _require_unchanged(job)
    if xy_path:
        raw = np.fromfile(xy_path, dtype="<f4")
        ndim = int(raw.size // max(len(job.kept_idx), 1))
        if ndim not in (2, 3):
            ndim = 2
        xy = raw.reshape(-1, ndim)
    elif job.xy is not None:
        xy = job.xy
        ndim = int(xy.shape[1]) if xy.ndim == 2 else 2
    else:
        raise RuntimeError("No projected coordinates available; pass a coordinate file.")
    if len(xy) != len(job.kept_idx):
        raise ValueError("Coordinate count does not match the prepared rows.")
    n = job.frame.n_rows
    full = np.full((n, ndim), np.nan, dtype=np.float32)
    full[job.kept_idx] = xy
    ns = _user_ns()
    col_names = [x_name, y_name] + ([z_name] if ndim == 3 else [])
    if job.frame.kind == "pandas":
        job.frame.obj[x_name] = full[:, 0]
        job.frame.obj[y_name] = full[:, 1]
        if ndim == 3:
            job.frame.obj[z_name] = full[:, 2]
        target = job.name
        # Our own change (new columns), not the user's: keep the job current.
        job.shape_at_start = (job.frame.n_rows, job.frame.n_cols)
    elif job.frame.kind == "polars":
        import polars as pl

        series = [pl.Series(x_name, full[:, 0]), pl.Series(y_name, full[:, 1])]
        if ndim == 3:
            series.append(pl.Series(z_name, full[:, 2]))
        new = job.frame.obj.with_columns(*series)
        target = job.name if job.name.isidentifier() else "atlas_result"
        ns[target] = new
        job.frame = _Frame(new)
        job.shape_at_start = (job.frame.n_rows, job.frame.n_cols)
    else:
        # narwhals generic path
        assert isinstance(job.frame, _NarwhalsFrame)
        job.frame.add_column_writeback(x_name, full[:, 0])
        job.frame.add_column_writeback(y_name, full[:, 1])
        if ndim == 3:
            job.frame.add_column_writeback(z_name, full[:, 2])
        target = job.name if job.name.isidentifier() else "atlas_result"
        ns[target] = job.frame._native
        job.shape_at_start = (job.frame.n_rows, job.frame.n_cols)
    return _json({"ok": True, "variable": target, "columns": col_names})


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


@_guard
def overlay_selection_frame(job_id: str, layer_id: str, mask_path: str) -> str:
    """Create a new variable from the selected rows of an overlay layer.

    mask_path: packed-bits file over overlay position indices (nKept rows).
    Returns {ok, variable, rows} like selection_frame.
    """
    job = _get(job_id)
    overlay = job.overlays.get(layer_id)
    if overlay is None:
        return _json({"ok": False, "error": f"Overlay layer '{layer_id}' not found."})
    n = len(overlay.kept_idx)
    packed = np.fromfile(mask_path, dtype=np.uint8)
    if len(packed) != (n + 7) // 8:
        return _json({"ok": False, "error": f"Mask has {len(packed) * 8} bits for {n} overlay rows."})
    mask = np.unpackbits(packed, bitorder="little")[:n].astype(bool)
    orig_indices = np.sort(overlay.kept_idx[mask])
    if len(orig_indices) == 0:
        return _json({"ok": False, "error": "Nothing is selected in this overlay."})
    try:
        ov_obj = _resolve(overlay.name)
        ov_frame = _make_frame(ov_obj)
    except Exception as e:  # noqa: BLE001
        return _json({"ok": False, "error": f"Cannot load overlay variable '{overlay.name}': {e}"})
    ns = _user_ns()
    base = overlay.name if overlay.name.isidentifier() else "atlas_selection"
    name = _unique_name(f"{base}_selection", ns)
    if ov_frame.kind == "pandas":
        ns[name] = ov_obj.iloc[orig_indices].copy()
    elif ov_frame.kind == "polars":
        ns[name] = ov_obj[orig_indices]
    else:
        try:
            native = ov_frame.obj.to_native()
            ns[name] = native[orig_indices.tolist()]
        except Exception:  # noqa: BLE001
            ns[name] = ov_frame.obj[orig_indices.tolist()].to_native()
    return _json({"ok": True, "variable": name, "rows": int(len(orig_indices))})


def describe_overlay(job_id: str, layer_id: str) -> str:
    """Return column descriptions for an overlay layer's source variable.

    Used by the webview to populate search/filter column pickers for overlay layers.
    Returns {ok, columns} where columns matches the ColumnInfo protocol shape.
    """
    job = _get(job_id)
    overlay = job.overlays.get(layer_id)
    if overlay is None:
        return _json({"ok": False, "error": f"Overlay layer '{layer_id}' not found."})
    try:
        ov_obj = _resolve(overlay.name)
        frame = _make_frame(ov_obj)
    except Exception as e:  # noqa: BLE001
        return _json({"ok": False, "error": str(e)})
    cols = []
    for j, cname in enumerate(frame.column_names()):
        dtype, kind = frame.column_kind(j)
        cols.append({"index": j, "name": cname, "dtype": dtype, "kind": kind, "null_frac": None, "n_unique_est": None})
    return _json({"ok": True, "columns": cols})


def search_overlay(job_id: str, layer_id: str, column: int, query: str, limit: int = 100_000) -> str:
    """Search a text column of an overlay layer for a substring.

    Returns overlay position indices (u32) of matching rows, written to a temp file.
    """
    if not query:
        return _json({"ok": True, "file": None, "count": 0})
    job = _get(job_id)
    overlay = job.overlays.get(layer_id)
    if overlay is None:
        return _json({"ok": False, "error": f"Overlay layer '{layer_id}' not found."})
    try:
        ov_obj = _resolve(overlay.name)
        frame = _make_frame(ov_obj)
    except Exception as e:  # noqa: BLE001
        return _json({"ok": False, "error": str(e)})
    try:
        col = int(column)
        q = str(query)
        q_low = q.lower()
        if frame.kind == "pandas":
            col_name = frame.column_names()[col]
            series = frame.obj[col_name].iloc[overlay.kept_idx]
            mask_arr = series.str.contains(q, case=False, regex=False, na=False)
            mask_bool = np.asarray(mask_arr, dtype=bool)
        elif frame.kind == "polars":
            import re as _re
            col_name = frame.column_names()[col]
            series = frame.obj[col_name].gather(overlay.kept_idx)
            try:
                mask_bool = series.str.contains(f"(?i){_re.escape(q)}").to_numpy(dtype=bool)
            except Exception:  # noqa: BLE001
                vals = np.array(series.to_list(), dtype=object)
                mask_bool = np.array([isinstance(v, str) and q_low in v.lower() for v in vals], dtype=bool)
        else:
            vals = np.array([frame.column(col, np.array([i], dtype=np.intp))[0] for i in overlay.kept_idx], dtype=object)
            mask_bool = np.array([isinstance(v, str) and q_low in v.lower() for v in vals], dtype=bool)
        pos_indices = np.where(mask_bool)[0].astype(np.uint32)
        if len(pos_indices) > limit:
            pos_indices = pos_indices[:limit]
        fname = f"search_overlay_{layer_id}_{int(time.time() * 1000)}.u32"
        fpath = os.path.join(job.dir, fname)
        pos_indices.astype("<u4").tofile(fpath)
        return _json({"ok": True, "file": fname, "count": int(len(pos_indices))})
    except Exception as e:  # noqa: BLE001
        return _json({"ok": False, "error": str(e)})


def hist_values_overlay(job_id: str, layer_id: str, column: int) -> str:
    """Return float32 values for a numeric column of an overlay layer.

    Used for the histogram filter on overlay layers.
    """
    job = _get(job_id)
    overlay = job.overlays.get(layer_id)
    if overlay is None:
        return _json({"ok": False, "error": f"Overlay layer '{layer_id}' not found."})
    try:
        ov_obj = _resolve(overlay.name)
        frame = _make_frame(ov_obj)
    except Exception as e:  # noqa: BLE001
        return _json({"ok": False, "error": str(e)})
    col = int(column)
    vals_raw = frame.column(col, overlay.kept_idx)
    dtype, kind = frame.column_kind(col)
    fv = _to_float(vals_raw, kind).astype(np.float32)
    fname = f"hist_ov_{layer_id}_{col}_{int(time.time() * 1000)}.f32"
    fpath = os.path.join(job.job_dir, fname)
    fv.astype("<f4").tofile(fpath)
    return _json({"ok": True, "file": fname, "dtype": "f32", "length": len(fv)})


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


# ---------------------------------------------------------------------------
# C2 — Time slider + tracks (items 10 and 11)
# ---------------------------------------------------------------------------


@_guard
def time_values(job_id: str, col: int) -> str:
    """Return normalised float32 column values for the animate time-slider (C2, item 10).

    Reads the column at index col from the kept rows, normalises to [0,1], and writes
    a little-endian float32 binary file to the job directory.
    Returns {"ok": True, "file": path, "min": float, "max": float, "length": int}.
    """
    job = _get(job_id)
    col = int(col)
    rows = job.kept_idx if job.kept_idx is not None else np.arange(job.frame.n_rows)
    vals = job.frame.column(col, rows)
    _, kind = job.frame.column_kind(col)
    fv = _to_float(vals, kind)
    lo = float(np.nanmin(fv)) if fv.size else 0.0
    hi = float(np.nanmax(fv)) if fv.size else 1.0
    if hi == lo:
        hi = lo + 1.0
    normed = ((fv - lo) / (hi - lo)).astype(np.float32)
    normed = np.clip(normed, 0.0, 1.0)
    fname = f"time_values_{uuid.uuid4().hex[:8]}.f32"
    _write(job, fname, normed)
    return _json({"ok": True, "file": fname, "min": lo, "max": hi, "length": int(len(normed))})


@_guard
def tracks(job_id: str, id_col: int, time_col: int, nd: int = 2, xy_path: str = '') -> str:
    """Build track paths sorted by ID then time (C2, item 11).

    Groups kept rows by id_col, sorts within each group by time_col, and writes 5 binary
    files: xy coords, starts (u32), lengths (u32), time values (f32), id index (u32).
    Returns {"ok": True, "xy_file": ..., "starts_file": ..., "lengths_file": ...,
             "time_file": ..., "id_file": ..., "id_colors": [...], "n_tracks": int, "n_points": int}.

    xy_path: optional path to a float32 file with anchorXY from the browser (used when
             job.xy is not set, e.g. browser-side UMAP with needsProjection=False).
    """
    # Matplotlib-free tab20 palette (same 20 colours as matplotlib's tab20).
    _TAB20 = [
        (31, 119, 180), (174, 199, 232), (255, 127, 14), (255, 187, 120),
        (44, 160, 44),  (152, 223, 138), (214, 39, 40),  (255, 152, 150),
        (148, 103, 189),(197, 176, 213), (140, 86, 75),  (196, 156, 148),
        (227, 119, 194),(247, 182, 210), (127, 127, 127),(199, 199, 199),
        (188, 189, 34), (219, 219, 141), (23, 190, 207), (158, 218, 229),
    ]

    job = _get(job_id)
    id_col, time_col, nd = int(id_col), int(time_col), int(nd)
    rows = job.kept_idx if job.kept_idx is not None else np.arange(job.frame.n_rows)
    n = len(rows)

    ids_raw = job.frame.column(id_col, rows)
    times_raw = job.frame.column(time_col, rows)
    _, time_kind = job.frame.column_kind(time_col)
    times_f64 = _to_float(np.asarray(times_raw), time_kind)

    # Lexsort: primary key = ids, secondary = times (stable sort within each id).
    ids_arr = np.asarray(ids_raw, dtype=object)
    unique_ids, inv = np.unique(ids_arr, return_inverse=True)
    order = np.lexsort((times_f64, inv.astype(np.int64)))

    ids_s = inv[order].astype(np.uint32)
    times_s = times_f64[order]
    # Normalised to 0-1 over all rows (the webview colours by time with it); NaN -> 0.
    finite = np.isfinite(times_s)
    if finite.any():
        t_lo, t_hi = float(times_s[finite].min()), float(times_s[finite].max())
        times_s = (times_s - t_lo) / (t_hi - t_lo) if t_hi > t_lo else np.zeros_like(times_s)
    times_s = np.where(np.isfinite(times_s), times_s, 0.0).astype(np.float32)
    unique_ids_int, starts_arr, lengths_arr = np.unique(ids_s, return_index=True, return_counts=True)
    n_tracks = int(len(unique_ids_int))
    n_points = int(n)

    # XY layout: prefer job.xy (kernel UMAP / coords mode).
    # Fall back to the caller-supplied xy_path (browser-side UMAP, needsProjection=False).
    if job.xy is not None:
        job_xy: np.ndarray = job.xy
    elif xy_path:
        raw = np.fromfile(xy_path, dtype="<f4")
        # Infer actual nd from the file size and number of rows; don't trust the
        # requested nd (e.g. setDims(3) may be called before the 3D UMAP completes).
        n_rows_total = len(rows)
        actual_nd = int(raw.size // n_rows_total) if n_rows_total > 0 and raw.size % n_rows_total == 0 else int(nd)
        job_xy = raw.reshape(n_rows_total, actual_nd)
    else:
        return _json({"ok": False, "error": "Layout not ready — run UMAP first"})
    xy_s = job_xy[order, :nd].astype(np.float32)
    xy_flat = xy_s.ravel()

    # Per-track colours cycling through tab20.
    id_colors: list[int] = []
    for i in range(n_tracks):
        r, g, b = _TAB20[i % len(_TAB20)]
        id_colors.extend([r, g, b, 255])

    suffix = uuid.uuid4().hex[:8]
    xy_file = f"tracks_xy_{suffix}.f32"
    starts_file = f"tracks_starts_{suffix}.u32"
    lengths_file = f"tracks_lengths_{suffix}.u32"
    time_file = f"tracks_time_{suffix}.f32"
    id_file = f"tracks_ids_{suffix}.u32"
    _write(job, xy_file, xy_flat)
    _write(job, starts_file, starts_arr.astype(np.uint32))
    _write(job, lengths_file, lengths_arr.astype(np.uint32))
    _write(job, time_file, times_s)
    _write(job, id_file, ids_s)

    return _json({
        "ok": True,
        "xy_file": xy_file,
        "starts_file": starts_file,
        "lengths_file": lengths_file,
        "time_file": time_file,
        "id_file": id_file,
        "id_colors": id_colors,
        "n_tracks": n_tracks,
        "n_points": n_points,
    })


# ---------------------------------------------------------------------------
# C3 — Python API for programmatic Atlas control
#
# Transport: Positron comms (target_name='positron.atlas').
# - Kernel → host: comm.send({name, cmdId, args, ...})
# - Host → kernel: on_msg receives {type: 'selectionChanged', ...}
# - save_png / save_html: host writes <api_dir>/<cmdId>.json; Python polls.
#
# Usage:
#   import positron_atlas as atlas
#   m = atlas.open(df)          # opens a comm, returns immediately
#   m.color_by('cluster')       # fire-and-forget via comm.send
#   m.save_png('/tmp/x.png')    # blocks via filesystem polling (up to 60s)
#   m.selected_rows             # updated via on_msg (between cells)
# ---------------------------------------------------------------------------

import base64
import pathlib
import tempfile

# Active handles keyed by comm_id.
_HANDLES: dict[str, "_AtlasHandle"] = {}


class SaveRequest:
    """A pending ``save_png`` / ``save_html``: check ``done`` and ``error`` in a later cell."""

    def __init__(self, path: pathlib.Path, status: pathlib.Path) -> None:
        self.path = path
        self._status = status
        self._result: dict | None = None

    def _read(self) -> dict | None:
        if self._result is None and self._status.exists():
            try:
                self._result = json.loads(self._status.read_text())
            except (json.JSONDecodeError, OSError):
                return None
        return self._result

    @property
    def done(self) -> bool:
        """True once the host has written the file (or failed)."""
        return self._read() is not None

    @property
    def error(self) -> str | None:
        """The error message if the save failed, else None."""
        r = self._read()
        return None if r is None or r.get("ok") else (r.get("error") or "save failed")

    def __repr__(self) -> str:
        state = "pending" if not self.done else ("failed: " + self.error if self.error else "saved")
        return f"<SaveRequest {self.path} {state}>"


class _AtlasHandle:
    """Python-facing handle for one Atlas panel (C3).

    Commands are sent immediately as comm messages.  Blocking commands
    (save_png, save_html) poll a status file written by the host in
    ``api_dir/<cmdId>.json``.  Selection updates arrive via comm on_msg
    when the kernel is idle.
    """

    def __init__(self, comm: Any, variable: str, api_dir: pathlib.Path) -> None:
        self._comm = comm
        self._variable = variable
        self._api_dir = api_dir
        self._api_dir.mkdir(parents=True, exist_ok=True)
        self._dims: int = 2
        self._selection_mask: bytes | None = None
        self._n_kept: int = 0
        self._job_id: str | None = None
        self._callbacks: list = []
        self._closed = False
        self._lock = threading.Lock()
        # Register on_msg handler.
        comm.on_msg(self._on_msg)

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _require_open(self) -> None:
        if self._closed:
            raise RuntimeError("This Atlas panel has been closed.")

    def _send(self, name: str, args: dict | None = None) -> str:
        """Enqueue a command via comm.send. Returns the cmdId."""
        self._require_open()
        cmd_id = uuid.uuid4().hex[:12]
        # _sentAt (ms since the epoch) lets the webview measure the comm latency.
        payload: dict[str, Any] = {"name": name, "cmdId": cmd_id, "args": {**(args or {}), "_sentAt": time.time() * 1000}}
        self._comm.send(payload)
        return cmd_id

    def _send_save(self, name: str, path: str) -> "SaveRequest":
        """Send a save command; the host writes the file once the map has settled.

        This never blocks: preparing the map, placing rows and loading colours run in this
        kernel, so waiting here (for example in the cell that called ``atlas.open``) would
        deadlock. The host writes ``<api_dir>/<cmdId>.json`` with the result.
        """
        cmd_id = self._send(name, {"path": str(path)})
        return SaveRequest(pathlib.Path(path), self._api_dir / f"{cmd_id}.json")

    def _on_msg(self, msg: Any) -> None:
        """Handle messages from the host (comm → kernel direction)."""
        data = msg.get("content", {}).get("data", {}) if isinstance(msg, dict) else {}
        msg_type = data.get("type") if isinstance(data, dict) else None

        try:
            if msg_type == "selectionChanged":
                mask_b64 = data.get("mask_b64", "")
                n_kept = int(data.get("nKept", 0))
                mask: bytes | None = base64.b64decode(mask_b64) if mask_b64 else None
                self._job_id = data.get("jobId") or self._job_id
                self._update_selection(mask, n_kept)
            elif msg_type == "closed":
                self._closed = True
        finally:
            # The host sends these with performRpc, which waits for a reply. Sent from inside
            # this handler, the message is the reply (ipykernel sets its parent header).
            if msg_type is not None and not self._closed:
                try:
                    self._comm.send({"type": "ack"})
                except Exception:  # noqa: BLE001
                    pass

    def _update_selection(self, mask: bytes | None, n_kept: int) -> None:
        with self._lock:
            self._selection_mask = mask
            self._n_kept = n_kept
        rows = self._mask_to_rows(mask) if mask else np.array([], dtype=np.intp)
        for cb in list(self._callbacks):
            try:
                cb(rows)
            except Exception:  # noqa: BLE001 - a user callback must not break the comm
                import traceback

                traceback.print_exc()

    def _mask_to_rows(self, mask: bytes) -> "np.ndarray":
        """Row positions in the original frame of the selected rows.

        The mask has one bit per prepared row (LSB first), after sampling and dropped rows;
        the job's ``kept_idx`` maps prepared rows back to the frame.
        """
        bits = np.unpackbits(np.frombuffer(mask, dtype=np.uint8), bitorder="little")[: self._n_kept]
        prepared = np.flatnonzero(bits)
        job = _JOBS.get(self._job_id) if self._job_id else None
        kept = getattr(job, "kept_idx", None)
        if kept is not None and len(kept) == self._n_kept:
            return np.sort(np.asarray(kept)[prepared]).astype(np.intp)
        return prepared.astype(np.intp)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def dims(self) -> int:
        return self._dims

    @dims.setter
    def dims(self, value: int) -> None:
        if value not in (2, 3):
            raise ValueError("dims must be 2 or 3")
        self._dims = value
        self._send("setDims", {"dims": value})

    @property
    def selection(self) -> Any:
        """Current selection as a filtered DataFrame, or None."""
        rows = self.selected_rows
        if len(rows) == 0:
            return None
        ns = _user_ns()
        df = ns.get(self._variable)
        if df is None:
            return None
        return df.iloc[rows] if hasattr(df, "iloc") else df[rows]

    @property
    def selected_rows(self) -> "np.ndarray":
        """Row positions of the selected rows in the original DataFrame."""
        with self._lock:
            mask = self._selection_mask
        if mask is None:
            return np.array([], dtype=np.intp)
        return self._mask_to_rows(mask)

    def color_by(self, column: "str | int") -> None:
        """Color the map by a column, by name or index. Unknown columns are reported by the host."""
        self._require_open()
        if isinstance(column, int):
            self._send("colorBy", {"column": column})
        else:
            self._send("colorBy", {"columnName": str(column)})

    def label_by(self, column: "str | int") -> None:
        """Label the map by a column, by name or index. Unknown columns are reported by the host."""
        self._require_open()
        if isinstance(column, int):
            self._send("labelBy", {"column": column})
        else:
            self._send("labelBy", {"columnName": str(column)})

    def annotate(self, row: int, text: str = "") -> None:
        """Add a text annotation to a row."""
        self._send("annotate", {"row": int(row), "text": str(text)})

    def on_select(self, callback: Any) -> None:
        """Register a callback fired when selection changes (runs when kernel is idle)."""
        self._callbacks.append(callback)

    def save_png(self, path: str) -> "SaveRequest":
        """Save the map as a PNG once it has finished loading. Returns at once.

        The returned request's ``done`` and ``error`` tell you (in a later cell) whether
        the file was written.
        """
        return self._send_save("savePng", path)

    def save_html(self, path: str) -> "SaveRequest":
        """Export the map as a self-contained HTML file once it has finished loading."""
        return self._send_save("saveHtml", path)

    def close(self) -> None:
        """Close the Atlas panel."""
        if not self._closed:
            try:
                self._send("close", {})
            except Exception:  # noqa: BLE001
                pass
            self._closed = True
            _HANDLES.pop(getattr(self._comm, "comm_id", None), None)

    def __repr__(self) -> str:
        return f"<AtlasHandle variable={self._variable!r} dims={self._dims}>"


def _ensure_atlas_module(handle: "_AtlasHandle | None" = None) -> None:
    """Register ``positron_atlas`` in ``sys.modules`` (once)."""
    import types
    name = "positron_atlas"
    m = sys.modules.get(name)
    if m is None:
        m = types.ModuleType(name)
        m.__doc__ = (
            "Positron Atlas Python API (C3).\n\n"
            "    import positron_atlas as atlas\n"
            "    m = atlas.open(df)\n"
            "    m.color_by('cluster')\n"
        )
        m.handles = _HANDLES  # live reference

        def _open(df: Any) -> "_AtlasHandle":
            return _atlas_open(df)

        m.open = _open
        sys.modules[name] = m
    # Update the live 'last' handle.
    if handle is not None:
        m.last = handle  # type: ignore[attr-defined]


def _atlas_open(df: Any) -> "_AtlasHandle":
    """Open an Atlas panel for ``df`` via Positron comms.

    Creates a comm (target_name='positron.atlas'), opens it, and returns
    the handle immediately.  The host's registerClientHandler callback
    will open the panel asynchronously.

    Raises if comms are unavailable (not running in a Positron/Jupyter kernel).
    """
    from comm import create_comm  # ipykernel comm package

    # Find the variable name in the user namespace.
    ns = _user_ns()
    variable = None
    for k, v in ns.items():
        if v is df and not k.startswith("_"):
            variable = k
            break
    if variable is None:
        variable = f"_atlas_df_{uuid.uuid4().hex[:8]}"
        ns[variable] = df

    # Create a temporary directory for status files (host writes here).
    api_dir = pathlib.Path(tempfile.mkdtemp(prefix="positron_atlas_"))

    comm = create_comm(
        target_name="positron.atlas",
        data={
            "variable": variable,
            "apiDir": str(api_dir),
        },
    )
    # Note: create_comm() with primary=True (default) already calls comm.open(data=...)
    # internally in BaseComm.__init__; do NOT call comm.open() again.

    handle = _AtlasHandle(comm, variable, api_dir)
    _HANDLES[comm.comm_id] = handle
    _ensure_atlas_module(handle)
    return handle


# Register positron_atlas in sys.modules when the helper loads.
# This runs at module load time so ``import positron_atlas`` works immediately.
_ensure_atlas_module()
