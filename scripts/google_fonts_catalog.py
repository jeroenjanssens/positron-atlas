"""Generate a trimmed Google Fonts catalogue snapshot.

Usage:
    uv run --project python python scripts/google_fonts_catalog.py

Fetches https://fonts.google.com/metadata/fonts (unofficial, no key; ~1,961 families, ~2.7 MB)
and writes a trimmed snapshot to media/fonts/google-fonts-catalog.json.

Target: <= 60 KB. Schema:

    {
      "schema": ["family", "category", "weights"],
      "categories": {"s": "Serif", "n": "Sans Serif", "d": "Display",
                     "h": "Handwriting", "m": "Monospace"},
      "families": [
        ["ABeeZee", "n", 400],
        ["Cinzel",  "d", "400-900"],
        ["Raleway", "n", "100-900"],
        ...
      ]
    }

  - category: single-char code (see categories map)
  - weights: int (single static weight), "w1,w2,..." (multiple static), or "min-max" (variable)
  - all fonts include the latin subset; non-latin scripts are not tracked here

latin and latin-ext are present for all relevant fonts and omitted to save space.
To fetch a font for a specific script, pass the unicode-range from the CSS2 API response.
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "media" / "fonts" / "google-fonts-catalog.json"
METADATA_URL = "https://fonts.google.com/metadata/fonts"

CATEGORY_MAP = {
    "Serif": "s",
    "Sans Serif": "n",
    "Display": "d",
    "Handwriting": "h",
    "Monospace": "m",
}

CATEGORY_LABELS = {
    "s": "Serif",
    "n": "Sans Serif",
    "d": "Display",
    "h": "Handwriting",
    "m": "Monospace",
}


def fetch_metadata() -> dict:
    """Fetch the Google Fonts metadata JSON."""
    print(f"Fetching {METADATA_URL} ...", flush=True)
    req = urllib.request.Request(
        METADATA_URL,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/131.0.0.0 Safari/537.36"
            )
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    print(f"  downloaded {len(raw):,} bytes", flush=True)
    # Google prefixes the JSON with ")]}'" to prevent XSSI
    text = raw.decode("utf-8", errors="replace")
    if text.startswith(")]}"):
        text = text[text.index("\n") + 1 :]
    return json.loads(text)


def build_catalog(data: dict) -> list[list]:
    """Build a compact catalogue from the raw metadata.

    Returns a list of [family, category_code, weights] tuples where:
    - weights is an int (single weight), "min-max" (variable), or "w1,w2,..." (static multi)
    """
    families_meta = data.get("familyMetadataList", [])
    catalog = []

    for fam in families_meta:
        family = fam.get("family", "")
        if not family:
            continue

        # Category (single-char code)
        raw_cat = fam.get("category", "")
        category = CATEGORY_MAP.get(raw_cat, "d")  # default display for unknown

        # Weights / variable axis
        axes = fam.get("axes", [])
        weights: int | str = 400
        is_variable = False

        for ax in axes:
            if ax.get("tag") == "wght":
                is_variable = True
                min_w = int(ax.get("min", 400))
                max_w = int(ax.get("max", 400))
                weights = f"{min_w}-{max_w}"
                break

        if not is_variable:
            seen_weights: set[int] = set()
            for style_name in fam.get("fonts", {}).keys():
                # style_name examples: "400", "700italic", "400i"
                w_str = style_name.rstrip("italic").rstrip("i")
                try:
                    seen_weights.add(int(w_str))
                except ValueError:
                    pass
            if len(seen_weights) == 1:
                weights = next(iter(seen_weights))
            elif seen_weights:
                weights = ",".join(str(w) for w in sorted(seen_weights))
            else:
                weights = 400

        catalog.append([family, category, weights])

    # Sort by family name for stable output
    catalog.sort(key=lambda x: x[0].lower())
    return catalog


def main() -> None:
    data = fetch_metadata()
    catalog = build_catalog(data)

    output_data = {
        "schema": ["family", "category", "weights"],
        "categories": CATEGORY_LABELS,
        "families": catalog,
    }
    output_json = json.dumps(output_data, separators=(",", ":"), ensure_ascii=False)
    output_bytes = output_json.encode("utf-8")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(output_bytes)

    size_kb = len(output_bytes) / 1024
    print(f"Wrote {len(catalog)} families to {OUTPUT}")
    print(f"File size: {size_kb:.1f} KB")

    if size_kb > 60:
        print(f"WARNING: file size {size_kb:.1f} KB exceeds target of 60 KB", file=sys.stderr)
        sys.exit(1)
    else:
        print("OK: within 60 KB target")


if __name__ == "__main__":
    main()
