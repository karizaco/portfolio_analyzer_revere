# FundedMind day-level setup pairing

## Problem
Signals today are **utterance-level**: a verb + ticker + timestamp inside one video.
Actionable review needs **day-level setups**: what the host was actually trading *that session day*,
with entries/exits/stops collapsed into one (or few) trade objects, not 5 fragmented caption hits.

## Units (keep FundedMind quirks here; shared transcript store unchanged)

1. **Session** = one video row
   - keys: `video_id`, `session_date` (from title), `host`, `kind`
2. **Burst** = collapsed rolling cues already via `collapseRollingCues`
   - optional next step: merge adjacent same-ticker trade reads within N seconds into one burst
3. **Setup** = multi-event object for one instrument on one session
   - open → (optional trims) → exit|stop_out|still_open
   - fields: ticker, side, entry_event, exit_event, stop, targets[], evidence[], confidence

## Pairing algorithm (v1, pure post-process on trade_signals)

For each (session_date, host, ticker) group — actually per video first (one desk = one video):

```
events = signals for video ordered by event_time_sec
active = map side -> open trade
for e in events:
  if e.action == open:
    if active[side]: close prior as still_open/replaced
    start new setup
  if e.action in trim/target: attach to active same side or same ticker
  if e.action in exit/stop_out: close active (prefer matching side)
```

Ambiguity rules (measured needs):
- Oliver multi-instrument: **never** merge across tickers
- Veselovský NAS100 default: prefer setups whose ticker_from != session_default when a named ticker exists same day
- If two opens same ticker opposite sides without exit: treat as flip (close prior)

## Day book (cross-video)

`session_date` from title is the join key across hosts:
- morning Veselovský NAS100 + afternoon Oliver gold → two setups, same calendar day
- Week Recap (Petr) can **score** the week’s setups later (confirm/deny) — separate claim_kind `recap`

Week Recap titles are currently `kind=other` quarantined. Promote to `week_recap` eligible for transcript + light extract (confirm language), not for live open mining.

## Actionability score (rank setups for UI)

+1 host first-person open with side  
+1 ticker from segment/prev/next (not session_default alone)  
+1 stop or target price present  
+1 exit or stop_out later same session  
−1 plan/conditional wording  
−1 ticker_from=session_dominant without nearby price  

## Implementation sketch (reuse, don’t fork OCR)

- `src/fundedmind/setupPairing.js` — pure functions over extractSignals output
- `tools/pairFundedMindSetups.js` — read trade_signals fundedmind-9, write `trade_setups` or JSON under derived
- Tests with Oliver gold burst + Veselovský NAS100 default cases
- Dashboard later: day view grouped by session_date

## Caption backlog relevance
- Week Recaps (23) are the best missing transcripts for **pairing validation**
- Upcoming live desks (Oliver 20.11, Focus 22.11, Šumný 19.11) fill forward once aired


## Persistence (derived.sqlite)

`tools/pairFundedMindSetups.js` writes:
- JSON day books under `data/video_pipeline/fundedmind_setups/`
- rows in `fundedmind_setups` (derived), replace-by-video for the active parser version

Week Recap titles are kind `week_recap` (extract-eligible). Extract emits
`claim_kind=retrospective` judgments via `src/fundedmind/recapRead.js`; pairing
stamps `recap_verdict` onto live setups whose `session_date` falls in the recap week.
