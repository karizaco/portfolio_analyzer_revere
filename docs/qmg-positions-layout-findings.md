# Qullamaggie positions table — measured layout facts

Everything here was measured on real 1920×1080 frames — "source" snapshots,
not the OCR-resolution 1280-wide renders, which are unreadable (see the note
at the end).

**A frame's identity is its FILE, not its label.** The same capture label —
`20230609 c0` — names several *different* PNGs: four **source-width** files
are called `qmg_20230609.png` in four different run directories, and they
hold three distinct images (two of the four are byte-identical). (The tree
holds two more files of that name, but they are 640×360 prefilter renders,
not source frames.) Two measurements labelled "20230609 c0" can therefore
disagree without either being wrong — and did, until this document was
re-checked against the artifacts. Every table below names the file it was
measured on, with the first eight hex digits of its md5.

The frames live under the gitignored `data/video_scan_test/` and
`data/video_ocr_probe/` trees, so these numbers are **not reproducible from a
clean clone** — only from a machine that still has the runs.

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
| ticker column | x 1795–1820 (20220218), 1795–1819 (20220222) | x 1697–1739 (20230609), 1606–1648 (20230608) |
| row pitch | **18 src px** | **18 src px** |
| 4th/5th header | `Dol Vol Daily` (watchlist) / `Pre Buzz` (positions) | `Dol Vol` / `Vol Buzz` |
| other tables in frame | watchlist above (y 63–286) | watchlist above (y ≤ 660) |

Both ticker-column cells quote the **positions table's** candidate — the
candidates' own `left`/`right`, the same measure as the geometry table below.
(On the 2022-era frames whose *top* candidate is the watchlist, the
positions table is the second candidate: `1794–1830` on 20220222 c1.)

The **positions table is always the bottom-most table in the right-hand
region**: the watchlist is docked above it.

## Measured geometry per corpus frame

The detector's **top candidate** — the one it would read — for each frame
this document cites, measured with the merge fix in place (§ 'The
glyph-merge rule'). The candidate's own `left`/`right`, not the padded
column it reports.

The frame is named by its **run directory and file**, because the run
directory is part of the name: two run directories can hold a file of the
same name holding different pixels, and a bare filename cannot tell them
apart. The run directories below are under `data/video_scan_test/_rerun/`
unless the row says otherwise.

| frame (run / file · md5) | ticker column | ink rows | band | GT | note |
|---|---|---|---|---|---|
| 20220218 c1 · `qmg-easyocr-20261011/qmg_20220218_2.png` · d6a45e35 | 1795–1820 | 9 | y 732–882 | 9 | rows start at the first data row |
| 20220218 c2 · `qmg-easyocr-20261011/qmg_20220218_3.png` · 8eaeba13 | 1795–1820 | 9 | y 732–882 | 9 | |
| 20220222 c0 · `qmg-easyocr-20261011/qmg_20220222.png` · fc63546d | 1792–1815 | 12 | y 64–286 | 7 | the **WATCHLIST** is the top candidate; the positions table is the second (`1795–1819`, 7 rows, y 732–846) |
| 20220222 c1 · `qmg-easyocr-20261011/qmg_20220222_2.png` · 8454ed2d | 1794–1816 | 12 | y 63–286 | 7 | the positions table is the second candidate (`1794–1830`, 9 rows, y 695–846); title read `APOSI`, header read `FUOSYM` |
| 20220222 c2 · `qmg-easyocr-20261011/qmg_20220222_3.png` · 52a6d7f6 | 1795–1819 | 7 | y 732–846 | 7 | |
| 20230608 c0 · `qmg-easyocr-20261017/qmg_20230608.png` · 287032ad | 1606–1648 | 14 | y 617–880 | 13 | title read `APOSIS` in this pass, `POSITIC` in the reader run (§ 'Measured results') — the two runs disagree; 1 title row + 13 data |
| 20230609 c0 · `qmg-easyocr-20261012/qmg_20230609.png` · d53cb5fa | 1697–1739 | 16 | y 658–937 | 13 | title read `AUPOSS`; 3 rows above the data + 13 data = the 16 ink rows |
| 20230609 c0 · `qmg-easyocr-20261017/qmg_20230609.png` · ee3bc2bf | 1697–1739 | 16 | y 658–937 | 13 | **the same label, a different file** — see § '20230609 c0: the 2023 sidebar' |

The last two rows are the same date, the same capture index and the same
filename in two different run directories, and they are **different images**.
Before the merge fix the second of them detected the watchlist instead; see
§ '20230609 c0: the 2023 sidebar'.

## The glyph-merge rule, and the bug it caused

`extractWords` (`src/video/positionColumn.js`) builds glyphs out of
horizontal ink runs: it seeds a glyph on a run and grows it up and down by
chaining runs that overlap it. The chaining test was

```js
overlap / shorter > 0.4
```

where `shorter` is the **shorter** of the two runs. That test is symmetric,
and the symmetry is the bug: a 1 px run is wholly inside a 51 px run, so it
covers 100 % of *itself* and the shorter of the two is the 1 px one. A 1 px
panel border sitting under a 51 px header rule therefore joined the rule.

The consequence was not a slightly wrong glyph. On the 2023 sidebar the
merged glyph was

```text
x 1677..1729   y 687..884   (53 x 198)
```

— the 51 px header rule at y 687 fused with the 1 px panel border below it
(the border's x-range is *inside* the rule's, so it covers 100 % of itself
and passes a symmetric test) and spanned the whole table. `extractWords`
then *consumes* every run in a glyph's row span that overlaps its bounding
box, so the merged glyph deleted the ticker of every row in between. The
positions table lost its middle rows and the reader had nothing to claim.

The fix adds a second, asymmetric test: the candidate must also cover
`MIN_MERGE_SUPPORT` (3 %) of the **longer** of the two runs. A letter's stem
is 1 px inside a 7 px bar (1/7 ≈ 14 %), so it still merges; a 1 px border
under a 51 px rule (1/51 ≈ 2 %) does not.

The threshold is not a free parameter. It has to sit **below** the 1-in-20
ratio a letter's stem has inside a 20 px bar (0.05) — a stem must keep
merging — and **above** the 1-in-51 ratio the 1 px panel border has under
the header rule (0.02) — chrome must not. 3 % sits in that window, and
`test/positionColumnMerge.test.js` pins both sides of it.

### What it changed, over the whole corpus

`findTickerColumnByInkRuns` is a pure image pass — no OCR, ~0.1 s a frame —
so it can be run over every source-width snapshot on disk. The corpus is
**every file** named `qmg_<date>[_<n>].png` under `data/video_scan*` whose
PNG header says ≥ 1600 px wide: **252 files, every one of them 1920 wide**.
("Source-width" is the only filter; it is the same scope
`tools/buildPositionCorpus.js` walks.) The two ends of the comparison are
two commits — `a15f66a` before, `1159ec0` after — and the only difference
between them is the merge test. What is compared is the *shortlist*: the
list the reader actually works from, after the region, row and pitch
filters.

The whole thing is one command:

```bash
git show a15f66a:src/video/positionColumn.js > C:/tmp/positionColumn_before.js
node tools/measureColumnMergeImpact.js --before C:/tmp/positionColumn_before.js
```

| | frames |
|---|---|
| shortlist unchanged | 116 |
| shortlist changed | 136 |
| … of those, a different TOP candidate | 109 |
| … of those, the same shortlist with a different winner | 4 |
| … empty before, populated after | **13** |
| … populated before, empty after | **0** |

The 136 split four ways: 13 frames had no shortlist before and have one
now; of the other 123, **4** kept the same candidates and only changed which
one wins, 92 changed the winner *and* the rest of the list, and 27 kept the
same winner and changed the rest of the list. The 4 are a subset of the 109,
not a separate class — which is worth saying, because the two numbers were
once read as if they were disjoint.

Nothing that was found stopped being found: `populated before, empty after`
is **0**. Over the 65 distinct frames of the seven measured dates the winning
column moved on **32** of them, and almost every move was *onto* the table.
(Those 65 are measured over **all of `data/`**, not over the 252-file corpus
above: the same seven dates inside that corpus give 45 distinct frames and
22 moves.)

| frame (md5) | before | after |
|---|---|---|
| 20220218 c0 · a68ab8b2 | `1792-1815`, 6 rows at y 64–178 (chart-area junk) | `1795-1820`, 9 rows at y 732–882 |
| 20220606 c1 · 93514908 | `1741-1762`, 4 rows at y 100–161 | `1741-1762`, 8 rows at y 730–862 |
| 20220607 c1 · 029cd1f9 | `148-188`, 3 rows at y 44–87 (chart area — this is the **detector's** top candidate; the pre-fix *shortlist* was empty) | `1738-1761`, 7 rows at y 730–844 |
| 20230609 c0 · ee3bc2bf | `1697-1723`, 17 rows at y 325–636 (**the watchlist**) | `1697-1739`, 16 rows at y 658–937 (**the positions table**) |
| 20230609 c1 · d8b376be | `1697-1721`, 4 rows at y 58–119 | `1697-1723`, 12 rows at y 715–937 |

### The cost: the title bar leaves the ladder

On the 20220607 family the fix goes the other way. The winning ladder now
starts at y 730 instead of y 693, so the **title row is no longer part of
the candidate** and the reader falls back from the `title` discriminator to
`bottom_most`. Measured on the same frame, both ways — `qmg_20220607_2.png`
in `clean_v48_20220607`, md5 `a7b6b283`, **not** the `029cd1f9` frame of the
table above (a different file of the same name):

| | before | after |
|---|---|---|
| candidate | `1740-1780`, 9 rows at y 693–844 | `1741-1763`, 7 rows at y 730–844 |
| discriminator | `title` (`APOSIT`) | `bottom_most` |
| published | UCO, VLO, ALB, BOIL, **NFLX**, TNA, LTHM | UCO, VLO, ALB, BOIL, **NFU**, TNA, LTHM |
| recall | 7/7 | 6/7 |

The cause is a pre-existing fragility that the fix *exposes* rather than
creates: the title word's left edge (x 1740) is 2 px from a stray word's at
the top of the frame (x 1738) and 1 px from the ladder's (x 1742), and the
grouping takes the **first** group within tolerance, not the closest. Before
the fix the title was merged with the rule above it into one wide glyph, so
it landed in the ladder by accident.

Making the closest group win restores the title row on 20220607 — and
merges the watchlist and the positions table into one 24-row ladder on
20230609, which is the frame the whole fix was for. The two rules cannot
both hold; the one that keeps the 2023 sidebar readable is the one that
ships.

## THE DISCRIMINATOR: the title bar is readable from the ticker column

OCR of the candidate column's first three rows, x widened 60 px left:

| frame | positions candidate | watchlist candidate |
|---|---|---|
| 20220218 c1 | `UPST` (no title captured) | `XIWL` |
| 20220222 c0 | — | `XWL` ‡ |
| 20220222 c1 | `APOSI` | `XSM` ‡ |
| 20220222 c2 | `NRGU` (no title captured) | `XIWL` |
| 20230608 c0 | `APOSIS` | — |
| 20230609 c0 | `AUPOSS` | — |

‡ The two 20220222 watchlist reads are **swapped** relative to the shipped
reader, which attributes the `XSM` read to c0
(`src/video/positionTableScan.js:444-446`) and leaves `XWL` for c1. The
corpus file (`data/qmg_position_corpus.json`) is empty, so the frames cannot
settle it; the table keeps the measurement it records and the disagreement
is flagged here rather than silently reconciled. See § 'When a table is
published'.

`A - Positi` / `A - Positions` is truncated by the panel width to a span that
**overlaps the ticker column**, and EasyOCR reads it as `APOSI`, `APOSIS`,
`AUPOSS`, `POSOS`, `POSITIC`, `POSIIC`, `POSTS`, `APOSIT`. A literal `POS`
match on the candidate's first rows is a **decisive** discriminator whenever
the title overlaps the column.

When the title does NOT overlap (20220218, 20220222 c2) the candidate's first
row is already a ticker, and the tie-break is that the positions table is the
**bottom-most** table in the region — but only when **two or more**
table-shaped candidates survive the watchlist veto. With a single one left,
the discriminator is `sole_candidate`, and the table is published only if a
watchlist was positively identified and vetoed above it (20220218 c1 measured
as `sole_candidate`, not `bottom_most`).

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

The consequence is not subtle. While the near-miss rule was in the reader it
picked the **watchlist** on 20230609 c0 (the 20261017 copy, md5 `ee3bc2bf`)
and published its holdings (`ABNB`, `AMD`, `SHOP`, `RIVN`, `NVDA`, `RBLX`,
`ZS`, `NFLX`, `DDOG`) as positions: 0 % recall, and a portfolio holding a
stock the streamer never bought.

It is worth being precise about what the literal-`POS` rule did and did not
fix, because it is easy to over-claim. On that same frame, with the
literal-`POS` rule in place but **before** the merge fix, the table reader
still located the **watchlist** rather than the positions table and still
decoded those same nine tickers out of it. What the title rule changed is
that nothing is now *mistaken* for a positions title, and no watchlist title
was recognised either — so the reading came back `verified: false`
(`reason: 'sole_candidate'`) and **was not published**; the scan fell back
to the legacy reader. The number is the same in both eras (0/13 with 9
false positives) but the meaning is not: under the near-miss rule those
nine were published as holdings, under the literal-`POS` rule they were
only decoded and then discarded. What actually turned that frame around
was the merge fix (§ '20230609 c0: the 2023 sidebar'), not the title rule.

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
`x ∈ [0.80·W, W]` — a restriction applied by **cropping the frame before the
call** (`dbg_win_tmp.js:9`), not by `detectPositionTables` itself, which has
no window option; the diagnostic also crops `y ≥ 0.40·H`
(`dbg_win_tmp.js:10`):

| frame | detected table | header slot | slots |
|---|---|---|---|
| 20220218 c1 | x 1771–1874, y 688–887 | 1 | 11 (2 header + 9 data) |
| 20220222 c1 | x 1771–1874, y 688–851 | 1 | 9 (2 header + 7 data) |
| 20230608 c0 | x 1548–1795, y 610–850 | 1 | 13 |
| 20230609 c0 | x 1640–1917, y 444–708 | 0 | 13 (watchlist + positions MERGED — one cluster) |

The 2023 sidebar stacks the watchlist and the positions table with the **same
column x boundaries**, so their vertical separators form ONE cluster, and
every horizontal rule inside that cluster's span shares one slot list. The
**longest constant-pitch run** of horizontal rules separates the two tables:
for 20230609 a hand measurement of the rules gives 606, 624, 642 (watchlist),
666/687 (watchlist footer + title bar), 708 (header rule) then 726, 744,
762 … 942 at a strict 18 px pitch — the last 13 are the positions data rows.

Note what the detector's own row does **not** say. Its cluster box ends at
y 708 and its 13 slots sit at 445, 463, …, 643 and 668 — so the positions
data rows at 726–942 are **below the box and not in the slot list at all**.
The "13" in that table row and the "last 13" in the paragraph above are two
different sets of thirteen: the first is what the detector reported, the
second is what the hand measurement shows the table continues with. That gap
is the failure — the detector stopped at the header rule.

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
- **The decoder's floor.** `maxCost` is 0.85, an insertion or a deletion
  costs 1.5 and an unexplained substitution 1.0 — so a read is only
  repairable when a *character was misread*, never when one is missing or
  extra. `ATR` → `PLTR` costs 2.5 and `A` → `AI` 1.5; neither is reachable.
  Raising `maxCost` to reach them only manufactures false positives (`AR`,
  `TSM`), because the ambiguity grows faster than the reach.
- **The lexicon contains OCR variants, and they publish verbatim.** Nine rows
  of `config/ticker_lexicon_seed.csv` are not tickers but the *shape* a
  ticker takes when it is misread — `AROQ`, `ARCQ`, `OBTS`, `GSII`, `IOI`,
  `PLIR`, `NUGI`, `GSlT`, `MNOY`, each with a note saying which
  ticker it came from. An exact lexicon hit short-circuits the decoder at
  cost 0, so `PLIR` publishes as `PLIR` at 0.000 and never competes with
  `PLTR`, whose repair would cost **0.375** — the `I>T` pair is
  `0.25 + 0.5 × (1 − 3/4)` (`config/ticker_char_confusion.csv:26`, `I,T,3`,
  model max 4). (0.250 is the cost of a *different* pair, `O>Q`, whose count
  of 4 is the model max.) That is where 4 of the 7 false positives in
  § 'Measured results` come from. The tenth variant row, `~09r3`
  (`config/ticker_lexicon_seed.csv:246`), is the exception: it **cannot**
  publish anything, because the decoder strips every non-A-Z character out of
  the read before the lookup (`src/normalize/tickerDecode.js:157`), so the
  read arrives as `R` and never matches the key `~09R3`; `GSlT` publishes
  uppercased, as `GSLT`. Deleting the variant rows would let `PLIR` decode
  to `PLTR`, and nothing else would be lost — `URNM` is itself a seeded row
  (`config/ticker_lexicon_seed.csv:200`) and decodes at cost 0 either way —
  but it has not been done.
- **The production reader applies the confusion model.**
  `readPositionTable` loads it by default (`src/video/positionTableScan.js`,
  `const confusion = options.confusion || loadCharConfusion();`), so the
  "no confusion model" figures below describe a configuration the shipped
  reader does not use. The model is load-bearing, and a real scan shows it:
  in the e2e artifact's frame 150
  (`data/video_scan_20261024/qmg-table-e2e/ocr_probe/logs/20220222_20220222_x1rp33_-r9e_9d13da23_snapshot.json`,
  `top_candidates[2].position_table.decoded`) the reads `TOCQ` and
  `TSUA|TSUA|TSU` decode to `TQQQ` at 0.750 and `TSLA` at 0.500 through
  the model and to **nothing at all** without it — an unexplained
  substitution costs 1.0 (`UNKNOWN_SUBSTITUTION`), so those two would cost
  2.000 and 1.000 against a `maxCost` of 0.85 and the holdings would be
  lost. An exact lexicon hit does not depend on the model (`TSLA` → `TSLA`
  at 0.000 either way), which is why the false positives that survive are
  the ones the lexicon gets wrong outright rather than the ones it repairs.
  There is **no** measured corpus figure for the production configuration
  (model on): `tools/evalPositionDecoder.js` scores that column, but the
  corpus it reads (`data/qmg_position_corpus.json`) holds no entries.
- Recogniser errors are **stable** across scale / kernel / colour / grayscale —
  only a lexicon constraint or a second recogniser can fix them.
- Measured on a 4-date corpus: raw recall 58.7 %; decoded (no confusion
  model) recall 58.7 %, precision 74.0 %. That "no confusion model" is the
  **corpus tool's** configuration (`tools/evalPositionDecoder.js`); the
  production reader always decodes with the learned matrix, as the bullet
  above says. All 13 false positives are reads
  that identify a *different* ticker — either another real ticker
  (`PYPL←COPX`, `MPC←MOS`, `RIVN←DVN`, `NRGU←NDGU`) or the lexicon's own
  OCR variants (`IOI←IOT`, `AROQ←ARQQ`, `PLIR←PLTR`).
  The corpus is built by `tools/buildPositionCorpus.js` and is **not
  checked in** — the frames it was measured from live under the
  gitignored `data/video_scan_test/` tree — so these figures are not
  reproducible from a clean clone.
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

So in table mode the **best-scoring prefilter frame is swapped in** for one
of the uniform ones. Three details decide whether and which
(`tools/scanVideoWithOcr.js`): the evicted frame is the uniform one
**nearest** the best frame, not the last one (the capture dedup drops any
capture within `CAPTURE_MIN_FRAME_GAP` of a better one, so the nearest is
the one most likely to be discarded anyway); the swap **does not happen in
batch mode**, where the selected rows are replaced wholesale; and the best
frame must clear the profile threshold, relaxed to 60 % of it when the
whole video scores below it — otherwise `--prefilter-threshold` would have
no effect at all. The swap is local to the table profile:
`selectFramesForOcr` is shared with the `chart_stream` and whiteboard
pipelines, and changing its selection there would change results that have
already been measured.

### The two-phase read

Per candidate frame, `readPositionTable` does two OCR batches:

1. **Title probe** — one WIDE strip per shortlisted column (the ticker
   column plus 60 px to the left, first **8** ladder rows). This is what
   tells the positions table apart from the watchlist, and the rows below
   the title are what say "this column is a table of tickers at all". The
   title is searched in the first three rows only; the header is searched in
   the three rows **below** the title (so with the title on row 0 the header
   can be row 3); the rest of the strip is the shape signal. (With a three-row probe the shape
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
// tools/aggregateScanResults.js
function getCaptureTickers(capture) {
  if (capture.screen_layout === 'chart_stream') {
    return Array.isArray(capture.chart_stream?.position_list)
      ? capture.chart_stream.position_list
      : [];
  }
  ...
```

so the table's holdings flow into the merge, the timeline and the report
with no aggregator change. `screen_layout` is **stated**, not detected:
`detectScreenLayout` needs two ticker tokens AND a price token, and the
table reader never sees a price.

Diagnostics are carried in `chart_stream.position_table` (discriminator,
title/header text and row, `data_row_start`, the decoded rows, the
candidate scores) and mirrored at the capture's top level as
`position_table` with a `reason` when no table was claimed.

### When a table is published

`verified` says the table was identified as the POSITIONS table. Only a
`verified` reading that also decoded something is published; anything else
falls back to the legacy crop reader (§ 'Fail-safe').

| discriminator | verified | what it actually rests on |
|---|---|---|
| `title` | yes | **a positive identification**: the title bar says "Positions" |
| `bottom_most` | yes | a **positional tie-break**, not an identification. The watchlist is docked **above** the positions table, so the lowest table-shaped candidate wins — but the code grants it `verified` unconditionally (`src/video/positionTableScan.js`, `decision(winner, evaluations, 'bottom_most', true)`) and "table-shaped" only means **≥ 2 ticker-shaped rows**, where a **one-character** row counts (`lettersOnly(text)` non-empty and length ≤ 5). So a column of 1–2 letter junk qualifies, and a `bottom_most` publication is a prior, not evidence. It is not hypothetical: at `a15f66a` the 20220606 c1 frame (`93514908`) had only **two** candidates — a 4-row chart-area column at y 100–161 and a 3-row one at y 376–436 — and `bottom_most` took the lower of the two, publishing one junk cell that happened to coincide with the two-letter lexicon ticker `SE`: 0/8 with 1 FP |
| `sole_candidate` | **only if a watchlist was identified and vetoed, and the survivor is below it** | otherwise "the only table in the panel" could just as easily be the watchlist |

That last row is measured, not hypothetical, and both of its conditions
are required: `verified` is `watchVetoed && belowWatchlist`. On 20220222
the watchlist was the **surviving** candidate on one of the corpus frames —
with the merge fix in place the positions table is present there, but as the
second candidate — and the watchlist's title was mangled beyond recognition:
the `XSM` read, which the watchlist rule does not match. Publishing it would
put watchlist entries into the portfolio as holdings. A lone table with no
readable title is therefore located but **not published**, and the scan
falls back to the legacy reader. A lone table **below** a vetoed watchlist,
on the other hand, *is* published.

(The discriminator table above attributes the `XSM` read to 20220222 c1,
whereas the shipped reader attributes it to c0 —
`src/video/positionTableScan.js:444-446` records that on 20220222 c0 the
detector produced only the watchlist and its title read as `XSM`, which
leaves `XWL` for c1. The corpus file (`data/qmg_position_corpus.json`) is
empty, so the frames themselves cannot settle it — but the module's comment
is an artifact too. Either way the rule does not change: a lone table with
no readable title is located but not published.)

The same applies to the title rule itself. `looksLikePositionsTitle`
matches the **literal** substring `POS` and nothing looser — see
§ 'The match has to be the LITERAL substring "POS"' above for the measured
evidence. A near miss (`PIS`, `ROS`) is a watchlist title, and accepting it
means publishing the watchlist as holdings. Two further guards sit in the
same function (`src/video/positionTableScan.js:172-180`): a read shorter than
**four** characters is never a title — so `POS` on its own is not — and a
read that is a **lexicon ticker** is never a title either.

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

The take-over rule is now a single tested predicate, `publishTableHoldings()`
(`src/video/positionTablePublish.js`): it returns the holdings only when the
table was found, **verified** AND decoded something, and `null` otherwise.
The legacy reader therefore runs for a frame that found a table but decoded
nothing from it — the "neither branch" failure mode this section used to
warn about no longer exists.

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

The trade cuts **both** ways, and the one recorded instance shows the
downgrade. In the e2e run (§ 'End to end, through the production scan';
`data/video_scan_20261024/qmg-table-e2e/ocr_probe/logs/20220222_20220222_x1rp33_-r9e_9d13da23_snapshot.json`,
`top_candidates[2]`, frame index 150) the table reader had already found
the right table — the same column the two published captures used
(1795–1819, 7 rows, bottom 846) — and decoded **seven** holdings: `NRGU`,
`DVN`, `MOS`, `COPX`, `TQQQ`, `FCX`, `TSLA`. But no watchlist title was read
on that frame, so the `sole_candidate` path could not identify the table
positively (`verified: false`), nothing was published from it, and the
legacy crop reader's reading was published instead — only **five** (`COPX`,
`DVN`, `FCX`, `NRGU`, `TQQQ`). `MOS` and `TSLA` were lost. The fail-safe is
not "the table reading or nothing": it is "the table reading, or a
*different and possibly poorer* reading".

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
> the clusterer.
>
> The consensus is a **video-level** reading, so it is published in
> `merged_position_list` and not in the individual captures. A capture
> keeps what its own frame showed: `captures[n].tickers` and
> `captures[n].chart_stream.position_list` are the same list for a
> chart_stream capture, and writing the consensus into only one of them
> would publish two different holdings lists for one capture — with the
> aggregator reading the one that was not overwritten.
>
> The clusterer also repairs against the **observed** lexicon
> (`loadDecodeLexiconSync`), not the seed lexicon. The seed lexicon is the
> whole-panel parser's allowlist and it is missing 26 tickers Qullamaggie
> actually held (UPST, NRGU, MOS, DWAC, SWN, ...). Against the seed
> lexicon the clusterer rewrites a holding it does not know to a
> neighbouring seed ticker — on 20220218 that turned NRGU into NUGI and
> lost UPST outright.
>
> **Correction to commit `bdd4dbc`.** That commit's message claims the
> clusterer "removes OCR garbage (20220218: 15 tokens of ONKS/TTOCQ/UPST
> -> 9 clean tokens incl. ROKU and FCX)". UPST was not garbage: it is a
> real 20220218 ground-truth holding, and the 9-token list it describes
> drops four further ground-truth tickers while adding four that are not
> in the ground truth. The clusterer is not a cleaner — it is a vote, and
> a vote can lose a holding. The backing scan log is gitignored, so the
> claim cannot be re-checked from the repository.

## Measured results

`readPositionTable` run directly over six real 1920-wide source frames, one
capture each, with the ground truth from `data/qmg_ground_truth.json`. The
rows are keyed by **file**, because the label is not unique — and by the
**code state**, because the merge fix (§ 'The glyph-merge rule') changes
what the reader publishes on the same pixels. The two are separate tables:
the totals of the second are **not** added to the totals of the first.

### At `1159ec0` — the merge fix in place

| frame (run / file · md5) | discriminator | recall | FP | what happened |
|---|---|---|---|---|
| 20220218 c1 · `qmg-easyocr-20261011/qmg_20220218_2.png` · d6a45e35 | `sole_candidate` | 8/9 = 88.9 % | 1 | the watchlist was vetoed by its `XIWL` title, so the survivor was published; `ROKU` read as `UPST` |
| 20220222 c1 · `video_scan_20261024/qmg-table-e2e/qmg_20220222_2.png` · a1bdb944 | `bottom_most` | 7/7 = **100 %** | 0 | the frame the e2e scan below produced — a different tree from the `_rerun/` corpus |
| 20221104 c0 · `qmg-easyocr-20261017/qmg_20221104.png` · 59cba1f3 | `title` | 1/1 = **100 %** | 0 | title read `POSTS`, header `SM` — a single holding, `OIH` |
| 20220606 c1 · `final_v29_20220606/qmg_20220606_2.png` · 93514908 | `bottom_most` | 6/8 = 75 % | 2 | `BOIL` and `NFU` are false positives |
| 20230608 c0 · `qmg-easyocr-20261017/qmg_20230608.png` · 287032ad | `title` | 10/13 = 76.9 % | 3 | title read `POSITIC` — the geometry pass read the same file as `APOSIS` (§ 'Measured geometry per corpus frame'); the two runs disagree. The three misses are misreads of real tickers: `GSIT`→`GSII`, `IOT`→`IOI`, `PLTR`→`PLIR` |
| 20230609 c0 · `qmg-easyocr-20261017/qmg_20230609.png` · ee3bc2bf | `title` | 10/13 = 76.9 % | 1 | title read `POSIIC`, header `SYM`; `ARQQ` read as `AROQ` |
| **total** | | **42/51 = 82.4 %** | **7** | |

### At `a15f66a` — before the merge fix

The same reader, the same ground truth, the same machine, a run or two
earlier. This is a **separate measurement**, not a second opinion on the
table above:

| frame (run / file · md5) | before (`a15f66a`) | after (`1159ec0`) |
|---|---|---|
| 20220218 c1 · `qmg-easyocr-20261011/qmg_20220218_2.png` · d6a45e35 | `sole_candidate`, 8/9, 1 FP, col {1795, 1820}, 154.5 s | `sole_candidate`, 8/9, 1 FP, col {1795, 1820}, 170.2 s |
| 20220222 c1 · `qmg-easyocr-20261011/qmg_20220222_2.png` · 8454ed2d | `title`, 7/7, 0 FP, col {1794, 1819}, 240.9 s | not re-read at this code state — the frame in the table above is the *other* copy, `a1bdb944` |
| 20221104 c0 · `qmg-easyocr-20261017/qmg_20221104.png` · 59cba1f3 | `title`, 1/1, 0 FP, col {1761, 1803}, 134.4 s | `title`, 1/1, 0 FP, col {1761, 1803}, 161.7 s |
| 20220606 c1 · `final_v29_20220606/qmg_20220606_2.png` · 93514908 | `bottom_most`, **0/8**, 1 FP (published `SE`), col {1731, 1747}, 2 candidates, 93.3 s | `bottom_most`, 6/8, 2 FP, col {1741, 1762}, 4 candidates, 199.8 s |
| 20230608 c0 · `qmg-easyocr-20261012/qmg_20230608.png` · 898baaa1 | `title`, 9/13, 4 FP, col {1606, 1631}, 214.8 s | not re-read at this code state — the frame in the table above is the *other* copy, `287032ad` |
| 20230609 c0 · `qmg-easyocr-20261017/qmg_20230609.png` · ee3bc2bf | `sole_candidate`, **0/13**, **9 FP** — it decoded the WATCHLIST, but `verified: false`, so nothing was published from it, 273.0 s | `title`, 10/13, 1 FP, col {1697, 1723}, 245.1 s |
| 20230609 c0 · `qmg-easyocr-20261012/qmg_20230609.png` · d53cb5fa | `title`, 11/13, 0 FP, col {1697, 1723}, 214.2 s | not re-read at this code state — the frame in the table above is the *other* copy, `ee3bc2bf` |

Two pre-fix runs were made, one of four frames and one of six. They
totalled **20/31 with 2 FPs** and **36/51 with 6 FPs** respectively. Neither
is comparable with the 42/51 above: the frame sets differ, and so does the
code.

One more frame was measured **both** ways, with and without the merge fix:

| frame (file · md5) | before | after |
|---|---|---|
| 20220607 c1 · `qmg_20220607_2.png` · a7b6b283 | `title` (`APOSIT`), 7/7, 0 FP | `bottom_most`, 6/7, 1 FP (`NFU` for `NFLX`) |

which is the title-row cost of the merge fix, quantified in § 'The
glyph-merge rule'. (Eleven byte-identical copies of that frame exist under
`_rerun/`; the md5 identifies all of them.)

The reads are **not stable** — EasyOCR is not deterministic on glyphs this
small, so every number here is a measurement of one run. The 20220222 c1
row is the clearest case, but it has to be read carefully: the `title` read
and the `bottom_most` read are of two **different images** — `8454ed2d` (the
20261011 copy, § 'Measured geometry per corpus frame') and `a1bdb944` (the
e2e copy, § 'Measured results') — and on `8454ed2d` the post-fix top
candidate is the **watchlist**, so the two candidate lists are not identical
either.

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

**100 % recall, 100 % precision.** The two published captures carry
`ticker_source: 'position_table'`, so the clusterer left them alone. The
**third** OCR'd frame (index 150) was not table-published — its reading was
`verified: false`, `reason: 'sole_candidate'` — so it was the legacy crop
reader's, and it was the only frame the clusterer was eligible to repair.
Its legacy reading was `COPX`, `DVN`, `FCX`, `NRGU`, `TQQQ` — five tickers,
while the table reader had decoded **seven** on that same frame (`NRGU`,
`DVN`, `MOS`, `COPX`, `TQQQ`, `FCX`, `TSLA`); see § 'Fail-safe'.

`merged_raw_token_list` is empty because of **Filter A**, not because the
clusterer received nothing. The clusterer's input is the raw candidates
(`scanResult.candidates`) — the input path was fixed in `bdd4dbc`, and this
run was launched with that fix already on disk — and frame 150 does
contribute one non-empty legacy list. But Filter A counts **distinct
frames** (`src/parse/parseChartStream.js`, `if (clusterFrames.size <
minFrequency) continue;`) and only one frame contributed, so with
`minFrequency` 2 every cluster was dropped. Since `a15f66a` the filter is
relaxed to 1 when only one frame contributes (`tools/scanVideoWithOcr.js`),
so a re-run of the same video now produces a non-empty merged list — this
artifact predates that change.

### 20230609 c0: the 2023 sidebar, and what it used to publish

The positions table in this frame is at x 1697–1739 with 13 data rows at
y 726–942. Two copies of this frame exist — `qmg_20230609.png` in the
20261012 run (md5 `d53cb5fa`) and in the 20261017 run (md5 `ee3bc2bf`) —
and they behaved differently, because the **pixels** differ, not the code.

**The 20261017 copy (`ee3bc2bf`), before the merge fix.** The ink-run
detector's candidates were a 17-row ladder at x 1697 ending at y 636, a
10-row one at x 1781 ending at y 938, a 5-row one at x 1807, and a 4-row one
at x 1802 carrying the header `TSYMAGSI`. The positions table's ticker
column was **not** among them. The table reader read the 17-row ladder —
which is the **watchlist** — decoded nine tickers out of it, and came back
`verified: false`, `reason: 'sole_candidate'`, `fallback: true`. So nothing
from it was published and the scan fell back to the legacy reader. The
0/13 with 9 FPs that the pre-fix run recorded on this frame is the **table
reader's own decoded list** — the nine watchlist tickers, scored against the
ground truth — not the legacy reader's output: the script measures what the
table reader decoded, and the publication decision is a separate one
(`publishTableHoldings`, `src/video/positionTablePublish.js`, which returns
`null` for an unverified reading).

The reason the positions table was missing was not "the rows are not
detected as a column" — it was one merged glyph. The header rule at y 687
(51 px wide) and the panel border below it (1 px wide) satisfied the old
merge test and fused into a single glyph spanning y 687–884; the consume
step then deleted the ticker of every row in between. § 'The glyph-merge
rule' has the mechanics.

With the merge fixed the same frame yields the positions table:
`1697–1739`, 16 rows at y 658–937, the reader's discriminator becomes
`title`, and it publishes 10 of the 13 ground-truth holdings — 76.9 %, with
1 false positive (`AROQ` for `ARQQ`).

**The 20261012 copy (`d53cb5fa`).** The same measurement on the *other*
copy, before the merge fix, gave `title`, 11/13 and **0** false positives.
It has not been re-read since the merge fix, so it is not a like-for-like
comparison with the 10/13 above — that is a difference of pixels, of code
state, or of both, and the two have not been separated.

It is worth saying what the reader did **not** do. It did not publish the
watchlist. After the merge fix the positions table is the candidate it
claims, and the watchlist's title read as `RPISLU` is not a positions title
in any case — the one candidate carrying a `Sym` header has no ticker rows,
so a frame that could not be claimed publishes nothing from the table
reader, and the scan falls back to the legacy reader, which is no worse
than the legacy reader on its own.

### Cost

One frame is two EasyOCR batches: one wide probe strip per candidate
column, then one narrow strip per strip variant on the winner. The post-fix
run's six frames cost 170, 207, 162, 200, 257 and 245 s, and the 20220607
frame cost 186 s — so **162–257 s a frame** is the right order of magnitude
for this reader on an idle machine. It is **not** a floor. The same files
were read on the same day, before the merge fix, at 75.1 s and 134.4 s
(20221104 c0) and 93.3 s and 94.6 s (20220606 c1) — and the 20221104 file
was read three times in three runs at 75.1 s, 134.4 s and 161.7 s across
two different code states. EasyOCR's wall-clock on frames like these swings
by a factor of two, so a single timing difference between two runs says
nothing about the code. (Read off the console during those runs; the probe
logs carry no timing field, so the numbers are not reproducible from an
artifact.)

What the code *does* change is how many strips a frame needs, because the
cost is `candidates + 3` strips per frame, and the merge fix moved the
winning column onto **longer** ladders with **more** candidates on many
frames. The clearest case is 20220606 c1 (`93514908`): before the fix the
reader claimed a 2-candidate, 3-row chart-area column and took 93.3 s;
after it, a 4-candidate, 8-row column and 199.8 s. That is the fix's
price, and it is not a timing artifact.

That number is not a constant, either, and the reason is the adapter's
budget: `runEasyOcrBatch` spends `perImageMs × imageCount + 120000`, so a
**fixed** per-image timeout makes the cost of a frame scale with the number
of candidate columns. Four probe strips at 300 s each is a 22-minute probe
on its own, which is how one frame came to carry a 39-minute budget and take
**4 948 s** (that one was a contended machine, not the code — and, like the
number above, it is not recorded in an artifact).

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
  profile, so a video can cost 3 × (probe + read) ≈ **8–13 minutes** of
  EasyOCR at the post-fix per-frame rates. Run it on a handful of videos at
  a time.

## Operational constraints (CLAUDE.md)

- Every EasyOCR invocation must carry the low-CPU env. It is enforced at
  `src/ocr/easyocrAdapter.js` — do not bypass it.
- `runEasyOcrBatch`'s timeout is `perImageMs × imagePaths.length + 120000`.
  A per-image timeout of 1 800 000 (30 min) makes an 8-image batch budget
  4 hours. **Use a sane per-image timeout (~300 000).**
- Do not `ls` or `Read` `data/video_scan_test/_rerun/` directly.
