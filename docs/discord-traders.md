
## The Discord traders — drendel, ariel-long, ariel-short (2026-11-15)

Two private trading-server channels, ingested with a Discord **user token**
and parsed into position histories. They are the only source here that
states a position with a **size**, and the only one that names its
accounts.

### What each channel IS

| channel | author | what it is |
|---|---|---|
| `drendel` | drendeltrading | **two accounts**, and two kinds of message: a daily "Portfolio" post (a STATE snapshot with weights) and his trade messages (ACTIONS) |
| `ariel-long` | realsimpleariel | her **LONG** book, as trade actions |
| `ariel-short` | realsimpleariel | her **SHORT** book, as trade actions |

The three live in `discord_sources` (ids 10, 11, 12) with 5,515 messages in
`discord_messages`, current to 2026-11-13.

**DRENDEL'S ACCOUNTS (the user's statement, 2026-11-15).** One account for
trading — longs and shorts both — and one other he calls **"Vibe"**. A
position that is NOT listed under "Vibe Account" is in the trading account.
His posts also carry a "Shorts in small account" block (22 posts): by that
rule it is the trading account, and the label is kept as a `sub_account` so
the distinction the post drew is not lost.

**DRENDEL'S "SHORTS" ARE INVERSE PRODUCTS HE BUYS.** His own words:
"Bought AVS (AVGO inverse)", "Short AVGO (Long AVS)". So the P&L of such a
row is the **instrument's own return**, and only a short of a real stock
(APP, CVNA, DASH in the small account) is signed negative. Getting this
wrong inverts the whole trading-account curve.

### Retrieval

`tools/discord_pipeline/import_channel.py <source> <channel_id> <token>
--messages N` pages backwards from the newest message with `before=`, and
inserts into `discord_messages` with `INSERT OR IGNORE`. `last_message_id`
is the watermark, so only new messages are inserted.
`tools/discord_pipeline/fetch_all_history.py` backfills through the
`/messages/search` endpoint. The token is **not** stored anywhere: pass it
in an environment variable, and change the Discord password afterwards
(changing the password invalidates the token; logging out does not).

**A DISCORD USER TOKEN IS A SELF-BOT** and is against Discord's terms. The
README's other paths (a bot token, or a Playwright login) are the compliant
ones; keep the volume low either way.

### The three parsed tables

| table | holds | rebuilt by |
|---|---|---|
| `discord_positions` | one row per (snapshot, account, side, ticker) | `tools/buildDiscordPositions.js` |
| `discord_trade_actions` | one row per (message, ticker) that is an action or a stop update | the same |
| `discord_episodes` | one row per position lifecycle, priced and scored | `tools/buildDiscordPositions.js` + `tools/analyzeDiscordTraders.js` |

They are DERIVED from `discord_messages` and carry `parser_version`
(`discord-traders-1`), so a re-run with a changed parser can be told apart
from the previous one. The messages are never rewritten.

```bash
npm run discord:positions   # messages -> the three tables
npm run discord:analyze     # price the episodes, score them
npm run discord:report      # data/discord_traders.html
```

### The parsing rules, and the traps behind them

- **THE EARLIEST VERB IS THE ACTION.** "Bought 5% SQQQ back at 50.63 (was
  stopped this morning)" is a purchase. A priority order (stop-out first)
  reads it as a stop-out.
- **AN INTENT IS NOT A TRADE.** "Watching OKLO on the short side", "looking
  to add", "will look for adds later" — and a sentence that DESCRIBES a past
  action ("the dip was bought so aggressively") is not a trade either.
- **THE TICKER IS THE SUBJECT OF THE MESSAGE, NOT THE FIRST NAME IN IT.**
  "Bought 4% AAOZ at 9.76 (AAOI failed at resistance gap)" is a trade in
  AAOZ. AAOI is a remark.
- **THE CORPUS'S OWN STOCKS ARE NOT IN THE LEXICON.** TSLL, IONZ, SARK,
  MSTZ, SOXS, SQQQ, GDX, SILJ are not US registrants, so a lexicon-only
  search drops the subject of the trade. They are found by their SLOT
  ("$NVDA short 114.30") or right behind their verb.
- **"BE" IS BLOOM ENERGY AND BREAK-EVEN.** "stop to BE" is break-even;
  "Bought BE" is the stock.
- **A NUMBER IS A PRICE ONLY WHERE A PRICE CAN STAND.** "50sma", "7x ATR",
  "6/20 setup" and "3%" are not prices. A bare integer is a price only
  right after a ticker or a price word.
- **A PERCENT ON A TRIM IS OF THE POSITION**, except where he says otherwise
  ("Trimmed another 1% (of portfolio) of ARM"). Drendel also writes small
  trims in portfolio points without saying so ("Trimmed 4% from MU"); that
  case is marked `ambiguous` and resolved against the position's known size.
- **THE VIBE ACCOUNT HAS NO WEIGHTS.** It is read as an equal-weighted,
  fully invested basket, and that is stated in the output. It is also the
  reason a Vibe position closes by DISAPPEARING from the list and never by
  its weight — reading the missing weight as "closed" makes every Vibe
  position a one-day trade.
- **A POSITION THAT REAPPEARS IS A SECOND TRADE.** He buys it again; the
  two are separate trades.
- **HIS HEADER DATE IS TYPED BY HAND.** It wins within a day of the post's
  own timestamp (he posts at night about the day, and at weekends about the
  Friday before) and loses beyond it. Two posts in the corpus repeat the
  same date; the later one is dated by its own timestamp.

### What the corpus measures, and what it does not

The returns are **MODELLED from daily closes**: entry = the close on the
entry date, exit = the close on the exit date, signed by the direction.
Neither trader publishes fills, so none of it is his or her P&L, and his
entries are made on intraday levels, so a close-to-close model is
conservative about the entry and silent about the exit.

**A SAME-DAY TRADE IS INVISIBLE** to that model (it reads as a flat 0%),
so those trades are counted apart and left out of the hit rate. The
still-open book is marked to the last close and reported apart.

**THE CURVE HAS NO SURVIVORSHIP BIAS.** A position that closed during a
period contributes its move to the day it was closed — not to the period
end, and not nothing. Dropping it (as a snapshot-to-snapshot diff does)
removes exactly the positions that lost money.

### Measured (2026-11-15, closes from Yahoo, 2025-04-10 → 2026-11-13)

| book | episodes | closed | hit rate | avg | avg (capped ±100%) | avg vs SPY | median days |
|---|---|---|---|---|---|---|---|
| Drendel, all | 899 | 805 | **34.5 %** | +1.80 % | +1.30 % | +0.89 % | 7 |
| Ariel, long | 241 | 207 | **58.9 %** | +25.60 % | +12.19 % | +21.65 % | 7 |
| Ariel, short | 165 | 144 | **36.2 %** | −10.77 % | −7.74 % | −9.08 % | 6 |

| account curve | periods | cumulative | vs SPY | hit rate |
|---|---|---|---|---|
| Drendel, trading (weighted, as posted) | 173 | **−21.6 %** | −37.5 % | 48.6 % |
| Drendel, Vibe (equal-weighted) | 156 | **+26.3 %** | +10.7 % | 56.4 % |

So the **Vibe account beat the trading account** over the same window, and
the trading account lost to SPY by a wide margin. The Vibe number rests on
an assumption (equal weights) that the trading account's does not, so it is
the weaker of the two claims — but it is the weaker CLAIM that wins.

**THE RULES, MEASURED.**

- **THE ATR TRIM.** Ariel cites an ATR multiple in 33 of her 914 trims. In
  the LONG book, a trim is a sale, so a good trim is a price that FELL
  after it. The ATR-cited trims were followed by **+4.71 %** at 5 days and
  **+9.33 %** at 20 days — i.e. the names went UP after she sold, so those
  trims were EARLY, not early-exhausted. The other trims: +2.19 % and
  +9.94 %. There is no edge in the ATR citation on this measure.
- **THE STOP.** 742 episodes state a stop; the day's LOW breached it before
  the exit in **64.3 %** of them, and only 133 exited by a stop. The stop
  measured is the one stated at the ENTRY, and he moves stops ("moving stop
  to today's low"), so the breach rate is an upper bound on how often his
  stated stop was not the operative one. A trade whose stop was breached
  returned −3.13 % on average against −1.37 % for one that was not.
- **SIZE.** The biggest positions did the worst: 8 %+ → −3.81 % average and
  a 24.7 % hit rate; under 1 % → −17.26 % on 4 trades.
- **THE TWO TRADERS.** 79 tickers appear in both books. **Ariel entered
  first on 52 of them, Drendel on 22, and 5 on the same day.**

### The gaps, stated rather than hidden

- Ariel's SHORT book loses money on this measure (−10.8 % per closed
  trade). The sign convention is the book's, and the prices are closes.
- The 89 still-open episodes are marked to the last close: Drendel's are
  marked at −32.9 % on average, Ariel's longs at −14.5 % and her shorts at
  +26.2 %.
- 85 actions carry no ticker at all and are kept out of the corpus; 671
  inherit the previous message's ticker and are MARKED as inherited
  (`ticker_inferred`).
- 8 episodes have no price.

## Clement (`clement` / cletibals) — caption ideas (2026-11-22)

Fourth Discord source on the same guild. Messages live in `discord_messages`;
image files stay under gitignored `data/discord_pipeline/media/clement/`.

Parsed layer (captions only): `clement_posts` + `clement_ideas` in
`derived.sqlite`. Rebuild with:

```bash
npm run discord:clement:ideas
```

Parser version: `clement-captions-1`. Daily Market Plan dashboard OCR is deferred;
setup-chart meaning is primarily in the Discord caption.

### Daily Market Plan image layout (human-verified 2026-11-22)

Full notes: `src/discord/clement/LAYOUT.md`.

- **Split the dashboard vertically first** (white gutter between gray left
  cells and the blue/white right tables). Important content is the **left half**.
- **1. Market Trend** — YES/NO checklist (sample day 2026-01-09: all five YES).
- **2. Primary Watchlist** is a **header for left-column theme/focus content**
  (e.g. "Metal Miners, Other Commodities…"), **not** the S&P Sub-Market table.
- **S&P 500 Sub-Market / Sub-Sector** blocks are a separate **market monitor**
  on the **right half**.
- Setup charts: ticker glyph is often gray-on-gray (OCR-hard); black chart
  title carries the name (e.g. "Ethereum / TetherUS…"). Example map for
  2025-08-21 multi-attach: `…0018.png`→ETHUSDT, `…0262.png`→IWM, `…3368.png`→TEM.

## Clement pipeline phases (status)

1. **Captions** — `npm run discord:clement:ideas` → `clement_posts` / `clement_ideas`
2. **Analytics** — `npm run discord:clement:analytics` → watchlist/theme stats
3. **Dashboard OCR (split)** — `npm run discord:clement:ocr-batch`  
   sequential EasyOCR, CPU only, 1 image at a time, resume-safe  
   output: `data/discord_pipeline/media/clement/ocr_split_batch/`
4. **Daily plans from left OCR** — `npm run discord:clement:daily-plans`
5. **Report** — `npm run discord:clement:report`
6. **Chart titles** — `src/discord/clement/chartTitleResolve.js` (name→ticker; gray glyphs skipped)

Dashboard split: white gutter ~42.5% width; left = plan/watchlist, right = S&P monitor.

## Plechac (`plechac`) — a Czech private investor (2026-11-26)

**WHO HE IS.** `petrplechactradecz`, author id `882261479036973126`, in
two channels of the TradeCZ server (guild `917782018992009256`):

| source | channel | what it is | his messages |
|---|---|---|---|
| `plechac-trades` | `977152752838918144` "realizované⋅investice" | what he DID | 266 |
| `plechac-talk` | `928591421500428319` "akcie-a-etf" | what he THINKS | 1,779 |

**BOTH CHANNELS ARE SHARED**, with about forty members each, so the
ingest FILTERS BY AUTHOR. `discord_sources.author_id` says whose messages
the channel is about, and empty means every author — which is what every
other source here is. The filter is also what keeps the catalog small:
2,045 of his messages against the 14,100 in the two channels.

**THE CORPUS.** 2,045 messages, 2025-12-21 → 2026-11-25. The parser
reads **380 actions** and **93 distinct holdings**; the chain gives **84
episodes**.

**TWO BOOKS.** A main book and a "RISKY" one, and the book is a property
of the STATEMENT, not of the message: "Dobírám na risky portfoliu Uber a
Circle | Na hlavním jsem kosmeticky doplnil" puts one name in each. 45 of
his actions are in the risky book, and only five names are risky-only
(ASTS, CAT, CRWV, GRPN, ZETU).

### The parser is his own (`src/discord/plechac/`)

He writes Czech, so the vocabulary is his and the parser is his. Four
rules are not the shared ones:

1. **THE LINE IS THE UNIT, NOT THE MESSAGE.** He writes a message as a
   list of statements, one per line, and a line of names CONTINUES the
   verb above it: "Dobral jsem akcie, které dneska trpí / RollsRoyce /
   Samsung / LEU / BABA" is four purchases.
2. **"BERU" PLUS A PROFIT IS A REDUCTION.** It is his most common verb
   (34 of 233 messages in the trade channel) and it means three things:
   a purchase, a top-up, and taking a profit. **12** messages pair it
   with "zisk" or "profit", and every one of them is a REDUCTION.
   Reading them as buys would publish twelve wrong holdings.
3. **A CLOSE OF A PART IS A TRIM.** "Zavřel jsem trochu Samsung, OXY,
   DELL" closes a part of three positions, and the positions are still
   open afterwards.
4. **`\b` IS ASCII, AND CZECH BREAKS IT.** `\b` after a word ending in
   a diacritic is not a boundary, so `/\bdokup\b/` MATCHES "dokupů" and
   `/\bcelé\b/` NEVER MATCHES. The same defect the Sevcik extractor
   had. Every pattern here uses a Unicode lookaround instead.

A name behind a dash or an ellipsis is not the subject of the trade:
"Zavřel jsem opět trochu B - barrick mining" is a trade in B, and the
name behind the dash says what B is.

### What he does NOT publish

No stops (0 mentions of "stop" or "zastav" in the corpus), no ATR
multiples, and no weights — only qualitative sizes ("trochu", "kousek",
"celé pozice") and nine percentages. So the returns are MODELLED from
closes, like every other source here.

### The names

`config/ticker_names_plechac.csv` is his own confirmed table: the
company names he writes (with their Czech case endings) and the symbols
he writes that are NOT the symbol Yahoo wants (`BRK` → `BRK-B`, `KLA` →
`KLAC`, `CNRL` → `CNQ`, `RR` → `RR.L`, `CSU` → `CSU.TO`). A name that is
not there is left unresolved, and that is how the table grows.

What is NOT a holding, each read in the message it came from: `SAAS`
(Czech "software as a service"), `AI` (the theme, not C3.ai), `IBKR` /
`XTB` / `Bitpanda` / `Alocano` / `eToro` (BROKERS), `MSCI` (an index),
`RISKY` (the book), `METU` (ambiguous: he writes META for Meta Platforms
ten times, and METU is a real leveraged ETF).

### The other two channels, and the portfolio screenshots (2026-11-26)

He writes in four channels of the same shared server, and the ingest
filters by author, so the catalog carries only his messages:

| source | channel | what it is |
|---|---|---|
| `plechac-trades` | 977152752838918144 `realizované investice` | what he actually did — 266 messages |
| `plechac-talk` | 928591421500428319 `akcie-a-etf` | commentary — 1,779 messages |
| `plechac-portfolia` | 1104753899610583050 `portfolia` | **the portfolio state** — 50 messages |
| `plechac-komodity` | 987078000426237982 `komodity` | his commodity trades — 1,783 messages, back to 2022 |

The `komodity` channel reaches back to **2022-06**, two years before the
trades channel starts, and the import's max-id watermark skipped the older
tail: 4,097 messages had to be fetched by hand to reach it.

**THE PORTFOLIO CHANNEL CARRIES THE BROKER'S OWN SCREEN.** He posts
screenshots of his positions, and the image is the record of WHAT the
book holds — the trade channel says what he traded, and a position's
**size** is a thing only the screenshot carries. The images are
downloaded into `data/discord_pipeline/media/<source>/<message_id>/`, and
the row that ties an image to its message is in `discord_attachments`, a
table of its own.

**THE READABLE FORMAT IS THE XTB `POZICE` TABLE**, and it is read
whole: 15 positions, and their weights add up to **exactly 100.00 %** —
which is the table's own `Celkem` row saying so. Two of its columns are
what the trade channel cannot give: the **WEIGHT** (VÁHA) and the
average cost (NÁK. CENA).

Four things had to be right for that reading, and each was measured:

1. **THE HEADER IS LEFT-ALIGNED AND THE NUMBERS ARE RIGHT-ALIGNED.** The
   header words' centres are TICKER 168, KUSY 690, NÁK.CENA 942,
   AKT.CENA 1456, HODNOTA 1762, P&L 2146, P&L % 2413, VÁHA 2612 — and
   the data words' centres are within 50 px of them. A column built from
   the header's LEFT edge drops a number that sits 20 px to the left of
   it, so the anchor is the CENTRE and a value belongs to the NEAREST
   column.
2. **THE BROKER'S MINUS SIGN IS NOT READ.** `"-24,53 $"` comes back as
   `"~24,53 $"` and `"-0,26%"` as `"F0,26%"`, so the SIGN of the P&L is
   taken from the prices and never from the glyph.
3. **THE PRINTED P&L % IS MISREAD** on that very screenshot — three of
   fifteen rows: `"-3,98%"` reads `"73,98%"`, `"131,93%"` reads
   `"4131,93%"` and `"11,19%"` reads `"411,19%"`. So the P&L is
   **DERIVED** from the prices, and the row is CHECKED against its own
   arithmetic (`value = units x price`, `P&L = units x (price - average
   cost)`). A row that does not add up is `unverified` and says so: on
   the measured screenshot the RHM row's average-cost cell holds two
   numbers, so no cost is published for it at all.
4. **THE LOGO IS NOT A TICKER.** Every row carries a round company logo
   to the left of the ticker, and a logo is a picture, so the ticker is
   taken from the column the header defines.

**THE VENDOR WRITES THE EXCHANGE, AND YAHOO WRITES ITS OWN NAME FOR IT.**
The broker's screen says `RHM XETRA`, `IDUS.LSE`, `MC.PA`, `EVO.ST`,
`IGLN.UK`; Yahoo says `RHM.DE`, `IDUS.L`, `MC.PA`, `EVO.ST`, `IGLN.L`.
Measured 2026-11-26: **every** `.XETRA` and `.LSE` form returns HTTP 404
from Yahoo and every one of its equivalents resolves. So the translation
lives in `normalizeTickerSymbol()` (`src/analysis/priceProvider.js`),
which is where the symbol that is FETCHED is decided, and the plechac
name table carries the same mapping so the RECORD has one ticker per
instrument.

**THE OTHER SCREENSHOTS ARE NOT READ YET.** The corpus holds 14
attachments: one XTB positions table (read), one performance chart, one
grid of holding cards, one `My Holdings` table and four narrow ticker
strips. The images are all kept on the machine that fetched them, and
Discord's own URLs expire, so the media is the only copy -- which is why
the reader is pinned by a FROZEN fixture of the OCR words
(`test/fixtures/plechac_portfolio/`) rather than by a live image.

### The 2025-12-22 "Overview" table -- 83 holdings, ALL WITH WEIGHTS (2026-11-28)

**THE SIX PICTURES OF THAT MESSAGE ARE ONE TREEMAP AND FIVE SCROLL
POSITIONS OF THE XTB "Overview" TABLE**, and the table says "1-86 of 86".
The weight is in a column called **"Allocation"** -- the same column the
Czech "POZICE" table calls "VAHA" -- so the premise that these pictures
carry no weight was wrong.

**MEASURED: 83 HOLDINGS, EVERY ONE WITH A WEIGHT, AND THE WEIGHTS SUM TO
98.27 %**, which is the broker's own book exactly (the missing 1.57 % is
the "$ Cash" row).

Three things had to be right, and each one is a wrong-number trap:

1. **THE HEADER IS SPLIT OVER TWO BANDS.** The Czech table puts every
   column name on one line, but the English "Overview" view puts "Ticker"
   on the line BELOW the others, so the columns are found in the band
   above the ticker band too.
2. **THE DAILY CHANGE GETS ITS OWN COLUMN**, because it is a different
   fact: "1D Gain %" is today and "Unr. Gain %" is the unrealised gain.
   A reader that took the wrong percentage column would publish a
   CHANGE as a weight.
3. **THE CUT-OFF ROW IS THE TRAP.** Each picture's last row is cut off
   by the image edge and the OCR reads its numbers without their points
   ("0.78 %" as "78 %", "1.61 %" as "161 %"). So a weight outside
   (0, 100] is IMPOSSIBLE and the row is rejected, and a weight that
   breaks the column's SORTED order is repaired by dividing it by 100 --
   but only when that restores the order.

**AND TWO LINES OF ONE HOLDING ADD, and the source's own vocabulary is
what tells them apart.** He holds the Amsterdam line and the Nasdaq line
of ASML, and both map to the market ticker ASML. The vocabulary's keys
ARE the broker's spellings, so "ASML.AS" and "ASML" are two LINES while
"ASMLAS" -- the Amsterdam line with the dot dropped by the OCR --
resolves to "ASML.AS" and is the same line read badly. Two lines of one
holding are ONE position and their weights add; the scroll overlap is
the same line read twice and it does NOT add.

**AND THE ACCOUNT RULE WAS WRONG, ON A BOOK OF 84 HOLDINGS.** The rule
was "does the message contain the word risky?". His 2025-12-22 message
publishes his ONE PUBLIC INVESTMENT ACCOUNT and mentions the risky book
in passing, on another account -- so the naive test filed his main book
under the risky account. The rule is now "the risky book is the one the
message calls a RISKY PORTFOLIO".

**AND FIVE OF THE HOLDINGS WERE OCR MISREADS, read off the pixels.** The
Overview view's ticker column carries the COMPANY'S NAME under each
ticker, so a reading can be checked against the instrument it names:

| the OCR read | the picture says | the company |
|---|---|---|
| `IQQEDE` | IQQE.DE | iShares MSCI Emerging Markets |
| `IOGPL` | IOGP.L | iShares Oil & Gas Producers UCITS ETF |
| `IDUPL` | IDUP.L | iShares US Property Yield UCITS ETF |
| `IDTLL` | IDTL.L | iShares $ Treasury UCITS ETF |
| `FLXLDE` | FLXI.DE | Franklin Liberty |

Every one of the five was also probed against Yahoo, and all five
resolve. So the source has its own PICTURE-READING confusion table
(`config/ticker_ocr_confusions_plechac.csv`), separate from the
vocabulary: **the vocabulary says what the BROKER writes and the
confusion table says what the OCR READS.** It is applied only to a
picture reading.

**81 OF THE 83 HOLDINGS NOW CARRY A SYMBOL YAHOO CAN PRICE.** The two
that do not are `RZUS.L` (1.07 %) and `DOC1` (0.73 %) -- 1.80 % of the
book -- and both were read off the pixels ("Digital Angel Corp" for
DOC1), and Yahoo has no price series for either under any spelling that
was tried. So they keep the broker's own spelling: a holding that cannot
be priced is a holding that cannot be scored.

### The WRONG-INSTRUMENT CLASS, and what the probe found (2026-11-26)

Every ticker in `config/ticker_names_plechac.csv` was probed against Yahoo,
one by one, and the answer is not always the instrument he means. Three
were wrong, and a wrong instrument is a wrong PRICE on a real holding:

| he writes | Yahoo's bare form is | his instrument is |
|---|---|---|
| `EVO` | **Evotec SE** (NMS) | `EVO.ST` (Evolution AB, Stockholm) |
| `BTC` | the **Grayscale Bitcoin Mini Trust** | `BTC-USD` (bitcoin) |
| `LVMH` | 404 | `MC.PA` (LVMH, Paris) |
| `3CP.F` | -- | `1810.HK` (Xiaomi) -- **not** BYD, which is `1211.HK` |

**AND THE TOKEN HAS TO CARRY THE VENDOR'S SUFFIX.** The broker writes
`IGLN.UK` and `NGAS.UK`, and a token that stopped at the dot read only
the TAIL -- so `IGLN.UK` was published as the holding `UK`, which Yahoo
resolves to Ucommune International. The token may now carry a dot or a
dash, and the two rows are in the table.

**THE ONE THAT LOOKED LIKE A MISREAD WAS NOT.** `UUUU` is not a garble:
it is Energy Fuels Inc, the small uranium and gas company he writes
about ("Je\u0161t\u011b EQT a UUUU - plyn a uran", "relativn\u011b mal\u00e1 spole\u010dnost,
st\u00e1le zraniteln\u00e1, ale nab\u00edz\u00ed expozici i do kritick\u00fdch materi\u00e1l\u016f"). A
rule that said "UUUU is not a ticker" would have deleted a real holding.

### Commands

| command | what it does |
|---|---|
| `npm run discord:plechac:positions` | `tools/buildDiscordPlechacPositions.js` — the parsed layers |
| `npm run discord:positions` | the English traders' builder, then his |
| `npm run discord:analyze` | prices every episode, including his |
| `npm run discord:report` | the dashboard, with his books in the table |
| `npm run discord:attachments` | `tools/fetchDiscordAttachments.js` — the screenshots |
| `npm run discord:plechac:portfolios` | `tools/parsePlechacPortfolios.js` — the positions table |

The rows carry `source_name = 'plechac'`, and each builder deletes only
its own source's rows, so a rebuild of either one leaves the other's
alone.

## David Monoszon (`monoszon`) — calls about indexes, not positions (2026-11-26)

`⚡｜indexy` (1057197663285678241) in the same TradeCZ server, and
he is the dominant poster in it: **2,955 of the last 4,000 messages**,
2025-07 → 2026-11. The ingest filters by his author id
(`621658520491655176`), so the source is his messages and nobody else's.

**HE PUBLISHES NO POSITION LIST AND NO SIZE.** He trades the index
futures intraday and says only "malý size", "třetinovým size". So
this is NOT another position source, and it is not in the traders' table
of the dashboard. What it is: a TAPE of calls about indexes, sector ETFs
and commodities, and those calls can be scored against the instrument.

| | |
|---|---|
| messages ingested | **4,500** |
| readings | **90** — 69 forward, 15 retrospective, 6 live positions |
| measured precision | **88.4 %** (a hand-labelled sample of all 69) |
| 1-week hit rate | **57.4 %** (68 scored) against **63.2 %** for the same call on SPY |
| 1-month hit rate | **54.5 %** (66 scored) against **62.1 %** for the same call on SPY |

**SO HE DOES NOT BEAT THE INDEX EITHER**, and that is the honest result:
it is the same result Sevcik, T3Live and Benzinga give. The excess at
one week is **+0.07 pp** with a 95 % interval of **±0.56 pp**, so the
calls and the index are indistinguishable.

### The module is his own (`src/discord/monoszon/`)

`subjects.js` is the instrument table and `parser.js` is the Czech
reader. Six rules are not the shared ones, and each was measured:

1. **THE TENSE IS CARRIED BY THE VERB, NOT BY THE DIRECTION WORD.**
   "long" and "short" are nouns in Czech and they do not conjugate, so
   the tense of a call is carried by the verb around it. Measured over
   his 4,500 messages, **179** carry a subject and a direction word in
   the same sentence, and the rest of the parser is about deciding which
   of those 179 are about the FUTURE.
2. **"BY" IS NOT A PAST TENSE.** "to by byl bearish scénář" is a SCENARIO and
   "abych změnil na bearish" is a condition; Czech writes the
   conditional with "by", so a past form right after a "by" is
   conditional. Without that, nine of his best calls land in the
   retrospective bucket.
3. **A REGIME IS NOT A CALL.** "v bull marketu nečekám až na tick na target",
   "po ukončení bear marketu 2022", "v třetině komoditním bull cyklu". A direction word
   followed by a regime word is skipped — and the word is taken WITHOUT
   its punctuation, or "bull cyklu," does not match a pattern anchored
   at the end of the word.
4. **"SHORT COVERING" IS A SQUEEZE, AND A SQUEEZE IS UP.** The two words
   are read together, because "short" alone says the opposite — and the
   Czech case ending rides on the noun ("short coveringu"), so a
   `\bcovering\b` misses it and reads the opposite.
5. **AN OPTION SPREAD REVERSES THE DIRECTION.** "já budu nakupovat put
   spready na SPX 6580" is a BEARISH call on SPX, and reading the
   "nakupovat" as bullish gets it exactly wrong. Buying a put spread is
   bearish; buying a call spread is bullish.
6. **"SI" IS MATCHED CASE-SENSITIVELY AND NOTHING ELSE IS.** In Czech
   "si" is the reflexive pronoun, and a case-INSENSITIVE "SI" matched
   it on **421** messages and published the silver future as the subject
   of sentences about nothing at all. He writes the silver future in
   capitals (once) and the pronoun in lower case (421 times). Every
   OTHER instrument he writes in BOTH cases — `SPX` 105 caps / 173
   lower, `NQ` 224 / 111, `QQQ` 37 / 17, `SPY` 29 / 24 — so every other
   subject is matched in both.

**THE SUBJECT IS WHAT THE DIRECTION HANGS OFF**, and it is the one the
direction is NEAREST to: "v momentě kdy by to dnes prodejci vzali pod 6220
tak bullish teze padá" is a BEARISH call on SPX, because "prodejci" is the
word that hangs off "SPX" and "bullish teze" is the thesis falling.

**THE ENTRY IS THE CLOSE ON THE DAY HE WROTE IT.** He names a level
("abych změnil na bearish, potřeboval bych vidět spx uzavírat pod 6550")
and the level is recorded with the reading — but the price model enters
at the close, because the entry model is close-to-close and a limit
level is not a fill. A call made intraday is therefore scored from the
close of the day, which leaves the day's own move out of the measured
return.

**THE SCORING GATE IS IN THE DATA, NOT IN THE READER.** `claim_kind` is
`forward` (scored), `retrospective` ("dnes byl krásný long na GC" — a
fact) or `present` ("dnes uzavírám třetinu BTAL longu" — a position he
holds, which has already had its move). A query that wants the scorable
calls says `WHERE claim_kind = 'forward'`.

**A CALL ON THE S&P 500 FUTURE IS SCORED ON SPY**, so its excess against
SPY is zero by construction; the hit rate is the number that means
something there. That is said in the payload rather than left for the
reader to discover.

### Commands

| command | what it does |
|---|---|
| `npm run discord:monoszon:readings` | `tools/buildDiscordMonoszonReadings.js` — the readings |
| `npm run discord:monoszon:outcomes` | `tools/analyzeDiscordMonoszon.js` — the scoring |
| `npm run discord:report` | the dashboard, with his calls in their own section |

The readings live in `monoszon_readings`, a table of their own: a
reading is not a trade, so it is not in `discord_trade_actions`, and it
has no video, so it is not in the shared `market_readings` either. The
Clement source is the precedent for a chat source with its own tables.

## HariSeldon (`hariseldon`) -- a trade journal in English (2026-11-27)

`verified-traders` in the `/r/RealDayTrading` server (1058604837467607100),
and the source is ONE account that posts under FOUR names: `*HariSeldon*`
(1,927 messages), `Twitter: RealDayTrading` (637), `HSeldon2020` (416) and
`OptionStalker` (20). They are all one Discord user id -- 1058608380173889537
-- because the Reddit and Twitter accounts are WEBHOOKS posting under his
identity.

**SO THE SOURCE NEEDS A DEDUPE, and the mirrors are the reason.** His own
post is "Exit $NKE `36.52` with .98 profit per share" and the Twitter mirror
is "Exit NKE with .98 profit per share". **Measured: 97 of his 126 messages
in the sample have a mirror within 15 minutes**, and 146 of his 1,927
messages in the whole corpus do. The rule is to keep the RICHER post -- the
one with the price -- because that is the one the episode is priced from.

**WHAT HE POSTS.** Plain text, and the format is regular:

```text
Long $NKE `35.5322` $35.55 - 1,000 Shares
Exit $RBLX `51.665` with $1.02 profit per share (1,000)
Short $SPY PDS $730/$720 for $3.08 - 10 Contract - expires Friday
Long $NVDA `165.96` Lottos CDS $167.5/$170 - for .83 - 20 Contracts
I sold the $AMD $500 Calls (again) this time for $8.55 - expiring tomorrow
Bought back the sold Calls for $4 profit per contract (5 Contract)
I added to another 250 Shares, 750 Total now for an average price of $109.68
```

**THE PRICE IS THE FIRST NUMBER AFTER THE TICKER, and that was MEASURED.**
Over the entry/exit pairs that state a profit, the first number after the
ticker is within 5 % of the exit price in **101 of 110** pairs (median
0.50 %), while the second number is within 5 % in 124 of 481 (median
distance **78 %**) -- the second number is the SIZE or a STRIKE.

**AND THE FOUR RULES THAT WERE FIXED BY MEASUREMENT:**

1. **".98 profit per share" is 0.98 and not 98.** A number that may start
   with a decimal point, or the exit's price is read as 98 and the P&L is
   taken for a fill.
2. **A PROFIT IS NOT A PRICE.** "Exit $MRNA with $1.32 profit per contract
   (15)" states no price at all, and the number there is the profit.
3. **AN OPTION IS NOT AN EQUITY.** A spread's price is the SPREAD's price
   and not the underlying's, so an option action is recorded and NOT
   chained into a position episode -- the episode model prices a position
   from the underlying's closes, and the two prices are not the same
   number. The option's price is the LAST number before the size.
4. **THE FUTURES CARRY YAHOO'S SYMBOL.** "Exit /ES" is the S&P future and
   Yahoo spells it `ES=F`; `ES` on its own is Eversource Energy.

**MEASURED.** 3,000 messages, 194 mirrors dropped, **2,007 actions**
(1,307 equity and 700 option) and **485 episodes**, all priced. The
hit rate is **58.9 %** (95 % CI 51.5-65.9) with the excess over SPY at
**0.00 %**.

**AND HE IS AN INTRADAY TRADER, WHICH THE CLOSE-TO-CLOSE MODEL CANNOT
SEE.** 285 of his 460 closed episodes are SAME-DAY: he opens and closes
inside one session, and the model reads that as a flat 0 %. They are
counted apart, exactly as the same-day trades of the other traders are,
and the hit rate is over the 175 that were held longer than a day.

### His OPTION LEGS, scored as directional claims (2026-11-28)

**HE TRADES OPTIONS, AND AN OPTION IS NOT A HOLDING.** Every episode so
far has been an EQUITY trade, so his option structures were never
scored -- and they are a different kind of claim, because an option's
price is the option's and not the underlying's.

**THE RULE, IN THE SOURCE'S OWN MODULE**
(`src/discord/hariseldon/optionDirection.js`): an option leg is scored
as a **directional claim on the UNDERLYING**, because a spread is a
bounded bet and the question is whether the DIRECTION carries
information -- not whether the spread was a good trade. **And the
option's own price is not chained into an episode**: the price of a
spread is the spread's, so the option action is recorded and the equity
episodes are not disturbed.

**MEASURED over 521 directional opens:**

| | n | hit rate | the same call on SPY | edge | the mean excess |
|---|---|---|---|---|---|
| 1 week | 517 | **44.5 %** (CI 40.3-48.8) | 47.0 % | **-2.5 pp** | -0.18 pp (CI -0.65 to +0.29) |
| 1 month | 490 | **49.0 %** (CI 44.6-53.4) | 43.7 % | **+5.3 pp** | +0.49 pp (CI -0.60 to +1.58) |

So his option calls are **worse than the index at one week** and
indistinguishable from it at one month, and the assessment the tool
writes is `possible_negative_edge` at both horizons.

**AND THE DIRECTION IS DERIVED FROM THE STRUCTURE, not from the
underlying.** A CALL is bullish and a PUT is bearish; a spread's two
legs give the direction its larger exposure carries; and a call that
BUYS a put (a synthetic short) is bearish.

```bash
node tools/analyzeDiscordHariSeldonOptions.js
```

## Martin Klass (`martinklass`) -- a daily digest of the earnings (2026-11-27)

Two channels of his own server (1334510084231004202): `trading`
(1335565442550595594) and `investování` (1338925744147140658).
**1,013 messages** in all, 2025-02 -> 2026-11.

**THE TWO CHANNELS ARE TWO CLAIM KINDS, AND THAT IS THE WHOLE DESIGN.**
His `investování` channel posts the day's earnings, one message per
company, and every one of those messages reports what ALREADY HAPPENED:
"**🛡️ Ambarella se potýká s nedostatkem paměťových čipů, akcie
výrazně klesají**". A result cannot be scored, because the price has
already moved by the time the claim is written -- the same rule the
Benzinga source follows for "Wedbush's Dan Ives remains very bullish". So
those readings are RECORDED (149 of them) and NOT scored, and they are the
context that makes the forward ones readable.

**THE FORWARD CLAIMS ARE SCORED: 52 of them**, with a **measured precision
of 75.0 %** (a hand-labelled sample of all 52 -- the same class as the
Benzinga readings' 75 %).

**MEASURED.** 1 week: **42.0 %** against **48.0 %** for the same call on
SPY. 1 month: 44.2 % against 44.2 %. So he does not beat the index, and
the excess at one week is +0.65 pp -- inside the noise of 50 calls.

**AND THERE IS A STRUCTURAL CAVEAT THAT MAKES THE NUMBER LATE BY
CONSTRUCTION.** His forward readings are published AFTER the news that
moved the name ("it fell 15 %, but I think it will bounce"), so the
close-to-close model enters after the move.

**THE PARSER IS HIS OWN** (`src/discord/martinklass/`), because he writes
Czech, and four rules are not the shared ones:

1. **THE HEADLINE DECIDES THE SUBJECT, AND THE BODY CANNOT STEAL IT.** The
   digest's headline is the claim and the body explains it. Reading the
   body as a second reading is what put AMZN on a message about AST
   SpaceMobile.
2. **THE DIRECTION HAS TO BE IN THE SUBJECT'S OWN SENTENCE.** A digest
   message names a company and then talks about several others, and a
   direction word from the next paragraph is not a claim about this one.
3. **THE COMMODITIES ARE IN CZECH** -- zlato (GLD), stribro (SLV), ropa
   (USO), psenice (WEAT) -- and the case ending changes the word, so the
   forms are written out. A call on gold is a call on GLD here, and GLD
   is the gold MINERS' equity and not the gold price.
4. **THE COMPANY NAMES GO THROUGH THE SHARED MATCHER**, which is the
   market's own registrant file -- and which resolves some names and not
   others ("CrowdStrike" yes, "Ambarella" no).

### The 2026-04-15 treemap -- the main book, and its sector (2026-11-27)

The portfolio channel carries a TREEMAP of the whole book as well as the
XTB table: a full-width picture divided into SECTOR groups, every leaf
one holding, with the ticker, the day's CHANGE and the company name.

**THE PERCENTAGE IS THE DAILY CHANGE AND NOT THE WEIGHT**, and that is
what the pixels say. A weight can never be negative, and three leaves
carry a negative percentage; the header's own sentence separates the two
("Denni zmena · velikost = hodnota v portfoliu" -- the change is
printed, the size is drawn); and the sector's aggregate is a weighted
average of its leaves' changes and nowhere near their sum. **So the
treemap contributes NO weight**, and its 65 rows carry a NULL weight.

**THE SIGN COMES FROM THE COLOUR**, because the OCR loses the broker's
minus dash on 12 of the 64 leaves -- and so does the OTHER OCR pass, on
the SAME leaves, so their agreement is not evidence. The tile's
background carries it: green rgb(26, 65, 45), red rgb(75, 31, 32), and
a FLAT tile rgb(45, 51, 59) for the leaves whose change is a fraction
of a point, where the glyph is the only witness.

**MEASURED.** 65 of the screenshot's 96 positions, across 7 of the 13
sector labels. The cross-check against the trade channel, bounded to
the screenshot's date: the screenshot holds 63 names, the trade channel
named 62 by then, and **29 are in both**.

## THE HEAD-TO-HEAD, every source against the same call on SPY (2026-11-28)

**NINE SOURCES, ONE TABLE, AND THE HONEST HEADLINE IS THAT NONE OF THEM
BEATS THE INDEX.** Every row is the source's own published claims,
scored at the entry rule that source publishes with, against **the same
call on SPY on the same dates**.

| source | claims | 1w hit | the same call on SPY | excess | 1m hit | excess |
|---|---|---|---|---|---|---|
| Sevcik (Czech streams) | 1708 | 50.8 % | 53.2 % | **-2.4 pp** | 54.4 % | -5.8 pp |
| T3Live | 4511 | 51.3 % | 55.2 % | **-3.9 pp** | 53.1 % | -6.5 pp |
| Benzinga (signals) | 1426 | 52.1 % | 55.0 % | **-2.9 pp** | 54.6 % | -10.0 pp |
| Benzinga (readings) | 2696 | 50.9 % | 53.1 % | **-2.2 pp** | 50.9 % | -2.1 pp |
| AsymTrading | 30 | 46.7 % | 60.0 % | **-13.3 pp** | 56.7 % | -26.7 pp |
| Komar | 153 | 59.6 % | 62.3 % | **-2.6 pp** | 57.0 % | -11.3 pp |
| FundedMind | 395 | 55.1 % | 53.8 % | **+1.3 pp** | 50.3 % | -0.8 pp |
| David Monoszon | 69 | 57.4 % | 63.2 % | **-5.9 pp** | 54.5 % | -7.6 pp |
| Martin Klass | 52 | 42.9 % | 49.0 % | **-6.1 pp** | 45.2 % | 0.0 pp |

**AND IT IS ALSO THE ANSWER TO "IS THE ENTRY RULE THE REASON?",** because
every source is re-scored under every executable entry rule with the
exit FIXED at the claim date, so only the entry moves -- and every
source's edge is negative or indistinguishable from zero under all of
them. So the "no edge" finding is a fact about the SOURCES and not an
artefact of the entry price.

**AND THE INSTRUMENT VALIDATES ITSELF, LIKE FOR LIKE.** Eight of the
nine sources AGREE exactly with their published numbers on the rows both
scored, and the ninth -- T3Live -- differs on **ONE row in 4,353**
(Yahoo revised NXDR's history between the published run and the
measurement).

```bash
node tools/measureEntryRule.js        # writes data/entry_rule_measurement.json
```

The dashboard carries the same table over the Discord sources, in
`data/discord_traders.html`, and the posted-books table shows the
RICHEST snapshot of each book and not only the latest one -- because the
latest is not always the whole book.

## Additive cross-trader layers (2026-11-22)

No rebuild of core `discord_positions` / episodes / clement_posts required.

| Command | Writes |
|---|---|
| `npm run discord:attachment-hints` | `discord_attachment_hints` (Ariel/Drendel image-thin msgs) |
| `npm run discord:clement:focus-episodes` | `clement_focus_episodes` |
| `npm run discord:regime-join` | `regime_book_days` |
| `npm run discord:exposures` | `trader_exposures` (projection) |
| `npm run discord:additive` | all four in order |

Shared ticker OCR repairs: `src/discord/shared/ocrConfusables.js`.
