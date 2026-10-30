# OCR queue status

**The numbers in this file are a snapshot, and they decay.** The catalog
(`data/video_pipeline/state.sqlite`) is the source of truth; § *Re-measuring*
has the commands that regenerate every figure here. Measured **2026-10-29**.

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

### The outstanding work

| # | what | size | notes |
|---|---|---|---|
| 1 | re-download the lost media | 535 videos | 514 Qullamaggie + 21 Revere. `data/qmg_video_recovery_manifest.json` is the list; 219 are `pending` and 316 `scanning`, so both downloaders already list them. |
| 2 | download the Qullamaggie 1080p corpus | 539 videos | 588 candidates, 49 already on disk. Use the `visios` client — see CLAUDE.md. |
| 3 | the `position_table` sweep | the Qullamaggie videos whose positions list is a TradingView table | 10–16 h of EasyOCR at 162–257 s/frame. Layout analysis in `docs/qmg-positions-layout-findings.md`. |
| 4 | re-OCR for the current parser | — | the recorded readings predate the parser fixes. `tools/evalParserReplay.js` scores the *current* parser over the recorded logs, so the parser is measurable without re-scanning. |

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
