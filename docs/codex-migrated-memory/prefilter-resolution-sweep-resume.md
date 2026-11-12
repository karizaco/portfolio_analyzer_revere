---
name: prefilter-resolution-sweep-resume
description: "Completed wide prefilter-resolution candidate-pool sweep for 2022 and 2023 eras, with final results, caveats, and decision"
metadata:
  node_type: memory
  type: project
  originSessionId: 909a4330-b5c4-47fe-b9c1-83296bf43698
  modified: 2026-11-04T05:49:51.969Z
---

**Started 2026-11-04. If a conversation is restarted, resume here — do not re-derive.**

## What this work is

CLAUDE.md's section *The prefilter's RESOLUTION — 640×360 is the first one that works*
says shipping a higher prefilter resolution (production is still 160×90) needs a
**wide** measurement, a re-tune of the scale-bound constants
(`rowDensityTarget: 150`, `multiColStripeCountTarget: 3`), and a decision on the
stripe term. This work is the wide measurement. **Nothing has shipped** — the
pipeline still calls `analyzeFrameBeforeOcr` with no resolution override.

## The measurement, and the correction that made it honest

The first attempt used only the probe logs' `captures` (the SELECTED captures).
That is **biased**: selected captures are frames the scanner already chose after
OCR, so they are disproportionately frames that read holdings. Every early date
reported `NO_ZERO_FRAME` — the hard half of the comparison was missing.

The fix: the label set is the **whole retained OCR candidate pool**, which the
probe logs already record per frame:

| source | log field | what it is |
|---|---|---|
| `captures` | `log.captures` | the selected captures |
| `candidates` | `log.top_candidate` + `log.top_candidates` | the top of the retained pool |
| `rejected` | `log.top_rejected_candidates` | the near-miss tail |

`tools/extractPrefilterLabels.js` extracts all three by default
(`--sources captures,candidates,rejected`; `--sources captures` reproduces the
old biased set). Each label carries `ts`, `holdings`, `source`, `sources`,
`aligned`, `index`, `runTag`, `video`, `empty`.

**Two measurement bugs were found and fixed along the way** — do not reintroduce:

1. **Spearman was computed on raw values, not ranks.** It produced impossible
   values like `-21.5`. `src/video/ocrScanLogic.js` now has `rankValues()` +
   `spearman(pairs)` that rank BOTH series first. `tools/measurePrefilterRegion.js`
   imports the same function so the two tools cannot drift.
2. **Multi-video dates attached labels to the wrong media.** 20220606 covers
   three uploads (`aaIlqb7HUJQ`, `Axs8VyUKFRk`, `ST8lvpOVjeM`). The media
   resolver now (a) matches the log's exact recorded basename, (b) then the
   recorded video id against the downloader's own-name convention, (c) and only
   then falls back to a date-only match **when exactly one** `.mp4` matches.
   The sweep then filters labels to the selected media path (`labelsForVideo`).

## Status as of 2026-11-04 (complete)

Both era sweeps are complete with the corrected candidate-pool methodology:

- **2022 floating-panel era:** 32 dates, 719 labels, 582 retained pool frames,
  516 holding frames, 66 zero-holding frames, 146 frames with at most one
  holding, and 14 dates containing a zero-holding label.
- **2023 right-sidebar era:** 9 dates, 143 labels, 110 retained pool frames,
  97 holding frames, 13 zero-holding frames, 18 frames with at most one holding,
  and 3 dates containing a zero-holding label. `20230601` had no usable aligned
  label/media pair and was excluded rather than treated as zero.

2022 production-decay roll-up:

| region | resolution | PARTIAL | INVERTED | NO_ZERO_FRAME | mean Spearman | mean best-labelled |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| era | 160×90 | 9 | 5 | 18 | -0.073 | 5.53 |
| era | 320×180 | 10 | 4 | 18 | -0.058 | 3.44 |
| era | 640×360 | 10 | 4 | 18 | **-0.088** | 4.19 |
| fallback | 160×90 | 9 | 5 | 18 | -0.063 | 5.31 |
| fallback | 320×180 | 10 | 4 | 18 | -0.044 | 3.34 |
| fallback | 640×360 | 10 | 4 | 18 | -0.044 | 4.13 |

2023 production-decay roll-up:

| region | resolution | PARTIAL | INVERTED | NO_ZERO_FRAME | mean Spearman | mean best-labelled |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| era | 160×90 | 0 | 3 | 6 | **+0.221** | 6.00 |
| era | 320×180 | 0 | 3 | 6 | +0.046 | 4.78 |
| era | 640×360 | 2 | 1 | 6 | +0.135 | **6.11** |
| fallback | 160×90 | 0 | 3 | 6 | +0.275 | 5.33 |
| fallback | 320×180 | 1 | 2 | 6 | +0.152 | 6.44 |
| fallback | 640×360 | 2 | 1 | 6 | +0.177 | 6.11 |

Interpretation and decision:

- 640×360 is slightly better by mean Spearman in the 2022 era rectangle, but
  it does not reduce inverted dates and selects fewer holdings on average than
  160×90.
- In 2023, 640×360 improves the verdict mix somewhat, but still has no `OK`
  dates and its Spearman remains positive, the wrong direction.
- The zero-frame count is a lower bound: when runs disagree on a frame, the
  larger holding count wins, so the candidate pool remains biased toward frames
  that read something.
- **Nothing has shipped.** Production remains at 160×90. Shipping a higher
  resolution requires re-tuning the scale-bound row-density and stripe
  constants, measuring the stripe term, and OCR-validating frames discarded by
  the current prefilter.

The completed result files are:

- `data/prefilter_resolution_sweep_2022.json`
- `data/prefilter_resolution_sweep_2023.json`

The JSON artifacts are generated measurement outputs and remain uncommitted
unless the user explicitly decides to include them.

## Next steps

The measurement and documentation are complete. Before any production change:

1. Keep production at 160×90; no higher resolution has shipped.
2. If pursuing a higher resolution, re-tune the scale-bound
   `rowDensityTarget` and `multiColStripeCountTarget` constants separately for
   each era and measure the stripe term rather than reusing the 160×90 values.
3. OCR-validate frames currently discarded by the prefilter; the retained-pool
   sweep cannot measure full-video recall.
4. Keep the generated sweep JSON files out of commits unless the user explicitly
   chooses to publish the measurement artifacts.

The focused checks for the implementation are:

```text
node --test test/extractPrefilterLabels.test.js
node --test test/sweepPrefilterResolution.test.js
node --test test/ocrScanLogic.test.js
```

**Why:** the measurement was expensive (minutes per date, hours per era), and
label-set, media-resolution, and Spearman corrections each changed the numbers.
This record preserves the final results and prevents re-deriving them.

**How to apply:** read this file first on any prefilter-resolution question; the
result JSON files and the final tables above are the measurement record.

Related: [[qullamaggie-prefilter-improvement]], [[qullamaggie-scan-freeze-guidelines]],
[[next-steps-assessment-2026-10-28]], [[qmg-crop-alb-reversal]].
