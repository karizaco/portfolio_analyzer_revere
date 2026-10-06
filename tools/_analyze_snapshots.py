#!/usr/bin/env python3
"""Snapshot analysis for QMG OCR pipeline.

Reads all 83 saved log JSONs (no CPU needed) and computes per-snapshot:
- captures_recall (from parser output)
- cluster_recall (from clusterRawOcrTokens output)
- captures_FPs and cluster_FPs
- Whether the b2925da backfill would have helped (empty captures → non-empty cluster)
- Whether the pricewords fix would have helped (length-<=2 FPs)
- Intro-card captures
"""
import json
import os
import glob
from collections import Counter, defaultdict

GT_FILE = 'data/qmg_ground_truth.json'
LOG_PATTERN = 'data/video_scan_test/_rerun/*/ocr_probe/logs/*_snapshot.json'
OUT_FILE = 'data/_snapshot_analysis.txt'

def load_gt():
    with open(GT_FILE) as f:
        return json.load(f)

def gt_for_video(vid, gt_data):
    """Return a set of GT tickers (uppercase) for this video's first capture with non-empty tickers."""
    v = vid.strip()
    if v not in gt_data:
        return set()
    # GT dict structure: {'20220606': {'0': [...], '1': [...]}, ...}
    caps = gt_data[v]
    # Use the first non-empty cap as canonical
    for k, t in sorted(caps.items()):
        if isinstance(t, list) and len(t) > 0:
            return {x.upper() for x in t}
    return set()

def analyze_log(path, gt_data):
    try:
        with open(path) as f:
            log = json.load(f)
    except Exception as e:
        return None, f'load error: {e}'

    # Get the video id from the file path
    fname = os.path.basename(path)
    # file names look like YYYYMMDD_YYYYMMDD_xxxxx_xxxxxx_snapshot.json
    parts = fname.split('_')
    if len(parts) < 2:
        return None, 'bad filename'
    vid = parts[0]
    gt = gt_for_video(vid, gt_data)
    if not gt:
        return None, 'no GT'

    # Get captures
    captures = log.get('captures', [])
    cap0 = captures[0] if captures else {}
    cap_tickers = set(t.upper() for t in cap0.get('tickers', []))
    cap_is_intro = cap0.get('is_intro_card', False)
    cap_parse_status = (cap0.get('chart_stream') or {}).get('parse_status', '')

    # Get cluster output
    cluster = log.get('merged_raw_token_list', [])
    cluster_tickers = set(t.upper() for t in cluster)

    # Get the rejected list for FP analysis
    rejected = (cap0.get('chart_stream') or {}).get('tickers_rejected_list', [])

    # Backfill: would cap_tickers != cluster_tickers if b2925da applied?
    # b2925da backfills when captures[0].tickers is empty AND cluster has tickers
    backfill_helps = len(cap_tickers) == 0 and len(cluster_tickers) > 0

    return {
        'vid': vid,
        'path': path,
        'gt_size': len(gt),
        'gt': sorted(gt),
        'cap_count': len(captures),
        'cap_tickers': sorted(cap_tickers),
        'cap_recall': len(cap_tickers & gt),
        'cap_fps': sorted(cap_tickers - gt),
        'cap_intro': cap_is_intro,
        'cap_parse': cap_parse_status,
        'cluster_tickers': sorted(cluster_tickers),
        'cluster_recall': len(cluster_tickers & gt),
        'cluster_fps': sorted(cluster_tickers - gt),
        'backfill_helps': backfill_helps,
        'rejected': rejected,
    }, None

def main():
    gt = load_gt()
    paths = sorted(glob.glob(LOG_PATTERN))
    print(f'Found {len(paths)} snapshot logs')
    print(f'GT covers {len(gt)} videos')

    rows = []
    fps_counter = Counter()
    short_fp_counter = Counter()  # 2-3 char FPs
    b2925da_helps_count = 0
    for p in paths:
        result, err = analyze_log(p, gt)
        if result is None:
            continue
        rows.append(result)
        fps_counter.update(result['cap_fps'])
        for fp in result['cap_fps']:
            if len(fp) <= 3:
                short_fp_counter[fp] += 1
        if result['backfill_helps']:
            b2925da_helps_count += 1

    # Write per-snapshot markdown table
    out = []
    out.append(f'# Snapshot Analysis ({len(rows)} snapshots with GT)\n')
    out.append(f'## Top-Level Stats\n')
    out.append(f'- Total snapshots analyzed: {len(rows)}')
    out.append(f'- b2925da backfill helps: {b2925da_helps_count}/{len(rows)} snapshots ({b2925da_helps_count/len(rows)*100:.0f}%)\n')

    out.append(f'## Top FPs across all snapshots (per-capture, post-b2925da)\n')
    out.append('| Ticker | Count | Length |')
    out.append('|--------|-------|--------|')
    for ticker, count in fps_counter.most_common(20):
        out.append(f'| {ticker} | {count} | {len(ticker)} |')
    out.append('')

    out.append(f'## Short FPs (length ≤ 3, would benefit from pricewords fix)\n')
    out.append('| Ticker | Count |')
    out.append('|--------|-------|')
    for ticker, count in short_fp_counter.most_common(20):
        out.append(f'| {ticker} | {count} |')
    out.append('')

    out.append(f'## Per-snapshot recall table\n')
    out.append('| Date | GT | Cap# | Cap#GT | CapRecall% | Cluster#GT | ClusterRecall% | B2925da? |')
    out.append('|------|----|------|-------|------------|------------|----------------|----------|')
    # Sort by date
    for r in sorted(rows, key=lambda x: x['vid']):
        cr_pct = r['cap_recall']/r['gt_size']*100 if r['gt_size'] else 0
        cl_pct = r['cluster_recall']/r['gt_size']*100 if r['gt_size'] else 0
        bf = 'YES' if r['backfill_helps'] else ''
        out.append(f"| {r['vid']} | {r['gt_size']} | {r['cap_count']} | {r['cap_recall']} | {cr_pct:.0f}% | {r['cluster_recall']} | {cl_pct:.0f}% | {bf} |")

    with open(OUT_FILE, 'w', encoding='utf-8') as f:
        f.write('\n'.join(out))
    print(f'Wrote {OUT_FILE}')

    # Also print to stdout
    print('\n'.join(out[:100]))  # first 100 lines

if __name__ == '__main__':
    main()
