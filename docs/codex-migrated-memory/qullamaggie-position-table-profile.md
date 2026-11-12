---
name: qullamaggie-position-table-profile
description: "The `position_table` prefilter profile reads Qullamaggie's positions TABLE (two layouts, source-resolution, lexicon-constrained), beats the chart_stream profile on precision, and needs an ASYMMETRIC glyph-merge rule — added 2026-10-24, merge fix 2026-10-24"
metadata:
  node_type: memory
  type: project
  originSessionId: 909a4330-b5c4-47fe-b9c1-83296bf43698
  modified: 2026-10-25T09:26:47.740Z
---

# Qullamaggie `position_table` profile (added 2026-10-24, commit `bdd4dbc`)

The Qullamaggie position list is a **TradingView GUI table**, not a chart
overlay. Two layouts exist and the legacy `chart_stream` crop reader only
ever saw the first:

| layout | ticker column (of 1920) | y range |
|---|---|---|
| 2022-era floating panel, bottom-right | x 1795–1820 | lower third |
| 2023-era right sidebar | x 1606–1648 or 1697–1739 | y 617–937 |

`--prefilter-profile position_table` runs `src/video/positionTableScan.js`:
a wide title probe (ticker column + 60 px left, first 8 ladder rows) to
identify which table is the positions table, then a narrow ticker-column
read at three strip variants, each cell decoded against the lexicon.

**Why it matters**: the table's ticker glyphs are ~6.8 *source* px tall. A
1280-wide OCR frame renders them ~4.5 px and the panel reads as
`US / D / WCU / W / KOCO` instead of `UPST / DVN / NRGU / MOS / TQQQ`.
Frames below 1600 px wide are refused, so the profile extracts OCR frames
at native resolution.

**The rule that decides everything**: the title discriminator is the
LITERAL substring `"POS"`. "A - Positions" is truncated by the panel width
to `APOSI` / `APOSIS` / `AUPOSS` / `POSOS` / `POSITIC` / `POSIIC` / `POSTS`
/ `APOSIT` — all contain `POS`. Every
measured near-miss at edit distance 1 (`RPISLVE`, `RPISLU`, `ROSIM`) was a
**false positive** — the watchlist title. No digit folding: the title check
runs on letters only. Two more guards sit in `looksLikePositionsTitle`: a
read shorter than 4 characters is never a title, and a read that is a
**lexicon ticker** is never a title.

**Verified result**: 20220222 → NRGU/DVN/MOS/COPX/TQQQ/FCX/TSLA, 100%
recall AND 100% precision, `verified: true` on both captures
(`discriminator: bottom_most`). The `chart_stream` profile trades precision
for recall instead (9–29 FPs per video).

**Corpus result at the merge fix (`1159ec0`), six frames**: 42/51 recall
(82.4 %), 7 false positives. The same reader **before** the fix
(`a15f66a`) measured 20/31 and 36/51 on two different frame sets — not
comparable with the 42/51, because the frame sets AND the code differ.
Always record the code state next to a measurement.

**Cost**: two EasyOCR batches per frame. **162–257 s/frame on an idle
machine** — the earlier "54–65 s" figure in this file and in
`docs/qmg-positions-layout-findings.md` was read off a console that was
*not* idle and was wrong; it was corrected on 2026-10-24. That range is
the right **order of magnitude, not a floor**: the same file was read
three times at 75.1 s / 134.4 s / 161.7 s. What the code *does* change is
the strip count (`candidates + 3` per frame) — the merge fix moved the
winning column onto longer ladders with more candidates, e.g. 20220606 c1
went 2 candidates/3 rows/93.3 s → 4 candidates/8 rows/199.8 s. Budget
**8–13 min per video**, not 3–6. The per-image timeout is derived from
`--table-frame-budget-ms` (default 900000) rather than fixed, so the cost
scales with the candidate count instead of multiplying it.

**How to apply**: for new Qullamaggie positions work, use
`--prefilter-profile position_table --output-kind snapshot`. It implies
native-resolution frames and EasyOCR. The legacy crop reader still runs as
a fail-safe, so a scan never ends up with less than it had before.

## The glyph-merge rule must be ASYMMETRIC (2026-10-24, commit `1159ec0`)

`extractWords` (`src/video/positionColumn.js`) chains row runs into
glyphs. The original test was `overlap / shorter > 0.4` — symmetric, so a
1 px run wholly inside a 51 px run always merged. On the 2023 sidebar the
panel's 1 px left border fused with the table's 51 px header rule into a
glyph spanning **y 687–884 — the whole table** — and `extractWords`'s
`consume()` then deleted the ticker of every row in between. The
positions table was not among the candidates at all; the frame published
nothing (0 % recall).

Fix: a second test — the candidate must also cover
`MIN_MERGE_SUPPORT = 0.03` of the **longer** run. The threshold window is
narrow: below the 1-in-20 ratio a letter stem has inside a 20 px bar
(0.05, must keep merging) and above the 1-in-51 border ratio (0.02, must
not). 0.1 was tried and splits real tickers.

Cost of the fix: on the 20220607 family the ladder starts at y 730 instead
of 693, so the **title row leaves the candidate** and the reader falls
back `title` → `bottom_most` (7/7 → 6/7, `NFLX` read as `NFU`). Cause is
the pre-existing left-edge grouping taking the FIRST group within
tolerance rather than the closest; "closest wins" restores 20220607's
title but merges watchlist+positions into one 24-row ladder on 20230609.
The two rules cannot both hold.

Blast radius over the 252-file corpus: 136 shortlists changed (116 did
not). Of the 136, 13 went from an empty shortlist to a populated one and
NONE went the other way. **At the set level every one of the 136 has a
DIFFERENT candidate set** — "the same candidates in a different order" is
0. The fix never merely reshuffled a shortlist; on every frame it changed
which columns the reader was offered. Re-run with
`tools/measureColumnMergeImpact.js --before <pre-fix positionColumn.js>`
(the before-file may live outside the repo; the tool compiles it with the
repo's module resolution so it can still `require('sharp')`).

## The seed lexicon contains OCR VARIANTS, and they publish verbatim

Nine rows of `config/ticker_lexicon_seed.csv` are not tickers but the
*shape* a ticker takes when it is misread — `AROQ`, `ARCQ`, `OBTS`, `GSII`,
`IOI`, `PLIR`, `NUGI`, `GSlT`, `MNOY`. An exact lexicon hit
short-circuits the decoder at cost 0, so `PLIR` publishes as `PLIR` at
0.000 and never competes with `PLTR`, whose repair would cost **0.375**
(`I>T` at count 3 of a model max of 4; 0.250 is a different pair, `O>Q`).
That is where 4 of the 7 measured false positives come from.

The tenth variant row, `~09r3` (`ticker_lexicon_seed.csv:246`), is the
exception and **cannot publish anything**: the decoder strips every non-A-Z
character out of the read before the lookup (`tickerDecode.js:157`), so the
read arrives as `R` and never matches the key `~09R3`. `GSlT` publishes
uppercased, as `GSLT`. Deleting the variant rows would fix the `PLIR` FP
and cost nothing else — `URNM` is itself a seeded row (`:200`) and decodes
at cost 0 either way — but it has NOT been done.

The decoder's floor: `maxCost` 0.85, indel 1.5, unexplained substitution
1.0 — a read is repairable only when a CHARACTER was misread, never when
one is missing or extra (`ATR`→`PLTR` costs 2.5, `A`→`AI` 1.5; neither is
reachable).

The **production reader loads the confusion matrix** (`readPositionTable`
does `options.confusion || loadCharConfusion()`), and the model is
load-bearing: in the e2e artifact's frame 150 the reads `TOCQ` and
`TSUA|TSUA|TSU` decode to `TQQQ` at 0.750 and `TSLA` at 0.500 through the
model and to **nothing at all** without it.

## What "published" means, and what each discriminator rests on

`publishTableHoldings` (`src/video/positionTablePublish.js`) publishes a
reading only when `found && verified && tickers.length`. **Decoded is not
published**: an unverified reading is discarded and the legacy crop reader
takes over.

| discriminator | verified | rests on |
|---|---|---|
| `title` | yes | a positive identification — the title bar says Positions |
| `bottom_most` | yes | a **positional tie-break**, not an identification: the lowest table-shaped candidate wins, granted `verified` unconditionally (`positionTableScan.js:465`). "Table-shaped" is only ≥2 ticker-shaped rows and a **one-character** row counts |
| `sole_candidate` | only if a watchlist was identified AND vetoed AND the survivor is below it | otherwise a lone untitled table could be the watchlist |

The trade cuts both ways: on e2e frame 150 the table reader decoded **7**
holdings but was unverified, so the legacy reader's **5** were published
instead — `MOS` and `TSLA` were lost.

## The title rule did NOT turn 20230609 around — the merge fix did

Under the old near-miss rule the watchlist title read `RPISLVE`, matched,
and the reader published the **watchlist** as positions (0 % recall, 9 FPs
— a portfolio holding a stock the streamer never bought). The literal-`POS`
rule stopped that: the reading became `verified: false`
(`reason: 'sole_candidate'`), so the watchlist was decoded and then
**discarded**. The frame only turned around when the merge fix put the
positions table in the candidate list (`title`, 10/13).

Same 0/13-with-9-FPs number, completely different meaning — always record
the **code state** next to a measurement.

## A FRAME'S IDENTITY IS ITS FILE, NOT ITS LABEL

Four **source-width** files are named `qmg_20230609.png` in four run
directories and hold **three distinct images** (the tree also holds two
640×360 prefilter renders under that name). Two measurements labelled
"20230609 c0" can disagree without either being wrong — and did, until the
findings doc was re-checked. Always name the file + its md5. Also:
`tools/buildPositionCorpus.js`
used to pick the canonical frame by the first three path segments of the run
directory, which are identical for every run under `data/video_scan_test/_rerun/`,
so the winner was decided by directory-walk order — arbitrary. It now uses
the whole run path with the directory's mtime as the "later run" signal.

Full geometry and derivation: `docs/qmg-positions-layout-findings.md`; the
same rules are summarised in CLAUDE.md's `position_table` section. The
doc's corpus-wide numbers are reproducible with
`tools/measureColumnMergeImpact.js --before <pre-fix positionColumn.js>`;
its scope is `data/video_scan*` files named `qmg_*.png` with PNG width
≥ 1600 (252 files, all 1920 wide).

Related: [[qullamaggie-easyocr-breakthrough]] (the chart_stream path this
supersedes), [[qullamaggie-ocr-crop-analysis]].
