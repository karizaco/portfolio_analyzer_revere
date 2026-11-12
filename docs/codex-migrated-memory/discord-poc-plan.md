---
name: discord-poc-plan
description: "Discord channel-ingestion POC plan + 8 locked-in decisions (auth, storage, viewer shape, package.json layout, ingest mode)"
metadata: 
  node_type: memory
  type: project
  originSessionId: ba4fc76f-933d-43f8-addb-9ea105b4d328
  modified: 2026-09-17T09:10:31.870Z
---

# Discord POC plan (locked-in)

Plan context: prior research workflow produced a deep-dive on Discord data retrieval. Key findings:

- **No official Discord MCP exists.** Use direct REST API + Python (no `discord.py`, no `dotnet`-based DiscordChatExporter — keep zero new heavy deps).
- **Storage**: sibling tables `discord_sources`, `discord_messages`, `discord_pipeline_runs` in the same SQLite (`data/video_pipeline/state.sqlite`). Additive migration, no ALTER on existing tables.
- **5-6 file first-step plan** (~400 LoC total):
  - `data/discord_pipeline/__init__.py` — idempotent schema bootstrap (~30 LoC)
  - `tools/runDiscordIngest.js` — Node CLI wrapper, mirrors `runWhiteboardWorker.js` (~100 LoC)
  - `tools/discord_pipeline/ingest_channel.py` — fetcher with `Retry-After` + cursor pagination (~150 LoC)
  - `tools/discord_pipeline/extract_tickers.py` — same regex/seed as OCR scanner, ~50 LoC
  - `tools/listDiscordCatalog.js` — Node mirror of `listCatalog.js` (~60 LoC)
  - `tools/discord_pipeline/smoke.sh` — end-to-end smoke test on ONE channel (~15 LoC)

## 8 locked-in decisions (user accepted defaults 2026-09-17)

1. **Auth**: Bot token + MESSAGE_CONTENT intent (Discord-compliant, ban-safe).
2. **Privileged intent**: Apply for MESSAGE_CONTENT (one-click in dev portal; verification only triggers at 100+ guilds).
3. **Pre-join history**: Server admins grant READ_MESSAGE_HISTORY on the channels; we accept the post-invite-bounded history limit. Typical for trading-discord communities; usually fine.
4. **Ingest mode**: Backfill-only via scheduled CLI (no long-running gateway daemon).
5. **package.json**: Mirror `video:*` convention — `discord:init`, `discord:ingest`, `discord:extract-tickers`, `discord:list`, `discord:status`.
6. **Timeline viewer**: Extend `aggregateOcrTimeline.js` (emit `videos: [...]` + `discord_messages: [...]`) + add a Discord chip + row shape to `viewTimeline.html`. NOT a sibling viewer, NOT a unified-new aggregator.
7. **Output**: Discord-attributed tickers in a separate `discord_signals.csv` + Discord panel in viewer. NOT merged into `portfolio_actions.csv`.
8. **Backfill direction**: Newest→oldest only (via `?before=<oldest_id>&limit=100` cursor). Discord's `after` cursor is bounded; only practical direction for full history.

## Why

Captured before code was written; without this memory, a future session would re-ask the same 8 questions and likely re-research the architecture.

## How to apply

When implementing or extending Discord ingestion in this repo, treat all 8 as settled. Reference [[video-pipeline-overview]] (if present) for the upstream patterns the Discord code should mirror (Node-CLI-wraps-Python, sqlite via `spawnSync(py, …)`, idempotent migrations in `initialize_schema`, run-tag directories under `data/video_scan_<date>/<tag>/`).
