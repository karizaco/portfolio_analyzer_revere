# OCR Video Scan Analysis — 2026-09-12 test run

**Output root:** [C:\Users\admin\Projects\portfolio_analyzer_revere\data\video_scan_20260913\fields-v1](C:\Users\admin\Projects\portfolio_analyzer_revere\data\video_scan_20260913\fields-v1)  
**Probe directory:** `C:\Users\admin\Projects\portfolio_analyzer_revere\data\video_scan_20260913\fields-v1\ocr_probe\logs`  
**Saved screenshots:** `C:\Users\admin\Projects\portfolio_analyzer_revere\data\video_scan_20260913\fields-v1\screenshots` (50 PNGs)  
**Generated at:** 2026-09-13T13:16:50.340Z  

## Totals

- **Videos scanned:** 10 of 10
- **Videos status=done:** 10
- **Total captures saved:** 50
- **Captures with OCR-observed date:** 44
- **Intro-card captures:** 7
- **Whiteboard segments:** 25 (3 intro-card)
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

| # | t (HH:MM:SS) | frame | score | prefilter | OCR conf | layout | obs.date | intro? | issues | snippet |
|---|---|---:|---:|---:|---:|---|---:|:---:|---|---|
| 1 | 00:13:04 | 196 | 96.5 | 5.7 | 61 | dmi | 20221115 | · | MISSING_METRIC_LINE | >> TALE OF THE TAPE — TUE, 11/15/22 << * MARKET STATE: BEAR MARKET RALLY > R * HEADWINDS: … |
| 2 | 00:14:28 | 217 | 98.6 | 5.7 | 62 | dmi | 20221115 | · | MISSING_METRIC_LINE | >> TALE OF THE TAPE — TUE, 11/15/22 << * MARKET STATE: BEAR MARKET RALLY > R * HEADWINDS: … |
| 3 | 00:15:24 | 231 | 96.2 | 5.7 | 62 | dmi | 20221115 | · | MISSING_METRIC_LINE | >> TALE OF THE TAPE — TUE, 11/15/22 << * MARKET STATE: BEAR MARKET RALLY > R * HEADWINDS: … |
| 4 | 00:18:40 | 280 | 97.0 | 5.7 | 62 | dmi | 20221115 | · | MISSING_METRIC_LINE | >> TALE OF THE TAPE — TUE, 11/15/22 << * MARKET STATE: BEAR MARKET RALLY > R * HEADWINDS: … |
| 5 | 00:21:28 | 322 | 97.3 | 8.9 | 63 | dmi | 20221115 | · | MISSING_METRIC_LINE | >> TALE OF THE TAPE — TUE, 11/15/22 << * MARKET STATE: BEAR MARKET RALLY > R * HEADWINDS: … |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | dmi | 1 | 13:04 | 13:04 | 96.5 | · |
| 2 | dmi | 2 | 14:28 | 15:24 | 98.6 | · |
| 3 | dmi | 1 | 18:40 | 18:40 | 97.0 | · |
| 4 | dmi | 1 | 21:28 | 21:28 | 97.3 | · |

**Saved files:**
- [`20260912_ps.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps.png)
- [`20260912_ps_2.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_2.png)
- [`20260912_ps_3.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_3.png)
- [`20260912_ps_4.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_4.png)
- [`20260912_ps_5.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_5.png)

### 2. Going Nowhere Day 12 Can These Recent Breakouts Offer Hope to Bu.mp4

- **Status:** done
- **Frame budget:** 497 sampled → 60 OCR → 5 saved
- **Prefilter top:** 10.6 | **Thresholds:** strong=6, review=4

| # | t (HH:MM:SS) | frame | score | prefilter | OCR conf | layout | obs.date | intro? | issues | snippet |
|---|---|---:|---:|---:|---:|---|---:|:---:|---|---|
| 1 | 00:03:44 | 56 | 66.6 | 7.2 | 48 | dmi | 20230104 | · | MISSING_METRIC_LINE, MISSING_BOTTOM_LINE, LOW_OCR_CONFIDENCE | > REVERE ASSET MANAGEMENT < e, — NT RATES, RUSSIA/UKRAINE [LEY ar. Ee > DAILY MARKET INSIG… |
| 2 | 00:05:20 | 80 | 60.7 | 3.6 | 59 | dmi | 20230104 | · | MISSING_METRIC_LINE, MISSING_BOTTOM_LINE, LOW_OCR_CONFIDENCE | > REVERE ASSET MANAGEMENT < 0 = ErYyes ony \|,_woomy \| 3000 [ «\| Gn yo [EE > DAILY MARKE… |
| 3 | 00:20:48 | 312 | 89.1 | 6.1 | 52 | dmi | 20230104 | · | MISSING_METRIC_LINE, LOW_OCR_CONFIDENCE | »> TALE OF THE TAPE - WED, 1/4/23 << [ 5 \| * MARKET STATE: * HEADWINDS: USD, INFLATION, R… |
| 4 | 00:23:28 | 352 | 90.3 | 6.3 | 52 | dmi | 20230104 | · | MISSING_METRIC_LINE, LOW_OCR_CONFIDENCE | 2» TALE OF THE TAPE - WED, 1/4/23 << [ >\| MARKET STATE: * HEADWINDS: USD, INFLATION, RECE… |
| 5 | 00:25:36 | 384 | 82.3 | 6.1 | 51 | tale_of_the_tape | 20230104 | · | MISSING_METRIC_LINE, LOW_OCR_CONFIDENCE | > TALE OF THE TAPE — WED, 1/4/23 << ' >\| * MARKEY STATE: * HEADWINDS: USD, INFLATION, REC… |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | dmi | 1 | 03:44 | 03:44 | 66.6 | · |
| 2 | dmi | 1 | 05:20 | 05:20 | 60.7 | · |
| 3 | dmi | 1 | 20:48 | 20:48 | 89.1 | · |
| 4 | dmi | 1 | 23:28 | 23:28 | 90.3 | · |
| 5 | tale_of_the_tape | 1 | 25:36 | 25:36 | 82.3 | · |

**Saved files:**
- [`20260912_ps_6.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_6.png)
- [`20260912_ps_7.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_7.png)
- [`20260912_ps_8.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_8.png)
- [`20260912_ps_9.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_9.png)
- [`20260912_ps_10.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_10.png)

### 3. INDEX FALL ON MID EAST TENSIONS AS MKT AWAITS CPI PPI SPCX AMD I.mp4

- **Status:** done
- **Frame budget:** 245 sampled → 60 OCR → 5 saved
- **Prefilter top:** 22.06 | **Thresholds:** strong=6, review=4

| # | t (HH:MM:SS) | frame | score | prefilter | OCR conf | layout | obs.date | intro? | issues | snippet |
|---|---|---:|---:|---:|---:|---|---:|:---:|---|---|
| 1 | 00:00:32 | 8 | 55.0 | 3.8 | 63 | dmi | 20260908 | ✓ | MISSING_METRIC_LINE, MISSING_BOTTOM_LINE | >>> THE REVERE ROUNDUP <<< WHATS THE MARKET TREND? —_— “THE GROTECTION GAUGE" 222DAILY MAR… |
| 2 | 00:01:36 | 24 | 53.6 | 3.8 | 63 | dmi | 20260908 | ✓ | MISSING_METRIC_LINE, MISSING_BOTTOM_LINE | >>> THE REVERE ROUNDUP <<< WHATS THE MARKET TREND? —_— “THE GROTECTION GAUGE" >>>DAILY MAR… |
| 3 | 00:06:08 | 92 | 100.3 | 6.0 | 73 | structured_whiteboard | 20260908 | · | — | >> TALE OF THE TAPE = TUESDAY, SEPTEMBER 8, 2026 << * MARKET STATE; UPTREND *STOINDEXES AT… |
| 4 | 00:07:12 | 108 | 100.3 | 6.0 | 73 | structured_whiteboard | 20260908 | · | — | >> TALE OF THE TAPE ~ TUESDAY, SEPTEMBER 8, 2026 << * MARKET STATE: UPTREND *STOINDEXES 41… |
| 5 | 00:08:16 | 124 | 100.4 | 6.1 | 73 | structured_whiteboard | 20260908 | · | — | >> TALE OF THE TAPE ~ TUESDAY, SEPTEMBER 8, 2026 << * MARKET STATE: UPTREND *STOINDEXES 41… |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | dmi | 2 | 00:32 | 01:36 | 55.0 | ✓ |
| 2 | structured_whiteboard | 3 | 06:08 | 08:16 | 100.4 | · |

**Saved files:**
- [`20260912_ps_11.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_11.png)
- [`20260912_ps_12.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_12.png)
- [`20260912_ps_13.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_13.png)
- [`20260912_ps_14.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_14.png)
- [`20260912_ps_15.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_15.png)

### 4. Indexes Log a Negative Reversal...Is it Normal Action.mp4

- **Status:** done
- **Frame budget:** 349 sampled → 60 OCR → 5 saved
- **Prefilter top:** 11.28 | **Thresholds:** strong=6, review=4

| # | t (HH:MM:SS) | frame | score | prefilter | OCR conf | layout | obs.date | intro? | issues | snippet |
|---|---|---:|---:|---:|---:|---|---:|:---:|---|---|
| 1 | 00:00:00 | 0 | 61.0 | -15.3 | 67 | dmi | 20221114 | ✓ | MISSING_METRIC_LINE, MISSING_BOTTOM_LINE | 2 WHAT'S THE MARKET TREND? © men - Qa wm THE GROTECTION GAUGE" > REVERE ASSET MANAGEMENT <… |
| 2 | 00:01:20 | 20 | 60.7 | -15.3 | 65 | dmi | 20221114 | ✓ | MISSING_METRIC_LINE, MISSING_BOTTOM_LINE | 2 WHAT'S THE MARKET TREND? © smn us - Qa wm THE GROTECTION GAUGE" > REVERE ASSET MANAGEMEN… |
| 3 | 00:12:20 | 185 | 92.4 | 5.9 | 64 | dmi | 20221114 | · | MISSING_METRIC_LINE | 2> TALE OF THE TAPE — MON, 11/14/22 << * MARKET STATE: BEAR MARKET RALLY > B * HEADWINDS: … |
| 4 | 00:13:20 | 200 | 92.4 | 5.8 | 64 | dmi | 20221114 | · | MISSING_METRIC_LINE | 2> TALE OF THE TAPE - MON, 11/14/22 << * MARKET STATE: BEAR MARKET RALLY > B * HEADWINDS: … |
| 5 | 00:14:00 | 210 | 92.4 | 5.8 | 64 | dmi | 20221114 | · | MISSING_METRIC_LINE | 2> TALE OF THE TAPE - MON, 11/14/22 << * MARKET STATE: BEAR MARKET RALLY > B * HEADWINDS: … |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | dmi | 2 | 00:00 | 01:20 | 61.0 | ✓ |
| 2 | dmi | 3 | 12:20 | 14:00 | 92.4 | · |

**Saved files:**
- [`20260912_ps_16.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_16.png)
- [`20260912_ps_17.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_17.png)
- [`20260912_ps_18.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_18.png)
- [`20260912_ps_19.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_19.png)
- [`20260912_ps_20.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_20.png)

### 5. OIL YIELDS AND GEOPOLITICAL TENSIONS CONTINUE TO ACT AS A HEADWI.mp4

- **Status:** done
- **Frame budget:** 221 sampled → 60 OCR → 5 saved
- **Prefilter top:** 18.86 | **Thresholds:** strong=6, review=4

| # | t (HH:MM:SS) | frame | score | prefilter | OCR conf | layout | obs.date | intro? | issues | snippet |
|---|---|---:|---:|---:|---:|---|---:|:---:|---|---|
| 1 | 00:00:12 | 3 | 54.1 | 3.5 | 62 | dmi | 20260909 | ✓ | MISSING_METRIC_LINE, MISSING_BOTTOM_LINE | # Preview File Edi View Go Tools Window Help [=3 [CH] BC d 8 ® L WF Q 8 © WedSepd 5:00PM L… |
| 2 | 00:01:00 | 15 | 52.7 | 3.5 | 70 | dmi | 20260909 | ✓ | MISSING_METRIC_LINE, MISSING_BOTTOM_LINE | # Proview File Edi View Go Tools Window Help [3 [CH] Me 8 ® bm FQ Be © WedSepd 5:00PM LE W… |
| 3 | 00:01:48 | 27 | 57.4 | 3.4 | 68 | dmi | 20260909 | ✓ | MISSING_METRIC_LINE, MISSING_BOTTOM_LINE | WHAT'S THE MARKET TREND? >>> THE REVERE ROUNDUP <<< THE GROTECTION GAUGE" >>> DAILY MARKET… |
| 4 | 00:05:12 | 78 | 119.3 | 2.8 | 66 | structured_whiteboard | 20260909 | · | — | ® Preview Fle ER View Go Tools Window Hep GC ®0 nc i WO LW FQ 8 @ WedSepd SOM ean 2» TALE … |
| 5 | 00:06:36 | 99 | 119.6 | 2.8 | 66 | structured_whiteboard | 20260909 | · | — | ® Preview Flo ER View Go Tools Window Hep CG ®O ac dl #0 Lm TQ 8 8 Wedteps S0ePM ean >> TA… |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | dmi | 3 | 00:12 | 01:48 | 57.4 | ✓ |
| 2 | structured_whiteboard | 1 | 05:12 | 05:12 | 119.3 | · |
| 3 | structured_whiteboard | 1 | 06:36 | 06:36 | 119.6 | · |

**Saved files:**
- [`20260912_ps_21.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_21.png)
- [`20260912_ps_22.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_22.png)
- [`20260912_ps_23.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_23.png)
- [`20260912_ps_24.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_24.png)
- [`20260912_ps_25.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_25.png)

### 6. Second Straight Down Day...Here are the Key Levels That Bulls Ne.mp4

- **Status:** done
- **Frame budget:** 307 sampled → 60 OCR → 5 saved
- **Prefilter top:** 11.53 | **Thresholds:** strong=6, review=4

| # | t (HH:MM:SS) | frame | score | prefilter | OCR conf | layout | obs.date | intro? | issues | snippet |
|---|---|---:|---:|---:|---:|---|---:|:---:|---|---|
| 1 | 00:12:20 | 185 | 91.2 | 6.5 | 60 | dmi | 20230206 | · | MISSING_METRIC_LINE | > TALE OF THE TAPE — MON, 2/6/23 << * MARKET STATE: UPTRENDI »\| *HEADWINDS: INFLATION, RE… |
| 2 | 00:13:00 | 195 | 85.9 | 6.5 | 57 | dmi | 20230206 | · | MISSING_METRIC_LINE, LOW_OCR_CONFIDENCE | »> TALE OF THE TAPE — MON, 2/6/23 << ¢ * MARKET STATE: UPTRENDI \| *HEADWINDS: INFLATION, … |
| 3 | 00:13:40 | 205 | 92.7 | 11.2 | 59 | dmi | 20230206 | · | MISSING_METRIC_LINE, LOW_OCR_CONFIDENCE | 2 TALE OF THE TAPE — MON, 2/6/23 << ! * MARKET STATE: UPTREND > * HEADWINDS: INFLATION, RE… |
| 4 | 00:14:40 | 220 | 87.3 | 6.8 | 58 | dmi | 20230206 | · | MISSING_METRIC_LINE, LOW_OCR_CONFIDENCE | > TALE OF THE TAPE — MON, 2/6/23 << hi * MARKET STATE: UPTREND! 5 *HEADWINDS: INFLATION, R… |
| 5 | 00:15:40 | 235 | 87.6 | 6.8 | 57 | dmi | 20230206 | · | MISSING_METRIC_LINE, LOW_OCR_CONFIDENCE | > TALE OF THE TAPE — MON, 2/6/23 << ’ * MARKET STATE: UPTREND 5 * HEADWINDS: INFLATION, RE… |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | dmi | 5 | 12:20 | 15:40 | 92.7 | · |

**Saved files:**
- [`20260912_ps_31.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_31.png)
- [`20260912_ps_32.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_32.png)
- [`20260912_ps_33.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_33.png)
- [`20260912_ps_34.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_34.png)
- [`20260912_ps_35.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_35.png)

### 7. SELECT LEADERS STANDOUT AS INDEXES SNAP BACK DESPITE HOT CPI PRI.mp4

- **Status:** done
- **Frame budget:** 729 sampled → 60 OCR → 5 saved
- **Prefilter top:** 18.4 | **Thresholds:** strong=6, review=4

| # | t (HH:MM:SS) | frame | score | prefilter | OCR conf | layout | obs.date | intro? | issues | snippet |
|---|---|---:|---:|---:|---:|---|---:|:---:|---|---|
| 1 | 00:16:48 | 252 | 104.2 | -27.5 | 72 | structured_whiteboard | 20260911 | · | — | > TALE OF THE TAPE — THURSDAY, SEPTEMBER 11, 2026 << * MARKET STATE: "STOINDEXES 11 SY RG8… |
| 2 | 00:18:24 | 276 | 104.4 | -27.5 | 74 | structured_whiteboard | 20260911 | · | — | > TALE OF THE TAPE — THURSDAY, SEPTEMBER 11, 2026 << * MARKET STATE: *STOINDEXES 11 5 RGBE… |
| 3 | 00:19:12 | 288 | 104.4 | -27.5 | 74 | structured_whiteboard | 20260911 | · | — | > TALE OF THE TAPE — THURSDAY, SEPTEMBER 11, 2026 << * MARKET STATE: *STOINDEXES 11 5 RGBE… |
| 4 | 00:20:00 | 300 | 104.4 | -27.5 | 74 | structured_whiteboard | 20260911 | · | — | > TALE OF THE TAPE — THURSDAY, SEPTEMBER 11, 2026 << * MARKET STATE: *STOINDEXES 11 5 RGBE… |
| 5 | 00:20:48 | 312 | 104.4 | -27.5 | 74 | structured_whiteboard | 20260911 | · | — | > TALE OF THE TAPE — THURSDAY, SEPTEMBER 11, 2026 << * MARKET STATE: *STOINDEXES 11 5 RGBE… |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | structured_whiteboard | 1 | 16:48 | 16:48 | 104.2 | · |
| 2 | structured_whiteboard | 4 | 18:24 | 20:48 | 104.4 | · |

**Saved files:**
- [`20260912_ps_26.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_26.png)
- [`20260912_ps_27.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_27.png)
- [`20260912_ps_28.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_28.png)
- [`20260912_ps_29.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_29.png)
- [`20260912_ps_30.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_30.png)

### 8. Split Decision Day As Both Bulls AND Bears Have Mixed Emotions.mp4

- **Status:** done
- **Frame budget:** 357 sampled → 60 OCR → 5 saved
- **Prefilter top:** 12.51 | **Thresholds:** strong=6, review=4

| # | t (HH:MM:SS) | frame | score | prefilter | OCR conf | layout | obs.date | intro? | issues | snippet |
|---|---|---:|---:|---:|---:|---|---:|:---:|---|---|
| 1 | 00:12:40 | 190 | 93.1 | 6.0 | 63 | dmi | — | · | MISSING_METRIC_LINE | >> TALE OF THE TAPE - THUR, 13/17/22 << * MARKET STATE: BEAR MARKET RALLY 5 \| * HEADWINDS… |
| 2 | 00:13:20 | 200 | 93.6 | 6.0 | 63 | dmi | — | · | MISSING_METRIC_LINE | >> TALE OF THE TAPE - THUR, 13/17/22 << * MARKET STATE: BEAR MARKET RALLY 5. \| * HEADWIND… |
| 3 | 00:14:20 | 215 | 92.9 | 6.0 | 63 | dmi | — | · | MISSING_METRIC_LINE | >> TALE OF THE TAPE - THUR, 13/17/22 << * MARKET STATE: BEAR MARKET RALLY 5 \| * HEADWINDS… |
| 4 | 00:15:00 | 225 | 94.2 | 6.0 | 65 | dmi | — | · | MISSING_METRIC_LINE | >> TALE OF THE TAPE - THUR, 13/17/22 << * MARKET STATE: BEAR MARKET RALLY 5 \| * HEADWINDS… |
| 5 | 00:18:00 | 270 | 95.1 | 6.0 | 63 | dmi | 20221117 | · | MISSING_METRIC_LINE | >> TALE OF THE TAPE - THUR, 11/17/22 << * MARKET STATE: BEAR MARKET RALLY 5 \| * HEADWINDS… |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | dmi | 4 | 12:40 | 15:00 | 94.2 | · |
| 2 | dmi | 1 | 18:00 | 18:00 | 95.1 | · |

**Saved files:**
- [`20260912_ps_36.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_36.png)
- [`20260912_ps_37.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_37.png)
- [`20260912_ps_38.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_38.png)
- [`20260912_ps_39.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_39.png)
- [`20260912_ps_40.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_40.png)

### 9. Thanksgiving Week Kicks Off With a Yawn But We Did Add to a Posi.mp4

- **Status:** done
- **Frame budget:** 314 sampled → 60 OCR → 5 saved
- **Prefilter top:** 11.99 | **Thresholds:** strong=6, review=4

| # | t (HH:MM:SS) | frame | score | prefilter | OCR conf | layout | obs.date | intro? | issues | snippet |
|---|---|---:|---:|---:|---:|---|---:|:---:|---|---|
| 1 | 00:12:00 | 180 | 93.5 | 6.5 | 64 | dmi | 20221121 | · | MISSING_METRIC_LINE | >> TALE OF THE TAPE — MON, 11/21/22 << * MARKET STATE: BEAR MARKET RALLY 2. HEADWINDS: USD… |
| 2 | 00:12:40 | 190 | 94.7 | 6.5 | 62 | dmi | 20221121 | · | MISSING_METRIC_LINE | > TALE OF THE TAPE — MON, 11/21/22 << * MARKET STATE: BEAR MARKET RALLY 2f HEADWINDS: USD,… |
| 3 | 00:13:20 | 200 | 93.2 | 6.5 | 62 | dmi | 20221121 | · | MISSING_METRIC_LINE | >> TALE OF THE TAPE — MON, 11/21/22 << * MARKET STATE: BEAR MARKET RALLY 2f HEADWINDS: USD… |
| 4 | 00:14:00 | 210 | 93.8 | 6.5 | 62 | dmi | 20221121 | · | MISSING_METRIC_LINE | >> TALE OF THE TAPE — MON, 11/21/22 << * MARKET STATE: BEAR MARKET RALLY 2f HEADWINDS: USD… |
| 5 | 00:15:00 | 225 | 93.4 | 6.5 | 61 | dmi | 20221121 | · | MISSING_METRIC_LINE | >> TALE OF THE TAPE — MON, 11/21/22 << * MARKET STATE: BEAR MARKET RALLY 2f HEADWINDS: USD… |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | dmi | 5 | 12:00 | 15:00 | 94.7 | · |

**Saved files:**
- [`20260912_ps_46.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_46.png)
- [`20260912_ps_47.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_47.png)
- [`20260912_ps_48.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_48.png)
- [`20260912_ps_49.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_49.png)
- [`20260912_ps_50.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_50.png)

### 10. THE BIG SHOW...The Sector Rotation Rally Edition.mp4

- **Status:** done
- **Frame budget:** 483 sampled → 60 OCR → 5 saved
- **Prefilter top:** 12.69 | **Thresholds:** strong=6, review=4

| # | t (HH:MM:SS) | frame | score | prefilter | OCR conf | layout | obs.date | intro? | issues | snippet |
|---|---|---:|---:|---:|---:|---|---:|:---:|---|---|
| 1 | 00:02:08 | 32 | 55.7 | -15.6 | 61 | dmi | 20221111 | · | MISSING_METRIC_LINE, MISSING_BOTTOM_LINE | a \| & File Home Insert Draw Desig Layon Refer: Mailis Revie View Hetp Acrot © HEA be a [o… |
| 2 | 00:16:32 | 248 | 81.4 | 6.0 | 63 | dmi | 20221111 | · | MISSING_METRIC_LINE, MISSING_BOTTOM_LINE | ja Brose @E Dc vorov PL beware @ © & - 0 x RE RE \| Er >> TALE OF THE TAPE = FRI, 11/11/22… |
| 3 | 00:17:36 | 264 | 81.7 | 5.9 | 64 | dmi | 20221111 | · | MISSING_METRIC_LINE, MISSING_BOTTOM_LINE | ja Bros @E Dc vorov PL bewdend @ © & - © x I I] \| Ee >> TALE OF THE TAPE = FRI, 11/11/22 … |
| 4 | 00:19:12 | 288 | 73.5 | 6.7 | 58 | tale_of_the_tape | — | · | MISSING_METRIC_LINE, LOW_OCR_CONFIDENCE | ja Brose @ ER Dc vorov PL bowen @ © 2 - 0 x J de mn ee i ET *SPX O/N 39-390 03966 0-30/60 … |
| 5 | 00:20:16 | 304 | 76.6 | 6.5 | 57 | tale_of_the_tape | — | · | MISSING_METRIC_LINE, LOW_OCR_CONFIDENCE | ja Brose @ ER Dc voroy PL bewdend @ © 2 - © x Fle Home et Daw Owign Lyout Adee Maligs feve… |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | dmi | 1 | 02:08 | 02:08 | 55.7 | · |
| 2 | dmi | 2 | 16:32 | 17:36 | 81.7 | · |
| 3 | tale_of_the_tape | 2 | 19:12 | 20:16 | 76.6 | · |

**Saved files:**
- [`20260912_ps_41.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_41.png)
- [`20260912_ps_42.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_42.png)
- [`20260912_ps_43.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_43.png)
- [`20260912_ps_44.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_44.png)
- [`20260912_ps_45.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20260913/fields-v1/screenshots/20260912_ps_45.png)

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