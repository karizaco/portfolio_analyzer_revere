# Adding Komar (`julian_komar`) as a source: analysis and implementation plan

**Status:** Phase 1 (the catalog) **implemented** 2026-11-17. Phases 2-7 are
not started. Every number below was measured on 2026-11-17 against the corpus
in `D:\courses_nosync\julian_komar` and
`D:\courses_nosync\julian_komar\_finished`.

---

## Phase 1 as built (2026-11-17)

```
src/komar/       channel.js  corpusCatalog.js  documentLayout.js  schema.js
tools/           catalogKomar.js
test/            komarChannel  komarCorpusCatalog  komarDocumentLayout
                 komarCatalog              (44 tests, all passing)
data/            komar_manifest.json        (committed)
```

`npm run komar:catalog` inventories both folders, reads every PDF's own
chrome, probes every video with ffprobe, and writes `komar_documents` and
`komar_videos` into `derived.sqlite`.

### What the catalog measured

| | |
|---|---|
| documents | **27** -- report 7, post 7, lesson 7, rule 3, summary 2, deck 1 |
| videos | **116** -- weekend 65, lesson 42, midweek 6, webinar 3 |
| video hours | **65.9** |
| videos with a session date | **32 / 116** (22 from a document, 10 from the filename) |
| videos linked to their document | **21 / 116** |
| documents whose FILENAME disagrees with their own date | **2** |
| files skipped | **0** |

The 84 videos with no date are the honest gap: a weekly session is named
after its report number, and only 7 of the 29 sessions in the corpus have a
document that carries the date. The other 22 need their date from the video
itself, which is Phase 3's job (the TradingView chrome shows it).

### The two filename lies, caught

| file | the filename says | the document says |
|---|---|---|
| `komar_20260408.pdf` | 2026-04-08 | **2025-04-08** -- the title AND the URL |
| `Trades-August-2025.pdf` | August 2025 | **July 2025** -- the deck's first slide |

Both are recorded with `date_conflict = 1`, and the session date is the
document's own. The first is caught from the chrome alone; the second needs
the native text layer, because a slide deck has no browser furniture.

### A THIRD RULE, LEARNED WHILE BUILDING IT

**A DATE CARRIES A PRECISION.** `April 2026 - Screening routine.mp4` is
dated to a MONTH, and storing it as `20260401` would invent a day. So both
tables carry `session_date_precision` (`day` / `month` / ``), and a
**month-precision date does not link a video to a document** -- two things
that both say "July 2025" are not thereby the same thing.

### TWO BUGS THE TESTS CAUGHT, WORTH RECORDING

1. **The page count swallowed the date.** The browser prints the page label
   and the print timestamp with nothing between them -- "1 of
   82026-05-10, 12:52" -- so a page label read off the raw text reports
   **8,206 pages**. The stamp is now cut out before the label is read.
   Pinned by `test/komarDocumentLayout.test.js`.
2. **A column added to an INSERT and forgotten in its `ON CONFLICT DO
   UPDATE SET` list is written exactly once.** `session_date_precision`
   stayed empty for all 116 videos while the catalog reported them as
   up to date, because the diff is by checksum and a changed column is not
   a changed checksum. Pinned by `test/komarCatalog.test.js`, which reads
   the tool's source and checks that every inserted column is also updated.

---

## TL;DR

Julian Komar publishes a **paid membership** called *MARKET UPDATE Premium*
on `members.julian-komar.com`. The corpus is a folder of **116 MP4s**
(65.9 h, 48.3 GB) and **27 PDFs** (225 pages), split across two folders: the
root holds the *current* window plus every PDF, and `_finished` holds the
video archive.

It is the project's **sixth** source, and the **first hybrid**: it is a
video source *and* a document source in one corpus, with a **third artifact
type** neither of the existing families has -- a **spreadsheet trade log**.

| | Revere / QMG | Sevcik / T3Live / Benzinga | O'Connell (Pristine) | **Komar** |
|---|---|---|---|---|
| artifact | video | video | document | **video + document + sheet** |
| how it is fetched | crawl + download | crawl + download | files already on disk | **files already on disk** |
| what it yields | positions off a screen | calls from words | setups + positions | **positions + calls + a real trade log** |
| truth | in git | in git | paid, outside the repo | **paid, outside the repo** |
| language | English | Czech / English | English | **English** |

Three facts drove the whole design.

**1. The PDF is a print of a web page, and the page is a shell.**
`komar_20260509.pdf` is a browser print of
`members.julian-komar.com/c/weekly-videos/may-9-2026-weekend-report-226`.
Its text layer carries **four glyph spans per page** -- the title, the URL,
the page number and the print timestamp -- and nothing else. The body prose
is **vector outlines** (measured: page 2 of `komar_20260509.pdf` has 1,295
`l` and 1,930 `c` operators against 4 text spans), exactly the O'Connell
situation. But the *substance* of a weekly report is in the **video**, and
the PDF only holds the metadata, the chapter list, and the embedded
"Market Update" card image.

**2. The video's right-hand panel is a TradingView table, and it is
persistent.** Every session is a screen share with a watchlist panel docked
to the right edge. A crop of `Weekend-Report 224 - My Portfolio.mp4` at
`t=600 s`, source-resolution, `crop=300:1000:1620:30` reads cleanly:

```
Symbol        Last      Chg%
DELL    ●     216.09    1.86%
TER     ●     418.08    4.26%   <- selected row
POWL   ●     252.76    0.23%
MU     ●     496.72    3.11%
SNDK   ●     989.90    6.16%
APLD   ●     34.98    -3.77%
  v CLOSED
RKLB   ●     79.68    -5.82%
AMLX   ●     17.04    -1.62%
WULF   ●     20.01    -1.77%
CRWV   ●     110.14   -6.20%
LITE   ●     881.64    4.10%
BW     ●     14.50    -7.41%
TH     ●     14.25    1.79%
PL     ●     35.44    -7.44%
```

That is a **holdings panel with an explicit `CLOSED` group** -- positions
*and* exits -- in the same table. The project's existing
`src/video/positionPanel.js` / `positionColumn.js` were built for exactly a
TradingView GUI table and are directly reusable.

**3. The corpus cannot be re-fetched and its best document is already
parsed by hand.** `Trades-August-2025.pdf` is a 67-page slide deck whose
page 2 carries a **2048x1715 spreadsheet screenshot** of the trade log --
one row per trade with entry date, close date, entry type, ticker, average
price, stop, risk size, exit type, %WL, initial rating, after-close rating
and a free-text comment. The file is named for August and its content says
**July**. The corpus is paid, so the derived records must be **committed**,
the way O'Connell's are.

### What is proposed

```
src/komar/       channel.js  corpusCatalog.js  documentLayout.js
                 panelLayout.js  tradeLogLayout.js  schema.js
src/report/      komarReport.js
tools/           catalogKomar.js  fetchKomarTranscripts.js
                 extractKomarDocuments.js  extractKomarPanel.js
                 extractKomarSignals.js    extractKomarTradeLog.js
                 aggregateKomarSignals.js  analyzeKomarOutcomes.js
test/            komarChannel komarCorpusCatalog komarDocumentLayout
                 komarPanelLayout komarTradeLogLayout
```

---

## Phase 2 as built (2026-11-17)

```
src/komar/       cardLayout.js    the card's vocabulary and colour windows
                 cardDiscs.js     the trend arrows, read from PIXELS
                 cardThemes.js    the theme names, read from the accent ink
                 documentExtract.js  the PDF readers
tools/           extractKomarDocuments.js
test/            komarCardDiscs  komarCardThemes  komarDocumentExtract
                 komarDocumentTool
```

`npm run komar:documents` reads what the documents SAY and writes three
tables: `komar_market_cards`, `komar_theme_leaders` and `komar_deck_notes`.

### What it measured

| | |
|---|---|
| documents processed | **15** (the 7 reports + 7 posts + the trade deck) |
| market cards read | **10** |
| theme-leader rows | **83**, over **55 distinct tickers** |
| deck notes | **65**, of which **63** carry a star rating and **65** a checklist |

### THREE THINGS THE ARROWS TAUGHT

**1. THE ARROWS ARE IMAGES AND NO OCR READS THEM.** The card's trend arrows
are coloured discs with a white glyph inside. The measured whole-card OCR
of `komar_20260509.pdf` page 2 comes back with `"NASDAQ @ @& 2 enim"` --
three discs and a mangled percentage. So the direction is read from the
DISC'S COLOUR, and the colour is measured, not chosen:

| | disc | what it means |
|---|---|---|
| up | rgb(83,190,107) -- and rgb(32,176,0) on the 2025 cards | the arrow points up |
| flat | rgb(232,179,64) | the arrow points across |
| down | rgb(209,56,49) | the arrow points down |

**2. THE DISC HAS TO BE FOUND BY ITS CENTRE, NOT BY FLOOD FILL.** The
white arrow glyph lies across the disc and cuts it into pieces, so a
flood fill of the disc's colour finds fragments: measured, a flood fill
of the 2026-05-09 card finds 2 blobs where there are 6 discs. The disc is
scored by how much of a RING around a candidate centre carries its
colour, and a candidate in the GAP between two discs is suppressed
because it scores 0.47 against a real disc's 0.92.

**3. THE DISC READING HAS TO WIN OVER THE TEXT READING.** The card's
NARRATIVE sits in the same OCR line as the index names, and the
2026-01-25 card reads "Market still going sideways" -- so the text
parser reported every index as `flat`, when the card's own discs say
up, up and down. The discs are read first; the text only fills in a row
whose discs were not found.

### THE CARD HAS TWO LAYOUTS, AND BOTH ARE READ

| | 2025 cards | 2026 cards |
|---|---|---|
| size | 1978x1466 | 1080x692 to 1080x769 |
| arrow green | rgb(32,176,0) | rgb(83,190,107) |
| leaders | `$GEV, $SAR` | `SNDK, MU` |
| themes | 4 boxes | 3 or 4 boxes |

### THE THEME NAMES COME FROM THE ACCENT INK

The card prints the theme names in ORANGE and the OCR flattens the card
into one line, so the name, its description and its leaders end up in
one string. The orange ink separates them: the titles are found as
orange ink bands, split into their separate titles by the gap between
them, and each one is read on its own.

The names are used **only when their count matches the number of leader
groups** -- the accent ink also catches the badge and the footnote, and
a name that is off by one is worse than no name.

### WHAT IS STILL NOT READ

* **The trade-log sheet** (`Trades-August-2025.pdf` page 2, a 2048x1715
  spreadsheet screenshot with 18 columns). It wants the full `src/table/`
  reader path with its own measured column mapping, and it is left for
  Phase 3.
* **The card's per-horizon mapping.** The 2026-05-09 card's leader
  groups are read in a different order from its theme names, so some
  leaders carry the wrong theme. The leaders themselves are right.
* **The 2025 card's theme grouping.** Its four boxes are laid out
  differently and the group boundaries are off; the leaders are right.
* **The daily posts** (`20250625`, `20250820`, `komar_20260505`,
  `komar_20260506`) carry no market card -- their images are chart
  screenshots, and the card check says so.
---

## Part 1: How the app is structured today

### 1.1 The source families

| family | sources | what they read |
|---|---|---|
| OCR | qullamaggie, revere | a screen, read with EasyOCR/Tesseract |
| text | davidsevcik, t3live, benzinga, asymtrading | a transcript or an article |
| document | oconnell | a paid newsletter PDF and a spreadsheet screenshot |

`docs/benzinga-source-plan.md` §1.2 and `docs/oconnell-source-plan.md` §1.2
map the shared backbone. The parts this source reuses:

| layer | module | reused for |
|---|---|---|
| PDF structure | `src/newsletter/pdfReader.js` | page count, text blocks, embedded images |
| PDF rasterise | `tools/_oconnell_pdf.py` (PyMuPDF) | turning a page into an image for OCR |
| prose OCR | `src/newsletter/proseOcr.js` | reading vector-outlined body copy |
| table geometry | `src/table/tableGrid.js` | grid rules, cells, ink components |
| table reading | `src/table/tableReader.js` | per-cell OCR, colour, stars |
| panel geometry | `src/video/positionColumn.js` | finding the ticker column in a GUI table |
| panel reading | `src/video/positionPanel.js` | reading the table, header-anchored |
| crop from source | `src/video/panelExtract.js` | crop the panel out of the **source** frame |
| era-conditional crop | `src/video/chartStreamCrop.js` | the *pattern* for a layout that changed |
| audio -> text | `src/transcript/deepgramClient.js` | Deepgram, `nova-2`, retries, key hygiene |
| transcript shape | `src/transcript/transcriptNormalize.js` | one canonical `{start_sec,end_sec,text,confidence}` |
| segment store | `src/transcript/segmentStore.js` | the `transcript_segments` cache |
| runner | `src/transcript/extractRunner.js` | replace-a-video's-rows, never-regressing |
| ticker hygiene | `src/normalize/*` | decode, fuzzy resolve, lexicon |
| scoring | `src/sevcik/outcomeAnalysis.js` | returns, hits, SPY baseline, Wilson CI |
| prices | `src/analysis/priceProvider.js` | the Yahoo cache |
| event derivation | `src/report/derivePositionEvents.js`, `derivePortfolioActions.js` | BUY/SELL/ADD/TRIM from a position series |
| report shell | `src/report/sourceDashboardShell.js` | header, coverage funnel, CSS |
| record contract | `docs/source-dashboard-pattern.md` | the payload shape |
| CSV | `src/write/writeCsv.js`, `src/config/schema.js` | the column contracts |

### 1.2 What it does NOT reuse, and why

* **`videos` / `trade_signals` / `market_readings`.** `videos` is named for
  YouTube and its `status` column is an OCR lifecycle; `trade_signals` and
  `market_readings` carry a NOT NULL `transcript_id` that REFERENCES
  `video_transcripts(id)`. This corpus has no YouTube identity at all --
  the files have no video id -- so it gets its own tables, the way
  O'Connell and AsymTrading do, with a namespaced id (`komar_<...>`).
* **`src/table/tableGrid.js` is reused but NOT changed.** It finds rules by
  NEAR-BLACK on a *white* spreadsheet. The Komar sheet is the same thing
  (a Google Sheets screenshot), so it fits. But the project's standing rule
  is that shared code does not change under a source that depends on it
  without its own measurement -- so any Komar-specific grid quirk goes in
  `src/komar/tradeLogLayout.js`, not in the shared module.
* **`src/asym/sectorGeometry.js` is not reused.** It measures DIM GREY rules
  on a dark video frame. Komar's sheet is on white.

### 1.3 The one defect this source does not inherit

`docs/benzinga-source-plan.md` §1.4 documents that a channel has to be
registered in **six** places and proposes `config/channels.json` plus
`src/sources/registry.js`. **Neither exists.**

This source touches **none** of the six. There is no catalog crawl, no
`videos` row, no `videos.status`. The integration points are `package.json`
and a new schema file.

---

## Part 2: What the corpus is (measured 2026-11-17)

### 2.1 The shape of it

| | root | `_finished` | total |
|---|---|---|---|
| files | 45 | 98 | **143** |
| MP4 | 19 | 97 | **116** |
| PDF | 26 | 1 | **27** |
| PDF pages | 224 | 1 | **225** |
| video hours | 12.4 | 53.5 | **65.9** |
| video GB | 12.9 | 35.4 | **48.3** |

The split is **not chronological**. The root holds the PDF corpus (every
PDF) *and* the most recent videos *and* three old ones (Weekend-Report 43,
94, 105, 142). `_finished` holds the rest of the video archive. The PDF
corpus is a **Jan 2025 -> May 2026** window; the video archive is
**Jan 2022 -> May 2026**.

> A measurement note: the first pass at these numbers reported **213 MP4 /
> 118.7 h**. That was `Get-ChildItem -Recurse` over a folder *and* its own
> subfolder, which enumerates the subfolder twice. The table above comes
> from two separate non-recursive listings. The rule from AGENTS.md applies:
> quote the number the tool printed, and re-derive it when the tool is
> suspect.

### 2.2 The video corpus

Resolution (measured with `ffprobe`, never inferred from size):

| resolution | files | what it is |
|---|---|---|
| 1280x720 | 57 | the majority; TradingView screen share, panel text ~9 px |
| 1920x1080 | 41 | newer sessions and the 2022 archive; panel text ~13 px |
| 960x540 | 8 | 2025-2026, panel text ~7 px -- **below reliable OCR** |
| 2560x1440 | 7 | best panel legibility |
| 640x360 | 2 | "Audio Lessons" -- slide deck + voiceover, **no panel at all** |
| (no video stream) | 1 | `65 gap down in XNDU...` -- audio-only |

Duration: median ~30 min, longest 7,115 s (Weekend-Report 51, Jan 2022).

Series (by filename):

| series | files | hours | shape |
|---|---|---|---|
| `Weekend-Report NNN` | 65 | 35.8 | the weekly session, in **three parts** |
| other (`Weekend Report NNN`, market-update singles) | 21 | 12.0 | older naming |
| education | 13 | 9.0 | lessons, screeners, backtests |
| `EPS N` / `Audio Lessons` | 8 | 3.4 | slide decks, voiceover |
| `Mid-Week Update` | 6 | 1.8 | short update posts |
| `Member Webinar` | 2 | 2.6 | long-form |
| `Daily Market Update` | 1 | 1.3 | short update post |

**29 distinct Weekend-Report numbers**: 43, 50, 51, 70, 94, 105, 129, 142,
160, 163, 164, 169, 188-199, 211, 215, 218, 222, 224, 226.

The weekly session is a **triple**:

```
Weekend-Report 226 - Market Overview.mp4     (727 s)
Weekend-Report 226 - My Portfolio.mp4        (807 s)
Weekend-Report 226 - Stocks Analysis.mp4     (1,820 s)
```

Older ones are the same triple under a suffix (`-01`, `-02`) and the older
naming (`Weekend-Report 197 MARKET UPDATE Premium.mp4` + `-01` + `-02`).
That ordering -- **overview, then portfolio, then stocks** -- is a free
segmentation the corpus already gives us.

### 2.3 The PDF corpus, by kind

The 27 PDFs are **not one kind**. Three readers are needed.

#### (a) Web-page prints -- 15 files, the weekly and daily reports

`komar_YYYYMMDD.pdf`, `20250125_weekend_report.pdf`,
`20250625_daily_update.pdf`, `20250820_daily_update.pdf`,
`komar_20260504_biggest_losses.pdf` (a "Trading Lessons" post).

* Text layer: **4 spans per page** (title, URL, page number, print time).
* Body prose: **vector outlines** -> needs rasterise + OCR.
* Embedded images: the **"Market Update" card** (1080x764) -- a rendered
  slide carrying `Market Trend` (NASDAQ / S&P 500 / Russell 2000, each with
  a mid and a short arrow), `Exposure` (a "100% invested" donut), a one-line
  market read, and **High-Potential Themes** with **Leaders** (e.g.
  Semis -> SNDK, MU, INTC; Data centers -> CIFR, HUT, NBIS; Software ->
  FROG, DDOG, TWLO). This card is **the single densest structured document
  in the corpus** and it is a clean raster image -> OCR at 4x, no prose
  heuristics needed.
* Text layer also carries the **chapter timestamps** (`18:45`, `12:35 41:04`,
  `14:51`, `30:20`), which are the site's chapter list -> a free section
  index for the transcript.
* The daily/mid-week prints carry a **"Daily Audio Update"** block with an
  `audio-message.m4a` attachment (18.1 MiB, 00:19). The **audio file itself
  is not in the folder** -- only the PDF render. The audio content is
  therefore **unrecoverable from this corpus**; the matching video
  (`April 15 2026 Mid-Week Update.mp4`) carries the same material.

#### (b) Slide decks -- 10 files

`Trades-August-2025.pdf` (67 pages), `core_strategy_v2.pdf` (3),
`market_rules_v2.pdf` (3), `a_simpler_rule_set_for_position_trading.pdf`
(10), `my-favorite-chart-patterns-for-high-potential-stocks.pdf` (11),
`every-trader-makes-mistakes-no-matter-what.pdf` (5),
`reflecting-on-my-decision-lessons-learned-from-moving-to-cash-on-feb-11-2025.pdf` (5),
`talking-about-hidden-champions-learnings-why-smci-was-a-hidden-gem.pdf` (4),
`the-emotional-temptation-of-chasing-trades.pdf` (6),
`why-you-should-avoid-what-90-of-traders-are-doing.pdf` (6).

* These are **16:9 slides** (720x405 pt), and their **notes are a real text
  layer** (22 glyph spans on `Trades-August-2025.pdf` p1, `BT`=22) --
  prose is *not* outlined on these. `core_strategy_v2.pdf` p2 by contrast
  has 9,449 `l` / 25,666 `c` operators against 4 spans, so that deck's
  *prose* is outlined and only the notes are text. **Both behaviours occur
  in the same corpus** -> the reader must detect per page, not per file.
* `Trades-August-2025.pdf` p2 carries the **trade-log screenshot at
  2048x1715** -- the highest-resolution table in the corpus.

#### (c) Text-native summaries -- 2 files

`20250816_Julian_Komar_Weekend_Report_Summary_NoTable.pdf` and
`_finished/Weekend_Report_Summary_Corrected.pdf`. One page each, **no
images, no drawings, full text layer** (2,839 / 2,228 chars). Sections:
`Market Trend Analysis`, `Commodities & Crypto`, `Stocks Holding Up /
Under Watch`, `Additional Mentions`, `Summary`.

Each ticker line is `TICKER: description.` followed by a **ZapfDingbats
filled square** (rendered as the literal letter `I` in extraction). These
are **machine-written summaries of a video**, not the video itself -- an
important provenance distinction: they are a *derived* artifact and must be
labelled as such, not merged with the primary record.

> The `_NoTable` suffix implies a **with-table variant exists** and is not in
> this folder. Worth asking the user for it: a table version would give
> per-ticker ratings directly.

### 2.4 The on-screen panel -- two modes and three eras

This is the extraction layer's real prize, and it is **era-dependent**, in
exactly the way `src/video/chartStreamCrop.js` is.

| era | window | platform | panel |
|---|---|---|---|
| A | 2022-01 -> 2023-05 | TradingView on **macOS** (Safari), plus **MarketSmith** screens | right panel, header `Symbol | Last | Chg | Chg%`, group headers `STOCKS`, `NASDAQ.COM/W` |
| B | 2025-01 -> 2025-08 | TradingView on **macOS** | right panel, `Symbol | Last | Chg | Chg%`, group headers `COMMODITIES & BONDS`, `STOCKS` |
| C | 2025-08 -> 2026-05 | TradingView on **Windows** | right panel, `Symbol | Last | Chg%`, group headers `DATA CENTER`, `SEMICONDUCTORS`, `LITHIUM / RARE EARTH`, `SOFTWARE`, `OTHERS`, `SAAS / AI / DATA`, `FRESH OFFICIAL EARNINGS` |

And the panel has **two modes by session kind**:

* **`Watchlist`** -- in the *Stocks Analysis* part. Theme-grouped
  watchlist. Includes a `CASH` row at the top in era C.
* **`Portfolio`** -- in the *My Portfolio* part. The **holdings**, plus an
  explicit **`CLOSED`** group of exited names.

Both are TradingView GUI tables with the same three columns, so the same
panel reader serves both; only the *meaning* of the rows differs, and that
is a per-session-kind decision.

Two occlusions to design around:

* The **webcam circle** overlaps the panel's lower-right from about
  `y=862` (1920-space) downward. It hides rows when the list is long.
* In era A the video also shows **MarketSmith** screens with a bottom
  screener table (`Symbol | Name | Type | Ind Group Rank | Ind Risk Level |
  Ind Gr | % Chg YTD | Ind Mkt Val | Number of Stocks`) -- a **second table
  in a different place**, and a different platform.

### 2.5 Data-quality caveats

| observation | consequence |
|---|---|
| `Trades-August-2025.pdf` contains **July 2025** trades | the filename date is **not** the content date; content must be read from the page |
| Weekend-Report numbering is **not chronological** (50 = Jan 2023, 51 = Jan 2022) | never derive a date from the report number |
| "Weekend-Report 43" / "Weekend Report 129" use inconsistent spacing | the filename grammar must be tolerant |
| `65 gap down in XNDU...mp4` has **no video stream** | audio-only; must not be dropped as "corrupt" |
| `960x540` files (8) have ~7 px panel text | below reliable OCR -> report as `unreadable`, never as "no positions" |
| The two Summary PDFs are **machine-written summaries of a video** | a derived artifact; must not be merged with the primary record |
| The daily update's `audio-message.m4a` is **not in the corpus** | that audio is unrecoverable here |

---

## Part 3: The extraction layer

### 3.1 Catalog

`tools/catalogKomar.js` -> `komar_documents` + `komar_videos`.

**Filename grammar** (three families, one parser):

```
komar_20260509.pdf                     -> report document, session date 2026-05-09
komar_20260504_biggest_losses.pdf      -> report document + slug
20250125_weekend_report.pdf            -> report document, session date 2025-01-25
20250816_Julian_Komar_Weekend_Report_Summary_NoTable.pdf
                                      -> summary document (text-native)
Trades-August-2025.pdf                 -> strategy/lesson document (deck)
core_strategy_v2.pdf                   -> strategy/lesson document (deck)
20250820_daily_update.pdf              -> daily/mid-week post
Weekend-Report 226 - Stocks Analysis.mp4  -> video, session 226 part 3
April 15 2026 Mid-Week Update.mp4     -> video, session date 2026-04-15
Position Sizing.mp4                    -> video, education
```

**Id namespacing** (the O'Connell rule: the logical name is not the handle):

```
komar_doc_20260509                     document, session date
komar_doc_20260504_biggest_losses      document, session date + slug
komar_doc_summary_20250816             document, summary
komar_doc_deck_trades_2025_08          document, deck (content date from the page)
komar_vid_w226_stocks_analysis        video, report number + part
komar_vid_20260415_mid_week            video, session date
komar_vid_lesson_position_sizing       video, education
```

**Kinds** recorded on every row: `report | summary | deck | daily_post | lesson`.

**Rule 1 to encode**: never derive the date from the Weekend-Report number.
Rule 2: the *content* date wins over the filename date when they disagree
(the Trades deck). Rule 3: a session is keyed by **report number + date**,
because 226 appears in both folders.

### 3.2 Reading the PDFs

Three readers, selected by **measurement, not by filename**:

```
src/komar/documentLayout.js
  detectPageKind(page)      -> 'chrome_only' | 'text_layer' | 'outline_prose' | 'slide_notes'
  extractChrome(page)       -> title, url, page_no, print_ts   (always text)
  extractChapters(page)     -> the timestamp list from the text layer
  extractCardImages(page)   -> the embedded 1080x764 Market Update cards
```

* `chrome_only` and `outline_prose` -> rasterise at 200 DPI and OCR with
  **`src/newsletter/proseOcr.js`** (already height-filters prose from chart
  ink). Note the Komar case is *easier* than O'Connell's: the page is a web
  page, so the "chart ink" is one chart image, not 29 pages of screener
  tables.
* `text_layer` -> read directly (the two Summary PDFs).
* `slide_notes` -> read the text layer directly for the notes; render the
  embedded image and OCR it separately.

**Card images** (the Market Update card) get their own reader, because the
card's fields are *known* and a targeted OCR beats a page-level one:

```
src/komar/cardLayout.js
  marketTrend(card)   -> { NASDAQ: {mid, short}, S&P500: {...}, Russell2000: {...} }
  exposure(card)      -> { percent_invested: 100 }
  themes(card)        -> [ { theme: 'Semis', leaders: ['SNDK','MU','INTC'] }, ... ]
  narrative(card)     -> the one-line market read
```

The theme leaders are **tickers**, and they are the highest-value field in
the whole corpus: a dated, curated list of the market leaders in each theme,
read from a clean image.

### 3.3 Reading the trade log

`Trades-August-2025.pdf` p2, image 2048x1715. Column set read off the page:

```
Date opened | Date closed | Entry type | Ticker | Avg. price | Stop loss % |
Risk size | Stop loss price | Risk vs Capital | Exit type | MARS Open/Close |
MMTS Open/Close | W%L | W/L % | Initial rating | After close rating | Review | Comment
```

This is the **closest thing in the corpus to a ground-truth trade log**, and
it is a *table*, so it uses `src/table/tableGrid.js` + `tableReader.js`
(the O'Connell position-log path) with the column names held in
`src/komar/tradeLogLayout.js`.

Two things the O'Connell measurement already predicts and that will apply
here: the sheet has **filled red/green cells** that a naive rule detector
reads as rules, and the **column widths are not uniform**.

The per-trade slides (p3 onward) carry the **rating and the reasoning** in
the text layer: `4.5 stars. Got really tight yesterday. A bit choppy that's
why 0.5 stars less. Hot theme: AI data centers. Initial entry: 55.90 Stop
loss: 52 (7%) Add-ons: 57.02 and 58.16` plus a **"Quick checklist"** with
nine binary items (`Explosive look?`, `Big upmove before (70-100%)?`,
`Exponential / straight?`, `Increased volume?`, `EMA 8 / 21 surfing?`,
`Clean price action?`, `Narrow / inside bar?`, `Higher lows?`,
`Innovative product?`).

**That checklist is the source's setup definition, in the author's own
words.** It is the highest-value text in the corpus and it is machine
readable today.

### 3.4 The videos

#### 3.4.1 Audio -> text

All 116 files have an AAC audio stream (48 kHz, mono or stereo). There are
**no YouTube captions** -- these are local files -- so Deepgram is the only
route.

**The language is a model choice, not a hint.** `src/transcript/deepgramClient.js`
documents the measurement: pointed at the wrong acoustic model, Deepgram
emits a handful of isolated words instead of a transcript. The module's
default is `cs` (Czech, for Sevcik) and the repo's `.env` sets
**`DEEPGRAM_API_KEY` only** -- no language. So a Komar run **must** pass
`language: 'en'` per call, the way `tools/fetchSevcikTranscripts.js` does
for its `T3LIVE` and `BENZINGA` channels.

`tools/fetchKomarTranscripts.js` (new):

* reuses `extractAudio` + `transcribeAudio` from `deepgramClient.js`,
  `normalizeDeepgram` from `transcriptNormalize.js`;
* takes a **local path**, not a YouTube id (the existing tools are id-based);
* writes to `data/video_pipeline/transcripts/komar_<id>.json` in the
  canonical shape;
* deletes the extracted MP3 after each file (the existing default);
* is resumable, chunked and logged like `tools/fetchDeepgramBatch.js`;
* records `provider='deepgram'`, `language='en'`, `model` in the DB.

Cost at 65.9 h = 3,954 minutes: **~ $30** on `nova-2` standard
($0.0077/min), **~ $17** on batch pricing. That is a rounding error next to
the time, and the transcripts are the corpus's primary text.

#### 3.4.2 The panel

`tools/extractKomarPanel.js` -> for each video, sample frames, crop the
right-hand panel **from the source frame** (never from a downscaled OCR
frame -- that is `src/video/panelExtract.js`'s measured rule), OCR it, and
read the rows.

```
src/komar/panelLayout.js
  panelEra(session)        -> 'A' | 'B' | 'C'    (by date, from the measured table)
  panelRegion(era, w, h)  -> { x, y, w, h }      (measured per era)
  panelMode(sessionKind)   -> 'watchlist' | 'portfolio'
  readPanel(rows)         -> { groups: [{header, rows:[{symbol,last,chgPct}]}] }
```

The reading reuses `src/video/positionColumn.js` (finds the ticker column
from ink runs) and `src/video/positionPanel.js` (anchors on the header row
to choose among left-aligned candidate columns). Two adaptations are
needed, and they belong in `src/komar/panelLayout.js`, not in the shared
modules:

1. The Komar header says **`Symbol`**, not `Sym` (era C), and era A/B have
   a fourth column. The header-anchor logic must accept both.
2. The panel sits at the **right edge of the whole screen**, and the webcam
   circle **overlaps its lower part** -> the region must exclude the
   occlusion, and rows that fall behind it must be recorded as
   `occluded`, not as absent.

**Where the panel geometry has to be measured, not assumed.** The crop
`crop=300:1000:1620:30` on a 1920x1080 frame produced a clean read of 14
rows, but that was one frame of one video in one era. The plan requires
pinning the geometry per era against **pinned ground-truth frames** (the
pattern `test/fixtures/qmg_benchmark/manifest.json` already uses), because a
crop that is 20 px off will read `PL` as `P|`.

**Frame sampling budget.** The panel is static for long stretches, so a
low frame rate suffices: the panel changes when he changes the watchlist,
which is visible as a change in the panel crop's checksum. Sample at
**1 fps**, hash the cropped panel, and OCR only when the hash changes.
That is the same idea as `src/video/imageHash.js` and
`src/asym/frameOcrCache.js` (a cache keyed on path + mtime + parser
version), and it turns 65.9 h of video into a bounded number of OCR passes.

#### 3.4.3 Chapters

The chapter timestamps in the PDF text layer (`18:45`, `12:35 41:04`, ...)
are the site's own chapter list. Where a PDF exists for a video, the
chapter list gives a **free section index** for the transcript
(`Market Overview` / `My Portfolio` / `Stocks Analysis`). Where it does
not (all of `_finished`), the **session kind from the filename** is the
only segmentation available -- which is why the filename grammar matters.

---

## Part 4: The transformation layer

### 4.1 The records

| record | where it comes from | shape |
|---|---|---|
| `komar_documents` | the catalog | one row per PDF |
| `komar_videos` | the catalog | one row per MP4 |
| `komar_transcripts` | Deepgram | canonical segments |
| `komar_panel_snapshots` | the panel OCR | a dated reading of the holdings/watchlist panel |
| `komar_positions` | `komar_panel_snapshots` (Portfolio mode) | symbol, last, chg%, group, is_closed |
| `komar_watchlist` | `komar_panel_snapshots` (Watchlist mode) | symbol, theme, last, chg% |
| `komar_setups` | the transcript + the deck checklist | ticker, action, rating, evidence_text |
| `komar_trade_log` | the trade-log sheet | the 18 columns, one row per trade |
| `komar_market_readings` | the cards + the PDF prose | exposure %, market trend arrows, themes |
| `komar_theme_leaders` | the card images | theme, ticker, date |

### 4.2 Ticker normalisation

Reuse `src/normalize/tickerDecode.js`, `tickerFuzzyResolve.js`,
`src/normalize/tickerScan.js` and the `config/ticker_*.csv` lexicons.
Komar names **thematic groups** ("DATA CENTER", "SEMICONDUCTORS",
"LITHIUM / RARE EARTH") that are **not** tickers and must never reach the
ticker normaliser as such -> the group headers are recognised **by layout**
(section rows are a distinct visual row type in the panel), not by string
matching.

The ticker corpus here is unusual: `SNDK`, `NBIS`, `CIFR`, `HUT`, `FROG`,
`DDOG`, `TWLO`, `LARC`, `UMAY`, `CRML`, `USAR`, `AMLX`, `WULF`, `CRWV`,
`LITE`, `RKLB`, `AEHR`, `HIMX`, `NVTS`, `SIMO`, `AXTI`, `SYM`, `HYMC`,
`CVXZ`, `AON`, `MWH`, `NOK`, `POML`, `APLD`, `DFEL` -- a long tail of small
caps. `config/ticker_lexicon_observed.csv` and `ticker_names_confirmed.csv`
will need a Komar pass.

### 4.3 Setups from the transcript

The transcript carries the *reasoning*; the deck carries the *definition*.
A setup is extracted only when it can be anchored to a **named ticker** and
an **action verb**, and the evidence text is stored verbatim (the
`evidence_text` rule in `src/config/schema.js`: "a signal without the words
it was read from cannot be checked").

Reuse `src/sevcik/signalExtractor.js` + `signalPatterns.js` (the pattern
lists are Czech+English already) and `src/benzinga/marketReadings.js` for
the market-level readings. `src/transcript/extractRunner.js` is the runner
-- replace-a-video's-rows, never-regressing, with a `parser_version`.

**The deck checklist is the calibration set.** Nine binary items, each with
a known answer for the trades in the log. A setup extractor can be scored
against them: does a spoken setup contain the checklist items it claims?

### 4.4 Positions, actions and performance

`src/report/derivePositionEvents.js` and `derivePortfolioActions.js` already
turn a *series* of position readings into BUY/SELL/ADD/TRIM events and a
weighted position performance table. The Komar panel series is exactly that
shape: one reading per session, symbol, last, change.

`src/analysis/priceProvider.js` prices the entries and exits;
`src/sevcik/outcomeAnalysis.js` scores forward returns at +7 and +30
calendar days against SPY with Wilson intervals.

**The one metric only this source can answer.** A *setup* is what he SAID he
was watching; a *position* is what he HELD; and the **trade log** is what
he actually DID, with entry price, stop and result. Komar is the only source
in the project with all three. The aggregate should report the
**conversion funnel**: setups -> watchlist -> position -> closed trade, and
the hit rate at each step. That is a genuinely new question, not another
column.

---

## Part 5: The presentation layer

`src/report/komarReport.js`, built on `src/report/sourceDashboardShell.js`
and the payload contract in `docs/source-dashboard-pattern.md`.

```
source:  { id:'komar', label:"Komar (MARKET UPDATE Premium)", accent:'#1f7a4d',
           capabilities:['panel positions','panel watchlist','trade log','transcripts','market cards'] }
coverage: [ catalogued -> readable -> transcribed -> panel read -> extracted -> scored ]
items:    [ documents, videos ]
signals:  [ setups, from the transcript ]
readings: [ market trend arrows, exposure %, theme leaders, trade-log rows ]
outcomes: [ forward returns ]
```

Tabs, in the order the question is asked:

1. **Activity** -- the session timeline (Market Overview -> My Portfolio ->
   Stocks Analysis), with the chapter list.
2. **Positions** -- the panel readings, open vs `CLOSED`, per session, with
   the trade-log rows joined where the ticker and the date line up.
3. **Watchlist** -- the theme-grouped watchlist and the theme leaders from
   the cards, over time. *Which themes does he rotate into?*
4. **Setups** -- the calls, with the evidence text, the rating, and the
   outcome.
5. **Coverage** -- the funnel, with every stage's denominator.

The **source dashboard pattern** requires that a stage which has not been
checked is `unknown`, not zero. For Komar that matters in two places: the
`960x540` videos whose panel is below OCR resolution, and the sessions with
no PDF (no chapter list).

---

## Part 6: Files

```
NEW  src/komar/channel.js            identity, paths, id grammar, era table
NEW  src/komar/corpusCatalog.js      the folder walk + filename grammar
NEW  src/komar/documentLayout.js     the three PDF readers
NEW  src/komar/cardLayout.js         the Market Update card reader
NEW  src/komar/panelLayout.js        the panel geometry + row reading
NEW  src/komar/tradeLogLayout.js     the sheet's columns
NEW  src/komar/schema.js             guarded ALTERs, like src/oconnell/schema.js
NEW  src/report/komarReport.js       the dashboard
NEW  tools/catalogKomar.js
NEW  tools/fetchKomarTranscripts.js
NEW  tools/extractKomarDocuments.js
NEW  tools/extractKomarPanel.js
NEW  tools/extractKomarTradeLog.js
NEW  tools/extractKomarSignals.js
NEW  tools/aggregateKomarSignals.js
NEW  tools/analyzeKomarOutcomes.js
NEW  test/fixtures/komar_benchmark/  pinned frames + manifest.json (md5)
NEW  test/komar*.test.js
EDIT data/db/schema_derived.sql      the Komar tables
EDIT package.json                     komar:* scripts
EDIT .env.example                     KOMAR_SOURCE_DIR, KOMAR_PYTHON
```

Nothing existing is modified except the three files above.

---

## Part 7: Phasing

| phase | what | done when |
|---|---|---|
| 0 | this document | reviewed |
| 1 | the catalog | **DONE (2026-11-17)** -- `komar_documents` + `komar_videos` hold all 143 files, each classified by kind and dated from content where the filename lies |
| 2 | the PDF readers | **DONE (2026-11-17)** -- the card images yield market trends, exposure and theme leaders; the decks parse to notes. The trade-log SHEET and the Summary PDFs are not yet read. |
| 3 | the panel | a pinned frame from each era reads its tickers correctly; the ground-truth fixture is md5-pinned like the QMG one |
| 4 | the transcripts | every video has a transcript in the canonical shape; `language=en` is asserted, not assumed |
| 5 | the signals and the positions | setups carry evidence text; the panel series produces position events |
| 6 | the outcomes and the dashboard | the funnel, the conversion rates, the coverage |
| 7 | the tests and the documentation | `AGENTS.md` / `CLAUDE.md` updated; the `komar:*` scripts documented |

The order is **2 and 3 in parallel** -- they share nothing -- and **4 before
5**.

---

## Part 8: Risks

| risk | what is done about it |
|---|---|
| the wrong Deepgram language produces no transcript at all | the language is passed per call and recorded on every transcript; a run that yields a suspiciously short transcript is a failure, not a result |
| 65.9 h of Deepgram is a long, unobservable run | chunked, resumable, logged; one chunk failing does not take the rest down |
| the panel crop is 20 px off and reads `PL` as `P|` | the geometry is pinned per era against md5-pinned ground-truth frames, and the region is measured, not assumed |
| the webcam circle hides rows | the occlusion is excluded from the region and hidden rows are recorded as `occluded` |
| `960x540` files are below OCR resolution | they are reported `unreadable`; they never become "no positions" |
| the Summary PDFs are a *derived* artifact | they are stored with `kind='summary'` and `provenance='machine_written'`, and are never merged with the primary record |
| the corpus is outside the repository and cannot be re-fetched | the derived records are **committed** (as O'Connell's are), the media never is; the stored paths are relative to the corpus root |
| the file is named August and contains July | the content date is read from the page and stored separately from the filename date |
| the shared table/panel modules are modified under other sources | any Komar-specific behaviour goes in `src/komar/*`, never in the shared module |
| the PDF body prose is vector outlines | the reader detects it per page and OCRs it; the Summary PDFs' text layer is read directly |

---

## Part 9: Costs

| item | cost |
|---|---|
| Deepgram `nova-2`, 65.9 h (3,954 min) | **~ $30** standard, ~ $17 batch |
| OCR of the panel frames | bounded by the hash-change rule; hours, not days |
| OCR of the PDF pages | 225 pages, of which only the outline pages matter |
| disk for extracted audio | transient; deleted after each transcript |
| **storage of the corpus** | 48.3 GB, outside the repository, never committed |

---

## Part 10: Open questions

| # | question | why it matters |
|---|---|---|
| 1 | Is there a **with-table** variant of the Weekend-Report Summary? (`..._Summary_NoTable.pdf` implies one) | it would give per-ticker ratings directly, replacing inference |
| 2 | Does the corpus have the **audio** for the daily/mid-week updates? | the PDF shows an `audio-message.m4a` attachment that is not in the folder |
| 3 | Are the **Daily Update** posts' charts in the corpus at full resolution? | the PDF's chart image is 4353x2682 -- high quality -- and they are dated market reads |
| 4 | Is `Trades-August-2025.pdf` the only trade-log deck? | one more deck per month would make the trade log a time series |
| 5 | Should the trade-log deck be treated as **ground truth** for the panel readings? | it would let the panel reader be scored, exactly as the QMG benchmark scores the OCR |
| 6 | The 2022-2023 era shows **MarketSmith** screens as well as TradingView | a second panel position in a second app; decide whether it is in scope |
| 7 | Should `_finished` be merged into the catalog as one corpus, or kept as two? | the root has three old videos (43, 94, 105, 142) among the new ones |



