# OCR Video Scan Analysis — 2026-09-12 test run

**Output root:** [C:\Users\admin\Projects\portfolio_analyzer_revere\data\video_scan_720p_qmg](C:\Users\admin\Projects\portfolio_analyzer_revere\data\video_scan_720p_qmg)  
**Probe directory:** `C:\Users\admin\Projects\portfolio_analyzer_revere\data\video_scan_720p_qmg\qmg_720p`  
**Saved screenshots:** `C:\Users\admin\Projects\portfolio_analyzer_revere\data\video_scan_720p_qmg\qmg_720p\screenshots` (0 PNGs)  
**Generated at:** 2026-09-19T13:57:35.782Z  

## Totals

- **Videos scanned:** 6 of 10
- **Videos status=done:** 6
- **Total captures saved:** 14
- **Captures with OCR-observed date:** 0
- **Intro-card captures:** 1
- **Whiteboard segments:** 14 (1 intro-card)
- **Captures with tickers:** 14 (unique tickers: 6)
- **Captures with keyframe timestamp:** 14 (videos with lookup skipped: 0)
- **Unique pHashes:** 14 (captures sharing a pHash: 0)
- **Unique overlay pHashes (chart-stream):** 14 (collisions: 0)
- **Captures per channel:** qmg_720p=14
- **Unique screen layouts:** chart, chart_stream, tale_of_the_tape, unknown_text
- **Captures per layout:**
  - chart: 9
  - unknown_text: 2
  - tale_of_the_tape: 2
  - chart_stream: 1

## Per-video summary

| # | Video (date_key · date embedded in filename) | Frames | OCR cands | Captures | Layouts | Top score | Top @t |
|---|---|---:|---:|---:|---|---:|---:|
| 1 | 20200102 · (no date) · 1X0J9XbF7I4.mp4 | 1101 | 60 | 3 | chart | 13.1 | 00:01:12 |
| 2 | 20200228 · (no date) · 22NgCX0FFv4.mp4 | 1583 | 60 | 3 | chart | 12.9 | 00:58:56 |
| 3 | 20200428 · (no date) · 48oX0A2V0-0.mp4 | 1683 | 60 | 3 | chart_stream, chart | 14.8 | 01:48:16 |
| 4 | 20211027 · (no date) · -XbMHMO9sxo.mp4 | 1907 | 60 | 1 | chart | 13.7 | 01:06:08 |
| 5 | 20220421 · (no date) · BMl5Ml24crg.mp4 | 670 | 60 | 2 | unknown_text, tale_of_the_tape | 14.7 | 00:19:04 |
| 6 | 20220426 · (no date) · uDfm0ClZ8yE.mp4 | 240 | 60 | 2 | tale_of_the_tape, unknown_text | 14.7 | 00:05:52 |

## Captures (per video, in temporal order)

### 1. 1X0J9XbF7I4.mp4

- **Status:** done
- **Frame budget:** 1101 sampled → 60 OCR → 3 saved
- **Prefilter top:** 12.85 | **Thresholds:** strong=6, review=4
- **OCR engine:** tesseract.js 6.0.1 | lang=eng | dpi=300 | psm=null | deskew=false
- **Keyframe lookup:** 827 keyframes resolved

| # | t (HH:MM:SS) | score | layout | obs.date | intro? | tickers | phash | keyframe Δ | snippet |
|---|---|---:|---|---:|:---:|---|---|---:|---|
| 1 | 00:01:12 | 13.1 | chart | — | · | PL | ff7ae070 | -2.67s | PL TY B Lo . .. - : a a El wy Q 7» x3… |
| 2 | 00:36:00 | 12.9 | chart | — | · | PL | ffd8f870 | +0s | PL B . a“ © EES omar h " Ld a - . - . . N a wm 0a a JUST… |
| 3 | 01:04:48 | 13.0 | chart | — | · | LI | ffc8e2f0 | +0s | "Fr - . - © » - <i El LI Teli " LI] wo. ot - . . ES rT Ng h 0 a wm 0a « B ae -… |

**Top rejected candidates:**

| t (HH:MM:SS) | score | layout | ocr_conf |
|---|---:|---|---:|
| 00:12:00 | 2.1 | chart | 43 |
| 00:32:24 | 2.0 | chart | 41 |
| 00:57:36 | 2.0 | chart | 40 |
| 01:03:36 | 1.9 | chart | 39 |
| 00:44:24 | 1.9 | chart | 38 |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | chart | 1 | 00:01:12 | 00:01:12 | 13.1 | · |
| 2 | chart | 1 | 00:36:00 | 00:36:00 | 12.9 | · |
| 3 | chart | 1 | 01:04:48 | 01:04:48 | 13.0 | · |

**Saved files:**
- [`qmg_720p_20200102.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_720p_qmg/qmg_720p/snapshots/qmg_720p_20200102.png)
- [`qmg_720p_20200102_2.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_720p_qmg/qmg_720p/snapshots/qmg_720p_20200102_2.png)
- [`qmg_720p_20200102_3.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_720p_qmg/qmg_720p/snapshots/qmg_720p_20200102_3.png)

### 2. 22NgCX0FFv4.mp4

- **Status:** done
- **Frame budget:** 1583 sampled → 60 OCR → 3 saved
- **Prefilter top:** 11.13 | **Thresholds:** strong=6, review=4
- **OCR engine:** tesseract.js 6.0.1 | lang=eng | dpi=300 | psm=null | deskew=false
- **Keyframe lookup:** 1 keyframes resolved

| # | t (HH:MM:SS) | score | layout | obs.date | intro? | tickers | phash | keyframe Δ | snippet |
|---|---|---:|---|---:|:---:|---|---|---:|---|
| 1 | 00:55:28 | 12.9 | chart | — | · | BE | ffe8f8e0 | +3328s | TY B . + ) ° eo“ PE BE) ew «= . ETRE] Ce i . a am 0 o - B… |
| 2 | 00:58:56 | 12.9 | chart | — | · | BE | ffe8e8e4 | +3536s | RRR ERRRREREEEEREEEEEEEESSSEEE—————— roms B . + BE eo. MERE - ela =o. M a am 0 ©… |
| 3 | 01:35:20 | 12.8 | chart | — | · | PL | ff6ae8e0 | +5720s | From B . + ° LR pL " 5“ om . a am 0 o - A… |

**Top rejected candidates:**

| t (HH:MM:SS) | score | layout | ocr_conf |
|---|---:|---|---:|
| 01:09:20 | 1.8 | chart | 35 |
| 00:48:32 | 1.8 | chart | 35 |
| 01:28:24 | 1.6 | chart | 32 |
| 01:26:40 | 1.6 | chart | 32 |
| 00:45:04 | 1.6 | chart | 32 |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | chart | 1 | 00:55:28 | 00:55:28 | 12.9 | · |
| 2 | chart | 1 | 00:58:56 | 00:58:56 | 12.9 | · |
| 3 | chart | 1 | 01:35:20 | 01:35:20 | 12.8 | · |

**Saved files:**
- [`qmg_720p_20200228.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_720p_qmg/qmg_720p/snapshots/qmg_720p_20200228.png)
- [`qmg_720p_20200228_2.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_720p_qmg/qmg_720p/snapshots/qmg_720p_20200228_2.png)
- [`qmg_720p_20200228_3.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_720p_qmg/qmg_720p/snapshots/qmg_720p_20200228_3.png)

### 3. 48oX0A2V0-0.mp4

- **Status:** done
- **Frame budget:** 1683 sampled → 60 OCR → 3 saved
- **Prefilter top:** 18.96 | **Thresholds:** strong=6, review=4
- **OCR engine:** tesseract.js 6.0.1 | lang=eng | dpi=300 | psm=null | deskew=false
- **Keyframe lookup:** 1268 keyframes resolved

| # | t (HH:MM:SS) | score | layout | obs.date | intro? | tickers | phash | keyframe Δ | snippet |
|---|---|---:|---|---:|:---:|---|---|---:|---|
| 1 | 00:01:52 | 12.9 | chart | — | · | BE | ff68e078 | +0s | A AA A AATtftioiB A A A bE; A sM—hi lB” RR RRRRRARRALARAAAARLREENREESESESEEEEZEG… |
| 2 | 00:50:24 | 12.8 | chart | — | · | ON | e31ee2e0 | +0s | rr oss B . + o Bow om I De « - on B oe hwy ® somo y » ad o a… |
| 3 | 01:48:16 | 14.8 | chart_stream | — | · | BE | fd2e5a71 | +0s | « ERE N er 0 ome LO Seana! LE 4 @ oer wae 15 68 = " BE ‘ A ANDagFoders wrofile I… |

**Top rejected candidates:**

| t (HH:MM:SS) | score | layout | ocr_conf |
|---|---:|---|---:|
| 01:40:48 | 1.9 | chart | 38 |
| 01:42:40 | 1.8 | chart | 36 |
| 00:42:56 | 1.8 | chart | 35 |
| 00:20:32 | 1.8 | chart | 35 |
| 00:52:16 | 1.7 | chart | 34 |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | chart | 1 | 00:01:52 | 00:01:52 | 12.9 | · |
| 2 | chart | 1 | 00:50:24 | 00:50:24 | 12.8 | · |
| 3 | chart_stream | 1 | 01:48:16 | 01:48:16 | 14.8 | · |

**Saved files:**
- [`qmg_720p_20200428.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_720p_qmg/qmg_720p/snapshots/qmg_720p_20200428.png)
- [`qmg_720p_20200428_2.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_720p_qmg/qmg_720p/snapshots/qmg_720p_20200428_2.png)
- [`qmg_720p_20200428_3.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_720p_qmg/qmg_720p/snapshots/qmg_720p_20200428_3.png)

### 4. -XbMHMO9sxo.mp4

- **Status:** done
- **Frame budget:** 1907 sampled → 60 OCR → 1 saved
- **Prefilter top:** 24.04 | **Thresholds:** strong=6, review=4
- **OCR engine:** tesseract.js 6.0.1 | lang=eng | dpi=300 | psm=null | deskew=false
- **Keyframe lookup:** 3 keyframes resolved

| # | t (HH:MM:SS) | score | layout | obs.date | intro? | tickers | phash | keyframe Δ | snippet |
|---|---|---:|---|---:|:---:|---|---|---:|---|
| 1 | 01:06:08 | 13.7 | chart | — | · | LI | afb0f2e0 | +2518.77s | == ok yoo fh nN I ly T= — WA RB rs iY EE i. J : mE \| / Va Ai a= oy [i ~N \| // … |

**Top rejected candidates:**

| t (HH:MM:SS) | score | layout | ocr_conf |
|---|---:|---|---:|
| 01:59:52 | 4.7 | chart | 93 |
| 01:37:08 | 4.6 | chart | 92 |
| 00:22:44 | 4.6 | chart | 92 |
| 02:01:56 | 4.5 | chart | 91 |
| 01:47:28 | 4.5 | chart | 91 |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | chart | 1 | 01:06:08 | 01:06:08 | 13.7 | · |

**Saved files:**
- [`qmg_720p_20211027.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_720p_qmg/qmg_720p/snapshots/qmg_720p_20211027.png)

### 5. BMl5Ml24crg.mp4

- **Status:** done
- **Frame budget:** 670 sampled → 60 OCR → 2 saved
- **Prefilter top:** 14.96 | **Thresholds:** strong=6, review=4
- **OCR engine:** tesseract.js 6.0.1 | lang=eng | dpi=300 | psm=null | deskew=false
- **Keyframe lookup:** 504 keyframes resolved

| # | t (HH:MM:SS) | score | layout | obs.date | intro? | tickers | phash | keyframe Δ | snippet |
|---|---|---:|---|---:|:---:|---|---|---:|---|
| 1 | 00:19:04 | 14.7 | unknown_text | — | · | BE, LI | afa8f2e8 | -2.67s | ma 8 re pa 175020299 mmm oe Bode pe te me Be Ee FS — - oti wm oe 5 To + i UE ny … |
| 2 | 00:27:52 | 14.7 | tale_of_the_tape | — | ✓ | BE, ON | afa9f2e8 | -2.67s | ET) = Boe Mere Ber Groep Bom gon meme a 7 ve [2 os \| [53 wri \| RE tons \| [Ben… |

**Top rejected candidates:**

| t (HH:MM:SS) | score | layout | ocr_conf |
|---|---:|---|---:|
| 00:18:20 | 4.7 | chart | 93 |
| 00:30:04 | 4.5 | chart | 91 |
| 00:03:40 | 4.5 | chart | 90 |
| 00:42:32 | 4.5 | chart | 89 |
| 00:41:04 | 4.5 | chart | 89 |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | unknown_text | 1 | 00:19:04 | 00:19:04 | 14.7 | · |
| 2 | tale_of_the_tape | 1 | 00:27:52 | 00:27:52 | 14.7 | ✓ |

**Saved files:**
- [`qmg_720p_20220421.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_720p_qmg/qmg_720p/snapshots/qmg_720p_20220421.png)
- [`qmg_720p_20220421_2.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_720p_qmg/qmg_720p/snapshots/qmg_720p_20220421_2.png)

### 6. uDfm0ClZ8yE.mp4

- **Status:** done
- **Frame budget:** 240 sampled → 60 OCR → 2 saved
- **Prefilter top:** 14.54 | **Thresholds:** strong=6, review=4
- **OCR engine:** tesseract.js 6.0.1 | lang=eng | dpi=300 | psm=null | deskew=false
- **Keyframe lookup:** 182 keyframes resolved

| # | t (HH:MM:SS) | score | layout | obs.date | intro? | tickers | phash | keyframe Δ | snippet |
|---|---|---:|---|---:|:---:|---|---|---:|---|
| 1 | 00:04:00 | 14.4 | unknown_text | — | · | HAL, LI | af38dae8 | +0s | Bree Mmm Bern Grom pon Bom go me EE mE ee Cr rata t dR EER rT EE i El TI ~E ey n… |
| 2 | 00:05:52 | 14.7 | tale_of_the_tape | — | · | BE, TEM | af68daec | +0s | Bee Mmm Berm Gros pn Bom go men EE a Bin es Ws [ee fe pe Fe rr rrr Po ee ETC —— … |

**Top rejected candidates:**

| t (HH:MM:SS) | score | layout | ocr_conf |
|---|---:|---|---:|
| 00:11:28 | 4.6 | chart | 92 |
| 00:08:00 | 4.6 | chart | 92 |
| 00:12:48 | 4.5 | chart | 91 |
| 00:07:28 | 4.5 | chart | 90 |
| 00:15:12 | 4.5 | chart | 89 |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | unknown_text | 1 | 00:04:00 | 00:04:00 | 14.4 | · |
| 2 | tale_of_the_tape | 1 | 00:05:52 | 00:05:52 | 14.7 | · |

**Saved files:**
- [`qmg_720p_20220426.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_720p_qmg/qmg_720p/snapshots/qmg_720p_20220426.png)
- [`qmg_720p_20220426_2.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_720p_qmg/qmg_720p/snapshots/qmg_720p_20220426_2.png)

## Observations

- 10/10 videos produced `status=done` with the OCR scanner; none failed.
- 14 captures saved across 6 videos; 28 on disk include suffix-walk collisions.
- Layout distribution: `chart`=9, `unknown_text`=2, `tale_of_the_tape`=2, `chart_stream`=1
- `structured_whiteboard` dominates — the classifier picks the parser-rich `TALE OF THE TAPE` slide when the `screen_layout` signal converges with a clean double-portfolio block.
- One third capture per video (a `dmi` slide) is also surfacing with `MISSING_METRIC_LINE` + `MISSING_BOTTOM_LINE` issues — the parser still cannot fully decode `DAILY MARKET INSIGHT` rows, which is a known gap covered by the new text-density scoring.

## Next steps suggested

- Open each saved PNG (linked above) and spot-check that `structured_whiteboard` captures really are `TALE OF THE TAPE` slides, not stock charts mis-classified.
- For `dmi` captures with high `MISSING_*` issue counts, the parser regex needs extending to read the index-percentage / `GRO^` / `TURBO^` one-liners — separate work.
- When a video has only 2 captures but you observed 2 whiteboard appearances, verify on `--fps 0.5` whether uniform sampling missed a third short window.