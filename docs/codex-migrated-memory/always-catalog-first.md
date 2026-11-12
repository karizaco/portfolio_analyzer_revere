---
name: always-catalog-first
description: Always run fresh catalog fetch before answering video availability/download questions
metadata:
  node_type: memory
  type: project
  originSessionId: ba4fc76f-933d-43f8-addb-9ea105b4d328
  modified: 2026-10-28T05:56:45.696Z
---

# Always Fetch Fresh Catalog Before Answering Video Questions

When the user asks about whether there are new/undownloaded videos, or any question about the current state of the video catalog:

**DO:**
1. Run `python tools/whiteboard_worker.py catalog --channel <channel> --source-url <url> --limit 5` (or higher limit)
2. Query SQLite to compare against `download_path` column
3. Report what the fresh catalog shows

**DON'T:**
- Trust the local SQLite catalog as up-to-date without refreshing first
- Answer "all downloaded" based on a stale catalog
- Answer questions about new uploads without checking YouTube directly

**Why this matters:**
- YouTube catalog changes constantly — new uploads appear daily
- Local SQLite is a snapshot, not live data
- Answering from stale data means missing new content

**Rule:** Any question of the form "are there new videos?", "what's not downloaded?", or "is the catalog current?" must trigger a fresh `whiteboard_worker.py catalog` call before answering.

**Running one (operational facts, as of 2026-10-25):**
- A catalog fetch downloads **no video bytes** — it is `--skip-download` metadata only. The
  user's real downloads happen on another machine; the catalog never touches the video dirs.
- A FULL Qullamaggie catalog is ~700 videos and takes **~3.5 h** (one yt-dlp invocation
  resolving per-video metadata). Run it in the background. `--limit N` maps to
  `--playlist-end N`, so a small probe is cheap; the full run is not.
- Add `--sleep-requests 1` to space the requests. It does apply here — this path is ONE
  yt-dlp invocation, not one per video.
- **A partial run is now preserved.** The worker used to check yt-dlp's exit code BEFORE
  parsing stdout, so a DNS blip near the end threw away every row it had already collected
  (this cost a 3 h 23 min run on 2026-10-25). It now imports the rows it did get and reports
  `status: "partial"`. Regression-tested in `test/whiteboardWorkerCatalog.test.js` with a
  fake yt-dlp — no network needed.
- Where the output goes: the TSV snapshot lands in `data/video_pipeline/catalog/` and is
  **gitignored**; `data/video_pipeline/state.sqlite` is the only catalog output that is
  **tracked** in git.

**The gap-filler (`fill-dates`, added 2026-10-26):**
- The catalog resolves a channel one video at a time, so the videos it fails on are left
  with an empty `upload_date`. `fill-dates` resolves a `video_id<TAB>title` TSV directly,
  in `--jobs` parallel batches, and upserts through `upsert_catalog_rows` (so `status` and
  `download_path` are never touched — the user's download bookkeeping is safe).
- **The client set decides the speed.** Measured per video on the same list: `mweb` 4.2 s,
  `mweb,ios,android,web` 8.5 s, `ios,android,web` 123 s. yt-dlp queries **every** client
  in the list, so extra clients cost time on EVERY video, not just the failures. Use
  `mweb` alone for the bulk pass.
- **It saves per batch (`--batch-size`, default 25) and skips videos that already have a
  date.** So the bulk pass is interruptible, and a second pass with the slow fallback
  clients only fetches the stragglers.
- Measured cost: ~1.7 cores of 24 (7% of the machine) at `--jobs 6` — network-bound, not
  CPU-bound. The heavy background CPU on this machine is the user's own apps (TradingView
  ~6 cores, `C:\Jts\tws.exe` ~3, browsers ~5).
- Channel sizes measured 2026-10-25: **Qullamaggie 588** (dormant since 2023-12-15),
  **Revere 1,811** (uploads daily).

**The gap-filler now builds its own work list (2026-10-26):**
- `fill-dates --build-listing` fetches the channel listing, diffs it against the DB, and
  resolves what is missing — **it needs nothing but the channel and the DB**, so it runs
  on a fresh clone. `--from-listing <file>` does the same from a listing you already have.
  `--input` still works and takes precedence.
- This closed a real reproducibility gap: the script that built the work list lived in
  `%TEMP%`, not in the repo, so `fill-dates --input` was a dead end for anyone else.
- Two traps the reader now handles: the listing separator may be a **literal `\t`**
  (the shell hands yt-dlp backslash-t and yt-dlp prints it verbatim), and the bytes may
  be **cp1252, not UTF-8** (yt-dlp's stdout goes through the Windows console codepage).
  Getting either wrong made the whole listing unparseable.
- `fill-dates` now **stores the title of a video it could not date**. An age-restricted
  upload can never be resolved, so if the title is not stored it lives only in a
  gitignored TSV. An existing title is never overwritten — the listing is lossy.
- `fill-dates` now records itself in `catalog_runs`, with the honest count of videos left
  undated. The campaign that built the catalog had left NO run row at all.
- `catalog_runs` rows carry a `kind` (`live` / `fixture`) and a **repo-relative**
  `raw_output_path`, so the audit table reads the same on every machine. Both ship as
  migration version 2.

**The catalog IS in git** — `data/video_pipeline/state.sqlite` is tracked (the only
tracked file under `data/video_pipeline/`; `.gitignore:4-5` ignore the directory and
re-include the DB). What is only local is `data/catalog_flat/*.tsv` (a regenerable
cache with no `upload_date` in it) and `data/video_pipeline/catalog/catalog_*.tsv` (run
snapshots). See [[catalog-tracking-what-is-in-git]].
