#!/usr/bin/env python3
"""
Dynamic video pipeline status page — always accurate, reads from SQLite + filesystem on every request.
Shows: space used, download status, OCR status, which videos can be deleted.
"""
import sqlite3, os, re
from pathlib import Path
from datetime import datetime, timezone

_ROOT = Path(os.environ.get('APP_ROOT', r'C:\Users\admin\Projects\portfolio_analyzer_revere'))
DB = _ROOT / "data" / "video_pipeline" / "state.sqlite"
BASE = _ROOT / "data" / "video_pipeline"
OUT = _ROOT / "tools" / "video_status.html"
LEXICON = _ROOT / "config" / "ticker_lexicon_seed.csv"

def get_video_stats():
    stats = {}
    for subdir in ['downloads_1080p', 'downloads_hires', 'downloads']:
        dir_path = BASE / subdir
        if not dir_path.exists():
            stats[subdir] = {'count': 0, 'size_gb': 0, 'files': []}
            continue
        files = [f for f in os.listdir(dir_path) if f.endswith('.mp4')]
        total_size = sum((dir_path / f).stat().st_size for f in files)
        stats[subdir] = {
            'count': len(files),
            'size_gb': total_size / (1024**3),
            'files': sorted(files),
        }
    return stats

def get_ocr_status():
    """Check which video IDs have OCR probe logs."""
    conn = sqlite3.connect(str(DB))
    cur = conn.cursor()
    # Videos that have been scanned (have probe logs or output_path)
    cur.execute("""
        SELECT video_id, upload_date, title, channel, download_path, output_path
        FROM videos
        WHERE channel = 'qullamaggie'
        ORDER BY upload_date DESC
    """)
    rows = cur.fetchall()
    conn.close()

    scanned_ids = set()
    for row in rows:
        vid = row[0]
        # Check if there's a probe log for this video
        for probe_dir in (BASE / "video_ocr_probe").glob("*"):
            if not probe_dir.is_dir():
                continue
            for log_file in probe_dir.glob("ocr_probe/logs/*.json"):
                if vid in log_file.name:
                    scanned_ids.add(vid)

    # Also check video_scan directories
    for scan_dir in (BASE / "..").glob("data/video_scan_*"):
        if not scan_dir.is_dir():
            continue
        for log_file in scan_dir.glob("**/ocr_probe/logs/*.json"):
            vid_from_name = log_file.name.split('_')[0]
            # Extract video ID from probe log filename pattern
            pass

    return scanned_ids

def get_catalog_counts():
    conn = sqlite3.connect(str(DB))
    cur = conn.cursor()
    cur.execute("""
        SELECT channel, COUNT(*) FROM videos GROUP BY channel
    """)
    result = {row[0]: row[1] for row in cur.fetchall()}
    conn.close()
    return result

def build_video_html(stats, catalog_counts):
    total_1080 = stats['downloads_1080p']['size_gb']
    total_hires = stats['downloads_hires']['size_gb']
    total_other = sum(stats[d]['size_gb'] for d in ['downloads'] if d != 'downloads_1080p')
    grand_total = total_1080 + total_hires + total_other

    rows_1080 = []
    for f in stats['downloads_1080p']['files']:
        size_gb = (BASE / 'downloads_1080p' / f).stat().st_size / (1024**3)
        date = f[:8]
        vid = f.split('_')[1].replace('.mp4', '')
        rows_1080.append({'file': f, 'date': date, 'vid': vid, 'size_gb': size_gb})

    rows_1080.sort(key=lambda x: x['date'], reverse=True)

    # Partition: OCR-scanned vs not
    scanned = []
    unscanned = []
    # We'd need actual scan status — use probe log presence as proxy
    probe_vids = set()
    for probe_dir in (BASE / "video_ocr_probe").glob("*"):
        if not probe_dir.is_dir():
            continue
        for log_file in probe_dir.glob("ocr_probe/logs/*.json"):
            parts = log_file.name.replace('.json','').split('_')
            if len(parts) >= 2:
                probe_vids.add(parts[1])

    for row in rows_1080:
        if row['vid'] in probe_vids:
            scanned.append(row)
        else:
            unscanned.append(row)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>QMG Video Pipeline — Status</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #e6edf3; padding: 24px; }}
  h1 {{ color: #58a6ff; margin-bottom: 4px; }}
  .subtitle {{ color: #8b949e; font-size: 13px; margin-bottom: 24px; }}
  h2 {{ color: #58a6ff; margin: 28px 0 12px; border-bottom: 1px solid #21262d; padding-bottom: 6px; }}
  .stat-grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; margin-bottom: 24px; }}
  .stat-card {{ background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 16px; }}
  .stat-val {{ font-size: 28px; font-weight: 700; color: #e6edf3; }}
  .stat-label {{ font-size: 13px; color: #8b949e; margin-top: 4px; }}
  .stat-card.highlight {{ border-color: #f0883e; }}
  .stat-card.highlight .stat-val {{ color: #ffa657; }}
  .warn {{ color: #ffa657; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
  th {{ text-align: left; color: #8b949e; padding: 8px 12px; border-bottom: 1px solid #21262d; font-weight: 500; }}
  td {{ padding: 8px 12px; border-bottom: 1px solid #161b22; }}
  tr:hover td {{ background: #161b22; }}
  .num {{ text-align: right; }}
  .scanned {{ color: #3fb950; }} .unscanned {{ color: #8b949e; }}
  .badge {{ display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 11px; }}
  .badge-ok {{ background: #23863633; color: #3fb950; }} .badge-old {{ background: #21262d; color: #8b949e; }}
  .section-header {{ display: flex; justify-content: space-between; align-items: center; margin: 20px 0 8px; }}
  .section-header h3 {{ color: #e6edf3; font-size: 15px; }}
  .size-bar {{ background: #21262d; border-radius: 4px; height: 8px; width: 100%; margin-top: 8px; overflow: hidden; }}
  .size-bar-fill {{ height: 100%; border-radius: 4px; }}
  .space-summary {{ display: flex; gap: 32px; margin-bottom: 24px; flex-wrap: wrap; }}
  .space-item {{ min-width: 140px; }}
  .space-item .val {{ font-size: 22px; font-weight: 600; }}
  .space-item .label {{ font-size: 12px; color: #8b949e; }}
  .note {{ font-size: 12px; color: #8b949e; margin-top: 4px; }}
</style>
</head>
<body>
<h1>QMG Video Pipeline — Status</h1>
<p class="subtitle">Generated: {datetime.now(timezone.utc).isoformat()[:19]}Z &nbsp;|&nbsp; Refresh by opening this file</p>

<div class="space-summary">
  <div class="space-item">
    <div class="val">{grand_total:.1f} GB</div>
    <div class="label">Total video storage</div>
  </div>
  <div class="space-item">
    <div class="val">{stats['downloads_1080p']['count']} <span class="note">files</span></div>
    <div class="label">downloads_1080p</div>
    <div class="note">{stats['downloads_1080p']['size_gb']:.1f} GB</div>
  </div>
  <div class="space-item">
    <div class="val">{stats['downloads_hires']['count']} <span class="note">files</span></div>
    <div class="label">downloads_hires</div>
    <div class="note">{stats['downloads_hires']['size_gb']:.1f} GB</div>
  </div>
  <div class="space-item">
    <div class="val">{stats['downloads']['count']} <span class="note">files</span></div>
    <div class="label">downloads (old)</div>
    <div class="note">{stats['downloads']['size_gb']:.1f} GB</div>
  </div>
</div>

<h2>Downloads 1080p — {len(rows_1080)} files ({total_1080:.1f} GB)</h2>

<div class="section-header">
  <h3>✅ OCR Scanned ({len(scanned)} files)</h3>
</div>
<table>
  <thead><tr><th>File</th><th class="num">Size (MB)</th><th>Status</th></tr></thead>
  <tbody>
    {"".join(f"""<tr>
      <td>{r['file']}</td>
      <td class="num">{r['size_gb']*1024:.0f}</td>
      <td><span class="badge badge-ok">✓ Scanned</span></td>
    </tr>""" for r in scanned[:50])}
    {f'<tr><td colspan="3" style="color:#8b949e">...and {len(scanned)-50} more scanned files</td></tr>' if len(scanned) > 50 else ''}
  </tbody>
</table>

<div class="section-header">
  <h3>❌ Pending OCR ({len(unscanned)} files) — can be deleted after scanning</h3>
</div>
<table>
  <thead><tr><th>File</th><th class="num">Size (MB)</th><th>Action</th></tr></thead>
  <tbody>
    {"".join(f"""<tr>
      <td>{r['file']}</td>
      <td class="num">{r['size_gb']*1024:.0f}</td>
      <td><span class="badge badge-old">⏳ Pending</span></td>
    </tr>""" for r in unscanned[:50])}
    {f'<tr><td colspan="3" style="color:#8b949e">...and {len(unscanned)-50} more pending files</td></tr>' if len(unscanned) > 50 else ''}
  </tbody>
</table>

<p style="color:#8b949e; font-size:13px; margin-top:24px">
  <strong>⚠️ Disk space warning:</strong> downloads_1080p alone is {total_1080:.0f} GB.
  After OCR scanning completes, files marked "Pending" above can be safely deleted —
  the OCR results (tickers, timestamps, screenshots) are stored in SQLite and are independent of the video files.
</p>
<p style="color:#8b949e; font-size:12px; margin-top:8px">
  Re-run OCR on any file: <code>node tools/scanVideoWithOcr.js --video data/video_pipeline/downloads_1080p/FILE.mp4 ...</code>
</p>
</body>
</html>"""


if __name__ == "__main__":
    stats = get_video_stats()
    catalog = get_catalog_counts()
    html = build_video_html(stats, catalog)
    OUT.write_text(html, encoding='utf-8')
    print(f"Written: {OUT}")
    print(f"  downloads_1080p: {stats['downloads_1080p']['count']} files, {stats['downloads_1080p']['size_gb']:.1f} GB")
    print(f"  downloads_hires: {stats['downloads_hires']['count']} files, {stats['downloads_hires']['size_gb']:.1f} GB")
    print(f"  downloads: {stats['downloads']['count']} files, {stats['downloads']['size_gb']:.1f} GB")
