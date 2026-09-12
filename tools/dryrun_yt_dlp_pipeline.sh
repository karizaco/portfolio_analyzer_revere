#!/usr/bin/env bash
# Dry run for the YouTube flow using the bundled mock yt-dlp fixture.
#
# Exercises:
#   init -> catalog -> download -> status
#
# Writes under a sandboxed pipeline-root in ./data/video_pipeline_dryrun_<pid>/
# and never touches the read-only asset folder or any pre-existing pipeline.
#
# Exits non-zero if any assertion fails.

set -euo pipefail

WORKSPACE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
YT_DLP_BIN="${YT_DLP_BIN:-$WORKSPACE_ROOT/test/fixtures/mockYtDlp.py}"
PIPELINE_ROOT="$WORKSPACE_ROOT/data/video_pipeline_dryrun_yt_$$"

echo "[dryrun-yt] workspace: $WORKSPACE_ROOT"
echo "[dryrun-yt] yt-dlp binary: $YT_DLP_BIN"
echo "[dryrun-yt] pipeline root: $PIPELINE_ROOT"

if [[ ! -f "$YT_DLP_BIN" ]]; then
  echo "[dryrun-yt] FAIL: mock yt-dlp fixture not found at $YT_DLP_BIN" >&2
  exit 1
fi

cleanup() {
  rm -rf "$PIPELINE_ROOT"
}
trap cleanup EXIT

DRIVER="$WORKSPACE_ROOT/tools/runWhiteboardWorker.js"

echo "[dryrun-yt] step 1/4: init"
node "$DRIVER" init --pipeline-root "$PIPELINE_ROOT" >/dev/null

echo "[dryrun-yt] step 2/4: catalog against mock"
catalog_output="$(node "$DRIVER" catalog \
  --pipeline-root "$PIPELINE_ROOT" \
  --yt-dlp-bin "$YT_DLP_BIN" \
  --source-url 'https://example.com/playlist?list=dryrun' \
  --limit 2)"
catalog_count="$(echo "$catalog_output" | node -e 'let buf="";process.stdin.on("data",(c)=>buf+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(buf).cataloged_rows||0)}catch(_){console.log(0)}})')"
if [[ "$catalog_count" != "2" ]]; then
  echo "[dryrun-yt] FAIL: catalog expected 2 rows, got $catalog_count" >&2
  echo "$catalog_output" >&2
  exit 1
fi

echo "[dryrun-yt] step 3/4: download 1 mock video"
download_output="$(node "$DRIVER" download \
  --pipeline-root "$PIPELINE_ROOT" \
  --yt-dlp-bin "$YT_DLP_BIN" \
  --limit 1 \
  --extractor-args '' \
  --format 'bv*[height<=480]+ba/b[height<=480]')"
download_status="$(echo "$download_output" | node -e 'let buf="";process.stdin.on("data",(c)=>buf+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(buf).status||"unknown")}catch(_){console.log("unknown")}})')"
if [[ "$download_status" != "ok" ]]; then
  echo "[dryrun-yt] FAIL: download expected status 'ok', got '$download_status'" >&2
  echo "$download_output" >&2
  exit 1
fi

echo "[dryrun-yt] step 4/4: status"
status_output="$(node "$DRIVER" status --pipeline-root "$PIPELINE_ROOT" --list-limit 5)"
total_videos="$(echo "$status_output" | node -e 'let buf="";process.stdin.on("data",(c)=>buf+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(buf).total_videos||0)}catch(_){console.log(0)}})')"
scanning_count="$(echo "$status_output" | node -e 'let buf="";process.stdin.on("data",(c)=>buf+=c);process.stdin.on("end",()=>{try{console.log((JSON.parse(buf).video_counts||{}).scanning||0)}catch(_){console.log(0)}})')"
if [[ "$total_videos" != "2" ]]; then
  echo "[dryrun-yt] FAIL: status expected total_videos=2, got $total_videos" >&2
  echo "$status_output" >&2
  exit 1
fi
if [[ "$scanning_count" != "1" ]]; then
  echo "[dryrun-yt] FAIL: status expected video_counts.scanning=1, got $scanning_count" >&2
  echo "$status_output" >&2
  exit 1
fi

# Verify the catalog snapshot TSV landed on disk
catalog_dir="$PIPELINE_ROOT/catalog"
if [[ ! -d "$catalog_dir" ]] || [[ -z "$(ls -A "$catalog_dir" 2>/dev/null)" ]]; then
  echo "[dryrun-yt] FAIL: no catalog snapshot TSV under $catalog_dir" >&2
  exit 1
fi

# Verify the download produced a mock file under downloads/
downloads_dir="$PIPELINE_ROOT/downloads"
mock_files="$(find "$downloads_dir" -name '*.mp4' 2>/dev/null | wc -l)"
if [[ "$mock_files" != "1" ]]; then
  echo "[dryrun-yt] FAIL: expected 1 mock mp4 under $downloads_dir, got $mock_files" >&2
  exit 1
fi

# Verify the download_archive file was written
archive_file="$PIPELINE_ROOT/download_archive.txt"
if [[ ! -f "$archive_file" ]] || ! grep -q '^youtube abc123$' "$archive_file"; then
  echo "[dryrun-yt] FAIL: download_archive.txt missing or did not record 'youtube abc123'" >&2
  exit 1
fi

echo "[dryrun-yt] OK: catalog=2, downloaded=1, total_videos=2, scanning=1"
