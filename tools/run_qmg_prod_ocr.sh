#!/usr/bin/env bash
# One timed EasyOCR production scan, then the rest of the chunk.
#
# Run from the repository root:
#   bash tools/run_qmg_prod_ocr.sh first     # time ONE video
#   bash tools/run_qmg_prod_ocr.sh rest      # the remaining three
#
# --low-cpu is MANDATORY. EasyOCR uses PyTorch + OpenCV + NumPy, each
# spawning multi-threaded pools; without the caps, parallel scans saturate
# every core and the machine freezes.
set -u

cd "$(dirname "$0")/.." || exit 1

RUN_TAG=qmg-easyocr-20261104-prod
LOG=data/qmg_prod_scan.log

case "${1:-first}" in
  first) DATES=20231201; PAR=1 ;;
  rest)  DATES=20231215,20230518,20230601; PAR=2 ;;
  *)     echo "usage: $0 first|rest"; exit 2 ;;
esac

echo "=== $(date +%H:%M:%S) starting: $DATES (parallel=$PAR, low-cpu) ==="
node tools/runQmgOcrBatch.js \
  --dates "$DATES" \
  --low-cpu \
  --parallel "$PAR" \
  --run-tag "$RUN_TAG" >>"$LOG" 2>&1
echo "=== $(date +%H:%M:%S) finished ==="
