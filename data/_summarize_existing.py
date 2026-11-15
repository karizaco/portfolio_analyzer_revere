"""Aggregate existing per-video probe logs under <base>/<prefix><date>/
against data/qmg_ground_truth.json to compute per-video recall / FP counts.

Usage:
    py -3 data/_summarize_existing.py [base_dir] [prefix] [date1 date2 ...]

Defaults:
    base_dir = data/video_scan_test/_rerun
    prefix   = rerun_
    targets  = the 6 README "validated" GT dates

If <prefix> is "-" the script globs base/**/ocr_probe/logs/*_<date>_*_snapshot.json
instead of looking for <base>/<prefix><date>/ subdirectories. This is used
for the legacy baseline where probe logs were dropped directly under
<run-tag>/<run-tag>/ocr_probe/logs/.
"""
import json
import sys
from pathlib import Path

ROOT = Path('.').resolve()
GT_PATH = ROOT / 'data' / 'qmg_ground_truth.json'
SCAN_ROOT = ROOT / 'data' / 'video_scan_test' / '_rerun'

def parse_gt(entry):
    if not entry:
        return []
    if isinstance(entry, list):
        return [str(t).upper() for t in entry]
    if isinstance(entry, dict) and isinstance(entry.get('tickers'), list):
        return [str(t).upper() for t in entry['tickers']]
    return []

def summarize_dir(date_dir: Path, gt_list):
    """Find the first probe log in <date_dir>/ocr_probe/logs and compute recall."""
    logs_dir = date_dir / 'ocr_probe' / 'logs'
    if not logs_dir.exists():
        return None
    logs = sorted(logs_dir.glob('*_snapshot.json'))
    if not logs:
        return None
    log = json.loads(logs[0].read_text(encoding='utf-8'))
    captures = log.get('captures') or []
    all_tickers = set()
    correct = set()
    gt_set = set(gt_list)
    for c in captures:
        for t in c.get('tickers') or []:
            up = str(t).upper()
            all_tickers.add(up)
            if up in gt_set:
                correct.add(up)
    fps = len(all_tickers - gt_set)
    return {
        'captures': len(captures),
        'tickers': sorted(all_tickers),
        'correct': sorted(correct),
        'gt': gt_list,
        'recall_pct': round(len(correct) / max(len(gt_list), 1) * 100),
        'fps': fps,
    }

def summarize_log_blob(log: dict, gt_list: list) -> dict:
    captures = log.get('captures') or []
    all_tickers = set()
    correct = set()
    gt_set = set(gt_list)
    for c in captures:
        for t in c.get('tickers') or []:
            up = str(t).upper()
            all_tickers.add(up)
            if up in gt_set:
                correct.add(up)
    fps = len(all_tickers - gt_set)
    return {
        'captures': len(captures),
        'correct': sorted(correct),
        'recall_pct': round(len(correct) / max(len(gt_list), 1) * 100),
        'fps': fps,
    }

def main():
    gt = json.loads(GT_PATH.read_text(encoding='utf-8'))
    base = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 and sys.argv[1] != '-' else SCAN_ROOT
    prefix = sys.argv[2] if len(sys.argv) > 2 else 'rerun_'
    targets = sys.argv[3:] if len(sys.argv) > 3 else ['20220606', '20220607', '20220608', '20220614', '20221117', '20230126']
    print(f'Base: {base}')
    print(f'Prefix: {prefix}')
    print(f'Date       | GT | Rec | FP | Captures | Correct (in GT)')
    print('-----------|----|-----|----|----------|----------------')
    total_correct = total_gt = total_fp = total_captures = 0
    for d in targets:
        gt_entry = gt.get(d)
        if not gt_entry:
            print(f'{d}: NOT IN GT')
            continue
        first_key = sorted(gt_entry.keys())[0]
        gt_list = parse_gt(gt_entry[first_key])
        result = None
        if prefix != '-':
            date_dir = base / f'{prefix}{d}'
            result = summarize_dir(date_dir, gt_list)
        if result is None:
            # Fallback: glob base/**/ocr_probe/logs/*_<date>_*_snapshot.json
            candidates = list(base.glob(f'**/ocr_probe/logs/*_{d}_*_snapshot.json'))
            if candidates:
                log = json.loads(candidates[0].read_text(encoding='utf-8'))
                result = summarize_log_blob(log, gt_list)
        if result is None:
            print(f'{d}: NO PROBE LOG')
            continue
        total_correct += len(result['correct'])
        total_gt += len(gt_list)
        total_fp += result['fps']
        total_captures += result['captures']
        correct_str = ','.join(result['correct']) if result['correct'] else '-'
        print(f"{d} | {len(gt_list):2} | {result['recall_pct']:3}% | {result['fps']:2} | {result['captures']:8} | {correct_str}")
    print('-----------|----|-----|----|----------')
    recall = round(total_correct / max(total_gt, 1) * 100)
    print(f'TOTAL      | {total_gt:2} | {recall:3}% | {total_fp:2} | {total_captures:8}')

if __name__ == '__main__':
    main()