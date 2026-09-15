#!/usr/bin/env bash
# Parallel OCR driver: thin shell wrapper around tools/parallelOcrScan.py,
# which drives N concurrent scanVideoWithOcr.js subprocesses via Python's
# multiprocessing.Pool.
#
# We delegate to Python (rather than running the original bash/xargs heredoc
# approach directly) because Git Bash on Windows mangles Windows backslash
# paths through `<<<` here-strings + `IFS=...| read`, dropping the path
# separators before ffmpeg ever sees the file. Python owns the path string
# from SQLite -> subprocess.run without any shell-style quoting in between.
#
# Safety model (designed to coexist with an in-flight runAllOcr.js batch):
#   1. Read-only on SQLite. The serial run still owns `status`.
#   2. Probe logs go to <run-tag>/ocr_probe/logs/<...>.json, distinct from
#      the in-flight run's directory, so no file collision.
#   3. Sibling subdirectories under the run-tag (sample/, screenshots/, ...)
#      are also distinct, so no ffmpeg-temp collisions.
#   4. SKIP_FROM_TAG=<in-flight-tag> makes us skip any row the serial run
#      already finished. Worst case: the row currently mid-flight gets
#      OCR'd twice (once serial, once parallel) into different run-tags --
#      duplicate work, never destructive.
#
# Usage:
#   bash tools/parallelOcrScan.sh                               # 4 workers, fresh run-tag
#   bash tools/parallelOcrScan.sh 6                             # 6 workers
#   bash tools/parallelOcrScan.sh 4 --limit 30                  # cap row count
#   SKIP_FROM_TAG=ocr-20260915 bash tools/parallelOcrScan.sh 4  # cooperate with serial run
#   RUN_TAG=ocr-20260915-p4 bash tools/parallelOcrScan.sh 4     # explicit run-tag
#
# After completion, aggregate with:
#   node tools/aggregateOcrTimeline.js <run-tag>

set -euo pipefail

WORKSPACE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$WORKSPACE_ROOT"

# Forward all env vars so the Python argparse defaults are populated:
#   SKIP_FROM_TAG=<in-flight-tag>  --skip-from-tag
#   RUN_TAG=<name>                 --run-tag
#   FFMPEG_BIN=<path>              --ffmpeg-bin
#   NODE_BIN=<path>                --node-bin
export SKIP_FROM_TAG RUN_TAG FFMPEG_BIN NODE_BIN

exec py -3 tools/parallelOcrScan.py "$@"
