---
name: qmg-pixel-verified-aliases
description: "How to add a curated alias row — locate the token on the pixels first, and derive the crop geometry from the log"
metadata:
  node_type: memory
  type: project
  originSessionId: 909a4330-b5c4-47fe-b9c1-83296bf43698
  modified: 2026-11-02T10:45:16.648Z
---

A curated alias row (`config/ticker_ocr_confusions.csv`) must be **pixel-verified
before it is proposed**. Three candidates looked like misreads from the OCR text
alone and were all rejected by pixel inspection: `CO→UCO` (a % Change cell read as
`+0,43%`), `REIGN→REGN` (chart-area ink near the price labels), `IMG→IMGN` (the
Sym header band).

**The geometry must come from the log, and be validated.** `log.phash_region_fraction`
is the region the run actually used — it is NOT always the chart-stream default
(the 20220606 diag log used `{"x":0.86,"y":0.55,"w":0.14,"h":0.45}`). The OCR image
width is the **fixed EasyOCR crop width 1345**, not the log's `ocr_frame_width`.

**The one check that catches a wrong geometry: the rendered height must equal the
log's max word bottom.** With the right region and width the two agree to ~1 %
(2432 vs 2419). A wrong geometry does not merely mis-render — it **refutes a real
misread**, which is the worst failure for a check whose purpose is to reject false
candidates.

**A 7.6 px glyph cannot be read by eye.** The `CBIO`/`CBO` question was settled by
**column-intensity cosine similarity** against the known-good rows: 0.9990 for the
match vs 0.73–0.81 for every other row of the panel. Row-band detection needs a
low threshold (`mx*0.35`) or it compares *different rows* and produces spurious
similarity.

**A verified misread that cannot fire today is still worth keeping** (the
`KOT`/`RLI`/`CBO` precedent) — it can fire on the next frame that reads that way.
`CBO→CBIO` cannot fire because the column detector latched onto the % Change
column (dominant_left 684) instead of the Sym column (x 450).

**The replay corpus cannot find every misread — a PRODUCTION SCAN can.** The
`RGN→RGTI` row (2026-11-02) was found by a real scan of a 2023-era video, not by
the corpus: `RGN` is a garble of `RGTI` that lands **one edit from `REGN`, a real
seed ticker**, so the distance-1 repair pass published a *wrong holding*. The
corpus contains zero `RGN` tokens (283 probe logs searched), so the row measures
**+0 on both corpora** and is invisible to `evalParserReplay.js`. When a corpus
number is unmoved, that is not proof the change was inert.

**The failure shape to look for: a garble that happens to BE a valid ticker.**
`AROQ→ARQQ`, `IOI→IOT`, `OI→LMT` and `RGN→RGTI` all produce a *wrong holding*
rather than a missing one, because the repair pass correctly finds a real seed
ticker one edit away. Check the merged list against the date's ground truth for
any ticker that is a real holding on *other* dates.

**A second, fresh scan is the end-to-end confirmation.** Re-running
`tools/scanVideoWithOcr.js` on the same video with the new table re-ran EasyOCR
from the video (an independent OCR pass, not a replay). It landed on the **same
frame with the same score and the same `bbox_filter` geometry**, and read the
date's ground truth **exactly, 0 FP** — so the difference between the two runs
is the table and nothing else.

**Score the MERGED list, not only the capture.** The bad holding lived in the
**multi-frame clusterer consensus**, not in the captured frame — the capture
read the 13 holdings cleanly while the merge published a 14th. The aggregator
reads `capture.chart_stream.position_list`; `tools/runQmgOcrBatch.js` and
`tools/runQmgCuratedBenchmark.js` read `merged_position_list`. The two consumers
of the same scan disagreed, and only one of them was wrong.

Measure every candidate with `node tools/evalParserReplay.js --confusion-csv
<temp copy>` — never edit the shared table. See [[qmg-alias-table-measurement]].
