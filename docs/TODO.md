# TODO

The open items that are not blocked on an answer from the user, and not
blocked on the corpus. Each one says what is known, what is not, and
what a fix would look like -- so that a later session can pick it up
without re-deriving the measurement.

## The Komar source

### The exact DAY of a report is not recoverable from its number

**RESOLVED (2026-11-19), and the answer is "it is not recoverable" --
with the data now SAYING so.**

**What was known.** The report number is chronological -- seven days a
number (43 = 19 Nov 2022, 50 = 8 Jan 2023, 211 = 25 Jan 2026) -- and
`src/komar/corpusCatalog.js`'s `dateFromReportNumber` dates a session
from it. **What was not known.** The day it lands on is the session's
WEEK, not its day: the reports are published on a weekend and the
number does not say which.

**THE PROPOSED FIX WAS REFUTED BY MEASUREMENT, and this is the
interesting part.** The idea was to date a session from its file's own
timestamp, because the 2025 series' timestamps looked like the report
dates. They are not: **they are the DOWNLOAD dates.**

| the files | their own timestamps |
|---|---|
| the reports up to 169 | all of them copied on **21 August 2025** |
| the 2025 series | 188 on 23 Aug, 189 on 25 Aug, 190 on 31 Aug, 192 on 15 Sep ... 199 on 2 Nov -- the days they were fetched |
| the 2026 series | all of them copied in one go on **10 May 2026** |

They do not run in seven-day steps (the gaps are 2, 6, 15, 6, 7, 6, 7,
8, 7, 7 days), and they agree with the interpolation to within a day
for nine of the eleven reports of the 2025 series -- which is what
"downloaded the next day" looks like -- and six days late for 188. So
dating a session from its file's timestamp would have put report 188
six days late.

**WHY THE DAY IS NOT RECOVERABLE.** The publication day moves inside
the weekend: the reports whose own PDF chrome carries the date are a
week apart in the number and, in one case, 27 calendar days apart (211
on 25 January 2026 and 215 on 21 February 2026 -- four reports, one day
short of 28). So the day of the weekend moves between Saturday and
Sunday, and the number cannot say which.

**WHAT CHANGED.** `dateFromReportNumber` now returns the precision
**`week`**, not `day`, and the 45 report-number-dated videos carry it
(`session_date_precision = 'week'`, `session_date_source =
'report_number'`). The dates themselves are unchanged, so nothing that
scores a price moved: the outcomes are the same 153 setups at the same
59.2 %. **What the change buys is that the data no longer claims a
precision it does not have** -- and a reader can now see that a
one-week horizon measured from a report-number date carries up to three
days of uncertainty.

### The Komar market card's per-horizon mapping

**RESOLVED (2026-11-19).** The 2026-05-09 card's leader groups were
read in a different order from its theme names, so some leaders
carried the wrong theme. The leaders themselves were right.

**THE CAUSE, and it is not a per-horizon problem at all: THE ORDER THE
OCR READS IS NOT THE ORDER THE CARD IS IN.** Tesseract reads a
multi-column card LINE BY LINE across the whole width, so the card's
three "Leaders:" runs arrive interleaved:

```
Leaders: SNDK, MU,    Leaders: CIFR, HUT,    Leaders: FROG,
INTC and more.        NBIS and more.        DDOG, TWLO and more.
```

and the text parser -- which walks the text in the order it arrives --
mixed the columns: "Semis" got the "Data centers" leaders, and
"Software" got the tail of both of its neighbours.

**THE FIX: READ THE GROUPS BY POSITION.** The "Leaders:" word is the
ANCHOR of a column, and every leader word belongs to it -- the NEAREST
anchor when it is within twelve pixels, and otherwise the last anchor
before it. The nearest rule matters because a wrapped tail can sit a
pixel LEFT of its own anchor: the 2026-03-14 card's "AMPX," is at x 326
and its "Leaders:" label is at x 327, and the "last anchor before it"
rule would hand the tail to the PREVIOUS column.

And the token is cleaned before the shape test: the card prints a
dollar sign before some tickers and a comma after them ("Leaders:
$GEV, $AR"), and a trailing LOWERCASE letter is the OCR's own noise --
the 2026-03-14 card's "AAOI" reads as "AAOIl", and a ticker is
uppercase, so the lowercase letter goes before the shape test (which
would otherwise reject the word before the lexicon ever sees it).

The theme names are matched to the groups by position too (the title is
centred in its box, so the title is the NEAREST one -- a different
rule from the leaders', which are left-aligned).

**MEASURED against the pixels** (the card was read by eye and the
reader's output compared with it):

| the card | the theme and its leaders |
|---|---|
| 2026-05-09 | Semis: SNDK, MU, INTC -- Data centers: CIFR, HUT, NBIS -- Software: FROG, DDOG, TWLO |
| 2025-01-25 | Energy: GEV, AR, VST, AROC, KGS -- Software: VERX, INTA, GLBE, RBRK -- Datacenter: AVGO, CRDO, VRT, CLS -- Chips: SMTC, NVMI |

Both are now **exactly** what the card shows.

**AND THE LEADERS ARE THE CORPUS'S OWN HOLDINGS**, so the lexicon is
the arbiter: a leader the lexicon does not know is the OCR's noise.
The 2025 card's dotted borders read as "L" and "AL", and they are the
ONLY two of the corpus's 57 card leaders that the lexicon does not
know.

### The Komar 2025 card's theme grouping

**RESOLVED (2026-11-19), and it was two defects, not one.**

1. **THE GROUP BOUNDARIES** were the same interleaving defect as
   above, and are fixed by the column rule.
2. **THE THEME NAMES COULD NOT BE READ AT ALL**, because the 2025
   card draws its four theme boxes with a **DOTTED border in the same
   colour as the titles**. The accent search found the borders as well
   as the titles -- 32 boxes for four titles -- and the names that came
   out were "welwg," and "{i Datacenter || Chips".

   **The discriminator is the ROWS, not the density.** A title has ink
   on every row (it is glyphs) and a dotted border has empty rows
   between its dots. The density does NOT separate them: the 2025
   titles are thin strokes in a wide box (an ink ratio of 0.035 to
   0.070) while a one-pixel fragment of a dotted border has a ratio of
   1.0. A box that is too small for a word is not a title either (the
   titles are 22 px tall and the shortest is 38 px wide).

   And where the accent ink cannot be trusted, the names are read from
   the OCR's own words: the title is the topmost word-looking token in
   the column, above the "Leaders:" label (the descriptions are below
   it, and the dotted borders read as "|" and "~~", which are not
   words). **And the names SHARE A ROW** -- they are printed side by
   side -- so a candidate well below the others is not a title but the
   description's first word, and it is refused.

   **AND THE TITLE IS READ AS PURE INK.** The card prints the titles
   in orange ON a dark green chart photograph, with a green drop
   shadow behind them, and Tesseract reading the crop as it is sees
   the shadow as part of the glyphs: a three-letter title with a thin
   "il" comes back as "0)". Read as pure ink -- the accent pixels
   black, everything else white -- the same crop reads "Oil" (which is
   what the 2026-03-14 card's first theme is called), and the 2025
   card's dim gold titles are read from the crop as they are.

### The daily updates' charts -- USEFUL, and a better source than the panel (2026-11-19)

**The question was whether the daily updates' charts can be useful, and
the answer is yes -- and they are a better path to a dated market read
than the panel video frames are.**

**WHAT THE CORPUS'S DAILY UPDATES ACTUALLY HOLD.** Seven "post"
documents (the daily and mid-week updates), each with one or two kinds
of image:

| the era | what it carries | can the OCR read it? |
|---|---|---|
| 2025-06-25, 2025-08-20 | a full TradingView WORKSPACE at 3156x2200 or 4353x2682 -- four panels (the Nasdaq Composite with the author's own analysis boxes, the Net Highs/Lows of All US Stocks, the % of stocks above MA 200, and the NDX distance to MA 50) | **YES** -- the boxes are clear sans-serif at 25-40 px |
| 2025-04-08, 2026-04-15, 2026-04-29 | the market CARD (already read) and a TradingView WATCHLIST SCREENSHOT -- one chart per ticker, each with the change, the change percentage and the price | **YES** -- the ticker labels are THIRTY pixels tall |
| 2026-05-05, 2026-05-06 | the market CARD only | not a watchlist |

**MEASURED, ON THE 2025 WORKSPACE (the 4353x2682 chart of the
2025-08-20 update):** the OCR reads the author's own boxes straight
out of the pixels --

```
Summary:      Choppy Market!  50% invested  10% position size
Mid/short-term Trends:  NASDAQ  S&P 500  Russell 2000
```

-- and the chart carries, in words, what the market cards do not: the
breadth facts ("New net highs", "Stocks above MA 200 increase"), the
MMTS and IBD statistics, a rally-type table (whipsaws, small losses or
gains, money makers, life changers), the trend lengths ("4 trading
days", "43 trading days", "81 trading days"), the net highs and lows
(51,011), the ADRN reading (0.87) and the annotations ("Reduced
exposure", "Increased exposure", "Buy signal 25 April", "Divergence!",
"Stretched index").

### The watchlist screenshot reader -- BUILT AND MEASURED (2026-11-19)

**`src/komar/watchlistReader.js` reads all three of the corpus's
watchlist screenshots: 30 of 30 panes, 30 of 30 tickers, 28 of 30
changes, every sign right.** It is the first reader of the three
(readers, transcripts, screenshots) that the corpus can actually feed.

| | |
|---|---|
| the reader | `src/komar/watchlistReader.js` |
| the three frames, pinned | `test/fixtures/komar_watchlist/20250408.png`, `20260415.png`, `20260429.png` |
| the rows they show | `test/fixtures/komar_watchlist/expectations.json` -- read off the frames BY EYE, and four of the first readings then corrected against the pixels |
| the test that scores it | `test/komarWatchlist.test.js` |
| the tool | `tools/extractKomarWatchlist.js` (`npm run komar:watchlist`) |
| the table | `komar_watchlist` |

**THE PANE GRID IS THE FINDING, and a reader that did not know it
would lose a third of the corpus.** The screens are 1080 pixels wide
with **270x150** panes, and **a row that does not fill the width is
CENTRED** -- one pane at 405 (the 2026-04-29 frame's last row), two at
270 and 540 (the 2026-04-15 frame's last row), three at 135, 405 and
675 (the 2025-04-08 frame's last row, which is LEFT-aligned at 135).
So the origins are a **half-pane grid**, and the four-column grid
assumption loses exactly those rows.

**THE SHAPE GUARD, because the market CARD is 1080 wide too.** The
card carries a "(46.04 -0.19%)" of its own, so a percentage test takes
it for a header -- measured: without the guard the 2026-05-05 card
publishes a phantom `N28`. The separator is the **height**: a
screenshot shows whole panes, so its height is a multiple of 150
(306, 451, 604) against 692 for the card. The full-screen workspaces
are excluded by the width (4353 / 4 = 1088 pixels to a pane).

**THE FOUR RULES THE READINGS COME FROM, each measured:**

1. **The change percentage is the pane marker and the sign comes from
   the ink.** The header prints the sign on the change and none on the
   percentage, and the printed minus is one pixel wide -- so the sign
   is the sum of how far the header's pixels lean green or red (the
   background (35, 38, 47) leans neither way and contributes
   nothing).
2. **The change is read at three scales and the majority wins**, because
   the same pixels read `+1.21 (12.17%)` at one scale and
   `+1.21 (12.27%)` at another. This is the project's own rule (see
   `tools/resolveUndatedDates.js`): two independent readings have to
   agree before anything is written.
3. **A ticker the market does not know is read a second time at a
   narrower width**, and the market's own list picks between them.
   The 52-pixel crop reads a four-letter ticker whole but can pick up
   the date beside it -- `TER` came back as `TERE` -- and `TER` is
   what the 40-pixel crop reads.
4. **The screens are inverted first.** The screenshots are dark, and
   Tesseract reads dark-on-light.

**WHAT IS STILL WRONG, and it is two numbers.** Both are the printed
"+" being read as a "4":

| frame | pane | the truth | what is read | why the majority does not catch it |
|---|---|---|---|---|
| 20260429 | SGML | `+0.49 (2.38%)` | `40.49 (2.38%)` | scales 3 and 4 both say 40.49, scale 6 says +0.49 |
| 20250408 | GEV | `+24.97 (2.74%)` | `424.97 (2.74%)` | scales 3 and 6 both say 424.97, scale 4 says +24.97 |

The percentage and the SIGN are right in both cases, so a market read
built on them is sound; only the price move is 10x too large. Anchoring
the crop on the change's own coloured ink (which is where the sign is
read from anyway) was measured against this and **made it worse**: the
thin sign stroke falls below the ink threshold, so the crop starts
inside the number and reads `10.49`, `17.42`, `92` -- it is recorded
here so it is not re-attempted.

**THE WHOLE-SCREEN READING IS NOT USED AT ALL**, and that is the design
rather than an oversight: at 2x the 2025-04-08 frame's first change
comes back as the word "he" (the header merged with the chart under
it), and at 1x the tickers come back mangled (`AER` for AEHR). Each
cell is read on its own instead.

**AND ONE FINDING WORTH RECORDING.** The document the catalog calls
`komar_doc_post_20250408` is the file `komar_20260408.pdf` -- its
FILENAME says 2026-04-08 and its CONTENT says 2025-04-08. The corpus's
own rule (the document's content wins, the filename's date is kept
beside it and the row is marked) is already in place ✓, and this is
the first document where the two disagree by a YEAR.

### The panel reader, iteration 3 -- MEASURED ON TWELVE SESSIONS (2026-11-19)

**The reader has been measured on a SET now, not on one frame.** The
measurement set is twelve sessions -- one per dated session, spanning
19 months, THREE resolutions (1920x1080, 1280x720 and 2560x1440), both
panel layouts (the four-column watchlist of the 2022-2025 era and the
three-column table of the later one) and both MODES (a watchlist of
indices and ETFs, and a portfolio of his holdings).

| | |
|---|---|
| the frames | `test/fixtures/komar_panel/sessions/` (12 PNGs, 6.6 MB, with a manifest) |
| the rows they show | `test/fixtures/komar_panel/sessions.json` -- read off the frames BY EYE |
| the tool that scores the reader | `tools/measureKomarPanel.js` |
| the frames' provenance | `tools/extractKomarPanels.js` (samples the sessions and finds the frames where the panel is on screen), `tools/pickKomarPanels.js` (one frame per session) and `tools/pinKomarPanels.js` (copies them into the fixtures) |

**THE SCORE, and it says the reader is NOT ready.**

| | the era fixtures (3 frames) | the measurement set (12 sessions) |
|---|---|---|
| the symbols, in order | 14 / 52 (26.9 %) | **49 / 182 (26.9 %)** |
| the symbols, found | 42 / 52 (80.8 %) | **109 / 182 (59.9 %)** |

**And the set says exactly WHY, which is the value of measuring on a
set rather than on one frame.**

1. **THE 720p PANELS ARE AT THE OCR'S LIMIT.** The 2025 series' videos
   are 1280x720 and the panel's text is about 8 px tall. Tesseract
   reads "EURU" as "TURU" or "FURL" and "ETHUS" as "THUS" -- at every
   scale from 4x to 12x, and with the region inverted as well as it is.
   A human reads the same pixels without trouble. So **the positions
   series can be built from the 1080p and 1440p sessions and NOT from
   the 720p ones** -- and that is a property of the CORPUS, not of the
   reader.
2. **THE REGION READ HAS TO BE IN PIECES.** Tesseract's page analysis
   needs a reasonable ASPECT RATIO and the panel's region is a tall
   narrow strip (307x972 at 1080p). On the whole image the reader gets
   the WORDS but not the GLYPHS -- the header comes back as "ia",
   "Sy", "yO" for "Symbol", "Last", "Chg%" -- and the header cannot be
   found at all, so the reader has no columns and reads no rows. Read
   in pieces of a roughly square size, the same pixels come back as
   "Symbo", "Last", "Chg" and "EURU". **But the piece boundaries split
   the rows**, and a split row is a lost row: with the pieces the era C
   fixture fell from 14 of 14 symbols to 9 of 14, and the measurement
   set from 49 of 182 to 20. The pieces have to OVERLAP, and even with
   the overlap the set stayed below the single-read score. **This is the
   next thing to fix, and it is a real one: the 720p frames need the
   pieces and the 1080p frames are better without them.**
3. **THE ICON IS A BLOB, AND THE CUT HAS TO BE PER ROW.** The icon is
   ink at the row's left and the symbol is a separate blob after it:
   measured on the 2026-05-09 frame, the icon ends at x 1652 and the
   symbol starts at 1672. Cutting the symbol cell at the end of the
   ink blob makes the modern three-column frames EXACT -- the
   2026-05-09 portfolio goes from 0 of 7 to **7 of 7** and the
   2025-10 portfolio from 6 of 21 to **17 of 21**. But in the
   four-column era the icon and the symbol TOUCH, the blob runs into
   the symbol, and the cut takes the symbol with it: the era A fixture
   fell from 16 symbols found to 7. So the cut needs to know where the
   ICON ends and not merely where the ink ends.
4. **THE HEADER HAS TO BE MATCHED BY NEAR, NOT BY EQUAL.** The panel's
   labels are 9 px tall in the 720p frames and Tesseract drops a
   letter ("Symbo" for "Symbol"), so an exact match finds no header
   at all. The columns have to be matched by an edit distance of one
   or two, which is what the 720p frames need.

**So the reader stays UNWIRED, and the panel tables, the position
events (5b) and the dashboard's Positions tab wait.** The measurement
is now an instrument that every change to the reader moves, and the
next three changes are the three defects above -- in the order: the
icon's extent (the biggest single win, and it is already exact on the
modern frames), then the overlapping pieces, then the near header
match.

**WHAT THE MARKETSMITH SCREENS ARE, since they are in scope.** The
2022-2023 sessions ALSO show MarketSmith screens -- a second widget in
a different place, with a bottom table -- and the panel this reader
reads is the TradingView one at the right edge. So the MarketSmith
screens are a SEPARATE reading (a different position, a different
layout), not a fix to this one, and they are not in the measurement
set.

### The panel reader, iteration 3 (the earlier notes)

**What is known.** The reader finds the region, the header, the columns
and the rows, and reads the prices mostly right. **What is wrong.**
(a) the symbol column carries the row's ICON -- the panel draws a small
coloured blob before every symbol and Tesseract reads some of them as
letters, so the POWL row reads "VPOWLE"; (b) the W/L sign is taken
from a single sampled pixel of the cell's fill, which is sometimes not
where the sign is; (c) the detail card under the table is read as rows
on some frames.

**What iteration 2 fixed.** The icon is now taken out of the picture
before the OCR sees it -- it is COLOURED and the text is not, so every
saturated pixel in the symbol column is whitened (only that column:
the W/L numbers are coloured too). That fixed the rows whose icon read
as a letter (DELL, TER, POWL, MU, RKLB, AMLX). And the W/L sign is
now the MAJORITY of the cell's coloured pixels, counted over the whole
cell, instead of one sampled pixel in the middle.

**IT IS NOW MEASURED, which it never was.** `tools/measureKomarPanel.js`
scores the reader against a PINNED expectation --
`test/fixtures/komar_panel/expectations.json` holds the rows read off
the three frames' own pixels, one frame per era, so every reading of
the reader can be compared with the panel itself instead of with a
report by hand.

| | before | now |
|---|---|---|
| the symbols, in order | 7 / 52 (13.5 %) | **14 / 52 (26.9 %)** |
| the symbols, FOUND (as a set) | — | **42 / 52 (80.8 %)** |
| the prices | — | 59 / 98 (60.2 %) |
| the **portfolio** frame (2026) | 4 / 14 | **14 / 14 in order, exactly** |
| the 2022 watchlist frame | 2 / 20 | 16 / 20 found |
| the 2025 watchlist frame | 9 / 18 | 12 / 18 found |

**The in-order score is 0 on the two watchlist frames for ONE reason:
their first row is lost to a merged band, and a missing first row
shifts every row after it.** The set score is the honest one for them
(16/20 and 12/18).

**The fixes, in the order the defects bite.**

1. **REMOVE THE ICON, DON'T CUT THE CELL.** The colour mask only takes
   out the saturated part of the blob; a partly-saturated edge still
   reads as a letter, and the US flag in front of "US02" reads as "C",
   the "S" logo in front of DIA as "S", the "i" in front of IWN as "I".
   A CUT is worse: the cut lands on the icon's antialiased edge, and
   one pixel of pale blue is enough for Tesseract to read a letter out
   of it -- the MU row reads "CMU" when the cell starts at the last
   saturated pixel and "MU" when it starts one pixel later. So the icon
   is PAINTED WHITE in the OCR's own box for it.
2. **THE CHART'S PRICE AXIS WAS BRIDGING THE GAP.** The detail card
   under the table was read as rows, and the gap test never saw it,
   because the chart's price-axis labels sit at the crop's left edge,
   spaced about a pitch apart, and they fill the gap between the table
   and the card. Only the panel's own columns are read now.
3. **A GROUP HEADER IS A ROW WITH NO NUMBERS.** The group headers are
   the author's OWN theme names -- MEDICAL, DRONES, SEMICONDUCTORS,
   OIL / GAS / COAL -- and they are not an enumerable set, so a list of
   them cannot work. And a row whose numbers could not be read is still
   a POSITION when the lexicon knows its symbol.
4. **THE PANEL'S TRAILING DOT IS NOT PART OF THE TICKER.** The panel
   draws a small dot after every symbol and Tesseract reads it as a
   final "e" -- "DIAe", "HYGe", "UVXYe" -- so it is stripped. A ticker
   that really ends in "e" is kept when the lexicon knows it ("LITE").
5. **MEASURE THE READER, DO NOT ASSUME IT.** Done: the expectation is
   pinned, the tool scores it, and the score is reported here rather
   than quoted from memory.

**AND TWO THINGS THE MEASUREMENT FOUND, which are not the reader's
fault.**

* **TESSERACT'S READING OF THE SAME PIXELS DEPENDS ON WHAT THE
  SHARED WORKER READ BEFORE IT.** Measured on the 2026-04-25 frame: the
  same region read twice in one process gave "nue" and "MU" for the
  same ticker. The project's own Revere notes say the same about that
  path. So a panel reading is a measurement of the pixels AND of the
  order they were read in, and a run that scores differently from the
  one recorded here is not necessarily a worse reader. **This is also
  why the score is REPORTED and not ASSERTED** in
  `test/manual/komarPanelReader.test.js`.
* **THE ICONS ARE TALLER THAN THE TEXT**, so a cluster of everything
  chains a row to the row below it (a 16 px logo against a 10 px
  ticker), and two rows read as one.

**Why it is still UNWIRED.** A wrong holding is worse than a missing
one. The reader is now **exact on the portfolio frame** -- the "My
Portfolio" table, which is what the position series (5b) needs -- and
it is exact enough to be worth wiring, but:

* **one pinned frame is not a measurement of a reader.** The portfolio
  frame is one video's one moment. The corpus has 40+ "My Portfolio"
  videos, and the frame set wants one per month before the reader is
  trusted with a series of positions.
* **the watchlist frames are still wrong** (16/20 and 12/18 found), and
  the watchlist is the other half of the panel.
* the two card rows at the bottom of the 2022 frame ("HG1", "Q.1285")
  are still read as rows: the card there follows the table closely
  enough that the gap test does not catch it.

So the panel tables, the position events (5b) and the dashboard's
Positions tab stay unwired, and the work that would wire them is:
(1) pin a portfolio frame per month and measure the reader on the set;
(2) bound the detail card by the table's own prices rather than by a
gap; (3) fix the watchlist frames' first row.

The QMG project took many rounds on its equivalent
(`src/video/positionTableScan.js` and the "column gate" work in
AGENTS.md), so this is the expected cost of the work.

## Everywhere else

### The Deepgram provider splits a ticker across a boundary

**RESOLVED for the Komar corpus, 2026-11-18 -- and the cause is not what
it was assumed to be.**

**What the artifact is.** A ticker the provider wrote in two pieces:
"I bought into DF," | "DV. I see a lot of positive momentum". The
holding is then invisible to the extractor, because neither half is a
ticker.

**How it was measured.** The stored transcripts keep the segments'
TEXTS and not the provider's WORD LIST, and a shape test over the texts
cannot tell a split from a sentence -- "the previous segment ends with
a letter, the next begins with a letter, and the previous's last word
is two characters or fewer" matches **21 %** of the corpus's 5.9
million boundaries, and every example is an ordinary sentence. So
twenty Komar videos were re-transcribed with the provider's word list
kept (`tools/fetchKomarTranscripts.js --keep-words`, $1.94, 251.8
minutes) and the corpus was then checked boundary by boundary against
the corpus's own lexicon: a ticker is BROKEN when its two halves fall
on either side of a boundary and neither half is a ticker itself.

**What the measurement said.** Over the 116 transcripts' 50,884
boundaries: **3 candidates, 1 real.** The other two are ordinary
speech -- the phrase "go go", and a clean sentence boundary after "QS"
-- and both are rejected by the repair's guards.

**The cause, and it is NOT the endpointing.** The provider's word list
carries "df" and "dv" as **two words**, and the boundary falls between
them: the provider's TOKENISATION broke the ticker (it wrote the
punctuation too), and its endpointing never cut a word in 2,863
measured boundaries. **So a join in the shared segmenter could never
have repaired it** -- there is no whole word to recover.

**What was shipped.** A lexicon-driven join in the Komar's OWN module,
`src/komar/transcriptRepair.js`: the joined form has to BE a ticker the
corpus knows, and neither half may be a ticker itself. Measured on the
whole corpus with the same command: **212 -> 213 setups**, one ticker
rejoined (`DF | DV -> DFDV` in `komar_vid_weekend_192_part_02`), **no
setup lost, none invented**. The shared normaliser is untouched, and
the stored transcript is untouched -- the repair is what the extractor
reads, and the repaired ticker is in the evidence.

**What was measured and REJECTED: the provider's TERMS parameter.**
Deepgram can be told the terms to expect (`keywords` on nova-2,
`keyterm` on nova-3 -- its own error message says which), and it WORKS:
with the corpus's own tickers sent, the provider wrote "dfdv" as one
word and the transcript reads "I bought into DFDV."

It is rejected because a terms list made of TICKERS is a
**hallucination machine** -- tickers ARE ordinary words. Measured on
the same video, the hint replaced ordinary speech with corpus tickers:

| the audio | with the terms |
|---|---|
| "I got stopped out" | "I got stopped **OUST**" |
| "right now in the not not so much momentum" | "right now **INVZ** the not not so much momentum" |
| "this explosive verb" | "this explosive **VERB**" |
| "a new source of into" | "a new source of **INTA**" |
| "I don't think that stock will go to the moon" | "I don't think that **OUST** stock will go to the moon" |

Every one of those is a ticker the corpus really trades (OUST, INVZ,
VERB and INTA are all in `config/ticker_lexicon_komar.csv`), so the
error is invisible -- and a wrong holding is worse than a missing one.
The mechanism is nonetheless in the shared client
(`requestKeyterms()` in `src/transcript/deepgramClient.js`), additive
and OFF by default, so a source that wants it can have it.

**What is left for the other corpora.** Sevcik, T3Live and Benzinga
carry the same artifact, and the repair is written against the Komar's
lexicon -- a source-local rule for a source-local vocabulary. Each
corpus needs its own, and each needs its own measurement. **The
generalisation is now possible, though:** the mechanism (a join across
a boundary when the two halves form a known ticker) is shared, and the
DECISION (which vocabulary, which guards) is the source's -- the same
shape as every other source-specific parameter in the project.

**How to measure it for a source.** Re-transcribe a sample with
`--keep-words` (the word list is the evidence), check the corpus
against its own lexicon boundary by boundary, and then measure the
repair on the same corpus with the same command.

**A RE-FETCH IS NOT THE SAME FILE, and here it is measured.** Twenty
videos were re-transcribed for the word lists, and **16 of the 116
transcripts came back with a different TEXT** -- the same words, cut
into different segments ("Terradyne will have earnings here," +
"Tuesday." against "Terradyne will have earnings here, Tuesday."). So
Deepgram's **endpointing is not bit-deterministic between requests**,
and a re-fetch is not a no-op on the corpus. The 20 transcripts were
therefore **restored** to the committed versions and the analysis
re-derived from those, because the re-transcription's purpose was the
MEASUREMENT and not a new reading: the committed record stays the
record, and the numbers above are the ones the committed corpus gives
(**212 -> 213 setups** on exactly the same command). The word lists --
the evidence -- stay in the working folder, untracked.

## The Discord traders

### The 2026-04-15 treemap -- READ, and the premise REFUTED (2026-11-27)

**RESOLVED, and the open question is answered in the opposite direction
to the one the plan assumed.**

**WHAT WAS ASSUMED.** The plan was to read the main book's card grid and
"take the percentage in the same column BELOW the ticker" as the
position's WEIGHT, and then check the weights against the table's own
total. **The percentage is not the weight.** It is the DAILY CHANGE.

**THE ARITHMETIC THAT SETTLES IT, and it is the screenshot's own.**

1. **A WEIGHT CAN NEVER BE NEGATIVE, and three leaves carry a negative
   percentage** -- MC.PA at -0.28 %, EQT at -0.07 %, NDIA.LSE at -0.11 %.
   A size cannot be negative, and a daily change can.
2. **The header says what the two encodings are**: "Denni zmena ·
   velikost = hodnota v portfoliu" -- the DAILY CHANGE is what is
   PRINTED, and the size is what is DRAWN. The leaf's AREA is its value
   in the portfolio, and the value is not printed anywhere.
3. **The screenshot's own arithmetic agrees**: the sector's aggregate
   (+1.04 % for Technologie) is close to the MEAN of its leaves'
   changes, and nowhere near their SUM.

**SO THE WEIGHT IS NOT PRINTED IN THIS PICTURE, and the reader does not
publish one.** Publishing the daily change as the weight would be a
wrong number in a portfolio record, and a weight is what a portfolio
record is for. The 65 rows the treemap contributes carry the daily
change and the sector, and their weight is NULL.

**WHAT WAS ALSO FOUND, and it was a live defect: THE OCR LOSES THE
BROKER'S MINUS SIGN.** The minus is a thin dash, and the OCR dropped it
on **12 of the 64 leaves** -- JPM's tile reads "-1.71 %" and the OCR
read "+1.71 %", MU's reads "-2.70 %" and the OCR read "+2.70 %". And the
OTHER OCR pass lost the SAME minus on the SAME leaves, so their
agreement was not evidence.

**THE SIGN IS THEREFORE READ FROM THE LEAF'S COLOUR**, which is the
project's own pattern (the O'Connell reader takes the sign from the
colour; the XTB reader takes it from the prices). The treemap's scale
is "-4 % ... +4 %", red for a loss and green for a gain, and the
percentage is WHITE TEXT on that background. Measured on the
screenshot:

| the tile | its colour |
|---|---|
| green | rgb(26, 65, 45) |
| red | rgb(75, 31, 32) |
| flat | rgb(45, 51, 59) |

A SATURATED tile settles the sign and a FLAT one does not: the leaves
whose change is under about a tenth of a point are drawn flat, and for
those the glyph is the only witness. The reader says which it used, in
`sign_source`.

**AND THE PICTURE WAS NOT EVEN READ IN FULL.** The pipeline's OCR
region is the chart-stream overlay -- the LEFT 70 % of the image -- and
this is a full-width treemap, so 30 % of the book had never been looked
at. The treemap is now OCR'd WHOLE, which costs about six minutes a
picture, so it runs only for a picture wider than 2000 px: the treemap
is 2133, the XTB table is 1387, the "My Holdings" pictures are
1846-1861, and the ticker strips are 201-992.

**WHAT WAS READ.** 65 of the screenshot's 96 positions, across 7 of the
13 sector labels, with the daily change of each. The six sector labels
the OCR missed are the cost of the misses: a leaf whose GROUP's label was
not read is assigned to the nearest group above it, and its sector is
then wrong. The coverage is published with the reading.

**AND THE CROSS-CHECK, which is the real test of the reader.** The
screenshot says WHAT HE HELD; the trade channel says WHAT HE TRADED.
Bounded to the screenshot's own date: the screenshot holds 63 names, the
trade channel named 62 on or before that date, and **29 are in both**.
So the reader finds real tickers -- names an INDEPENDENT source also
names -- and the two sources overlap on less than half of each other,
which is what two views of a book that changed over four years look
like.

**WHAT IS STILL NOT READ.** The 2025-12-22 "My Holdings" pictures (six
of them) are a THIRD format -- a ticker grid with a separate sector
table -- and they have no reader yet. The XTB reader finds their header
and reports "header without VAHA", which is right: there is no weight
column in them either.

### The other screenshot formats are not read (2026-11-26)

**WHAT IS KNOWN.** The portfolio channel of plechac carries **14**
attachments, and exactly ONE of them is read: the XTB `POZICE` table of
2026-05-22, which the reader takes whole -- 15 positions, and the
weights add up to the table's own 100 %.

The other thirteen are three formats, and none of them is read:

| the image | what it is | what is known about it |
|---|---|---|
| 2026-04-15, 2133x1128 | the MAIN book as a grid of CARDS: a ticker, a percentage and the company name, laid out in a masonry grid | the percentage sits in the SAME column as the ticker, just below it, so the pair is recoverable; the grid is 5-6 columns wide |
| 2025-12-22, 6 images | **READ (2026-11-28): one "My Holdings" TREEMAP and FIVE scroll positions of the XTB "Overview" table** | the Overview table carries the weight, in a column called "Allocation" -- the same column the Czech table calls "VAHA" |
| 2023-05-08, 4 images | four narrow STRIPS of tickers (206x767, 204x701, 201x259, 992x20) | the tickers only; there is no weight |
| 2023-05-08, one image | a PERFORMANCE CHART ("VYKONNOST VS SPY") | not a position list at all |

**WHAT IS NOT KNOWN.** Whether the weights in the 2026-04-15 cards are
the `velikost` (size) column the header names, or something else. The
header row reads `Sektory | Regiony | Denni zmena | velikost | hodnota V
portfoliu`, and the card percentages sit at x 2321-2570 -- which is
where the `velikost` column would be -- but the header and the cards are
laid out on DIFFERENT axes, and nothing has confirmed that a card's
percentage is the book's weight.

**WHAT A FIX WOULD LOOK LIKE.** A second reader beside
`readPositionsTable`: find the ticker cells, take the percentage in the
same column BELOW it, and check the weights against the table's own
total -- the same check the XTB reader uses, and the same way a reading
that does not add up is reported rather than published. The 2026-04-15
image is the one worth building it for: it is the MAIN book, and it has
about 96 holdings.

**THE IMAGES ARE THE EVIDENCE AND THEY ARE NOT IN GIT.** The media
directory is gitignored (as every other Discord media here), and
Discord's own attachment URLs expire -- so the images on this machine
are the only copy. The reader is therefore pinned by a FROZEN fixture of
the OCR words (`test/fixtures/plechac_portfolio/`), not by a live image,
and a new reader should be pinned the same way.

### The 2025-12-22 "Overview" table -- READ, and it carries the WEIGHT (2026-11-28)

**THE PREMISE WAS WRONG, AND THE PICTURES SAY SO.** The open question was
"the tickers are in a grid with no weight column; the weight is not in
these images". **It is the XTB "Overview" table and the weight IS there**,
in a column called "Allocation" -- the same column the Czech "POZICE"
table calls "VAHA". The six pictures are ONE treemap and FIVE
consecutive scroll positions of the Overview table, and the table says
"1-86 of 86".

**MEASURED: 83 HOLDINGS, EVERY ONE WITH A WEIGHT, AND THE BOOK ADDS
UP.** The weights sum to **98.27 %**, which is the broker's own book
exactly (the missing 1.57 % is the "$ Cash" row). 83 holdings out of
84 LINES, because two of them are two exchange lines of one company --
and their weights ADD, which is what closes the gap.

**AND THE SOURCE'S OWN VOCABULARY IS WHAT TELLS THE TWO LINES APART.**
The Overview view's OCR drops the dot, so the Amsterdam line of ASML is
read "ASMLAS"; the vocabulary's keys ARE the broker's spellings, so
"ASML.AS" and "ASML" are two LINES while "ASMLAS" resolves to
"ASML.AS" and is the same line read badly.

**AND THE OVERVIEW VIEW'S OCR LOSES THE DOT**, so "IDUSL" has to find
its way back to IDUS.L -- which is what the source's own vocabulary is
for, and why the lookup also tries a dot-insensitive match.

**AND THE HEADER IS SPLIT OVER TWO BANDS, and the table is in ENGLISH.**
The Czech table puts every column name on one line, but the English
"Overview" view puts "Ticker" on the line BELOW the others, so the
columns are found in the band above the ticker band too. The column
names are English: "Allocation" is the weight, "Last" the price, "Avg
Cost" the average cost, and "Unr. Gain %" the unrealised gain.

**AND THE DAILY CHANGE GETS ITS OWN COLUMN, because it is a different
fact.** The English table has "1D Gain %" -- today's change, which is
exactly what the treemap prints -- and "Unr. Gain %", the unrealised
gain. **A reader that took the wrong one would publish a CHANGE as a
weight**, so "1D Gain %" is its own column and the weight is
"Allocation" and nothing else.

**THE CUT-OFF ROW IS THE TRAP, and it is caught two ways.** Each
picture's LAST row is cut off by the image edge, and the OCR reads that
row's numbers without their points: "0.78 %" comes back as "78 %" and
"1.61 %" as "161 %". So:

1. **A weight outside (0, 100] is IMPOSSIBLE** -- a weight is a share
   of the book -- and the row is REJECTED. That catches the "161".
2. **The column is SORTED**, so a weight that breaks the order is a
   misread, and it is repaired by dividing it by 100 -- but ONLY when
   that restores the order. That catches the "78", which is inside the
   bound and would otherwise have been published.

The repaired row is the one the NEXT picture has right, so the repair is
confirmed by a second reading of the same holding.

**AND THE PICTURES ARE MERGED INTO ONE BOOK.** A message can carry
several pictures of the same book, and they do not all carry the same
facts: the treemap reads the change and no weight, and the table reads
the weight. So the pictures of a message are read together and merged
by ticker, and a holding a picture with a weight read wins over the
same holding read by a picture without one.

**AND THREE SYMBOLS ARE STILL THE BROKER'S OWN SPELLING**, because the
probe could not reach them on 2026-11-28 and a symbol the market does
not have must not be invented: `RZUS.LSE`, `FLXL.DE` and `IDU.L`. They
are three of the 83 holdings, and the other 80 carry a market symbol.

**AND THE 0.31 % GAP IS CLOSED (2026-11-28).** The two lines of one
holding now add, and the book reads 98.27 % -- the broker's own number.
The discriminator is the source's own vocabulary: its keys are the
broker's spellings, so "ASML.AS" and "ASML" are two LINES while
"ASMLAS" (the Amsterdam line with the dot dropped by the OCR) resolves
to "ASML.AS" and is the same line read badly. The scroll overlap is the
same line read twice, and it does not add.

### HariSeldon's option legs, and the head-to-head table -- DONE (2026-11-28)

**BOTH ARE MEASURED AND RECORDED** -- in AGENTS.md / CLAUDE.md:

- **the option legs**: 521 directional opens, 1w 44.5 % against 47.0 %
  for the same call on SPY (edge -2.5 pp), 1m 49.0 % against 43.7 %
  (edge +5.3 pp), assessment `possible_negative_edge` at both horizons.
  An option leg is scored as a directional claim on the UNDERLYING, and
  the option's own price is not chained into an episode.
- **the head-to-head**: nine sources, one table, and the honest headline
  is that none of them beats the index. Every source is also re-scored
  under every executable entry rule, and the edge is negative or
  indistinguishable from zero under all of them -- so the finding is a
  fact about the sources and not an artefact of the entry price.

### The Overview view's misreads -- READ, and the source has its own table (2026-11-28)

**DONE.** Five of the 2025-12-22 book's holdings were OCR misreads.
Read off the pixels -- the Overview view prints the company's name under
each ticker, so the reading can be checked against the instrument it
names -- and verified against Yahoo:

| the OCR read | the picture says | the company |
|---|---|---|
| `IQQEDE` | **IQQE.DE** | iShares MSCI Emerging Markets |
| `IOGPL` | **IOGP.L** | iShares Oil & Gas Producers UCITS ETF |
| `IDUPL` | **IDUP.L** | iShares US Property Yield UCITS ETF |
| `IDTLL` | **IDTL.L** | iShares $ Treasury UCITS ETF |
| `FLXLDE` | **FLXI.DE** | Franklin Liberty |

**AND THE SOURCE HAS ITS OWN PICTURE-READING CONFUSION TABLE**
(`config/ticker_ocr_confusions_plechac.csv`), separate from the
vocabulary: the vocabulary says what the BROKER writes and the confusion
table says what the OCR READS. It is applied only to a picture reading.

**MEASURED: 81 OF 83 HOLDINGS CARRY A SYMBOL YAHOO CAN PRICE.** The two
that do not -- `RZUS.L` (1.07 %) and `DOC1` (0.73 %) -- were read off the
pixels ("Digital Angel Corp" for DOC1) and Yahoo has no price series
for either under any spelling that was tried, so they keep the broker's
own spelling.

### The replay pools two readers, and the number was a mixture (2026-11-28)

**DONE.** The `position_table` sweep added a second reader to the
corpus, and the replay tool pooled the two -- so a date scanned once per
reader was counted as one reading contributed to by two scanners, and the
table reader's false positives counted against the chart-stream reader's
score.

**MEASURED over `data/video_scan_test/_rerun`:**

| | hits | recall | precision |
|---|---|---|---|
| the chart-stream reader alone | 431/460 | 93.7 % | **78.9 %** |
| the table reader alone | 60/64 | 93.8 % | **84.5 %** |
| **the two pooled** | 432/460 | 93.9 % | **76.3 %** |

The tool now reports each reader's own measurement with its own
denominator, and labels the pooled number as a mixture. A log whose
captures came from both readers is its own bucket.

**AND THE `rebuilt_current` ARM IS THE CHART-STREAM PARSER, ALWAYS**, so
its `position_table` rows are NOT the table reader's own reading. The
tool says so on every run.

### The `position_table` sweep -- REFUTED, and it should STOP (2026-11-28)

**DONE, and the answer is NO.** The sweep asked "does the table reader
help where the chart-stream reader fails?", and over fifteen swept dates
the table reader is worse in BOTH recall and precision:

| | hits | recall | false positives | precision |
|---|---|---|---|---|
| the chart-stream reader | **116/126** | **92.1 %** | **5** | **95.9 %** |
| the table reader | 108/126 | 85.7 % | 16 | 87.1 % |

**AND ON THE DATES THE SWEEP WAS AIMED AT** -- the chart-stream
reader's weakest -- the table reader is equal or worse on EVERY ONE
(20220126 0/2 against 1/2, 20220131 0/1 with ELEVEN false positives
against one, 20220405 12/16 against 13/16, 20220406 6/8 against 7/8,
20221117 4/6 against 5/6, 20231215 10/12 against 11/12).

**AND TWO OF ITS SIXTEEN FALSE POSITIVES ARE ALREADY FIXED** -- the
`NFU` on 20220606 and 20220607 is the date-scoped layout alias, which
the table reader applies now. So the shipped reader reads 14, and still
loses to the chart-stream reader's 5.

**SO THE REMAINING 48-DATE SWEEP SHOULD NOT BE RUN.** Ten to sixteen
hours of EasyOCR on a hypothesis refuted on fifteen dates, for a reader
that costs two OCR passes a frame.

**WHAT THE SWEEP DID FIND, and it is worth more than the sweep:** the
`bottom_most` prior published his WATCHLIST on 20220131, and the
header's own word "SYM" leaked in as a holding. The fix -- a table with
no readable title AND no TICKER or POSITIONS heading is not published
at all -- is still to be MEASURED on the 2022-era floating-panel dates,
where the table IS the positions table and its heading is the only
thing that says so.

`20220421` hit the 40-minute timeout; the process tree was killed and
no orphans were left.

### The `bottom_most` prior published a WATCHLIST (measured 2026-11-28)

**WHAT HAPPENED.** The `position_table` sweep of 20220131 -- the
worst-recall date in the corpus, where the chart-stream reader reads 0 of
1 -- found a NINETEEN-row table and published ten names from it: AAPL,
AVGO, ENPH, HOOD, NFLX, PINS, PLUG, SPOT, SYM and TER. **None of them
is a holding.** The ground truth says that video showed ONE holding
(TQQQ), and the table the reader found is his WATCHLIST.

**SO IT IS THE DOCUMENTED FAILURE MODE, MEASURED.** The reader's own
documentation says that a table is published when it was "positively
identified as the positions table", and that the `bottom_most`
discriminator is "only a positional tie-break, not an identification" --
and that it "can carry false positives". This is that, on a real date:
the prior picked the watchlist and published it, because the frame had
no readable "POSITIONS" title to identify the right table.

**AND THE HEADER'S OWN WORD LEAKED IN.** "SYM" is the table's column
heading and it was decoded as a holding. A cell that is the table's own
header is not a holding, and the reader does not check.

**WHAT THE FIX IS, and it is not a guess.** The `title` discriminator
-- the one that reads "POSITIONS" out of the table's own title -- is
already preferred over the prior, and the merge now prefers an
identified table over a prior (measured: 20230609 went from 11/13 with
NINE false positives to 11/13 with none). What is missing is the case
where NO capture identifies a table: then the prior is the only
reading, and it can be a watchlist.

**THE SAFE RULE WOULD BE**: a table whose own heading does not say
"TICKER" or "POSITIONS" and which has no title is not published at all.
That costs the 2022-era floating-panel dates, where the table IS the
positions table and its heading is the only thing that says so -- so the
rule has to be measured on those dates before it is shipped.

**WHAT IS NOT DONE.** The rule above is a MEASUREMENT to take, not a fix
that is ready. Until it is, the reader publishes the prior's reading and
the coverage says the discriminator, so a reader of the log can see
that the table was a positional guess and not an identification.

**WHAT IS STILL NOT READ.** The 2023-05-08 ticker STRIPS (206x767,
204x701, 201x259, 992x20) and the 2026-08-20 picture (1227x717): four
narrow strips of tickers with no weight column, and one picture whose
format is not yet identified.

### The monoszon parser's remaining defects (2026-11-26)

**WHAT IS KNOWN.** The parser reads **69** forward calls out of 4,500
messages, and a hand-labelled sample of all 69 says **88.4 %** of them
are a call on that instrument in that direction. The eight that are not
fall into three classes, and each one is a sentence the parser cannot
tell from a call:

1. **COMMENTARY THAT NAMES A TICKER.** "netu\u0161\u00edm, kolik kus\u016f akcie MSFT musel
   n\u011bkdo nakoupit aby takhle vyhnal canu nahoru" is about a
   post-market print, and the parser reads it as a bullish MSFT call.
2. **A LIVE POSITION.** "nyn\u00ed sleduju potenci\u00e1ln\u00ed vstup long, kdy\u017e se spx bl\u00ed\u017eil k
   6720 tak jsem podle mapy koupil 0dte calls" -- he took the trade and
   partly closed it, and the parser reads the remaining sentence as
   forward.
3. **A VEHICLE RECOMMENDATION.** "pou\u017eijte SPY, tam si m\u016f\u017eete koupit jeden spread za 100usd"
   names the instrument to trade and not a direction.

**WHAT IS NOT KNOWN.** Whether the class is separable at all in Czech.
A position-management sentence and a call about the same instrument
differ mostly in the verb, and the parser already has a PRESENT
vocabulary for the live ones -- "uzav\u00edr\u00e1m", "obchoduju", "m\u00e1m" -- so the
question is whether the three classes above have a verb of their own.

**WHY IT MATTERS AND WHY IT IS NOT FIXED YET.** A wrong DIRECTION
dilutes a hit rate toward 50 %, so the error understates the source
rather than overstating it. At 88.4 % precision the measured 1-week hit
rate of 57.4 % is already a conservative reading of the corpus: at 100 %
precision the same 69 calls would have to score at least as well. Fixing
it is worth doing before the corpus grows, and the fix would be a
vocabulary and a measurement, not a rewrite.
