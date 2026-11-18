# martinlukkt — measured before the catalog (2026-11-18)

A YouTube transcript source. Not in the catalog yet. Listings were read with
yt-dlp and not written into the database.

| | |
|---|---|
| handle | `@martinlukkt` |
| logical channel | `martinlukkt` |
| streams | 113, all `was_live`, 12 Nov 2025 to 4 Nov 2026, 213 hours |
| videos tab | 2 long uploads ("My first stream", "Pullback short") |
| shorts | none |
| resolution | formats up to 1440p; 1080p exists |
| session date | in the title, `\| D Mon YYYY` (112 of 113). The flat listing has no upload_date. A title date can be the day before YouTube's upload timestamp. |
| captions | English auto-captions on 11 of 12 sampled streams. `f6w0PgDU8Rk` has none. The full caption-less share is not measured yet. |
| speech | 21–38 words per minute. Tickers are rarely capitalised in the captions. |
| what a signal is | a trade he states: "I bought the breakout", "my stop was the day low", "I'm going to short this one". Not a bullish/bearish call. |
| review streams | titles containing "trades" ("Oct trades") look back at finished trades. They are stored and not scored as calls made on the session date. |
| on-screen book | **Yes, both eras, and the section names changed.** Right-edge TradingView watchlist, 1920×1080, format 299 (1080p60; format 137 is not offered). 2026-11-04 `NUT6d6Hvbmw`: list `E_Main`, sections INDEXES / LONGS / SHORTS / FOCUS / TRACKING. LONGS and SHORTS are the book; they changed between t=600 s and t=1800 s. 2025-11-14 `LcGmyo5ASt4`: at t=900 s the list is `E_Lagging`, a flat coloured list with no section headers; at t=2700 s it is `E_Main` with HOLDINGS / IDEA / LONGS / SHORTS / WAITLIST. So the widget is stable and the section vocabulary is not. A reader that assumes LONGS/SHORTS are the only books would miss the 2025 HOLDINGS section and would publish TRACKING and WAITLIST names as positions. The crop is not shipped. |

Code so far: `src/martinlukkt/channel.js`, `src/martinlukkt/contentFilter.js`,
the catalog URL in `tools/whiteboard_worker.py`, and the English caption
defaults in `tools/fetchSevcikTranscripts.js`.
