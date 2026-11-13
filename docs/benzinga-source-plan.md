# Adding Benzinga (`@Benzinga`) as a source: analysis and implementation plan

*Status: IMPLEMENTED through the pilot, 2026-11-12. Phase 0 (hardening), the
catalog, the classification, the transcripts, the extractor, the readings and the
aggregation are all in place and measured. The SCALE decision (Phase 3 beyond
the pilot) is still open — see § "What the pilot measured".*

*Every number marked "measured" was taken on 2026-11-11/12 from the catalog
(opened read-only), the code, or a sample of the channel. Appendix A has the
commands.*

---

## TL;DR

- Benzinga belongs to the **transcript family** (Sevcik, T3Live), not the OCR
  family. The T3Live chain can be reused almost end to end: flat listing →
  captions first, Deepgram as fallback → the shared English extractor →
  per-show aggregation → outcome scoring against SPY → HTML dashboard.
- **Benzinga is not a trade-call channel by default.** Of the newest 150
  streams, 51% are company earnings-call rebroadcasts and 2% are Fed press
  conferences. The `/videos` tab is mostly 3-minute futures updates,
  explainers, CEO interviews and product tutorials. The gate must therefore be an
  **allow-list of shows** (PreMarket Playbook/Prep, The Drift, setup clips).
  T3Live's permissive deny-list would not work here.
- **The shared extractor fails on news-style speech (measured).** It publishes
  analysts' opinions as the host's own call: "Wedbush's Dan Ives remains very
  bullish on Tesla" becomes a forward bullish TSLA at confidence 0.83. It also
  reads "I'm going to sell some puts" as **bearish**, though selling puts is a bullish position. Both must
  be fixed before Benzinga's corpus goes through it.
- **The recap / sector analysis / next-week preview has no home today.**
  `trade_signals` is a ticker table. Add a source-agnostic `market_readings`
  table for index, sector and macro-event stances, scored against SPY and the
  sector ETFs.
- **Fix four latent defects first (Phase 0).** A channel this size turns them from
  latent into acute:
  - The OCR downloaders are not channel-scoped. Measured: they already pick T3Live rows.
  - The fetch tool silently falls back to **Czech** settings for an
    unregistered channel.
  - `catalog` labels an unrecognised URL as `revere`.
  - The per-source extract tools are copies, and Sevcik's copy leaves stale rows behind.
- **Recommended order:**
  1. hardening plus a small registry refactor;
  2. catalog and inventory;
  3. classification and dating;
  4. a 40-video transcript pilot;
  5. extractor rules;
  6. market readings;
  7. aggregation, scoring and the dashboard.

  Wall time is dominated by network rate limits and the Deepgram budget.

---

## Part 1: How the app is structured today

### 1.1 Two families of sources

| family | sources | what is read | pipeline |
|---|---|---|---|
| **OCR** (pixels) | Revere (`@revereasset`, whiteboard), Qullamaggie (`@Qullamaggie`, chart-stream and positions table) | on-screen holdings lists | catalog → download 720p/1080p → prefilter frames → Tesseract/EasyOCR → parse → probe logs → `aggregateScanResults` → `analysis.json`, timeline, portfolio report |
| **Text** | Sevcik (`@davidsevcik-sved4697`, Czech streams), T3Live (`@t3live`, English, multi-show), AsymTrading (Substack; **in progress and uncommitted**: `src/asym/`, `asym_*` tables), Discord | spoken words, article text, chat messages | catalog → transcript (captions, then Deepgram) → deterministic extractor → `trade_signals` / `sevcik_setups` → aggregate → outcomes vs SPY → dashboard |

Catalog contents (measured):

| channel | videos | transcripts | signals |
|---|---|---|---|
| `revere` | 1,825 | — | — |
| `qullamaggie` | 588 | — | — |
| `davidsevcik` | 498 | 491 (378 `cs-orig` captions, 113 Deepgram `cs`) | 1,444 (parser v5) |
| `t3live` | 7,349 | 2,574 (2,461 `en` captions, 113 Deepgram `en`) | 5,588 from 1,233 videos, 741 tickers |

### 1.2 The shared backbone a YouTube transcript source plugs into

| layer | modules | shared? | notes |
|---|---|---|---|
| channel identity | `src/<source>/channel.js`; `CHANNEL_SOURCE_URLS` + `infer_channel_from_url` in `tools/whiteboard_worker.py` | per source | logical name ≠ YouTube handle; URLs are looked up, never interpolated |
| catalog | `videos` + `catalog_runs` in tracked `state.sqlite`; `whiteboard_worker.py catalog` (per-video metadata); `tools/importFlatListing.js` (flat, undated); `fill-dates` (`--input` TSV, `--from-listing`, `--build-listing`) | shared | `videos.status` is the OCR lifecycle; transcript-source rows simply stay `pending` |
| transcript fetch | `tools/fetchSevcikTranscripts.js` (generic despite the name: `--channel`, `CHANNEL_DEFAULTS`), `tools/fetchTranscriptChunks.js` (captions-only, chunked, blacklist with verdicts), `tools/fetchDeepgramBatch.js` | shared | auto + manual captions first; Deepgram `nova-2` as fallback; 429-aware |
| normalization | `src/transcript/transcriptNormalize.js` (VTT, rolling-cue collapse, timing-free checksum), `deepgramClient.js` (the language parameter selects the acoustic model), `segmentStore.js` (untracked segments cache, ATTACHed) | shared | |
| extraction | `src/sevcik/signalExtractor.js` (run model, price roles, `claim_kind`) + `signalPatterns.js` (Czech and English lists) + name finders (`czechNames.js`, `src/t3live/englishNames.js`) + `lexicon.js` (SEC + seed + non-US) + `config/ticker_names_confirmed.csv` | shared engine, per-source options | the engine lives under `src/sevcik/` for historical reasons |
| show / quarantine | `src/sevcik/contentFilter.js`, `src/t3live/contentFilter.js` | per source | the show is derived from the title at run time and not stored |
| scoring | `src/sevcik/outcomeAnalysis.js` (Yahoo cache, SPY baseline, Wilson CI) + per-source `analyze*Outcomes.js` | shared core | T3Live adds per-show baselines and "same call on SPY" |
| reporting | per-source aggregators → CSV/JSON + self-contained HTML (`src/report/*Report.js`) | per source | derived outputs are gitignored; transcript JSON and VTT are tracked |

### 1.3 The template: how T3Live was plugged in

Commits `60d2ef6` and `7888d2a` touched the following:

- New source modules: `src/t3live/{channel,contentFilter,englishNames}.js`.
- New tools: `tools/{extract,aggregate,analyze}T3live*.js`, `surveyT3liveNames.js`,
  `importFlatListing.js`, `fetchTranscriptChunks.js`, `fetchDeepgramBatch.js`.
- A new dashboard: `src/report/t3liveReport.js`.
- Small edits: one `CHANNEL_DEFAULTS` row in the fetch tool, and two entries in
  `whiteboard_worker.py`.
- Shared-engine changes in `signalExtractor.js`, `signalPatterns.js` and
  `transcriptNormalize.js`, with the blast radius on Sevcik measured.
- Growth of `config/ticker_names_confirmed.csv`.
- Five test files, nine npm scripts, `.gitignore` rules, and README and CLAUDE.md sections.

Benzinga needs the same set of pieces. The question is how many of them should be
copies.

### 1.4 What breaks or gets harder at a third transcript source

Each item below was measured or read in the code on 2026-11-11.

1. **The OCR downloaders are not channel-scoped.**
   - `whiteboard_worker.py select_videos_for_download()` takes
     `status IN ('pending','error','downloading') ORDER BY upload_date ASC`
     with no channel filter. Its first 30 picks today are **all T3Live** rows.
   - `downloadHiresBatch.js` (`buildDownloadCandidateSql`) is unscoped too:
     **16 of its first 30** picks are T3Live or Sevcik rows.
   - Thousands of Benzinga rows, many of them 2–3.5 h streams, would dominate both queues.
2. **An unregistered channel silently gets Czech settings.**
   - `channelDefaults()` falls back to Sevcik's `cs-orig,en` caption order and to
     Deepgram `cs`.
   - Captions would still be found through `en`. But a caption-less English
     video would be sent to Deepgram's Czech acoustic model, which is the failure
     CLAUDE.md documents (15 useless segments instead of 881).
   - The result is written to disk, so the video is never fetched again.
3. **`catalog` labels an unrecognised URL `revere`**
   (`args.channel or infer_channel_from_url(...) or 'revere'`). A Benzinga
   *playlist* URL carries no handle.
4. **The extract tools are copies.**
   - `extractSevcikSignals.js` and `extractT3liveSignals.js` duplicate the
     register, select, load and replace code.
   - Sevcik's copy replaces a video's rows only when the new run found signals, and it
     never revisits a quarantined video. As a result, **8 rows from parser versions
     3–4 survive on 4 videos**: one is quarantined, and three now yield zero signals.
     These rows are still aggregated and scored.
5. **Channel configuration is spread over about six places.**
   - The places: `channel.js`, `CHANNEL_SOURCE_URLS`, `infer_channel_from_url`,
     `CHANNEL_DEFAULTS`, the aggregator's hard-coded `WHERE v.channel = 't3live'`,
     and the npm scripts.
   - The chunk runner also parses the fetch tool's `[sevcik-transcripts]` log prefix,
     so renaming the prefix would silently break the runner.
6. **The catalog stores no duration, live status or listing membership.**
   Questions like "is this a live show, a 3-minute clip, or an upcoming stream?"
   currently cost one request per video, although a flat listing returns all of it for free.
7. **`importFlatListing.js` records `listing_complete = 1` unconditionally**, even
   for a truncated listing.
8. **Repository size.**
   - Tracked transcripts are already 970 MB: 3,220 JSON files (466 MB) and 2,995 VTT files
     (489 MB), with medians of 125 KB and 144 KB.
   - The git pack is 858 MB.
   - `state.sqlite` is 39 MB, against GitHub's 100 MB per-file limit. That limit is
     why `transcript_segments` was moved out.
9. **Concurrency.**
   - `state.sqlite` is shared by several agents. On 2026-11-11 at 21:36 local time,
     another process restored it to the committed version, which dropped that
     day's uncommitted catalog runs.
   - Benzinga catalog writes must be committed promptly and never run alongside
     another writer.

---

## Part 2: What Benzinga looks like (sample, measured 2026-11-11)

**Method.** A flat listing of the newest 150 entries of `/streams` and of `/videos`
(about a dozen page requests, no per-video metadata calls), plus caption lists for
4 videos. The sample covers 2026 only.

| tab | content type | n of 150 | median length | value here |
|---|---|---|---|---|
| streams | company **earnings-call rebroadcasts** (`... Earnings Call \| $TICKER \| WATCH LIVE`) | 76 | 62 min | none as calls (management speech); useful as an **earnings calendar** from the titles alone |
| streams | **PreMarket Playbook**: daily, live, air date in the title, partners in the title (T3 Live 10, All Access 5, Nasdaq 4, Cboe 2, Direxion 1) | 50 | 147 min (118 h in the sample) | **primary**: recap, movers, levels, next-session/next-week preview, setups |
| streams | **The Drift** (Adam Mesh & Tom Sosnoff, weekly, options) | 16 | 47 min | **high**: options-structured trade ideas |
| streams | sponsored webinars / education | 5 | 58 min | low |
| streams | FOMC press conferences | 3 | 35 min | none as calls; macro calendar |
| videos | futures / market-update clips | ~63 | 3 min | market readings only (recap) |
| videos | thematic explainers ("7 AI stocks to own") | 51 | 8–13 min | medium: long-horizon picks |
| videos | single-ticker small-cap clips ("VIVS Stock in Play...") | 28 | 2–4 min | medium: setups with levels, with microcap price-data risk |
| videos | CEO interviews | 7 | 39 min | none as calls (insiders talking their book) |
| videos | education / Benzinga Pro tutorials | 7 | 3–14 min | none |

Other facts:

- **Captions.**
  - All 4 sampled videos carry English auto-captions (`en-orig`, `en`): one
    PreMarket Playbook, one Drift, one futures clip and one earnings call.
  - The two live shows also list uploaded subtitles.
  - You report that some videos have no captions. They are most likely in older eras,
    as with T3Live, where 237 of the 630 Club streams had none.
- **102 of 150 stream titles carry `$CASHTAGS`.** That is a free, high-precision hint of
  which tickers are discussed.
- **Flat-listing dates are approximate.** "4 weeks ago" became `20261012` for a dozen
  videos. These dates must never be stored as `upload_date`.
- **Show lineage.**
  - PreMarket Prep has run since 2014: hosts Joel Elconin and Dennis Dick, later
    Aaron Bry; weekdays 8–9 am ET; about 1.3k podcast episodes by 2024.
  - "PreMarket Playbook" is the 2026 name, and it runs 2–3.5 h.
  - Benzinga maintains per-show YouTube playlists (Appendix B).
- **Overlap with T3Live.** "PreMarket Playbook + T3 Live" episodes feature T3Live
  people, so their calls are not independent of the T3Live corpus.

### Extractor probe

The shared extractor was run with T3Live's English settings and no database writes.

| sentence | result today | correct? |
|---|---|---|
| "Wedbush's Dan Ives remains very bullish on Tesla heading into next week." | TSLA bullish, forward, conf 0.83 | **no**: a reported analyst opinion |
| "Morgan Stanley raised its price target on Nvidia to 250 dollars, they are bullish on the name." | NVDA bullish, forward, conf 0.44 | **no**: reported |
| "On CRWV I'm going to sell some puts here at the 80 strike." | CRWV **bearish**, action `sell`, conf 0.50 | **no**: short puts are a bullish position |
| "Nvidia is up 4% in the premarket after earnings, and AMD is down 3%." | no signal | yes: a description, not a call |
| "For next week I'm bullish on PLTR, long over 180 with a stop under 172." | PLTR bullish, entry 180, stop 172, conf 0.58 | yes |
| the same sentences with "Palantir" and "CoreWeave" spoken as names | no signal | **name gap**: both are unconfirmed candidates; "SpaceX" does not resolve at all |

The host names do not resolve to tickers today. However, "Tom" proposes TOMZ and
"Brent" proposes BNO. Brent is also a host's first name and the crude-oil
benchmark, so `brent` must never be confirmed in the shared names table.

---

## Part 3: Design

### 3.1 Decisions

- **D1. Benzinga is a transcript source.** Logical name `benzinga`, handle
  `@Benzinga`, listings `/streams` and `/videos`, language `en`. OCR of the
  show's on-screen charts and "stocks in play" panels is out of scope.
- **D2. Gate by an allow-list of shows.**
  - Extracted by default: `premarket_playbook` (including PreMarket Prep and
    Prep Plus), `the_drift`, `stock_in_play` clips, and `explainer` (scored at one month).
  - Quarantined by default: earnings calls, Fed press conferences, CEO interviews,
    education and webinars, product tutorials, upcoming or live placeholders, and Shorts.
  - Market-update clips feed `market_readings` only.
- **D3. Generalize before adding.** Do a small refactor and prove it with a
  regression check, instead of making a third copy. Option B, copying the T3Live
  files, is faster but repeats defects 1.4.4 and 1.4.5.
- **D4. Three output layers per video:**
  - ticker calls (`trade_signals`, same table as today);
  - market, sector and event readings (new `market_readings` table);
  - calendar events read from titles (optional, Phase 7).
- **D5. New English rules go into the shared pattern lists.** Each change records
  its blast radius on T3Live and keeps Sevcik pinned unchanged, which is the
  project's existing rule.
- **D6. Measure before scaling.** Every Benzinga-specific rule is measured on a pilot
  corpus first.
- **Out of scope.** Benzinga produces claims, not holdings. It does not feed
  `portfolio_snapshots.csv` or the performance report, the same as Sevcik and T3Live.

### 3.2 Component map: reuse, extend, new

| need | reuse as is | extend | new |
|---|---|---|---|
| identity & URLs | — | `whiteboard_worker.py` channel map reads `config/channels.json` | `config/channels.json`, `src/sources/registry.js`, `src/benzinga/channel.js` |
| listing import | `importFlatListing.js` core | optional `duration` / `live_status` columns; `--listing-kind`, `--playlist-id`, `--partial` | `video_listing_entries` table |
| show classification | the T3Live classifier pattern | — | `src/benzinga/contentFilter.js` (shows, partner, quarantine, priority) |
| dating | `fill-dates --input` (mweb client); the bound rule of `resolveUndatedDates.js` | — | `src/benzinga/titleDates.js` (air date from the title, cross-checked against listing-order bounds) |
| captions / Deepgram | fetch tool, chunk runner, Deepgram batch runner, blacklist verdicts | registry row; unknown channel becomes a hard error; record provider `manual` when uploaded subtitles were used | — |
| ticker extraction | extractor engine, English name finder, CAPS gate, index aliases, rolling-cue collapse | attribution → `claim_kind='reported'`; options direction; host stoplist; confirmed names | `src/transcript/extractRunner.js` (shared, always replaces), `src/benzinga/sections.js` |
| market & sector readings | the sector vocabulary from the Asym parser (once committed) | spoken aliases (semis, chips, banks, oil names...) | `market_readings` table, `src/transcript/marketReadings.js`, sector→ETF map |
| scoring | `outcomeAnalysis.js`; T3Live's per-show and same-call logic | score only `claim_kind='forward'`; split per partner; optional same-day horizon | `src/transcript/outcomeRunner.js` |
| reporting | the T3Live dashboard | labels and shows taken from the registry | `data/benzinga_*` outputs |

### 3.3 Show taxonomy

This is the initial taxonomy; it grows from the Phase 1 inventory.

| show id | detection | default | priority | scored horizon |
|---|---|---|---|---|
| `premarket_playbook` | `/premarket\s+(playbook\|prep)/i`, plus playlist membership | extract | high | 1w / 1m (+ optional same-day) |
| `the_drift` | `/the\s+drift/i` | extract | high | 1w / 1m |
| `stock_in_play` | one all-caps ticker in the title, < 400 s, not news-anchor wording | extract | medium | 1w |
| `explainer` | ≥ 400 s, thematic, not an interview or education | extract | medium | 1m |
| `market_update` | futures / markets wording, < 400 s | readings only | low | — |
| `earnings_call` | `/earnings\s+call/i` | quarantine (feeds calendar) | — | — |
| `fed_presser` | `/fomc\|press\s+conference\|rate\s+decision/i` | quarantine (feeds calendar) | — | — |
| `interview` | `/\bceo\b\|exclusive interview\|co-founder/i` | quarantine | — | — |
| `education`, `product_tutorial`, `webinar` | title patterns | quarantine | — | — |
| `upcoming` | `live_status` is `is_upcoming` or `is_live` | skip until `was_live` | — | — |

**Partner.**
- Parsed from `PreMarket Playbook + <partner>`: `t3live`, `nasdaq`, `cboe`, `direxion` or
  `all_access`.
- Reported and scored per partner.
- Sponsor and issuer partners are flagged, for example Direxion as an ETF issuer.

### 3.4 Data model (additive only)

**`video_listing_entries`** holds one row per (video, listing).
- Columns: `video_id`, `channel`, `listing_kind` (`streams | videos | shorts | playlist`),
  `listing_url`, `playlist_id`, `playlist_title`, `duration_sec`, `live_status`,
  `first_seen_at`, `last_seen_at`.
- Why a side table rather than columns on `videos`:
  - the tracked table's shape is pinned and shared with the OCR pipeline;
  - `videos.source_url` is overwritten by whichever listing ran last, so it cannot
    record membership.

**`market_readings`** is source-agnostic; Asym's readings could move here later.
Columns: `video_id`, `transcript_id`, `scope` (`market | sector | macro_event | earnings_event`),
`subject`, `proxy_ticker`, `stance` (`bullish | bearish | neutral | mixed | watch`),
`claim_kind`, `section`, `horizon_text`, `event_date`, `event_time_sec`,
`evidence_text NOT NULL`, `parser_version`.

**`trade_signals`** gets new values only, with no CHECK-constraint changes:
- `claim_kind='reported'`;
- options actions: `sell_put`, `buy_put`, `buy_call`, `sell_call`, `spread`;
- an optional `section` column, added through the existing inline-ALTER guard and
  documented in `schema.sql`.

**Computed at run time, not stored** (T3Live's principle): show, partner and title cashtags.

### 3.5 Extraction rules for news-style speech

1. **Attribution guard.**
   - A direction or target stated about a third party becomes `claim_kind='reported'`.
     Examples: "<firm> upgraded / raised its price target", "analysts expect",
     "according to", "<person> says / remains bullish".
   - A broker named as the speaker (MS, GS, JPM...) never yields a signal on the broker's
     own ticker.
   - Probe rows 1–2 become tests.
2. **Options direction.**
   - Selling or shorting puts is bullish.
   - Buying puts is bearish; buying calls is bullish.
   - Covered or short calls are neutral to bearish.
   - Spreads take the direction of their side.
   - A strike is not an entry price.
   - Probe row 3 becomes a test.
3. **Sections.** Phrase cues tag windows of segments:

   | section | example cues |
   |---|---|
   | recap | "yesterday", "closed", "on the session" |
   | preview | "next week", "on the calendar", "CPI on Wednesday", "earnings this week" |
   | setup | "I like", "long over", "my trade", "levels to watch" |
   | interview | the guest's introduction |
   | sponsor | "brought to you by", partner pitches, promo codes |

   Claims inside a recap become retrospective. Sponsor windows yield no signals.
4. **Title cashtags corroborate.** A transcript ticker that also appears in the title
   gets a corroboration flag. The flag is reported only; it does not change any score
   until it has been measured.
5. **Index and macro.**
   - Keep the SPY/QQQ/IWM/DIA aliases.
   - "The 10-year", "crude", "gold" and "Brent" go to `market_readings` as macro
     subjects, never to a ticker.
6. **Names.**
   - Run the name survey through a `--channel` version of `surveyT3liveNames.js`.
   - Confirm each row only after reading it in context (Palantir, CoreWeave,
     SpaceX...).
   - Put the host names in the stoplist **before** confirming anything: Joel Elconin,
     Dennis Dick, Aaron Bry, Adam Mesh, Tom Sosnoff, Brent Slava.
   - The confirmed-names table is shared, so measure the Sevcik and T3Live deltas.

### 3.6 Scoring

- **Reuse T3Live's rules:**
  - one claim per (video, ticker), and conflicting mentions are not scored;
  - SPY baselines per show;
  - excess return against the same call made on SPY, with a confidence interval;
  - entry is the close on the upload date, or the Friday close for a weekend upload.
- **Score only `claim_kind='forward'`.** `analyzeT3liveOutcomes.js` and
  `analyzeSevcikTa.js` currently exclude only `'retrospective'`, so a new
  `'reported'` kind would leak in.
- **Split per partner.** Score T3 Live episodes separately. Claims made by T3Live
  people on both channels are correlated and must not be pooled as independent.
- **Optional same-day horizon for pre-market shows:** entry at the event-day open,
  exit at that day's close. Report it beside the conservative rule. It would also
  help T3Live's 630 Club.
- **Score sector and market readings with ETFs, relative to SPY.**
  - Sectors: XLK, SMH, XLF, XLE, XLV, XLI, XLB, XLU, XLRE, XLY, XLP, XLC.
  - Market: SPY, QQQ, IWM.

### 3.7 Storage

This is an estimate, to be measured in the pilot.
- A 2.5-hour episode is roughly 0.5–1 MB of JSON plus VTT, scaled from the T3Live medians.
- 1,000 episodes would add 0.5–1 GB, about doubling the tracked transcripts.

Recommendation: decide after the pilot. Default to tracking Benzinga's normalized JSON but
**not** its VTT, since captions can be fetched again. Revisit compression (`.json.gz`)
once the Benzinga share passes about 300 MB. Also watch `state.sqlite` growth,
because every signal row carries its evidence text.

### 3.8 YouTube etiquette at Benzinga's scale

- Build the catalog from flat listings only. Never run the per-video `catalog`
  command over the whole channel.
- Date only the allow-listed shows.
- Fetch captions through the chunk runner: 40 per chunk, with pauses, stopping on a 429.
- Never run alongside another YouTube job.
- Use Deepgram only for allow-listed caption-less videos, within an agreed budget, and
  delete the audio after each transcript (the tool's default).

---

## Part 4: Implementation plan

Each phase ends with `npm test` green and an explicit exit check. Phases 0–2
download no transcripts.

### Phase 0: Hardening and the minimal refactor (no Benzinga data)

| # | task | files | test |
|---|---|---|---|
| 0.1 | Scope both OCR downloaders to OCR-family channels | `whiteboard_worker.py` (`select_videos_for_download`), `src/video/downloadCandidates.js` | new `test/ocrDownloaderChannelScope.test.js`: transcript-family rows are never selected |
| 0.2 | An unknown channel is a hard error in the fetch tool (no Czech fallback) | `tools/fetchSevcikTranscripts.js` | extend `test/sevcikDeepgramLanguage.test.js` |
| 0.3 | `catalog` defaults to `revere` only for the known Revere playlist ids, and requires `--channel` otherwise | `whiteboard_worker.py` | `test/whiteboardWorkerCatalog.test.js` |
| 0.4 | `importFlatListing.js --partial` sets `listing_complete=0`; optional duration and live_status columns go into `video_listing_entries` | the tool, `data/db/schema.sql` | new test with a fixture TSV |
| 0.5 | `config/channels.json` becomes the single channel map (handles, listings, language), read by both Python and JS | `whiteboard_worker.py`, `src/sources/registry.js` | `test/channelRegistry.test.js` pins Python/JS agreement |
| 0.6 | A shared extract runner (register, select, load, and always-replace in one transaction per video), used by both the Sevcik and T3Live tools | `src/transcript/extractRunner.js`, both extract tools | regression: T3Live `trade_signals` identical; Sevcik identical except that the 8 stale rows are gone |

**Exit:** T3Live outputs unchanged; the Sevcik delta is −8 stale rows, documented.

**Coordination:** `data/db/schema.sql` currently carries the uncommitted Asym
edits. Land Benzinga's schema additions after that work is committed, as appended
sections only.

### Phase 1: Catalog and inventory

1. Add `src/benzinga/channel.js` and the `benzinga` entry in `config/channels.json`.
2. Take full flat listings of `/streams` and `/videos` with `id, title, duration, live_status`,
   and import them with `--channel benzinga`. Also check whether `/shorts`, `/podcasts`
   and show playlists exist.
3. Import Benzinga's show playlists as memberships (`listing_kind='playlist'`).
4. Write an inventory report: rows, hours and status per show and per year. Confirm the
   allow-list with the user.

**Exit:** rows catalogued as `benzinga`, zero per-video requests, committed promptly.

### Phase 2: Classification and dating

1. Write `src/benzinga/contentFilter.js` and `test/benzingaContentFilter.test.js`. The
   test uses the real sampled titles: each bucket, the partners, and upcoming/live entries.
2. Write `src/benzinga/titleDates.js`.
   - It reads the air date from PreMarket titles.
   - A date is accepted only if it falls inside the listing-order bounds (the same rule as
     `resolveUndatedDates.js`).
   - Disagreements are reported, never written.
   - Tests: "November 9, 2026", "Oct 27, 2026", "OCT 20, 2026".
3. Run `fill-dates --channel benzinga --input <priority ids TSV>` for the
   remaining allow-listed rows (mweb client).

**Exit:** every allow-listed row has a show and a date, and the quarantine counts are reported.

### Phase 3: Transcripts, a pilot first, then scale

1. Add the registry row: `subLangs ['en']`, Deepgram `en`, and the Benzinga quarantine.
2. Pilot 40 videos through `fetchTranscriptChunks.js --channel benzinga`: 20 PreMarket
   episodes across eras, 10 Drift episodes, and 10 clips or explainers. Measure caption
   coverage per show and era, and the transcript sizes.
3. From the pilot, decide the storage policy (3.7) and the Deepgram budget
   (caption-less hours × rate).
4. Scale the caption fetch in chunks. Run Deepgram through `fetchDeepgramBatch.js` for
   the agreed list only.

**Exit:** a coverage table per show and era; the budget approved; the storage decision recorded.

### Phase 4: Ticker extraction

1. Add `tools/extractBenzingaSignals.js`, a thin wrapper over the runner with the
   English config and parser version `benzinga-signals-1`.
2. Add the attribution guard, the options direction rules, the host stoplist and the
   confirmed names. Each gets the probe cases as tests, and each change records its
   T3Live blast radius: signal counts before and after, plus sampled diffs that have been read.
3. Add the section tagger (`src/benzinga/sections.js`), so claims inside a recap become retrospective.
4. Hand-label a sample, for example 10 episodes and about 200 extracted claims. Label each
   claim as a host call, reported, descriptive, or wrong ticker. Record precision per show,
   and iterate until the agreed bar is met.

**Exit:** precision recorded per show; T3Live and Sevcik deltas documented.

### Phase 5: Market, sector and event readings

1. Add the `market_readings` table and `tools/extractMarketReadings.js --channel benzinga`.
2. Share the sector vocabulary with the Asym parser once that work is committed. Do not
   import from the uncommitted `src/asym/`.
3. Score sector and market readings with ETFs, relative to SPY.

**Exit:** readings stored with their evidence, and a scored summary.

### Phase 6: Aggregation, scoring, dashboard, docs

1. Turn the aggregator, outcome and report code into shared modules parameterized by the
   registry. `tools/{aggregate,analyze}Benzinga*.js` become thin wrappers, and the outputs
   go to `data/benzinga_*` (gitignored).
2. Score outcomes per show, partner, bias and category, with the optional same-day horizon.
3. Build the dashboard: show and partner filters, expandable evidence, and a readings panel.
4. Add `benzinga:*` npm scripts, plus README and CLAUDE.md sections covering the gating
   rule, the Deepgram budget rule, partner correlation and the earnings-call quarantine.

**Exit:** one command chain rebuilds the dashboard from the catalog.

### Phase 7: Optional

- An earnings and FOMC calendar built from titles alone (zero transcription).
- Cross-channel duplicate detection with the timing-free transcript checksum (T3Live vs
  Benzinga).
- Podcast RSS audio for old caption-less PreMarket Prep episodes.
- Deepgram diarization, to attribute calls in multi-host shows to the right speaker.

### Rough effort

| phase | code effort |
|---|---|
| 0 | 1–2 days |
| 1–2 | 1–2 days, plus network time |
| 3 | 1 day for the pilot, plus a caption campaign bounded by YouTube throttling |
| 4 | 3–4 days |
| 5 | 2–3 days |
| 6 | about 2 days |

That is about 2–3 weeks of code in total. Wall time depends mostly on rate limits and the
Deepgram budget.

---

## Part 5: What the pilot measured (2026-11-12)

The pilot was 35 videos, spread across the shows and the eras (2014 → 2026),
dated with `fill-dates` and transcribed through the chunk runner.

| | |
|---|---|
| transcripts fetched from YouTube captions | **34 of 35** (one caption-less) |
| transcript size | 2,000–7,600 segments per hour-long episode |
| signals | 81 from 29 videos, 32 tickers |
| market and sector readings | 130 from 36 videos |
| scored claims | 42 — 1w hit 50.0 %, same-call-on-SPY 58.3 %, excess −0.27 % [−2.51 %, +1.98 %] |

**THE CEILING IS THE SPOKEN TICKERS.** Measured per show (`npm run
benzinga:survey`):

| show | segments | segments naming a ticker | share |
|---|---|---|---|
| The Drift | 73,222 | 1,805 | **2.5 %** |
| PreMarket Playbook | 19,496 | 682 | **3.5 %** |
| long-form commentary | 12,343 | 567 | 4.6 % |
| a market-update clip | 121 | 23 | 19.0 % |

A Drift episode has ~4,000 segments and only ~2.5 % of them name a ticker:
the host says "I'm buying here" and the ticker is on the screen, not in the
words. **No vocabulary work raises that ceiling** — it is a property of a
chart-driven live show.

The 2014–2020 PreMarket Prep era is worse: those hosts name companies in
words ("Neri", "Apple"), so the tickers come from the confirmed-names table.
One pilot episode ("Merger Monday Is Back", 4,100 segments) has **zero**
ticker segments and yields nothing.

**WHAT WAS FIXED AS A RESULT OF THE PILOT**, each one measured:

| defect | how it showed | the fix |
|---|---|---|
| an analyst's opinion was published as the host's call | "Wedbush's Dan Ives remains very bullish on Tesla" → bullish TSLA at confidence 0.83 | the attribution tag (`reported`), with the first-person check so the host's own "I remain bullish" is untouched |
| selling puts was published as bearish | "I'm going to sell some puts" → bearish CRWV | the options direction table, with the option word required to be NEXT to the verb ("I sold calls on NVDA to finance the put" is a call sale) |
| the indicator was published as a holding | "DMA. Held it on a bounce and is running." → DMA | `src/benzinga/symbols.js`: the indicators, and the index futures (ES, NQ, …) which are market positions and not holdings |
| a broker's own name was a call on the broker | "Morgan Stanley raised its price target…" → MS | the broker check; the row is tagged `reported` |
| a reading's stance came from the wrong clause | "We'll see what happens on General Electric today… Let's get to some other stocks" → bearish Consumer Staples | the stance is the direction word NEAR the subject, and the words AFTER the subject are preferred (English puts the predicate after its subject) |
| a question was a claim | "What's the most overvalued stock in the S&P 500?" → bearish S&P | a caption with a `?` produces no reading |
| a quoted opinion was the host's | "all the headlines say, 'Oh, rates crashed the market'" → the host's bearish call | the quote check — and the straight quote is counted separately from the curly one, or every straight-quoted sentence looks closed |
| a recap was a prediction | yesterday's review → a forward call | the section tagger; a recap is `retrospective` |

**THE READINGS' PRECISION IS ~65 %, NOT T3Live's.** Hand-labelled on two
random samples of 20: 12/20 and 13/20. The residual errors are the rolling
caption itself — a caption holds the tail of one thought and the head of the
next, so the subject and the stance are often in different clauses ("The
Nasdaq is definitely not as weak as the S&P" reads as bearish). It is reported
with its evidence on every row, and it is a NEW artifact with nothing to
compare it against, so the bar for it is the user's call.

## Part 6: Risks

| risk | mitigation |
|---|---|
| news-style speech yields reported opinions as calls | attribution guard; score only `forward`; a labelled sample |
| options talk is misread | options direction rules and tests |
| more than half the streams are not commentary | allow-list gate; quarantined ids reported |
| the downloaders pick Benzinga rows | Phase 0.1, before any catalog import |
| Czech Deepgram model run on English audio | Phase 0.2 |
| rate limits at this scale | flat listings, selective dating, the chunk runner, no concurrent jobs |
| Deepgram cost | a budget derived from the pilot; allow-listed videos only |
| repository growth | storage decision after the pilot |
| claims correlated with T3Live's | partner tag; scoring per partner |
| microcap price gaps (delisted symbols) | `price_status` is already recorded; report coverage per show |
| other agents writing the shared `state.sqlite` | commit catalog changes promptly; never run alongside another writer; schema edits after Asym lands |
| shared English rule changes move T3Live's numbers | measure and record the blast radius of each change (project rule) |

## Part 7: Decisions taken, and decisions still open

**TAKEN (2026-11-11, by the user).**

| decision | answer | what it means in the code |
|---|---|---|
| the allow-list | **agreed** | PreMarket Playbook/Prep, The Drift, setup clips and explainers; market-update clips feed the readings only; everything else is quarantined (`src/benzinga/contentFilter.js`) |
| the Deepgram budget | **consider unlimited** | the budget is not a gate in the code; what IS a gate is the caption-less list, which only ever grows by YouTube's own answer |
| transcript storage | **track JSON only** | the VTTs of the Benzinga corpus are NOT committed; the normalised JSON is. The VTTs are re-fetchable, the JSON is the artifact |
| refactor first? | **no need — the T3Live pattern is fine** | so the shared runner was NOT a big rewrite of the two extractors. It was, however, needed for correctness: the two copies had drifted (the Sevcik one never replaced a video's rows when the new run found none, so 8 rows from a superseded parser survived on 4 videos), and both now share `src/transcript/extractRunner.js` |
| the precision bar | **comparable to T3Live, to be seen** | the pilot's measured numbers are in Part 5. The SIGNALS are close; the READINGS are ~65 % and are a new artifact with nothing to compare against |

**STILL OPEN.**

1. **The scale.** The catalog holds 12,786 Benzinga videos, 9,302 of them on
   the allow-list. Transcribing all of them is ~9,000 hours of video, and the
   transcripts alone would add ~1 GB to a repository whose tracked transcripts
   are already 970 MB. The pilot's 34 transcripts covered 2014–2026 and showed
   97 % caption coverage, so the cost is bandwidth and Deepgram budget rather
   than captions. **Recommendation: the two shows (PreMarket Playbook, The
   Drift) plus the setup clips, and the long-form commentary only back to
   2024.** That is ~3,000 videos and ~2,500 hours.
2. **The precision bar for the READINGS** (currently ~65 % hand-labelled).
   Options: publish them as they are, with the evidence on every row; publish
   only the ones from the two talk shows; or publish only the ones whose
   subject and stance are in the same clause.
3. **The confirmed-names table.** The 2014–2020 era speaks tickers as company
   names ("Neri", "Apple"), and those names have to be confirmed one at a
   time — the same work `npm run t3live:names` did for T3Live.
   **Decided by the user (2026-11-13): the 2014–2020 era waits until the
   names table exists.** The survey that grows it is built
   (`tools/surveyBenzingaNames.js`); what is left is reading its rows and
   confirming them one at a time.

---

## Part 8: What the corpus was NOT ready for (2026-11-13)

The scale decision above was the obvious one, and the measurements turned up
two things that were **not** about scale.

### 1. THE CORPUS WAS NOT PLACED IN TIME

`upload_date` is the **event date**, so an undated video cannot be scored.
The flat listing carries no dates, and **12,751 of the 12,786 rows had
none** — so the outcome analysis had 42 claims to work with.

`tools/surveyBenzingaDates.js` measured what can be dated for free: **2,170
rows carry the air date in the TITLE**, and where a title date and a fetched
date both exist they agree (3 of 3). `tools/buildBenzingaDateList.js` builds
the work list **in the order that matters** — the shows that carry calls
first (4,206 rows), then the long-form commentary, and never the quarantine,
because a metadata request on an earnings call the pipeline will not read is
waste. Wave 1 (the two shows and the setup clips) is dated: **4,200 of
4,206**, one still missing.

### 2. FOUR CONFIRMED NAME ROWS WERE WRONG, AND EACH PUBLISHED A WRONG HOLDING

This is the more serious one, and it was **not** in the Benzinga corpus at
all — it was in the shared table, corrupting three sources. The Benzinga
names survey exposed it, and the fix touches T3Live and Sevcik too.

| spoken | was | the registrant it pointed at | is |
|---|---|---|---|
| `goldman sachs` / `goldman` / `sachs` | `GJS` | *STRATS(SM) Trust for Goldman Sachs Group Securities* | **`GS`** |
| `iron` | `IRHO` | *Iron Horse Acquisition II Corp.* — a $10 SPAC | **`IREN`** |
| `rocket` | `RCKT` | *Rocket Pharmaceuticals* | **`RKLB`** |
| `maria` / `mario` / `mary` / `marie` | `MARA` | *MARA Holdings* — via the **Czech stemmer** | **nothing** |

**143 published signals** carried a wrong ticker before the fix. The full
analysis — the three different mechanisms, the evidence that "Iron" is
IREN, and the phrase-collision rule that "iron condor" needs — is in
CLAUDE.md § *FOUR CONFIRMED ROWS WERE WRONG*.

**The lesson is about the TABLE, not the rows.** A confirmed row is a
claim, and a claim cannot be audited by reading it: two of the four had
notes that looked checked, and the fourth corrupts a *different* spoken
form through a row that is itself correct. So there are now two tools —
`tools/auditConfirmedNames.js` (the registrant-level heuristics) and
`tools/surveyBenzingaNames.js` (what the corpus actually resolved) — and
the survey is the one that found the damage.

### 3. THE EXTRACTOR WROTE EVERY ROW UNDER THE WRONG VERSION

The shared engine stamped its own `sevcik-signals-N` constant on every row,
so the T3Live and Benzinga rows were labelled as Sevcik's. That is not
cosmetic: the shared runner's purge deletes the rows of a superseded
version, so **a mislabelled row is a row the purge cannot see**. 6,953 T3Live
rows were labelled `sevcik-signals-6`.

The engine now takes the version from its caller. Pinned by
`test/signalParserVersion.test.js`.

---

## Appendix A: Evidence and how to reproduce

```bash
# Channel sample: flat listing, newest 150 per tab, no per-video requests
py -3 -m yt_dlp --flat-playlist --skip-download --playlist-items 1-150 \
  --extractor-args "youtubetab:approximate_date" \
  --print $'%(id)s\t%(upload_date)s\t%(duration)s\t%(live_status)s\t%(title)s' \
  "https://www.youtube.com/@Benzinga/streams"        # and /videos

# Caption tracks (watch page; not the throttled timedtext endpoint)
py -3 -m yt_dlp --skip-download --list-subs --js-runtimes node \
  --extractor-args "youtube:player_client=visios" \
  "https://www.youtube.com/watch?v=gcAqTxtRfew"       # also HfANy7eb45A, Tayerv35Gs8, rxiungRVoEQ

# Downloader queues (read-only): what the unscoped queries would pick first
SELECT channel, COUNT(*) FROM (SELECT channel FROM videos
  WHERE status IN ('pending','error','downloading')
  ORDER BY upload_date ASC, video_id ASC LIMIT 30) GROUP BY channel;   -- t3live 30
```

The extractor probe called `extractSignals()` with T3Live's options
(`requireCapsSymbols: true`, `symbolStoplist: ENGLISH_SYMBOL_STOPLIST`,
`nameFinderFn: findEnglishCompanyNames`, the lexicon from `loadSevcikLexicon()`) on
three-segment synthetic transcripts. It opened no database.

## Appendix B: External sources (show history)

- Apple Podcasts, *PreMarket Prep*: https://podcasts.apple.com/us/podcast/premarket-prep/id915782694
- RedCircle, *PreMarket Prep*: https://redcircle.com/shows/premarket-prep
- YouTube, the *PreMarket Prep* playlist: https://www.youtube.com/playlist?list=PL4k0fH8EgI3ZX4yrUdNwBpxHNqOUOHzpv
- Benzinga, "Briefing With Brent" on PreMarket Prep Plus: https://www.benzinga.com/trading-ideas/21/11/23802706/briefing-with-brent-launches-on-benzingas-premarket-prep-plus-show
