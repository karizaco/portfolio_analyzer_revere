# OCR Video Scan Analysis — 2026-09-12 test run

**Output root:** [C:\Users\admin\Projects\portfolio_analyzer_revere\data\video_scan_20260914\fields-v2](C:\Users\admin\Projects\portfolio_analyzer_revere\data\video_scan_20260914\fields-v2)  
**Probe directory:** `C:\Users\admin\Projects\portfolio_analyzer_revere\data\video_scan_20260914\fields-v2\ocr_probe\logs`  
**Saved screenshots:** `C:\Users\admin\Projects\portfolio_analyzer_revere\data\video_scan_20260914\fields-v2\screenshots` (50 PNGs)  
**Generated at:** 2026-09-13T15:38:30.722Z  

## Totals

- **Videos scanned:** 10 of 10
- **Videos status=done:** 10
- **Total captures saved:** 50
- **Captures with OCR-observed date:** 44
- **Intro-card captures:** 7
- **Whiteboard segments:** 25 (3 intro-card)
- **Captures with tickers:** 42 (unique tickers: 30)
- **Captures with keyframe timestamp:** 50 (videos with lookup skipped: 0)
- **Unique pHashes:** 24 (captures sharing a pHash: 26)
- **Unique screen layouts:** dmi, structured_whiteboard, tale_of_the_tape
- **Captures per layout:**
  - dmi: 37
  - structured_whiteboard: 10
  - tale_of_the_tape: 3

## Per-video summary

| # | Video (date_key · date embedded in filename) | Frames | OCR cands | Captures | Layouts | Top score | Top @t |
|---|---|---:|---:|---:|---|---:|---:|
| 1 | 20260912 · (no date) · Gap Up...Chop Around...Break Down...Bounce Whats The Bot… | 423 | 60 | 5 | dmi | 98.6 | 00:14:28 |
| 2 | 20260912 · (no date) · Going Nowhere Day 12 Can These Recent Breakouts Offer Ho… | 497 | 60 | 5 | dmi, tale_of_the_tape | 90.3 | 00:23:28 |
| 3 | 20260912 · (no date) · INDEX FALL ON MID EAST TENSIONS AS MKT AWAITS CPI PPI SP… | 245 | 60 | 5 | structured_whiteboard, dmi | 100.4 | 00:08:16 |
| 4 | 20260912 · (no date) · Indexes Log a Negative Reversal...Is it Normal Action.mp… | 349 | 60 | 5 | dmi | 92.4 | 00:13:20 |
| 5 | 20260912 · (no date) · OIL YIELDS AND GEOPOLITICAL TENSIONS CONTINUE TO ACT AS … | 221 | 60 | 5 | structured_whiteboard, dmi | 119.6 | 00:06:36 |
| 6 | 20260912 · (no date) · Second Straight Down Day...Here are the Key Levels That … | 307 | 60 | 5 | dmi | 92.7 | 00:13:40 |
| 7 | 20260912 · (no date) · SELECT LEADERS STANDOUT AS INDEXES SNAP BACK DESPITE HOT… | 729 | 60 | 5 | structured_whiteboard | 104.4 | 00:20:48 |
| 8 | 20260912 · (no date) · Split Decision Day As Both Bulls AND Bears Have Mixed Em… | 357 | 60 | 5 | dmi | 95.1 | 00:18:00 |
| 9 | 20260912 · (no date) · Thanksgiving Week Kicks Off With a Yawn But We Did Add t… | 314 | 60 | 5 | dmi | 94.7 | 00:12:40 |
| 10 | 20260912 · (no date) · THE BIG SHOW...The Sector Rotation Rally Edition.mp4 | 483 | 60 | 5 | dmi, tale_of_the_tape | 81.7 | 00:17:36 |

## Captures (per video, in temporal order)

### 1. Gap Up...Chop Around...Break Down...Bounce Whats The Bottom Line.mp4

- **Status:** done
- **Frame budget:** 423 sampled → 60 OCR → 5 saved
- **Prefilter top:** 12.26 | **Thresholds:** strong=6, review=4
- **OCR engine:** tesseract.js 6.0.1 | lang=eng | dpi=300 | psm=null | deskew=false
- **Keyframe lookup:** 1 keyframes resolved

| # | t (HH:MM:SS) | score | layout | obs.date | intro? | tickers | phash | keyframe Δ | snippet |
|---|---|---:|---|---:|:---:|---|---|---:|---|
| 1 | 00:13:04 | 96.5 | dmi | 20221115 | · | PL, QLD, SSO | d5ff2ac0 | +784s | >> TALE OF THE TAPE — TUE, 11/15/22 << * MARKET STATE: BEAR MARKET RALLY > R * H… |
| 2 | 00:14:28 | 98.6 | dmi | 20221115 | · | PL, QLD, SSO | d5ff2ac0 | +868s | >> TALE OF THE TAPE — TUE, 11/15/22 << * MARKET STATE: BEAR MARKET RALLY > R * H… |
| 3 | 00:15:24 | 96.2 | dmi | 20221115 | · | PL, QLD | d5ff2ac0 | +924s | >> TALE OF THE TAPE — TUE, 11/15/22 << * MARKET STATE: BEAR MARKET RALLY > R * H… |
| 4 | 00:18:40 | 97.0 | dmi | 20221115 | · | SSO | d5ff2a80 | +1120s | >> TALE OF THE TAPE — TUE, 11/15/22 << * MARKET STATE: BEAR MARKET RALLY > R * H… |
| 5 | 00:21:28 | 97.3 | dmi | 20221115 | · | BE, PL, QLD, SSO | d5ff2a80 | +1288s | >> TALE OF THE TAPE — TUE, 11/15/22 << * MARKET STATE: BEAR MARKET RALLY > R * H… |

**Top rejected candidates:**

| t (HH:MM:SS) | score | layout | ocr_conf |
|---|---:|---|---:|
| 00:17:44 | -21.6 | tale_of_the_tape | 35 |
| 00:26:08 | -21.6 | tale_of_the_tape | 36 |
| 00:21:56 | -22.1 | tale_of_the_tape | 33 |
| 00:27:04 | -22.1 | tale_of_the_tape | 34 |
| 00:08:24 | -22.2 | tale_of_the_tape | 40 |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | dmi | 1 | 00:13:04 | 00:13:04 | 96.5 | · |
| 2 | dmi | 2 | 00:14:28 | 00:15:24 | 98.6 | · |
| 3 | dmi | 1 | 00:18:40 | 00:18:40 | 97.0 | · |
| 4 | dmi | 1 | 00:21:28 | 00:21:28 | 97.3 | · |

**Saved files:**
- [`20260912_ps.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps.png)
- [`20260912_ps_2.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_2.png)
- [`20260912_ps_3.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_3.png)
- [`20260912_ps_4.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_4.png)
- [`20260912_ps_5.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_5.png)

### 2. Going Nowhere Day 12 Can These Recent Breakouts Offer Hope to Bu.mp4

- **Status:** done
- **Frame budget:** 497 sampled → 60 OCR → 5 saved
- **Prefilter top:** 10.6 | **Thresholds:** strong=6, review=4
- **OCR engine:** tesseract.js 6.0.1 | lang=eng | dpi=300 | psm=null | deskew=false
- **Keyframe lookup:** 356 keyframes resolved

| # | t (HH:MM:SS) | score | layout | obs.date | intro? | tickers | phash | keyframe Δ | snippet |
|---|---|---:|---|---:|:---:|---|---|---:|---|
| 1 | 00:03:44 | 66.6 | dmi | 20230104 | · | BABA, SLY | d5bf0a40 | -0.12s | > REVERE ASSET MANAGEMENT < e, — NT RATES, RUSSIA/UKRAINE [LEY ar. Ee > DAILY MA… |
| 2 | 00:05:20 | 60.7 | dmi | 20230104 | · | — | d5bf6850 | +0.63s | > REVERE ASSET MANAGEMENT < 0 = ErYyes ony \|,_woomy \| 3000 [ «\| Gn yo [EE > D… |
| 3 | 00:20:48 | 89.1 | dmi | 20230104 | · | BABA, SLY | d5bf2a40 | -1.47s | »> TALE OF THE TAPE - WED, 1/4/23 << [ 5 \| * MARKET STATE: * HEADWINDS: USD, IN… |
| 4 | 00:23:28 | 90.3 | dmi | 20230104 | · | BABA | d5bf2a40 | +1.64s | 2» TALE OF THE TAPE - WED, 1/4/23 << [ >\| MARKET STATE: * HEADWINDS: USD, INFLA… |
| 5 | 00:25:36 | 82.3 | tale_of_the_tape | 20230104 | · | BABA, SLY, TER | d5bf2a40 | +0.77s | > TALE OF THE TAPE — WED, 1/4/23 << ' >\| * MARKEY STATE: * HEADWINDS: USD, INFL… |

**Top rejected candidates:**

| t (HH:MM:SS) | score | layout | ocr_conf |
|---|---:|---|---:|
| 00:15:28 | -20.5 | tale_of_the_tape | 42 |
| 00:14:56 | -20.6 | tale_of_the_tape | 42 |
| 00:11:12 | -21.9 | tale_of_the_tape | 42 |
| 00:06:56 | -22.1 | tale_of_the_tape | 43 |
| 00:06:24 | -22.3 | tale_of_the_tape | 39 |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | dmi | 1 | 00:03:44 | 00:03:44 | 66.6 | · |
| 2 | dmi | 1 | 00:05:20 | 00:05:20 | 60.7 | · |
| 3 | dmi | 1 | 00:20:48 | 00:20:48 | 89.1 | · |
| 4 | dmi | 1 | 00:23:28 | 00:23:28 | 90.3 | · |
| 5 | tale_of_the_tape | 1 | 00:25:36 | 00:25:36 | 82.3 | · |

**Saved files:**
- [`20260912_ps_6.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_6.png)
- [`20260912_ps_7.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_7.png)
- [`20260912_ps_8.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_8.png)
- [`20260912_ps_9.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_9.png)
- [`20260912_ps_10.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_10.png)

### 3. INDEX FALL ON MID EAST TENSIONS AS MKT AWAITS CPI PPI SPCX AMD I.mp4

- **Status:** done
- **Frame budget:** 245 sampled → 60 OCR → 5 saved
- **Prefilter top:** 22.06 | **Thresholds:** strong=6, review=4
- **OCR engine:** tesseract.js 6.0.1 | lang=eng | dpi=300 | psm=null | deskew=false
- **Keyframe lookup:** 192 keyframes resolved

| # | t (HH:MM:SS) | score | layout | obs.date | intro? | tickers | phash | keyframe Δ | snippet |
|---|---|---:|---|---:|:---:|---|---|---:|---|
| 1 | 00:00:32 | 55.0 | dmi | 20260908 | ✓ | — | c699f74d | +2.24s | >>> THE REVERE ROUNDUP <<< WHATS THE MARKET TREND? —_— “THE GROTECTION GAUGE" 22… |
| 2 | 00:01:36 | 53.6 | dmi | 20260908 | ✓ | — | c699f74d | -0.8s | >>> THE REVERE ROUNDUP <<< WHATS THE MARKET TREND? —_— “THE GROTECTION GAUGE" >>… |
| 3 | 00:06:08 | 100.3 | structured_whiteboard | 20260908 | · | CF, ETHA, FCX, GDXU (+16) | be69c194 | -1.92s | >> TALE OF THE TAPE = TUESDAY, SEPTEMBER 8, 2026 << * MARKET STATE; UPTREND *STO… |
| 4 | 00:07:12 | 100.3 | structured_whiteboard | 20260908 | · | CF, ETHA, FCX, GDXU (+15) | be6bc194 | +0s | >> TALE OF THE TAPE ~ TUESDAY, SEPTEMBER 8, 2026 << * MARKET STATE: UPTREND *STO… |
| 5 | 00:08:16 | 100.4 | structured_whiteboard | 20260908 | · | CF, ETHA, FCX, GDXU (+15) | be69c194 | -1.76s | >> TALE OF THE TAPE ~ TUESDAY, SEPTEMBER 8, 2026 << * MARKET STATE: UPTREND *STO… |

**Top rejected candidates:**

| t (HH:MM:SS) | score | layout | ocr_conf |
|---|---:|---|---:|
| 00:00:00 | -14.7 | chart | 0 |
| 00:05:20 | -20.4 | tale_of_the_tape | 33 |
| 00:04:32 | -20.6 | chart | 27 |
| 00:05:04 | -20.8 | tale_of_the_tape | 32 |
| 00:15:12 | -20.9 | chart | 23 |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | dmi | 2 | 00:00:32 | 00:01:36 | 55.0 | ✓ |
| 2 | structured_whiteboard | 3 | 00:06:08 | 00:08:16 | 100.4 | · |

**Saved files:**
- [`20260912_ps_11.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_11.png)
- [`20260912_ps_12.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_12.png)
- [`20260912_ps_13.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_13.png)
- [`20260912_ps_14.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_14.png)
- [`20260912_ps_15.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_15.png)

### 4. Indexes Log a Negative Reversal...Is it Normal Action.mp4

- **Status:** done
- **Frame budget:** 349 sampled → 60 OCR → 5 saved
- **Prefilter top:** 11.28 | **Thresholds:** strong=6, review=4
- **OCR engine:** tesseract.js 6.0.1 | lang=eng | dpi=300 | psm=null | deskew=false
- **Keyframe lookup:** 263 keyframes resolved

| # | t (HH:MM:SS) | score | layout | obs.date | intro? | tickers | phash | keyframe Δ | snippet |
|---|---|---:|---|---:|:---:|---|---|---:|---|
| 1 | 00:00:00 | 61.0 | dmi | 20221114 | ✓ | — | c79df54c | +0s | 2 WHAT'S THE MARKET TREND? © men - Qa wm THE GROTECTION GAUGE" > REVERE ASSET MA… |
| 2 | 00:01:20 | 60.7 | dmi | 20221114 | ✓ | — | c79df54c | +0s | 2 WHAT'S THE MARKET TREND? © smn us - Qa wm THE GROTECTION GAUGE" > REVERE ASSET… |
| 3 | 00:12:20 | 92.4 | dmi | 20221114 | · | QLD | d5ff2a80 | -1.33s | 2> TALE OF THE TAPE — MON, 11/14/22 << * MARKET STATE: BEAR MARKET RALLY > B * H… |
| 4 | 00:13:20 | 92.4 | dmi | 20221114 | · | QLD | d5ff2a80 | +0s | 2> TALE OF THE TAPE - MON, 11/14/22 << * MARKET STATE: BEAR MARKET RALLY > B * H… |
| 5 | 00:14:00 | 92.4 | dmi | 20221114 | · | QLD | d5ff2a80 | -2.67s | 2> TALE OF THE TAPE - MON, 11/14/22 << * MARKET STATE: BEAR MARKET RALLY > B * H… |

**Top rejected candidates:**

| t (HH:MM:SS) | score | layout | ocr_conf |
|---|---:|---|---:|
| 00:10:40 | -20.0 | tale_of_the_tape | 40 |
| 00:19:20 | -21.7 | tale_of_the_tape | 37 |
| 00:17:00 | -22.3 | tale_of_the_tape | 29 |
| 00:15:40 | -22.6 | tale_of_the_tape | 33 |
| 00:15:20 | -22.6 | tale_of_the_tape | 36 |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | dmi | 2 | 00:00:00 | 00:01:20 | 61.0 | ✓ |
| 2 | dmi | 3 | 00:12:20 | 00:14:00 | 92.4 | · |

**Saved files:**
- [`20260912_ps_16.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_16.png)
- [`20260912_ps_17.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_17.png)
- [`20260912_ps_18.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_18.png)
- [`20260912_ps_19.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_19.png)
- [`20260912_ps_20.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_20.png)

### 5. OIL YIELDS AND GEOPOLITICAL TENSIONS CONTINUE TO ACT AS A HEADWI.mp4

- **Status:** done
- **Frame budget:** 221 sampled → 60 OCR → 5 saved
- **Prefilter top:** 18.86 | **Thresholds:** strong=6, review=4
- **OCR engine:** tesseract.js 6.0.1 | lang=eng | dpi=300 | psm=null | deskew=false
- **Keyframe lookup:** 179 keyframes resolved

| # | t (HH:MM:SS) | score | layout | obs.date | intro? | tickers | phash | keyframe Δ | snippet |
|---|---|---:|---|---:|:---:|---|---|---:|---|
| 1 | 00:00:12 | 54.1 | dmi | 20260909 | ✓ | — | c495e46c | +2.08s | # Preview File Edi View Go Tools Window Help [=3 [CH] BC d 8 ® L WF Q 8 © WedSep… |
| 2 | 00:01:00 | 52.7 | dmi | 20260909 | ✓ | BE | c495e46c | -0.12s | # Proview File Edi View Go Tools Window Help [3 [CH] Me 8 ® bm FQ Be © WedSepd 5… |
| 3 | 00:01:48 | 57.4 | dmi | 20260909 | ✓ | — | c495e46c | -1.96s | WHAT'S THE MARKET TREND? >>> THE REVERE ROUNDUP <<< THE GROTECTION GAUGE" >>> DA… |
| 4 | 00:05:12 | 119.3 | structured_whiteboard | 20260909 | · | ARKG, CF, ETHA, FCX (+11) | c091a52d | +1.2s | ® Preview Fle ER View Go Tools Window Hep GC ®0 nc i WO LW FQ 8 @ WedSepd SOM ea… |
| 5 | 00:06:36 | 119.6 | structured_whiteboard | 20260909 | · | ARKG, CF, ETHA, FCX (+12) | c091a52d | +1.12s | ® Preview Flo ER View Go Tools Window Hep CG ®O ac dl #0 Lm TQ 8 8 Wedteps S0ePM… |

**Top rejected candidates:**

| t (HH:MM:SS) | score | layout | ocr_conf |
|---|---:|---|---:|
| 00:00:00 | -16.0 | chart | 0 |
| 00:07:24 | -21.8 | tale_of_the_tape | 33 |
| 00:10:36 | -22.4 | tale_of_the_tape | 34 |
| 00:11:48 | -22.5 | tale_of_the_tape | 35 |
| 00:04:00 | -22.5 | tale_of_the_tape | 37 |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | dmi | 3 | 00:00:12 | 00:01:48 | 57.4 | ✓ |
| 2 | structured_whiteboard | 1 | 00:05:12 | 00:05:12 | 119.3 | · |
| 3 | structured_whiteboard | 1 | 00:06:36 | 00:06:36 | 119.6 | · |

**Saved files:**
- [`20260912_ps_21.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_21.png)
- [`20260912_ps_22.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_22.png)
- [`20260912_ps_23.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_23.png)
- [`20260912_ps_24.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_24.png)
- [`20260912_ps_25.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_25.png)

### 6. Second Straight Down Day...Here are the Key Levels That Bulls Ne.mp4

- **Status:** done
- **Frame budget:** 307 sampled → 60 OCR → 5 saved
- **Prefilter top:** 11.53 | **Thresholds:** strong=6, review=4
- **OCR engine:** tesseract.js 6.0.1 | lang=eng | dpi=300 | psm=null | deskew=false
- **Keyframe lookup:** 245 keyframes resolved

| # | t (HH:MM:SS) | score | layout | obs.date | intro? | tickers | phash | keyframe Δ | snippet |
|---|---|---:|---|---:|:---:|---|---|---:|---|
| 1 | 00:12:20 | 91.2 | dmi | 20230206 | · | BE, TAN, TSLA | d5ff2a80 | -0.6s | > TALE OF THE TAPE — MON, 2/6/23 << * MARKET STATE: UPTRENDI »\| *HEADWINDS: INF… |
| 2 | 00:13:00 | 85.9 | dmi | 20230206 | · | PL, TSLA | d5ff2a80 | -0.91s | »> TALE OF THE TAPE — MON, 2/6/23 << ¢ * MARKET STATE: UPTRENDI \| *HEADWINDS: I… |
| 3 | 00:13:40 | 92.7 | dmi | 20230206 | · | BE | d5ff2a80 | -1.21s | 2 TALE OF THE TAPE — MON, 2/6/23 << ! * MARKET STATE: UPTREND > * HEADWINDS: INF… |
| 4 | 00:14:40 | 87.3 | dmi | 20230206 | · | BE, TSLA | d5ff2a80 | -1.67s | > TALE OF THE TAPE — MON, 2/6/23 << hi * MARKET STATE: UPTREND! 5 *HEADWINDS: IN… |
| 5 | 00:15:40 | 87.6 | dmi | 20230206 | · | BE, SSO, TSLA | d5ff2a80 | -2.12s | > TALE OF THE TAPE — MON, 2/6/23 << ’ * MARKET STATE: UPTREND 5 * HEADWINDS: INF… |

**Top rejected candidates:**

| t (HH:MM:SS) | score | layout | ocr_conf |
|---|---:|---|---:|
| 00:16:40 | -12.3 | tale_of_the_tape | 38 |
| 00:09:00 | -20.1 | tale_of_the_tape | 39 |
| 00:08:40 | -20.1 | tale_of_the_tape | 39 |
| 00:08:20 | -20.1 | unknown_text | 39 |
| 00:06:00 | -20.5 | tale_of_the_tape | 40 |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | dmi | 5 | 00:12:20 | 00:15:40 | 92.7 | · |

**Saved files:**
- [`20260912_ps_31.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_31.png)
- [`20260912_ps_32.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_32.png)
- [`20260912_ps_33.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_33.png)
- [`20260912_ps_34.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_34.png)
- [`20260912_ps_35.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_35.png)

### 7. SELECT LEADERS STANDOUT AS INDEXES SNAP BACK DESPITE HOT CPI PRI.mp4

- **Status:** done
- **Frame budget:** 729 sampled → 60 OCR → 5 saved
- **Prefilter top:** 18.4 | **Thresholds:** strong=6, review=4
- **OCR engine:** tesseract.js 6.0.1 | lang=eng | dpi=300 | psm=null | deskew=false
- **Keyframe lookup:** 684 keyframes resolved

| # | t (HH:MM:SS) | score | layout | obs.date | intro? | tickers | phash | keyframe Δ | snippet |
|---|---|---:|---|---:|:---:|---|---|---:|---|
| 1 | 00:16:48 | 104.2 | structured_whiteboard | 20260911 | · | CF, ETHA, FCX, GDXU (+8) | 94686b97 | +1.07s | > TALE OF THE TAPE — THURSDAY, SEPTEMBER 11, 2026 << * MARKET STATE: "STOINDEXES… |
| 2 | 00:18:24 | 104.4 | structured_whiteboard | 20260911 | · | CF, ETHA, FCX, GDXU (+11) | 94686b97 | -1.07s | > TALE OF THE TAPE — THURSDAY, SEPTEMBER 11, 2026 << * MARKET STATE: *STOINDEXES… |
| 3 | 00:19:12 | 104.4 | structured_whiteboard | 20260911 | · | CF, ETHA, FCX, GDXU (+11) | 94686b97 | +0s | > TALE OF THE TAPE — THURSDAY, SEPTEMBER 11, 2026 << * MARKET STATE: *STOINDEXES… |
| 4 | 00:20:00 | 104.4 | structured_whiteboard | 20260911 | · | CF, ETHA, FCX, GDXU (+8) | 94686b97 | +1.07s | > TALE OF THE TAPE — THURSDAY, SEPTEMBER 11, 2026 << * MARKET STATE: *STOINDEXES… |
| 5 | 00:20:48 | 104.4 | structured_whiteboard | 20260911 | · | CF, ETHA, FCX, GDXU (+11) | 94686b97 | -2.13s | > TALE OF THE TAPE — THURSDAY, SEPTEMBER 11, 2026 << * MARKET STATE: *STOINDEXES… |

**Top rejected candidates:**

| t (HH:MM:SS) | score | layout | ocr_conf |
|---|---:|---|---:|
| 00:47:12 | -24.1 | tale_of_the_tape | 35 |
| 00:14:24 | -25.3 | tale_of_the_tape | 35 |
| 00:40:00 | -25.5 | tale_of_the_tape | 34 |
| 00:11:12 | -26.1 | tale_of_the_tape | 39 |
| 00:34:24 | -26.1 | tale_of_the_tape | 38 |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | structured_whiteboard | 1 | 00:16:48 | 00:16:48 | 104.2 | · |
| 2 | structured_whiteboard | 4 | 00:18:24 | 00:20:48 | 104.4 | · |

**Saved files:**
- [`20260912_ps_26.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_26.png)
- [`20260912_ps_27.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_27.png)
- [`20260912_ps_28.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_28.png)
- [`20260912_ps_29.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_29.png)
- [`20260912_ps_30.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_30.png)

### 8. Split Decision Day As Both Bulls AND Bears Have Mixed Emotions.mp4

- **Status:** done
- **Frame budget:** 357 sampled → 60 OCR → 5 saved
- **Prefilter top:** 12.51 | **Thresholds:** strong=6, review=4
- **OCR engine:** tesseract.js 6.0.1 | lang=eng | dpi=300 | psm=null | deskew=false
- **Keyframe lookup:** 269 keyframes resolved

| # | t (HH:MM:SS) | score | layout | obs.date | intro? | tickers | phash | keyframe Δ | snippet |
|---|---|---:|---|---:|:---:|---|---|---:|---|
| 1 | 00:12:40 | 93.1 | dmi | — | · | NVDA, TAN | d5ff2a80 | -2.67s | >> TALE OF THE TAPE - THUR, 13/17/22 << * MARKET STATE: BEAR MARKET RALLY 5 \| *… |
| 2 | 00:13:20 | 93.6 | dmi | — | · | NVDA, TAN | d5ff2a80 | +0s | >> TALE OF THE TAPE - THUR, 13/17/22 << * MARKET STATE: BEAR MARKET RALLY 5. \| … |
| 3 | 00:14:20 | 92.9 | dmi | — | · | NVDA, TAN | d5ff2a80 | +1.33s | >> TALE OF THE TAPE - THUR, 13/17/22 << * MARKET STATE: BEAR MARKET RALLY 5 \| *… |
| 4 | 00:15:00 | 94.2 | dmi | — | · | NVDA, TAN | d5ff2a80 | -1.33s | >> TALE OF THE TAPE - THUR, 13/17/22 << * MARKET STATE: BEAR MARKET RALLY 5 \| *… |
| 5 | 00:18:00 | 95.1 | dmi | 20221117 | · | NVDA, TAN | d5ff2a80 | -2.67s | >> TALE OF THE TAPE - THUR, 11/17/22 << * MARKET STATE: BEAR MARKET RALLY 5 \| *… |

**Top rejected candidates:**

| t (HH:MM:SS) | score | layout | ocr_conf |
|---|---:|---|---:|
| 00:10:20 | -20.1 | tale_of_the_tape | 39 |
| 00:19:40 | -21.4 | tale_of_the_tape | 35 |
| 00:16:00 | -21.6 | tale_of_the_tape | 33 |
| 00:15:40 | -21.7 | tale_of_the_tape | 31 |
| 00:07:00 | -21.7 | tale_of_the_tape | 38 |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | dmi | 4 | 00:12:40 | 00:15:00 | 94.2 | · |
| 2 | dmi | 1 | 00:18:00 | 00:18:00 | 95.1 | · |

**Saved files:**
- [`20260912_ps_36.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_36.png)
- [`20260912_ps_37.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_37.png)
- [`20260912_ps_38.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_38.png)
- [`20260912_ps_39.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_39.png)
- [`20260912_ps_40.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_40.png)

### 9. Thanksgiving Week Kicks Off With a Yawn But We Did Add to a Posi.mp4

- **Status:** done
- **Frame budget:** 314 sampled → 60 OCR → 5 saved
- **Prefilter top:** 11.99 | **Thresholds:** strong=6, review=4
- **OCR engine:** tesseract.js 6.0.1 | lang=eng | dpi=300 | psm=null | deskew=false
- **Keyframe lookup:** 236 keyframes resolved

| # | t (HH:MM:SS) | score | layout | obs.date | intro? | tickers | phash | keyframe Δ | snippet |
|---|---|---:|---|---:|:---:|---|---|---:|---|
| 1 | 00:12:00 | 93.5 | dmi | 20221121 | · | BE | d5bf2a40 | +0s | >> TALE OF THE TAPE — MON, 11/21/22 << * MARKET STATE: BEAR MARKET RALLY 2. HEAD… |
| 2 | 00:12:40 | 94.7 | dmi | 20221121 | · | BE | d5bf2a40 | -2.67s | > TALE OF THE TAPE — MON, 11/21/22 << * MARKET STATE: BEAR MARKET RALLY 2f HEADW… |
| 3 | 00:13:20 | 93.2 | dmi | 20221121 | · | — | d5bf2a40 | +0s | >> TALE OF THE TAPE — MON, 11/21/22 << * MARKET STATE: BEAR MARKET RALLY 2f HEAD… |
| 4 | 00:14:00 | 93.8 | dmi | 20221121 | · | BE | d5bf2a40 | -2.67s | >> TALE OF THE TAPE — MON, 11/21/22 << * MARKET STATE: BEAR MARKET RALLY 2f HEAD… |
| 5 | 00:15:00 | 93.4 | dmi | 20221121 | · | BE | d5bf2a40 | -1.33s | >> TALE OF THE TAPE — MON, 11/21/22 << * MARKET STATE: BEAR MARKET RALLY 2f HEAD… |

**Top rejected candidates:**

| t (HH:MM:SS) | score | layout | ocr_conf |
|---|---:|---|---:|
| 00:05:40 | -14.2 | tale_of_the_tape | 35 |
| 00:09:00 | -20.1 | tale_of_the_tape | 39 |
| 00:09:20 | -20.1 | tale_of_the_tape | 38 |
| 00:17:40 | -20.6 | tale_of_the_tape | 43 |
| 00:05:20 | -21.3 | tale_of_the_tape | 39 |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | dmi | 5 | 00:12:00 | 00:15:00 | 94.7 | · |

**Saved files:**
- [`20260912_ps_46.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_46.png)
- [`20260912_ps_47.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_47.png)
- [`20260912_ps_48.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_48.png)
- [`20260912_ps_49.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_49.png)
- [`20260912_ps_50.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_50.png)

### 10. THE BIG SHOW...The Sector Rotation Rally Edition.mp4

- **Status:** done
- **Frame budget:** 483 sampled → 60 OCR → 5 saved
- **Prefilter top:** 12.69 | **Thresholds:** strong=6, review=4
- **OCR engine:** tesseract.js 6.0.1 | lang=eng | dpi=300 | psm=null | deskew=false
- **Keyframe lookup:** 363 keyframes resolved

| # | t (HH:MM:SS) | score | layout | obs.date | intro? | tickers | phash | keyframe Δ | snippet |
|---|---|---:|---|---:|:---:|---|---|---:|---|
| 1 | 00:02:08 | 55.7 | dmi | 20221111 | · | BE | cd93f44c | +0s | a \| & File Home Insert Draw Desig Layon Refer: Mailis Revie View Hetp Acrot © H… |
| 2 | 00:16:32 | 81.4 | dmi | 20221111 | · | PL, SSO, TAN | d5ff2b80 | +0s | ja Brose @E Dc vorov PL beware @ © & - 0 x RE RE \| Er >> TALE OF THE TAPE = FRI… |
| 3 | 00:17:36 | 81.7 | dmi | 20221111 | · | PL, QLD, SSO, TAN | d5ff2b80 | +0s | ja Bros @E Dc vorov PL bewdend @ © & - © x I I] \| Ee >> TALE OF THE TAPE = FRI,… |
| 4 | 00:19:12 | 73.5 | tale_of_the_tape | — | · | PL, QLD, SSO, TAN | d5ff2a80 | +0s | ja Brose @ ER Dc vorov PL bowen @ © 2 - 0 x J de mn ee i ET *SPX O/N 39-390 0396… |
| 5 | 00:20:16 | 76.6 | tale_of_the_tape | — | · | PL, QLD, SSO, TAN | d5ff2a80 | +0s | ja Brose @ ER Dc voroy PL bewdend @ © 2 - © x Fle Home et Daw Owign Lyout Adee M… |

**Top rejected candidates:**

| t (HH:MM:SS) | score | layout | ocr_conf |
|---|---:|---|---:|
| 00:13:52 | -21.2 | chart | 16 |
| 00:13:20 | -21.7 | tale_of_the_tape | 32 |
| 00:12:16 | -21.8 | tale_of_the_tape | 34 |
| 00:12:48 | -21.8 | tale_of_the_tape | 33 |
| 00:16:00 | -22.0 | tale_of_the_tape | 38 |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | dmi | 1 | 00:02:08 | 00:02:08 | 55.7 | · |
| 2 | dmi | 2 | 00:16:32 | 00:17:36 | 81.7 | · |
| 3 | tale_of_the_tape | 2 | 00:19:12 | 00:20:16 | 76.6 | · |

**Saved files:**
- [`20260912_ps_41.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_41.png)
- [`20260912_ps_42.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_42.png)
- [`20260912_ps_43.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_43.png)
- [`20260912_ps_44.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_44.png)
- [`20260912_ps_45.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260914/fields-v2/screenshots/20260912_ps_45.png)

## Observations

- 10/10 videos produced `status=done` with the OCR scanner; none failed.
- 50 captures saved across 10 videos; 28 on disk include suffix-walk collisions.
- Layout distribution: `dmi`=37, `structured_whiteboard`=10, `tale_of_the_tape`=3
- `structured_whiteboard` dominates — the classifier picks the parser-rich `TALE OF THE TAPE` slide when the `screen_layout` signal converges with a clean double-portfolio block.
- One third capture per video (a `dmi` slide) is also surfacing with `MISSING_METRIC_LINE` + `MISSING_BOTTOM_LINE` issues — the parser still cannot fully decode `DAILY MARKET INSIGHT` rows, which is a known gap covered by the new text-density scoring.

## Next steps suggested

- Open each saved PNG (linked above) and spot-check that `structured_whiteboard` captures really are `TALE OF THE TAPE` slides, not stock charts mis-classified.
- For `dmi` captures with high `MISSING_*` issue counts, the parser regex needs extending to read the index-percentage / `GRO^` / `TURBO^` one-liners — separate work.
- When a video has only 2 captures but you observed 2 whiteboard appearances, verify on `--fps 0.5` whether uniform sampling missed a third short window.
- 26 capture(s) share a pHash with another capture. Cross-reference the phash_collisions field in analysis.json to find same-slide duplicates.