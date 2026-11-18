# Adding Komar (`julian_komar`) as a source: analysis and implementation plan

**Status:** Phases 1 (the catalog), 2 (the document readers), 2b (the
Summary), 3a (the trade-log sheet), 4 (the transcripts) and 5a (the
setups) **implemented** 2026-11-17. The panel reader, the outcomes and
the dashboard are not started. Every number below was measured on 2026-11-17 against the
corpus in `D:\courses_nosync\julian_komar` and
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
  spreadsheet screenshot with 18 columns). **READ in Phase 3** -- see
  "Phase 3 as built" above.
* **The card's per-horizon mapping.** The 2026-05-09 card's leader
  groups are read in a different order from its theme names, so some
  leaders carry the wrong theme. The leaders themselves are right.
* **The 2025 card's theme grouping.** Its four boxes are laid out
  differently and the group boundaries are off; the leaders are right.
* **The daily posts** (`20250625`, `20250820`, `komar_20260505`,
  `komar_20260506`) carry no market card -- their images are chart
  screenshots, and the card check says so.
---

## Phase 2b as built (2026-11-17): the WEEKEND-REPORT SUMMARY

```
src/komar/       summaryLayout.js   the sections, the entries, the verdicts
test/            komarSummaryLayout
test/fixtures/   komar_summaries/   the two summaries' TEXT, pinned (md5)
```

`npm run komar:documents` now also reads the two Summary PDFs, and
writes `komar_summary_readings`: **43 readings** -- 32 holdings, 7
commodities and 4 prose sections, over **30 distinct subjects**.

**THEY ARE A DERIVED ARTIFACT.** They are machine-written summaries OF
a video, and the plan says they must be labelled as one and never
merged with the primary record. What they carry that nothing else in
the corpus does is a dated, curated, per-ticker WATCHLIST with the
author's VERDICT on each name -- so they are worth reading, and they
are stored in their own table.

**They are TEXT-NATIVE** (a ReportLab PDF: 2,778 and 2,149 characters
of text layer), so no OCR is involved at all.

**THE TWO FILES ARE IN DIFFERENT FORMATS, and that is the difficulty.**

| | 16 August | 24 August |
|---|---|---|
| a holding reads | `VFF (Village Farms) -- commentary. [square] Needs more consolidation.` | `DFDV: commentary. [square]` |
| the company's name | printed | not printed |
| the verdict | printed | absent |

**THE SQUARE IS A LETTER.** The summary prints a ZapfDingbats filled
square, and the TEXT LAYER renders it as the literal letter "I" --
and it is GLUED to whatever follows it. So every entry of the 24
August file but the first reads as "ISBET" where the ticker is SBET,
and "IBMNR" where it is BMNR. The corpus's own trade log settles it:
it carries BMNR for the entry the text layer reads as "IBMNR" (measured
2026-11-17).

So a leading "I" on an entry that is not the first of its section is
the square and not the ticker's first letter. **The raw form is kept
beside the reading** (`raw_subject`), so the decision is checkable.

**THE EXTRACTION DROPS THE SPACES AT LINE BREAKS**, inside a word as
well as between words: the verdict comes back as "Needs
moreconsolidation" and the 24 August file's as "Needsmore
consolidation". So the verdict's stance is matched with the spaces
IGNORED, and the verdict text is stored exactly as it was read.

**THE TITLE'S OWN WORD "Summary" WOULD SPLIT THE DOCUMENT.** The
document is called "Julian Komar Weekend-Report Summary" and its last
section is called "Summary", so the title and the date are cut out
before the sections are found.

### WHAT IS STILL NOT READ

* **The with-table variant of the Summary.** The file is named
  `..._Summary_NoTable.pdf`, which implies a with-table version exists
  and is not in this folder. It would carry per-ticker RATINGS
  directly, replacing the inference from the verdict. Worth asking the
  user for (the plan's open question 1).

---

## Phase 3 as built (2026-11-17)

```
src/komar/       tradeLogLayout.js   the sheet's geometry, its 18 columns, its values
tools/           extractKomarTradeLog.js
test/            komarTradeLogLayout  komarTradeLogTool  komarTradeLogSchema
test/manual/     komarTradeLogRead    the full OCR pass (20 s, so it is manual)
test/fixtures/   komar_tradelog/      the pinned sheet (md5 31bea590299439d3bd03a872e0c9e0a0)
```

`npm run komar:tradelog` reads the trade-log sheet -- `Trades-August-2025.pdf`
page 2, a 2048x1715 screenshot of a spreadsheet -- and writes
`komar_trade_log`: **32 trades**, **26 distinct tickers**, every one of
the sheet's 18 columns.

### The sheet's own content is JULY 2025

The file is named `Trades-August-2025.pdf` and its first slide says
"July 2025 Trades" -- the same lie the catalog already records as
`date_conflict`. The trades themselves say so too: every entry date is
between **2025-07-02 and 2025-07-29**.

### THE GRID IS GREY, AND THE SHARED READER CANNOT SEE IT

`src/table/tableReader.js` finds a grid by NEAR-BLACK rules (luma <= 40)
on a white spreadsheet. This sheet's gridlines are **neutral grey**:
measured, the row separators run luma 169..248 and the column
separators 165..195. So `findHorizontalRules` finds **zero** rules on
the raw pixels and the whole image reads as ONE cell.

The fix is a Komar-specific PREPROCESS -- the shared module is not
touched (the project's standing rule) -- in `src/komar/tradeLogLayout.js`:

1. locate the grey lines (a coverage profile, plus a both-sides test so
   that a FILL BLOCK's interior is not a line);
2. paint them near-black in a COPY of the pixels;
3. hand that copy to the shared reader, which then sees the grid it
   expects.

**THREE THINGS THE GREY GRID DOES THAT THE BLACK ONE DOES NOT**

- **The header is a fill block, not a rule.** The grey header band runs
  y=33..123 (91px) and its interior rows are >=85% grey exactly like a
  rule would be. A thick island therefore contributes its two EDGE rows
  (33 and 123) and no interior row, and the header TEXT -- which breaks
  the island into 33..47 / 56..123 -- is bridged by a gap merge of
  <=12 rows.
- **The filled cells hide their own column rules.** The W/L columns are
  conditionally filled (green rgb(85,221,49), red rgb(232,39,6)), and a
  fill starts exactly ON the boundary at x=960 and ends on the boundary
  at x=1030 -- so grey coverage over the data rows never reaches 85%
  there and BOTH boundaries vanish. They are recovered from the FILLS'
  OWN EDGES, which is why the detector has a third source.
- **The date column is filled too.** `Date opened` carries a grey fill
  (rgb 220) down the whole table, and the date glyphs inside it break
  its column into fragments (gaps of 10/30/8px). Vertical islands are
  merged across gaps of <=40px; real column rules are never closer than
  50px (the narrowest measured gap is 538..588).

The 19 boundaries that come out: 10, 121, 225, 350, 418, 482, 538, 588,
639, 721, 802, 886, 964, 1029, 1100, 1195, 1290, 1384, 2030.

### A CELL IS READ IN LINE ORDER, NOT IN LEFT-EDGE ORDER

The shared reader sorts a cell's words by their LEFT EDGE. That is
right for a single-line cell and wrong for a wrapped one, and this
sheet wraps a lot: "Breakout short-" / "term", "Risk" / "Capital",
"MMTS" / "Opening", and numbers ("18,63" with a "3" under it).

The second line's first character sits a pixel to the LEFT of the first
line's, so the left-edge order read:

| the sheet says | the reading was |
|---|---|
| Breakout short-term | `term Breakout short-` |
| Risk Capital | `Capital Risk` |
| MMTS Opening | `Opening MMTS` |
| 10,312 | `2 10,31` |
| 18,633 | `3 18,63` |

**It cost four of the eighteen columns their mapping.** The header is
matched fuzzily and globally, and "Capital Risk" is six edits from
"Risk Capital" -- past the tolerance -- so `risk_capital_pct`,
`mmts_opening`, `mmts_close` and `after_close_rating` were never
matched, and every row lost four values. The text is now rebuilt from
the words' own boxes: words grouped into LINES by their vertical
position, lines top to bottom, words within a line left to right.

### THE WHITELIST MUST CARRY THE DOT

The repair pass re-reads a cell whose text holds a character its column
cannot hold. The sheet prints decimals with a COMMA and the OCR
sometimes returns a dot for the same comma ("-1.39" for "-1,39"), and a
whitelist without the dot makes that reading look like a stray
character -- so the repair re-reads the cell with a whitelist that CANNOT
hold the dot, and the value comes back a hundred times too large
(measured: QSI's W/L R "-1.39" became -139 and fell outside its bounds).

**And a filled cell is never repaired.** The shared reader rewrites a
filled cell as black-on-white before it reads it; a repair would have to
do the same, and reading the original white-on-red pixels gives a worse
reading than no repair at all (measured: the red W/L cells came back as
fragments).

### THE SHEET'S OWN ARITHMETIC: W/L % IS THE RETURN ON THE AVERAGE PRICE

```
W/L % = (avg close price - avg opening price) / avg opening price * 100
```

Measured on 30 of the 32 rows, to the digit the sheet prints: QS
(9,91 - 7,18) / 7,18 = 38,0223 -> "38,02 %"; BMNR (40,779 - 45,526) /
45,526 = -10,4295 -> "-10,43 %". The two exceptions are the two rows
where a number could not be read.

So the column is DERIVED from two other columns, and the sheet's own
print of it is a CHECK on the reading rather than a fourth fact. That
is worth having twice over:

- it **catches a misread price**: GOGO's avg close reads "15,57" where
  the sheet prints "15,576", and the check sees 1,63 % against the
  sheet's "1,67 %". The row is FLAGGED (`reading_check`), not silently
  published;
- it **recovers a W/L that could not be read**: PDYN's "-11,33 %" comes
  back as "-1 1 33 :" -- the comma and the per cent sign lost -- and the
  prices give -11,33. The row records `derived_fields = 'wl_pct'`.

The tolerance is 0,02: the sheet prints two decimals, so its own
rounding is +-0,005.

### THE NUMBERS ARE EUROPEAN

The decimal separator is a comma ("7,18", "0,56 %"), the dates are
day-first and come in two forms ("08.07.25" and "29.07.2025"), and a
number that WRAPS inside its cell comes back with its fragments
space-joined ("17,10 15" is 17,1015) -- so whitespace is stripped
before a numeric cell is parsed. Every value is bounded by its
column's measured range, so a lost decimal point (a hundred times too
large) is refused rather than published.

### WHAT IS STILL NOT READ

* **The two Summary PDFs' prose.** They are text-native (2,839 and
  2,228 chars) and are a *machine-written summary of a video* -- a
  derived artifact, which the plan says must be labelled as one and
  never merged with the primary record.
* **The video panel** (the plan's Phase 3 in the phasing table -- the
  era-dependent TradingView panel). That is the heavy one: 116 videos,
  ffmpeg frames, and a pinned fixture per era.
* **The Deepgram transcripts** (the plan's Phase 4). The key is
  configured; 65.9 h at nova-2 is about $30.

---

## Phase 4 as built (2026-11-17)

```
tools/           fetchKomarTranscripts.js
test/            komarTranscripts
data/            video_pipeline/transcripts/komar_<id>.json   (tracked -- the record)
```

`npm run komar:transcripts` transcribes the corpus with Deepgram.
`npm run komar:transcripts:dry` prints the plan and the PRICE before a
cent is spent.

### The corpus's primary text

| | |
|---|---|
| videos | **116** |
| audio | **3,952 minutes** (65.9 hours) |
| the price at nova-2's standard rate | **$30.43** ($0.0077 a minute) |
| captions available | **none** -- these are local files, so Deepgram is the only route |
| the language | **`en`, per call** |

**THE LANGUAGE IS A MODEL CHOICE, NOT A HINT.** `src/transcript/deepgramClient.js`
documents the measurement: pointed at the wrong acoustic model,
Deepgram emits a handful of isolated words instead of a transcript
(measured: 15 segments of isolated words on Czech audio with
`language=en`, against 881 segments of full sentences with `language=cs`).
The module's default is `cs` -- Sevcik is Czech -- and the repo's `.env`
sets no language, so this tool passes `language: 'en'` PER CALL and
records the language the request actually used. A transcript with no
segments is treated as a FAILURE, not a result: that is exactly what the
wrong model produces.

### The JSON is the RECORD and the row is its INDEX

The transcript is written as the canonical JSON under
`data/video_pipeline/transcripts/komar_<id>.json`, and it is TRACKED --
the corpus cannot be re-fetched, so the derived records are committed
and the media never is. `komar_transcripts` (in the derived file) is
its index: provider, language, model, path, segment count, duration,
the provider's quality score, and the checksum.

**A file with no row is re-registered, not transcribed again.** The
first run of this tool wrote a transcript and then failed on the row
(the quality score was `undefined`, which SQLite will not bind), and a
resume that only looked at the FILE would have skipped that video for
ever with no row to show for it. So the resume check is the ROW, and a
file with no row has its row written from the file -- no Deepgram call.

**The audio is deleted after every request.** It is a byproduct; only
the transcript is the corpus.

**The order is by DURATION**, so a bounded run buys the most transcripts
per dollar, and the cheapest ones are the ones that fail first.

### WHAT THE TRANSCRIPTS CONTAIN (measured over the corpus)

A census of the ticker-shaped tokens in the transcripts, which is what
sizes the next stage:

| | |
|---|---|
| segments | **20,451** over 81 transcripts |
| words | ~290,000 |
| distinct ticker-shaped tokens | **456**, of which **261 appear once** |

The frequent ones are a MIX of the corpus's own holdings and the words
of a chart lesson:

```
EMA:539  US:116  AI:91  ARC:55  EPS:49  MA:39  IPO:38  AMD:33
MU:25  PL:22  ETF:22  OTC:19  SMCI:17  APLD:17  ADR:17  ARK:16
IOND:14  NBIS:13  SNDK:13  USAR:12  CRDO:12  NVIDIA:12  QS:12  CRML:11
```

So the setup extraction has to tell a HOLDING from a CHART TERM (EMA,
VCP, ARC, FOMO), a MARKET WORD (US, ETF, OTC, ADR, IPO) and an OCR
fragment ("I...", "ARC.") -- and the corpus speaks some names
("NVIDIA", 12 times) as well as symbols, so the confirmed-names table
needs a Komar pass. The plan already says so:
`config/ticker_lexicon_observed.csv` and `config/ticker_names_confirmed.csv`
will need a Komar pass.

### A PROVIDER ARTIFACT, MEASURED

Deepgram's utterance boundary can fall **inside a word**: the first
transcript reads "...Here you can see, I" and then "ONS. I sold that
here when it dropped below the EMA eight." -- the ticker "IONS" split
across two segments. Measured over 308 boundaries of three transcripts,
the shape (a segment that does not end on sentence punctuation followed
by one that starts with a capital) occurs about 1 % of the time, and
most of those are ordinary clause boundaries.

It is a PROVIDER artifact, and it is not fixed here: the fix belongs
where the words are read -- the extractor, which is Phase 5 -- and the
shared normaliser is not changed under a source that depends on it
without its own measurement.

## Phase 5a as built (2026-11-17): the SETUPS

```
src/komar/       lexicon.js          the corpus's own tickers, and the words that are not
tools/           extractKomarSignals.js
config/          ticker_lexicon_komar.csv   the 73 tickers the seed lexicon does not have
test/            komarLexicon
```

`npm run komar:signals` reads the transcripts through the SHARED engine
(`src/sevcik/signalExtractor.js` -- the same one the Sevcik, T3Live and
Benzinga extractors use) with the English name finder, and writes
`komar_setups`.

### THE SEED LEXICON DOES NOT KNOW THIS CORPUS

Measured on 2026-11-17: the corpus names **105** tickers -- the trade
log's 26, the market cards' 55 theme leaders and the Summary's 30
holdings -- and only **32 of the 105** are in the shared seed lexicon.
So 73 of the corpus's own names would not have been recognised at all.
Those 73 live in `config/ticker_lexicon_komar.csv`, one row each, with
the note saying WHICH artifact names it.

### THE TRANSCRIPTS ARE A CHART LESSON AS MUCH AS A TRADING CALL

786 distinct ticker-shaped tokens, and the frequent ones are a mix of
holdings and words:

```
EMA:797  US:255  EPS:232  IPO:97  ARC:71  ETF:65  ADR:46  VCP:30
OTC:25  NASDAQ:18  IBD:21  FOMO:15  MMTS:19  COVID:12  EMI:11
```

Every one was checked against the SEC's own registrant list before
being stopped, because a token that IS a listed registrant might be a
holding:

* **"EMI" is the EMA INDICATOR.** The corpus says "the EMI 21" and "the
  EMI 65", and EMI is a listed registrant (a music company), so it has
  to be stopped or every chart reference becomes a holding.
* **"MMTS" is the author's own score**, not a ticker -- he says "from
  looking at the MMTS" nineteen times.
* **"ARC" is "ARK Innovation Fund"** (Cathie Wood's ARKK), so it is an
  ALIAS and not a stop. But the alias needs the WHOLE NAME: a looser
  one ("the ARC") fired on sentences that are ABOUT Cathie Wood --
  "Kathy Woods from the ARC, you know, she would do 1,000,000 times
  better if she would look at charts" -- and turned a remark about a
  fund manager into **57 setups on ARKK**. A missing setup is better
  than a false one.
* **"CCG", "ALAP", "NB" and "KC" LOOK like words and are not** -- the
  contexts say so ("CCG is another sister stock", "I'm thinking about
  ALAP, CRDO", "NB Bancorp", "the same is true for KC, VNET"), so
  they are left alone.

### WHAT IT FOUND

| | |
|---|---|
| setups | **212** over 116 transcripts |
| the corpus's own tickers among them | PLTR:19, RKLB:9, GDS, CRDO, VST, GLBE, BTCS, ... |

### THE TWO THINGS THAT ARE STILL WRONG

1. **A RUN MIXES A TICKER MENTION WITH UNRELATED COMMENTARY.** The
   shared engine's RUN model takes the text from a ticker mention to
   the next one, so a mention inside a general remark ("the bases are
   looking always the same") produces a call whose direction comes
   from the surrounding talk. This is the SHARED engine's behaviour and
   it is the same for T3Live and Benzinga; it is measured there, not
   fixed here.
2. **"CRISPR" is the company (CRSP), not the technology** -- and the
   confirmed-names table has no row for it, so it is stopped rather
   than published as a ticker. That is a gap in
   `config/ticker_names_confirmed.csv`, which the plan says needs a
   Komar pass.

## Phase 3b as built (2026-11-17): the PANEL, measured

```
src/komar/       panelLayout.js    the eras, the region, the pitch, the occlusion
test/            komarPanelLayout
test/fixtures/   komar_panel/       one panel crop per era, pinned (md5)
```

The panel is the on-screen table at the right edge of every session,
and it is the last unmeasured thing in the corpus. **This phase
MEASURED it; the reader that consumes the measurement is the next
step**, and the measurements below are what that reader needs.

### THE GEOMETRY, MEASURED OFF THE PIXELS

Three frames, one per era, at their native resolutions:

| | frame | size |
|---|---|---|
| era A | Weekend-Report 51 (2022-01-14) | 1920x1080 |
| era B | Weekend-Report 193 (2025) | 1280x720 |
| era C | Weekend-Report 224 (2026-04-25) | 1920x1080 |

* **the table is the RIGHT ~15 % of the screen in every era**: its
  left edge measured at x=1660/1920 (0.865) in era A, 1640/1920 (0.854)
  in era C and 1128/1280 (0.881) in era B;
* **the header row** sits at y=0.132 of the height in era A and 0.128 in
  era C;
* **the row pitch is 25px at 1080 and 17px at 720 -- which is 0.023 of
  the height in both.** So the pitch is a FRACTION and not a pixel
  count, and that is what makes one crop work at every resolution the
  corpus holds (960x540, 1280x720, 1920x1080, 2560x1440);
* **the WEBCAM CIRCLE overlaps the panel's lower right**, and its top
  edge moves with the frame (measured at 0.57 of the height in era C
  and 0.80 in another). A row behind it is recorded as OCCLUDED, not
  as absent -- the plan's rule, and the difference between a short
  list and a wrong one.

### THE ERAS DIFFER IN ONE THING THAT MATTERS: THE COLUMN COUNT

| era | header | groups |
|---|---|---|
| A | `Symbol \| Last \| Chg \| Chg%` | `STOCKS`, `NASDAQ.COM/W` |
| B | `Symbol \| Last \| Chg \| Chg%` | `COMMODITIES & BONDS`, `STOCKS` |
| C | `Symbol \| Last \| Chg%` | the THEME names, and `CLOSED` |

and the header says **"Symbol", not "Sym"** -- so a reader that
expects the QMG header would pick the wrong columns.

### A GROUP HEADER IS ONE OF THE ERA'S OWN LABELS

"CLOSED", "STOCKS", "DATA CENTER" -- and the era carries the list.
It is deliberately NOT a shape test: a row whose prices could not be
read leaves a lone symbol in the column, and a shape rule ("no digits")
would call that a group header and DROP THE POSITION. That is a rule
the test now pins.

### WHAT IS STILL TO BE BUILT

The reader itself: the crop from the source frame (never from a
downscaled OCR frame -- that is `src/video/panelExtract.js`'s measured
rule), the header anchor, the per-cell read, the `CLOSED` group as a
section rather than a holding, the occlusion, the schema
(`komar_panel_snapshots`, `komar_positions`, `komar_watchlist`) and
the frame sampling (the panel is static for long stretches, so hash
the crop and read it only when the hash changes -- the same idea as
`src/video/imageHash.js`).

## The PANEL READER: where it stands (2026-11-17)

`src/komar/panelReader.js` reads the panel out of a frame, and it is
**not yet good enough to publish**. This is the honest state of it:

| | |
|---|---|
| the region, the header and the columns | found ✓ |
| the rows | found ✓ |
| the prices | mostly read ✓ ("252.76", "76.64", "418.08" all come out right) |
| the SYMBOLS | **not reliable** -- the row's icon is read as a letter, so the POWL row reads "VPOWLE" and half the rows are wrong |
| the W/L sign from the fill | **not reliable** -- the fill is not always sampled where the sign is, so "-7.41 %" comes back "+7.41 %" |
| the detail card under the table | still read as rows on some frames |

**A wrong holding is worse than a missing one**, so the reader is NOT
wired to a writer: no tool writes `komar_panel_snapshots`, and the
dashboard's coverage funnel says the panel stage is **unknown** rather
than zero.

What the next iteration needs, in the order the defects bite:

1. **THE SYMBOL COLUMN IS CONTAMINATED BY THE ROW ICONS.** The panel
   draws a small coloured icon before every symbol and Tesseract reads
   some of them as letters. The reader already prefers the token the
   LEXICON knows, which fixes half of them; the rest needs the icon's
   own pixels excluded from the crop -- the icon is a COLOURED blob,
   so the symbol strip can be masked where the pixels are saturated.
2. **THE W/L SIGN.** The fill is the authority, but the cell's middle
   can be over the text. The fix is to sample the fill at the cell's
   RIGHT edge (where the number is not) or to count the coloured
   pixels in the cell instead of sampling one.
3. **THE DETAIL CARD.** The card under the table is a different
   widget with its own layout; the gap test catches it on some frames
   and not on others.

The QMG project took many rounds on its equivalent
(`src/video/positionTableScan.js` and the whole "column gate" work
in AGENTS.md), so this is the expected cost of the work, not a sign
that the approach is wrong.

---

## Phase 6 as built (2026-11-17): the OUTCOMES and the DASHBOARD

```
tools/           analyzeKomarOutcomes.js
src/report/      komarReport.js
data/            komar_outcomes.json  komar_outcomes.csv  komar_report.html
```

`npm run komar:outcomes` scores the setups against the prices and
writes the dashboard.

### WHAT IT FOUND

| | |
|---|---|
| setups, from the sessions | **153** |
| setups from the lessons and the webinars, left out on purpose | **60** |
| of the session's setups, with a session date | **153 — every one** |
| hit rate, 1 week | **59.2 %** |
| SPY over the same windows | **69.7 %** (1w) |
| the edge | **-10.5 pp (1w)** |
| the verdict | `possible_negative_edge` |

**So the calls DO NOT BEAT THE INDEX** -- the same honest result the
other sources give (Sevcik, T3Live and Benzinga are all flat or
negative against the same baseline). The corpus's own trade log is
where the source's real signal is: what he actually did, with the
prices and the outcomes.

**Every setup from a session is scored.** The report number dates the
sessions (it is chronological -- seven days a number), so what is left
undated is the 60 setups in the LESSONS and the WEBINARS: evergreen
teaching content, which carries no timely call and has no window to
score it against. They are excluded on purpose, and the exclusion is
reported rather than left as a silent gap.

### THE DASHBOARD

`data/komar_report.html`, on the shared source shell
(`src/report/sourceDashboardShell.js`), with the tabs the source's
question needs: the CALLS (with the outcomes and the evidence), the
TRADE LOG, the WATCHLIST (the weekend summaries) and the MARKET (the
cards) -- and the COVERAGE FUNNEL, which is where the panel says
**unknown** rather than zero.

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
| Weekend-Report numbering IS chronological -- 43 = 19 Nov 2022, 50 = 8 Jan 2023, 211 = 25 Jan 2026, seven days a number (only `January 14 2022 Weekend-Report 51` disagrees, and its year is a typo) | the number DATES a session whose own name carries no date; an anchor that contradicts its neighbours by more than a fortnight is not trusted |
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
| 2 | the PDF readers | **DONE (2026-11-17)** -- the card images yield market trends, exposure and theme leaders; the decks parse to notes. The Summary PDFs are not yet read. |
| 3a | the trade-log sheet | **DONE (2026-11-17)** -- 32 trades over 26 tickers, every one of the sheet's 18 columns, checked against the sheet's own arithmetic. |
| 3b | the video panel | the GEOMETRY is measured and pinned (2026-11-17): the region, the row pitch, the era column counts, the occlusion. The reader, the schema and the frame sampling are not built. |
| 4 | the transcripts | **DONE (2026-11-17)** -- 116 videos, 3,952 minutes, ~$30 of Deepgram at `language=en`; the canonical JSON is tracked and `komar_transcripts` indexes it. |
| 5a | the setups | **DONE (2026-11-17)** -- 213 setups over 75 transcripts, read with the shared engine and the corpus's own lexicon (73 tickers the seed lexicon does not have). One ticker the provider split across a boundary is rejoined by `src/komar/transcriptRepair.js` (2026-11-18) |
| 5b | the positions | the panel series produces position events (needs 3b) |
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



