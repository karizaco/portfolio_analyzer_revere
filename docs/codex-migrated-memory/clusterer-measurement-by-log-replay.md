---
name: clusterer-measurement-by-log-replay
description: "How to measure the QMG clusterer and the table reader without re-running OCR: replay the archived snapshot logs (64 logs / 575 GT occurrences) — added 2026-10-24"
metadata:
  node_type: memory
  type: project
  originSessionId: 909a4330-b5c4-47fe-b9c1-83296bf43698
  modified: 2026-10-24T17:07:21.552Z
---

**Measure the QMG clusterer by REPLAYING the archived snapshot logs, not by
re-running OCR.** Every scan writes a probe log under
`data/video_ocr_probe/**/logs/*_snapshot.json` (and
`data/video_scan_*/**/logs/`) carrying each capture's
`chart_stream.position_list`. Feeding those per-frame lists back through
`clusterRawOcrTokens` / `mergeMultiplePositionLists` and scoring against
`data/qmg_ground_truth.json` costs seconds instead of the ~75 min a real
EasyOCR sweep takes.

The replay yields **64 logs with a ground truth and 575 ground-truth ticker
occurrences** — enough to separate a real change from noise. Baseline
figures on that corpus (commit `a15f66a`):

| reading | recall | FP |
|---|---|---|
| union of the per-capture lists | 202/575 | 659 |
| clusterer, seed lexicon, minFrequency 2 | 160/575 | 135 |
| clusterer, **observed** lexicon, minFrequency 2 | 171/575 | 137 |
| clusterer, observed lexicon, minFrequency 1 | **234/575** | 264 |

**Open policy question the numbers raise**: minFrequency 1 (Filter A off)
beats the union on BOTH axes — more recall than 202 and 2.5x fewer false
positives than 659 — but it disables the "a garble must appear in two
frames" rule. The default stays at 2 because that is a policy choice, not
a bug fix; the flag is `--cluster-min-frequency 1`.

**Also**: the clusterer must repair against the **observed** lexicon
(`loadDecodeLexiconSync`), not the seed lexicon — the seed is the
whole-panel parser's allowlist and is missing 26 tickers Qullamaggie
actually held. With the seed, NRGU was rewritten to NUGI and UPST was
lost outright.

**Caution**: replaying measures the clusterer only. It says nothing about
whether the frames selected were the right ones — for that, re-read the
4 real GT frames with `readPositionTable` (≈10 min EasyOCR each).

Related: [[qullamaggie-position-table-profile]], [[qmg-ocr-2023-improvements]].
