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

**The fixes, in the order the defects bite.**

1. **MASK THE ICON BY ITS GEOMETRY.** The colour mask only takes out
   the saturated part of the blob; a partly-saturated edge still reads
   as a letter. The blob's own extent is measurable -- it is a
   contiguous run of coloured pixels at the row's left -- so the strip
   can be cut at the blob's right edge instead.
2. **COUNT THE FILL OVER THE WHOLE CELL.** Done in iteration 2.
3. **BOUND THE DETAIL CARD.** The card is a different widget under the
   table; the gap test catches it on some frames and not on others, so
   it needs its own rule -- most likely "the table ends where the
   prices stop".
4. **MEASURE THE READER, DO NOT ASSUME IT.** Every frame the reader
   has been tried on so far has been reported by hand. A reading that
   is not measured against the sheet's own rows is a guess, and the
   project's rule is that a wrong holding is worse than a missing one:
   the reader stays unwired until it is measured.

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
