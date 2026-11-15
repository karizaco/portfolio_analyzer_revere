
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
