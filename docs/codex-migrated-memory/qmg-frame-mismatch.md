---
name: qmg-frame-mismatch
description: "A 'false positive' in the QMG scan is not always a wrong holding — the ground truth is pinned to the OCTOBER run's frames, and the rescan captured different moments. The panel footer count is the instrument that proves it."
metadata:
  node_type: memory
  type: project
  originSessionId: 909a4330-b5c4-47fe-b9c1-83296bf43698
  modified: 2026-11-05T12:30:00.000Z
---

The QMG ground truth is pinned to the frames of the **October** run
(`data/video_ocr_probe/qmg-1080p-batch1`), one fixture PNG per capture,
md5-pinned in `test/fixtures/qmg_ground_truth/manifest.json`. The 2026-11-05
rescan captured **different moments** of the same videos, and the positions
panel changes inside a session.

Measured: `20220607` was captured at ts 0 / 296 / 2368 s in November and at
ts 672 / 2744 / 2660 s in October.

**What that does to the score.** A ticker the rescan read but the ground truth
does not list is a *miss* in the other direction — it may be a real holding
the ground truth never saw. On `20220607` the November frame counts **9**
items and the ground truth's frame counts **7**; the pixels show both lists,
and `WEAT` and `TQQQ` are the two rows the ground truth does not carry. The
same holds for `COIN` on `20220606` (9 rows scanned, 8 in the ground truth)
and `RBLX`/`COIN` on `20220608`.

**The instrument.** The panel's own footer (the 2026-11-05 footer reader)
prints the row count: *"N Items in Personal WatchList"*, or *"K of N ..."*
where K is the selected row's index and N is the number of rows ON SCREEN.
Compare N with the ground truth's ticker count for that date and the frames
are immediately distinguishable. Over the twelve ground-truth dates whose
newest log carries a footer count, **six have a different row count than the
ground truth's frame**: `20220330` +2, `20220412` +1, `20220418` −1,
`20220606` −1, `20220607` +2, `20220608` −1.

**How to apply.** The false-positive count is an UPPER BOUND on wrong
holdings, not a precision measurement. Before treating an FP as a defect:
read the panel's footer count and the pixels. If the scanned frame had more
rows than the ground truth's frame, the "FP" is a holding the ground truth
never saw — and the fix is a capture-alignment problem, not an alias row.
The one-glyph rule and the curated alias tables address a real cell read; they
do not address a list that changed between the two runs.

Related: [[qmg-layout-scoped-aliases]], [[qmg-pixel-verified-aliases]],
[[qmg-production-ocr-20261104]].
