#!/usr/bin/env bash
# Parallel download driver: runs `npm run video:download -- --video-id <id>` in
# N parallel workers against the SQLite state in data/video_pipeline/state.sqlite.
#
# Reads the list of pending video ids from SQLite, splits them into a stream,
# and feeds them to xargs -P. Each invocation is a single-id download, so
# SQLite's WAL mode handles concurrent UPDATE writers safely and the worker's
# disk-dedup check + status-based skip keep re-runs idempotent.
#
# Usage:
#   bash tools/parallelDownload.sh           # default: 4 workers, all pending
#   bash tools/parallelDownload.sh 6         # 6 workers
#   bash tools/parallelDownload.sh 4 30      # 4 workers, max 30 videos

set -euo pipefail

WORKSPACE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PARALLELISM="${1:-4}"
LIMIT="${2:-0}"

# Hand off DB access to a small Python helper that prints pending ids (one
# per line) so the bash quoting stays simple.
PENDING_FILE="$(mktemp)"
trap 'rm -f "$PENDING_FILE"' EXIT

DB_PATH="$WORKSPACE_ROOT/data/video_pipeline/state.sqlite" \
LIMIT_VAL="$LIMIT" \
PENDING_FILE="$PENDING_FILE" \
  py -3 - <<'PY'
import os, sqlite3, pathlib
db = pathlib.Path(os.environ['DB_PATH'])
if not db.exists():
    raise SystemExit(f'[parallel-download] FAIL: {db} not found. Run npm run video:init first.')
conn = sqlite3.connect(str(db))
rows = conn.execute(
    "SELECT video_id FROM videos WHERE status IN ('pending','error') "
    "ORDER BY upload_date ASC, video_id ASC"
).fetchall()
limit = int(os.environ.get('LIMIT_VAL') or 0)
if limit:
    rows = rows[:limit]
out = pathlib.Path(os.environ['PENDING_FILE'])
out.write_text('\n'.join(vid for (vid,) in rows) + ('\n' if rows else ''), encoding='utf-8')
print(f'[parallel-download] {len(rows)} pending ids written to {out}', flush=True)
PY

mapfile -t PENDING_IDS < "$PENDING_FILE"

if [[ "${#PENDING_IDS[@]}" -eq 0 ]]; then
  echo "[parallel-download] no pending videos in $DB"
  exit 0
fi

echo "[parallel-download] workspace: $WORKSPACE_ROOT"
echo "[parallel-download] parallelism: $PARALLELISM workers"
echo "[parallel-download] pending ids: ${#PENDING_IDS[@]}"

# xargs -P runs N workers in parallel, each pulling one id at a time off stdin.
# -I {} is itself the "one id per invocation" form.
printf '%s\n' "${PENDING_IDS[@]}" | xargs -P "$PARALLELISM" -I {} \
  bash -c '
    set -e
    cd "$0"
    echo "[parallel-download worker $(date +%H:%M:%S)] downloading {}"
    npm run video:download -- --video-id "{}" --yt-dlp-bin py-yt-dlp >/dev/null
  ' "$WORKSPACE_ROOT"

echo "[parallel-download] done"
