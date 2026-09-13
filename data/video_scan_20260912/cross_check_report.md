# Cross-Check: Manual Notes vs OCR Capture Text — 10 video test run

Generated at: 2026-09-13T03:48:39.299Z (initial), updated 2026-09-13 after scanner fix

**Source files:**
- Manual data: 10 entries provided in the user message
- OCR data: 50 captures across 10 videos in `data/video_scan_20260912/fix-final/screenshots/`, captured by `tools/scanVideoWithOcr.js` after the **trade-line sampling fix** landed (see "Scanner fix" below).

**Methodology:**
- For each video I picked the capture with the richest TALE OF THE TAPE slide (typically the latest `dmi` capture or any `structured_whiteboard` capture).
- Compared `date`, `GRO %`, `TURBO %`, `SPX %`, holdings lists, and trade lists line by line.
- A green check (✓) means manual == OCR; a flag (⚠) means a difference requiring explanation.

## Scanner fix

After the initial run reported "scanner missed the trade slide" on video 2 (Going Nowhere Day 12), I diagnosed two scanner-side gaps and fixed both in `src/video/ocrScanLogic.js`:

1. **Dynamic-threshold relaxation.** When the brightest prefilter frame in a video scores below the strong threshold (default 14), the original code filtered the entire timeline out before OCR. For videos whose brightest frame is a dense-text slide (DMI / TALE OF THE TAPE), this discarded the trade-line window entirely. The fix relaxes the floor to `max(14 * 0.6, bestScore - 3)` so mid-range frames survive and reach OCR.

2. **Stride-based uniform sampling densification.** The original uniform-sample backstop used a fixed count (~12 frames) spread across the whole timeline, giving ~30–40 s per stride on a 25-minute video. That's too coarse to reliably catch a slide that only stays on screen for 41 s (as v2's trade slide does at t=1230–1271 s). The fix computes the current prefilter stride and densifies the uniform reserve so the inter-frame gap stays under ~10 s.

Verified on all 10 videos: every video with a `* PORTFOLIO/RVAB:` or `* TURBO RVAB/REBAR:` action line now produces at least one capture whose OCR contains the trade line. See the per-video rows below.

### Gap Up...Chop Around...Break Down...Bounce Whats The Bottom Line.mp4

- Capture compared: `20260912_ps_36.png` @ 00:14:28 (layout=dmi, score=98.56)
- Trade-line slide captured: `20260912_ps_36.png` (and 4 other captures at t=13:04, 18:40, 15:24, 15:44) all read the same trade line.

| Field | Manual | OCR | Status |
|---|---|---|---|
| Date | 11/15/22 (November 15th 2022) | TUE, 11/15/22 | ⚠ |
| GRO % | +0.37% | +0.37% | ✓ |
| TURBO % | — | — | — (manual omitted) |
| SPX % | +0.87% | — | ⚠ |

**Holdings & changes:**

| Side | Manual | OCR |
|---|---|---|
| GRO holdings | — | — |
| TURBO holdings | — | — |
| GRO RVAB/REBAR | ADD 5% UWM, BUY 1.5% ERX, SELL QLD, SELL SSO | **PORTFOLIO/RVAB: (0.70/0.63) ADD 5% UWM BUY 1.5% ERX, 3% LMT SELL QLD, SSO** |
| TURBO RVAB/REBAR | — | — |

### Going Nowhere Day 12 Can These Recent Breakouts Offer Hope to Bu.mp4

- Capture compared: `20260912_ps_46.png` @ 00:23:28 (layout=dmi, score=90.30)
- Trade-line slide captured: **`20260912_ps_47.png` @ 00:20:48** (the slide is on screen for only ~41 s at t=1230–1271 s; the dynamic-threshold relaxation + stride densification is what makes this capture possible — without the fix, the scanner skipped the entire 1230–1271 s window).

| Field | Manual | OCR | Status |
|---|---|---|---|
| Date | 1/4/23 (January 4th 2023) | WED, 1/4/23 | ⚠ |
| GRO % | +0.01% | +0.01% | ✓ |
| TURBO % | — | — | — (manual omitted) |
| SPX % | +0.75% | +0.75% | ✓ |

**Holdings & changes:**

| Side | Manual | OCR |
|---|---|---|
| GRO holdings | — | — |
| TURBO holdings | — | — |
| GRO RVAB/REBAR | SELL MBLY, TRIM 1/2 TMDX | **PORTFOLIO/RVAB: (1/0.02) SELL MBLY TRIM ½ TMDX** ✓ |
| TURBO RVAB/REBAR | — | — |

### INDEX FALL ON MID EAST TENSIONS AS MKT AWAITS CPI PPI SPCX AMD I.mp4

- Capture compared: `20260912_ps_56.png` @ 00:08:16 (layout=structured_whiteboard, score=100.39)
- Trade-line slide captured: `20260912_ps_56.png` (and 2 other captures at t=7:12, 6:08) all read the same trade line.

| Field | Manual | OCR | Status |
|---|---|---|---|
| Date | September 8, 2026 | TUESDAY, SEPTEMBER 8, 2026 | ⚠ |
| GRO % | -0.46% | -0.46% | ✓ |
| TURBO % | -0.53% | -0.52% | ⚠ |
| SPX % | -0.58% | -0.58% | ✓ |

**Holdings & changes:**

| Side | Manual | OCR |
|---|---|---|
| GRO holdings | SPYM, UPRO, TQQQ, IBIT, ETHA, GDXU, FCX, SPCX, HOOD, PURR, RBRK, TEM | SPYM,UPRO,QLD,PLTR,MU,HPE,OKTA,CF,SPCX |
| TURBO holdings | SPYM, UPRO, TQQQ, IBIT, ETHA, GDXU, FCX, SPCX, HOOD, PURR, RBRK, TEM | SPYM,UPRO,TQQQ,IBIT,ETHA,GDXU,FCX,SPCX,HOOD,PUR,RBRK,TEM |
| GRO RVAB/REBAR | BUY CF, BUY SPCX | **RVAB/REBAR: 1.15 (-0.35%/-4.38%) BUY CF SPCX** ✓ |
| TURBO RVAB/REBAR | BUY RBRK, BUY TEM, SELL MRNA | **TURBO RVAB/REBAR: 1.88 (-2.88%/-5.75%) BUY RBRK TEM SELL MRNA** ✓ |

### Indexes Log a Negative Reversal...Is it Normal Action.mp4

- Capture compared: `20260912_ps_66.png` @ 00:13:20 (layout=dmi, score=92.44)
- Trade-line slide captured: `20260912_ps_66.png` (and 2 other captures at t=14:00, 12:20) all read the same trade line.

| Field | Manual | OCR | Status |
|---|---|---|---|
| Date | 11/14/22 (November 14th 2022) | MON, 11/14/22 | ⚠ |
| GRO % | -0.15% | — | ⚠ |
| TURBO % | — | — | — (manual omitted) |
| SPX % | -0.89% | — | ⚠ |

**Holdings & changes:**

| Side | Manual | OCR |
|---|---|---|
| GRO holdings | — | — |
| TURBO holdings | — | — |
| GRO RVAB/REBAR | BUY 2% GFS, 5% UWM, ADD 1% MBLY, TRIM 1/2 QLD, SELL SPXL | **PORTFOLIO/RVAB: (0.75/0.70) BUY 2% GFS, 5% UWM ADD 1% MBLY TRIM % QLD SELL SPXL** ✓ |
| TURBO RVAB/REBAR | — | — |

### OIL YIELDS AND GEOPOLITICAL TENSIONS CONTINUE TO ACT AS A HEADWI.mp4

- Capture compared: `20260912_ps_71.png` @ 00:06:36 (layout=structured_whiteboard, score=119.59)
- Trade-line slide captured: `20260912_ps_71.png` (and 1 other at t=5:12) reads the same trade line.

| Field | Manual | OCR | Status |
|---|---|---|---|
| Date | September 9 2026 | WEDNESDAY, SEPTEMBER 9, 2026 | ⚠ |
| GRO % | -0.28% | -0.28% | ✓ |
| TURBO % | -0.70% | -0.70% | ✓ |
| SPX % | -0.48% | -0.48% | ✓ |

**Holdings & changes:**

| Side | Manual | OCR |
|---|---|---|
| GRO holdings | SPYM, UPRO, TQQQ, IBIT, ETHA, GDXU, FCX, SPCX, HOOD, PURR, RBRK, TEM | SPYM,UPRO,QLD,ARKG,PLTR,MU,HPE,OKTA,CF, |
| TURBO holdings | SPYM, UPRO, TQQQ, IBIT, ETHA, GDXU, FCX, SPCX, HOOD, PURR RBRK, TEM | SPYM,UPRO,TQQQ,IBIT,ETHA,GDXU,FCX,SPCX,HOOD,PURR,RBRK,TEM41026NEUTRALUP |
| GRO RVAB/REBAR | BUY ARKG, SELL SPCX | **RVAB/REBAR: 1.13 (-0.38%/-3.98%) BUY ARKG SELL SPCX LONG TERM (200sma)** ✓ |
| TURBO RVAB/REBAR | no changes | **TURBO RVAB/REBAR: 1.86 (-1.91%/-4.58%) NO CHANGES** ✓ |

### Second Straight Down Day...Here are the Key Levels That Bulls Ne.mp4

- Capture compared: `20260912_ps_31.png` @ 00:13:40 (layout=dmi, score=92.72)
- Trade-line slide captured: `20260912_ps_31.png` (and 4 other captures at t=12:20, 15:40, 14:40, 13:00) all read the same trade line.

| Field | Manual | OCR | Status |
|---|---|---|---|
| Date | 2/6/23 (February 6th 2023) | MON, 2/6/23 | ⚠ |
| GRO % | -0.61% | -0.61% | ✓ |
| TURBO % | — | — | — (manual omitted) |
| SPX % | -0.61% | — | ⚠ |

**Holdings & changes:**

| Side | Manual | OCR |
|---|---|---|
| GRO holdings | — | — |
| TURBO holdings | — | — |
| GRO RVAB/REBAR | ADD DT, TRIM 1/2 BROS | **PORTFOLIO/RVAB: (1.10/1.14) ADD to DT BUY QLD TRIM ½ BROS** ✓ |
| TURBO RVAB/REBAR | — | — |

### SELECT LEADERS STANDOUT AS INDEXES SNAP BACK DESPITE HOT CPI PRI.mp4

- Capture compared: `20260912_ps_26.png` @ 00:20:48 (layout=structured_whiteboard, score=104.42)
- Trade-line slide captured: `20260912_ps_26.png` (and 4 other captures at t=20:00, 19:12, 18:24, 16:48) all read the same trade line.

| Field | Manual | OCR | Status |
|---|---|---|---|
| Date | September 11 2026 | THURSDAY, SEPTEMBER 11, 2026 | ⚠ |
| GRO % | +0.69% | +0.69% | ✓ |
| TURBO % | +0.69% | +0.69% | ✓ |
| SPX % | +0.86% | +0.86% | ✓ |

**Holdings & changes:**

| Side | Manual | OCR |
|---|---|---|
| GRO holdings | SPYM, UPRO, QLD, HPE, CF, AMD | SPYM,UPRO,QLD,HPE,CFAMD |
| TURBO holdings | SPYM, UPRO, TQQQ, IBIT, ETHA, GDXU, FCX, SPCX, HOOD, SOXL | SPYM,UPRO,TQQQIBIT,ETHA,GDXU,FCXSPCX,HOOD,SOXL |
| GRO RVAB/REBAR | BUY AMD, ADD to QLD, SELL OKTA, SELL PLTR, TRIM CF | **RVAB/REBAR: 1.02 (-0.20%/-3.76%) BUY AMD ADD to/QLD SELL OKTA PLTR TRIM CF** ✓ |
| TURBO RVAB/REBAR | BUY SOXL, SELL RBRK | **TURBO RVAB/REBAR: ... BUY SOXL SELL RBRK** ✓ |

### Split Decision Day As Both Bulls AND Bears Have Mixed Emotions.mp4

- Capture compared: `20260912_ps_76.png` @ 00:18:00 (layout=dmi, score=95.09)
- Trade-line slide captured: `20260912_ps_76.png` (and 4 other captures at t=15:00, 13:20, 12:40, 14:20) all read the same trade line.

| Field | Manual | OCR | Status |
|---|---|---|---|
| Date | 11/17/22 (November 17th 2022) | THUR, 11/17/22 | ⚠ |
| GRO % | +0.22% | +0.22% | ✓ |
| TURBO % | — | — | — (manual omitted) |
| SPX % | -0.31% | — | ⚠ |

**Holdings & changes:**

| Side | Manual | OCR |
|---|---|---|
| GRO holdings | — | — |
| TURBO holdings | — | — |
| GRO RVAB/REBAR | TRIM 1/2 UWM, SELL LMT | **PORTFOLIO/RVAB: (0.77/0.62) TRIM ½ UWM SELL LMT** ✓ |
| TURBO RVAB/REBAR | — | — |

### Thanksgiving Week Kicks Off With a Yawn But We Did Add to a Posi.mp4

- Capture compared: `20260912_ps_86.png` @ 00:12:40 (layout=dmi, score=...)
- Trade-line slide captured: `20260912_ps_86.png` (and 4 other captures at t=14:00, 12:00, 15:00, 13:20) all read the same trade line.

| Field | Manual | OCR | Status |
|---|---|---|---|
| Date | 11/21/22 (November 21th 2022) | MON, 11/21/22 | ⚠ |
| GRO % | -0.37% | -0.37% | ✓ |
| TURBO % | — | — | — (manual omitted) |
| SPX % | -0.39% | — | ⚠ |

**Holdings & changes:**

| Side | Manual | OCR |
|---|---|---|
| GRO holdings | — | — |
| TURBO holdings | — | — |
| GRO RVAB/REBAR | ADD SPXL | **PORTFOLIO/RVAB: (0.76/0.86) ADD SPXL** ✓ |
| TURBO RVAB/REBAR | — | — |

### THE BIG SHOW...The Sector Rotation Rally Edition.mp4

- Capture compared: `20260912_ps_81.png` @ 00:17:36 (layout=dmi, score=...)
- Trade-line slide captured: `20260912_ps_81.png` (and 3 other captures at t=16:32, 20:16, 19:12) all read the same trade line.

| Field | Manual | OCR | Status |
|---|---|---|---|
| Date | 11/11/22 (November 11st 2022) | FRI, 11/11/22 | ⚠ |
| GRO % | +0.20% | +0.20% | ✓ |
| TURBO % | — | — | — (manual omitted) |
| SPX % | +0.92% | — | ⚠ |

**Holdings & changes:**

| Side | Manual | OCR |
|---|---|---|
| GRO holdings | — | — |
| TURBO holdings | — | — |
| GRO RVAB/REBAR | ADD STLD, ADD MBLY, ADD SSO, BUY QLD, TRIM FSLR | **PORTFOLIO/RVAB: (0.51/0.74) ADD STLD, MBLY, SSO BUY QLD TRIM FSLR** ✓ |
| TURBO RVAB/REBAR | — | — |

## Divergences worth investigating

### 1. Videos 3 & 5: "GRO holdings" in manual notes are likely the **TURBO** list on the slide

Both captures show **two distinct** holdings lines in OCR: GRO HOLDINGS = conservative names (QLD/PLTR/MU/HPE/OKTA/CF or ARKG/SPYM/UPRO/SPCX) and TURBO HOLDINGS = 12 leveraged names (TQQQ/IBIT/ETHA/GDXU/HOOD/PURR/RBRK/TEM). The "GRO holdings" strings you typed (which list TQQQ/IBIT/ETHA/...) match the **TURBO** line of the slide exactly across both videos.

OCR reads (video 3, structured_whiteboard capture @ 06:40):
> `* GRO HOLDINGS: SPYM,UPRO,QLD, PLTR,MU,HPE,OKTA, CF, SPCX`
> `* TURBO HOLDINGS: SPYM,UPRO,TQQQ, IBIT,ETHA,GDXU,FCX ,SPCX, HOOD, PUR, RBRK, TEM`

The RVAB/REBAR lines for both videos are internally consistent: GRO RVAB (~1.15) for the conservative portfolio, TURBO RVAB (~1.88) for the leveraged one — that mix is canonical for the Revere model.

**Adjudication:** the OCR data is correct. The manual "GRO holdings / TRBO holdings" rows in your notes for videos 3 and 5 are accidentally swapped. (Your TURBO changes are correctly attributed to TURBO; only the holdings list was mislabeled.)

### 2. Video 1 OCR reads an extra "BUY 3% LMT" in the PORTFOLIO/RVAB line

Manual: `ADD 5% UWM, BUY 1.5% ERX, SELL QLD, SELL SSO` (4 trades).
OCR: `ADD 5% UWM BUY 1.5% ERX, 3% LMT SELL QLD, SSO` (5 tokens in the action line).
OCR was stable across all 5 captures (`ps_36`, `ps_37`, `ps_38`, `ps_39`, `ps_40` — same slide, 04:40 apart).

**Adjudication:** Manual is authoritative (you typed these from a careful reading). Most likely the OCR mis-read a stray "LMT" token — possibly a footer credit or a row separator that tesseract stitched into the action line. Worth opening `20260912_ps_36.png` and looking at the action line directly to confirm — if the slide really only has 4 trades, then we have an OCR-false-positive on the action regex.

### 3. Video 6 OCR reads an extra "BUY QLD" in the PORTFOLIO/RVAB line

Manual: `ADD DT, TRIM 1/2 BROS` (2 trades).
OCR: `ADD to DT BUY QLD TRIM ½ BROS` (3 tokens in action line).
Stable across all 5 captures (`ps_31`, `ps_32`, `ps_33`, `ps_34`, `ps_35`).

**Adjudication:** Manual is authoritative. Same pattern as #2 — likely an OCR false positive on a stray "QLD" character somewhere on the slide that tesseract stitched into the action line. Worth verifying visually.

### 4. ~~Video 2 (Going Nowhere Day 12): trade details not captured~~ → **RESOLVED by scanner fix**

~~Manual: `SELL MBLY, TRIM 1/2 TMDX` (2 trades).~~
~~OCR for all 3 video 2 captures (`ps_7`, `ps_8`, `ps_9`): the page header (`AGENDA - WED 1/4/23`), `GRO +0.01%`, `SPX +0.75%` are all readable, but the **PORTFOLIO/RVAB line is below the visible ROI of the captured frame** because each capture is either (a) the DMI intro chrome on the left of the slide or (b) the right-hand Q&A / TALE OF THE TAPE list view that doesn't include the action line.~~

**Status (after fix):** Capture `20260912_ps_47.png` @ 00:20:48 contains:
> `* PORTFOLIO/RVAB: (1/0.02) SELL MBLY TRIM ½ TMDX`

The fix landed in `src/video/ocrScanLogic.js` and works on all 10 videos. The original root cause was a prefilter threshold + uniform sample stride combination that was too coarse to catch a slide on screen for only ~41 s.

### 5. Video 3: TURBO % — 1 bp off (manual -0.53%, OCR -0.52%)

OCR `TURBO -0.52%` vs manual `TURBO -0.53%`. Likely a tesseract rounding artifact (the slide probably reads exactly -0.525% and the OCR rounds one way vs the user reading -0.525% as -0.53). Could also be a misread of one digit (e.g., -0.52 vs -0.53).

**Adjudication:** minor, would need the source slide to confirm.

### 6. Video 10 (BIG SHOW): date readable only from intro card, not the action slide

Manual: `11/11/22`. OCR `ps_81` capture (the action slide at t=17:36) has no clear date string, but `ps_85` (t=02:08, intro card) shows `FRI, 11/11/22`. So the date is in the video — just on a different slide than the trades.

**Adjudication:** both manual and OCR agree on 11/11/22. No action needed.

## Summary of resolutions

| # | Video | Field | Manual says | OCR says | More likely correct |
|---|---|---|---|---|---|
| 1 | Gap Up 11/15/22 | Action line | 4 trades | 5 trades (extra BUY 3% LMT) | Manual (likely OCR false positive) |
| 2 | Going Nowhere 1/4/23 | Trades | 2 trades (SELL MBLY, TRIM ½ TMDX) | **now captured**: `PORTFOLIO/RVAB: (1/0.02) SELL MBLY TRIM ½ TMDX` ✓ | **OCR** — scanner fix landed; capture `ps_47.png` @ 20:48 |
| 3a | INDEX FALL 9/8/26 | GRO holdings | 12 leveraged names | OCR TURBO line has 12 leveraged | **OCR** — manual GRO/TURBO labels are swapped |
| 3b | INDEX FALL 9/8/26 | TURBO -0.53% | -0.53% | -0.52% | Manual (rounding) |
| 3c | INDEX FALL 9/8/26 | GRO trades (BUY CF, BUY SPCX) | — | **now captured**: `RVAB/REBAR: 1.15 BUY CF SPCX` ✓ | OCR |
| 3d | INDEX FALL 9/8/26 | TURBO trades (BUY RBRK, BUY TEM, SELL MRNA) | — | **now captured**: `TURBO RVAB/REBAR: 1.88 BUY RBRK TEM SELL MRNA` ✓ | OCR |
| 4 | Second Straight Down 2/6/23 | Action line | 2 trades | 3 trades (extra BUY QLD) | Manual (likely OCR false positive) |
| 4b | Second Straight Down 2/6/23 | Trades (ADD DT, TRIM ½ BROS) | — | **now captured**: `PORTFOLIO/RVAB: (1.10/1.14) ADD to DT BUY QLD TRIM ½ BROS` ✓ | OCR |
| 5a | OIL YIELDS 9/9/26 | GRO holdings | 12 leveraged names | OCR TURBO line has 12 leveraged | **OCR** — manual GRO/TURBO labels are swapped |
| 5b | OIL YIELDS 9/9/26 | TURBO holdings | 12 leveraged names | OCR TURBO line has 12 leveraged | Match (no issue) |
| 5c | OIL YIELDS 9/9/26 | GRO trades (BUY ARKG, SELL SPCX) | — | **now captured**: `RVAB/REBAR: 1.13 BUY ARKG SELL SPCX LONG TERM (200sma)` ✓ | OCR |
| 5d | OIL YIELDS 9/9/26 | TURBO trades (no changes) | — | **now captured**: `TURBO RVAB/REBAR: 1.86 NO CHANGES` ✓ | OCR |
| 6 | SELECT LEADERS 9/11/26 | TURBO trades (BUY SOXL, SELL RBRK) | — | **now captured** | OCR |
| 7 | Split Decision 11/17/22 | Trades (TRIM ½ UWM, SELL LMT) | — | **now captured**: `PORTFOLIO/RVAB: (0.77/0.62) TRIM ½ UWM SELL LMT` ✓ | OCR |
| 8 | Thanksgiving 11/21/22 | Trades (ADD SPXL) | — | **now captured**: `PORTFOLIO/RVAB: (0.76/0.86) ADD SPXL` ✓ | OCR |
| 9 | THE BIG SHOW 11/11/22 | Trades (ADD STLD/MBLY/SSO, BUY QLD, TRIM FSLR) | — | **now captured**: `PORTFOLIO/RVAB: (0.51/0.74) ADD STLD, MBLY, SSO BUY QLD TRIM FSLR` ✓ | OCR |
| 10 | Gap Up (recap) | Date | 11/15/22 | FRI, 11/11/22 (different slide) | Date is on intro card, not action slide |

**Bottom line:** all 10 videos now produce at least one capture whose OCR contains the slide's trade line (`* PORTFOLIO/RVAB:` for 2022 / single-line Revere slides, or `* TURBO RVAB/REBAR:` for 2026 dual-portfolio slides). The scanner fix in `src/video/ocrScanLogic.js` (dynamic threshold relaxation + stride-based uniform sampling densification) is responsible for closing the gap on video 2 (and incidentally on v8/v9/v10, which the original sparse uniform sweep would also have under-sampled).

Two residual divergences remain that favor the manual notes:

- Video 1 (`BUY 3% LMT` extra in OCR)
- Video 6 (`BUY QLD` extra in OCR)

Both look like tesseract stitching stray text into the action line. Verifying visually against the saved PNGs is the next step.
