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
- **Turn on *Points are images*** in the **Display** section, then hover a point to see the digit itself. Atlas finds the 784 pixel columns (`px0` … `px783`) and shows them as a 28 × 28 image. Tick **Invert colors** for black digits on white.
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
- **Turn on *Points are images*** in the **Display** section and hover the points to see the clothing items. Try the boundary between shirts and T-shirts.
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

FEATURE_NAMES = [
    "lepton_pT", "lepton_eta", "lepton_phi",
    "missing_energy_magnitude", "missing_energy_phi",
    "jet_1_pt", "jet_1_eta", "jet_1_phi", "jet_1_b_tag",
    "jet_2_pt", "jet_2_eta", "jet_2_phi", "jet_2_b_tag",
    "jet_3_pt", "jet_3_eta", "jet_3_phi", "jet_3_b_tag",
    "jet_4_pt", "jet_4_eta", "jet_4_phi", "jet_4_b_tag",
    "m_jj", "m_jjj", "m_lv", "m_jlv", "m_bb", "m_wbb", "m_wwbb",
]

HIGGS = notebook(
    [
        md(
            """\
# HIGGS (11,000,000 rows × 28 features)

The [HIGGS dataset](https://archive.ics.uci.edu/dataset/280/higgs) from the UCI Machine Learning Repository contains 11 million Monte Carlo simulated collision events for a high-energy physics classifier: does the collision produce a Higgs boson (signal) or background noise? Each row has 28 kinematic features measured in the detector.

This example exercises Atlas at scale: 11 million rows, the *anchor + projection* placement path, and legend toggles on the binary class label.

> **License:** CC BY 4.0. **Download:** ~2.6 GB compressed on first run; cached afterwards."""
        ),
        code(DOWNLOAD),
        code(
            '''\
import zipfile

ZIP_URL = "https://archive.ics.uci.edu/static/public/280/higgs.zip"
zip_path = download(ZIP_URL, "higgs.zip")

# The zip contains HIGGS.csv.gz — extract it once if needed.
csv_gz = CACHE / "HIGGS.csv.gz"
if not csv_gz.exists():
    print("Extracting HIGGS.csv.gz from zip ...")
    with zipfile.ZipFile(zip_path) as zf:
        zf.extract("HIGGS.csv.gz", CACHE)
print(f"Cached at: {csv_gz}")'''
        ),
        md(
            "Load with polars (reads the gzip CSV directly). The file has no header: the first column is the class label (0 = background, 1 = signal) and the remaining 28 are kinematic features."
        ),
        code(
            f'''\
import polars as pl

FEATURES = {json.dumps(FEATURE_NAMES)}

print("Reading 11M rows — this takes about 20–40 s the first time ...")
higgs = pl.read_csv(
    csv_gz,
    has_header=False,
    new_columns=["label_raw"] + FEATURES,
    schema_overrides={{col: pl.Float32 for col in FEATURES}},
).with_columns(
    pl.Series(
        "label",
        ["signal" if v == 1 else "background" for v in pl.col("label_raw").to_list()],
        dtype=pl.Enum(["signal", "background"]),
    )
).drop("label_raw")
higgs.shape'''
        ),
        md(HOW_TO_OPEN.format(var="higgs")),
        md(
            """\
## Things to try

- **Color by `label`.** Signal and background separate, though imperfectly — that is the physics. The last 7 columns (`m_jj` … `m_wwbb`) are high-level derived features that the original paper shows improve separation.
- **Watch the footer.** With 11 million rows, Atlas runs UMAP on up to 100,000 anchors and places the rest in the kernel. The status bar shows the two phases; the whole map fills in progressively.
- **Lower *Sample rows*** to 1 % (110,000 rows) and click **Apply** for a quick exact UMAP. No projection step needed at that size.
- **Turn on *Apply PCA first*** with 20 components and click **Apply** for a faster run on the full dataset.
- **Add coordinates.** After projection, click **Add umap_x / umap_y** in the **Export** section to write the coordinates back into `higgs`. Then use them in a follow-up analysis:

  ```python
  higgs.group_by("label").agg(pl.col("umap_x", "umap_y").mean())
  ```"""
        ),
    ]
)

WIKIPEDIA_INTRO = """\
# Wikipedia article titles (11.8 M × 64)

Three language editions of Wikipedia (English, German, French) from the
[`wikimedia/wikipedia`](https://huggingface.co/datasets/wikimedia/wikipedia)
dataset on Hugging Face.  Each row is one article, embedded as a 64-dimensional
PCA projection of a 256-dimensional static embedding produced by
[`minishlab/potion-multilingual-128M`](https://huggingface.co/minishlab/potion-multilingual-128M).

**Licence:** Wikipedia text is CC BY-SA 4.0 / GFDL.  The embedding model is MIT.

**First run:** downloading the raw Parquet shards takes roughly 22 GB and
dominates the ≈ 40-minute first run; the cached result is ≈ 4 GB.
Subsequent runs skip every step that is already cached, so re-running the
notebook is fast.

**Quick try:** set `SAMPLE = True` at the top to process only one shard per
language (≈ 400 k articles, a few minutes).

**What to try in Atlas:** set `title` as the hover-title column, `url` as the
link column, and color by `language` to see the three language editions as
distinct regions.  Turn on cluster labels to discover topic areas.
"""

WIKIPEDIA_THINGS = """\
- **Color by `language`.** The three editions form broad regional clusters with
  some overlap where topics are covered in all three languages.
- **Hover a point** to see the article title and first sentence.
- **Cmd/Ctrl-click a point** (when `url` is the link column) to open the
  Wikipedia article in a browser.
- **Lower *Sample rows*** to 5–10 % for a quicker first UMAP run. At 11.8 M × 64
  features, 10 % gives 1.18 M anchors — still a large and representative map.
- **Turn on *Cluster labels*** to see topic regions emerge across languages.
- **Search by title** to find specific articles and see where they land in the
  embedding space.
"""


def wikipedia_titles() -> dict:
    """Generate the Wikipedia titles notebook."""
    cell_config = '''\
# ── Configuration ──────────────────────────────────────────────────────────────
# Set SAMPLE = True to process only 1 shard per language (~400 k rows, ~5 min).
# Set SAMPLE = False for the full dataset (~11.8 M rows, ~40 min first run).
SAMPLE = False

LANGS = ["en", "de", "fr"]   # English, German, French Wikipedia
DATE = "20231101"             # Wikipedia snapshot date
N_COMPONENTS = 64             # PCA output dimensions (f0 … f63)
BATCH_SIZE = 4096             # Titles per embedding batch
PCA_SAMPLE = 500_000          # Number of titles used to fit PCA'''

    cell_imports = '''\
import json
import re
import time
import urllib.request
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import polars as pl
from model2vec import StaticModel

CACHE = Path.home() / ".cache" / "positron-atlas" / "datasets" / "wikipedia"
CACHE_RAW  = CACHE / "raw"      # downloaded HuggingFace Parquet shards
CACHE_TEXT = CACHE / "text"     # small per-shard parquets (title, url, lang, first_sentence)
CACHE_FEAT = CACHE / "features" # per-shard parquets after embedding + PCA
WIKI_PARQUET = CACHE / "wiki.parquet"

for _d in [CACHE_RAW, CACHE_TEXT, CACHE_FEAT]:
    _d.mkdir(parents=True, exist_ok=True)


def _download(url: str, path: Path) -> Path:
    """Download url to path atomically; skip if already present."""
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    urllib.request.urlretrieve(url, tmp)
    tmp.rename(path)
    return path


_SENT_END = re.compile(r\'[.!?](?:\\s|$)\')


def _first_sentence(text: str) -> str:
    """Return the first sentence of text, capped at 300 characters."""
    text = text.strip()[:300]
    m = _SENT_END.search(text)
    return text[:m.end()].rstrip() if m else text


def _embed_batched(model: StaticModel, titles: list[str]) -> np.ndarray:
    """Embed titles in BATCH_SIZE chunks; return float32 (n, dim) array."""
    out = []
    for i in range(0, len(titles), BATCH_SIZE):
        out.append(model.encode(titles[i : i + BATCH_SIZE]))
    return np.concatenate(out, axis=0).astype(np.float32)'''

    cell_shards = '''\
def _list_shards(lang: str) -> list[tuple[str, str]]:
    """Return [(filename, url), …] for all train shards of one language."""
    config = f"{DATE}.{lang}"
    api = (
        "https://datasets-server.huggingface.co/parquet"
        f"?dataset=wikimedia/wikipedia&config={config}&split=train"
    )
    with urllib.request.urlopen(api) as resp:
        data = json.loads(resp.read())
    shards = [(f["filename"], f["url"]) for f in data["parquet_files"]]
    return shards[:1] if SAMPLE else shards


shards_by_lang = {lang: _list_shards(lang) for lang in LANGS}
total_shards = sum(len(v) for v in shards_by_lang.values())
print(f"Shards to process: {total_shards}")
for lang, shards in shards_by_lang.items():
    print(f"  {lang}: {len(shards)} shards")'''

    cell_phase1 = '''\
# ── Phase 1: extract title, url, first_sentence from each shard ──────────────
if WIKI_PARQUET.exists():
    print("wiki.parquet already cached — skipping all phases")
else:
    print("Phase 1: extracting text from shards...")
    _t0 = time.perf_counter()
    _n_done = 0

    for _lang, _shards in shards_by_lang.items():
        for _fname, _url in _shards:
            _stem = f"{_lang}_{_fname.replace(\'.parquet\', \'\')}"
            _text_path = CACHE_TEXT / f"{_stem}.parquet"
            if _text_path.exists():
                _n_done += 1
                continue

            # Download raw shard (cached in CACHE_RAW)
            _raw_path = CACHE_RAW / f"{_stem}.parquet"
            if not _raw_path.exists():
                print(f"  Downloading {_lang}/{_fname} ...")
            _download(_url, _raw_path)

            # Read only the columns we need; extract first sentence then drop text
            _tbl = pq.read_table(_raw_path, columns=["title", "url", "text"])
            _titles   = _tbl["title"].to_pylist()
            _urls     = _tbl["url"].to_pylist()
            _texts    = _tbl["text"].to_pylist()
            _sents    = [_first_sentence(t) for t in _texts]
            del _texts  # release memory immediately

            pq.write_table(
                pa.table({
                    "title":          _titles,
                    "url":            _urls,
                    "language":       [_lang] * len(_titles),
                    "first_sentence": _sents,
                }),
                _text_path,
            )
            _n_done += 1
            print(f"  {_lang}/{_fname}: {len(_titles):,} articles ({_n_done}/{total_shards})")

    if not WIKI_PARQUET.exists():
        _elapsed = time.perf_counter() - _t0
        print(f"Phase 1 done in {_elapsed:.0f} s ({_n_done} shards)")'''

    cell_phase2 = '''\
# ── Phase 2: load model once; fit PCA on a sample of titles ──────────────────
_PCA_CACHE = CACHE / "pca_components.npz"

if WIKI_PARQUET.exists():
    print("wiki.parquet already cached — skipping Phase 2")
else:
    print("Phase 2: loading model...")
    _t0 = time.perf_counter()
    model = StaticModel.from_pretrained("minishlab/potion-multilingual-128M")
    print(f"  Model loaded in {time.perf_counter() - _t0:.1f} s (dim={model.dim})")

    if _PCA_CACHE.exists():
        _npz = np.load(_PCA_CACHE)
        _pca_mean, _pca_components = _npz["mean"], _npz["components"]
        print(f"Loaded PCA cache: mean {_pca_mean.shape}, components {_pca_components.shape}")
    else:
        # Collect up to PCA_SAMPLE titles from the text parquets
        _sample_titles: list[str] = []
        for _lang, _shards in shards_by_lang.items():
            for _fname, _ in _shards:
                _stem = f"{_lang}_{_fname.replace(\'.parquet\', \'\')}"
                _t = pq.read_table(CACHE_TEXT / f"{_stem}.parquet", columns=["title"])
                _sample_titles.extend(_t["title"].to_pylist())
                if len(_sample_titles) >= PCA_SAMPLE:
                    break
            if len(_sample_titles) >= PCA_SAMPLE:
                break

        _rng = np.random.default_rng(42)
        _idx = _rng.choice(len(_sample_titles), min(PCA_SAMPLE, len(_sample_titles)), replace=False)
        _sample = [_sample_titles[int(i)] for i in sorted(_idx)]
        del _sample_titles

        print(f"  Embedding {len(_sample):,} titles for PCA fitting...")
        _t1 = time.perf_counter()
        _sample_embs = _embed_batched(model, _sample)
        _rate = len(_sample) / (time.perf_counter() - _t1)
        print(f"  Embedded in {time.perf_counter() - _t1:.1f} s ({_rate:,.0f} titles/s)")

        # Fit PCA via covariance eigendecomposition (p=256, so cov is small)
        _pca_mean = _sample_embs.mean(axis=0)
        _C = (_sample_embs - _pca_mean).astype(np.float32)
        _cov = (_C.T @ _C) / (len(_C) - 1)
        _evals, _evecs = np.linalg.eigh(_cov.astype(np.float64))
        _order = np.argsort(_evals)[::-1]
        _pca_components = _evecs[:, _order[:N_COMPONENTS]].T.astype(np.float32)
        del _C, _cov, _evals, _evecs, _sample_embs

        np.savez(_PCA_CACHE, mean=_pca_mean, components=_pca_components)
        print(f"  PCA fitted and cached ({_pca_components.shape})")'''

    cell_phase3 = '''\
# ── Phase 3: embed every shard, apply PCA, save per-shard feature parquets ───
if WIKI_PARQUET.exists():
    print("wiki.parquet already cached — skipping Phase 3")
else:
    print("Phase 3: embedding and projecting all shards...")
    _t0 = time.perf_counter()
    _n_already = 0
    _n_new = 0
    _total_rows = 0

    for _lang, _shards in shards_by_lang.items():
        for _fname, _ in _shards:
            _stem = f"{_lang}_{_fname.replace(\'.parquet\', \'\')}"
            _feat_path = CACHE_FEAT / f"{_stem}.parquet"

            if _feat_path.exists():
                _total_rows += pq.read_metadata(_feat_path).num_rows
                _n_already += 1
                continue

            _tbl    = pq.read_table(CACHE_TEXT / f"{_stem}.parquet")
            _titles = _tbl["title"].to_pylist()

            _t1   = time.perf_counter()
            _embs = _embed_batched(model, _titles)
            _proj = ((_embs - _pca_mean) @ _pca_components.T).astype(np.float32)
            _rate = len(_titles) / (time.perf_counter() - _t1)

            _meta = {col: _tbl[col].to_pylist() for col in ["title", "url", "language", "first_sentence"]}
            _feat = {f"f{i}": _proj[:, i] for i in range(N_COMPONENTS)}
            pq.write_table(pa.table({**_meta, **_feat}), _feat_path)

            _total_rows += len(_titles)
            _n_new += 1
            _elapsed = time.perf_counter() - _t0
            _done    = _n_already + _n_new
            _eta     = (_elapsed / _n_new) * (total_shards - _done) if _n_new else 0
            print(
                f"  {_lang}/{_fname}: {len(_titles):,} rows at {_rate:,.0f}/s"
                f" ({_done}/{total_shards}, ETA {_eta/60:.1f} min)"
            )

    if not WIKI_PARQUET.exists():
        print(f"Phase 3 done — {_total_rows:,} rows across {total_shards} shards")'''

    cell_phase4 = '''\
# ── Phase 4: concatenate per-shard feature parquets into wiki.parquet ─────────
if WIKI_PARQUET.exists():
    print("wiki.parquet already cached — skipping Phase 4")
else:
    print("Phase 4: concatenating into wiki.parquet...")
    _t0  = time.perf_counter()
    _tmp = CACHE / "wiki.parquet.part"
    _writer: pq.ParquetWriter | None = None

    for _lang, _shards in shards_by_lang.items():
        for _fname, _ in _shards:
            _stem = f"{_lang}_{_fname.replace(\'.parquet\', \'\')}"
            _tbl  = pq.read_table(CACHE_FEAT / f"{_stem}.parquet")
            if _writer is None:
                _writer = pq.ParquetWriter(str(_tmp), _tbl.schema)
            _writer.write_table(_tbl)

    if _writer:
        _writer.close()
    _tmp.rename(WIKI_PARQUET)
    _size_gb = WIKI_PARQUET.stat().st_size / 1e9
    print(f"Phase 4 done in {time.perf_counter() - _t0:.0f} s — {_size_gb:.2f} GB")'''

    cell_load = '''\
wiki = pl.read_parquet(WIKI_PARQUET)
wiki.shape'''

    return notebook([
        md(WIKIPEDIA_INTRO),
        code(cell_config),
        code(cell_imports),
        code(cell_shards),
        code(cell_phase1),
        code(cell_phase2),
        code(cell_phase3),
        code(cell_phase4),
        code(cell_load),
        md(HOW_TO_OPEN.format(var="wiki")),
        md(f"## Things to try\n\n{WIKIPEDIA_THINGS}"),
    ])


CHEMBL_INTRO = """\
# ChEMBL 37 chemical space (2.4 M × 64)

[ChEMBL 37](https://www.ebi.ac.uk/chembl/) is a manually curated database of bioactive
molecules with drug-like properties maintained by EMBL-EBI.  Each row is one compound,
represented as a 64-dimensional TruncatedSVD projection of a 2048-bit Morgan fingerprint
(radius 2) computed with [RDKit](https://www.rdkit.org/).

**Licence:** ChEMBL data is released under
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).
RDKit is BSD-licensed.  scikit-learn is BSD-licensed.

**Data source:** `chembl_37_chemreps.txt.gz` from the
[ChEMBL FTP site](https://ftp.ebi.ac.uk/pub/databases/chembl/ChEMBLdb/latest/)
(292 MB compressed, ~2.4 M compounds).  Compound names and clinical-phase metadata
are fetched for named compounds only via the
[ChEMBL REST API](https://www.ebi.ac.uk/chembl/api/data/).
Structure images use the ChEMBL image API (PNG format).

**Image decision:** compound structure thumbnails use the PNG endpoint
(`…/api/data/image/<id>.png`) rather than SVG.  PNG rasterises reliably in every
Atlas code path — hover card *and* annotation overlay — without any special handling.
The SVG endpoint (`…/<id>.svg`) works in the hover card but can yield zero-dimension
thumbnails in the annotation overlay's canvas rasterisation path.

**First run:** downloading takes a few minutes; fingerprint computation and SVD
projection for all 2.4 M compounds takes roughly 5–15 minutes depending on hardware.
The final `chembl.parquet` is cached in `~/.cache/positron-atlas/datasets/chembl/`.
Subsequent runs skip every step that is already cached.

**Quick try:** set `SAMPLE = True` to process only the first 100,000 compounds
(under 1 minute on most machines).

**What to try in Atlas:**
- Hover a point to see the compound name, structure image (`image_url` column) and
  a link to the ChEMBL compound page.
- Color by `max_phase` to highlight clinical-stage compounds (phase 4 = approved drugs).
- Color by `mw` (histogram filter) to explore molecular weight.
- Search for a drug name such as *aspirin*, *imatinib*, or *sildenafil*.
- Turn on cluster labels to discover structural families.
- Annotate a cluster of approved CNS drugs or kinase inhibitors.
"""

CHEMBL_THINGS = """\
- **Color by `max_phase`.**  Clinical phase 4 (approved drugs) forms a distinctive
  population; phase 0 / null compounds are the vast majority.
- **Color by `mw`** and use the histogram filter to zoom in on drug-like compounds
  (MW 150–500).  The Lipinski "rule of five" space becomes visible.
- **Hover** a compound: the structure image is loaded from the ChEMBL image API (PNG).
  Set `image_url` as the **Image URL column** in the **Tooltip** tab if Atlas does not
  auto-detect it.
- **Cmd/Ctrl-click** (when `url` is the link column) to open the compound card on
  the ChEMBL website.
- **Search** for *aspirin*, *imatinib*, or *sildenafil* to find approved drugs and see
  where they sit in chemical space.
- **Annotate** the imatinib cluster (kinase inhibitors) or aspirin / NSAID cluster.
"""


def chembl_chemical_space() -> dict:
    """Generate the ChEMBL chemical space notebook."""
    cell_config = '''\
# ── Configuration ──────────────────────────────────────────────────────────────
# Set SAMPLE = True to process only the first 100,000 compounds (< 1 min).
# Set SAMPLE = False for the full 2.4 M compounds (~5–15 min first run).
SAMPLE = False

CHEMREPS_URL = "https://ftp.ebi.ac.uk/pub/databases/chembl/ChEMBLdb/latest/chembl_37_chemreps.txt.gz"
N_COMPONENTS = 64     # TruncatedSVD output dimensions (f0 … f63)
CHUNK_SIZE   = 50_000 # compounds per fingerprint / projection chunk
SVD_SAMPLE   = 200_000  # compounds used to fit TruncatedSVD
SAMPLE_N     = 100_000  # compounds to process in SAMPLE mode'''

    cell_imports = '''\
import csv, gzip, json, time, urllib.request
from pathlib import Path

import numpy as np
import polars as pl
from rdkit import Chem, DataStructs
from rdkit.Chem import AllChem, Descriptors
from scipy.sparse import lil_matrix
from sklearn.decomposition import TruncatedSVD
import pyarrow as pa
import pyarrow.parquet as pq

CACHE = Path.home() / ".cache" / "positron-atlas" / "datasets" / "chembl"
CHEMREPS_PATH = CACHE / "chembl_37_chemreps.txt.gz"
SVD_CACHE     = CACHE / "svd_components.npz"
FEATURES_PATH = CACHE / "chembl_features.parquet"
META_PATH     = CACHE / "chembl_meta.parquet"
CHEMBL_PATH   = CACHE / "chembl.parquet"
CACHE.mkdir(parents=True, exist_ok=True)


def _download(url: str, path: Path) -> Path:
    """Download url to path atomically; skip if already present."""
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    print(f"Downloading {url} ...")
    urllib.request.urlretrieve(url, tmp)
    tmp.rename(path)
    return path


def _mol_to_fp(mol) -> np.ndarray:
    """Return 2048-bit Morgan (radius-2) fingerprint as uint8 array."""
    arr = np.zeros(2048, dtype=np.uint8)
    if mol is not None:
        DataStructs.ConvertToNumpyArray(
            AllChem.GetMorganFingerprintAsBitVect(mol, radius=2, nBits=2048), arr,
        )
    return arr'''

    cell_phase1 = '''\
# ── Phase 1: download chemreps ────────────────────────────────────────────────
if CHEMBL_PATH.exists():
    print("chembl.parquet already cached — skipping all phases")
elif CHEMREPS_PATH.exists():
    print(f"chemreps already downloaded ({CHEMREPS_PATH.stat().st_size / 1e9:.2f} GB)")
else:
    _t0 = time.perf_counter()
    _download(CHEMREPS_URL, CHEMREPS_PATH)
    print(f"Downloaded in {time.perf_counter() - _t0:.0f} s  ({CHEMREPS_PATH.stat().st_size / 1e9:.2f} GB)")'''

    cell_phase2 = '''\
# ── Phase 2: fit TruncatedSVD on a sample of Morgan fingerprints ─────────────
# TruncatedSVD (no mean-centering) is appropriate for bit matrices.
# We build a scipy sparse matrix for the sample to keep memory under control
# (~100 bits set per fingerprint → ~95 % sparsity).

if CHEMBL_PATH.exists():
    print("chembl.parquet already cached — skipping Phase 2")
elif SVD_CACHE.exists():
    _npz = np.load(SVD_CACHE)
    _svd_components = _npz["components"]          # shape (N_COMPONENTS, 2048)
    print(f"Loaded SVD cache: {_svd_components.shape}")
else:
    _n_target = min(SVD_SAMPLE, SAMPLE_N if SAMPLE else SVD_SAMPLE)
    print(f"Phase 2: reading up to {_n_target:,} fingerprints for SVD fitting...")
    _t0 = time.perf_counter()
    _sample_fps: list[np.ndarray] = []

    with gzip.open(CHEMREPS_PATH, "rt") as _f:
        _reader = csv.DictReader(_f, delimiter="\t")
        for _row in _reader:
            if len(_sample_fps) >= _n_target:
                break
            _mol = Chem.MolFromSmiles(_row["canonical_smiles"] or "")
            _sample_fps.append(_mol_to_fp(_mol))

    print(f"  Read {len(_sample_fps):,} fingerprints in {time.perf_counter() - _t0:.0f} s; building sparse matrix...")
    _t1 = time.perf_counter()
    _sparse = lil_matrix((len(_sample_fps), 2048), dtype=np.float32)
    for _i, _fp in enumerate(_sample_fps):
        _nz = _fp.nonzero()[0]
        if _nz.size:
            _sparse[_i, _nz] = 1.0
    _X = _sparse.tocsr()
    del _sparse, _sample_fps

    print(f"  Sparse matrix ({_X.shape}) built in {time.perf_counter() - _t1:.0f} s; fitting TruncatedSVD({N_COMPONENTS})...")
    _svd = TruncatedSVD(n_components=N_COMPONENTS, random_state=42)
    _svd.fit(_X)
    del _X

    _svd_components = _svd.components_.astype(np.float32)   # (64, 2048)
    np.savez(SVD_CACHE, components=_svd_components)
    print(f"  SVD fitted and cached in {time.perf_counter() - _t0:.0f} s — {_svd_components.shape}")'''

    cell_phase3 = '''\
# ── Phase 3: compute fingerprints and MW for all compounds, project to 64 dims ─
# Processes CHUNK_SIZE compounds at a time; total memory stays under ~1 GB.

if CHEMBL_PATH.exists():
    print("chembl.parquet already cached — skipping Phase 3")
elif FEATURES_PATH.exists():
    print("Features parquet already cached")
else:
    print("Phase 3: fingerprinting all compounds...")
    _t0 = time.perf_counter()
    _all_ids: list[str] = []
    _all_mws: list[float | None] = []
    _all_feats_parts: list[np.ndarray] = []
    _chunk_ids: list[str] = []
    _chunk_mws: list[float | None] = []
    _chunk_fps: list[np.ndarray] = []
    _n_total = _n_invalid = 0

    def _flush_chunk() -> None:
        _X = np.stack(_chunk_fps, axis=0).astype(np.float32)
        _all_feats_parts.append(_X @ _svd_components.T)
        _all_ids.extend(_chunk_ids)
        _all_mws.extend(_chunk_mws)
        _chunk_ids.clear(); _chunk_mws.clear(); _chunk_fps.clear()

    with gzip.open(CHEMREPS_PATH, "rt") as _f:
        _reader = csv.DictReader(_f, delimiter="\t")
        for _row in _reader:
            if SAMPLE and _n_total >= SAMPLE_N:
                break
            _mol = Chem.MolFromSmiles(_row["canonical_smiles"] or "")
            if _mol is None:
                _n_invalid += 1
            _chunk_ids.append(_row["chembl_id"])
            _chunk_mws.append(round(Descriptors.MolWt(_mol), 2) if _mol else None)
            _chunk_fps.append(_mol_to_fp(_mol))
            _n_total += 1
            if len(_chunk_fps) >= CHUNK_SIZE:
                _flush_chunk()
                _elapsed = time.perf_counter() - _t0
                print(f"  {_n_total:,} compounds at {_n_total / _elapsed:,.0f}/s")

    if _chunk_fps:
        _flush_chunk()

    _all_feats = np.concatenate(_all_feats_parts, axis=0).astype(np.float32)
    print(
        f"Phase 3 done: {len(_all_ids):,} compounds ({_n_invalid:,} invalid SMILES) "
        f"in {time.perf_counter() - _t0:.0f} s"
    )

    _cols: dict = {"chembl_id": _all_ids, "mw": pa.array(_all_mws, type=pa.float32())}
    for _i in range(N_COMPONENTS):
        _cols[f"f{_i}"] = _all_feats[:, _i]
    pq.write_table(pa.table(_cols), FEATURES_PATH)
    print(f"Saved features parquet ({FEATURES_PATH.stat().st_size / 1e6:.0f} MB)")
    del _all_feats, _all_feats_parts'''

    cell_phase4 = '''\
# ── Phase 4: fetch pref_name and max_phase for named compounds via REST API ────
# Only compounds with a preferred name are fetched (~15,000 out of 2.4 M).
# For the remaining compounds, the title column falls back to chembl_id.

if CHEMBL_PATH.exists():
    print("chembl.parquet already cached — skipping Phase 4")
elif META_PATH.exists():
    print("Metadata parquet already cached")
else:
    print("Phase 4: fetching named-compound metadata from ChEMBL API...")
    _t0 = time.perf_counter()
    _meta_ids: list[str] = []
    _meta_names: list[str | None] = []
    _meta_phases: list[float | None] = []
    _offset = 0
    _limit  = 1000
    _total  = None

    while True:
        _url = (
            "https://www.ebi.ac.uk/chembl/api/data/molecule.json"
            f"?pref_name__isnull=False&limit={_limit}&offset={_offset}"
            "&fields=molecule_chembl_id,pref_name,max_phase"
        )
        _req = urllib.request.Request(_url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(_req, timeout=30) as _resp:
            _data = json.loads(_resp.read())

        for _m in _data["molecules"]:
            _meta_ids.append(_m["molecule_chembl_id"])
            _meta_names.append(_m.get("pref_name"))
            _phase = _m.get("max_phase")
            _meta_phases.append(float(_phase) if _phase is not None else None)

        if _total is None:
            _total = _data["page_meta"]["total_count"]
            print(f"  Total named compounds: {_total:,}")

        _offset += _limit
        if _offset >= _total:
            break
        if _offset % 5_000 == 0:
            print(f"  {_offset:,}/{_total:,} ...")

    pq.write_table(
        pa.table({
            "chembl_id":  _meta_ids,
            "pref_name":  pa.array(_meta_names, type=pa.string()),
            "max_phase":  pa.array(_meta_phases, type=pa.float32()),
        }),
        META_PATH,
    )
    print(f"Phase 4 done: {len(_meta_ids):,} named compounds in {time.perf_counter() - _t0:.0f} s")'''

    cell_phase5 = '''\
# ── Phase 5: join features and metadata, write chembl.parquet ─────────────────
if CHEMBL_PATH.exists():
    print("chembl.parquet already cached — loading")
else:
    print("Phase 5: joining features and metadata...")
    _feats = pl.read_parquet(FEATURES_PATH)
    _meta  = pl.read_parquet(META_PATH)

    chembl = (
        _feats
        .join(_meta, on="chembl_id", how="left")
        .with_columns(
            pl.coalesce(["pref_name", "chembl_id"]).alias("title"),
            pl.format(
                "https://www.ebi.ac.uk/chembl/compound_report_card/{}/",
                pl.col("chembl_id"),
            ).alias("url"),
            pl.format(
                "https://www.ebi.ac.uk/chembl/api/data/image/{}.png",
                pl.col("chembl_id"),
            ).alias("image_url"),
        )
        .drop("pref_name")
        .select(
            ["chembl_id", "title", "url", "image_url", "max_phase", "mw"]
            + [f"f{i}" for i in range(N_COMPONENTS)]
        )
    )
    chembl.write_parquet(CHEMBL_PATH)
    print(f"Saved chembl.parquet ({CHEMBL_PATH.stat().st_size / 1e9:.2f} GB, {len(chembl):,} rows)")

chembl = pl.read_parquet(CHEMBL_PATH)
chembl.shape'''

    return notebook([
        md(CHEMBL_INTRO),
        code(cell_config),
        code(cell_imports),
        code(cell_phase1),
        code(cell_phase2),
        code(cell_phase3),
        code(cell_phase4),
        code(cell_phase5),
        md(HOW_TO_OPEN.format(var="chembl")),
        md(f"## Things to try\n\n{CHEMBL_THINGS}"),
    ])


UNIPROT_INTRO = """\
# UniProt human proteome — ProtT5 embeddings (20 k × 1024)

[UniProt](https://www.uniprot.org/) is the central resource for protein sequence and
functional information.  This notebook maps the human reference proteome
(**UP000005640**, Homo sapiens) using per-protein
[ProtT5-XL-U50](https://github.com/agemagician/ProtTrans) embeddings precomputed by
the UniProt team and hosted on the UniProt FTP server.

**Licence:** UniProt data is licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); verify at
<https://www.uniprot.org/help/license>.  The ProtTrans models are MIT-licensed.

**Data sources:**
- Embeddings: `per-protein.h5` from
  <https://ftp.uniprot.org/pub/databases/uniprot/current_release/knowledgebase/embeddings/UP000005640_9606/>
  (~84 MB, 20,588 proteins × 1024 dims, float16 HDF5).
- Metadata: streamed as TSV from the UniProt REST API
  (`https://rest.uniprot.org/uniprotkb/stream?…`).

**First run:** downloading the HDF5 file takes about 1 minute; reading embeddings and
fetching metadata adds another minute.  Results are cached in
`~/.cache/positron-atlas/datasets/uniprot/`.

**Quick try:** set `SAMPLE = True` to load only the first 2,000 proteins (seconds).

**Anchor budget note:** With 1024 feature dimensions, Atlas's WebGPU UMAP can use up to
10 M / 1024 ≈ 9,765 anchors.  Since the human proteome has ~20 k proteins, only about
half will be exact anchors and the rest will be placed.  For a fully exact run, enable
**Apply PCA first** (50 components) in the Atlas **Data** tab before clicking **Apply**.

**What to try in Atlas:**
- Hover a protein to see its name, gene, and family, and open it on UniProt.
- Color by `family` to see broad structural/functional groups.
- Color by `length` (protein length) with the histogram filter.
- Search for *EGFR*, *TP53*, or *BRCA1* to locate known cancer proteins.
- Enable **Apply PCA first** (50 dims) in the Data tab so UMAP runs on all 20 k proteins
  without sampling.
- Turn on cluster labels to discover functional clusters.
"""

UNIPROT_THINGS = """\
- **Color by `family`.** Protein families (kinases, GPCRs, immunoglobulins, …) form
  distinct clusters.  The legend lets you toggle families on and off.
- **Color by `length`** and use the histogram slider to isolate short peptides or
  large structural proteins.
- **Search** for *EGFR*, *TP53*, *BRCA1*, or *ACTB* to find well-known proteins and
  see their neighbours.
- **Enable *Apply PCA first*** (50 components) in the Atlas **Data** tab before
  clicking **Apply**. This reduces the feature space from 1024 to 50 dims so UMAP
  runs on all 20 k proteins exactly (no anchor placement needed).
- **Hover a point** and click **Open link** to view the UniProt entry.
- **Add umap_x / umap_y** in the **Export** tab, then run:

  ```python
  uniprot.group_by("family").agg(pl.col("umap_x", "umap_y").mean()).sort("family")
  ```
"""


def uniprot_protein_embeddings() -> dict:
    """Generate the UniProt protein embeddings notebook."""
    cell_config = '''\
# ── Configuration ──────────────────────────────────────────────────────────────
# Set SAMPLE = True to load only the first 2,000 proteins (seconds).
# Set SAMPLE = False for the full human reference proteome (~20 k proteins).
SAMPLE = False

PROTEOME      = "UP000005640_9606"   # human reference proteome
EMBEDDINGS_URL = (
    "https://ftp.uniprot.org/pub/databases/uniprot/current_release"
    "/knowledgebase/embeddings/UP000005640_9606/per-protein.h5"
)
META_URL = (
    "https://rest.uniprot.org/uniprotkb/stream"
    "?query=proteome:UP000005640&format=tsv"
    "&fields=accession,protein_name,gene_names,organism_name,protein_families,length"
)
SAMPLE_N = 2_000'''

    cell_imports = '''\
import time, urllib.request
from pathlib import Path

import h5py
import numpy as np
import polars as pl

CACHE = Path.home() / ".cache" / "positron-atlas" / "datasets" / "uniprot"
EMBEDDINGS_PATH = CACHE / "per-protein-UP000005640_9606.h5"
META_PATH       = CACHE / "uniprot_human_meta.tsv"
UNIPROT_PATH    = CACHE / "uniprot.parquet"
CACHE.mkdir(parents=True, exist_ok=True)


def _download(url: str, path: Path) -> Path:
    """Download url to path atomically; skip if already present."""
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    print(f"Downloading {url} ...")
    urllib.request.urlretrieve(url, tmp)
    tmp.rename(path)
    return path'''

    cell_phase1 = '''\
# ── Phase 1: download the ProtT5 HDF5 embeddings file ─────────────────────────
if UNIPROT_PATH.exists():
    print("uniprot.parquet already cached — skipping all phases")
elif EMBEDDINGS_PATH.exists():
    print(f"Embeddings already downloaded ({EMBEDDINGS_PATH.stat().st_size / 1e6:.0f} MB)")
else:
    _t0 = time.perf_counter()
    _download(EMBEDDINGS_URL, EMBEDDINGS_PATH)
    print(f"Downloaded in {time.perf_counter() - _t0:.0f} s  ({EMBEDDINGS_PATH.stat().st_size / 1e6:.0f} MB)")'''

    cell_phase2 = '''\
# ── Phase 2: stream metadata from the UniProt REST API ────────────────────────
# Fields: accession, protein name, gene names, organism, protein families, length.
# The stream returns a TSV with one row per protein; cached as a local file.

if UNIPROT_PATH.exists():
    print("uniprot.parquet already cached — skipping Phase 2")
elif META_PATH.exists():
    print(f"Metadata already cached ({META_PATH.stat().st_size / 1e3:.0f} kB)")
else:
    print("Phase 2: fetching metadata from UniProt REST API...")
    _t0 = time.perf_counter()
    _req = urllib.request.Request(META_URL, headers={"Accept": "text/plain"})
    with urllib.request.urlopen(_req, timeout=120) as _resp:
        _raw = _resp.read()
    META_PATH.write_bytes(_raw)
    print(f"Metadata saved ({META_PATH.stat().st_size / 1e3:.0f} kB) in {time.perf_counter() - _t0:.0f} s")'''

    cell_phase3 = '''\
# ── Phase 3: load embeddings + metadata, produce final DataFrame ──────────────
if UNIPROT_PATH.exists():
    print("uniprot.parquet already cached — loading")
else:
    print("Phase 3: loading embeddings and joining metadata...")
    _t0 = time.perf_counter()

    # Load embeddings from HDF5; each key is a UniProt accession.
    with h5py.File(EMBEDDINGS_PATH, "r") as _f:
        _accs = sorted(_f.keys())                             # sorted for reproducibility
        if SAMPLE:
            _accs = _accs[:SAMPLE_N]
        _embeddings = np.stack([_f[a][:] for a in _accs]).astype(np.float32)

    print(f"  Loaded {len(_accs):,} embeddings × {_embeddings.shape[1]} dims in {time.perf_counter() - _t0:.0f} s")

    # Read metadata TSV; rename columns to short names.
    _meta = (
        pl.read_csv(META_PATH, separator="\t", infer_schema_length=10_000)
        .rename({
            "Entry":            "accession",
            "Protein names":    "title",
            "Gene Names":       "gene",
            "Organism":         "organism",
            "Protein families": "family",
            "Length":           "length",
        })
        .with_columns(
            # Keep only the first (recommended) protein name: text before " (".
            pl.col("title").str.replace(r"\\s*\\(.*", "").alias("title"),
            # Keep only the first gene name.
            pl.col("gene").str.split(" ").list.first().alias("gene"),
            # Shorten organism name: "Homo sapiens (Human)" → "Homo sapiens".
            pl.col("organism").str.replace(r"\\s*\\(.*", "").alias("organism"),
            # Keep only the first protein family.
            pl.col("family").str.split(",").list.first().alias("family"),
            pl.col("length").cast(pl.Int32),
        )
    )

    # Build embedding columns (e0 … e1023).
    _n_dims = _embeddings.shape[1]
    _emb_df = pl.from_numpy(_embeddings, schema=[f"e{i}" for i in range(_n_dims)])

    # Assemble final DataFrame: metadata columns + URL + embedding columns.
    _ids_df = pl.DataFrame({"accession": _accs})
    uniprot = (
        _ids_df
        .join(_meta, on="accession", how="left")
        .with_columns(
            pl.format("https://www.uniprot.org/uniprotkb/{}/entry", pl.col("accession")).alias("url"),
        )
        .select(["accession", "title", "gene", "family", "organism", "length", "url"])
        .hstack(_emb_df)
    )

    uniprot.write_parquet(UNIPROT_PATH)
    print(f"Saved uniprot.parquet ({UNIPROT_PATH.stat().st_size / 1e6:.0f} MB, {len(uniprot):,} rows) in {time.perf_counter() - _t0:.0f} s")

uniprot = pl.read_parquet(UNIPROT_PATH)
uniprot.shape'''

    return notebook([
        md(UNIPROT_INTRO),
        code(cell_config),
        code(cell_imports),
        code(cell_phase1),
        code(cell_phase2),
        code(cell_phase3),
        md(HOW_TO_OPEN.format(var="uniprot")),
        md(f"## Things to try\n\n{UNIPROT_THINGS}"),
    ])


TRIALS_INTRO = """\
# ClinicalTrials.gov (612 k studies × 64)

[ClinicalTrials.gov](https://clinicaltrials.gov/) is a database of privately and
publicly funded clinical studies.  This notebook downloads study metadata via the
[ClinicalTrials.gov API v2](https://clinicaltrials.gov/data-api/api), embeds the brief
title of each study with the
[`minishlab/potion-base-8M`](https://huggingface.co/minishlab/potion-base-8M)
static embedding model (English, 256 dims), and reduces to 64 dims with PCA —
exactly as the Wikipedia notebook does for article titles.

**Terms of use:** ClinicalTrials.gov data are in the public domain; see the
[NLM copyright and disclaimer notice](https://www.nlm.nih.gov/copyright.html) and the
[ClinicalTrials.gov terms and conditions](https://clinicaltrials.gov/about-site/terms-conditions).
Commercial redistribution of the raw data may require a data licence; always consult
the current terms before redistributing.

**Data source:** ClinicalTrials.gov API v2 — paginated JSON, `pageSize=1000`, fields:
NCTId, BriefTitle, Phase, OverallStatus, LeadSponsorClass, Conditions, StartDate,
EnrollmentCount.  Pages are cached in `~/.cache/positron-atlas/datasets/trials/pages/`.
Full download is ~612 k studies across ~613 pages.

**Embedding model:** `minishlab/potion-base-8M` (model2vec, English, MIT licence).

**First run:** downloading all pages takes roughly 15–30 minutes (rate-limited); the
embedding + PCA step adds 5–10 minutes.  Results are cached in
`~/.cache/positron-atlas/datasets/trials/trials.parquet`.
Subsequent runs skip every step that is already cached.

**Quick try:** set `SAMPLE = True` to download only the first 100 pages (~100 k studies,
a few minutes).

**What to try in Atlas:**
- Hover a study to see its title and open it on ClinicalTrials.gov.
- Color by `phase` to see the clinical-trial landscape.
- Color by `sponsor_class` (INDUSTRY vs NIH vs OTHER) to see funding patterns.
- Use the histogram filter on `start_date` to explore when trials started.
- Filter on `enrollment` to focus on large trials.
- Search for *COVID-19*, *diabetes*, or *Alzheimer* to find specific disease areas.
- Annotate clusters corresponding to oncology or cardiovascular trials.
"""

TRIALS_THINGS = """\
- **Color by `phase`.**  Phase 3 and 4 trials cluster together; Phase 1 (first-in-human)
  sits in a broad, dispersed region.
- **Color by `sponsor_class`.**  Industry-sponsored and NIH-funded trials have distinct
  spatial patterns.
- **Histogram filter on `start_date`.**  Slide the range to watch the clinical-trial
  landscape evolve over time.  The COVID-19 surge in 2020–2021 becomes visible.
- **Histogram filter on `enrollment`.**  Set a minimum of 1,000 to focus on large trials.
- **Search** for *COVID-19*, *diabetes*, or *breast cancer* to find disease clusters.
  Try *vaccine*, *placebo*, or *randomized* for trial-design keywords.
- **Turn on cluster labels** to discover disease areas.
- **Annotate** the COVID-19 vaccine cluster (2020 trials) or the large oncology region.
"""


def clinical_trials() -> dict:
    """Generate the ClinicalTrials.gov notebook."""
    cell_config = '''\
# ── Configuration ──────────────────────────────────────────────────────────────
# Set SAMPLE = True to download only 100 pages (~100 k studies, a few minutes).
# Set SAMPLE = False for the full ~612 k studies (~30 min first run).
SAMPLE = False

PAGE_SIZE    = 1000     # studies per API page
SAMPLE_PAGES = 100      # pages to download in SAMPLE mode
N_COMPONENTS = 64       # PCA output dimensions (f0 … f63)
BATCH_SIZE   = 4096     # titles per embedding batch
PCA_SAMPLE   = 100_000  # titles used to fit PCA
REQUEST_DELAY = 0.1     # seconds between API requests (be polite)'''

    cell_imports = '''\
import json, time, urllib.error, urllib.request
from pathlib import Path

import numpy as np
import polars as pl
from model2vec import StaticModel

CACHE     = Path.home() / ".cache" / "positron-atlas" / "datasets" / "trials"
PAGES_DIR = CACHE / "pages"
TRIALS_PARQUET = CACHE / "trials.parquet"
PCA_CACHE      = CACHE / "pca_components.npz"
PAGES_DIR.mkdir(parents=True, exist_ok=True)

_API_BASE = "https://clinicaltrials.gov/api/v2/studies"
_FIELDS   = (
    "NCTId,BriefTitle,Phase,OverallStatus,LeadSponsorClass,"
    "ConditionBrowseModule,StartDate,EnrollmentCount"
)


def _page_path(n: int) -> Path:
    return PAGES_DIR / f"page_{n:06d}.json"


def _extract_study(study: dict) -> dict:
    """Extract flat fields from a v2 study object."""
    proto  = study.get("protocolSection", {})
    ident  = proto.get("identificationModule", {})
    status = proto.get("statusModule", {})
    design = proto.get("designModule", {})
    sponsor = proto.get("sponsorCollaboratorsModule", {})
    conds  = proto.get("conditionsModule", {})

    phases = design.get("phases", [])
    phase  = phases[0].replace("PHASE", "Phase ") if phases else None

    sponsor_class = (sponsor.get("leadSponsor") or {}).get("class")

    # conditions come from either conditionsModule or the browse mesh
    cond_list = conds.get("conditions", [])
    if not cond_list:
        cond_list = [
            m.get("meshTerm", "")
            for m in (study.get("derivedSection", {})
                      .get("conditionBrowseModule", {})
                      .get("meshes", []))
        ]
    condition = cond_list[0] if cond_list else None

    start_struct = status.get("startDateStruct", {})
    start_date   = start_struct.get("date")           # "YYYY-MM" or "YYYY-MM-DD"
    if start_date and len(start_date) == 7:
        start_date += "-01"                            # normalise to full date

    enroll_info  = design.get("enrollmentInfo") or {}
    enrollment   = enroll_info.get("count")

    return {
        "nct_id":        ident.get("nctId", ""),
        "title":         ident.get("briefTitle", ""),
        "phase":         phase,
        "status":        status.get("overallStatus"),
        "sponsor_class": sponsor_class,
        "conditions":    condition,
        "start_date":    start_date,
        "enrollment":    enrollment,
    }


def _embed_batched(model: StaticModel, titles: list[str]) -> np.ndarray:
    """Embed titles in BATCH_SIZE chunks; return float32 (n, dim) array."""
    out = []
    for i in range(0, len(titles), BATCH_SIZE):
        out.append(model.encode(titles[i : i + BATCH_SIZE]))
    return np.concatenate(out, axis=0).astype(np.float32)'''

    cell_phase1 = '''\
# ── Phase 1: paginate the API, caching each page as JSON ──────────────────────
# Resume-safe: pages already on disk are skipped; the next page token is read
# from the last cached page.

if TRIALS_PARQUET.exists():
    print("trials.parquet already cached — skipping Phase 1")
else:
    _existing = sorted(PAGES_DIR.glob("page_*.json"))
    _n_start  = len(_existing)
    if _n_start:
        _last_data  = json.loads(_existing[-1].read_text())
        _page_token = _last_data.get("nextPageToken")
        print(f"Resuming from page {_n_start} (token: {_page_token!r})")
    else:
        _page_token = None

    _page_num     = _n_start
    _total_so_far = sum(len(json.loads(p.read_text()).get("studies", [])) for p in _existing)
    _t0           = time.perf_counter()

    while True:
        if SAMPLE and _page_num >= SAMPLE_PAGES:
            break
        if _page_token is None and _page_num > 0:
            break

        _url = f"{_API_BASE}?pageSize={PAGE_SIZE}&fields={_FIELDS}"
        if _page_token:
            _url += f"&pageToken={_page_token}"

        for _attempt in range(5):
            try:
                with urllib.request.urlopen(_url, timeout=30) as _resp:
                    _data = json.loads(_resp.read())
                break
            except (urllib.error.URLError, OSError) as _e:
                _wait = 2 ** _attempt
                print(f"  Retry {_attempt + 1}/5 after {_wait}s ({_e})")
                time.sleep(_wait)
        else:
            raise RuntimeError("API unavailable after 5 retries")

        _page_path(_page_num).write_text(json.dumps(_data))
        _n = len(_data.get("studies", []))
        _total_so_far += _n
        _page_num += 1

        if _page_num % 50 == 0 or _n < PAGE_SIZE:
            _elapsed = time.perf_counter() - _t0
            print(f"  Page {_page_num}: {_total_so_far:,} studies total ({_elapsed:.0f} s)")

        _page_token = _data.get("nextPageToken")
        if _page_token is None:
            break
        time.sleep(REQUEST_DELAY)

    print(f"Phase 1 done: {_page_num} pages, {_total_so_far:,} studies")'''

    cell_phase2 = '''\
# ── Phase 2: load model once; fit PCA on a sample of titles ───────────────────
if TRIALS_PARQUET.exists():
    print("trials.parquet already cached — skipping Phase 2")
else:
    _all_pages = sorted(PAGES_DIR.glob("page_*.json"))
    if not _all_pages:
        raise RuntimeError("No pages cached; run Phase 1 first.")

    print("Phase 2: loading model...")
    _t0 = time.perf_counter()
    model = StaticModel.from_pretrained("minishlab/potion-base-8M")
    print(f"  Model loaded in {time.perf_counter() - _t0:.1f} s (dim={model.dim})")

    if PCA_CACHE.exists():
        _npz = np.load(PCA_CACHE)
        _pca_mean, _pca_components = _npz["mean"], _npz["components"]
        print(f"Loaded PCA cache: {_pca_components.shape}")
    else:
        # Collect up to PCA_SAMPLE titles for PCA fitting.
        _sample_titles: list[str] = []
        for _p in _all_pages:
            _d = json.loads(_p.read_text())
            for _s in _d.get("studies", []):
                _t = (_s.get("protocolSection", {})
                        .get("identificationModule", {})
                        .get("briefTitle", ""))
                if _t:
                    _sample_titles.append(_t)
            if len(_sample_titles) >= PCA_SAMPLE:
                break

        _rng = np.random.default_rng(42)
        _idx = _rng.choice(len(_sample_titles), min(PCA_SAMPLE, len(_sample_titles)), replace=False)
        _sample = [_sample_titles[int(i)] for i in sorted(_idx)]
        del _sample_titles

        print(f"  Embedding {len(_sample):,} titles for PCA fitting...")
        _t1 = time.perf_counter()
        _sample_embs = _embed_batched(model, _sample)
        _rate = len(_sample) / (time.perf_counter() - _t1)
        print(f"  Embedded in {time.perf_counter() - _t1:.1f} s ({_rate:,.0f} titles/s)")

        _pca_mean = _sample_embs.mean(axis=0)
        _C = (_sample_embs - _pca_mean).astype(np.float32)
        _cov = (_C.T @ _C) / (len(_C) - 1)
        _evals, _evecs = np.linalg.eigh(_cov.astype(np.float64))
        _order = np.argsort(_evals)[::-1]
        _pca_components = _evecs[:, _order[:N_COMPONENTS]].T.astype(np.float32)
        del _C, _cov, _evals, _evecs, _sample_embs

        np.savez(PCA_CACHE, mean=_pca_mean, components=_pca_components)
        print(f"  PCA fitted and cached ({_pca_components.shape})")'''

    cell_phase3 = '''\
# ── Phase 3: embed all titles, project, assemble DataFrame ────────────────────
if TRIALS_PARQUET.exists():
    print("trials.parquet already cached — loading")
else:
    print("Phase 3: embedding all study titles and assembling DataFrame...")
    _t0 = time.perf_counter()
    _all_pages = sorted(PAGES_DIR.glob("page_*.json"))

    _rows: list[dict] = []
    _titles: list[str] = []

    for _p in _all_pages:
        _d = json.loads(_p.read_text())
        for _s in _d.get("studies", []):
            _r = _extract_study(_s)
            _rows.append(_r)
            _titles.append(_r["title"])

    print(f"  Loaded {len(_rows):,} studies; embedding titles...")
    _t1 = time.perf_counter()
    _embs = _embed_batched(model, _titles)
    _proj = ((_embs - _pca_mean) @ _pca_components.T).astype(np.float32)
    _rate = len(_titles) / (time.perf_counter() - _t1)
    print(f"  Embedded in {time.perf_counter() - _t1:.1f} s ({_rate:,.0f} titles/s)")

    _df = pl.DataFrame({
        "nct_id":        [r["nct_id"]        for r in _rows],
        "title":         [r["title"]         for r in _rows],
        "phase":         [r["phase"]         for r in _rows],
        "status":        [r["status"]        for r in _rows],
        "sponsor_class": [r["sponsor_class"] for r in _rows],
        "conditions":    [r["conditions"]    for r in _rows],
        "start_date":    pl.Series([r["start_date"] for r in _rows]).cast(pl.Date, strict=False),
        "enrollment":    pl.Series([r["enrollment"]  for r in _rows], dtype=pl.Int32),
    }).with_columns(
        pl.format("https://clinicaltrials.gov/study/{}", pl.col("nct_id")).alias("url"),
    )

    _feat_df = pl.from_numpy(_proj, schema=[f"f{i}" for i in range(N_COMPONENTS)])
    trials = _df.hstack(_feat_df)

    trials.write_parquet(TRIALS_PARQUET)
    print(f"Saved trials.parquet ({TRIALS_PARQUET.stat().st_size / 1e6:.0f} MB, {len(trials):,} rows) in {time.perf_counter() - _t0:.0f} s")

trials = pl.read_parquet(TRIALS_PARQUET)
trials.shape'''

    return notebook([
        md(TRIALS_INTRO),
        code(cell_config),
        code(cell_imports),
        code(cell_phase1),
        code(cell_phase2),
        code(cell_phase3),
        md(HOW_TO_OPEN.format(var="trials")),
        md(f"## Things to try\n\n{TRIALS_THINGS}"),
    ])


README = """\
# Example notebooks

Real high-dimensional datasets to explore with Positron Atlas. Each notebook downloads its data once, caches it in `~/.cache/positron-atlas/datasets`, and needs only **numpy** and **polars** (see exceptions below).

| Notebook | Data | Rows × features | DataFrame |
|---|---|---|---|
| [01-mnist.ipynb](01-mnist.ipynb) | Handwritten digits ([MNIST](https://yann.lecun.com/exdb/mnist/)) | 70,000 × 784 | polars |
| [02-fashion-mnist.ipynb](02-fashion-mnist.ipynb) | Clothing images ([Fashion-MNIST](https://github.com/zalandoresearch/fashion-mnist)) | 70,000 × 784 | polars |
| [03-covertype.ipynb](03-covertype.ipynb) | Forest cover types ([UCI Covertype](https://archive.ics.uci.edu/dataset/31/covertype)) | 581,012 × 10 | polars |
| [05-higgs.ipynb](05-higgs.ipynb) | Higgs boson search ([UCI HIGGS](https://archive.ics.uci.edu/dataset/280/higgs)) | 11,000,000 × 28 | polars |
| [06-wikipedia-titles.ipynb](06-wikipedia-titles.ipynb) | Wikipedia titles en+de+fr ([wikimedia/wikipedia](https://huggingface.co/datasets/wikimedia/wikipedia)) | 11.8 M × 64 | polars |
| [07-chembl-chemical-space.ipynb](07-chembl-chemical-space.ipynb) | ChEMBL 37 chemical space ([ChEMBL](https://www.ebi.ac.uk/chembl/)) | 2.4 M × 64 | polars |
| [08-uniprot-protein-embeddings.ipynb](08-uniprot-protein-embeddings.ipynb) | UniProt human proteome ProtT5 ([UniProt](https://www.uniprot.org/)) | ~20 k × 1024 | polars |
| [09-clinical-trials.ipynb](09-clinical-trials.ipynb) | ClinicalTrials.gov studies ([ClinicalTrials.gov](https://clinicaltrials.gov/)) | ~612 k × 64 | polars |

## Setup

This folder is a [uv](https://docs.astral.sh/uv/) project with everything the notebooks need (numpy, polars, ipykernel):

```sh
cd examples
uv sync                      # creates examples/.venv
uv sync --group exact        # optional: also install umap-learn for Atlas's "Kernel (umap-learn)" mode
uv sync --group wikipedia    # optional: also install model2vec and pyarrow for the Wikipedia notebook
uv sync --group chembl       # optional: also install rdkit, scikit-learn, scipy, pyarrow for the ChEMBL notebook
uv sync --group uniprot      # optional: also install h5py and pyarrow for the UniProt notebook
uv sync --group trials       # optional: also install model2vec and pyarrow for the ClinicalTrials notebook
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
        "05-higgs.ipynb": HIGGS,
        "06-wikipedia-titles.ipynb": wikipedia_titles(),
        "07-chembl-chemical-space.ipynb": chembl_chemical_space(),
        "08-uniprot-protein-embeddings.ipynb": uniprot_protein_embeddings(),
        "09-clinical-trials.ipynb": clinical_trials(),
    }
    for name, nb in nbs.items():
        (OUT / name).write_text(json.dumps(nb, indent=1, ensure_ascii=False) + "\n")
    (OUT / "README.md").write_text(README)
    print(f"Wrote {len(nbs)} notebooks to {OUT}")


if __name__ == "__main__":
    main()
