# Adding O'Connell (`@pristinecapital`) as a source: analysis and implementation plan

**Status:** implemented (2026-11-14). The numbers in this document were measured
on 2026-11-14 against the corpus in `D:\trading_books\andrew_oconnell_Pristine_capital`.

---

## TL;DR

Andrew O'Connell, CFA, FRM publishes a **paid newsletter** on Substack. The
corpus is **302 PDFs** -- "Microsoft Print to PDF" renders of those posts --
plus **144 position-log screenshots** beside them.

It is the project's **fifth** source and its **second** non-video one, and it
is different from the other four in a way that shapes the whole design:

| | the other sources | this one |
|---|---|---|
| the artifact | a video | a document |
| how it is fetched | a catalog crawl plus a download | **nothing** -- the files are already on disk |
| what it yields | positions read off a screen | **setups** (what he SAID he was watching) and **positions** (what he HELD) |
| where the truth is | the corpus is in git | the corpus is **paid and outside the repository** |

Two facts drove everything below.

**1. The body text is not text.** These renders draw their body copy as
**vector outlines**, so the PDF's text layer is a free and exact index of the
STRUCTURE and is useless for the CONTENT. Measured on `20261112.pdf` page 21:

```
BT / ET / TJ text blocks .... 6      the headings and the browser chrome
get_texttrace() glyph spans .. 6      the same six
`l` (lineto) operators ...... 2,221   the prose, as outlines
`c` (curveto) operators ..... 2,336   the prose, as outlines
```

Cross-checked with a second, independent engine: `pypdf` returns exactly what
`pymupdf` returns -- the two headings, and none of the paragraph under them.
So the prose has to be OCR'd, and the pages have to be rasterised.

**2. The corpus cannot be re-fetched.** The posts are paid, the PDFs live
outside the repository, and the 20240108 issue was printed on **29 March
2025** -- nearly a year after it was published. So the derived records are
**committed** (they are the only recoverable copy) and the PDFs never are.

### What was built

```
src/oconnell/     channel.js  issueKinds.js  setupLayout.js
                   positionLayout.js  aggregate.js  schema.js
src/newsletter/   documentCatalog.js  pdfReader.js  proseOcr.js
src/table/        tableGrid.js  tableReader.js
src/report/       oconnellReport.js
tools/            _oconnell_pdf.py  catalogOconnell.js
                   extractOconnellSetups.js  extractOconnellPositions.js
                   aggregateOconnellSignals.js  analyzeOconnellOutcomes.js
test/             oconnellChannel  oconnellIssueKinds  oconnellSetupLayout
                   oconnellPositionLayout  oconnellTableGrid
```

---

## Part 1: How the app is structured today

### 1.1 The two families of sources

| family | sources | what they read |
|---|---|---|
| OCR | qullamaggie, revere | a screen, read with EasyOCR |
| text | davidsevcik, t3live, benzinga, asymtrading | a transcript or an article |

This source is a **third** shape: a **document with a table in it**. The
table has to be found, and it has to be read -- and the table is a
spreadsheet screenshot, which is a different problem from a video frame.

### 1.2 The shared backbone

`docs/benzinga-source-plan.md` §1.2 maps it. The parts this source reuses:

| layer | module | reused for |
|---|---|---|
| table geometry | `src/table/tableGrid.js` (NEW) | grid rules, cells, ink components |
| table reading | `src/table/tableReader.js` (NEW) | per-cell OCR, colour, stars |
| scoring | `src/sevcik/outcomeAnalysis.js` | returns, hits, SPY baseline, Wilson CI |
| prices | `src/analysis/priceProvider.js` | the Yahoo cache |
| report shell | `src/report/sourceDashboardShell.js` | header, coverage funnel, CSS |
| record contract | `docs/source-dashboard-pattern.md` | the payload shape |
| CSV | `src/write/writeCsv.js`, `src/config/schema.js` | the column contracts |

### 1.3 What it does NOT reuse, and why

`trade_signals` and `market_readings` are both **transcript-shaped** -- they
carry a NOT NULL `transcript_id` that REFERENCES `video_transcripts(id)`.
This source has no transcript, so reusing them would mean either a foreign
key to nothing or a change to tables four other sources depend on.

So it gets **its own tables**, the way AsymTrading does, and the id is
namespaced (`oconnell_<source_date>`).

### 1.4 The one defect this source did NOT inherit

The Benzinga plan §1.4 documents that a channel has to be registered in
**six** places, and proposes `config/channels.json` plus
`src/sources/registry.js`. Neither exists.

This source does not touch any of the six. It is not a YouTube source: there
is no catalog crawl, no `videos` row, and `videos.status` is an OCR
lifecycle that a newsletter has no part in. The only integration point is
`package.json`.

---

## Part 2: What the corpus looks like (measured 2026-11-14)

### 2.1 The shape of it

| | count |
|---|---|
| documents | **302** (2024-01-08 → 2026-11-12) |
| pages | median 20, max 34 |
| position-log screenshots | **144** (137 dates, 7 of them second copies) |
| documents with a screenshot | 131 |

### 2.2 The kinds of document

| kind | count | has a position log |
|---|---|---|
| `market_analysis_watchlist` (the trading day) | **220** | 119 |
| `weekend_watchlist` (Saturday) | **56** | 2 |
| `research_note` (short "EDUCATIONAL CONTENT") | 1 | 0 |
| `training_note` (three-page training posts) | 2 | 0 |
| `knowledge_hub` (the guides) | 3 | 0 |
| `special` (P&L reviews, vacation notes, recaps) | 20 | 8 |

The kinds are read off the **masthead by font size**, not by line order --
the order changed between the 2024 and the 2026 templates.

### 2.3 The two dates

The **filename** is the SESSION the issue covers. The **publish** timestamp
is in the print footer, and it is the date the PDF was PRINTED, which for
some issues is months later. The two are kept apart: the id is the session
date, because that is the date the corpus is read by.

### 2.4 What the position log holds

Two tables stacked in one image:

```
EQUITIES - SWING TRADES - USIC Account - Money Manager ($1MM+) Division
  Ticker | Change | Cost Basis | Price | 20D SMA | 50D SMA | Gain/Loss % |
  Size | STOP | RISK | R2 | Exits | Exit Price | Entry Date | Trade Length

OPTIONS - SWING TRADES - USIC Account - Money Manager ($1MM+) Division
  Ticker | Underlying Change | Options Change | Position | Cost Basis |
  Price | Gain/Loss % | Size | Beta | Delta | Setup | Exits | Exit Price |
  Entry Date | Trade Length
```

Plus a sidebar (`CASH %`, `INVESTED %`, `MAX LOSS STOCK/OPTIONS`,
`Trend Model`) and a footer (`% Winning Stock/Options Trades`).

**A row is a LOT and not a ticker.** Measured on `20250910`: MSOS is on four
rows of the equities table, with four different cost bases and entry dates.
And the same ticker is on the equities table AND on the options table.

### 2.5 What the setups hold

743 headings carry a ticker and a label, in 171 tickers, across 253 of the
302 documents:

```
AVGO → 200D SMA Reclaim           the arrow form
NU - Nu Holdings Ltd               the dash form
QFIN - Qifu Technology - Long      with a direction
```

The leading words of the labels are a vocabulary: Power (24), Relative (15),
Russell (15), Earnings (17), PEG (12), Bullish (9), Rescheduling (7),
Cannabis (8), Rocket (6), AI (6), Event-Driven (4), Mean (7), 52wk (10), and
the moving-average lengths.

---

## Part 3: Design

### 3.1 Decisions

| # | decision | why |
|---|---|---|
| D1 | The corpus folder is the source of record, and the pipeline never fetches from the web | the posts are paid; the PDFs are the only copy |
| D2 | The derived records are **committed**; the PDFs never are | the corpus cannot be re-fetched, so the records are the only recoverable copy |
| D3 | The headings come from the PDF text layer; the prose comes from OCR | the text layer is exact for the headings and silent about the prose |
| D4 | A setup without readable prose is still a setup | the heading is the claim, the prose is the evidence |
| D5 | The sign of a percentage comes from the COLOUR of the ink | Tesseract loses the leading minus, unevenly |
| D6 | The position-sizing stars are counted as shapes, not OCR'd | a five-pointed star is not a character in any training set |
| D7 | The columns are matched by NAME and globally | the 2024 and the 2026 sheets do not have the same columns, and one header is one edit from two of them |
| D8 | The id carries the filename's discriminator | the corpus holds two pairs of documents on one date |
| D9 | `trade_signals` and `market_readings` are not touched | they are transcript-shaped, and four sources depend on them |
| D10 | Only a setup that STATES a direction is scored | a setup with no direction is a watch, not a call |

### 3.2 Component map: reuse, extend, new

| component | status | note |
|---|---|---|
| `src/table/tableGrid.js` | **NEW** | grid rules, cells, ink components. `src/asym/sectorGeometry.js` is **not** touched -- it measures DIM GREY rules on a DARK frame, which is a different problem |
| `src/table/tableReader.js` | **NEW** | per-cell OCR, colour, stars |
| `src/newsletter/documentCatalog.js` | **NEW** | the filename grammar of a document corpus |
| `src/newsletter/pdfReader.js` | **NEW** | the PyMuPDF side, spoken to over JSON |
| `src/newsletter/proseOcr.js` | **NEW** | prose, filtered by LINE height |
| `src/oconnell/*` | **NEW** | the source-specific reading |
| `src/sevcik/outcomeAnalysis.js` | reuse | the scoring |
| `src/analysis/priceProvider.js` | reuse | the prices |
| `src/report/sourceDashboardShell.js` | reuse | the chrome |

### 3.3 The data model

| table | one row is | the key |
|---|---|---|
| `oconnell_issues` | a document | `doc_id` |
| `oconnell_setups` | a setup in a document | `(doc_id, ticker, setup_label)` |
| `oconnell_positions` | a **lot** in a document | `(doc_id, lot_key)` |
| `oconnell_snapshots` | a document's own summary | `doc_id` |
| `oconnell_readings` | a non-ticker reading | `(doc_id, scope, subject, stance, section)` |
| `oconnell_ocr_cache` | an OCR of one image | `(source_key, size, mtime, parser_version)` |

### 3.4 The reading of a position log -- what was measured

The sheet is EASY to read and HARD to OCR, and every one of these was
found by measuring a real capture:

| what | what happens | the fix |
|---|---|---|
| "BELOW" is white on solid red | reads as `prow` | normalise the FILLED cells only |
| "-4.41%" is red on white | reads as `4.41%`, confidence 35 | take the sign from the ink's COLOUR |
| "$2.20" | reads as `$220` in a row, `$2.20` on its own | read the cells ONE AT A TIME, at five times |
| the grid's rules | read as `\|` characters | filter them out of the text; **do not erase them** -- they are what segments the words, and erasing them made the reading worse |
| "★★" | reads as `w WK` and `R223` | count the stars as connected components |
| "50D SMA" | reads as `30D SMA` | match the headers globally, by name |

### 3.5 The reading of the prose -- what was measured

| what | the fix |
|---|---|
| the body text is vector outlines | rasterise the page at 200 DPI and OCR it |
| the words of a line come out in the wrong order | group by the vertical CENTRE, with a FIXED anchor, and sort left-to-right inside the line |
| the short words of English disappear | filter on the LINE's height, not the word's -- "a", "we", "to" have no ascender, so their boxes are half the height of the line |
| the chart ink is read as prose | a line of prose is at least 24 pixels tall at 200 DPI; the chart labels are 17 to 22 |
| a setup collects the NEXT setup's prose | cut the words by their y, against the next heading's y |

### 3.6 Scoring

The setups are scored with `src/sevcik/outcomeAnalysis.js` at +7 and +30
calendar days, against the SPY baseline, with the same Wilson intervals.

Three rules:

1. **Only a setup that states a direction is scored.** "AVGO → 200D SMA
   Reclaim" says what he is watching, not what he thinks will happen.
   The setups with no direction are counted and reported as unscored.
2. **The event date is the session the issue covers**, not the day the PDF
   was printed.
3. **The entry is the close of that session.** The newsletter reaches the
   reader the morning after the session it analyses, so that close is the
   last price before the call was made.

### 3.7 The one metric only this source can answer

**A setup is what he SAID he was watching; a position is what he HELD.** The
distance between the two is the whole point of reading both, so the aggregate
reports the conversion rate: of the setups, how many became a position
within 30 days.

---

## Part 4: Implementation plan

| phase | what | state |
|---|---|---|
| 0 | the plan document and the design | done |
| 1 | the catalog: inventory, classify, record | done |
| 2 | the position log reader, with a measured ground truth | done |
| 3 | the setup extraction | done |
| 4 | the aggregate and the dashboard | done |
| 5 | the outcomes | done |
| 6 | the tests and the documentation | done |

### The commands

```bash
node tools/catalogOconnell.js
node tools/extractOconnellPositions.js
node tools/extractOconnellSetups.js
node tools/analyzeOconnellOutcomes.js
node tools/aggregateOconnellSignals.js
```

The stage order is **outcomes → aggregate**, because the aggregate embeds
the outcome summary and the report is rebuilt from the payload.

---

## Part 5: Risks, and what was done about them

| risk | what was done |
|---|---|
| the OCR of a page is slow | only the pages that CARRY a setup heading are OCR'd -- a few per document, not twenty-nine |
| the OCR is re-done on every run | the reading of an image is cached by its checksum and the parser version, so a re-run is seconds |
| a parser change silently invalidates the cache | the parser version is part of the cache key, so a change invalidates the cache by itself |
| the grid's columns drift between 2024 and 2026 | the columns are matched by NAME, globally, and "Trade Length" (a 2025 addition) is simply absent from the older sheets |
| the corpus is outside the repository | the paths are stored relative to the corpus root, and the derived records are committed |
| a document without a position log reads as an empty portfolio | the coverage funnel separates "issues of this kind" from "issues with a position log" |

---

## Part 6: Decisions still open

| # | question | the state of it |
|---|---|---|
| 1 | The other twenty folders under `D:\trading_books\` | out of scope for now. The shared modules (`src/table/`, `src/newsletter/`) are meant to make a second author a layout profile rather than a rewrite, but that has not been measured. |
| 2 | The `_FINISHED` subfolder | out of scope. It holds videos, which would be a different artifact type -- and the OCR path, not the document path. |
| 3 | The screener tables | NOT extracted. They are the market's context, not his calls, and they OCR badly: the 20261112 screener comes back as "11/29/2006 \| 21 \| 0 \| LIE." |
| 4 | The focus list | NOT extracted. It is a watchlist rather than a setup, and the corpus carries it in one document only. |
