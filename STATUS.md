# OCR queue status

Last update: 2026-09-16 (recovery round complete)

## Current state

SQLite catalog `data/video_pipeline/state.sqlite` is fully drained:

| status                | count |
| --------------------- | ----- |
| `done`                | 115   |
| `error`               | 17    |
| `pending` / `scanning`| 0     |

The 17 `error` rows are all whiteboard-free videos: OCR ran cleanly (exit 0) but
the prefilter never promoted a candidate to a capture. The shared error reason
is `whiteboard-free — OCR ran clean but found no whiteboard captures` (these are
genuinely whiteboard-free Revere episodes, not scanner failures).

## How we got here

Two cooperating rounds on the 107 hires-batch videos.

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
`ocr-20260912`/`20260913`/`20260914` runs). Catalog state at the end of round 1:
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

Combined with round 1, **every video in the catalog now has either `done` (115) or `error` (17)**.

## Bugs fixed in round 2

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

## Files of interest

| path                                                                                | what it is                                                                  |
|-------------------------------------------------------------------------------------|-----------------------------------------------------------------------------|
| `data/video_pipeline/state.sqlite`                                                  | source of truth (115 done + 17 error)                                       |
| `data/video_scan_20260915/ocr-20260915/`                                            | round-1 serial-run probe logs + timeline                                    |
| `data/video_scan_20260915/ocr-20260915-p4/`                                         | round-1 parallel-run probe logs                                             |
| `data/video_scan_20260915/ocr-20260915-backfill/`                                   | round-2 backfill (driver crashed); recovery `.STATUS.json` written manually |
| `data/video_scan_20260915/ocr-20260915-backfill/ocr-20260915-backfill/`             | round-2 aggregated probe logs + `analysis.json` / `analysis.md`             |
| `data/video_scan_20260915/ocr-20260915-backfill/ocr-20260915-backfill/screenshots/` | 333 PNGs from the backfill                                                  |

## How to resume / inspect a future session

Per-run state lives at:

- `data/video_scan_<YYYYMMDD>/<run-tag>/.STATUS.json` — last probe log, expected total, next step.
- `data/video_scan_<YYYYMMDD>/<run-tag>/run_summary.json` — full job log with per-video status + video_type.
- `data/video_scan_<YYYYMMDD>/<run-tag>/<run-tag>/analysis.json` — aggregated captures + per-video rollup.

If a session loses context, read those files in order: `.STATUS.json` (where
we are), `run_summary.json` (what happened), `analysis.json` (what's
consumable).

## Known constraints (read-only)

- `D:\courses_F\revere_asset` is read-only reference asset directory; never write into it.
- Windows path mangling through bash heredocs is a recurring trap — anything
  that needs to ship a Windows path into a Node subprocess should go through
  Python's `subprocess.run` (no shell quoting in between), not bash.
- Em-dashes stored in SQLite as `\xe2\x80\x94` (UTF-8 bytes for U+2014) render
  correctly when read with `encoding='utf-8'`; reading via `sqlite3` CLI or
  with cp1252 stdout will display `?` / `â€"`. The data is fine — only the
  terminal encoding is lossy.
