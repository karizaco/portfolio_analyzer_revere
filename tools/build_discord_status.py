#!/usr/bin/env python3
"""
Dynamic Discord signal status page — always accurate, regenerates from SQLite on every request.
Serves as the presentation layer for Discord trading signals.
"""
import sqlite3, json, csv, re, os
from pathlib import Path
from datetime import datetime, timezone

_ROOT = Path(os.environ.get('APP_ROOT', r'C:\Users\admin\Projects\portfolio_analyzer_revere'))
DB = _ROOT / "data" / "video_pipeline" / "state.sqlite"
OUT = _ROOT / "tools" / "discord_signals.html"
LEXICON = _ROOT / "config" / "ticker_lexicon_seed.csv"

# Discord-specific tickers seen in practice (not in seed lexicon)
DISCORD_TICKERS = {
    'NBIS','SSPC','DELL','PLTR','MAGS','ZETA','MRNA','OKTA','HPE','AMD',
    'SPCX','SKHY','SNOW','IREN','NEM','TEAM','DBX','RKB','GLW','MP',
    'LITE','BE','SPCE','SEZL','FTNT','HOOD','SNDK','AXTI','TWST','CAR',
    'CRWD','ARKK','ARKG','NVDA','MU','ON','AT','DT','ARKK','ARM','FCX',
    'HSAI','UBER','SLV','AAPL','TSLA','AMKR','WDC','MRVL','SMH','IGV',
    'MSTR','STX','PLTR',
}

# Load seed lexicon
LEX = set(DISCORD_TICKERS)
if LEXICON.exists():
    with open(LEXICON, newline='', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            LEX.add(row['ticker'].upper())

# Upper bound on valid tickers (5 letters max)
MAX_TICKER_LEN = 5

def build_report():
    conn = sqlite3.connect(str(DB))
    cur = conn.cursor()

    # Channel stats
    cur.execute("""
        SELECT s.name, COUNT(m.id) as msgs,
               SUM(m.has_tickers) as ticker_msgs,
               MIN(m.posted_at) as oldest,
               MAX(m.posted_at) as newest
        FROM discord_sources s
        LEFT JOIN discord_messages m ON m.source_id = s.id
        GROUP BY s.id
        ORDER BY newest DESC
    """)
    channels = []
    for name, msgs, ticker_msgs, oldest, newest in cur.fetchall():
        if name == 'test-alerts':
            continue
        channels.append({
            'name': name,
            'messages': msgs or 0,
            'with_tickers': ticker_msgs or 0,
            'oldest': (oldest or '')[:10],
            'newest': (newest or '')[:10],
        })

    # Top tickers
    cur.execute("""
        SELECT m.ticker_list
        FROM discord_messages m
        JOIN discord_sources s ON s.id = m.source_id
        WHERE s.name != 'test-alerts' AND m.ticker_list != ''
    """)
    from collections import Counter
    all_tickers = Counter()
    for (tl,) in cur.fetchall():
        if not tl:
            continue
        for t in tl.split(','):
            t = t.strip().upper()
            if t in LEX or (len(t) <= MAX_TICKER_LEN and t.isalpha() and t.isupper()):
                all_tickers[t] += 1
    top_tickers = [{'ticker': t, 'count': c} for t, c in all_tickers.most_common(30)]

    conn.close()

    # Messages per month per channel
    conn = sqlite3.connect(str(DB))
    cur = conn.cursor()
    monthly = {}
    cur.execute("""
        SELECT s.name, SUBSTR(m.posted_at, 1, 7) as ym, COUNT(*)
        FROM discord_messages m
        JOIN discord_sources s ON s.id = m.source_id
        WHERE s.name != 'test-alerts'
        GROUP BY s.name, ym
        ORDER BY ym DESC, s.name
    """)
    for name, ym, cnt in cur.fetchall():
        if ym not in monthly:
            monthly[ym] = {}
        monthly[ym][name] = cnt
    conn.close()

    return {
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'channels': channels,
        'top_tickers': top_tickers,
        'monthly': dict(sorted(monthly.items(), reverse=True)[:24]),
    }


def build_html(data):
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Discord Signals — Status</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #e6edf3; padding: 24px; }}
  h1 {{ color: #58a6ff; margin-bottom: 4px; }}
  .subtitle {{ color: #8b949e; font-size: 13px; margin-bottom: 24px; }}
  h2 {{ color: #58a6ff; margin: 28px 0 12px; border-bottom: 1px solid #21262d; padding-bottom: 6px; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 14px; }}
  th {{ text-align: left; color: #8b949e; padding: 8px 12px; border-bottom: 1px solid #21262d; font-weight: 500; }}
  td {{ padding: 10px 12px; border-bottom: 1px solid #161b22; }}
  tr:hover td {{ background: #161b22; }}
  .num {{ text-align: right; font-variant-numeric: tabular-nums; }}
  .channel-name {{ font-weight: 600; color: #79c0ff; }}
  .tag {{ display: inline-block; background: #1f6feb22; color: #58a6ff; padding: 2px 8px; border-radius: 12px; font-size: 12px; margin-right: 4px; }}
  .ticker-cell {{ font-family: 'SF Mono', Monaco, monospace; }}
  .ticker {{ display: inline-block; background: #23863622; color: #3fb950; padding: 2px 8px; border-radius: 4px; margin: 2px; font-size: 13px; }}
  .ticker-high {{ background: #f0883e22; color: #ffa657; }}
  .month-grid {{ display: grid; grid-template-columns: 100px repeat(3, 1fr); gap: 1px; background: #21262d; border: 1px solid #21262d; border-radius: 6px; overflow: hidden; }}
  .mg-header {{ background: #161b22; padding: 8px 12px; font-weight: 600; color: #8b949e; font-size: 13px; }}
  .mg-cell {{ background: #0d1117; padding: 8px 12px; font-size: 13px; text-align: right; }}
  .mg-cell.marker {{ color: #8b949e; }}
  .total {{ color: #e6edf3; font-weight: 600; }}
  .refresh {{ color: #8b949e; font-size: 12px; margin-top: 32px; }}
</style>
</head>
<body>
<h1>Discord Trading Signals</h1>
<p class="subtitle">Generated: {data['generated_at'][:19]}Z &nbsp;|&nbsp; data/video_pipeline/state.sqlite</p>

<h2>Channels</h2>
<table>
  <thead>
    <tr>
      <th>Channel</th>
      <th class="num">Messages</th>
      <th class="num">With Tickers</th>
      <th>Oldest</th>
      <th>Newest</th>
    </tr>
  </thead>
  <tbody>
    {"".join(f"""
    <tr>
      <td class="channel-name">{ch['name']}</td>
      <td class="num">{ch['messages']:,}</td>
      <td class="num">{ch['with_tickers']:,}</td>
      <td>{ch['oldest']}</td>
      <td>{ch['newest']}</td>
    </tr>""" for ch in data['channels'])}
  </tbody>
</table>

<h2>Top Tickers</h2>
<div style="display: flex; flex-wrap: wrap; gap: 6px;">
  {"".join(f'<span class="ticker{' ticker-high' if t["count"] > 200 else ''}">${t["ticker"]} <span style="opacity:0.7">{t["count"]}</span></span>'
           for t in data['top_tickers'][:30])}
</div>

<h2>Messages per Month</h2>
<div class="month-grid">
  <div class="mg-header">Month</div>
  {"".join(f'<div class="mg-header">{ch["name"]}</div>' for ch in data['channels'])}
  {"".join(f"""<div class="mg-cell marker">{ym}</div>
  {"".join(f'<div class="mg-cell total">{data["monthly"][ym].get(ch["name"], 0)}</div>' for ch in data['channels'])}"""
           for ym in data['monthly']) }
</div>

<p class="refresh">Refresh by opening this file in a browser. Re-run <code>python tools/build_discord_status.py</code> to regenerate.</p>
</body>
</html>"""


if __name__ == "__main__":
    data = build_report()
    html = build_html(data)
    OUT.write_text(html, encoding='utf-8')
    print(f"Written: {OUT}")
    print(f"  Channels: {len(data['channels'])}")
    print(f"  Top ticker: {data['top_tickers'][0] if data['top_tickers'] else 'none'}")
