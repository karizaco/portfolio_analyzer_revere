# Portfolio Analyzer — Qullamaggie + Revere OCR Pipeline

OCR-powered pipeline that crawls YouTube channels (Qullamaggie, Revere), extracts
position/ticker data from video frames, normalizes tickers, and produces portfolio
analytics.

Stack: Node.js + Python (yt-dlp/ffmpeg) + SQLite + EasyOCR + Tesseract OCR + sharp.

---

## YouTube Download: `visios` client (CRITICAL)

Bot protection blocks the `tv` client even with valid cookies — it returns "Video unavailable" for ALL videos. The `visios` (visionOS API) client bypasses this.

**Always use these flags together:**
```bash
--extractor-args "youtube:player_client=visios" --js-runtimes node
```

| Client | Result |
|--------|--------|
| `tv` | "Video unavailable" — bot blocked |
| `android` | SABR-only formats, no MP4 streams |
| `web_safari` | "Video unavailable" — bot blocked |
| `visios` + `--js-runtimes node` | **Works** |

**Never assume a video is truly unavailable** just because yt-dlp returns "Video unavailable" — switch to `visios` before concluding a video is gone.

**Cookie refresh**: SID and __Secure-3PSID are long-lived (~2 years). SIDCC/__Secure-1PSIDTS expire same-day and are not needed for download. When cookies fail, export fresh ones from Firefox Cookie-Editor.

### SABR blocking

YouTube's SABR-only streaming blocks yt-dlp on some videos. Error looks like:
```
WARNING: [youtube] VIDEO_ID: Some android client https formats have been skipped as they are missing a URL.
```
Fix: `visios` client handles this correctly. Do not use `android` client for QMG videos.

### Rate-limiting

Running too many yt-dlp requests rapidly (catalog refresh, batch downloads) triggers YouTube rate-limiting:

```
ERROR: [youtube] VIDEO_ID: This content isn't available, try again later.
The current session has been rate-limited by YouTube for up to an hour.
```

- **Catalog refresh** is the biggest offender — one yt-dlp invocation per video with no built-in delay.
- **Batch downloads** with `--limit 200` are safer because each download takes 20–60s, naturally spacing requests.
- If rate-limited: **stop all YouTube activity for 30–60 minutes** before retrying.
- Do NOT run catalog refresh and batch downloads concurrently — they compete for the same rate-limit budget.
- The `--sleep-requests` yt-dlp flag does NOT help for catalog refresh (separate invocation per video).

---

## Quick Start

```bash
npm install

# Initialize SQLite schema
node tools/whiteboard_worker.py init

# Catalog Qullamaggie channel
python tools/whiteboard_worker.py catalog \
  --channel qullamaggie \
  --source-url https://www.youtube.com/@Qullamaggie/videos

# Download QMG videos at 1080p
node tools/downloadQmg1080p.js --cookies youtube_cookies.txt --limit 200

# Run OCR on downloaded videos (EasyOCR recommended)
OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 KMP_DUPLICATE_LIB_OK=TRUE node tools/scanVideoWithOcr.js \
  --video-dir data/video_pipeline/downloads_1080p/ \
  --prefilter-profile chart_stream --chart-stream-parser \
  --basename qmg --output-kind snapshot \
  --ocr-engine easyocr

# Aggregate results
node tools/aggregateScanResults.js data/video_scan_YYYYMMDD/
```

---

## Qullamaggie Chart-Stream OCR

Qullamaggie's live trading sessions show a **position-list overlay** in the bottom-right corner — a small table listing open positions with ticker symbols and price/percent data. This is fundamentally different from Revere's whiteboard slides.

### Architecture

- **Parser**: `src/parse/parseChartStream.js` — extracts ticker symbols from raw OCR text using two signals:
  1. **Lexicon membership** — ticker appears in `config/ticker_lexicon_seed.csv`
  2. **Price-nearby** — ticker appears within 12 characters of a price token (`$`, decimal number, `HIGH/LOW/CLOSE/TARGET/STOP/BID/ASK`, or `+/-value%`)

- **OCR pipeline**: `src/ocr/easyocrAdapter.js` (EasyOCR, recommended) or `src/ocr/ocrImage.js` (Tesseract, legacy). EasyOCR crops from the original source video, scales the era-specific position-list region 5×, then runs the CNN. The crop width is measured at runtime; do not hardcode it.

- **Scanner**: `tools/scanVideoWithOcr.js` uses `--prefilter-profile chart_stream` and `--chart-stream-parser`. The default chart-stream crop is selected from the upload date by `src/video/chartStreamCrop.js` (see below).

### Current Crop Region

```
{x: 0.86, y: 0.60, w: 0.14, h: 0.28}   ← 2022-era layout — floating bottom-right panel
{x: 0.82, y: 0.60, w: 0.18, h: 0.32}   ← 2023-era layout — table docked to the right edge
```

The crop targets the position-list column specifically (not the chart area). It is **era-conditional** — Qullamaggie moved the position list from a floating bottom-right panel to a right-docked table between 2023-01-26 and 2023-05-18 — and both rectangles live in `src/video/chartStreamCrop.js`, which is the single source of truth. EasyOCR is used with this crop for ~75% recall on 20220606 vs ~25% with Tesseract on the old wider crop.

### Cluster canonical rules

The chart-stream scan produces two readings: each capture's `position_list`, and the video-level `merged_position_list` formed by clustering all OCR candidate frames. The options below affect the **video-level merge only**; they do not make EasyOCR read a missed ticker. The current default is **`corroborated`**, in both the scan tool and the QMG batch runner.

A cluster may publish a lexicon ticker exactly read by the video, or a corrected canonical inferred from a garbled token. The `corroborated` rule rejects a corrected canonical unless it is within edit distance 1 of a cluster member (or is corroborated by the video's own reading under the non-strict rule). This prevents the clusterer from inventing a holding such as `AAPL` when no frame read it. It is a precision filter, not a recall mechanism.

| Named rule | Meaning | Scan flags | Batch/replay selection |
| --- | --- | --- | --- |
| `corroborated` | **Default**; require distance-1 corroboration | no extra flag | `--cluster-rule corroborated` |
| `shipped` | Pre-2026-11-03 behavior; corroboration off | `--no-cluster-corroboration` | `--cluster-rule shipped` |
| `corroborated-strict` | Corroboration by proximity only; video support does not count | `--cluster-strict-corroboration` | `--cluster-rule corroborated-strict` |
| `supported` | Prefer a canonical the video read when equally close; no corroboration gate | `--cluster-supported --no-cluster-corroboration` | `--cluster-rule supported` |
| `supported+corroborated` | Supported tie-break plus corroboration | `--cluster-supported` | `--cluster-rule supported+corroborated` |
| `video-supported` | Prefer video support regardless of edit distance; no gate | `--cluster-video-supported --no-cluster-corroboration` | `--cluster-rule video-supported` |
| `video-supported+corroborated` | Video-supported selection plus corroboration | `--cluster-video-supported` | `--cluster-rule video-supported+corroborated` |
| `swallowed` | Also publish another lexicon ticker in a cluster when independently read often enough; no gate | `--cluster-swallowed-holdings --no-cluster-corroboration` | `--cluster-rule swallowed` |
| `corroborated+swallowed` | Swallowed-holding guard plus corroboration | `--cluster-swallowed-holdings` | `--cluster-rule corroborated+swallowed` |

The scanner's `--cluster-min-frequency <n>` setting controls the minimum number of distinct OCR frames that must contribute a canonical to the merge; its default is **2**, while `1` permits single-frame garbles. This is separate from the corroboration rule: frequency controls voting, while corroboration checks whether an inferred correction has evidence.

The swallowed-holding option uses `--cluster-swallowed-min-frames <n>`, default **4**. It publishes the additional ticker only when that ticker was read in at least `n` of its own frames. This option is **off by default**; the measured threshold 4–7 gained two holdings without adding a false positive, but it has not replaced the default in production. The supported and video-supported variants are also opt-in because corpus measurements added false positives.

For direct scans, `--cluster-corroboration` explicitly enables the default gate and `--no-cluster-corroboration` explicitly disables it. The option is tri-state internally: omitted means the current default, while the negative flag means explicitly off. Probe logs record the resolved `cluster_rule` and component flags, so results remain auditable. The batch runner defaults to `corroborated`; pass `--cluster-rule shipped` only when reproducing historical output.

The replay tool accepts the same nine names with `node tools/evalParserReplay.js --cluster-rule <name>`. Run `node tools/scanVideoWithOcr.js --help` for the complete scan-tool option list. Every EasyOCR command must include `--low-cpu` when using the batch runner or a low-CPU environment.

### Resolution Requirements

| Resolution | Result |
|---|---|
| 1080p (1920×1080) | ✅ Works — mean recall ~57–70% |
| 720p | ⚠️ Marginal — significantly worse |
| 360p | ❌ Completely unusable |

**Must use 1080p source** for QMG chart-stream OCR. The 360p default download will not work.

### Ground Truth Test Set

Human-verified tickers for QMG snapshots are in `data/qmg_ground_truth.json`. The file contains 42 dated entries. Always verify GT against the actual video content before trusting recall numbers — some entries (e.g. 20220510) were recorded with incorrect assumptions.

### Portable remote benchmark kit

For low-resource remote runners, use the portable curated benchmark instead of a
full video sweep. It uses the repo's Tesseract path only and requires a small
out-of-band snapshot bundle rather than the full scan directories.

Required curated 1080p snapshots:

- `qmg_20220218_2.png`
- `qmg_20220606_2.png`
- `qmg_20221104_3.png`
- `qmg_20230609_3.png`

Run:

```bash
npm run qmg:benchmark:curated -- --snapshot-root /path/to/qmg-curated-snapshots
```

Artifacts are written to `artifacts/qmg_ocr_remote/` as:

- `REPORT.txt`
- `benchmark_results.json`

The command exits early if the snapshot root is missing or if any curated PNG is
absent, so remote runs fail clearly rather than silently falling back to the
wrong artifact set.

### Known OCR Failure Modes

These are **character-level confusions** from the overlay font:

| Ticker | OCR Reads As |
|--------|-------------|
| UCO | BUCO, LUCO |
| VLO | VIO |
| ALB | AB |
| YINN | *(missed entirely)* |
| PDD | *(missed entirely)* |
| OIH | *(missed entirely)* |
| CBIO | *(missed entirely)* |

The overlay font makes `I`, `O`, `L`, `U`, `B`, `V` easy to confuse. Fix approaches:
1. **Post-OCR edit-distance correction** — Levenshtein ≤2 against seed lexicon
2. **Larger fallback lexicon** — `config/ticker_sp500.csv` (505 symbols) catches more

### Negate Preprocessing

`negate()` (white-on-dark → black-on-white) gave **+13pp** OCR confidence improvement on dark-overlay frames. On well-lit 1080p snapshots, negate makes zero difference — both produce identical output. Keep it enabled; it helps on darker frames.

---

## Revere Whiteboard OCR

Revere videos show structured **whiteboard slides** (GRO/TURBO portfolios, DMI, Tale of the Tape) — fundamentally different from QMG's chart-stream overlay.

### Architecture

- **Parser**: `src/parse/parseWhiteboardScreenshot.js` — parses GRO/TURBO structured fields
- **Scanner**: `tools/scanVideoWithOcr.js` with `--prefilter-profile whiteboard`
- **Classifier**: `src/normalize/videoTypeClassifier.js` — categorizes videos as `daily` / `weekend_review` / `feature` / `live_update`

### Video Type Classification

| Kind | Detection | Treatment |
|------|-----------|-----------|
| `daily` | Tue-Fri upload, date prefix or DMI/ToTT keywords | Primary signal: per-day timeline rollup |
| `weekend_review` | Weekend upload, non-LIVE title | Weekly context only |
| `feature` | All-caps / sector-themed title | Ticker union only, no daily rollup |
| `live_update` | Title carries `LIVE`, `MIDDAY`, `PRE-MARKET` | Short chatter, often no captures |

### Resolution: 720p Recommended

| Resolution | OCR Confidence | File Size | Recommendation |
|---|---|---|---|
| 360p | 38 | ~50 MB | ❌ Too coarse for dense slides |
| **720p** | **64** | ~55 MB | ✅ Best trade-off |
| 1080p | 66 | ~114 MB | ⚠️ Marginal gain (+2pp) over 720p |

720p is recommended for Revere. Download via `tools/downloadHiresBatch.js`.

---

## Sevcik Prediction Streams (transcript source)

A fourth data source, and the **first one that is not an OCR source**: the
**Sevcik** channel (`https://www.youtube.com/@davidsevcik-sved4697/streams`),
whose daily stream videos carry **spoken** trade commentary rather than an
on-screen position list.

The QMG and Revere paths read **pixels**. This one reads **words**. It reuses
the catalog, the YouTube downloader and the same SQLite database, and adds a
transcript acquisition step, a signal extraction layer and a report.

### The channel is CZECH — and it is read in Czech

Sevcik streams in Czech, and the pipeline reads it **in Czech**. YouTube
publishes two subtitle tracks for the videos:

| track | what it is | why it is used |
|---|---|---|
| `cs-orig` | the original Czech | **the one that is read** |
| `en` | YouTube's **machine translation** | not used |

An earlier version read the English machine translation, on the reasoning
that the extractor understood English trading vocabulary. Measured on the
corpus, that was wrong: the English patterns fired on **nothing** — 0 bias
segments, 0 horizon segments, and 2 signals from 12 videos — because the
speaker says company **names** ("Tesla", "Apple", "Amazon") rather than
symbols, and because *bullish*, *target* and *stop loss* do not appear in
Czech speech.

So the vocabulary is Czech, and it is measured rather than guessed:

| what he says | segments | what it states |
|---|---|---|
| *do Longu* / *do Long* | 89 | **the direction** — the dominant construction |
| *do shortu* / *do Short* | 49 | the bearish construction |
| *poklesový kanál* | 62 | a falling channel — the direction is in the slope |
| *kanál* | 384 | **the level** — and the thing he calls a setup |
| *odraz* | 125 | the bounce off a level |
| *podmíněný* | 14 | the conditional call |

**There are no targets and no stops in this channel.** *cíl* (target)
appears twice and both are a goal, not a price; *stop* appears 15 times and
13 of them are inside *stoprocentně* ("one hundred percent"). The price
roles are therefore **levels** — which is what he actually says, and what
his setups are built on.

The language that was actually used is recorded in
`video_transcripts.language`, so a reader always knows.

### The provider order

| # | provider | cost | when it is used |
|---|---|---|---|
| 1 | **YouTube auto-captions** | free, no key, no upload | always tried first |
| 2 | **Deepgram** | needs `DEEPGRAM_API_KEY`, uploads the audio | the fallback |

Captions are tried first **even when a Deepgram key is configured** — they
are free and instant. Deepgram is the only way to reach videos that carry no
captions at all, and it is the only part of this pipeline that needs a
credential.

The provider that produced a transcript is recorded in
`video_transcripts.provider`, because the two are not equally trustworthy,
and the language is recorded in `video_transcripts.language`, so a reader
always knows what they are looking at.

**The Deepgram `language` is an ACOUSTIC MODEL, not a hint.** Pointing the
wrong one at Czech audio does not produce a worse transcript — it produces
**no transcript**: on one real 50-minute stream, `language=en` returned 15
segments of isolated words and `language=cs` returned 881 segments of full
sentences. The default is `cs`, and the parameter is read at call time so a
`DEEPGRAM_LANGUAGE` in `.env` actually reaches the request.

### The extraction is deterministic

Every rule is a claim about English trading language, and they all live in
one file — [`src/sevcik/signalPatterns.js`](src/sevcik/signalPatterns.js).
The same transcript always produces the same signals.

The rules are deliberately **conservative**:

- a signal needs a **ticker** — *"I am bullish"* is a mood, not a call
- a price needs a **role** — a bare number is not an entry level unless
  something said *entry*, *buy at* or *target*
- a common English word is not a ticker unless it is written in **CAPS**
  (`ON`, `BE`, `ARM` and `NET` are real tickers *and* everyday words)
- a **negation reverses** the direction — *"not bullish"* is bearish
- a **history** is not a call, and a **disclaimer** is not a call

Every signal carries the **exact transcript text** it was read from. A
signal without its evidence cannot be checked against its source, and an
unchecked claim in a portfolio report is worth nothing.

### SETUPS — what he is talking about, and how sure he is

A **setup** is not a signal. The speaker does not disclose positions; he
describes **setups** and **ideas** — *"if it holds this level, long"*. A
signal is a trade-shaped sentence; a setup is the **thing** he is talking
about, which may run for ten minutes, be revisited, and end up worked,
failed, or invalidated.

The lifecycle is read off his own words:

| state | the words |
|---|---|
| `new` | "mám tady novou predikci" |
| `running` | "predikce běží" — still live |
| `worked` | "predikce vyšla" |
| `failed` | "predikce nevyšla" |
| `invalidated` | "predikce zneplatněna" |
| `old` | "byla stará" |

**"Still running" means still live at the END of the video**, not "ran at
some point". A setup that ran and was then finished — *"predikce běží"*
followed by *"predikce vyšla"* — is not live any more, and the
setup's final state is the one the speaker last asserted about it.

The **certainty** is a separate scale, and it is built from what he
**actually says** — he never says "high conviction":

| level | the words | count |
|---|---|---|
| `certain` | "stoprocentně", "jistota" | 10 + 3 |
| `high` | "velmi silný signál", "silnější" | 26 + 6 |
| `conditional` | "podmíněný" | 14 |
| `even` | "50 na 50", "patová" | 14 + 2 |
| `low` | "nevím", "pravděpodobně", "asi" | 95 + 45 + 49 |
| `unknown` | — | — |

Three findings, all measured over the corpus:

- **"Jasný" alone is not certainty.** It appears 68 times and **66 of them
  are the filler "Jasně!"** — "Of course!" — in chat replies. It counts
  only next to the trading vocabulary: "jasný signál".
- **A negated "stoprocentně" is not certainty.** He says it 10 times, and 9
  are in a sentence that *denies* it: *"Není to žádná stoprocentní jistota,
  nikdy to nebyla. Je to jenom počítání pravděpodobnosti."*
- **"Podmíněný" is its own level**, not a point between "high" and "low". It
  is his **default** form for a live setup, not an apology for a weak one.

### The transcript is cut into runs, one per ticker

A name owns the speech that **follows** it, until the next name:

```text
"Let's talk about Tesla, TSLA. I am going to buy TSLA at 240, my target
 is 280. The stop loss is 225. Now for Nvidia, NVDA. I am bearish on it.
 The target is 120."

TSLA  "Let's talk about Tesla, TSLA. I am going to buy TSLA at 240,
       my target is 280. The stop loss is 225."
NVDA  "Now for Nvidia, NVDA. I am bearish on it. The target is 120."
```

A fixed window around each mention was tried first and it was **wrong**: a
window spans the move from one name to the next, so the TSLA row carried
NVDA's price, the TSLA *stop* was labelled a *target*, and `short` bled onto
a ticker that was only being watched. A wrong price on a real holding is
worse than a missing one, so the run model replaced it.

A run is also **split where the speaker changed his mind**, so "I am
bullish on TSLA" followed by "actually I am going to short TSLA" is two
calls at two moments rather than one "mixed" row.

### Running it

```bash
# 1. Catalog the channel (the streams tab, not the videos tab)
npm run sevcik:catalog

# 2. Fetch transcripts (captions first, Deepgram as the fallback)
npm run sevcik:transcripts -- --limit 5

# 3. Extract the trade signals
npm run sevcik:signals

# 4. Aggregate and build the dashboard
npm run sevcik:aggregate
```

Outputs land in `data/`:

| file | what it is |
|---|---|
| `sevcik_signals.csv` | every signal, with its evidence |
| `sevcik_daily_summary.csv` | one row per stream |
| `sevcik_ticker_summary.csv` | one row per ticker |
| `sevcik_setups.csv` | every setup, with its lifecycle and its evidence |
| `sevcik_setup_daily_summary.csv` | one row per stream — how many setups, and what became of them |
| `sevcik_setup_ticker_summary.csv` | one row per ticker — how this source has talked about this name |
| `sevcik_signals.json` | the same, for the dashboard |
| `sevcik_report.html` | the dashboard — open it in a browser |

The dashboard is **one self-contained file**: no CDN, no network, no build
step. Every signal row expands to the transcript text it came from.

### Configuration

| variable | what it does |
|---|---|
| `DEEPGRAM_API_KEY` | enables the Deepgram fallback |
| `DEEPGRAM_MODEL` | the model to use (default `nova-2`) |
| `DEEPGRAM_LANGUAGE` | the language hint (default `en`) |
| `YOUTUBE_COOKIES` | a cookie file, for the audio download |

The API key is read from the environment only. It is never written to a
file, never logged, and never included in an error message — the error text
goes into a log that gets committed.

> **The audio upload leaves the machine.** Deepgram is a hosted service, so
> a stream's audio is uploaded to be transcribed. That is a deliberate
> consequence of using one, and it is worth being explicit about.

### Known friction: the subtitle endpoint throttles hard

The subtitle endpoint answers `HTTP Error 429: Too Many Requests` far more
readily than the video endpoint does — it is a lighter endpoint and yt-dlp
hits it once per language. The fetcher **retries with a growing wait**
(`--rate-limit-attempts`, `--rate-limit-wait`), but a persistent 429 means
the IP is throttled and the honest answer is to wait 30–60 minutes, as the
project's YouTube rules say.

---

## T3Live (transcript source, English)

`https://www.youtube.com/@t3live` — the fifth source and the second transcript
source. It reuses the Sevcik pipeline (catalog → captions → signal extractor →
aggregate → outcome scoring); what differs is in `src/t3live/`.

| show (from the title) | host | what it is |
|---|---|---|
| Actionable Swing Trade Ideas | Sami Abusaad | weekly swing calls, 2019-06 → today |
| 630 Club, including the older "6:30 Club" spelling | Scott Redler | daily pre-market |
| Options In Play | unnamed | a 2020 options series, including the weekly "Earnings On The Radar" |
| Morning Call | Scott when the title names him | morning commentary, a different show from the 630 Club |
| Daily Recap | whoever the title names | the house end-of-day format, several hosts, 2011 → today |
| everything else that names a host | Sami, Scott, Derrick, Adam, Michael… | not one of the series above |

Older formats are categories too, even though the shows have ended: Market Wrap,
How-to, Watch List, Pro Desk, Half-Time Report, Mid-Day Update, Red Dog,
Black Room, Marketcast, Situation Report, Core FX, Conversations With A Pro
Trader, Morning Game Plan, Wall Report, and Weekly Market Update. A one-off
title stays `other`.

**Both tabs are needed.** The `/videos` tab (3,629 rows) and the `/streams` tab
(3,720 rows) share only 7 ids. The catalog holds both: **7,349** `t3live` rows.

**Dates.** A flat channel listing carries no upload date, so the bulk import
leaves `upload_date` empty and dating a video is one watch-page request. The
two structured shows and the hosts' other named shows are dated (Actionable
Swings 334, the 630 Club 629 of 630, Scott's other shows 394, Sami's other
shows 158). The remaining ~5,800 rows are recaps and interviews and are not
dated yet.

### Running the T3Live pipeline

```bash
# captions only, one fetch at a time, 40 per chunk, stops on a 429
npm run t3live:transcripts:swings
npm run t3live:transcripts:630club

npm run t3live:signals     # parser t3live-signals-3
npm run t3live:aggregate   # data/t3live_signals*.csv, t3live_signals.json, t3live_report.html
npm run t3live:outcomes    # data/t3live_outcomes.csv, t3live_outcome_summary.json
```

### What is different from Sevcik

- **English names.** `src/t3live/englishNames.js` does not drop a capitalised
  word at a sentence start (the Czech rule). People are not companies
  ("Trump" is not DJT), caption acronyms are not tickers (`AI`, `ATR`, `RSI`,
  `PM`…), and index phrases resolve to their ETF ("the Qs"/"the cues" → QQQ,
  "the S&P" → SPY, "the Russell" → IWM, "the Dow" → DIA).
- **Symbols must be written in capitals.** The auto-captions write a spoken
  ticker in capitals (`IWM`, `BHC`) and words in sentence case, so `for` is
  never FOR.
- **The swing format.** Sami states a trigger and a stop ("long over 525, stop
  under 478"; "short under 158, stop over 178"). The direction is read from
  those, and the prices are recorded: "long over" / "short under" is the
  trigger (`entry_price`) and "stop under" / "stop over" is the stop
  (`stop_price`). "I like it" is only a weak bullish reading because he says
  it about shorts too. A caption that drops the decimal point ("22.80" read as
  "2280") is caught by the stop beside it: a price ten times its own stop is
  not a price.

**Two defects the test runs found, both fixed (2026-11-09).**

*A completed trade is not a live call.* "I'm still in Tesla. Tesla did not
give me a reason to get out of it. ... I used my tier system. I sold some."
was published as a bearish TSLA. The speaker was long and bullish, describing
a tiered exit. 258 signals rested on a past-tense sale as their only
direction evidence, and 144 of those were scored as predictions. Past-tense
forms ("sold", "trimmed") are now recorded as the action but carry no
direction. T3Live's signal count went 3,190 → 2,912; Sevcik is unchanged at
1,444, because the change is English-only.

*The confirmed-names table had no English names.* It was grown from the Czech
corpus, so an English stream resolved almost nothing: across 811 T3Live
transcripts only 19 tickers came back, and 1,357 spoken names were reported
as candidates and dropped. Options In Play produced almost no signals for
exactly this reason. The names are now confirmed from their transcript
context (`surveyT3liveNames` writes the candidates; each row was read before
it was added), and the two-word names — "Goldman Sachs", "Morgan Stanley" —
are matched as pairs rather than as two unrelated words. The sample went from
12 resolved names to 23.

**What the new shows actually say.** Options In Play is educational — it
teaches stops and targets generically rather than calling trades ("upside
targets or downside targets if it's a bearish trade"). Over ten videos it
said "bullish" 24 times and "bearish" 18, mostly describing hypotheticals. It
produces few signals because it contains few calls, and that is the show's
nature rather than a parser gap.

**The measured result (2026-11-10).** 5,588 signals from 1,518 videos, 3,524
claims after merging a video's mentions of one ticker. One-week hit rate
**50.0%** against **56.0%** for the same call made on SPY on the same dates;
the excess return is +0.13% with a 95% interval of [−0.12%, +0.38%], so it is
not distinguishable from zero. One month is 51.7% against 61.0%, excess
+0.39% [−0.12%, +0.90%] — also not distinguishable from zero. The honest
reading is the same as Sevcik's: the source has not been shown to beat the
index, and the sample is now large enough to say so. Per show, Actionable
Swings and the 630 Club are the two series with enough claims to measure, and
both land the same way (1w excess +0.29% and +0.12%, neither significant).
The newly scored shows do not change the reading: Morning Call is +0.31% at
one week and Daily Recap is −0.42%, and both intervals cross zero.

**Deepgram reaches the videos YouTube will not caption.** 237 of the 630 Club
streams have no auto-captions at all. 113 of them have now been transcribed
through Deepgram — 32 in four small batches, 73 in a chunked run, and 8 more
in the 2026-11-10 caption sweep — with 23,127 segments, every one of them
`deepgram / en`. The audio is uploaded to Deepgram for those videos only:
captions are always tried first, because they are free and the audio stays on
the machine. The audio is deleted after each transcript, so only the transcript
is kept.

Two videos came back with no utterances, and both are genuinely silent. One is
a 10-second clip; the other is a 4-minute live stream whose only audio is a
short intro, the rest digital silence. Deepgram's empty answer is the right
one.

The chunked runner's "transcribed" count is **not** the Deepgram count, and
reading it as one overstates the corpus. It counts every video that ended with
a transcript on disk, and a video on the caption-less list can still come back
with captions once YouTube's throttle has lifted — 89 of the 164 in the first
chunked run did. The provider field is the record, and it says 73 for that run.

**A chunk that fetched nothing is not always a throttle.** On 2026-11-10 the
caption runner stopped and reported a possible rate limit on a chunk of 11
videos. They were educational "how to" titles the content filter had already
quarantined, so the fetch tool had no candidates and fetched nothing. The
fetch tool now names the quarantined ids, and the runner sets them aside
instead of reporting a throttle. Pinned by `test/fetchTranscriptChunks.test.js`.

### Rolling caption cues (fixed for every source)

YouTube auto-captions record each state of a scrolling two-line display, so
every line appears twice and the line before a ticker shares its segment.
`collapseRollingCues()` (`src/transcript/transcriptNormalize.js`) undoes this
inside the signal and setup extractors — for T3Live **and** Sevcik's caption
transcripts — and leaves Deepgram transcripts untouched (detected, not
assumed). Stored transcripts are not rewritten; reported segment indices still
point at them.

---

## Troubleshooting

### FFmpeg path missing (`ffmpeg.exe ENOENT`)
On Windows, the Gyan FFmpeg symlink may be broken. Recreate it:
```bash
cd tools && mklink ffmpeg.exe "C:/Users/admin/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe"
```

### Video ID leading underscore
QMG video IDs can start with `_` (e.g. `_9o5_4iZ0zjI`). yt-dlp may truncate these. The download script handles this. If files appear truncated, rename with the full ID and update SQLite.

### Cookie file error (`does not look like a Netscape format`)
Cookie SID/`__Secure-3PSID` expired or malformed. Re-export fresh cookies from Firefox Cookie-Editor.

### Wrong screenshot or timestamp selected
1. Re-run with `--keep-frames` to preserve sampled PNGs under `ocr_probe/frames/`
2. Check the JSON log under `ocr_probe/logs/` — it records `top_candidates`, `captures`, and prefilter scores
3. If the right screen exists but was missed: increase density with `--fps 0.5`
4. If a near-miss was chosen: raise `--strong-threshold`

---

## Common Commands

```bash
# Initialize SQLite
node tools/whiteboard_worker.py init

# Catalog a channel
python tools/whiteboard_worker.py catalog \
  --channel qullamaggie \
  --source-url https://www.youtube.com/@Qullamaggie/videos

# QMG 1080p batch download
node tools/downloadQmg1080p.js --cookies youtube_cookies.txt --limit 200

# Revere 720p batch download
node tools/downloadHiresBatch.js --limit 30 --height 720

# QMG chart-stream OCR (EasyOCR)
OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 KMP_DUPLICATE_LIB_OK=TRUE node tools/scanVideoWithOcr.js \
  --video-dir data/video_pipeline/downloads_1080p/ \
  --prefilter-profile chart_stream --chart-stream-parser \
  --basename qmg --output-kind snapshot \
  --ocr-engine easyocr

# Aggregate scan results
node tools/aggregateScanResults.js data/video_scan_YYYYMMDD/

# Sevcik: catalog, transcribe, extract signals, aggregate
npm run sevcik:catalog
npm run sevcik:transcripts -- --limit 5
npm run sevcik:signals
npm run sevcik:setups
npm run sevcik:aggregate

# Prune old probe directories
node tools/prune_old_probes.js           # dry-run
node tools/prune_old_probes.js --execute # actually delete
```

---

## Data Layout

```
data/
  video_pipeline/
    state.sqlite          # SQLite catalog
    downloads_1080p/      # QMG 1080p videos
    downloads_hires/      # Revere 720p videos
    transcripts/          # Fetched transcripts (one JSON per video)
    audio_sevcik/         # Temporary Sevcik audio, for the Deepgram fallback
  video_scan_YYYYMMDD/    # OCR scan outputs
  video_ocr_probe/       # Temporary probe directories (prune if >10 MB)
  price_cache/yahoo/      # Historical price data
```

**Never infer resolution from filesize.** A 10-minute 1080p video can be under 1 GB. Use `ffprobe` to check actual resolution.

---

## Outputs

- `data/portfolio_snapshots.csv` — canonical extracted snapshot rows
- `data/review_queue.csv` — rows flagged for manual review
- `data/portfolio_actions.csv` — normalized BUY/ADD/SELL/TRIM rows
- `data/position_events.csv` — entry/exit events by portfolio and day
- `data/portfolio_performance_summary.csv` — per-portfolio summary
- `data/portfolio_performance_timeseries.csv` — portfolio timeline
- `data/sevcik_signals.csv` — extracted trade signals, with their evidence
- `data/sevcik_daily_summary.csv` — one row per Sevcik stream
- `data/sevcik_ticker_summary.csv` — one row per ticker
- `data/sevcik_report.html` — the Sevcik dashboard
