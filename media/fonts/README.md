# Bundled fonts

This directory contains a curated set of fonts bundled with the extension for offline use.
All fonts are served from the webview via `webview.asWebviewUri`, matching the existing
`font-src ${webview.cspSource}` CSP rule — no CSP changes needed.

## Fonts

| Family | Category | Weights | Subsets | Version | Licence | Files |
|--------|----------|---------|---------|---------|---------|-------|
| Cinzel | Display (serif) | variable 400–900 | latin, latin-ext | v26 | OFL 1.1 | `Cinzel.woff2`, `Cinzel-LatinExt.woff2` |
| Playfair Display SC | Display (serif) | 400, 700, 900 | latin, latin-ext | v18 | OFL 1.1 | `PlayfairDisplaySC-{400,700,900}.woff2`, `PlayfairDisplaySC-{400,700,900}-LatinExt.woff2` |
| Marcellus SC | Serif | 400 | latin, latin-ext | v14 | OFL 1.1 | `MarcellusSC.woff2`, `MarcellusSC-LatinExt.woff2` |
| Montserrat | Sans-serif | variable 100–900 | latin, latin-ext | v31 | OFL 1.1 | `Montserrat.woff2`, `Montserrat-LatinExt.woff2` |
| Roboto | Sans-serif | variable 100–900 | latin, latin-ext | v51 | OFL 1.1 | `Roboto.woff2`, `Roboto-LatinExt.woff2` |
| Roboto Condensed | Sans-serif | variable 100–900 | latin, latin-ext | v31 | OFL 1.1 | `RobotoCondensed.woff2`, `RobotoCondensed-LatinExt.woff2` |
| Inter | Sans-serif | variable 100–900 | latin, latin-ext | v20 | OFL 1.1 | `Inter.woff2`, `Inter-LatinExt.woff2` |
| JetBrains Mono | Monospace | variable 100–800 | latin, latin-ext | v24 | OFL 1.1 | `JetBrainsMono.woff2`, `JetBrainsMono-LatinExt.woff2` |

## Source

All fonts were downloaded from Google Fonts via the CSS2 API using a modern Chrome User-Agent
to obtain woff2 format. Exact source URLs:

```
Cinzel v26 latin:
  https://fonts.gstatic.com/s/cinzel/v26/8vIJ7ww63mVu7gt79mT7.woff2
Cinzel v26 latin-ext:
  https://fonts.gstatic.com/s/cinzel/v26/8vIJ7ww63mVu7gt7-GT7LEc.woff2

Playfair Display SC v18 latin 400:
  https://fonts.gstatic.com/s/playfairdisplaysc/v18/ke85OhoaMkR6-hSn7kbHVoFf7ZfgMPr_lbkMEA.woff2
Playfair Display SC v18 latin 700:
  https://fonts.gstatic.com/s/playfairdisplaysc/v18/ke80OhoaMkR6-hSn7kbHVoFf7ZfgMPr_nQIpBcwXLg.woff2
Playfair Display SC v18 latin 900:
  https://fonts.gstatic.com/s/playfairdisplaysc/v18/ke80OhoaMkR6-hSn7kbHVoFf7ZfgMPr_nTorBcwXLg.woff2
Playfair Display SC v18 latin-ext 400:
  https://fonts.gstatic.com/s/playfairdisplaysc/v18/ke86OhoaMkR6-hSn7kbHVoFf7ZfgMPr_pb0HEw.woff2
Playfair Display SC v18 latin-ext 700:
  https://fonts.gstatic.com/s/playfairdisplaysc/v18/ke83OhoaMkR6-hSn7kbHVoFf7ZfgMPr_lbkMEA.woff2
Playfair Display SC v18 latin-ext 900:
  https://fonts.gstatic.com/s/playfairdisplaysc/v18/ke83OhoaMkR6-hSn7kbHVoFf7ZfgMPr_nTorBcwX.woff2

Marcellus SC v14 latin:
  https://fonts.gstatic.com/s/marcellussc/v14/ke8kOgUHP1dg-Rmi6RWjbLEPgdyd.woff2
Marcellus SC v14 latin-ext:
  https://fonts.gstatic.com/s/marcellussc/v14/ke8iOgUHP1dg-Rmi6RWjbLEPgde_.woff2

Montserrat v31 latin:
  https://fonts.gstatic.com/s/montserrat/v31/JTUSjIg1_i6t8kCHKm459Wlhyw.woff2
Montserrat v31 latin-ext:
  https://fonts.gstatic.com/s/montserrat/v31/JTUSjIg1_i6t8kCHKm459WdhyyTh89ZNpQ.woff2

Roboto v51 latin:
  https://fonts.gstatic.com/s/roboto/v51/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3yUBA.woff2
Roboto v51 latin-ext:
  https://fonts.gstatic.com/s/roboto/v51/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3KUBGEe.woff2

Roboto Condensed v31 latin:
  https://fonts.gstatic.com/s/robotocondensed/v31/ieVl2ZhZI2eCN5jzbjEETS9weq8-19K7DQ.woff2
Roboto Condensed v31 latin-ext:
  https://fonts.gstatic.com/s/robotocondensed/v31/ieVl2ZhZI2eCN5jzbjEETS9weq8-19y7DRs5.woff2

Inter v20 latin:
  https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2
Inter v20 latin-ext:
  https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa25L7SUc.woff2

JetBrains Mono v24 latin:
  https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbV2o-flEEny0FZhsfKu5WU4xD7OwE.woff2
JetBrains Mono v24 latin-ext:
  https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbV2o-flEEny0FZhsfKu5WU4xD1OwG_TA.woff2
```

CSS2 API requests (requires modern Chrome User-Agent for woff2):
```
https://fonts.googleapis.com/css2?family=Cinzel:wght@400..900&display=swap
https://fonts.googleapis.com/css2?family=Playfair+Display+SC:wght@400;700;900&display=swap
https://fonts.googleapis.com/css2?family=Marcellus+SC:wght@400&display=swap
https://fonts.googleapis.com/css2?family=Montserrat:wght@100..900&display=swap
https://fonts.googleapis.com/css2?family=Roboto:wght@100..900&display=swap
https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@100..900&display=swap
https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap
https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@100..800&display=swap
```

## Sizes (latin + latin-ext)

| Family | latin | latin-ext | total |
|--------|-------|-----------|-------|
| Cinzel | 25.3 KB | 14.2 KB | 39.5 KB |
| Playfair Display SC | 75.0 KB (3 weights) | 45.6 KB (3 weights) | 120.6 KB |
| Marcellus SC | 14.2 KB | 8.7 KB | 22.9 KB |
| Montserrat | 37.1 KB | 69.0 KB | 106.1 KB |
| Roboto | 42.1 KB | 28.7 KB | 70.8 KB |
| Roboto Condensed | 50.2 KB | 33.2 KB | 83.4 KB |
| Inter | 47.1 KB | 83.1 KB | 130.2 KB |
| JetBrains Mono | 39.5 KB | 14.8 KB | 54.3 KB |
| **Total** | | | **627.8 KB** |

## Licences

All bundled fonts are released under the SIL Open Font Licence 1.1 (OFL 1.1).
Licence texts are in `OFL-<Family>.txt` in this directory.

The OFL allows free use, modification, and distribution, including in software (like this
extension). Embedding in HTML/PNG exports is also permitted.

See https://scripts.sil.org/OFL for the full licence.
