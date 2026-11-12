---
name: qmg-2022-era-alias-rows
description: "The curated-alias rows from the 2022-era production scans, each pixel-verified: RX/FX→FCX, UI→LMT, NUGI→NUGT, O→LMT (2026-11-03), UC→LAC (2026-11-04)"
metadata:
  node_type: memory
  type: project
  originSessionId: 909a4330-b5c4-47fe-b9c1-83296bf43698
  modified: 2026-11-04T02:06:57.042Z
---

The 2022-era production scan `qmg-easyocr-20261103-era2022` (twelve dates,
low-CPU, `--cluster-rule corroborated`) scored **95/112 hits (84.8 %) with 4
false positives** in its recorded production cluster output. Five new
curated-alias rows were proposed from it, each **located on the source pixels
first** and each with every occurrence of its garbled form inventoried across
the whole corpus.

**The replay measurement.** The recorded production output is 95/112 with 4
false positives (the old cluster table, created before these aliases). On the
same twelve logs, `evalParserReplay`'s `rebuilt_current` arm — current parser
replayed over the twelve selected captures — is **95/112 with 2 false
positives** with `RX,FX,UI,NUGI,O` dropped, and **99/112 with 0 false
positives** with the five rows present. This is not a reserialization of the
old cluster table: production clustered every OCR'd candidate frame, while a
probe log retains only selected captures. The corpus-wide wide replay also
moves from **178/206 with 27 false positives** (five rows dropped) to
**182/206 with 24 false positives** (shipped table).

| garbled | canonical | the misread | date | worth |
|---|---|---|---|---|
| `RX` | `FCX` | F rendered as R, C dropped | 20220318, 20220323 | +1 hit, −1 FP |
| `FX` | `FCX` | C dropped | 20220321 | +1 hit |
| `UI` | `LMT` | L+M merged into a U glyph, T→I | 20220413 | +1 hit, −1 FP |
| `NUGI` | `NUGT` | T rendered as I | 20220413 | +1 hit |
| `O` | `LMT` | the 3-glyph cell collapsed to one glyph | 20220412 | −1 FP |

**The verification method that works.** The crop's column words sit at a
constant pitch (≈90 crop px), so read two neighbouring tickers from the same
frame, compute the garbled token's row index from its `top`, and check the
panel PNG's row at that index. The panel's own footer (`N Items in Personal
WatchList`) gives the row count to divide by. On 20220413 the panel reads
WEAT, REGN, COPX, FCX, LHX, LMT, X, URA, URNM, JNUG, NUGT ("7 of 11 Items")
and the OCR read the same eleven rows in the same order as WEAT, REGN, COPX,
FCX, WHX, **UI**, X, URA, URNM, JNUG, **NUGI** — a perfect 1:1 row match,
which is what makes the mapping certain rather than plausible.

**Two different failure modes behind them, and they need different mechanisms.**
`RX` on 20220318 was price-aligned, so the distance-1 repair reached it and
published **ERX** (RX→ERX is one insertion; FCX is two edits away) — a wrong
holding, invented. `FX` on 20220321 had a garbled price cell (`~0zi`), so it
was NOT price-aligned, the repair pass skipped it and the column gate
rejected it — a plain miss, reachable only by the curated rescue. `UI` on
20220413 was price-aligned and became **AI** (one edit away, and AI is in the
seed) — another invented holding.

**`O` is the row with the sharpest edge.** `O` is a single character, so it
is only legal because it is in neither lexicon (the seed's one-letter tickers
are U, X and P) and because the panel's row 2 is pixel-verified as LMT. Its
three other corpus sites are all safe: two are in logs whose `column_filter`
is `null` (the gate was never active, so neither the repair pass nor the
rescue can reach them) and one is in the % Change column, far outside the
Sym column.

**The fourth false positive is NOT alias-reachable.** 20220222 published `X`,
which its panel does not hold (the panel reads NRGU, DVN, MOS, COPX, TQQQ,
FCX, TSLA — "7 Items in Personal WatchList"). All seven recorded frames read
exactly those seven holdings and rejected `X`; the token came from the
**eighth** OCR'd frame, which the probe log does not record. It is born from
the panel's own ✕ close button, read as `#X` in the header row and as a
trailing `X` on the last price. The clusterer's input is not in the log, so
this one cannot be diagnosed further from the log — see
[[probe-log-lacks-clusterer-input]].

**The misses that are OCR losses, not parser decisions.** `X` on 20220330 and
20220406 has no `"text": "X"` word anywhere in the log — the cell was simply
not read. `ROKU` on 20220218, `AGQ`/`RSX` on 20220302, `WEAT`/`NEM`/`JNUG` on
20220321 and `JNUG` on 20220323 are the same kind of loss.

See [[qmg-fcx-misread]] for the FCX rows alone and
[[qmg-pixel-verified-aliases]] for the alias-table rules.

**Sixth row: `UC → LAC` (2026-11-04).** A class of defect the union score
cannot see. The 20220421 capture (at 09:58) read the LAC cell as `UC`
(left=736, width=94, conf=0.839) — the LA glyphs merged into one U glyph,
the C read alone. The distance-1 repair turned `UC` into `UCO` (one
insertion; UCO is a seed ticker). UCO is also in the GT union (it was opened
30 minutes later at 15:57), so the wrong holding scored as a hit and the
right holding (LAC) counted as a miss. Neither a recall count nor a row-count
check can see this — the panel had 14 rows, the reading had 14 tickers, and
they were not the same 14. Only the alias table catches it. Default-roots
replay unchanged at 97.6%/100% (83/85). Table is now 45 data rows.
