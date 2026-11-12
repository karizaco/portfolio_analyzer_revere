# Codex migration notes (portfolio_analyzer_revere)

## Instructions
- `AGENTS.md` is a copy of `CLAUDE.md` (Windows blocked symlink creation).
- If you edit project instructions, update both or re-copy `CLAUDE.md` → `AGENTS.md`.

## Migrated Claude project memory
- See `docs/codex-migrated-memory/` (38 files) and `.codex/MEMORY.md`.
- Prefer live repo docs / `AGENTS.md` when memory conflicts with current code.

## Global Codex customizations
- Skills live in `%USERPROFILE%\.agents\skills\` (Claude skills, Skillchain, Firecrawl, UI foundation, etc.).
- MCP servers were merged into `%USERPROFILE%\.codex\config.toml` without changing CC Switch provider routing.
- Secrets were not copied; set `DEEPGRAM_API_KEY` and `HLIDACSTATU_API_TOKEN` in the environment.

## Not auto-migrated
- Claude plugins github / playwright / php-lsp native runtime integration (see MCP entries if added; install/auth may still be required).
- Claude hooks (none configured in settings).
- Claude custom agents (none found).
- Session history / credentials.
