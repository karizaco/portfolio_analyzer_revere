"""Batch-split + left/right EasyOCR for Clement Daily Market Plan images.

Low resource:
  - one image at a time (no parallel workers)
  - OMP/MKL threads = 1
  - EasyOCR gpu=False
  - resize halves to max width 1100 before OCR
  - skip stems that already have _LEFT.txt (resume-safe)

Usage:
  py -3 tools/clementBatchDashboardOcr.py
  py -3 tools/clementBatchDashboardOcr.py --limit 5
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from pathlib import Path

os.environ['OMP_NUM_THREADS'] = '1'
os.environ['MKL_NUM_THREADS'] = '1'
os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['NUMEXPR_NUM_THREADS'] = '1'
os.environ['KMP_DUPLICATE_LIB_OK'] = 'TRUE'
# discourage GPU
os.environ['CUDA_VISIBLE_DEVICES'] = ''

import numpy as np
from PIL import Image

ROOT = Path('.').resolve()
MEDIA = ROOT / 'data/discord_pipeline/media/clement'
OUT = MEDIA / 'ocr_split_batch'
OUT.mkdir(parents=True, exist_ok=True)
PROGRESS = OUT / 'progress.jsonl'


def find_vertical_split(img: Image.Image) -> dict:
    a = np.asarray(img.convert('RGB'))
    h, w, _ = a.shape
    mn = a.mean(axis=2)
    white_frac = (mn > 240).mean(axis=0)
    chstd = a.std(axis=2).mean(axis=0)
    midgray = ((mn > 170) & (mn < 230) & (chstd < 18)).mean(axis=0)
    b_dom = ((a[:, :, 2].astype(np.int16) - a[:, :, 0].astype(np.int16)) > 20).mean(axis=0)
    k = 21
    ker = np.ones(k) / k
    white_s = np.convolve(white_frac, ker, mode='same')
    gray_s = np.convolve(midgray, ker, mode='same')
    blue_s = np.convolve(b_dom, ker, mode='same')
    lo, hi = int(w * 0.35), int(w * 0.72)
    split_white = lo + int(white_s[lo:hi].argmax())
    best = None
    for x in range(lo, hi, 2):
        s = float(gray_s[:x].mean() + blue_s[x:].mean() + 0.75 * white_s[max(0, x - 8):x + 8].mean())
        if best is None or s > best[0]:
            best = (s, x)
    if float(white_s[split_white]) >= 0.85:
        split_x, method = split_white, 'white_gutter'
    else:
        split_x, method = best[1], 'gray_left_blue_right'
    split_x = int(max(w * 0.30, min(w * 0.70, split_x)))
    return {
        'width': w, 'height': h, 'split_x': split_x,
        'split_frac': round(split_x / w, 4), 'method': method,
        'white_at_split': round(float(white_frac[split_x]), 4),
    }


def crop_halves(img: Image.Image, split_x: int, gutter: int = 10):
    w, h = img.size
    left = img.crop((0, 0, max(1, split_x - gutter), h))
    right = img.crop((min(w - 1, split_x + gutter), 0, w, h))
    return left, right


def resize_max_w(img: Image.Image, max_w: int = 1100) -> Image.Image:
    w, h = img.size
    if w <= max_w:
        return img
    return img.resize((max_w, int(h * max_w / w)), Image.Resampling.LANCZOS)


def file_md5(path: Path) -> str:
    h = hashlib.md5()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def ocr_pil(reader, img: Image.Image, tmp: Path) -> dict:
    img.save(tmp)
    try:
        raw = reader.readtext(str(tmp), detail=1, paragraph=False)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    lines, confs = [], []
    for item in raw:
        text = str(item[1]).strip() if len(item) > 1 else ''
        conf = float(item[2]) if len(item) > 2 else None
        if text:
            lines.append({'text': text, 'conf': conf})
            if conf is not None:
                confs.append(conf)
    text = '\n'.join(l['text'] for l in lines)
    return {
        'text': text,
        'line_count': len(lines),
        'mean_conf': round(sum(confs) / len(confs), 4) if confs else None,
    }


def list_targets(limit: int | None):
    rows = [json.loads(l) for l in (MEDIA / 'manifest.jsonl').read_text(encoding='utf-8').splitlines() if l.strip()]
    large = [
        r for r in rows
        if (r.get('width') or 0) >= 2800 and (r.get('height') or 0) >= 2000
    ]
    # prefer unique message dashboards: keep largest attachment per message if multiple
    by_msg = {}
    for r in large:
        mid = str(r.get('message_id') or '')
        area = (r.get('width') or 0) * (r.get('height') or 0)
        prev = by_msg.get(mid)
        if prev is None or area > (prev.get('width') or 0) * (prev.get('height') or 0):
            by_msg[mid] = r
    out = sorted(by_msg.values(), key=lambda r: r.get('posted_at') or '')
    if limit:
        out = out[:limit]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--sleep', type=float, default=0.5, help='pause between images')
    args = ap.parse_args()

    targets = list_targets(args.limit or None)
    print(f'targets={len(targets)} out={OUT}', flush=True)

    import easyocr
    print('loading easyocr (cpu, single-thread)...', flush=True)
    reader = easyocr.Reader(['en'], gpu=False, verbose=False)
    print('ready', flush=True)

    done = skipped = failed = 0
    for i, row in enumerate(targets, 1):
        rel = row['local_path']
        path = ROOT / rel
        stem = path.stem
        left_txt = OUT / f'{stem}_LEFT.txt'
        if left_txt.exists() and (OUT / f'{stem}_RIGHT.txt').exists() and (OUT / f'{stem}_meta.json').exists():
            print(f'[{i}/{len(targets)}] SKIP {stem}', flush=True)
            skipped += 1
            continue
        if not path.exists():
            print(f'[{i}/{len(targets)}] MISSING {rel}', flush=True)
            failed += 1
            continue
        t0 = time.time()
        try:
            md5 = file_md5(path)
            img = Image.open(path)
            split = find_vertical_split(img)
            left, right = crop_halves(img, split['split_x'], 10)
            left.save(OUT / f'{stem}_LEFT.png')
            right.save(OUT / f'{stem}_RIGHT.png')
            left_ocr = ocr_pil(reader, resize_max_w(left), OUT / f'_tmp_L_{os.getpid()}.png')
            right_ocr = ocr_pil(reader, resize_max_w(right), OUT / f'_tmp_R_{os.getpid()}.png')
            (OUT / f'{stem}_LEFT.txt').write_text(left_ocr['text'], encoding='utf-8')
            (OUT / f'{stem}_RIGHT.txt').write_text(right_ocr['text'], encoding='utf-8')
            meta = {
                'file': rel.replace('\\', '/'),
                'md5': md5,
                'posted_at': row.get('posted_at'),
                'message_id': row.get('message_id'),
                'attachment_id': row.get('attachment_id'),
                'split': split,
                'left': {'line_count': left_ocr['line_count'], 'mean_conf': left_ocr['mean_conf']},
                'right': {'line_count': right_ocr['line_count'], 'mean_conf': right_ocr['mean_conf']},
                'elapsed_s': round(time.time() - t0, 1),
            }
            (OUT / f'{stem}_meta.json').write_text(json.dumps(meta, indent=2), encoding='utf-8')
            with PROGRESS.open('a', encoding='utf-8') as fh:
                fh.write(json.dumps(meta) + '\n')
            done += 1
            print(
                f'[{i}/{len(targets)}] OK {stem} split={split["split_frac"]} '
                f'L={left_ocr["line_count"]} R={right_ocr["line_count"]} {meta["elapsed_s"]}s',
                flush=True,
            )
        except Exception as exc:
            failed += 1
            print(f'[{i}/{len(targets)}] FAIL {stem} {type(exc).__name__}: {exc}', flush=True)
        time.sleep(max(0.0, args.sleep))

    # write summary index for build tool (compatible with split_summary.json shape)
    summary = []
    for meta_path in sorted(OUT.glob('*_meta.json')):
        summary.append(json.loads(meta_path.read_text(encoding='utf-8')))
    (OUT / 'split_summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    print(json.dumps({'done': done, 'skipped': skipped, 'failed': failed, 'total_meta': len(summary)}, indent=2), flush=True)


if __name__ == '__main__':
    main()
