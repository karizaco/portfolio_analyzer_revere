#!/usr/bin/env bash
# End-to-end smoke test for the Discord pipeline POC.
#
# Exercises the parts that don't need DISCORD_BOT_TOKEN:
#   1. Schema bootstrap (idempotent on the real state.sqlite).
#   2. Source registration (no-op on duplicate name).
#   3. Ingest channel --list-sources prints the table without 401/403.
#   4. Node CLI wrappers round-trip.
#
# Run from the repo root:
#   bash tools/discord_pipeline/smoke.sh
#
# Exits non-zero on the first failing step so CI can wire it up.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

echo "[smoke] 1/4 schema bootstrap"
py -3 -c "from data.discord_pipeline import bootstrap_schema; \
import sqlite3; c = sqlite3.connect('data/video_pipeline/state.sqlite'); \
bootstrap_schema(c); c.close(); print('schema OK')"

echo "[smoke] 2/4 source registration (no-op on duplicate)"
py -3 -c "from data.discord_pipeline import register_source; \
import sqlite3; c = sqlite3.connect('data/video_pipeline/state.sqlite'); \
register_source(c, 'smoke-discord-source', '1234567890', '9876543210'); \
register_source(c, 'smoke-discord-source', '1234567890', '9876543210'); \
c.close(); print('source registered (twice, second time no-op)')"

echo "[smoke] 3/4 ingest_channel --list-sources (no token)"
py -3 -m tools.discord_pipeline.ingest_channel --list-sources

echo "[smoke] 4/4 Node CLI round-trip"
node tools/runDiscordIngest.js list
node tools/runDiscordIngest.js status

echo "[smoke] OK"
