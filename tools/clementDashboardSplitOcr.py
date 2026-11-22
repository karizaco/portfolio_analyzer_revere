"""Split Clement Daily Market Plan dashboards and OCR left vs right.

Layout (human-verified):
  - Left ~gray cells: Market Trend, commentary, Primary Watchlist body
  - Right ~blue/white tables: S&P Sub-Market / Sub-Sector monitor
  - Split at vertical white gutter (~42% width on 2989px plans)
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

import numpy as np
from PIL import Image

os.environ.setdefault('OMP_NUM_THREADS', '1')
os.environ.setdefault('MKL_NUM_THREADS', '1')
os.environ.setdefault('KMP_DUPLICATE_LIB_OK', 'TRUE')

ROOT = Path('.').resolve()
OUT = ROOT / 'data/discord_pipeline/media/clement/ocr_split_probe'
OUT.mkdir(parents=True, exist_ok=True)


def find_vertical_split(img: Image.Image) -> dict:
    """Return split_x separating left content from right monitor tables."""
    rgb = img.convert('RGB')
    a = np.asarray(rgb)
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
    # Primary: whitest column in mid band (gutter)
    split_white = lo + int(white_s[lo:hi].argmax())

    # Secondary: maximize left-gray + right-blue + local white
    best = None
    for x in range(lo, hi, 2):
        pad = white_s[max(0, x - 8): x + 8].mean()
        s = float(gray_s[:x].mean() + blue_s[x:].mean() + 0.75 * pad)
        if best is None or s > best[0]:
            best = (s, x)
    split_struct = best[1]

    # Prefer white peak if very white; else structural
    if float(white_s[split_white]) >= 0.85:
        split_x = split_white
        method = 'white_gutter'
    else:
        split_x = split_struct
        method = 'gray_left_blue_right'

    # Clamp away from edges
    split_x = int(max(w * 0.30, min(w * 0.70, split_x)))
    return {
        'width': w,
        'height': h,
        'split_x': split_x,
        'split_frac': round(split_x / w, 4),
        'method': method,
        'white_at_split': round(float(white_frac[split_x]), 4),
        'white_peak_x': int(split_white),
        'struct_x': int(split_struct),
        'struct_score': round(float(best[0]), 4),
    }


def crop_halves(img: Image.Image, split_x: int, gutter: int = 8):
    w, h = img.size
    left = img.crop((0, 0, max(1, split_x - gutter), h))
    right = img.crop((min(w - 1, split_x + gutter), 0, w, h))
    return left, right


def resize_max_w(img: Image.Image, max_w: int = 1200) -> Image.Image:
    w, h = img.size
    if w <= max_w:
        return img
    nh = int(h * (max_w / w))
    return img.resize((max_w, nh), Image.Resampling.LANCZOS)


def ocr_image(reader, img: Image.Image) -> dict:
    import tempfile
    tmp = OUT / f'_tmp_{os.getpid()}_{id(img)}.png'
    img.save(tmp)
    try:
        raw = reader.readtext(str(tmp), detail=1, paragraph=False)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    lines = []
    confs = []
    for item in raw:
        text = str(item[1]).strip() if len(item) > 1 else ''
        conf = float(item[2]) if len(item) > 2 else None
        if text:
            lines.append({'text': text, 'conf': conf})
            if conf is not None:
                confs.append(conf)
    text = '\n'.join(l['text'] for l in lines)
    return {
        'lines': lines,
        'text': text,
        'line_count': len(lines),
        'mean_conf': round(sum(confs) / len(confs), 4) if confs else None,
    }


def classify_snippets(text: str) -> dict:
    t = text or ''
    return {
        'has_daily_market_plan': bool(re.search(r'daily\s+market\s+plan', t, re.I)),
        'has_market_trend': bool(re.search(r'market\s+trend', t, re.I)),
        'has_primary_watchlist': bool(re.search(r'primary\s+watchlist', t, re.I)),
        'has_sub_market': bool(re.search(r'sub[- ]?market', t, re.I)),
        'has_sub_sector': bool(re.search(r'sub[- ]?sector', t, re.I)),
        'has_situational': bool(re.search(r'situational', t, re.I)),
        'yes_count': len(re.findall(r'\bYES\b', t)),
        'no_count': len(re.findall(r'\bNO\b', t)),
        'sector_codes': sorted(set(re.findall(r'\bX[A-Z]{2}\b', t))),
        'metal_miners_phrase': bool(re.search(r'metal\s+miners', t, re.I)),
        'focus_themes': bool(re.search(r'focus\s+themes?|focus\s+list', t, re.I)),
    }


def main():
    paths = [
        ROOT / 'data/discord_pipeline/media/clement/20260109_1459019777577058314_1459019777337987132.png',
        ROOT / 'data/discord_pipeline/media/clement/20251204_1445979039138578522_1445979038886789200.png',
    ]
    print('loading easyocr...')
    import easyocr
    reader = easyocr.Reader(['en'], gpu=False, verbose=False)
    print('ready')

    results = []
    for path in paths:
        if not path.exists():
            print('MISSING', path)
            continue
        img = Image.open(path)
        meta = find_vertical_split(img)
        left, right = crop_halves(img, meta['split_x'], gutter=10)
        # save crops
        stem = path.stem
        left_path = OUT / f'{stem}_LEFT.png'
        right_path = OUT / f'{stem}_RIGHT.png'
        left.save(left_path)
        right.save(right_path)

        left_r = resize_max_w(left, 1100)
        right_r = resize_max_w(right, 1100)
        print(f'--- {path.name} split_x={meta["split_x"]} ({meta["split_frac"]}) method={meta["method"]} ---', flush=True)
        print(' OCR LEFT', left_r.size, flush=True)
        left_ocr = ocr_image(reader, left_r)
        print('  lines', left_ocr['line_count'], 'mean_conf', left_ocr['mean_conf'], flush=True)
        print(' OCR RIGHT', right_r.size, flush=True)
        right_ocr = ocr_image(reader, right_r)
        print('  lines', right_ocr['line_count'], 'mean_conf', right_ocr['mean_conf'], flush=True)

        left_cls = classify_snippets(left_ocr['text'])
        right_cls = classify_snippets(right_ocr['text'])
        rec = {
            'file': str(path.relative_to(ROOT)).replace('\\', '/'),
            'split': meta,
            'left_crop': str(left_path.relative_to(ROOT)).replace('\\', '/'),
            'right_crop': str(right_path.relative_to(ROOT)).replace('\\', '/'),
            'left': {**left_cls, 'line_count': left_ocr['line_count'], 'mean_conf': left_ocr['mean_conf'], 'text': left_ocr['text']},
            'right': {**right_cls, 'line_count': right_ocr['line_count'], 'mean_conf': right_ocr['mean_conf'], 'text': right_ocr['text']},
        }
        results.append(rec)
        (OUT / f'{stem}_LEFT.txt').write_text(left_ocr['text'], encoding='utf-8')
        (OUT / f'{stem}_RIGHT.txt').write_text(right_ocr['text'], encoding='utf-8')
        print(' LEFT flags', {k: v for k, v in left_cls.items() if v}, flush=True)
        print(' RIGHT flags', {k: v for k, v in right_cls.items() if v}, flush=True)

    (OUT / 'split_summary.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    print('DONE', OUT)


if __name__ == '__main__':
    main()
