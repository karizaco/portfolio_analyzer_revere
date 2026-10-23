# Qullamaggie positions table — measured layout facts

Everything here was measured on real 1920×1080 frames from
`data/video_scan_test/_rerun/qmg-easyocr-20261011/snapshots/`. The frames are
1920-wide "source" snapshots (the OCR-resolution 1280-wide renders are
unreadable — see the note at the end).

## The widget

The position list is a **TradingView GUI table**, not a chart overlay.

```text
┌───────────────────────────────────────────────────────────┐
│ A - Positions ▼ | ☐Filter | Edit ▼ | ⬆Syms | ☰ | S+ | ✕  │  title bar
├──────┬─────────┬────────────┬──────────┬──────────────────┤
│ Flag │   Sym   │ % Change   │  Dol Vol │  Vol Buzz / Pre Buzz │ header row
├──────┼─────────┼────────────┼──────────┼──────────────────┤
│  🚩  │  CVNA   │  +21,96%   │  430.0M  │   +701,1%         │ data row
│  🚩  │  QBTS   │  +17,87%   │    9.2M  │   +752,8%         │ data row
└──────┴─────────┴────────────┴──────────┴──────────────────┘
```

- The **"Sym" header label is left-aligned with the ticker column**, so the
  header word's x-range IS the ticker column's x-range.
- The title bar also carries a "Syms" **column-visibility button**, so the word
  "Sym" alone does not identify the header row.
- **Both** the watchlist and the positions table have a "Sym" column and
  **both** have blue flag icons. Flags cannot tell them apart.

## Two layouts

| | 2022-era | 2023-era |
|---|---|---|
| where | floating panel, bottom-right over the chart | right sidebar |
| table left edge | x ≈ 1771 | x ≈ 1678 (20230609), 1580 (20230608) |
| ticker column | x 1793–1827 | x 1697–1728 (20230609), 1606–1648 (20230608) |
| row pitch | **18 src px** | **18 src px** |
| 4th/5th header | `Dol Vol Daily` (watchlist) / `Pre Buzz` (positions) | `Dol Vol` / `Vol Buzz` |
| other tables in frame | watchlist above (y 63–286) | watchlist above (y ≤ 660) |

The **positions table is always the bottom-most table in the right-hand
region**: the watchlist is docked above it.

## Measured geometry per corpus frame

| frame | ticker column | ink rows | GT | note |
|---|---|---|---|---|
| 20220218 c1 | 1795–1820 | 9 | 9 | rows start at the first data row |
| 20220218 c2 | 1795–1820 | 9 | 9 | |
| 20220222 c0 | 1792–1815 | 12 | 7 | **picked the WATCHLIST** — no positions candidate found |
| 20220222 c1 | 1794–1830 | 9 | 7 | title read `APOSI`, header read `FUOSYM` |
| 20220222 c2 | 1795–1819 | 7 | 7 | |
| 20230608 c0 | 1606–1648 | 14 | 13 | title read `APOSIS`; 1 title row + 13 data |
| 20230609 c0 | 1697–1739 | 16 | 13 | title read `AUPOSS`; 2 title/header rows + 13 data |

## THE DISCRIMINATOR: the title bar is readable from the ticker column

OCR of the candidate column's first three rows, x widened 60 px left:

| frame | positions candidate | watchlist candidate |
|---|---|---|
| 20220218 c1 | `UPST` (no title captured) | `XIWL` |
| 20220222 c0 | — | `XWL` |
| 20220222 c1 | `APOSI` | `XSM` |
| 20220222 c2 | `NRGU` (no title captured) | `XIWL` |
| 20230608 c0 | `APOSIS` | — |
| 20230609 c0 | `AUPOSS` | — |

`A - Positi` / `A - Positions` is truncated by the panel width to a span that
**overlaps the ticker column**, and EasyOCR reads it as `APOSI`, `APOSIS`,
`AUPOSS`, `POSOS`. A fuzzy `/pos/i` match on the candidate's first rows is a
**decisive** discriminator whenever the title overlaps the column.

When the title does NOT overlap (20220218, 20220222 c2) the candidate's first
row is already a ticker, and the tie-break is that the positions table is the
**bottom-most** table in the region.

## Why the full-frame geometry detector failed, and what works

`detectPositionTables` on the **whole 1920 frame** fails: the chart background
is `rgb(27..69)`, which satisfies the separator rule (`luma 32..105`,
saturation ≤ 0.3), so the chart's own horizontal grid lines bridge the table's
column separators into one giant cluster (`x 2..1889`).

**Restricting the search to the right-hand window fixes it.** With
`x ∈ [0.80·W, W]`:

| frame | detected table | header slot | slots |
|---|---|---|---|
| 20220218 c1 | x 1771–1874, y 688–887 | 1 | 11 (2 header + 9 data) |
| 20220222 c1 | x 1771–1874, y 688–851 | 1 | 9 (2 header + 7 data) |
| 20230608 c0 | x 1548–1795, y 610–850 | 1 | 13 |
| 20230609 c0 | x 1640–1917, y 444–708 | 0 | 13 (watchlist + positions MERGED — one cluster) |

The 2023 sidebar stacks the watchlist and the positions table with the **same
column x boundaries**, so their vertical separators form ONE cluster and the
horizontal rules from both tables fall in the same slot list. The **longest
constant-pitch run** of horizontal rules separates them: for 20230609 the
rules are at 606, 624, 642 (watchlist), 666/687 (watchlist footer + title bar),
708 (header rule) then 726, 744, 762 … 942 at a strict 18 px pitch — the last
13 are the positions data rows.

### Horizontal rules are cleanly detectable over a single column

Over one column's x-span, a rule row is ~100 % separator-coloured while a data
row is ~0 % (black background, white glyphs too bright, coloured glyphs too
saturated). Measured separator fraction over x 1678–1889 in 20230609:
`y=606 → 0.99, 624 → 0.99, 642 → 0.99, 726 → 0.99, 744 → 0.99, …` and
`y=666 → 1.00, 687 → 0.98`.

## Blue-flag measurement (does NOT disambiguate the two tables)

Blue pixels in the 26 px band immediately left of the ticker column, per row:

| frame | candidate | rows with a blue flag |
|---|---|---|
| 20220218 c1 | x 1795 (positions) | 9/9 |
| 20220218 c1 | x 1792 | 5/6 |
| 20220218 c1 | x 1901, x 3 | 0/5, 0/4 |
| 20220222 c0 | x 1792 rows 12 (watchlist) | 11/12 |
| 20220222 c1 | x 1794 rows 12 (watchlist) | 12/12 |
| 20230608 c0 | x 1606 (positions) | 13/14 |
| 20230608 c0 | every other candidate | 0/N |

So flags eliminate chart-area and chat-overlay candidates but **cannot** tell
the watchlist from the positions table. Only the title bar can.

## Decoder facts

- Lexicon: `loadDecodeLexiconSync()` (seed + observed, 259 tickers) covers
  **100 %** of the 678 GT ticker occurrences. `loadSeedLexiconSync()` (233)
  misses 26 distinct GT tickers = 63 occurrences (9.3 %).
- Recogniser errors are **stable** across scale / kernel / colour / grayscale —
  only a lexicon constraint or a second recogniser can fix them.
- Measured on a 4-date corpus: raw recall 58.7 %; decoded (no confusion
  model) recall 58.7 %, precision 74.0 %. All 13 false positives are reads
  that are *themselves valid tickers but wrong* (`PYPL←COPX`, `MPC←MOS`,
  `RIVN←DVN`, `IOI←IOT`, `AROQ←ARQQ`, `PLIR←PLTR`, `NRGU←NDGU`).
- GT row order does **not** always equal table row order (20230608 and
  20220323 differ), so rows must be matched to truth by an **assignment**,
  not a fixed offset.

## Existing modules (reuse, do not rewrite)

| file | what it gives |
|---|---|
| `src/video/positionColumn.js` | `findTickerColumnByInkRuns` → candidate ticker columns + their row bands |
| `src/video/positionTable.js` | `detectPositionTables`, `findTickerColumnByInk`, `findHeaderSlotIndex`, `buildSeparatorIndex`, `separatorFraction` |
| `src/ocr/positionCellOcr.js` | `prepareColumnStrip`, `ocrStrips`, `interpretColumnStrip`, `readTableHeader`, `readTickerColumn`, `prepareHeaderStrip` |
| `src/video/positionPanel.js` | `resolvePanelFromStrips`, `symRowIndex`, `TITLE_WORD` |
| `src/normalize/tickerDecode.js` | `decodeCell`, `weightedEditDistance`, `substitutionCost`, `loadCharConfusion` |
| `src/normalize/tickerScan.js` | `loadDecodeLexiconSync`, `loadSeedLexiconSync` |
| `tools/buildPositionCorpus.js` | labelled corpus builder (GT-based labelling — NOT a detection step) |
| `tools/evalPositionDecoder.js` | raw / decoded / learned scorer |
| `tools/learnCharConfusion.js` | writes `config/ticker_char_confusion.csv` (from=read char, to=true char) |

## Operational constraints (CLAUDE.md)

- Every EasyOCR invocation must carry the low-CPU env. It is enforced at
  `src/ocr/easyocrAdapter.js` — do not bypass it.
- `runEasyOcrBatch`'s timeout is `perImageMs × imagePaths.length + 120000`.
  A per-image timeout of 1 800 000 (30 min) makes an 8-image batch budget
  4 hours. **Use a sane per-image timeout (~300 000).**
- Do not `ls` or `Read` `data/video_scan_test/_rerun/` directly.
