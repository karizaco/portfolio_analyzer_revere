#!/usr/bin/env bash
# Parallel OCR driver: mirrors tools/parallelDownload.sh but scans videos
# rather than downloading them.
#
# Reads scanning rows from data/video_pipeline/state.sqlite, filters out any
# that have an existing probe log under the destination RUN_TAG (idempotency
# inside this run) and, optionally, under a SKIP_FROM_TAG (lets a parallel
# invocation cooperate with an in-flight serial run), and then forks N
# scanVideoWithOcr.js subprocesses via xargs -P. Each subprocess handles one
# video at a time end-to-end.
#
# Why this is safe against an in-flight serial run:
#   1. Read-only on SQLite (we never UPDATE rows). The serial run still
#      owns `status`.
#   2. Probe logs go to <run-tag>/ocr_probe/logs/<...>.json, distinct from
#      the in-flight run-tag's dir, so no file collision.
#   3. Sibling subdirectories under the run-tag (sample/, screenshots/, ...)
#      are also distinct, so no ffmpeg-temp collisions.
#   4. SKIP_FROM_TAG=<in-flight-tag> makes us skip any row the serial run
#      already finished. The remaining overlap window is at most the row
#      the serial run is currently mid-flight on. Workers produce duplicate
#      logs under different run-tags -- wasteful but not destructive.
#
# Usage:
#   bash tools/parallelOcrScan.sh                          # 4 workers, all
#   bash tools/parallelOcrScan.sh 6                        # 6 workers
#   bash tools/parallelOcrScan.sh 4 30                     # 4 workers, max 30
#   RUN_TAG=ocr-20260915-p4 bash tools/parallelOcrScan.sh 4
#   SKIP_FROM_TAG=ocr-20260915 bash tools/parallelOcrScan.sh 4 \
#       # cooperate with the in-flight serial run, skip finished rows
#
# Per-worker stderr/stdout is captured at
#   data/video_scan_<YYYYMMDD>/<run-tag>/<run-tag>_<upload_date>_<video_id>.log
# for post-mortem if any worker crashes.

set -euo pipefail

WORKSPACE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$WORKSPACE_ROOT"

PARALLELISM="${1:-4}"
LIMIT="${2:-0}"
RUN_TAG="${RUN_TAG:-ocr-parallel-$(date -u +%Y%m%d-%H%M%S)}"
SKIP_FROM_TAG="${SKIP_FROM_TAG:-}"
TODAY="$(date -u +%Y%m%d)"
DB_PATH="$WORKSPACE_ROOT/data/video_pipeline/state.sqlite"
OUTPUT_ROOT="$WORKSPACE_ROOT/data/video_scan_${TODAY}/${RUN_TAG}"
FFMPEG_BIN="${FFMPEG_BIN:-c:/Users/admin/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe}"

# Probe-log filename pattern per tools/aggregateOcrTimeline.js:
#   ^(\d{8})_(\d{8})_([A-Za-z0-9_-]{6,15})_([a-f0-9]{8})_whiteboard\.json$
# We glob the directory for files matching the <upload_date>_<video_id>_
# prefix and consider any hit as "already done under this run-tag".
PROBE_RE='^[0-9]{8}_[0-9]{8}_[A-Za-z0-9_-]{6,15}_[a-f0-9]{8}_whiteboard\.json$'

JOBS_FILE="$(mktemp)"
trap 'rm -f "$JOBS_FILE"' EXIT

if [[ ! -f "$DB_PATH" ]]; then
  echo "[parallel-ocr] FAIL: $DB_PATH not found. Run 'npm run video:init' and 'video:catalog' first." >&2
  exit 1
fi

mkdir -p "$OUTPUT_ROOT/$RUN_TAG/ocr_probe/logs"

# Step 1 -- collect (upload_date|video_id|download_path) tuples from SQLite,
# applying the disk-existence + skip-from-tag filters.
DB_PATH="$DB_PATH" \
LIMIT_VAL="$LIMIT" \
SKIP_FROM_TAG_VAL="$SKIP_FROM_TAG" \
RUN_TAG_VAL="$RUN_TAG" \
TODAY_VAL="$TODAY" \
JOBS_FILE_VAL="$JOBS_FILE" \
WORKSPACE_ROOT_VAL="$WORKSPACE_ROOT" \
  py -3 - <<'PY'
import os, sqlite3, pathlib, datetime, re
db_path = pathlib.Path(os.environ['DB_PATH'])
limit = int(os.environ.get('LIMIT_VAL') or 0)
run_tag = os.environ.get('RUN_TAG_VAL') or ''
skip_from_tag = os.environ.get('SKIP_FROM_TAG_VAL') or ''
today = os.environ.get('TODAY_VAL') or datetime.datetime.utcnow().strftime('%Y%m%d')
workspace = pathlib.Path(os.environ['WORKSPACE_ROOT_VAL'])
out_path = pathlib.Path(os.environ['JOBS_FILE_VAL'])

own_dir = workspace / 'data' / f'video_scan_{today}' / run_tag / run_tag / 'ocr_probe' / 'logs'
skip_dir = None
if skip_from_tag:
  skip_dir = workspace / 'data' / f'video_scan_{today}' / skip_from_tag / skip_from_tag / 'ocr_probe' / 'logs'

conn = sqlite3.connect(str(db_path))
rows = conn.execute(
  "SELECT video_id, upload_date, download_path FROM videos "
  "WHERE status IN ('pending','scanning','error') "
  "AND download_path IS NOT NULL AND download_path != '' "
  "ORDER BY upload_date ASC, video_id ASC"
).fetchall()

own_set = set()
if own_dir.exists():
  for f in own_dir.iterdir():
    m = re.match(r'^(\d{8})_[A-Za-z0-9_-]{6,15}_', f.name)
    if m:
      own_set.add(m.group(0))

skip_set = set()
if skip_dir and skip_dir.exists():
  for f in skip_dir.iterdir():
    m = re.match(r'^(\d{8})_[A-Za-z0-9_-]{6,15}_', f.name)
    if m:
      skip_set.add(m.group(0))

jobs = []
skipped_own = skipped_other = missing = 0
for video_id, upload_date, dl_path in rows:
  if not upload_date or upload_date == 'NA':
    continue
  p = pathlib.Path(dl_path)
  if not p.exists():
    missing += 1
    continue
  prefix = f'{upload_date}_{video_id}_'
  if any(s.startswith(prefix) for s in own_set):
    skipped_own += 1
    continue
  if skip_set and any(s.startswith(prefix) for s in skip_set):
    skipped_other += 1
    continue
  jobs.append((upload_date, video_id, str(p)))

if limit:
  jobs = jobs[:limit]

with out_path.open('w', encoding='utf-8') as f:
  for upload_date, video_id, dl_path in jobs:
    f.write(f'{upload_date}|{video_id}|{dl_path}\n')

print(
  f'[parallel-ocr] jobs={len(jobs)} skipped_own={skipped_own} skipped_other={skipped_other} missing_files={missing}',
  flush=True
)
PY

# Step 2 -- light existence check for the output directory tree.
if [[ ! -d "$OUTPUT_ROOT/$RUN_TAG/ocr_probe/logs" ]]; then
  mkdir -p "$OUTPUT_ROOT/$RUN_TAG/ocr_probe/logs"
fi

PENDING=$(wc -l < "$JOBS_FILE" | tr -d ' ' || echo 0)
if [[ "${PENDING:-0}" == "0" ]]; then
  echo "[parallel-ocr] nothing to scan under run-tag=$RUN_TAG"
  echo "[parallel-ocr] (or all candidates were filtered by SKIP_FROM_TAG=$SKIP_FROM_TAG)"
  exit 0
fi

echo "[parallel-ocr] workspace   : $WORKSPACE_ROOT"
echo "[parallel-ocr] run_tag     : $RUN_TAG"
echo "[parallel-ocr] output_root : $OUTPUT_ROOT"
echo "[parallel-ocr] parallelism : $PARALLELISM workers"
echo "[parallel-ocr] pending     : $PENDING videos"
if [[ -n "$SKIP_FROM_TAG" ]]; then
  echo "[parallel-ocr] skip_from   : $SKIP_FROM_TAG (cooperating with serial run)"
fi

# Step 3 -- export environment for the xargs children.
export RUN_TAG OUTPUT_ROOT FFMPEG_BIN TODAY PARALLELISM SKIP_FROM_TAG

# xargs -I {} reads one line per invocation; -P N runs N invocations concurrently.
# Each worker handles one video from end to end and writes its own progress
# log next to the probe-log directory so logs stay attributable.
cat "$JOBS_FILE" | xargs -P "$PARALLELISM" -I {} \
  bash -c '
    set -e
    line="{}"
    IFS="|" read -r upload_date video_id download_path <<< "$line"
    log_path="data/video_scan_${TODAY}/${RUN_TAG}/${RUN_TAG}_${upload_date}_${video_id}.log"
    echo "[parallel-ocr $(date -u +%H:%M:%S) w$$] $upload_date $video_id <- $download_path"
    if ! node tools/scanVideoWithOcr.js \
        --video "$download_path" \
        --date "$upload_date" \
        --output-root "$OUTPUT_ROOT" \
        --run-tag "$RUN_TAG" \
        --ffmpeg-bin "$FFMPEG_BIN" > "$log_path" 2>&1; then
      rc=$?
      echo "[parallel-ocr $(date -u +%H:%M:%S) w$$] ERROR $upload_date $video_id exit=$rc log=$log_path" >&2
      exit $rc
    fi
  '

echo "[parallel-ocr] done -> aggregate with: node tools/aggregateOcrTimeline.js $RUN_TAG"
