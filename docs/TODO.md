# TODO

The open items that are not blocked on an answer from the user, and not
blocked on the corpus. Each one says what is known, what is not, and
what a fix would look like -- so that a later session can pick it up
without re-deriving the measurement.

## The Komar source

### The exact DAY of a report is not recoverable from its number

**What is known.** The report number is chronological -- seven days a
number (43 = 19 Nov 2022, 50 = 8 Jan 2023, 211 = 25 Jan 2026) -- and
`src/komar/corpusCatalog.js`'s `dateFromReportNumber` dates a session
from it. **What is not known.** The day it lands on is the session's
WEEK, not its day: the reports are published on a weekend and the
number does not say which.

**Where the day IS recoverable.** The 2025 series' own file timestamps
run 188 (23 Aug) -> 199 (2 Nov) in exact 7-day steps, and 199's
timestamp (2 Nov 2025) agrees with the interpolation to within a day.
So for the sessions whose files were copied in report order, the
timestamp IS the report date. **A fix** would date a session from its
file's timestamp where the timestamps are monotonic in the report
number (and fall back to the interpolation where they are not -- the
older files were copied in bulk and their timestamps carry nothing).

**Why it matters.** A week's slack is inside the noise of a one-week
price horizon, so the scoring is not wrong -- but a day-accurate date
would make the one-week horizon exact.

### The panel reader, iteration 3

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

### The Komar market card's per-horizon mapping

**What is known.** The 2026-05-09 card's leader groups are read in a
different order from its theme names, so some leaders carry the wrong
theme. The leaders themselves are right. **A fix** is to read the
leaders' group boundaries from the card's own layout rather than
assuming the order, and to use a theme name only when its count
matches the number of groups (which is the rule now).

### The Komar 2025 card's theme grouping

**What is known.** Its four theme boxes are laid out differently from
the 2026 cards and the group boundaries are off. The leaders are right.
