# Discord channel-ingestion pipeline

Three sibling ingest paths all converge on the same `discord_messages` table.
Pick the one that matches how you can authenticate.

## Which path to use

| Path | Auth | Setup | Best when |
|------|------|-------|-----------|
| `ingest_channel.py`  (REST, bot token) | `DISCORD_BOT_TOKEN` + MESSAGE_CONTENT intent | Discord dev-portal one-time; `node tools/runDiscordIngest.js add-source ...` | You can run unattended backfills on a schedule. |
| `agentic_prompt.md` (computer-use agent) | user is already logged into Discord in their browser | Hand `agentic_prompt.md` to a Claude/Grok/OpenClaw browser agent; it emits JSONL | You want the AI to "look at Discord for me" right now, and you're fine with a 1-shot JSONL dump. |
| `browser_ingest.py`  (Playwright browser scrape) | user logs in manually inside the headful Chromium one time | `pip install -r requirements.txt` + `playwright install chromium` | **The bot path is blocked (e.g. not allowed to add bots to the server)** and you still want a CLI one-liner. |

### Browser path — no bot invite needed

This is the approach to use when you **cannot add a bot to the server** (common in private trading servers).
Your Discord account is already a member — Playwright logs in as you and scrapes the channel.

One-time setup:

```bash
pip install -r requirements.txt
playwright install chromium
```

Register the source (channel_id + guild_id required):

```bash
node tools/runDiscordIngest.js add-source <name> <channel_id> --guild-id <guild_id>
```

Find channel/guild IDs: Discord desktop app → User Settings → Advanced → Developer Mode ON → right-click channel → Copy ID.

First run (opens Chromium, you log in once):

```bash
npm run discord:ingest:browser -- --source <name> \
    --url "https://discord.com/channels/<guild_id>/<channel_id>" \
    --messages 200
```

Subsequent runs reuse the cached session (saved to `data/discord_pipeline/.cache/browser_session_<name>.json`).
Delete that file to force a fresh login.

## Browser flow (new)

One-time setup (do NOT expect the agent to install this; it's a manual step):

```bash
pip install -r requirements.txt
playwright install chromium
```

Scrape + import in one command (chains into `import_jsonl` automatically):

```bash
# register the source once (channel_id + guild_id required)
node tools/runDiscordIngest.js add-source my-alerts 1234567890 --guild-id 987654321

# log in once (headed Chromium opens, you solve any CAPTCHA / 2FA, then walk away)
npm run discord:ingest:browser -- --source my-alerts \
    --url https://discord.com/channels/987654321/1234567890 \
    --messages 200
```

Underlying flags:

```
python -m tools.discord_pipeline.browser_ingest \
    --source <name> --url <discord_channel_url> \
    [--messages N] [--out <jsonl_path>] \
    [--session <storage_state.json>] [--login-timeout-seconds 120] \
    [--headless] [--scroll-pause-ms 1500]
```

After the first run the browser session is persisted at
`./data/discord_pipeline/.cache/browser_session_<source>.json`. Subsequent runs
reuse it and skip the login prompt. Delete that file to clear the session.

Add `--skip-import` to the npm wrapper to stop after the JSONL is written (you
then ingest it later with `discord:ingest:jsonl`).

## Caveats

- **Discord ToS** — using a real user account to scrape via Playwright is in
  the grey area; keep volume low and respect rate limits.
- **Headed mode required** — Discord detects & blocks headless Chromium. The
  default is `--headless=False`; `--headless` is for testing only.
- **Browser binary size** — `playwright install chromium` downloads ~150 MB.
- **Selectors are fragile** — the regex-based `parse_message_element()` is
  best-effort. Discord ships frequent DOM changes; expect occasional per-field
  misses. Add new patterns to the `SELECTOR` regex list in
  `browser_ingest.py` when something breaks.
- **Image-only / file-only messages are skipped** to match the agentic path's
  downstream behaviour.
