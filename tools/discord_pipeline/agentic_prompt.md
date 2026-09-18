# Discord channel scrape → JSONL (for computer-use agents)

You are browsing a Discord channel in a real, graphical browser to produce a
JSONL dump that our Python ingest pipeline can import. The output you write will
be loaded into `data/video_pipeline/state.sqlite` via
`npm run discord:ingest:jsonl -- --source <name> --file <path>`.

Do **not** call any Discord API directly. Do **not** use the bot token. You are
the eyes; the Python importer is the hands.

---

## Goal

Produce **one JSONL file** at a path you choose. Each line is one Discord
message you saw in the browser. After you finish, write the path of the JSONL
file to your final message and exit.

---

## Workflow

1. **Open a browser** (the one your tool gives you — Chromium / Chrome / Edge /
   Firefox / Brave all work). Use the user's existing profile / cookies so you
   are already logged into Discord. If you are not logged in, stop and tell the
   user: "I need you to log into Discord in your browser, then re-run me."
2. **Navigate to the channel URL** the user provides. It looks like
   `https://discord.com/channels/<guild_id>/<channel_id>`. Wait for the message
   list to render.
3. **Scroll up** until you have at least the most recent N messages (the user
   supplies N; default is 100). Discord lazy-loads older messages, so scroll
   repeatedly with pauses for content to load.
4. **Transcribe each visible message** into the JSONL schema below. Be careful
   to capture author, timestamp, and content faithfully.
5. **Write the JSONL file** to a path the user will see (e.g.
   `./discord_dump.jsonl` in the repo root, or `/tmp/discord_dump.jsonl`).
   One JSON object per line. UTF-8. No trailing comma. No BOM.
6. **When done**, your final assistant message should contain:
   - the absolute path of the JSONL file you wrote
   - the count of messages you captured
   - the exact shell command the user should run to ingest it:
     `npm run discord:ingest:jsonl -- --source <source_name> --file <path>`

---

## JSONL schema

Each line is a JSON object. **Required keys** must all be present and
non-empty (use empty string `""` if a value is missing and the key is optional):

```json
{
  "discord_message_id": "1234567890123456789",
  "author_id":          "987654321098765432",
  "author_name":        "trader_jane",
  "content":            "$TQQQ breaking out, adding here. $SQQQ hedge if it fails.",
  "posted_at":          "2026-09-17T14:32:08.123+00:00",
  "edited_at":          null,
  "is_pinned":          false,
  "has_attachments":    false
}
```

Field rules:

| key                 | type    | required | notes                                                            |
|---------------------|---------|----------|------------------------------------------------------------------|
| `discord_message_id`| string  | yes      | Snowflake from the message permalink / context menu.              |
| `author_id`         | string  | yes      | Snowflake from the user profile popover.                         |
| `author_name`       | string  | yes      | Display name in the channel.                                     |
| `content`           | string  | yes      | Plain text body. Strip Discord markdown to plain text.          |
| `posted_at`         | string  | yes      | ISO-8601 with timezone (Discord shows "Today at HH:MM" — convert).|
| `edited_at`         | string  | no       | ISO-8601 only if the message shows the "(edited)" marker.        |
| `is_pinned`         | boolean | no       | `true` if a pin icon is visible on the message.                  |
| `has_attachments`   | boolean | no       | `true` if the message has images / files / embeds you skipped.   |

### Edge cases

- **Image-only / file-only messages** (no text body): **skip** entirely — do
  not emit a JSONL line. We cannot ingest image data here.
- **Reply chains**: if a message is a reply and you can see the parent text,
  prefix the new content like `"@replying to <author>: <parent_snippet> — <new_body>"`.
  Truncate the parent snippet to ~120 chars.
- **Embeds / link previews**: if you see a link with a title (e.g. a news
  article), append `" [embed: <title> — <url>]"` to the content string. If the
  embed has no visible title, just append the URL.
- **System messages** (joins, pins, boosts, "X started a thread"): **skip**.
- **Edited messages**: set `edited_at` to the ISO timestamp; `posted_at` stays
  as the original.
- **Pinned messages**: set `is_pinned: true`.
- **Reactions**: ignore — we do not capture reactions.

### Order

Chronological order, **oldest → newest**. The Python importer uses
`discord_message_id` as the unique key, so ordering only affects CSV display.

### Author display name

If two users share a display name (rare), prefer the `@unique_handle` if
visible in the message hover, else the display name. The Python ticker extractor
only uses `content`, so a slight ambiguity here is acceptable.

---

## Example

A real Discord channel might look like:

```
[14:30] market-maker  $TQQQ 4hr breakout, vol confirming.
[14:31] jane-doe      @replying to market-maker: agreed. $SQQQ hedge?
[14:31] bot          Welcome jane-doe to the channel!
[14:32] jane-doe      $TQQQ add here, target 80.
[14:33] news-bot     [embed: Fed minutes released — https://example.com/fed]
```

Expected JSONL:

```jsonl
{"discord_message_id":"1110000000000000001","author_id":"222000000000000001","author_name":"market-maker","content":"$TQQQ 4hr breakout, vol confirming.","posted_at":"2026-09-17T14:30:00.000+00:00","edited_at":null,"is_pinned":false,"has_attachments":false}
{"discord_message_id":"1110000000000000002","author_id":"222000000000000002","author_name":"jane-doe","content":"@replying to market-maker: agreed. $SQQQ hedge?","posted_at":"2026-09-17T14:31:00.000+00:00","edited_at":null,"is_pinned":false,"has_attachments":false}
{"discord_message_id":"1110000000000000004","author_id":"222000000000000002","author_name":"jane-doe","content":"$TQQQ add here, target 80.","posted_at":"2026-09-17T14:32:00.000+00:00","edited_at":null,"is_pinned":false,"has_attachments":false}
{"discord_message_id":"1110000000000000005","author_id":"222000000000000099","author_name":"news-bot","content":"Fed minutes released [embed: Fed minutes released — https://example.com/fed]","posted_at":"2026-09-17T14:33:00.000+00:00","edited_at":null,"is_pinned":false,"has_attachments":false}
```

(The `bot` join message is intentionally skipped.)

---

## After you finish

1. Print the **absolute path** of the JSONL file.
2. Print the **count of messages** captured.
3. Print the exact command to ingest:
   `npm run discord:ingest:jsonl -- --source <source_name> --file <absolute_path>`
4. Stop. Do not run the command yourself — the user owns that step.

If you cannot complete the scrape (e.g. you cannot reach Discord, login failed,
or the page never loads), report the failure clearly and do not write a
partial JSONL file.

## Tips for accuracy

- The Discord message snowflake can be copied from the message context menu
  ("Copy Message Link") — the trailing decimal in the URL is the ID.
- Timestamps in Discord's UI are relative ("Today at HH:MM"). Convert to
  absolute ISO-8601 using the current date you observe.
- Do not include the channel topic or pinned-message banners — only on-message
  text counts.
- If a message has multiple embeds, concatenate them with `;` separators inside
  the same `[embed: ...]` block.
- Newlines inside `content` are valid JSON: use `\n` in the JSON string.
- If you are unsure about an `author_name` (deleted user, webhook icon), use
  `"Deleted User"` or `"Webhook"` — the importer will accept any non-empty
  string.