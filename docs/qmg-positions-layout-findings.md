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
`AUPOSS`, `POSOS`. A literal `POS` match on the candidate's first rows is a
**decisive** discriminator whenever the title overlaps the column.

When the title does NOT overlap (20220218, 20220222 c2) the candidate's first
row is already a ticker, and the tie-break is that the positions table is the
**bottom-most** table in the region.

### The match has to be the LITERAL substring "POS"

The obvious extension of the rule above — "or within edit distance 1 of
`POS`" — is measured to be wrong, and it is the single rule that decides
which table is published.

| read | contains `POS` | 1 substitution from `POS` | what it actually is |
|---|---|---|---|
| `APOSI`, `APOSIS`, `AUPOSS`, `POSOS` | **yes** | — | the positions title |
| `RPISLVE` | no | `PIS` | the **watchlist** title |
| `RPISLU` | no | `PIS` | the **watchlist** title |
| `ROSIM` | no | `ROS` | a watchlist title |

Every near miss that has been measured on a real frame was a **false
positive**, and every true title that has been measured contains `POS`
**literally**. So the near-miss rule is not in the reader: only the literal
substring counts.

There is nothing to fold in before the check either. The recogniser strips
every non-A-Z character out of a row before the title is looked at
(`interpretColumnStrip` in `src/ocr/positionCellOcr.js`), so a read can never
arrive with a digit in it: `APO5I` reaches the title check as `APOI`, which
contains no literal `POS` and is therefore not claimed. Mapping digits back to
letters would be inventing evidence the OCR did not produce.

The consequence is not subtle. With the near-miss rule the reader picked the
**watchlist** on 20230609 c0 and published its holdings (`ABNB`, `AMD`,
`SHOP`, `RIVN`, `NVDA`, `RBLX`, `ZS`, `NFLX`, `DDOG`) as positions: 0 %
recall, and a portfolio holding a stock the streamer never bought.

Note that the reads are **not stable** — the same frame read the watchlist
title as `RPISLVE` in one run and `RPISLU` in the next. EasyOCR is not
deterministic on glyphs this small, so any measurement here is a measurement
of one run.

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

## Production wiring

The table reader is wired into `tools/scanVideoWithOcr.js` behind a new
prefilter profile. Nothing about the default profiles changes.

```bash
node tools/scanVideoWithOcr.js \
  --video <path.mp4> --date 20230608 \
  --prefilter-profile position_table \
  --basename qmg --output-kind snapshot
```

### What the profile implies

`--prefilter-profile position_table` sets, unless explicitly overridden:

| option | value | why |
|---|---|---|
| `chartStreamParser` | `true` | the result is published in the chart_stream shape |
| `positionTableParser` | `true` | turns on `readPositionTable` |
| `nativeOcrFrame` | `true` | the table's glyphs are ~6.8 source px tall; at 1280 they are ~4.5 px and unreadable |
| `ocrEngine` | `easyocr` | the reader feeds an upscaled narrow strip — Tesseract's document-trained model cannot read it. Asking for another engine is **refused**, not silently ignored |
| `phashRegionFraction` | `0.78,0.28,0.22,0.72` | capture-dedup only; the reader locates the table itself |
| `chartStreamCropFraction` | `0.86,0.62,0.14,0.22` | the crop the **legacy** reader OCRs when the table reader falls back — see § 'Fail-safe' |
| `tableFrameBudgetMs` | `900000` | wall-clock budget for one frame; the per-image OCR timeout is derived from it |
| `prefilterThreshold` | `8` | matches the profile's own floor |
| `prefilterMaxFrames` | `3` | each frame costs two OCR batches |
| `maxCapturesPerVideo` | `2` | |

Two combinations are **refused** rather than honoured, because in table mode
they can only produce a silently wrong result:

- `--ocr-frame-width` — it can only downscale the reader's input, and the
  reader cannot read a downscaled frame.
- any `--output-kind` other than `snapshot` — the table reader lives in the
  snapshot path, so the profile would be a no-op.

The profile also carries a `tickerRegion` of `{left: 0.78, top: 0.28}` for
the prefilter's mid-tone / row-density signals. The `chart_stream` rectangle
(x ≥ 0.85, y ≥ 0.55) misses the 2023-era sidebar almost entirely, so the
rectangle is widened to cover both layouts.

### Which frames get OCR'd

`selectFramesForOcr` spends its whole allowance on a **uniform** sample: its
stride-based reserve is allowed to consume the entire budget, so the
seed budget is 0 and the top-scoring frames are never selected. At
`prefilterMaxFrames = 3` that means three blind frames spread across the
video — and the profile's own ticker rectangle, which is what watches the
2023-era sidebar, would have no effect on frame selection at all.

So in table mode the **best-scoring prefilter frame is swapped in** for the
last uniform one. The swap is local to the table profile:
`selectFramesForOcr` is shared with the `chart_stream` and whiteboard
pipelines, and changing its selection there would change results that have
already been measured.

### The two-phase read

Per candidate frame, `readPositionTable` does two OCR batches:

1. **Title probe** — one WIDE strip per shortlisted column (the ticker
   column plus 60 px to the left, first **8** ladder rows). This is what
   tells the positions table apart from the watchlist, and the rows below
   the title are what say "this column is a table of tickers at all". The
   title and the header are searched in the first three rows only; the rest
   of the strip is the shape signal. (With a three-row probe the shape
   signal could never exceed one row, so a column with no readable title
   and no `Sym` header could not be recognised as a table at all.)
2. **Ticker read** — the NARROW column only (the ticker column itself; the
   wide crop swallows the flag column), full ladder, at three strip
   variants. Each variant's read of a cell is one hypothesis; the decoder
   picks the best against the lexicon.

Phase 2 only runs on the winner, so the cost is
`candidates + 3` strips per frame, not `3 × candidates`.

A frame the reader cannot read at all is **refused before any OCR**. The
position-list glyphs are ~6.8 px tall in a 1920-wide source; below about
1600 px they are under 6 px and the panel stops being readable (at 1280 the
same row reads as `US / D / WCU / W / KOCO` instead of `UPST / DVN / NRGU /
MOS / TQQQ`). A frame narrower than 1600 px is refused with the reason
`source_too_narrow`, so a 720p source does not cost a full EasyOCR pass per
frame to learn nothing.

### Published shape — the aggregator does not need to change

The result is written as `chart_stream.position_list` with
`screen_layout: 'chart_stream'`. `tools/aggregateScanResults.js` routes a
capture's tickers by layout:

```js
if (capture.screen_layout === 'chart_stream') {
  return capture.chart_stream?.position_list || [];
}
```

so the table's holdings flow into the merge, the timeline and the report
with no aggregator change. `screen_layout` is **stated**, not detected:
`detectScreenLayout` needs two ticker tokens AND a price token, and the
table reader never sees a price.

Diagnostics are carried in `chart_stream.position_table` (discriminator,
title/header text and row, `data_row_start`, the decoded rows, the
candidate scores) and mirrored at the capture's top level as
`position_table` with a `reason` when no table was claimed.

### A table is only published when it was POSITIVELY identified

`verified` says the table was positively identified as the POSITIONS table:

| discriminator | verified | why |
|---|---|---|
| `title` | yes | the title bar says "Positions" |
| `bottom_most` | yes | the watchlist is docked **above** the positions table |
| `sole_candidate` | **only if a watchlist was identified and vetoed, and the survivor is below it** | otherwise "the only table in the panel" could just as easily be the watchlist |

That last row is measured, not hypothetical. On 20220222 c0 the detector
produced **only** the watchlist as a candidate, and its title read as
`XSM` — which the watchlist rule does not recognise. Publishing it would
put watchlist entries into the portfolio as holdings. A lone table with no
readable title is therefore located but **not published**, and the scan
falls back to the legacy reader.

The same applies to the title rule itself. `looksLikePositionsTitle`
matches the **literal** substring `POS` and nothing looser — see
§ 'The match has to be the LITERAL substring "POS"' above for the measured
evidence. A near miss (`PIS`, `ROS`) is a watchlist title, and accepting it
means publishing the watchlist as holdings.

And a table is only *table-shaped* if it has ticker-shaped rows in it, not
merely a `Sym` header: on 20230609 c0 the one candidate carrying a header
(`TSYMAGSI`) had **no** readable ticker rows at all, and claiming it would
have published a column of prices.

#### Two guards that keep a HOLDING from being mistaken for chrome

Both of these were found by adversarial review of the wired pipeline, after
the first end-to-end scan had already passed. They are the same class of
mistake: a piece of the table's chrome read as a holding, or a holding read
as chrome, and the result is a holding silently missing from the output.

**1. The column header is never a ticker.** `Sym` is within two edits of
seventeen real tickers — `TSM`, `XOM`, `ARM`, `CRM`, `SOL`, `STX`, `VRM`,
`NEM`, `SWN`, `SLB`, `SLV`, `SLY`, `TEM`, `TSEM`, `SGMO`, `SSO`, `SPYM` —
and the header search runs in a three-row window below the title. On the
2023-era table, which has **no header row at all** (20230608 c0 is
"1 title row + 13 data"), that window reaches the first three data rows. So
a holding read as `TSM` was taken for the header row, `dataStart` moved past
it, and the holding was dropped from the published list — with no error, and
no fallback to recover it, because the legacy reader is skipped whenever the
table publishes.

The fix mirrors the rule the title tests already use: **a read that is a
lexicon ticker is never the header.** The measured header reads (`Sym`,
`FUOSYM`, `Syrn`, `Svm`) are not tickers, so the header is still found; and a
read that is *not* in the lexicon could not have been published anyway,
because the decoder rejects every read that does not identify a ticker
(`Sym` → `null`, `Syrn` → `null`, `Svm` → `null`).

**2. A lone survivor has to be BELOW the watchlist.** The `sole_candidate`
path claimed the one remaining table whenever *any* other candidate read a
watchlist title — but "whatever is left" only means the positions table
when the frame agrees. The watchlist is docked above the positions table,
so the survivor's top has to be at or below the watchlist's bottom. A
survivor above it (or overlapping it, which is what a merged sidebar
cluster looks like) is some other panel.

Both guards make the reader **more** conservative, in the direction the
module already states as its principle: publishing the watchlist as
positions, or losing a holding silently, are both worse than publishing
nothing.

### Fail-safe

If the table reader finds nothing, decodes nothing, is not verified, or
throws — the frame falls through to the legacy crop reader
(`runChartStreamOcr`).

The two conditions have to agree: the legacy reader is skipped only when
the table actually produced holdings. Otherwise a frame that found a table
but decoded nothing from it falls through *neither* branch and leaves the
OCR result undefined.

In table mode the legacy reader is given the **chart-stream crop**, not the
table profile's pHash region. The pHash region in table mode is a
capture-dedup rectangle over the whole right-hand strip (`0.78,0.28,0.22,
0.72`) — five times the area of the chart-stream crop and in the wrong place
for the column filter. `options.chartStreamCropFraction` carries the crop
the legacy reader should use, and it is never null: `--phash-region` (a
*pixel* region) leaves the fractional one unset, which used to crash the
fail-safe path with a `TypeError`.

So on a frame the table reader could not claim, a table-mode scan produces
what a `chart_stream` scan would have produced. On a frame it DID claim,
the table's holdings are published instead — and those can be **fewer** than
the legacy reader's: the table decoder is strict (a read that identifies
two tickers equally well is rejected), while the legacy reader accepts
anything that looks like a ticker. That is the intended trade: a wrong
holding is worse than a missing one.

### The clusterer is bypassed per FRAME, not per profile

The raw-token clusterer repairs garbled tokens in a **raw crop read**. The
table reader already decodes each cell against the lexicon and returns
holdings, not a bag of tokens, so running the clusterer over it would only
be a chance to replace good readings with bad ones.

The bypass used to be per profile — the whole scan skipped the clusterer
whenever the table profile was on. That is wrong: a frame the table reader
could not identify falls back to the legacy reader, and that frame still
needs the clusterer's repair. The bypass is now keyed on the frame's
`ticker_source` (`position_table` or `chart_stream`), and only
table-published frames are left alone.

> The clusterer's input was also broken while this was being fixed, and the
> breakage is worth recording: the input was read from `top_candidates`,
> which are **summaries**, and a summary spells the field `chart_stream` —
> so `c.chartStream.position_list` was always undefined and the clusterer
> received an empty list. The raw candidates spell it `chartStream`, so the
> input now comes from `scanResult.candidates` (every OCR'd frame, not just
> the top N). Every snapshot scan log written since 2026-10-11 shows
> `merged_raw_token_list: []` and zero clusters — that is the bug, visible
> in the logs. It also means `merged_position_list` was coming from
> `mergeMultiplePositionLists` over the per-capture lists rather than from
> the clusterer; both paths are now covered by the same rule, since the
> captures carry the clusterer's output.

## Measured results

`readPositionTable` run directly over four real 1920-wide source frames,
one capture each, with the ground truth from `data/qmg_ground_truth.json`:

| frame | recall | precision | what happened |
|---|---|---|---|
| 20220218 c1 | 88.9 % (8/9) | 88.9 % | watchlist vetoed by its `XIWL` title → `sole_candidate`, verified. `ROKU` read as `UPST` |
| 20220222 c1 | **100 %** (7/7) | **100 %** | title read `POSI`, header `SYM` → `title` |
| 20230608 c0 | 76.9 % (10/13) | 76.9 % | title read `POSITIC` → `title`. The three misses are misreads of real tickers: `GSIT`→`GSII`, `IOT`→`IOI`, `PLTR`→`PLIR` |
| 20230609 c0 | 0 % | — | **nothing published** — see below |

For comparison, the legacy `chart_stream` reader reaches 58.7 % raw recall
on the same four-date corpus (§ 'Decoder facts').

### End to end, through the production scan

The numbers above come from calling the reader directly. The same thing
through the scan tool:

```bash
node tools/scanVideoWithOcr.js \
  --video data/video_pipeline/downloads_1080p/20220222_X1Rp33_-R9E.mp4 \
  --date 20220222 \
  --prefilter-profile position_table \
  --basename qmg --output-kind snapshot \
  --output-root data/video_scan_20261024 --run-tag qmg-table-e2e
```

| result | value |
|---|---|
| status | `done`, 3 frames OCR'd, 2 captures |
| OCR frame width | 1920 (native) |
| discriminator | `bottom_most`, **verified** on both captures |
| tickers | `NRGU`, `DVN`, `MOS`, `COPX`, `TQQQ`, `FCX`, `TSLA` |
| ground truth (`20220222` capture 0) | `NRGU`, `DVN`, `MOS`, `COPX`, `TQQQ`, `FCX`, `TSLA` |

**100 % recall, 100 % precision.** The captures carry
`ticker_source: 'position_table'`, so the clusterer left them alone — and
`merged_raw_token_list` is empty for the same reason: all three OCR'd frames
were table-published, so none of them was eligible for the clusterer.

### 20230609 c0: the 2023 sidebar, and why it publishes nothing

The positions table in this frame is at x 1697–1739 with 13 data rows at
y 726–942. The ink-run detector finds that column **only** for the
watchlist rows above it (a 17-row ladder ending at y 636) and for three
stragglers at y 894–937; the twelve rows between are not detected as a
column at all. The ticker column of the positions table is therefore not
among the candidates, and the reader has nothing to claim.

It does not claim the wrong thing either, which is the point of the
`verified` rule and of the literal-`POS` title rule: the watchlist's title
read as `RPISLU` is not a title, the one candidate carrying a `Sym` header
has no ticker rows, and the table that does look table-shaped is the
watchlist. So the frame publishes **nothing** and the scan falls back to
the legacy reader — which is no worse than the legacy reader on its own.

Closing this gap is a **detection** problem, not a reading problem: the
ticker column's ink has to be found at y 726–942 in the first place.

### Cost

One frame is two EasyOCR batches: one wide probe strip per candidate
column, then one narrow strip per strip variant on the winner. On an idle
machine a frame takes **54–65 s** (measured on the four frames above).

That number is not a constant, though, and the reason is the adapter's
budget: `runEasyOcrBatch` spends `perImageMs × imageCount + 120000`, so a
**fixed** per-image timeout makes the cost of a frame scale with the number
of candidate columns. Four probe strips at 300 s each is a 22-minute probe
on its own, which is how one frame came to carry a 39-minute budget and take
**4 948 s** (that one was a contended machine, not the code).

So the timeout is **derived from a frame budget** instead. The budget is
900 000 ms (15 min) by default — `--table-frame-budget-ms` overrides it —
and `perImageTimeoutMs` splits it between the two phases and then across
the images of the phase, so the whole frame stays inside it. The per-image
timeout is still capped at 300 000 ms.

Two consequences for production:

- A table-mode scan of a video is **minutes, not seconds**. The daemons'
  300 s per-video kill timer does not fit it; a table-mode run needs a
  timer of its own, or fewer frames.
- `prefilterMaxFrames` is 3 and `maxCapturesPerVideo` is 2 in the
  profile, so a video can cost 3 × (probe + read) ≈ 3–6 minutes of
  EasyOCR on an idle machine. Run it on a handful of videos at a time.

## Operational constraints (CLAUDE.md)

- Every EasyOCR invocation must carry the low-CPU env. It is enforced at
  `src/ocr/easyocrAdapter.js` — do not bypass it.
- `runEasyOcrBatch`'s timeout is `perImageMs × imagePaths.length + 120000`.
  A per-image timeout of 1 800 000 (30 min) makes an 8-image batch budget
  4 hours. **Use a sane per-image timeout (~300 000).**
- Do not `ls` or `Read` `data/video_scan_test/_rerun/` directly.
