---
name: sevcik-ingest-backlog
description: "The Sevcik corpus was COMPLETED on 2026-11-06: 491 of 497 catalogued streams have transcripts (the other 6 are quarantined non-market series), and the whole corpus has been through the extractor. The numbers that matter and the stage order that is easy to get wrong."
metadata:
  node_type: memory
  type: project
  modified: 2026-11-06T02:45:00.000Z
---

**DONE 2026-11-06.** The Sevcik stream was mid-pipeline when the session was
interrupted; it is now complete and the report reflects the whole corpus.

## The state (measured, not estimated)

| stage | count |
|---|---|
| catalogued `davidsevcik` videos | 497 (2020-08-13 → 2026-11-04) |
| transcripts on disk | 491 |
| transcripts ingested (`video_transcripts`) | 491 (698,450 segments) |
| signals (`trade_signals`) | 1012 across 340 videos, 26 tickers |
| setups (`sevcik_setups`) | 2009 across 406 videos, 32 setup tickers |
| TA claims scored | 1279 |

The six without transcripts are the **quarantined non-market series** — the
"14 dní" challenge streams. `src/sevcik/contentFilter.js` drops them on
purpose and every path (fetch, extract, aggregate) applies the same filter.

## The stage order: outcomes → aggregate → ta

The aggregate reads `data/sevcik_outcomes.json` and embeds it in the payload;
the TA tool then re-embeds its summary and rebuilds the report. **Run
aggregate → ta and the report silently keeps the PREVIOUS run's outcomes** —
on 2026-11-05 the panel said "Not scored yet" while the database held 68
outcome rows from an older, smaller corpus. There is no warning; the panel
renders whatever is in the payload.

```bash
node tools/analyzeSevcikOutcomes.js    # Yahoo prices, cached under data/price_cache/yahoo
node tools/aggregateSevcikSignals.js
node tools/analyzeSevcikTa.js
```

## What the claims score

1,279 claims: **hit rate 1w 52.2 %** (95 % CI 49.5–54.9 %), **hit rate 1m
54.6 %**, against a **SPY baseline of 58.4 %** — the tool's own verdict is
`assess: no_clear_edge`, with 3 claims missing prices. The TA pass reads
53.3 % (primary bucket 54.0 %) and its 48 walk-forward folds select an
allow-bucket in only 4. The source is **not yet shown to beat the index**,
and 491 transcripts is enough to say so rather than hope for it.

## The vocabulary was broken, not the corpus (2026-11-06)

**150 of 491 videos produced ZERO signals.** It looked like the videos were
quiet. They are not -- they are 30-60 minutes of chart commentary each. Four
defects in the Czech vocabulary explained all of it:

1. **\w does not match Czech diacritics.** Even under /u, \w is ASCII-only,
   so `poklesov\w*` stopped before the "ý" in "poklesový" and the pattern
   NEVER FIRED. "máme poklesový kanál" is how he states a bearish call.
   Every Czech word tail ending in a diacritic was dead.
2. **The falling channel was in BULLISH_PATTERNS.** A falling channel read
   as a BULLISH call.
3. **The ASR drops the "g": "do Longu" is written "do Lon".** The most common
   construction in the corpus did not match.
4. **No Czech BUY verbs.** "kupuje" / "dokupuje" / "kupovat" / "sázím na"
   were missing, so "Berkshire dokupuje Alphabet" produced nothing.

After the fix: signals 1012 -> **1487**, tickers 26 -> **32**, zero-signal
videos 150 -> **104**, TA claims 1279 -> **1734**. Parser version
`sevcik-signals-3` -> `-4`.

**The hit rate FELL (1w 52.2 % -> 50.8 %, SPY 57.9 %).** That is correct, not
a regression: the recovered claims are descriptive ("Berkshire bought
Alphabet" is not a call on Alphabet). A bigger corpus that scores lower is
more honest than a small one that scored well by missing half the channel.

**Lesson: the small-corpus measurement was not representative.** The
vocabulary was built on 12 streams and every count in it came from there.
When the corpus tripled, the vocabulary did not grow with it -- and the
counted patterns were the ones that happened to appear in those 12 streams.

## Traps

- **`transcript_fetched_at` is an EMPTY STRING, not null, for a video that
  was never fetched.** `count(transcript_fetched_at is not null)` counts
  every row and looks like "497 of 497 fetched". It is not. The fetch tool's
  own candidate query is the truth: a video is a candidate when its transcript
  FILE is missing.
- **`data/sevcik_extract_log_batch*.txt` cannot measure coverage.** The
  batches re-extract a rolling window: ten logs held 968 lines over 138
  unique video ids. **The database is the only coverage count that is true.**
- The extractor replaces the signals/setups of the videos it processed and
  only those, so a partial re-run is safe — but an interrupted run leaves a
  gap. Re-run the missing ids with `--video-id` rather than the whole corpus.
- PowerShell `*>` writes **UTF-16**. A log written that way will not parse
  with a UTF-8 reader.

Related: [[sevcik-ingest-backlog]] superseded the earlier, wrong reading of
the state. [[qmg-frame-mismatch]].
