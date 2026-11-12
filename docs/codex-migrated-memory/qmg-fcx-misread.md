---
name: qmg-fcx-misread
description: "EasyOCR reads the QMG 2022-era position panel's FCX cell as \"FX\" (C dropped) or \"RX\" (F read as R, C dropped) — both are FCX, pixel-verified on 3 dates"
metadata:
  node_type: memory
  type: project
  originSessionId: 909a4330-b5c4-47fe-b9c1-83296bf43698
  modified: 2026-11-03T15:18:44.286Z
---

In the 2022-era Qullamaggie position panel, EasyOCR misreads the **FCX** ticker cell
as a two-glyph string: `FX` (the C dropped) or `RX` (the F rendered as R and the C
dropped). Neither `FX` nor `RX` is in the seed or the observed lexicon, and no
Qullamaggie holding reduces to either except FCX (FOX/RTX are S&P-500 names that are
not in the seed and were never held).

Pixel-verified 2026-11-03 on three dates, by reading the run's own snapshot PNG and
matching the OCR word's row against the panel's visible rows:

| date | token | panel row (crop px, pitch 90) | panel's own row |
|---|---|---|---|
| 20220318 | RX @ top 774 | 5 of 8 | FCX |
| 20220321 | FX @ top 956 | 7 of 8 | FCX |
| 20220323 | RX @ top 1040 | 6 of 10 | FCX |

**Why it matters — two different failure modes:**

- **20220318**: the log has **no `FCX` and no `ERX` token at all**. The published
  `ERX` was *invented* by the distance-1 edit-distance repair (RX→ERX is one
  insertion; FCX is two edits away, so the repair could not reach it). An
  `RX→FCX` alias row is consulted **before** that fallback, so it turns a wrong
  holding into the right one.
- **20220321**: the FCX row's price cell reads `~0zi` (garbled), so `FX` is not
  price-aligned, the column gate rejects it, and only the **curated-alias rescue**
  can reach it. A plain miss.

On the other four dates where FX/RX appear (20220218, 20220222, 20220301, 20220323)
the panel already reads FCX correctly via the edit-distance repair, so an alias row
is inert there — the "replace in place, never join it" rule keeps it from
double-publishing.

**How to verify a token is a row's ticker** (the method that worked): the crop's
column words sit at a constant pitch, so read two neighbouring tickers from the
same frame, compute the row index of the garbled token from its `top`, and check
the panel PNG's row at that index. The panel's own footer (`N Items in Personal
WatchList`) gives the row count to divide by. See
[[qmg-pixel-verified-aliases]] for the alias-table rules and
[[probe-log-lacks-clusterer-input]] for what a probe log can and cannot prove.
