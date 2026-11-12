---
name: catalog-tracking-what-is-in-git
description: "Which catalog artifacts are tracked in git, which are local-only, and why the flat TSVs should stay out"
metadata:
  node_type: memory
  type: project
  originSessionId: 909a4330-b5c4-47fe-b9c1-83296bf43698
  modified: 2026-10-28T05:56:20.234Z
---

Measured 2026-10-26. The user asked whether the catalog is in the repo and whether it
should be.

**In git:**
- `data/video_pipeline/state.sqlite` — the catalog: 2,399 videos (1,811 Revere + 588
  Qullamaggie), 2,396 dated, plus 27 `catalog_runs` rows. It is the ONLY tracked file
  under `data/video_pipeline/` — `.gitignore:4-5` ignore the directory and re-include
  this one file, so it needs `git add -f`.
- `data/qmg_video_recovery_manifest.json` — the re-download manifest, regenerated from
  the DB by `tools/inventoryLostVideos.py`.

**Local only (gitignored):**
- `data/catalog_flat/*.tsv` — the channel listings. Regenerable in ~4.5 min of
  metadata-only network time; they regenerate **byte-for-byte identically**. They carry
  NO `upload_date` (the one field the catalog exists to capture) and they are **lossy**:
  cp1252 bytes, not UTF-8, with 3 emoji titles dropped.
- `data/catalog_flat/*_needs_date.tsv`, `*_missing.tsv` — stale work lists from a
  completed gap-fill.
- `data/video_pipeline/catalog/catalog_*.tsv` — run snapshots, strictly worse than the DB.

**Why the flat TSVs should stay out of git:** they are regenerable, they go stale daily,
they hold no dates, and 99.99% of their content is already in the DB. The only thing
they uniquely held — the titles of the 3 age-restricted Qullamaggie videos — is now in
the DB. Committing them would add a second, lossy source of truth that drifts.

**What actually WAS missing, and is now fixed:** the machinery to rebuild the catalog.
The script that built the work list lived in `%TEMP%`, so the gap-fill could not run
from a fresh clone. `fill-dates --build-listing` fixes that — see
[[always-catalog-first]].

**Two defects found in the committed data (fixed 2026-10-26):**
- `abc123` / `def456` — mock rows from `test/fixtures/mockYtDlpCatalog.py` had leaked
  into the production DB, carrying `status='done'` and `download_path` values for files
  that do not exist. They reached the tracked recovery manifest as re-download targets.
  Removed.
- `data/qmg_video_recovery_manifest.json` was **stale against the DB**: 519 titles were
  already in the database but missing from the manifest. Regenerating it produced a
  ~2,000-line diff that was a catch-up, not a regression.

**Three more defects fixed 2026-10-28 (migration version 2):**
- `catalog_runs.raw_output_path` held **absolute Windows paths**, so every pointer in
  the audit table resolved on the machine that made the run and nowhere else. Now
  relative to the repo root when the file is inside the repo (`portable_path()`),
  absolute when it is not — there is no honest relative form for another machine's path.
- `catalog_runs` did not say which rows were real. The worker's own fixtures point at
  `example.com/mock-playlist`; they were self-labelling but made up a sixth of the audit
  table. A new `kind` column says `live` or `fixture` (4 fixture, 24 live).
- `missing_upload_dates` counted the rows yt-dlp printed, not the videos the channel has,
  so every run reported 0 while videos were undated. `fill-dates` records the honest count.

**The fresh-clone claim is now a test, not a promise:**
`test/catalogFreshClone.test.js` copies the **tracked** files into a scratch directory —
nothing else — and runs `fill-dates --build-listing` there with a fake yt-dlp. If the
gap-fill ever needs an untracked file, that test fails. This is what closed the
"reproducible from a fresh clone" gap: the work-list builder used to live in `%TEMP%`.

Related: [[yt-dlp-client-set-speed]], [[always-catalog-first]].
