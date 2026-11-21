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

## Setup

This folder is a [uv](https://docs.astral.sh/uv/) project with everything the notebooks need (numpy, polars, ipykernel):

```sh
cd examples
uv sync                      # creates examples/.venv
uv sync --group exact        # optional: also install umap-learn for Atlas's "Kernel (umap-learn)" mode
uv sync --group wikipedia    # optional: also install model2vec and pyarrow for the Wikipedia notebook
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
    }
    for name, nb in nbs.items():
        (OUT / name).write_text(json.dumps(nb, indent=1, ensure_ascii=False) + "\n")
    (OUT / "README.md").write_text(README)
    print(f"Wrote {len(nbs)} notebooks to {OUT}")


if __name__ == "__main__":
    main()
