"""
positron_atlas_examples — bundled sample data loaders for the "Atlas: Open example" command.

Each loader downloads its files once to ~/.cache/positron-atlas/datasets/, then rebuilds
them from cache on subsequent calls.  All loaders return a polars DataFrame whose column
layout matches the corresponding example notebook, so notebooks and the command share
exactly the same data and cache locations and never drift.

Required: numpy, polars (already needed by the kernel helper).
No other dependencies are required for the datasets exported here.
"""

from __future__ import annotations

import gzip
import urllib.request
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import polars as pl

CACHE = Path.home() / ".cache" / "positron-atlas" / "datasets"

# ---------------------------------------------------------------------------
# Catalogue
# ---------------------------------------------------------------------------

#: Each entry describes one example for the command quick-pick.
#: Keys: id (variable name), label, description, rows, mb (approx download MB).
EXAMPLES: list[dict] = [
    {
        "id": "mnist",
        "label": "MNIST — handwritten digits",
        "description": "70,000 rows × 784 pixels  |  ~11 MB download",
        "rows": 70_000,
        "mb": 11,
        "color_by": "label",
        "title_by": None,
    },
    {
        "id": "fashion",
        "label": "Fashion MNIST — clothing images",
        "description": "70,000 rows × 784 pixels  |  ~11 MB download",
        "rows": 70_000,
        "mb": 11,
        "color_by": "label",
        "title_by": None,
    },
    {
        "id": "covtype",
        "label": "Forest Cover Type",
        "description": "581,012 rows × 10 features  |  ~11 MB download",
        "rows": 581_012,
        "mb": 11,
        "color_by": "cover_type",
        "title_by": None,
    },
]


def examples() -> list[dict]:
    """Return the catalogue of available examples (for the quick-pick)."""
    return list(EXAMPLES)


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _download(url: str, name: str) -> Path:
    """Download *url* to CACHE/*name*, atomically; skip if already present."""
    dest = CACHE / name
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {url} …")
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        urllib.request.urlretrieve(url, tmp)
        tmp.rename(dest)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    return dest


def _read_idx(path: Path):
    """Read an IDX file (the MNIST binary format) → numpy array."""
    import numpy as np

    with gzip.open(path, "rb") as f:
        data = f.read()
    ndim = data[3]
    shape = tuple(
        int.from_bytes(data[4 + 4 * i : 8 + 4 * i], "big") for i in range(ndim)
    )
    arr = np.frombuffer(data, dtype=np.uint8, offset=4 + 4 * ndim)
    return arr.reshape(shape[0], -1) if ndim > 1 else arr


# ---------------------------------------------------------------------------
# MNIST — handwritten digits
# ---------------------------------------------------------------------------


def load_mnist() -> "pl.DataFrame":
    """Return a polars DataFrame with 70,000 MNIST rows.

    Columns: px0…px783 (uint8), label (Enum), split (str), ink (f32).
    Cache: ~/.cache/positron-atlas/datasets/mnist-*.gz
    """
    import numpy as np
    import polars as pl

    BASE = "https://ossci-datasets.s3.amazonaws.com/mnist/"
    LABELS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]
    names = [
        "train-images-idx3-ubyte.gz",
        "train-labels-idx1-ubyte.gz",
        "t10k-images-idx3-ubyte.gz",
        "t10k-labels-idx1-ubyte.gz",
    ]
    files = {n: _download(BASE + n, "mnist-" + n) for n in names}
    train_x = _read_idx(files["train-images-idx3-ubyte.gz"])
    test_x = _read_idx(files["t10k-images-idx3-ubyte.gz"])
    train_y = _read_idx(files["train-labels-idx1-ubyte.gz"])
    test_y = _read_idx(files["t10k-labels-idx1-ubyte.gz"])

    pixels = np.concatenate([train_x, test_x])  # (70000, 784) uint8
    labels = np.concatenate([train_y, test_y])
    n_train = len(train_y)

    df = pl.from_numpy(pixels, schema=[f"px{i}" for i in range(pixels.shape[1])]).with_columns(
        pl.Series("label", [LABELS[v] for v in labels], dtype=pl.Enum(LABELS)),
        pl.Series(
            "split",
            ["train" if i < n_train else "test" for i in range(len(labels))],
        ),
        pl.Series("ink", pixels.mean(axis=1).astype("float32")),
    )
    print(f"mnist: {df.shape[0]:,} rows × {df.shape[1]} columns")
    return df


# ---------------------------------------------------------------------------
# Fashion MNIST — clothing images
# ---------------------------------------------------------------------------


def load_fashion() -> "pl.DataFrame":
    """Return a polars DataFrame with 70,000 Fashion MNIST rows.

    Columns: px0…px783 (uint8), label (Enum), split (str), ink (f32).
    Cache: ~/.cache/positron-atlas/datasets/fashion-*.gz
    """
    import numpy as np
    import polars as pl

    BASE = "https://raw.githubusercontent.com/zalandoresearch/fashion-mnist/master/data/fashion/"
    LABELS = [
        "T-shirt/top",
        "Trouser",
        "Pullover",
        "Dress",
        "Coat",
        "Sandal",
        "Shirt",
        "Sneaker",
        "Bag",
        "Ankle boot",
    ]
    names = [
        "train-images-idx3-ubyte.gz",
        "train-labels-idx1-ubyte.gz",
        "t10k-images-idx3-ubyte.gz",
        "t10k-labels-idx1-ubyte.gz",
    ]
    files = {n: _download(BASE + n, "fashion-" + n) for n in names}
    train_x = _read_idx(files["train-images-idx3-ubyte.gz"])
    test_x = _read_idx(files["t10k-images-idx3-ubyte.gz"])
    train_y = _read_idx(files["train-labels-idx1-ubyte.gz"])
    test_y = _read_idx(files["t10k-labels-idx1-ubyte.gz"])

    pixels = np.concatenate([train_x, test_x])
    labels = np.concatenate([train_y, test_y])
    n_train = len(train_y)

    df = pl.from_numpy(pixels, schema=[f"px{i}" for i in range(pixels.shape[1])]).with_columns(
        pl.Series("label", [LABELS[v] for v in labels], dtype=pl.Enum(LABELS)),
        pl.Series(
            "split",
            ["train" if i < n_train else "test" for i in range(len(labels))],
        ),
        pl.Series("ink", pixels.mean(axis=1).astype("float32")),
    )
    print(f"fashion: {df.shape[0]:,} rows × {df.shape[1]} columns")
    return df


# ---------------------------------------------------------------------------
# Forest Cover Type (UCI)
# ---------------------------------------------------------------------------


def load_covtype() -> "pl.DataFrame":
    """Return a polars DataFrame with 581,012 forest-cover-type rows.

    Columns: elevation, aspect, slope, … (10 quantitative f32),
             cover_type (Enum, 7 classes), wilderness (Enum, 4 areas), soil_type (str).
    Cache: ~/.cache/positron-atlas/datasets/covtype.data.gz
    """
    import numpy as np
    import polars as pl

    URL = "https://archive.ics.uci.edu/ml/machine-learning-databases/covtype/covtype.data.gz"
    path = _download(URL, "covtype.data.gz")

    QUANTITATIVE = [
        "elevation",
        "aspect",
        "slope",
        "horizontal_distance_to_hydrology",
        "vertical_distance_to_hydrology",
        "horizontal_distance_to_roadways",
        "hillshade_9am",
        "hillshade_noon",
        "hillshade_3pm",
        "horizontal_distance_to_fire_points",
    ]
    WILDERNESS = ["Rawah", "Neota", "Comanche Peak", "Cache la Poudre"]
    COVER = [
        "Spruce/Fir",
        "Lodgepole Pine",
        "Ponderosa Pine",
        "Cottonwood/Willow",
        "Aspen",
        "Douglas-fir",
        "Krummholz",
    ]

    print("Reading covtype.data.gz …")
    with gzip.open(path, "rt") as f:
        import csv
        raw_rows = [list(map(int, row)) for row in csv.reader(f)]
    raw = np.array(raw_rows, dtype=np.int32)

    df = pl.DataFrame(
        {name: raw[:, i].astype(np.float32) for i, name in enumerate(QUANTITATIVE)}
    ).with_columns(
        pl.Series(
            "cover_type",
            [COVER[v - 1] for v in raw[:, 54]],
            dtype=pl.Enum(COVER),
        ),
        pl.Series(
            "wilderness",
            [WILDERNESS[i] for i in raw[:, 10:14].argmax(axis=1)],
            dtype=pl.Enum(WILDERNESS),
        ),
        pl.Series("soil_type", [f"soil {i + 1}" for i in raw[:, 14:54].argmax(axis=1)]),
    )
    print(f"covtype: {df.shape[0]:,} rows × {df.shape[1]} columns")
    return df


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

_LOADERS: dict[str, callable] = {
    "mnist": load_mnist,
    "fashion": load_fashion,
    "covtype": load_covtype,
}


def load_example(example_id: str):
    """Load an example by its id; return the DataFrame.  Raises KeyError for unknown ids."""
    fn = _LOADERS[example_id]
    return fn()
