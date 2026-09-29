"""
EasyOCR wrapper for the QMG chart-stream pipeline.
Outputs JSON with Tesseract-compatible schema: { text, lines, words[] }.
Each word has { text, left, top, width, height, conf, line } where line
groups words with similar y-coordinate.

Usage:
    python _easyocr_ocr.py <image_path>

Output: JSON to stdout.
"""

import sys
import json
import time
import os

# Force UTF-8 to handle Unicode in EasyOCR's progress bar
if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
if hasattr(sys.stderr, 'reconfigure'):
    try:
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

def log(msg):
    print(f"[easyocr] {msg}", file=sys.stderr, flush=True)

if len(sys.argv) < 2:
    print(json.dumps({"error": "usage: _easyocr_ocr.py <image_path>"}))
    sys.exit(1)

image_path = sys.argv[1]
if not os.path.exists(image_path):
    print(json.dumps({"error": f"file not found: {image_path}"}))
    sys.exit(1)

# Line grouping tolerance (px): words with center_y within this distance are on
# the same line. 15 px handles EasyOCR's natural word-center jitter on a
# 1080p-frame crop without merging adjacent rows.
LINE_TOLERANCE_PX = 15

try:
    import easyocr
    # Reader is module-global so subsequent calls reuse the loaded model
    # (EasyOCR's Reader() is expensive — model load is ~3-5s + ~80MB RAM).
    global _READER
    try:
        _READER
    except NameError:
        log("Loading EasyOCR (first run downloads models)...")
        t0 = time.time()
        _READER = easyocr.Reader(['en'], gpu=False, verbose=False)
        log(f"EasyOCR loaded in {time.time()-t0:.1f}s")

    log(f"Running OCR on {image_path}...")
    t0 = time.time()
    raw = _READER.readtext(image_path, detail=1)
    log(f"OCR took {time.time()-t0:.1f}s, {len(raw)} detections")

    # Convert EasyOCR output to Tesseract-like schema.
    # bbox is [[x1,y1],[x2,y2],[x3,y3],[x4,y4]] — quad polygon.
    words = []
    for bbox, text, conf in raw:
        xs = [p[0] for p in bbox]
        ys = [p[1] for p in bbox]
        words.append({
            "text": text,
            "left": float(min(xs)),
            "top": float(min(ys)),
            "width": float(max(xs) - min(xs)),
            "height": float(max(ys) - min(ys)),
            "conf": float(conf),
            # line assigned below
        })

    # Group words into lines by center_y proximity.
    words.sort(key=lambda w: (w["top"] + w["height"] / 2, w["left"]))
    line_anchors = []  # list of center_y for each line
    for w in words:
        cy = w["top"] + w["height"] / 2
        line_idx = None
        for i, anchor in enumerate(line_anchors):
            if abs(cy - anchor) <= LINE_TOLERANCE_PX:
                line_idx = i
                break
        if line_idx is None:
            line_anchors.append(cy)
            line_idx = len(line_anchors) - 1
        w["line"] = line_idx

    # Build lines array (joined text per line, in line order, left-to-right)
    n_lines = len(line_anchors)
    line_words = [[] for _ in range(n_lines)]
    for w in words:
        line_words[w["line"]].append(w)
    lines = []
    for li in range(n_lines):
        sorted_w = sorted(line_words[li], key=lambda x: x["left"])
        lines.append(" ".join(w["text"] for w in sorted_w))

    # Full text: lines joined by newline
    text = "\n".join(lines)

    output = {
        "text": text,
        "lines": lines,
        "words": words,
        # Meta for downstream diagnostics
        "_engine": "easyocr",
        "_image": os.path.basename(image_path),
        "_detection_count": len(words),
    }
    print(json.dumps(output))
except Exception as e:
    import traceback
    log(f"ERROR: {e}")
    log(traceback.format_exc())
    print(json.dumps({"error": str(e), "traceback": traceback.format_exc()}))
    sys.exit(1)
