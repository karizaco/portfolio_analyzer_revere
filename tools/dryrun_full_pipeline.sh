#!/usr/bin/env bash
# Combined dry run: exercises both the YouTube flow (mock yt-dlp) and the
# local-video flow (synthetic MP4 + white reference + real ffmpeg).
#
# Exits non-zero if either dry run fails.

set -euo pipefail

WORKSPACE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "[dryrun] running YouTube dry run"
bash "$WORKSPACE_ROOT/tools/dryrun_yt_dlp_pipeline.sh"

echo
echo "[dryrun] running local-video dry run"
bash "$WORKSPACE_ROOT/tools/dryrun_python_worker_pipeline.sh"

echo
echo "[dryrun] OK: both dry runs passed"
