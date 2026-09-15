# OCR queue status (2026-09-15)

## Current state

Two cooperating runs on the 107 hires-batch videos finished:

| run-tag             | driver           | videos done | err | elapsed | timeline                       |
|---------------------|------------------|-------------|-----|---------|--------------------------------|
| `ocr-20260915`      | `runAllOcr.js` (serial)  | 29/107 unique (rest were already `done` in SQLite) | 0 | 6h 5m | 24 videos w/ captures, 70 captures, 31 unique tickers, **15 daily + 5 weekend_review + 4 feature** |
| `ocr-20260915-p4`   | `parallelOcrScan.py` (4 workers) | 7/7 attempted | 0 | 17m | 6 videos w/ captures, 18 captures, **4 daily + 2 weekend_review** |

Together: **30 unique videos** OCR'd in this round, 88 captures total, **19 daily + 7 weekend_review + 4 feature** after de-dup.

The 78 rows the serial run skipped were already in SQLite status `done` (from prior `ocr-20260912`, `ocr-20260913`, `ocr-20260914` runs). The remaining 107 - 78 - 29 = 0 are still pending; the catalog is fully scanned as of this run.

## What landed in this round

- `d766f56` — Python parallel OCR driver (rewritten from the broken bash+xargs version, which mangled Windows backslash paths through `<<<` heredocs)
- `src/normalize/tickerScan.js`, `src/video/imageHash.js` — helpers shipped but never committed before; the live scanner already depended on them
- `src/normalize/videoTypeClassifier.js` — heuristic classifier (`daily` / `weekend_review` / `feature` / `live_update`) plus retroactive stamper and timeline viewer filter chips
- `.STATUS.json` per-run ledger (written by both drivers; backfilled for the two finished runs)

## Next steps

1. Open `data/video_scan_20260915/ocr-20260915/timeline.json` and the timeline viewer (`tools/viewTimeline.html`) to inspect daily-by-day rollups.
2. The 31 unique tickers extracted are in `timeline.json` — likely candidates for new seed entries in `config/ticker_lexicon_seed.csv` if any are missing.
3. Consider whether to roll the parallel Python driver into a permanent `npm run video:ocr-parallel` workflow (it already is — `package.json` script alias exists).

## How to resume / inspect a future session

Per-run state lives at:
- `data/video_scan_<YYYYMMDD>/<run-tag>/.STATUS.json` — last probe log, expected total, next step.
- `data/video_scan_<YYYYMMDD>/<run-tag>/run_summary.json` — full job log with per-video status + video_type.
- `data/video_scan_<YYYYMMDD>/<run-tag>/timeline.json` — aggregated daily/weekend/feature rollup for the viewer.

If a session loses context, read those three files in order: `.STATUS.json` (where we are), `run_summary.json` (what happened), `timeline.json` (what's consumable).

## Known constraints (read-only)

- `D:\courses_F\revere_asset` is read-only reference asset directory; never write into it.
- Windows path mangling through bash heredocs is a recurring trap — anything that needs to ship a Windows path into a Node subprocess should go through Python's `subprocess.run` (no shell quoting in between), not bash.
