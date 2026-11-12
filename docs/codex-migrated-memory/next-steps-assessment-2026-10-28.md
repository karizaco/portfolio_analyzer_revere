---
name: next-steps-assessment-2026-10-28
description: "Verified priority list of what to fix next in the OCR pipeline, from a 5-lens audit on 2026-10-28 — the five blocking items were fixed on 2026-10-29, plus six more in phase 3 (portable paths, migrations, the not-listed report, the .part inventory), the status contract plus the last undated rows in phase 4, the Revere whiteboard parser (resolver, case rule, fused-token splitting, real-frame fixtures, a scoring tool) in phase 5, the chart-stream curated-alias rescue in phase 6, the SPXL fix in phase 7, the seed's blast radius plus a duplicate-seed-row defect in phase 8, the ground-truth audit (three passes) plus the Filter B rewrite and the lexicon cleanup in phase 9, the column gate, the one-glyph rule and the ERA-CONDITIONAL crop in phase 10, and the 2023-era PRODUCTION smoke scan plus the RGN→RGTI alias row in phase 11; the expensive sweeps are still open"
metadata:
  node_type: memory
  type: project
  originSessionId: 909a4330-b5c4-47fe-b9c1-83296bf43698
  modified: 2026-11-02T10:45:10.128Z
---

A five-lens read-only audit of the repo ran on 2026-10-28 (workflow run
`wf_f9b5c209-9f3`). Every claim below was re-verified by hand afterwards.

## The five blocking items were fixed on 2026-10-29

All on branch `fix/cluster-overrides-capture-tickers`; `npm test` → 323 pass.

1. **Capture ticker routing** — new `src/video/captureTickers.js`. The
   whiteboard field to read is `capture.tickers`, **not**
   `parsed_observations[].tickers_from_bbox` and **not** the never-written
   top-level `capture.tickers_from_bbox` (present in 0 of 1281 captures). Chart
   stream reads `capture.chart_stream.position_list`. Effect: the aggregator
   produced 29/15 (a regression from commit `89af843`) and now produces
   **271 captures with tickers / 56 unique tickers** vs the committed
   **269 / 52** — the four recovered are real QMG holdings (`COPX`, `DVN`,
   `MOS`, `NRGU`), and 2 chart_stream captures contribute at all. `data/analysis.json`
   and `.md` were regenerated with the fixed aggregator.

2. **Probe-log path resolution** — new `src/video/probeLogDirs.js`, shared by
   both aggregators. Three layouts: flat `<date>/<tag>/ocr_probe/logs`, doubled
   `<date>/<tag>/<tag>/ocr_probe/logs` (what `parallelOcrScan.py` writes — and
   what **all six** committed `timeline.json` files use), legacy root
   `<date>/ocr_probe/logs`. `tools/aggregateOcrTimeline.js` resolved only the
   flat layout, so it exited 1 with "No probe logs found" on every committed
   run. The six `timeline.json` files were regenerated.

3. **Lexicon variant rows** — the **eleven** OCR-variant rows
   (`AROQ, ARCQ, OBTS, GSII, IOI, PLIR, NUGI, JNUG, ~09r3, GSlT, MNOY`) were
   deleted from `config/ticker_lexicon_seed.csv` (233 → 223 rows). The **real
   `JNUG` at line 201** (junior gold miners 2× ETF) was **kept** — the deleted
   line 245 was a redundant duplicate. Measured with the no-OCR replay
   (`node tools/evalParserReplay.js`, 0.24 s): recall **unchanged at 56.3%
   (71/126)**, precision **92.2% → 93.4% (71/77)** — the `OBTS` FP in 20230523
   is gone. The `O,D` row added to `config/ticker_char_confusion.csv` is
   strictly additive (3,549 O-containing single-substitution reads → 0 changed,
   0 lost, **38 gained**), and `MNOY→MNDY` / `GSLT→GSIT` are recorded as alias
   rows in `config/ticker_ocr_confusions.csv` instead.

4. **Download query + recovery manifest** — new `src/video/downloadCandidates.js`.
   `tools/downloadQmg1080p.js` selected **47 of 588** QMG rows because its
   `NOT LIKE '%downloads_1080p%'` excluded the very rows that needed a second
   1080p copy. The shared query now yields **588 candidates, 49 on disk, 539
   still to download**. `tools/inventoryLostVideos.py` was rewritten to resolve
   every pointer against the filesystem: the manifest now lists the **537
   missing** videos (514 QMG) and counts the **179 still on disk**, and its
   note no longer claims a blanket 2026-10-21 deletion. The 716 pointer rows
   break down exactly: **514** point at the bare `downloads_1080p/<id>.mp4`
   (an older naming scheme — all 514 are missing, and today's convention
   `<date>_<id>.mp4` can never reach them), **23** live in `downloads/`
   (all missing), **27** in `downloads_1080p` under today's scheme (present),
   and **152** in `downloads_hires` (present). Note: the "324" figure in the
   earlier audit was wrong — it is **514**.
   **A file can be on disk with no pointer naming it**: `downloads_1080p` holds
   49 `.mp4`, and all 49 are found by the *downloader's own name*; the
   catalog pointer resolves only 27 of them.

5. **Benchmark clone safety** — the four 1920×1080 frames are now tracked under
   `test/fixtures/qmg_benchmark/` with a `manifest.json` recording the md5 of
   each. `resolveSnapshotPath` prefers the fixture and **throws** if its md5
   changed; a missing frame is now a skip-with-warning, not a hard failure.
   `test/qmgBenchmarkFixtures.test.js` is the fast (seconds, no OCR) half.

   | case | fixture | md5 |
   |---|---|---|
   | trade_ideas 20220218[1] | `trade_ideas_20220218_c1.png` | `d6a45e350aeacf16c704d324f0ed18a5` |
   | sparse 20221104[0] | `sparse_20221104_c0.png` | `7d766f71608427d09c8dbf0592b81445` |
   | normal_2022 20220606[1] | `normal_2022_20220606_c1.png` | `e34b828300318085b07166a87aa50f98` |
   | dense_2023 20230609[0] | `dense_2023_20230609_c0.png` | `d53cb5fab33eba46e73ba40a7477f91e` |

   The frames are now pinned, so a recall number is a property of (code, frame)
   and the two must be quoted together. **Re-verified 2026-10-29** against the
   pinned fixtures: 88.9% / 100% / 87.5% / 46.2%, overall **80.6%**, all four
   cases passing, in 864 s — identical to the table recorded on 2026-10-25, so
   the fixtures are the same images and none of the five fixes moved the
   chart-stream benchmark.

## Phase 3 (2026-10-29, after the five blocking items)

Six more items from the audit's "Still open" list were fixed the same day.
`npm test` → **339 pass**.

**The portable-path rule.** A path inside the repository is stored relative to
its root; a path outside keeps its absolute form (there is no honest relative
form for a path from another machine). **Two implementations must agree** —
`portable_stored_path()` in `tools/whiteboard_worker.py` and `toPortablePath()`
in `src/video/downloadCandidates.js` — and `test/catalogPathPortability.test.js`
pins that they do. **Migration 3** rewrote the shipped catalog: **392**
absolute in-repo pointers became repo-relative and **not one changed what it
resolves to** (each was compared against its old absolute path — 0 mismatches,
179 present / 537 missing before and after).

**Migrations are version-gated, and a version once applied is closed.**
`_apply_migrations()` now runs versions 1–5 (1 `channel`, 2 `kind`, 3 the
pointer rewrite, 4 `not_listed_count`, 5 `listing_complete`). Two mistakes
shaped this: version 1 backfilled `channel` without adding it first (which
aborted on a pre-existing DB and left it unopenable), and adding
`listing_complete` to the already-applied version 4 meant it **never ran**.
Also: `data/db/schema.sql` now describes `videos` and `catalog_runs` exactly as
the shipped DB has them — same columns, same order, same CHECK on
`videos.status`.

**The "7 Revere rows are no longer returned" claim does not reproduce.**
Against a fresh listing of `@revereasset` taken 2026-10-29 (1,814 videos) vs
1,813 catalog rows, **zero** rows were missing; the only difference was one new
upload (`NqkkWLhHiL0`, 2026-10-28), now added. The original claim came from a
stale listing. The catalog holds **2,402 videos** (1,814 Revere + 588 QMG).

**Detection was added anyway, with the right caveat.** `catalog` now reports
`not_listed` / `not_listed_count` / the ids, and records `listing_complete` in
the `catalog_runs` row. **Absence from a `/videos` listing is an observation,
not proof of deletion** — Shorts, livestreams and members-only content are not
listed there either — and `listing_complete` is 0 whenever the listing cannot
be trusted (`--limit`, `--playlist-items`, or any `ERROR` on stderr;
`--ignore-errors` makes yt-dlp exit 0 on a per-video failure, so the exit code
alone proves nothing).

**The orphan `.part` files are inventoried, not deleted.**
`tools/reportPartialDownloads.py` reports and never deletes. **40 files,
10.15 GiB**, all Qullamaggie, all dated 2026-09-22…24. **All 40 are in the
catalog.** **39 have no completed copy** — the partial file is all there is of
those downloads. Exactly **1** is redundant
(`downloads_hires/20230601_1HFPeLD2zwc.mp4.part`, 247.4 MB). Matching a
`.part` file to a video needs **both** id forms: a Sept-2026 run named files
`<_id>.mp4.part` with the underscore *prepended*, and some QMG ids start with
an underscore themselves — so `_Vn-EBl95hes.mp4.part` is the video
`Vn-EBl95hes` and `__2urSPdZVec.mp4.part` is the video `_2urSPdZVec`. Without
both forms, 37 of the 40 look like they are not in the catalog. One video was
downloaded twice under both spellings (`uTMK9uhQZCc`).

## Still open

**Blocking, expensive but the biggest gain:**
- The `position_table` profile is the only reader with a measured exact match
  (7/7, zero FP on 20220222) and it has been run on **ONE date** — 2 captures,
  `position_table` — against `chart_stream`'s 398. The 2022-2023 QMG window is
  76 videos. *Needs the user's go-ahead: 10–16 h of EasyOCR.*
- The 539 QMG 1080p downloads. *Needs the user's go-ahead: network and
  YouTube rate-limit budget.*

**The catalog is still partly stale:**
- 716 rows carry a `download_path`; **537 point at files that no longer exist**
  (514 QMG + 23 Revere). That is *now* portable but still stale — the pointers
  are correct in form and wrong in fact. The re-download list is
  `data/qmg_video_recovery_manifest.json`. A row can be simultaneously
  pointing at a file that is gone *and* have its media on disk under the
  downloader's own name — so the repair rule matters, and is under
  investigation.
- A catalog refresh never re-reads a row that already has a date, so a wrong
  date or title is permanent. (`fill-dates --refresh` re-reads dated rows and
  reports `dates_changed`; a catalog refresh does not.)

**Smaller, verified:**
- `catalog_runs` accounts for only ~300 of the insertions; a 1,570-row Revere
  insert left no run row. The audit trail is incomplete, so a reader cannot
  tell which tool put which rows in the catalog.
- The `OBTS→QBTS` repair does **not** fire for the 20230523 frame: the
  chart-stream alias needs the column gate AND in-column membership. Fixing it
  means changing the column gate — out of scope for the variant-row cleanup.
  **CLOSED in phase 6**: the curated-alias rescue is exactly that change, and
  `OBTS→QBTS` now fires (QBTS ×2 added across the corpus, both in the GT).
- The 39 `.part` files with no completed copy are the only copy of those
  downloads. Deleting them (or resuming the downloads) is the maintainer's
  call; the tool only reports.

**Untrusted by a reader (zero consumers):**
- `data/revere_ground_truth.json` — 4 dates / 6 frames / 79 holdings. The
  whiteboard path scores 86.1% micro recall against it, but 20260924 has
  regressed to 42% and nothing signals it. There is no tool that recomputes
  the number, so the regression is invisible.
- `tools/evalParserReplay.js:103` skips logs with zero predictions and only 35
  of 207 GT-date logs store `ocr_words`, so its 57.4% recall has 83%
  survivorship bias.

**Closed since the audit:**
- The five blocking items (phase 1) and the portable-path rule, the
  migrations, the not-listed report and the `.part` inventory (phase 3) — see
  above.
- The status state machine, the 21-row stale-`done` reset and the dead
  artifact columns (phase 4).
- The last three undated rows; the catalog now has **zero** of them.

Related: [[catalog-tracking-what-is-in-git]], [[qullamaggie-position-table-profile]],
[[revere-ocr-progress]], [[always-catalog-first]], [[clusterer-measurement-by-log-replay]].

## Phase 4 (2026-10-29, the status contract and the last undated rows)

`npm test` → **400 pass** (was 339 after phase 3).

**The `videos.status` state machine is written down once.** New
`src/video/videoStatus.js` is the single source of truth: what each status
means, which tool writes it, and the two downloaders' work lists (the 720p
batch retries `error`, the 1080p batch does not). Both queries are now built
from it, so a filter cannot drift from its documentation.
`test/catalogStatusContract.test.js` pins the schema's CHECK list against the
module's, checks that every named writer file still exists, and runs both
queries against the shipped catalog so a broken template cannot reach
YouTube.

**The trap that made a deleted file invisible.** `done` records that a pass
finished — it says nothing about whether the media is still on disk. Both
downloaders exclude `done` from their work, so a `done` row whose file was
deleted is neither re-fetched nor reported as missing. **21 rows** were in
exactly that state on 2026-10-29 (all Revere, all pointing into the
`downloads/` directory the 2026-10-21 cleanup removed).
`tools/reconcileCatalogStatus.js` resolves every pointer against the
filesystem and resets the false claims to `pending` (dry-run by default,
`--execute` to apply). The reset is **21, not 23**: two rows have stale
pointers but their media *is* on disk under the downloader's own name, so
their claim legitimately holds.

**The asymmetry that makes this survivable on one path and not the other.**
`whiteboard_worker.py command_scan` marks a row `error` when its media file
is missing, and `error` **is** a download candidate — the worker heals itself
on the next pass. `runAllOcr.js` flips `scanning` → `done` without looking at
the filesystem, so nothing ever notices a file that vanished afterwards.

**The four artifact columns are dead in this catalog, and now that is pinned.**
`output_path`, `review_reason`, `selected_timestamp` and `selected_score` are
written **only** by `whiteboard_worker.py command_scan`, which has never run
here — the Revere OCR goes through `runAllOcr.js`, which writes a probe log
instead. So `status='done'` points at no artifact through the database while
the probe logs that hold the artifact path are pruned. A test asserts the
count is 0, with a message saying what to do if that changes.

**The last three undated rows are dated.** An age-restricted upload is refused
by yt-dlp before its metadata is read, so `fill-dates` cannot date it — and an
undated row falls out of every date-keyed layout the pipeline has. The
**watch page** carries the date anyway (`"uploadDate":"2022-03-03T06:59:31-08:00"`
in its embedded JSON), served to a logged-out client even for an age-gated
video. New `tools/resolveUndatedDates.js` reads it and **cross-checks it
against the listing order**: the listing is newest-first, so the date must
satisfy `older < target <= newer` against its dated neighbours — a bound from
a completely different source. The method was validated **12/12** against
dates yt-dlp had already resolved.

The tool **refuses** rather than writes whenever there is nothing to agree
against: no listing, a video not in the listing, **a listing with no dated
neighbour** (a bound with nothing on either side constrains nothing, so every
date satisfies it — accepting one would mean trusting the page alone), a date
outside the bound, or an unreachable page.

On 2026-10-29 this closed the last three (all QMG, all age-restricted):
`te9tmNOA38I` → 20220303, `xNL-i3acbVk` → 20220216, `fhH3wxpQxxE` → 20191029.
**The catalog now has zero undated rows.** The dates were cross-checked
against bounds derived independently from the listing order, and the bounds
the tool computed matched those derived bounds exactly.

Two traps in that tool worth remembering: the plan was synchronous while the
real fetch is asynchronous, so the page arrived as `"[object Promise]"` and
**every** video was reported as having no date — a silent, total failure that
still produced a clean-looking report; and a bound with nothing on either side
constrains nothing, so "accept if within the bound" accepted everything.

## Phase 5 (2026-10-29, the Revere whiteboard parser)

`npm test` → **471 pass** (was 400 after phase 4).

The Revere whiteboard path had a ground truth and **no way to read a number
off it**. Now it has three: a resolver, a parser fix, and a scoring tool.

**Two lexicons, two jobs.** `loadSeedLexiconSync()` is the **allow** list
(what may be REPORTED, 223); `loadDecodeLexiconSync()` (seed + observed, 249)
is the **match** lexicon (what a token MAY BE). SPXL is match-only: it
resolves to *itself* rather than to a neighbouring seed ticker (SOXL), and is
then dropped. A correction must be the **unique** candidate at the minimum
edit distance — `IBT` is one edit from both IBIT and IOT, `SPO` from both SPOT
and SSO, and neither is guessed.

**The rules that turned out to be load-bearing** (all in
`src/parse/parseWhiteboardScreenshotWithBoxes.js`):
- A misread portfolio label (`TURBO` → `TURBG`) cost the **whole** portfolio,
  and the section filter **fails open** when it cannot find a section — so the
  action line's tickers (DELL, SMTC) came in as holdings.
- The section must end at the portfolio's **own labelled action line**, not at
  the next `* ` — the action line is often read with a quote, not `* `.
- **A correction is only safe inside a LIST.** The chart is drawn beside the
  holdings list on the same lines, and its annotations are one edit from real
  tickers (`wal”` → HAL, `by` → BE). A merged group (comma/slash) *is* the
  evidence; a standalone word needs the **capitals** to stand in for it. The
  case rule gates the *correction* only.
- The section filter runs on the **RAW** text: a corrected ticker is not in
  the OCR text at all, so filtering on the corrected form rejects it.
- `splitFusedTicker` needs length ≥ 5 and requires a **two-character** part to
  be an EXACT ticker — so `UP.` is not `U`+`P` (the screen says `MU,P`) and
  `SP` cannot "correct" to `SPY`.
- The expansion must run **before** the ticker-shape test, or `LITE.OOCN` (a
  comma read as a period) is lost before the splitter can see it.

**The measurement.** Over three real frames (20260922 / 20260924 / 20260928)
against `data/revere_ground_truth.json`: **79/95 readings before, 90/95 after**
(83.2 % → 94.7 % recall), precision 100 % both ways. The five still missing
are **OCR losses verified against the pixels** (`MU,P` → `UP.`, `IBIT` →
`IBT`, `SPCX` → `SPO`), not parser decisions.

**The fixtures keep the pixels as well as the OCR.** A synthetic PNG failed
the window detector because it had only ONE dark column — the detector was
right and the fixture was wrong. `test/fixtures/revere_whiteboard/` now holds
three real frames with both pixels and OCR frozen, md5-pinned in a manifest.

**`tools/evalRevere.js` scores the RECORDED output**, not a re-parse, so a
parser fix is invisible in it until the videos are re-scanned. Its consensus
across runs is an **INTERSECTION**, not a union.

**SPXL was an open question for the user** (see Phase 7 — the user answered
it, and the answer was "fix the parser").

**Measurement trap worth remembering:** comparing two *independent* OCR passes
of the same video mixes the parser effect with Tesseract's non-determinism
(16 of 268 captures differed between two runs of the same code). Only a
**cached OCR** can attribute a difference to the parser.

## Phase 6 (2026-10-29, the curated-alias rescue)

`npm test` → **480 pass** (was 471 after phase 5).

**Why a garbled ticker was lost, structurally.** `inListTickers` is the
**price-aligned subset** of the detected column, so a row whose price is
garbled (`$lO5.OO`) is not in it, and the column gate rejects the token —
before the repair pass ever sees it. The gate is what keeps chart-area ink
out, so it cannot simply be relaxed.

**The rescue.** Substituting the canonical from `config/ticker_ocr_confusions.csv`
for a token that is **spatially inside the column**, whether or not the gate
accepted it. Three rules: inside the column; below the positions header and
above the watchlist header (the panel's **own** bounds); the canonical is in
the lexicon.

**Two designs that failed, and why both are worth remembering.**
- **A y-range gate on the rescued token**: the range comes from the *accepted*
  set, which excludes exactly the rows worth rescuing (a garbled price is why
  they were excluded). It rejected all eight rescuable holdings.
- **`impliedBottomLine`**: that is the caller's *heuristic* guess at where the
  list ends, and the parser never applies it to the accepted set. The real
  lists are longer than 15 rows.

**And the one that nearly shipped: pushing the canonical in BEFORE the repair
pass.** The repair pass's `!accepted.includes(aliased)` guard then failed, so
the raw survived as a duplicate FP, and the extra entries shifted Filter B's
median y and evicted real holdings (GTLB, DNA, APLD, UPST) — precision fell
93.0 % → 86.2 %. The rescue therefore runs **after** the repair pass and
**replaces in place**.

**Measured** with `node tools/evalParserReplay.js --json` (default 8 roots).
Census: 42 files, 42 logs, 11 with words, 12 captures with words, 40 GT dates,
33 with a log, **8 dates scored**, 25 lost to missing words. Recall
**59.6 % → 66.3 %**, precision **93.0 % → 95.2 %**. A **corpus-wide audit**
over every word-bearing capture found **10 additions, all 10 in the ground
truth, and no removals at all**.

**`hasPriceNear` threw on OCR text with regex metacharacters.** It interpolates
the ticker into a `RegExp`; `"1.02(-0.20"` (a real whiteboard reading) made an
unbalanced `(` and the whole parse died with `SyntaxError: Unterminated group`.
Now escaped, and the whiteboard call site runs the cheap shape test first.
Escaping also makes a dotted ticker literal — `BRK.B` no longer matches
`BRKXB`.

**The fuzzy resolver was A/B'd over the whole cached corpus**, not just the
three fixture frames: **21 additions, 21 in the ground truth (100 %); 4
removals, 0 in the ground truth (0 %)**. The removals are the **action-line
bleed** — 20260924's own note reads `TURBO RVAB: … SELL DELL SMTC`, so `DELL`,
`SMTC`, `BITO` and `SHOP` are what the action line says, not holdings. So the
resolver invents nothing on this corpus, and the section fix removes exactly
the action line's contribution.

## Phase 7 (2026-10-30, the SPXL fix)

`npm test` → **487 pass** (was 480 after phase 6).

**The user answered the SPXL question**: *"SPXL is in the TURBO portfolio and
the ground truth should be that SPXL was a position at that time … I do not
understand why parser is dropping SPXL but if it does for whatever reason,
then it needs to stop doing that."* So the **ground truth was wrong**, not the
screen, and the parser had to be fixed.

**Why the parser dropped it** (the mechanism, since it was asked for): SPXL
resolved **exactly** — it was already in the observed (match) lexicon — and was
then discarded by the **allow-list gate** (`NOT_IN_ALLOWLIST`), because the
seed (allow) lexicon had no SPXL row. It was found and then forbidden to be
reported, not misread. Two further defects hid it: the screen writes
`UPRO/SPXL`, and on 20260924 the OCR read `UPRO/SPXLIBT` (SPXL fused with
IBIT, comma and `I` lost), which `splitFusedTicker` returns **null** for
because the trailing "IBT" is ambiguous between IBIT and IOT.

**Three changes.** SPXL added to the seed allow-list (the MATCH set does not
change, so no new ambiguity is possible and the chart-stream path is
untouched); the ground truth lists SPXL second in every TURBO list; and the
action line is now excluded **by POSITION** (from the `RVAB` keyword onwards,
a word is action text), because the section filter is a **substring** test and
cannot tell the holdings line's SPXL from the action line's SPXL. Plus
`splitFusedTickerExactPrefix()`, which recovers the **leading** ticker of a
fused token when the remainder is unreadable — the leading part is an EXACT
lexicon hit, which is not a guess.

**The ground truth was verified from the pixels on all four dates** — the three
pinned fixtures plus 20260923 read from the video at 800 s. SPXL is second in
every TURBO list; GRO never held it.

**The measurement went DOWN by one reading, and that was the fix working.**
The pre-fix parser read a `P` in the 20260924 GRO holdings that came from the
**action row** (the tail of `O-TRIM P`), not from the holdings list; removing
that one OCR word makes the pre-fix parser lose it too. It had scored as a hit
against a GT that legitimately contains `P` — a coincidence. The post-fix
parser excludes the action line, so `P` is an honest OCR loss (`MU,P` was
OCRed as `AUP.`).

**A/B over the whole replayable corpus** (19 cached captures, 4 videos): the
two parsers differ on **two** captures — one **gains SPXL**, one **loses the
action line's `P`**. The other 17 read identically. No holding is lost
anywhere else.

**Measurement trap, confirmed again:** the probe logs do **not** retain word
geometry, so the re-parseable corpus is the OCR cache
(`data/revere_ocr_cache.json`), not the logs. `tools/evalRevere.js --replay
--ocr-cache …` is what makes two parser versions comparable; without the cache
the comparison mixes parser change with Tesseract noise.

## Phase 8 (2026-10-30, the seed's blast radius and a duplicate-row defect)

`npm test` → **490 pass** (was 487 after phase 7).

**"The chart-stream path is untouched" was WRONG, and measuring it proved it.**
The seed lexicon does two different jobs in two different places: the
whiteboard parser uses it as the **allow** list, but `parseChartStream.js`
(`:570`, `:1149`) uses it as the **match** list. SPXL was only in the
*observed* lexicon, so on the chart-stream path it was **not a match either** —
and `findCloseTickerMatch` repaired it to **`SOXL`** (one edit, `O`→`P`, and
SOXL is in the seed). Qullamaggie held SPXL on 20220331; the parser published
**SOXL** instead, as a false positive on the very date the holding was real.
Adding SPXL to the seed fixed it. Measured on the wide corpus
(`data/video_ocr_probe` + `data/video_scan_test/_rerun`): **109/170 → 110/170
hits**, precision 81.3 % → 82.1 %, and exactly **one** date changed (20220331:
the SPXL false positive became a hit, and the SOXL false positive went away
with it). The default 8-root replay is byte-identical either way.

**The lesson: "the seed is the allow list" is true of ONE consumer.** The seed
has three consumers and they use it for different jobs — the allow list, the
match list, and a set of correction candidates. A change to a shared config
file has to be measured against **each** consumer, not reasoned about from the
one you are looking at.

**The whiteboard path cannot gain a new ambiguity from an allow-list addition.**
Its MATCH set is `seed + observed`, and SPXL was already in the observed half,
so the resolver's candidate set is unchanged. Enumerating every token within
one edit of any of the 249 match-list tickers (20,801 tokens): **0** resolution
changes, **68** reportability changes (all one-edit neighbours of SPXL the
resolver had already decided was SPXL). The fix lets through readings the
resolver had made; it does not make new readings.

**A pre-existing defect surfaced while measuring this: 13 tickers were on TWO
seed rows.** The seed is a SET, and a ticker may be seeded for more than one
reason — `SPCX` was both a "seeded recurring ETF" and a "seeded Discord
recurring", and the file recorded the two reasons on two rows.
`loadSeedLexiconSync` de-duplicates the set it returns, so the defect was
invisible there. **`loadTickerRepairConfig` did not**, and the legacy repair
scores every seed **entry** (`addScore(seedTokenScores, ..., 20)`), so a ticker
listed twice scored 40. `findBestCorrection` multiplies the score by 10 while
an edit costs 25 — so the doubled score outweighed the edit distance outright,
and **71 correction targets flipped** on the duplicate rows alone (`TEM` →
`TEAM` instead of itself; `IBIS` → `NBIS` instead of `IBIT`; `MRA` → `MRNA`
instead of `URA`).

Fixed at both ends: the 13 duplicate rows were merged into one row per ticker
(both notes kept), and `loadTickerRepairConfig` now de-duplicates like the
scanner does. The committed `data/portfolio_snapshots.csv` holdings are
**unchanged** (0 moved), the chart-stream replay numbers are unchanged, and the
Revere replay is unchanged at **94.0 % (140/149) / 100 %**. Pinned by
`test/lexiconVariants.test.js`.

**The stale replay table in CLAUDE.md was updated.** The default-roots row still
quoted the pre-rescue 59.6 % / 93.0 % while the rescue section recorded 66.3 %
/ 95.2 % for the same run. Current: default 66.3 % (59/89) / 95.2 % (59/62);
wide corpus 64.7 % (110/170) / 82.1 % (110/134).

**Three Workflow runs died with API 429** ("The Token Plan usage limit has been
reached") this session, so the audits were done by hand — the corpus A/B, the
pixel verification, and the 20,801-token resolution enumeration.

## Phase 9 (2026-11-01, the ground-truth audit and Filter B)

`npm test` → **534 pass** (490 after phase 8).

**The ground truth was a hand-made reading that nothing compared to its
pixels.** `data/qmg_ground_truth.json` had eight classes of defect, found in
three passes over **94 pinned panel crops** (`test/fixtures/qmg_ground_truth/`,
md5-pinned, each crop showing the ticker column AND the panel's own footer):
a misread ticker, a missing capture, a wrong anchor, a reading off the
**watchlist** instead of the positions table, a **duplicate top-level key**
(`JSON.parse` keeps the last copy and says nothing — 24 of the file's 45 keys
appeared twice), a copied column, a partial reading of a crop, and a dropped
row.

**The rule that made the defects detectable: the panel prints its own row
count.** The footer reads `N Items in Personal WatchList`, `1 Item …`, or
`K of N Items …` where **K is the selected row's INDEX**. N is the number of
rows on screen (the panel is not scrolled), so `panel_count == |tickers|` is a
per-capture invariant. **It does not catch a wrong-widget reading** — the
watchlist prints its own count just as faithfully — so the positions table is
identified by its **TITLE** (`A - Positions`) and by being the **bottom-most**
table. `"Personal WatchList" does NOT identify it`: the 2022-era frame carries
three right-hand widgets and **two** of them print "Personal WatchList".

**A capture index is RUN-RELATIVE** — `qmg_<date>_<n>.png` holds a different
image in every run directory. Three dates were anchored wrongly in three
different ways (20220218's captures 0 and 1 were swapped; 20220406's order is
reversed; 20220429's three captures span two runs). A date key can also cover
**more than one video** (20220606 holds three probe logs and **three different
position lists**), and the day's ground truth is the **union** over its
captures.

**The anchoring rule:** a capture's ground truth is anchored to the frame the
hand reading was taken from (recorded in the tracked review page
`tools/qmg_snapshot_review.html`). It **reverted three of the audit's own
tentative corrections**, each a real difference from the frame that happened to
be nearest to hand.

**The position list changes DURING the session**, so the count invariant is
per-capture, not per-date (20220421: 14 rows at 15:27, 15 at 15:32, 16 at
15:57), and **the table is sorted by % Change**, so the row order is a property
of the sort, not of the portfolio — the checker compares sorted sets.

**Filter B was a unit error.** The rule was `yMedian ± 8 × lineHeight`, where
`lineHeight` is the median word **HEIGHT** (~54 px) where the intent was
**ROWS** (~90 px apart) — so the window spanned ~4.8 rows either side and
clipped the first and last row of any list longer than ~9 rows. Measured
corpus-wide, it dropped **50 ground-truth holdings**. The rule now is the
list's **own rows**: `selectPositionListRun` groups the column's words into
rows by OCR line, estimates the pitch as the **quartile** of the inter-row gaps,
splits into runs wherever a gap exceeds `pitch × 3.5`, and takes the longest
run. A ticker is a holding when **one of** its occurrences sits on one of the
run's rows — `tickerWordsMap` keeps every occurrence where `tickerWordMap`
keeps only the first, and the first alone loses holdings. The panel's own
upper bound is the second half: **nothing above the "A - Positions" header is a
position**. The legacy window survives only as the fallback for a frame whose
column could not be identified.

**The measured attribution, and it is separable.** Filter B is **+5 hits** on
each corpus; the four new alias rows are **+4** on the wide corpus; the 16
new seed rows are **+2** on each; the four 2026-11-02 alias rows are **+2** on
each and the `N -> AI` row is **+1** on each. Shipped: default **83/85/83 =
97.6 % / 100 %**, wide **136/168/154 = 81.0 % / 88.3 %** (from 72/85 and
120/168 at `HEAD`).

**Two regressions, recorded rather than hidden.** `20220323` **loses** `URNM`
and `X` — a garbage Tesseract capture where the column detector latches onto
the wrong column — and `20230518` **gains** one false positive (`TT`). The
curated EasyOCR benchmark moved **89.2 % → 91.1 %**, entirely from `dense_2023`
(9/13 → 10/13), and added **no** false positive.

**The two lexicon files were cleaned against the pixels.** The seed grew by
**16** pixel-verified Qullamaggie holdings (224 → 240 rows); the observed list
lost **9** rows the audit discredited (26 → 17) — five read off the upper
**watchlist** widget, two were misreads (`DCX`→`FCX`, `NDGU`→`NRGU`), one is in
no panel at all. **Every remaining observed ticker is now allow-listed in the
seed**, which is the property the two lists exist to express. The chart-stream
parser reads the **seed** only, so it is untouched by the observed removals; the
Revere replay is unchanged at **94.0 % (140/149) / 100 %**.

**Two brittle test assertions had to go, and the properties replaced them.**
`aliasTableOverride.test.js` hard-coded the shipped alias row count (now
derived from the CSV); `tickerFuzzyResolve.test.js` asserted
`decode.length > seed.length` (now false — observed ⊆ seed — so it asserts the
stronger "every observed ticker is allow-listed"); `lexiconVariants.test.js`
asserted the `O→D` row's gain count of 38 (now 33, because 5 of the 38 were
repairs **into discredited tickers**) and now asserts that **every** gain is a
read with one of its O's read as a D.

**Still open:** the `position_table` sweep (10–16 h of EasyOCR), the 539
Qullamaggie 1080p downloads, deleting the 39 orphan `.part` files, and the
`selectFramesForOcr` seed-budget fix (the prefilter's score still has no
effect on which frames get OCR'd).

## Phase 10 (2026-11-02, the column gate, the one-glyph rule and the crop)

`npm test` → **547 pass** (534 after phase 9).

**The column gate's evidence was wrong.** It used **price-alignment** as its
membership test — "a token belongs to the column if some row of the column had
a readable price beside it". That is a proxy, and it fails exactly when the
price cell is garbled, which is when the ticker cell is most likely to be read
*perfectly*. On 20220330, NFLX/REGN/COPX/NUGT are read perfectly (conf 0.92,
0.96, 0.51, 0.50) and sit exactly where every other ticker sits, but their
price cells read `"0s63 ~0383"` — so all four were dropped **before Filter B**
ever saw them. The gate's membership is now the **union** of price-alignment
and the list's own row stack (which Filter B already computes). A token the row
stack admitted and price-alignment did not is accepted only if the **lexicon**
knows it — `hasPriceNear` scans the whole flattened OCR text, so it fires on
nearly every token and says nothing about a garbled price cell. Measured:
**+12 hits** on the wide corpus, **no date regressed**.

**The one-glyph rule.** A one-glyph cell is either a real one-letter ticker or
a collapsed multi-glyph cell, and the shape cannot tell them apart (`X` at conf
0.98 and `U` at conf 0.62 look identical). The **column** settles it: a column
with a *second* one-glyph read has demonstrated that it collapses cells, so none
of its one-glyph reads can be taken at face value. Confidence cannot do this
job — `U` reads at 0.616 on one capture and 0.743 on another. The rule moved
the whole corpus by **exactly one row** (the `U` false positive on 20230522).
There is no price-aligned escape hatch, and there cannot be: the detector
measures a cell's *centre*, so a one-glyph cell is never price-aligned — the
row stack is its only evidence.

**The crop is ERA-CONDITIONAL** (`src/video/chartStreamCrop.js`): Qullamaggie
moved his position list between 2023-01-26 and 2023-05-18, so there are two
rectangles, chosen by the upload date. The old default had **two independent
defects** — its x window started to the *right* of the sidebar column (so a
sidebar-era frame read ZERO holdings under it, under every y variant) and its
y window clipped the first and last row of a long list in both eras. Measured
over the 94 pinned ground-truth captures: 2022 era 74/85 → **78/85** at
unchanged precision; 2023 era 27/56 → **69/75** with 8 FP. See
[[qmg-crop-alb-reversal]] and [[qullamaggie-ocr-crop-analysis]].

**Shipped figures now:** default replay **83/85/83 = 97.6 % / 100 %**, wide
**148/168/166 = 88.1 % / 89.2 %**, curated EasyOCR benchmark **94.4 %** overall
mean recall (`trade_ideas` 7/9, `sparse` 1/1, `normal_2022` 8/8,
`dense_2023` 13/13 with **zero** false positives).

**A benchmark regression recorded rather than hidden:** `trade_ideas` went
9/9 → 7/9, because a taller 2022-era crop is downscaled more by EasyOCR and two
faint rows stop being readable. Over the nine pinned 2022-era frames the taller
crop is **+4 hits at unchanged precision**, so the trade is worth it — but a
four-frame benchmark cannot move a global default on its own.

## Phase 11 (2026-11-02, the production smoke scan and the `RGN` row)

`npm test` → **547 pass** (unchanged).

**The first end-to-end run of the era-conditional crop in the production path.**
Everything in phase 10 was a crop A/B on pinned frames and a no-OCR replay. The
smoke scan is the real pipeline: `tools/scanVideoWithOcr.js` on
`data/video_pipeline/downloads_1080p/20230609_VdQSDGZBLQE.mp4` (1920×1080 by
ffprobe), `--prefilter-profile chart_stream --chart-stream-parser --ocr-engine
easyocr --max-captures 1 --fps 0.25 --prefilter-max-frames 6`, run tag
`qmg-crop-20261102-smoke`. The log's `phash_region_fraction` is
`{"x":0.82,"y":0.6,"w":0.18,"h":0.32}` — the 2023-era rectangle, **chosen from
the upload date inside the tool, with no crop flag on the command line**.

**The crop works: the capture reads the date's holdings exactly.** The capture
at t=1944 carries a `position_list` of **13** tickers and `20230609`'s ground
truth is **13** — the same set, **zero false positives**. The old fixed crop read
**zero** holdings on this date. The frame's own OCR shows the alias table firing
**in production** on eight garbles at once (`INGN`→IMGN, `AROQ`→ARQQ, `A`→AI,
`ATR`→PLTR, `GllB`→GTLB, `GSI`→GSIT, `Apld`→APLD, `MNDy`→MNDY).

**And the scan found exactly one thing wrong: a WRONG HOLDING.** The merged list
carried **`REGN`** — a real ticker, a genuine holding on thirteen 2022-era
dates — where the panel showed `RGTI`. The panel's first row is `RGTI` in all
five OCR'd frames (pixel-verified), and EasyOCR read it as `Rgn`/`RGn` in two of
them. Normalised that is `RGN`, **one edit from `REGN`**, a seed ticker — so the
distance-1 repair pass published a wrong holding. Same failure shape as
`AROQ→ARQQ`, `IOI→IOT` and `OI→LMT`.

**The fix is the curated alias table** — the project's designated mechanism for
"a garble that happens to BE a valid ticker": `RGN,RGTI,T rendered as N and I
dropped (20230609)`. `RGN` is in neither lexicon, `RGTI` is in the seed, no
duplicate key, no chain. A search of **283 probe logs** found **zero** `RGN`
tokens, so it shadows nothing already measured. The table is now **39 rows**.

**The corpus cannot see this class, and that is the general lesson.** The row
measures **+0 on both replay corpora** (default 83/85 97.6 %/100 %, wide
148/168 88.1 %/89.2 %, identical with `--drop-aliases RGN`), because the corpus
holds no `RGN`. **A corpus number that does not move is not proof a change was
inert** — the replay corpus is a surviving sample of the *post-2026-10-18* crop
profile, and this misread is a property of the *new* 2023-era crop, which only
a production scan of a 2023-era video exercises.

Measured on the real production frames by re-parsing their recorded
`ocr_words` (no OCR): ts 3888 and ts 0 read `REGN` before the row and `RGTI`
after; the **merged list goes from 14 (the 13 holdings + `REGN`) to 13 — exactly
the ground-truth set, 0 FP**.

**And confirmed end-to-end with a SECOND, fresh scan** (`…-smoke-v2`, EasyOCR
re-run from the video, so an independent OCR pass rather than a replay): the
capture landed on the **same frame** (ts 1944) with the **same score (33.02)**
and the same `bbox_filter` geometry (`list_rows`, 13 rows, pitch 90), and the two
runs' **snapshots are byte-identical** (md5 `01a88225bf091391cfc0085201bc2391`
in both). Its `position_list` and `merged_position_list` are both **the 13
ground-truth holdings with 0 FP** — `REGN` gone, `RGTI` present. The two runs
are therefore the same frame read twice, and the difference between them is the
table.

**The defect lived in the MERGE, not in the capture — and that decides which
metric would have caught it.** Run 1's *captured* frame (t=1944) already read
the exact 13 holdings, `REGN` and all. `REGN` came from the **other five
frames**, two of which misread the `RGTI` row as `Rgn`/`RGn`, and the
**clusterer's consensus** over the six frames published it. So the **aggregator**
(which reads `capture.chart_stream.position_list`, `src/video/captureTickers.js:47-48`)
never saw the bad holding, while the **video-level** `merged_position_list` —
consumed by `tools/runQmgOcrBatch.js:143` and `tools/runQmgCuratedBenchmark.js:179`
— did. **Score the merged list, not only the capture.**

**A note on the output root:** the scan tool's default is `data/video_ocr_probe/`
(`src/video/ocrScanArgs.js:17`), so a run without `--output-root` lands there;
run 1 was launched with `--output-root data/video_scan_test/_rerun`. Both layouts
are the **flat** one `src/video/probeLogDirs.js` knows, so the aggregators find
either.

Pinned by `test/ocrConfusionAliases.test.js` (the row is in `NEW_ALIASES`, so the
three behaviour tests cover it). See [[qmg-pixel-verified-aliases]].

**Still open:** the `position_table` sweep (10–16 h of EasyOCR), the 539
Qullamaggie 1080p downloads, deleting the 39 orphan `.part` files, and the
`selectFramesForOcr` seed-budget fix.

