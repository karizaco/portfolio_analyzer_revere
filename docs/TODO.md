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

### The 37 lessons and the 3 webinars carry no session date

**What is known.** They are evergreen teaching content, not sessions:
there is no report number and no date in the name. **What is not
known.** Whether a setup in a lesson is a CLAIM at all -- "here is how I
screen for momentum" is a method, not a call.

**Why it matters.** They are the 49 setups that cannot be scored
(163 of 212 can). **A decision** is needed: either they are dated
somewhere (the corpus has no such date), or they are excluded from
the outcome scoring on purpose, and the exclusion is recorded rather
than left as a silent gap.

### The panel reader, iteration 3

**What is known.** The reader finds the region, the header, the columns
and the rows, and reads the prices mostly right. **What is wrong.**
(a) the symbol column carries the row's ICON -- the panel draws a small
coloured blob before every symbol and Tesseract reads some of them as
letters, so the POWL row reads "VPOWLE"; (b) the W/L sign is taken
from a single sampled pixel of the cell's fill, which is sometimes not
where the sign is; (c) the detail card under the table is read as rows
on some frames.

**The fixes, in the order the defects bite.**

1. **MASK THE ICON.** The icon is a COLOURED blob -- saturated pixels
   that the text is not -- so the symbol strip can be cut where the
   pixels are saturated, and the icon simply is not in the crop.
2. **COUNT THE FILL, DON'T SAMPLE IT.** The sign is the majority
   colour of the cell's background, so count the green and the red
   pixels over the cell and take the larger, rather than reading one
   pixel in the middle (where the text may be).
3. **BOUND THE DETAIL CARD.** The card is a different widget under the
   table; the gap test catches it on some frames and not on others, so
   it needs its own rule -- most likely "the table ends where the
   prices stop".

The QMG project took many rounds on its equivalent
(`src/video/positionTableScan.js` and the "column gate" work in
AGENTS.md), so this is the expected cost of the work.

## Everywhere else

### The Deepgram utterance boundary can fall inside a word

**What is known.** The transcripts' segment boundaries sometimes split a
word ("...here you can see, I" / "ONS."). Measured: about 1 % of
segment boundaries, and the shared `transcriptNormalize.js` is not
changed under a source that depends on it. **A fix** belongs in the
extractor, where the words are read: the segments are joined before
the name finder runs. This is not a Komar-only problem -- the Sevcik,
T3Live and Benzinga corpora have the same artifact.

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
