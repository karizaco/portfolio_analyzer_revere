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
