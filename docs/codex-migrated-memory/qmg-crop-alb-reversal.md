---
name: qmg-crop-alb-reversal
description: "The chart-stream crop default is entangled with the capture-dedup pHash; the 2026-10-31 A/B was reversed on 2026-11-02 and the crop is now ERA-CONDITIONAL"
metadata:
  node_type: memory
  type: project
  originSessionId: 909a4330-b5c4-47fe-b9c1-83296bf43698
  modified: 2026-11-02T10:14:09.685Z
---

The chart-stream crop constant is **not only the OCR crop**. It is also the
`chart_stream` profile's `phashRegionFraction`, which is the **capture-dedup
pHash rectangle** used by `pickTopDistinctCandidates` (Hamming ≤ 6). So changing
the default moves the dedup with it. The prefilter's own scoring is NOT
affected — its ticker rectangle is separate (`PREFILTER_PROFILES[...].tickerRegion`).

**Resolved 2026-11-02: the crop is now ERA-CONDITIONAL** (`src/video/chartStreamCrop.js`),
not one rectangle — Qullamaggie moved his position list between 2023-01-26 and
2023-05-18. `0.86,0.60,0.14,0.28` for the 2022-era floating panel and
`0.82,0.60,0.18,0.32` for the 2023-era right sidebar, chosen by the upload date
(unknown date → the sidebar crop, the safer fallback). See
[[qullamaggie-ocr-crop-analysis]].

The chain of measurements that got there:

1. The 2026-10-31 crop A/B concluded "no wider default; era-conditional crop or
   `position_table`". **That was wrong** — it was taken with the pre-Filter-B
   parser, whose `yMedian ± 8·lineHeight` window clipped long lists anyway, so a
   taller crop could not show its value. **A crop change and a parser change
   interact.**
2. A four-frame benchmark cannot move a global default. The measurement that
   settles it runs over the **94 pinned ground-truth captures** in
   `test/fixtures/qmg_ground_truth/manifest.json` (all 1920×1080, each with its
   own per-capture reading and its own panel footer).
3. That measurement found the old default had **two independent defects**: its x
   window starts to the RIGHT of the sidebar column (so a sidebar-era frame read
   ZERO holdings under it), and its y window clips the first and last row of a
   long list in BOTH eras. Hence two rectangles, not one.
4. The dedup cost is measured too, because the crop IS the dedup rectangle: the
   shipped 2023-era rectangle collapses **0** of 70 distinct-capture pairs (min
   Hamming 8); the shipped 2022-era rectangle collapses **1** (min Hamming 4),
   against the old default's 0 (min Hamming 14).

**The general lesson:** a measurement taken against a parser that has since
changed is a measurement of *that parser*. Re-measure before acting on a recorded
comparison. See [[qmg-ground-truth-audit]] and [[qmg-alias-table-measurement]].
