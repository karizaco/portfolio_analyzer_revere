---
name: spelling-qullamaggie
description: "User repeatedly corrects \"Quullamaggie\" to \"Qullamaggie\" — the channel is named after Kristjan Qullamaggie, so the spelling is Qullamaggie (with the K dropped from \"Quill\")"
metadata:
  node_type: memory
  type: feedback
  originSessionId: ba4fc76f-933d-43f8-addb-9ea105b4d328
  modified: 2026-09-29T06:55:32.376Z
---

# Always spell "Qullamaggie" (not "Quullamaggie")

The YouTube channel/creator is **Qullamaggie** (pronounced "kwull-uh-MAH-gee"), named after Kristjan Qullamaggie. Spelling is **Q-u-l-l-a-m-a-g-g-i-e** — no extra 'u' between 'Q' and 'l'.

The misspelling "Quullamaggie" appears in conversation, internal notes, or git commit messages.

## Why

The creator's name is Qullamaggie, with one 'u'. Adding a second 'u' is a common mistake when typing.

## How to apply

- In any user-visible text (commit messages, documentation, reports, conversation replies, HTML files, README.md, CLAUDE.md, MEMORY.md), always use **Qullamaggie**.
- If a previous artifact was committed with "Quullamaggie", fix it when editing that artifact (e.g., `sed` over docs/ before commit).
- For code identifiers, the existing project uses `qmg` / `qullamaggie` / `Qullamaggie` (channel slug in SQLite uses lowercase `qullamaggie`). Don't change those — only fix the user-visible spelling.
