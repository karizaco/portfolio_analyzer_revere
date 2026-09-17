#!/usr/bin/env bash
# Combined dry run: exercises both the YouTube flow (mock yt-dlp) and the
# local-video flow (synthetic MP4 + white reference + real ffmpeg).
#
# Usage:
#   bash tools/dryrun_full_pipeline.sh                # Revere default
#   bash tools/dryrun_full_pipeline.sh --channel qullamaggie
#
# Exits non-zero if either dry run fails.

set -euo pipefail

WORKSPACE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

CHANNEL="revere"
while [ $# -gt 0 ]; do
  case "$1" in
    --channel)
      CHANNEL="${2:-}"
      shift 2
      ;;
    *)
      echo "[dryrun] unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

export CHANNEL
export PREFILTER_PROFILE="$([ "$CHANNEL" = "qullamaggie" ] && echo chart_stream || echo whiteboard)"
export BASENAME="$([ "$CHANNEL" = "qullamaggie" ] && echo qmg || echo revere)"

echo "[dryrun] channel=$CHANNEL prefilter=$PREFILTER_PROFILE basename=$BASENAME"

echo "[dryrun] running YouTube dry run"
bash "$WORKSPACE_ROOT/tools/dryrun_yt_dlp_pipeline.sh"

echo
echo "[dryrun] running local-video dry run"
bash "$WORKSPACE_ROOT/tools/dryrun_python_worker_pipeline.sh"

echo
echo "[dryrun] OK: both dry runs passed"
