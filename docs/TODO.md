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

### The Deepgram utterance boundary can fall inside a word

**What is known.** The transcripts' segment boundaries sometimes split a
word: Komar's first transcript reads "...Here you can see, I" and then
"ONS. I sold that here when it dropped below the EMA eight" -- the
ticker "IONS" cut in half. The same artifact is in the Sevcik, T3Live
and Benzinga corpora, so it is not a Komar problem.

**What is NOT known, and it is the important part: the artifact CANNOT
be measured against the stored corpus.** The stored transcripts keep the
segments' TEXTS; the word list -- the only thing that says where the
provider's boundary really fell -- is not kept, so the raw Deepgram
payloads are gone.

**A first attempt at a detector failed, and it is worth recording why.**
"the previous segment ends with a letter, the next begins with a
letter, and the previous's last word is two characters or fewer" --
measured over the corpus's 5.9 million boundaries -- matches **21 %**
of them, and the examples are ordinary sentence boundaries ("...the
belief was so" | "negative on Tesla."). So a shape test over the
stored texts cannot separate a split from a sentence.

**Where the fix belongs.** `src/transcript/transcriptNormalize.js`'s
`normalizeDeepgram`, which has the raw WORDS and can see that an
utterance's last word and the next utterance's first word are one
word. That is a change to a shared module, and the project's rule is
that shared code does not change under a source that depends on it
without its own measurement -- and here the measurement needs a
RE-FETCH, because the evidence was not kept.

**So the work is:** (a) keep the raw word list in the stored
transcript, or a flag per boundary that says "this one fell inside a
word", so the artifact becomes measurable; (b) measure it on one
channel; (c) then fix the segmenter and measure the change on the
same channel. Until (a) exists, every attempt to fix this is a guess
that cannot be checked.

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
