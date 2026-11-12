# OCR queue status

**The numbers in this file are a snapshot, and they decay.** The catalog
(`data/video_pipeline/state.sqlite`) is the source of truth; § *Re-measuring*
has the commands that regenerate every figure here. Measured **2026-10-29**,
except the parser's figures (§ *The chart-stream parser*), which are from
**2026-11-01**.

## Current state (measured 2026-10-29)

### The catalog

2,402 videos — 1,814 Revere + 588 Qullamaggie — and **every row is dated**
(0 rows with an empty `upload_date`).

| channel | total | pending | scanning | done | no_match |
|---|---|---|---|---|---|
| revere | 1,814 | 1,686 | 16 | 95 | 17 |
| qullamaggie | 588 | 219 | 369 | 0 | 0 |
| **total** | **2,402** | **1,905** | **385** | **95** | **17** |

`catalog_runs` holds **30** audit rows — 26 `live`, 4 `fixture`. It is a log
of **runs**, not of videos, so its size is not the catalog's size; the
per-video counts live inside each row. The 2026-10-26 gap-fill's 1,582 rows
are not in it — that run was interrupted, and the audit row was only written
at the end. That is fixed (see CLAUDE.md § *The audit table is a log of RUNS,
not of videos*), but the shipped database still carries the historical gap.

**What `status` means** is documented in `src/video/videoStatus.js`. The one
thing worth holding on to: `scanning` means *the media is on disk* — and it is
also the queue both OCR paths read. `done` means *a pass finished*; it says
nothing about whether the file is still there.

### Status against the filesystem

`node tools/reconcileCatalogStatus.js` (report only):

| | count |
|---|---|
| `done`, media present — the claim holds | 95 |
| `pending`/`scanning`, media present | 70 |
| `pending`/`scanning`, media missing | **2,220** |
| `review` / `no_match` / `error` | 17 |
| rows carrying a `download_path` | 716 |
| …of those, the pointer resolves to a file that is there | 179 |
| …of those, the pointer points at a file that is gone | 537 |
| files on disk that **no pointer names** | 36 |

"No row claims `done` without having the media" — the reconciler says so
explicitly, and it can, because it asks the filesystem **two** questions: does
the *pointer* resolve, and does a file named the way the downloader writes it
(`<upload_date>_<video_id>.mp4`) exist? Across the whole catalog **3 rows**
have their media present under the downloader's own name while their pointer
does not resolve; two of them (`bEidyFtV-lY`, `M0pV73RV2qo`) are `done` rows,
so their claim legitimately holds.

The 2,220 breaks down as:

| | count | what it means |
|---|---|---|
| has a pointer, and the media is gone | **535** | the re-download list (`data/qmg_video_recovery_manifest.json`): 219 `pending` (198 Qullamaggie + 21 Revere) and 316 `scanning` (all Qullamaggie) |
| has no pointer at all | 1,685 | never downloaded |

The 70 that *do* have their media are 69 whose pointer resolves (all
`scanning`, ready for the OCR queue) and 1 found only under the downloader's
own name.

### The media on disk

| directory | `.mp4` | `.part` |
|---|---|---|
| `data/video_pipeline/downloads/` | 0 | 0 |
| `data/video_pipeline/downloads_hires/` | 166 | 1 |
| `data/video_pipeline/downloads_1080p/` | 49 | 39 |

The 40 `.part` files are **10.15 GiB** of interrupted downloads. One of them
is redundant (the completed copy of the same video exists); the other 39 are
the only copy of their download. `py -3 tools/reportPartialDownloads.py`
reports them and **never deletes** — a partial file may be the only copy of
something worth resuming.

### The Qullamaggie ground truth

`data/qmg_ground_truth.json` is a hand-made reading of a TradingView positions
panel, and it is **verified against its pixels** — **94 of 104 captures across
40 of the 42 dates** are md5-pinned fixtures in
`test/fixtures/qmg_ground_truth/`, each cut to show the ticker column AND the
panel's own footer.

The audit (2026-11-01, three passes) moved **16 dates** and found eight
classes of defect, including a column copied across every capture of a date, a
reading taken off the watchlist instead of the positions table, and a ticker
read as another. The third pass added the **anchoring rule** — a capture's
ground truth is anchored to the frame the hand reading came from — and reverted
three of its own tentative corrections when that rule was applied to them.
**Run the checker before quoting any Qullamaggie recall number:**

```bash
node tools/checkGroundTruthConsistency.js
```

Every date the replay tool can score is now pinned; the only unpinned captures
are the ten under the two *annotated duplicate* keys, which no probe log can
match.
Details: CLAUDE.md § *The Qullamaggie ground truth, verified against its
pixels*.

### The chart-stream parser

The parser is measured **offline**, by replaying the captured probe logs through
it — no OCR, seconds instead of ~12 min/video:

```bash
node tools/evalParserReplay.js --json
node tools/evalParserReplay.js data/video_ocr_probe data/video_scan_test/_rerun --json
```

| corpus | dates scored | recall | precision |
|---|---|---|---|
| default (8 probe roots) | 8 | **97.6 %** (83/85) | **100 %** (83/83) |
| wide (`video_ocr_probe` + `_rerun`) | 17 | **88.1 %** (148/168) | **89.2 %** (148/166) |

Measured 2026-11-02, after the Filter B rewrite, the four 2022-era alias rows,
the 16 pixel-verified seed rows, the five 2026-11-02 alias rows, the **column
gate's row-stack evidence** and the **one-glyph column rule**. The attribution
of every step is in CLAUDE.md § *Filter B — the position-aware vertical bound*
and § *The column gate — price-alignment was the wrong evidence*. A **sixth**
2026-11-02 alias row (`RGN → RGTI`) came out of a production scan and moves
**nothing** on either corpus — the corpus holds no `RGN`.

**This is a surviving sample, not a corpus-wide figure** — the tool prints a
census on every run, and **read the number with the census**.

**And the era-conditional crop has now run in the real pipeline.** A production
smoke scan of `20230609` (`20230609_VdQSDGZBLQE.mp4`, 1920×1080) — the tool
picked the 2023-era rectangle `0.82,0.60,0.18,0.32` **from the upload date**,
with no crop flag — reads that date's **13 ground-truth holdings exactly, with
zero false positives**. The old fixed crop read **zero** holdings on that date.
The scan exposed one wrong holding (`REGN`, a real ticker, published in place
of `RGTI` because the garble `RGN` is one edit away); the `RGN → RGTI` alias row
fixes it, and a **second, fresh scan** confirms the fix end to end. CLAUDE.md
§ *The 2023-era production smoke scan*.

**Four more dates have now been through the batch**, and the era crop and
Filter B both fire in production: all four logs record
`phash_region_fraction = {"x":0.82,"y":0.6,"w":0.18,"h":0.32}` — chosen from
the upload date, with no crop flag — and every capture's `bbox_filter.rule` is
`list_rows`. Scored on the **merged** list against the pixel-verified ground
truth: `20230522` **6/7**, `20230523` **10/11**, `20230602` **12/12**,
`20230605` **11/11** — **39/41 (95.1 % recall), 3 false positives (92.9 %
precision)**. Two defects the merged list hides from a capture-level metric:
the clusterer **absorbed** a real holding (`LI` into `AI`, one edit apart) and
**invented** one (`ARCO` → `AAPL`, a seed ticker no frame ever showed).
CLAUDE.md § *The 2023-era production scan, four more dates*.

**And the merged list is now measured in its own right.** The replay tool
reports three **video-level** arms beside the capture-level number — `recorded`
(what production published), `rebuilt` (the current clusterer over the log's
recorded readings) and `rebuilt_current` (the current parser end to end) — and
the census says where each arm's input came from. A log that cannot support an
arm's reading is **unmeasured** in it, not scored as zero. The `AAPL` defect
is invisible to a capture-level metric, so a capture-level number alone cannot
answer "did the merge publish a holding the video never showed".

**Nine named cluster-rule configurations exist; `corroborated` is the DEFAULT**
(changed 2026-11-03). The clusterer names one canonical per cluster, and a
canonical that is a *correction* rather than a *reading* is a name the clusterer
invented. On 20230605 the cluster `{AACO, ARCO}` was published as `AAPL` — a
holding no frame of that video showed. **Every candidate for it is two edits
away**, so "closest" cannot discriminate; what discriminates is that the video
read `ARQQ` in six frames and `AAPL` in none.

The named configurations are `shipped` (the pre-2026-11-03 behaviour),
`corroborated` (**the default** — a correction must be within edit distance 1 of
a member or the cluster is dropped), `corroborated-strict` (the same, and the
video's own reading of the ticker does not count as corroboration), `supported`
(prefer the correction the video actually read, breaking ties),
`video-supported` (the same, whatever the distance), and `swallowed` (publish a
cluster's other lexicon tickers too, when the video read them in ≥ 4 frames of
their own), plus the three explicit combinations
`supported+corroborated`, `video-supported+corroborated`, and
`corroborated+swallowed`. The combination names make the corroboration and
swallowed settings explicit; all non-default alternatives are opt-in.

**With every rule off, the shipped path is provably unchanged**: the
pre-change clusterer and the current one produce identical cluster tables
over the recorded corpus — 177 logs, 1 025 clusters, zero differences
(`test/manual/clusterShippedPath.test.js`).

**And the measurement has been run — it decides against three of them.** Over
the corpus replay, the hit count **never moves** under any rule; only the
prediction count does. `corroborated` **removes** false positives (−2 default,
−6 wide) and loses nothing. `supported` and `video-supported` **add** false
positives (+2 default, +4 wide) and gain nothing — on 20230605 the supported
rule turns one false positive into three. The production audit (the recorded
production cluster tables, 46 logs / 2 480 clusters) agrees: **one** published
ticker changes, it is the `AAPL` false positive, and **no** holding is lost.
The whiteboard branch is unaffected — it never uses the clusterer's consensus.

**And a PRODUCTION SCAN of all six 2023-era dates under the rule agrees**
(`qmg-easyocr-20261103-corroborated`, scored on the merged list against
the pixel-verified ground truth, against the shipped rule's own logs):

| date | ruled | shipped |
|---|---|---|
| `20230522` | 6/7, 0 FP | 6/7, 0 FP |
| `20230523` | 10/11, 1 FP (`U`) | 10/11, 1 FP (`U`) |
| `20230602` | 12/12, 1 FP (`IOT`) | 12/12, 1 FP (`IOT`) |
| **`20230605`** | **11/11, 0 FP** | 11/11, **1 FP (`AAPL`)** |
| `20230608` | 13/13, 0 FP | — |
| **`20230609`** | **13/13, 0 FP** | 13/13, **1 FP (`REGN`)** |
| **total** | **65/67 — 97.0 % recall, 2 FP** | 52/67 — 77.6 %, 4 FP |

**Two false positives removed, no holding lost.** The two that remain
(`U` on 20230523, `IOT` on 20230602) are **capture-level** readings, so
no cluster rule can remove them.

**Stated plainly: `corroborated` is a PRECISION filter, not a recall one.**
The hit count never moves under it. It removes holdings the clusterer
*invented*; it does not find holdings the parser missed. The recall gains in
2026 came from the era-conditional crop and the parser. On the dates the two
scans **share** — the like-for-like comparison, since two scans of different
date sets cannot be compared in aggregate — the rule is **−1 false positive,
0 holdings lost** (`test/manual/corrobDefaultSafety.test.js`).

The blast radius is the **chart_stream branch only** — the whiteboard branch
merges the structured GRO/TURBO holdings and never reads the clusterer's
consensus. `--no-cluster-corroboration` turns the rule off and reproduces the
pre-2026-11-03 behaviour; the scan records which rule ran (`cluster_rule`).

**And the LAST known defect is now measured: the swallowed holding.** The
clusterer names one canonical per cluster, so when a cluster holds two
*distinct* lexicon tickers one edit apart, the second is swallowed — and on
20230522/20230523 that is `LI`, a real holding (69/74 hits → 71/74). Five
such clusters exist in the corpus; the discriminator is the **cluster
frequency** (a swallowed ticker read in ≥ 4 frames is a holding, ≤ 3 is a
one-off garble). Publishing every lexicon ticker in a cluster is measured
and **rejected** (+5 holdings, **+24 false positives**); the guarded version
— publish it only when the video read it in ≥ 4 frames of its own — gains
**2 holdings and adds ZERO false positives**, and a production scan confirms
it (`LI` read in 4 frames → published; in 1 frame → rejected). It is
implemented behind `--cluster-swallowed-holdings` and **off by default**.

CLAUDE.md § *The clusterer's canonical selection*.

**A batch's `TIMEOUT` used to say nothing about whether the video was read.**
The scan tool prints its whole result object to stdout at the end, and the
batch drained **stderr only** — so the child blocked forever on a full 64 KB
Windows pipe *after* writing a complete probe log. Every EasyOCR chart-stream
batch video burned the full 40-minute budget and was recorded as a failure even
when it succeeded. **Fixed**: `superviseChild()` drains stdout, and
`test/qmgBatchStdout.test.js` pins it (two of its tests fail against the
pre-fix code). The scan tool was not at fault — printing its result is correct,
and the fault was a tool that could not be supervised. CLAUDE.md § *The scan
writes its log and does not exit*.

**And the deadlock belonged to every consumer of the scan tool, not to the
batch.** It is a property of the *scan tool's stdout volume*, so every tool
that spawns it with a piped stdout inherits it — and **three** sibling daemons
did. The supervisor has moved into `tools/qmg_scan_daemon_support.js` (the
project's designated shared-guard module, where it is now the **fourth**
guard), and **nine** tools use it: the batch, the comparison daemon, the alt
daemon, the batch daemon, `qmg_ocr_batch.js`, `scanAllGtVideos.js`,
`_revere_scan.js`, `runQmgCuratedBenchmark.js` — and the module itself. Two
things came with the consolidation: the timeout now kills the whole **process
tree** (`taskkill /T /F`), which is the orphan-ffmpeg zombie mechanism
CLAUDE.md names as the cause of the perceived machine freeze; and
`runQmgCuratedBenchmark.js`, which had **no timeout at all**, now has a
40-minute one. Each tool's result-status vocabulary was preserved exactly
(`ok`/`timeout`/`error`, `exit_N`/`error_…`, and `scanAllGtVideos.js`'s `-1`),
because those values are written into results files compared across runs.
`_revere_scan.js` could not use the bounded stdout tail to decide success —
`status` serializes *after* the huge `captures` array — so it now reads the
**probe log on disk**, which is the authoritative record and is written before
the tool's final `console.log`. The invariant is now **statically pinned**:
every file in `tools/` that spawns the scan tool must either drain its stdout
or use `stdio: 'inherit'`. CLAUDE.md § *The deadlock belongs to every consumer
of the scan tool, not to the batch*.

The curated EasyOCR benchmark (`npm run test:benchmark`, the four md5-pinned
frames) now reads **94.4 %** overall mean recall — `trade_ideas` 7/9,
`sparse` 1/1, `normal_2022` 8/8, `dense_2023` 13/13 (false positives 3 / 3 / 2
/ 0). Measured 2026-11-02, after the **era-conditional crop** — Qullamaggie
moved his position list from a floating bottom-right panel to a table docked
to the right edge between 2023-01-26 and 2023-05-18, so the crop is now chosen
by the upload date (`src/video/chartStreamCrop.js`). `dense_2023` went 10/13 →
**13/13 with zero false positives** and `normal_2022` recovered `TNA`; the
`trade_ideas` frame **regressed** 9/9 → 7/9, because a taller 2022-era crop is
downscaled more by EasyOCR and two faint rows stop being readable. Over the
nine pinned 2022-era frames the taller crop is **+4 hits at unchanged
precision**. The full derivation is in CLAUDE.md § *The chart-stream crop —
MEASURED off the pixels, and ERA-CONDITIONAL*.

**The prefilter now measures the crop's rectangle, era-conditionally.** The crop
was fixed on 2026-11-02; the prefilter that *decides which frames get OCR'd* was
still measuring a hard-coded fallback (`left: 0.85, top: 0.55` → source x 1632)
that started to the **right** of the 2023-era sidebar's ticker column for two of
the three measured sidebar layouts. The rectangle is now the crop's rectangle,
era-conditionally (`chartStreamPrefilterRegionForDate`), so the prefilter
measures the pixels the OCR engine will read. The era question is answered in
**one** place (`chartStreamEraForDate`), so the crop, the prefilter rectangle and
the per-date flags cannot disagree.

**This is necessary, not sufficient.** The prefilter down-samples to 160×90, so
the mid-tone signal's denominator is 7–17 pixels and the row/stripe signals are
*inverted* in the sidebar era. Fixing the rectangle changes which pixels are
averaged; it does not re-tune `rowDensityTarget` / `multiColStripeCountTarget`.
The instrument for that measurement is `tools/measurePrefilterRegion.js` (no
OCR). CLAUDE.md § *The prefilter's rectangle — the crop's rectangle,
era-conditionally*.

**The panel's own row count is now a self-check on the reading.** The positions
panel prints its row count in its footer ("N Items in Personal WatchList", or
"K of N Items…" where N is the total). The parser now reads it and reports
`panel_count` and `panel_count_delta` — the reading's length minus the panel's
own count. A delta of 0 means the reading is not *provably* wrong; a non-zero
delta means a row was dropped or invented. **The count is reported, never acted
on**: a misread count read low would truncate a correct reading, which is
precisely the case where acting on it would do the most damage. Pinned by
`test/chartStreamPanelCount.test.js`.

**But in production the count is always `null`, and the reason is the pixels.**
The footer sits at source y ≈ 1020–1026, and the crops' bottom edges are 950
(2022 era) and 994 (2023 era) — **the OCR engine is never shown the line**. A
dedicated footer strip, read once per video, is the fix; a taller crop is not
(the crop is also the capture-dedup pHash rectangle, and a taller crop is
downscaled more by EasyOCR). CLAUDE.md § *The panel's footer is BELOW the
crop*.

**The media's resolution is now checked mechanically.** `test/videoResolution.test.js`
ffprobes every video the pipeline reads and asserts CLAUDE.md's floor — no video
below 720p — and checks that `downloads_1080p` really is 1920×1080, because the
chart-stream crop's measured geometry is stated for that width. Measured
2026-11-02 over 215 videos: `1280x720` ×91, `1112x720` ×53, `1920x1080` ×50,
`1152x720` ×14, `1670x1080` ×2, `1114x720` ×1, `1278x720` ×1, `1728x1080` ×1,
`1918x1080` ×1, `1280x718` ×1 — **none below 720p**, and **all 49 files in
`downloads_1080p` are 1920×1080**.

### The outstanding work

| # | what | size | notes |
|---|---|---|---|
| 1 | re-download the lost media | 535 videos | 514 Qullamaggie + 21 Revere. `data/qmg_video_recovery_manifest.json` is the list; 219 are `pending` and 316 `scanning`, so both downloaders already list them. |
| 2 | download the Qullamaggie 1080p corpus | 539 videos | 588 candidates, 49 already on disk. Use the `visios` client — see CLAUDE.md. |
| 3 | the `position_table` sweep | the Qullamaggie videos whose positions list is a TradingView table | 10–16 h of EasyOCR at 162–257 s/frame. Layout analysis in `docs/qmg-positions-layout-findings.md`. |
| 4 | re-OCR for the current parser | — | the recorded readings predate the parser fixes **and** the era-conditional crop, so every captured frame was cropped with the old fixed rectangle. `tools/evalParserReplay.js` scores the *current* parser over the recorded logs, so the parser is measurable without re-scanning — but the CROP is not: a re-scan is the only way to get a sidebar-era frame read at all. **Five sidebar-era dates have been done** — `20230609` reads its 13 holdings exactly, 0 FP, and the four-date batch reads 39/41 (§ *The chart-stream parser* above). |
| 5 | pin the remaining ground-truth captures | 10 of 104 captures | the ten under the two *annotated duplicate* keys, which no probe log can match and which carry the same readings as the dates they are labelled with. Every date the replay tool can score is pinned. |

## The AsymTrading source (measured 2026-11-11)

A **Substack** source, and the first one in the project with a paywall. It
is catalogued in its own tables rather than in `videos`, because a Substack
post is not a YouTube video and a paywalled post has no media and no body.

| | count |
|---|---|
| posts in the publication | 476 (2023-03-29 → 2026-11-11) |
| free, and therefore read | 42 |
| of those, Market Pulse reports | 27 |
| of those, carrying an embedded video | 24 |
| paywalled, and catalogued but not read | 434 |

| series | posts | free |
|---|---|---|
| `market_pulse` | 276 | 27 |
| `momentum_movers` | 94 | 1 |
| `market_monitor` | 46 | 0 |
| `focus_list` | 28 | 0 |
| `swing_trading_course` | 8 | 8 |
| `essay` | 6 | 0 |
| `post_mortem` | 6 | 0 |
| `copy` | 5 | 0 |
| `prelaunch` | 2 | 2 |
| `trader_profile` | 2 | 2 |
| `learning_together` | 1 | 1 |
| `market_breadth_monitor` | 1 | 1 |
| `market_dashboard` | 1 | 0 |

All 27 free Market Pulse posts parse all four market readings (backdrop,
trend, breadth, momentum). The parser switches on the report's LABELS, not
on a date, because the report format changed three times between 2024 and
2026 — see CLAUDE.md § *The AsymTrading source*.

**The video path is not built yet.** The 24 free posts with an embedded
video are catalogued with their Mux media-upload id, and the media can be
fetched from the signed Mux MP4 URL, but nothing downloads or transcribes
them yet. The article path is complete.

```bash
npm run asym:catalog        # walk the archive and parse the free posts
npm run asym:catalog:dry    # the same walk, writing nothing
```

## Re-measuring

Everything in § *Current state* comes from four commands:

```bash
# the catalog — status counts per channel, and the audit table
python -c "import sqlite3;c=sqlite3.connect('data/video_pipeline/state.sqlite');print(list(c.execute('SELECT channel,status,COUNT(*) FROM videos GROUP BY channel,status')));print(list(c.execute('SELECT kind,COUNT(*) FROM catalog_runs GROUP BY kind')))"

# status against the filesystem
node tools/reconcileCatalogStatus.js

# the media, per directory
python - <<'PY'
import os
for d in ('downloads', 'downloads_hires', 'downloads_1080p'):
    p = os.path.join('data/video_pipeline', d)
    files = os.listdir(p) if os.path.isdir(p) else []
    print(d, sum(f.endswith('.mp4') for f in files), 'mp4,',
          sum(f.endswith('.part') for f in files), 'part')
PY

# the lost media, as a re-download list
py -3 tools/inventoryLostVideos.py

# the ground truth against its pixels, and the parser against the ground truth
node tools/checkGroundTruthConsistency.js
node tools/evalParserReplay.js
node tools/evalParserReplay.js data/video_ocr_probe data/video_scan_test/_rerun
```

## How we got here — the September 2026 campaign

Everything below records the **2026-09-15/16 OCR campaign**, kept because it
records which bugs were found and fixed. It describes a catalog of 132 videos;
today's catalog has 2,402. The three bugs in § *Bugs fixed in round 2* are
fixed in the current tree — this is the record of how, not a to-do list.

### Round 1 — 2026-09-15 (initial scan)

| run-tag           | driver                            | videos done                                 | err | elapsed |
| ----------------- | --------------------------------- | ------------------------------------------- | --- | ------- |
| `ocr-20260915`    | `runAllOcr.js` (serial)           | 29/107 unique (rest already `done`)         | 0   | 6h 5m   |
| `ocr-20260915-p4` | `parallelOcrScan.py` (4 workers)  | 7/7 attempted                               | 0   | 17m     |

Round-1 timeline rollups (per `analysis.json`):

- **`ocr-20260915`**: 24 videos w/ captures, 70 captures, 31 unique tickers, **15 daily + 5 weekend_review + 4 feature**
- **`ocr-20260915-p4`**: 6 videos w/ captures, 18 captures, **4 daily + 2 weekend_review**

Together: **30 unique videos** OCR'd, 88 captures, **19 daily + 7 weekend_review + 4 feature**.

The serial run skipped 78 rows that were already `done` (from prior
`ocr-20260912`/`ocr-20260913`/`ocr-20260914` runs). Catalog state at the end of round 1:

**36 unique `done`** (the 29 from the serial run were the *new* ones — counting
the 7 from the parallel run brings the net new in this round to 36). This left
71 videos in the catalog (107 minus 36 = 71) without a probe log written under
the current date, but with stale `scanning` markers from interrupted prior
sessions.

### Round 2 — 2026-09-16 (recovery / backfill)

A round-1 audit found that the 78 "skipped" rows were a mix of legitimately
already-`done` rows AND rows whose prior scan had been interrupted mid-flight
(marked `scanning` but no probe log on disk under the current `date_tag`).
Four hires downloads were also missing. Round 2:

1. Killed 4 idle orphan `node.exe` workers from the prior interruption.
2. Re-downloaded the 4 missing mp4s (`node tools/downloadHiresBatch.js --only-ids …`).
3. Re-ran OCR for 18 problematic videos under run-tag `ocr-20260915-backfill`
   (4 workers, ~2h wall clock) — `--skip-from-tag ocr-20260915` cooperated with
   the live serial run.
4. Aggregated the 78 probe logs produced by the backfill into
   `data/video_scan_20260915/ocr-20260915-backfill/ocr-20260915-backfill/analysis.{json,md}`.

Round-2 outputs:

- **Videos scanned (probe logs on disk):** 78
- **Captures saved:** 181
- **Screenshots saved:** 333 PNGs
- **Unique tickers:** 41
- **Intro-card captures:** 30
- **Whiteboard segments:** 111 (23 intro-card)
- **Captures per layout:** `structured_whiteboard` 139, `dmi` 42
- **pHashes:** 109 unique among 181 captures (72 captures share a pHash with another — the
  expected signal that the same intro card / recurring slide is being deduped)

SQLite flip after round 2:

| SQLite transition     | count | reason                                                                 |
|-----------------------|-------|------------------------------------------------------------------------|
| `scanning` -> `done`  | 61    | probe log has captures                                                 |
| `scanning` -> `error` | 17    | probe log is whiteboard-free (`captures: []`); OCR ran clean, no match |

Combined with round 1, every video in the catalog then had either `done` (115)
or `error` (17). Those 17 rows are the `no_match` rows in today's table — the
schema now separates "the scan found nothing" from "the pass failed".

### Bugs fixed in round 2

Three idempotency bugs in `tools/parallelOcrScan.py` were silently wasting work
on every prior run. All fixed in commit `9482772`:

1. **Regex didn't match doubled-date filenames.** Real probe-log names are
   `<date>_<date>_<vid>_<hash>_whiteboard.json` (doubled date prefix). The
   single-date regex matched zero of them, so `_probe_log_stems` always returned
   empty and every video was re-scanned on every run.

2. **Underscore-in-video-id parsing.** `video_id` allows `_` (e.g. `eai-qmrf_t0`).
   `split('_')` fragmented the id; the rewritten regex uses `m.groups()` so the
   id stays intact.

3. **Case sensitivity.** SQLite stores the canonical `gzKJIHyBPfA`; filenames
   on disk are `gzkjihybpfa`. Membership test now `.lower()`s both sides.

Also in `9482772`:

- `--date-tag YYYYMMDD` (and `$DATE_TAG` env var) added to `parallelOcrScan.py`
  so the driver can write into yesterday's `data/video_scan_<date>/` directory
  when resuming — previously the date was hardcoded to "today" so re-runs had
  no choice but to scatter results across two date folders.
- `--only-ids <csv>` (and repeated `--only-id=<id>`) added to
  `tools/downloadHiresBatch.js` so the missing-download retry could be chunked
  cleanly across parallel workers without re-downloading the 103 already-on-disk
  videos.
- `parallelOcrScan.py` crashed at the very end of every run with
  `NameError: name '_write_status_json' is not defined` because the helper was
  defined *after* `if __name__ == "__main__": sys.exit(main())`. The function
  was hoisted to module scope so it actually executes. The round-2 backfill's
  recovery `.STATUS.json` (next-step field, probe log count) was written
  manually as a one-off because of this.

### Files of interest

| path                                                                                | what it is                                                                  |
|-------------------------------------------------------------------------------------|-----------------------------------------------------------------------------|
| `data/video_pipeline/state.sqlite`                                                  | source of truth (see § Current state — the status column counts in this file are a snapshot) |
| `data/video_scan_20260915/ocr-20260915/`                                            | round-1 serial-run probe logs + timeline                                    |
| `data/video_scan_20260915/ocr-20260915-p4/`                                         | round-1 parallel-run probe logs                                             |
| `data/video_scan_20260915/ocr-20260915-backfill/`                                   | round-2 backfill (driver crashed); recovery `.STATUS.json` written manually |
| `data/video_scan_20260915/ocr-20260915-backfill/ocr-20260915-backfill/`             | round-2 aggregated probe logs + `analysis.json` / `analysis.md`             |
| `data/video_scan_20260915/ocr-20260915-backfill/ocr-20260915-backfill/screenshots/` | 333 PNGs from the backfill                                                  |

### How to resume / inspect a future session

Per-run state lives at:

- `data/video_scan_<YYYYMMDD>/<run-tag>/.STATUS.json` — last probe log, expected total, next step.
- `data/video_scan_<YYYYMMDD>/<run-tag>/run_summary.json` — full job log with per-video status + video_type.
- `data/video_scan_<YYYYMMDD>/<run-tag>/<run-tag>/analysis.json` — aggregated captures + per-video rollup.

If a session loses context, read those files in order: `.STATUS.json` (where
we are), `run_summary.json` (what happened), `analysis.json` (what's
consumable).

### Known constraints (read-only)

- `D:\courses_F\revere_asset` is read-only reference asset directory; never write into it.
- Windows path mangling through bash heredocs is a recurring trap — anything
  that needs to ship a Windows path into a Node subprocess should go through
  Python's `subprocess.run` (no shell quoting in between), not bash.
- Em-dashes stored in SQLite as `\xe2\x80\x94` (UTF-8 bytes for U+2014) render
  correctly when read with `encoding='utf-8'`; reading via `sqlite3` CLI or
  with cp1252 stdout will display `?` / `â€"`. The data is fine — only the
  terminal encoding is lossy.
