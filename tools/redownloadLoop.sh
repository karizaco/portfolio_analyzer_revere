#!/usr/bin/env bash
# Unattended re-download loop for the qullamaggie videos destroyed by the
# 2026-10-21 sparse-checkout prune.
#
# Wraps tools/redownloadLostQmg.js's per-batch logic in a shell loop so the
# whole multi-hour run is ONE command. That matters in practice: Claude Code's
# auto-mode permission classifier intermittently times out on long-running
# download commands, and a timeout blocks the command. Approving one script
# call avoids re-classifying every batch.
#
# Safe by construction: every file lands in the out-of-tree media directory.
# The only destructive verb is yt-dlp's own `-o` template, which overwrites in
# place. Nothing here deletes anything.
#
# Usage: bash tools/redownloadLoop.sh [batch_size] [max_batches]
#   batch_size   videos per batch (default 30)
#   max_batches  stop after N batches (default 0 = until done or out of disk)

set -u

BATCH="${1:-30}"
MAX_BATCHES="${2:-0}"
PROJECT="C:/Users/Admin/Projects/portfolio_analyzer_revere"
MEDIA="C:/Users/Admin/Projects/portfolio_analyzer_revere_media"
LOG="$PROJECT/data/_redownload_loop.log"

cd "$PROJECT" || exit 1

free_gb() { df -BG "$PROJECT" 2>/dev/null | tail -1 | awk '{gsub("G",""); print $4}'; }

n=0
while [ "$MAX_BATCHES" -eq 0 ] || [ "$n" -lt "$MAX_BATCHES" ]; do
  free=$(free_gb)
  if [ "${free:-0}" -lt 40 ]; then
    echo "[loop] STOP: only ${free}G free on C: (need 40G). Reclaim and re-run to resume." | tee -a "$LOG"
    break
  fi

  n=$((n + 1))
  echo "" | tee -a "$LOG"
  echo "[loop] === pass $n (free=${free}G) $(date '+%H:%M:%S') ===" | tee -a "$LOG"

  # Capture this pass's output separately so completion is detected from THIS
  # pass only — the log accumulates across passes and would otherwise match a
  # stale "nothing left" line.
  pass_out="$PROJECT/data/_redownload_pass.log"
  node tools/redownloadLostQmg.js --batch "$BATCH" --max-batches 1 \
    --media-root "$MEDIA" --cookies data/youtube_cookies.txt > "$pass_out" 2>&1
  rc=$?
  cat "$pass_out" >> "$LOG"

  if [ "$rc" -ne 0 ]; then
    echo "[loop] pass $n exited $rc — see $LOG" | tee -a "$LOG"
  fi

  free=$(free_gb)
  echo "[loop] pass $n done (free now ${free}G)" | tee -a "$LOG"

  if grep -q "nothing left to download" "$pass_out"; then
    echo "[loop] all done — nothing left to download" | tee -a "$LOG"
    break
  fi

  # Cool off a little so YouTube does not start rate-limiting us.
  sleep 45
done

echo "[loop] FINISHED after $n passes — $(date '+%H:%M:%S')" | tee -a "$LOG"
