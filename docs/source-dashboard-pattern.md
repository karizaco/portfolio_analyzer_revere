# Source dashboard pattern

## Purpose

Give every data source a familiar place to inspect coverage, evidence, and extracted insights, while letting each source show the records it actually produces. This is a design contract for generated dashboards, not a requirement that all sources use the same charts.

## Page structure

1. **Source header** — source name, latest catalog/data update, selected date range, and a short source description.
2. **Coverage strip** — a source-specific funnel with counts and clear denominators: catalogued → accessible/eligible → transcript or structured data present → extracted records → scored outcomes. A stage that has not been checked is `unknown`, not zero.
3. **Overview** — measures that fit the source: calls, distinct tickers, readings, and outcome sample size. Omit unavailable measures; never render missing values as zero.
4. **Primary views** — tabs for `Activity`, `Signals`, `Readings`, and `Coverage`. A source can hide unsupported tabs and add a named view of its own.
5. **Evidence detail** — every extracted item opens to the exact source evidence, its source item, time/section, and extraction provenance.

## Shared record contract

The shell consumes a source adapter payload. Keep distinct record types; do not turn every reading into a ticker signal.

```js
{
  source: { id, label, updatedAt, capabilities },
  coverage: [{ stage, count, denominator, status, reason }],
  items: [{ id, publishedAt, eventDate, title, contentType, access, url }],
  signals: [{ itemId, ticker, action, bias, claimKind, horizon,
              confidence, evidence, section, eventTime }],
  readings: [{ itemId, kind, subject, value, stance, unit, evidence }],
  outcomes: [{ signalId, horizon, result, baseline, sampleSize }]
}
```

`claimKind` distinguishes `forward`, `reported`, and `retrospective`. `publishedAt` and `eventDate` remain separate. `coverage.status` is one of `complete`, `partial`, `not_started`, `unknown`, or `blocked`; access limitations and extraction failures belong in `reason`.

## Source modules

- **Benzinga:** show/partner filters; forward, reported, and retrospective claims; transcript section; market, sector, and macro readings; YouTube caption/Deepgram provenance. Keep Shorts, earnings calls, partner content, and quarantined shows visible in coverage even when excluded from signal totals.
- **AsymTrading:** access state; article readings and narrative; sector-table measurements; spreadsheet/breadth data; audio transcript evidence. Keep paid catalog entries visible as inaccessible coverage, not empty articles.

## Layout and interaction

Use a restrained editorial research-desk layout: warm neutral canvas, dark ink, one source accent, dense but legible tables, and a clear typographic hierarchy. The shell stays visually consistent; accent color and a small source mark identify the source. Do not rely on color alone for bias or access state.

The activity view uses a shared date axis with distinct markers for calls, readings, and outcomes. Filters adapt to the source: Benzinga gets show, partner, claim kind, and ticker; AsymTrading gets series, access, market stance, sector, and ticker. Selecting an item opens its evidence inline so the user keeps the surrounding timeline in view.

Coverage labels must be derived from stage-specific tables, not legacy workflow fields. In particular, Benzinga `videos.status='pending'` does not mean its transcript is missing. Caption availability is currently not recorded per video, so the UI should show it as unknown until a caption check is stored.

## Initial source summaries

- **Benzinga:** emphasize the coverage gap: 12,786 catalog items, 38 transcript records, 81 extracted signal rows, and 130 market readings in the inspected snapshot. Show The Drift's complete transcript coverage separately from the sparsely transcribed PreMarket Playbook. Label performance estimates with their sample size.
- **AsymTrading:** lead with access and content coverage: 476 catalog posts, 42 readable, 24 videos transcribed, 42 parsed articles, plus separate sector and spreadsheet data. Make the paywall boundary explicit.

## Implementation sequence

1. Define the adapter payload and coverage statuses above.
2. Extract shared header, coverage, tabs, filters, and evidence-detail rendering from the current standalone report generators.
3. Keep Benzinga and AsymTrading adapters responsible for their typed records and source-specific filters.
4. Add new sources by implementing an adapter and optional panels, not source conditionals throughout the shared shell.
