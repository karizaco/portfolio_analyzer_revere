# fundedmind — measured before the catalog (2026-11-18)

A YouTube transcript source. Identity, content filter, worker URL inference
and caption defaults are wired. Listings were measured with yt-dlp and are
not yet written into the database.

| | |
|---|---|
| handle | `@FundedMind` |
| logical channel | `fundedmind` |
| primary listing | `https://www.youtube.com/@FundedMind/streams` |
| secondary listing | `https://www.youtube.com/@FundedMind/videos` |
| streams | **465** rows (461 `was_live`, 4 upcoming), ~457 hours, median ~55 min |
| videos tab (sample 72) | short education / psychology / prop guides / FM Interview; median ~18 min |
| language | CZ/SK community. Measured captions on `jN_0UOGGV4A`: **`sk-orig` (original)** + `cs` auto; manual subs only live_chat. Defaults: `sk-orig,cs-orig,cs,en`; Deepgram `cs` until Slovak pilot |
| session date | in the title, Czech `D.M. YYYY` / `D.M.YYYY` after the host |
| host | in the title between `\|` and the date (multi-host desks) |
| on-screen position list | **not determined.** Needs a frame census. Until then this source is transcript-only and is **not** in `OCR_CHANNELS`. |

## Measured stream kinds (full streams listing)

| kind | count | title examples |
|---|---:|---|
| `live_trading` | 314 | `Live Trading \| Oliver Pátek …`, `LiveTrading \| Michal Veselovský …` |
| `focus` | 109 | `Sunday Focus \| Petr Můčka …`, `Monday Focus \| …` |
| `market_structure` | 6 | `Market Structure LiveTrading \| Petr Šumný …` |
| `gold` | 6 | `Gold Trading \| Sunita Hakimi …` |
| `macro` | 6 | `Macro Monday \| Daniel Valchář …` |
| `event` | 1+ | tournament / floor / Charts and Chill |
| `other` | 23 | residual |

Frequent hosts on streams: Oliver Pátek, Sunita Hakimi, Petr Můčka,
Michal Veselovský, Daniel Valchář, Petr Šumný, Daniel Hvězda (sometimes joint).

## What a signal is

A trade or setup the **named host** states during a live desk session.
Not an interview retrospective, not a prop-firm how-to, not a psychology
lesson. Extract-eligible kinds: `live_trading`, `focus`, `market_structure`,
`gold`, `macro`. Interviews / education / events are catalogued and
quarantined from the default transcript extract path.

Instrument universe is not settled: titles mention gold and live desks may
include FX/futures. Do not force every token through the US equity lexicon
without evidence.

## Family fit

| peer | what is reused |
|---|---|
| `davidsevcik` | Czech caption/Deepgram stack, Czech name/signal starting point |
| `t3live` | multi-host / multi-show content filter pattern |
| `martinlukkt` | streams-first, date-in-title, measure-before-OCR, VTT suffix |

## Code so far

```
src/fundedmind/channel.js
src/fundedmind/contentFilter.js
tools/whiteboard_worker.py   # infer_channel_from_url + CHANNEL_SOURCE_URLS
tools/fetchSevcikTranscripts.js  # CHANNEL_DEFAULTS entry
test/fundedmindChannel.test.js
.gitignore                   # *.captions.fundedmind.*.vtt
```

## Recommended next steps

1. Catalog streams:  
   `python tools/whiteboard_worker.py catalog --channel fundedmind --source-url https://www.youtube.com/@FundedMind/streams`
2. Catalog videos separately (same channel, videos URL).
3. Caption pilot on ~20–40 recent extract-eligible streams  
   (`node tools/fetchSevcikTranscripts.js --channel fundedmind --limit 20`).
4. Sample frames from 3–5 live_trading sessions before any OCR decision.
5. Extractor v1 only after caption quality and instrument language are measured;
   attribute every row with `host`, `kind`, `sessionDate`.


## Pilot status (2026-11-18)

- Catalog streams pilot (`--limit 30`): **26 rows inserted**, status `partial` (upcoming streams without upload_date dropped by yt-dlp). All `pending`, channel=`fundedmind`, source_url streams listing.
- Caption pilot: `jN_0UOGGV4A` (`LiveTrading | Michal Veselovský 17.11. 2026`) → provider `youtube_auto`, language **`sk-orig`**, **1058 segments**, written to `data/video_pipeline/transcripts/jN_0UOGGV4A.json`.
- Full streams catalog (~465) and videos tab not run yet (rate-limit budget).
- Extractor / dashboard / OCR not started.


## Transcript pilot on the first 26 catalog rows (2026-11-18)

Audio-only Deepgram path already exists in `tools/fetchSevcikTranscripts.js`
(`-f bestaudio/best`, convert to 16 kHz mono MP3, delete audio after success).
Full video files are **not** downloaded for transcripts.

| | |
|---|---|
| cataloged pilot rows | 26 |
| quarantined (event) | 1 — `JLyMZbW5oa8` Charts and Chill |
| already had transcript | 1 — `jN_0UOGGV4A` (sk-orig, earlier) |
| fetch candidates | 24 |
| fetched ok | **23** |
| failed | **1** — `VjyKk33u0Jw` |

### Providers

| provider | language | count | notes |
|---|---|---:|---|
| `youtube_auto` | `cs-orig` | 21 | Czech hosts |
| `youtube_auto` | `sk-orig` | 2 | Michal Veselovský desks (`jN_0UOGGV4A`, `cO5Z7JicqLk`) |
| `deepgram` | `cs` | 1 | `8iiACALYbu4` — no YouTube captions; **audio-only** download worked (662 segments) |

### Failure

`VjyKk33u0Jw` (Sunday Focus 25.10. 2026): ~300 s stream, no auto-captions, Deepgram returned **no utterances** (likely little/no speech or non-speech audio). Not a missing-key problem — the audio path ran.

### Disk

Deepgram path does not keep video. Temporary audio under `data/video_pipeline/audio_sevcik/` is deleted after a successful transcript (`--keep-audio` would retain it).

### Full streams catalog

Started in background after the pilot:

```
python tools/whiteboard_worker.py catalog --channel fundedmind \
  --source-url https://www.youtube.com/@FundedMind/streams \
  --extractor-args "youtube:player_client=visios" \
  --cookies-file data/video_pipeline/downloads_1080p/youtubeCookies.txt \
  --sleep-requests 2
```

Single yt-dlp process, metadata only, no media download. Rows appear in SQLite when the listing pass finishes (upsert at end). Log attempt: `data/video_pipeline/logs/fundedmind_catalog_full.log`.


## Status snapshot (2026-11-18 resume)

- Full streams catalog: **465** rows dated (ill-dates --build-listing, mweb).
- Transcripts: **59** (48 cs-orig, 9 sk-orig, 2 deepgram/cs).
- Extract pilot undedmind-1: 5 videos, signals written for BTC/XAUUSD desks; SK live desk still low recall.
- Catalog path fix: default client mweb + ignore-no-formats; fill-dates FK order fixed.

## Progress 2026-11-19

- Catalog: 465 streams dated
- Transcripts: 136 videos (113 cs-orig, 16 sk-orig, 7 deepgram/cs); ~302 eligible remaining
- Quarantine: interviews/education/events + same-day/future title dates + hard-skip VjyKk33u0Jw (silent)
- Extract parser: fundedmind-3 (12 signals on 40 newest eligible txs) — gold desk strongest; SK Veselovský still low recall
- Batches this session: +38 then +39 captions (only silent id failed after same-day upcoming fix)

## Progress 2026-11-19b (batching + Veselovský)

- Transcripts: ~260+ eligible (batches of 40, several 0-fail runs after quarantine fixes)
- Parser fundedmind-6:
  - SK verbs: bral/zobral/nabral/vstupoval/stopka
  - Veselovský host default NAS100
  - Filters: nebral, si bral, bare mi, tea/account/whatsapp opens, take-profit→exit, stoplos with bral→stop_out
  - euro bare → EURUSD
- Veselovský went from ~0 signals to dominant share of fundedmind-6 signals
- Remaining weak: Oliver Pátek / focus / market structure desks; some NAS100 default over-attach on multi-instrument days


## Progress 2026-11-19c (open items / fundedmind-9)

Parser **fundedmind-9** after measuring Oliver/Šumný/focus gaps on fundedmind-8.

### Open-item outcomes
| item | result |
|---|---|
| host-none titles | **0** remaining (already fixed in contentFilter) |
| Oliver recall | **4 → 33** signals (4 → 19 videos) |
| focus | **45 → 298** signals (33 → 91 videos) |
| Šumný | **1 → 6** signals (US30/SP500 phrasing) |
| NAS100 over-attach | default skipped when another instrument is named in ±60s (e.g. nearby gold → XAUUSD) |
| caption batches | still on 429 cool-down; eligible set already complete |

### Extract snapshot (430 eligible txs)
- **1362** signals on **328** videos (`fundedmind-9`)
- Hosts: Veselovský 505, Můčka (+joint) ~447, Sunita 281, Valchář 78, Oliver 33, Šumný 6
- Tickers: XAUUSD 417, NAS100 377, EURUSD 225, BTC 180, ES 59, USDJPY 47, US30 11, …
- ticker_from: window_unique 671, session_default 348, session_dominant 100, adjacent cues ~168, segment 75

### Code changes (quirks stay in src/fundedmind/)
- `tradeRead.js`: CZ verbs (držím, zavíral, vezmu, jsem v longu/shortu), US30/SP500/USDJPY instruments, ±2 cue + 60s unique ticker borrow (stop/exit backward-only), dominant-session fallback (strict), NAS100/gold default respects nearby competing instruments, undiacritic `zlate`
- `signalExtractor.js`: PARSER_VERSION `fundedmind-9`, dominantInstrument for multi-instrument hosts
- tests: 30 pass (`fundedmindChannel` + `fundedmindTradeRead`)

### Still soft
- Oliver still sparse vs 67 desks with tx (many opens never name a product and no clear session dominant)
- Šumný is market-structure coaching-heavy; few first-person fills
- session_default NAS100 still large on pure Veselovský unnamed fills (by design)
