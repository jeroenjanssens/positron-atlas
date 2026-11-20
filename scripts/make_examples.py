"""Generate the example notebooks in examples/.

    uv run --project python python scripts/make_examples.py

Each notebook downloads a real dataset once (cached in ~/.cache/positron-atlas/datasets)
and needs only numpy and polars.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "examples"

DOWNLOAD = '''\
import gzip
import urllib.request
from pathlib import Path

import numpy as np

CACHE = Path.home() / ".cache" / "positron-atlas" / "datasets"


def download(url: str, name: str) -> Path:
    """Download a file once and cache it."""
    path = CACHE / name
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        print(f"Downloading {url} ...")
        tmp = path.with_suffix(path.suffix + ".part")
        urllib.request.urlretrieve(url, tmp)
        tmp.rename(path)
    return path


def read_idx(path: Path) -> np.ndarray:
    """Read an IDX file (the MNIST format): images as (n, 784) uint8, labels as (n,)."""
    with gzip.open(path, "rb") as f:
        data = f.read()
    ndim = data[3]
    shape = tuple(int.from_bytes(data[4 + 4 * i : 8 + 4 * i], "big") for i in range(ndim))
    arr = np.frombuffer(data, dtype=np.uint8, offset=4 + 4 * ndim)
    return arr.reshape(shape[0], -1) if ndim > 1 else arr
'''

HOW_TO_OPEN = """\
## Open it in Atlas

1. In the **Variables** pane, double-click **`{var}`** to open it in the Data Explorer.
2. Click **Open in Atlas**, the first button in the Data Explorer's toolbar (top left).

Or run **Atlas: Open DataFrame…** from the Command Palette and pick `{var}`.
"""


def md(text: str) -> dict:
    return {"cell_type": "markdown", "metadata": {}, "source": text.strip("\n").splitlines(keepends=True)}


def code(text: str) -> dict:
    return {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": text.strip("\n").splitlines(keepends=True),
    }


def notebook(cells: list[dict]) -> dict:
    return {
        "cells": cells,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }


def mnist_like(*, title, intro, var, base_url, label_names, things, tips):
    build = f'''\
import polars as pl

{var} = pl.from_numpy(pixels, schema=[f"px{{i}}" for i in range(pixels.shape[1])]).with_columns(
    pl.Series("label", [LABELS[v] for v in labels], dtype=pl.Enum(LABELS)),
    pl.Series("split", np.where(np.arange(len(labels)) < n_train, "train", "test")),
    pl.Series("ink", pixels.mean(axis=1)),  # average pixel intensity: a numeric column to color by
)
{var}.shape'''
    return notebook(
        [
            md(f"# {title}\n\n{intro}"),
            code(DOWNLOAD),
            code(
                f'''\
BASE = "{base_url}"
LABELS = {json.dumps(label_names)}

files = {{
    name: download(BASE + name, "{var}-" + name)
    for name in [
        "train-images-idx3-ubyte.gz",
        "train-labels-idx1-ubyte.gz",
        "t10k-images-idx3-ubyte.gz",
        "t10k-labels-idx1-ubyte.gz",
    ]
}}
train_x = read_idx(files["train-images-idx3-ubyte.gz"])
test_x = read_idx(files["t10k-images-idx3-ubyte.gz"])
train_y = read_idx(files["train-labels-idx1-ubyte.gz"])
test_y = read_idx(files["t10k-labels-idx1-ubyte.gz"])
n_train = len(train_y)

pixels = np.concatenate([train_x, test_x])  # (70000, 784) uint8
labels = np.concatenate([train_y, test_y])
pixels.shape, labels.shape'''
            ),
            md(f"Build a polars DataFrame with one column per pixel (784 numeric columns) and a few columns to color by."),
            code(build),
            md(HOW_TO_OPEN.format(var=var)),
            md(tips),
            md(f"## Things to try\n\n{things}"),
        ]
    )


MNIST_THINGS = """\
- **Color by `label`.** This is the default, because it is the first low-cardinality categorical column. With the recommended settings below, the ten digits form separate islands. Look for the 4/7/9 and 3/5/8 neighborhoods.
- **Color by `ink`.** Within each digit, the layout often orders thin to bold strokes.
- **Hover** a point to see its row, including its label and split.
- **Drag *Min distance*** to 0 for tight clusters, or to 0.8 for a smoother map. The change applies live.
- **Set *Neighbors*** to 50 or more for more global structure. This rebuilds the graph."""

TIPS = """\
## Recommended settings for image data

With the defaults (all 785 numeric columns, standardized, no PCA), the browser UMAP only gets about 12,700 *anchor* rows. That is the limit of 10 million values ÷ 785 dimensions. The kernel then places the other rows next to their nearest anchors. That is quick, but the map is blurry, because z-scoring near-constant border pixels amplifies noise.

For a much sharper map, in the **Data** section:

1. Turn on **Apply PCA first** with **50** components.
2. Turn off **Standardize columns**. Raw pixel intensities are the usual input for these datasets.
3. Click **Apply**.

UMAP then runs on all 70,000 rows: about 4 s with WebGPU (the default when available). Without a GPU, also lower **Sample rows** to about 30 %."""

FASHION_THINGS = """\
- **Color by `label`.** Footwear (sandal, sneaker, ankle boot) and bags separate cleanly. Tops (T-shirt/top, pullover, coat, shirt) overlap much more than digits do in MNIST.
- **Compare *Metric*** euclidean with cosine, which is less sensitive to overall brightness.
- **Color by `ink`.** It explains much of the variation inside the tops cluster.
- **Copy as Python.** This gives the equivalent `umap-learn` code for the current settings, to reproduce the plot elsewhere."""

COVTYPE = notebook(
    [
        md(
            """\
# Forest cover types (581,012 rows)

The [Covertype dataset](https://archive.ics.uci.edu/dataset/31/covertype) describes 30 m × 30 m cells in the Roosevelt National Forest, Colorado. Each cell has 10 cartographic measurements (elevation, slope, distances to water, roads and fire points, hillshade) and 44 binary indicators (4 wilderness areas, 40 soil types). The target is the dominant tree species.

With more than half a million rows, this example exercises Atlas's *anchor + projection* path:

1. UMAP runs in the browser on 100,000 anchor rows (25,000 without WebGPU).
2. The kernel places the remaining rows next to their nearest anchors, using numpy only."""
        ),
        code(DOWNLOAD),
        code(
            '''\
import polars as pl

URL = "https://archive.ics.uci.edu/ml/machine-learning-databases/covtype/covtype.data.gz"
path = download(URL, "covtype.data.gz")

QUANTITATIVE = [
    "elevation", "aspect", "slope",
    "horizontal_distance_to_hydrology", "vertical_distance_to_hydrology",
    "horizontal_distance_to_roadways",
    "hillshade_9am", "hillshade_noon", "hillshade_3pm",
    "horizontal_distance_to_fire_points",
]
WILDERNESS = ["Rawah", "Neota", "Comanche Peak", "Cache la Poudre"]
COVER = ["Spruce/Fir", "Lodgepole Pine", "Ponderosa Pine", "Cottonwood/Willow", "Aspen", "Douglas-fir", "Krummholz"]

raw = np.loadtxt(path, delimiter=",", dtype=np.int32)  # (581012, 55), takes a few seconds
raw.shape'''
        ),
        md(
            "Keep the 10 measurements as numeric features. Turn the one-hot indicators into categorical columns, so they are available for coloring and not used as features."
        ),
        code(
            '''\
covtype = pl.DataFrame({name: raw[:, i].astype(np.float32) for i, name in enumerate(QUANTITATIVE)}).with_columns(
    pl.Series("cover_type", [COVER[i - 1] for i in raw[:, 54]], dtype=pl.Enum(COVER)),
    pl.Series("wilderness", [WILDERNESS[i] for i in raw[:, 10:14].argmax(axis=1)], dtype=pl.Enum(WILDERNESS)),
    pl.Series("soil_type", [f"soil {i + 1}" for i in raw[:, 14:54].argmax(axis=1)]),
)
covtype.shape'''
        ),
        md(HOW_TO_OPEN.format(var="covtype")),
        md(
            """\
## Things to try

- **Color by `cover_type`.** This is the default. Then try `wilderness` and `elevation`: elevation explains much of the species structure.
- **Watch the footer.** It shows `UMAP on 100,000 anchors`, then the remaining rows are placed in the kernel (a few seconds) and fill in progressively.
- **Lower *Sample rows*** to 10 % and click **Apply** for a quick, fully exact UMAP on 58,000 rows. No placement is needed then.
- **Add coordinates to DataFrame.** This writes `umap_x`/`umap_y` back into `covtype`. Because polars DataFrames are immutable, the variable is rebound to a new DataFrame. Then try, for example:

  ```python
  covtype.group_by("cover_type").agg(pl.col("umap_x", "umap_y").mean())
  ```"""
        ),
    ]
)

README = """\
# Example notebooks

Real high-dimensional datasets to explore with Positron Atlas. Each notebook downloads its data once, caches it in `~/.cache/positron-atlas/datasets`, and needs only **numpy** and **polars**.

| Notebook | Data | Rows × features | DataFrame |
|---|---|---|---|
| [01-mnist.ipynb](01-mnist.ipynb) | Handwritten digits ([MNIST](https://yann.lecun.com/exdb/mnist/)) | 70,000 × 784 | polars |
| [02-fashion-mnist.ipynb](02-fashion-mnist.ipynb) | Clothing images ([Fashion-MNIST](https://github.com/zalandoresearch/fashion-mnist)) | 70,000 × 784 | polars |
| [03-covertype.ipynb](03-covertype.ipynb) | Forest cover types ([UCI Covertype](https://archive.ics.uci.edu/dataset/31/covertype)) | 581,012 × 10 | polars |

## Setup

This folder is a [uv](https://docs.astral.sh/uv/) project with everything the notebooks need (numpy, polars, ipykernel):

```sh
cd examples
uv sync                 # creates examples/.venv
uv sync --group exact   # optional: also install umap-learn for Atlas's "Kernel (umap-learn)" mode
```

In Positron, open a notebook and select the `examples/.venv` interpreter (**Python 3.x (uv: positron-atlas-examples)**) from the interpreter picker in the top right.

## Usage

Run all cells, then open the DataFrame from the Data Explorer toolbar (**Open in Atlas**) or with **Atlas: Open DataFrame…** in the Command Palette.

The notebooks are generated by `scripts/make_examples.py`. Edit that script, not the `.ipynb` files.
"""


def main() -> None:
    OUT.mkdir(exist_ok=True)
    nbs = {
        "01-mnist.ipynb": mnist_like(
            title="MNIST handwritten digits (70,000 × 784)",
            intro="Each row is a 28 × 28 grayscale image of a handwritten digit, flattened to 784 pixel columns (0–255). UMAP should separate the ten digits without ever seeing the labels.",
            var="mnist",
            base_url="https://ossci-datasets.s3.amazonaws.com/mnist/",
            label_names=[str(i) for i in range(10)],
            things=MNIST_THINGS,
            tips=TIPS,
        ),
        "02-fashion-mnist.ipynb": mnist_like(
            title="Fashion-MNIST (70,000 × 784)",
            intro="Zalando's drop-in replacement for MNIST: 28 × 28 grayscale photos of clothing in ten classes. It is harder than digits, so expect some overlapping classes.",
            var="fashion",
            base_url="https://raw.githubusercontent.com/zalandoresearch/fashion-mnist/master/data/fashion/",
            label_names=["T-shirt/top", "Trouser", "Pullover", "Dress", "Coat", "Sandal", "Shirt", "Sneaker", "Bag", "Ankle boot"],
            things=FASHION_THINGS,
            tips=TIPS,
        ),
        "03-covertype.ipynb": COVTYPE,
    }
    for name, nb in nbs.items():
        (OUT / name).write_text(json.dumps(nb, indent=1, ensure_ascii=False) + "\n")
    (OUT / "README.md").write_text(README)
    print(f"Wrote {len(nbs)} notebooks to {OUT}")


if __name__ == "__main__":
    main()
