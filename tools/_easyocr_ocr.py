"""
EasyOCR wrapper for the QMG chart-stream pipeline.
Outputs JSON with Tesseract-compatible schema: { text, lines, words[] }.
Each word has { text, left, top, width, height, conf, line } where line
groups words with similar y-coordinate.

Usage:
    python _easyocr_ocr.py <image_path> [key=value ...]

Optional tuning keys (all optional; omitting every one reproduces the original
behaviour exactly, which is what production scans rely on):

    width_ths       detector box-merge width threshold (default: EasyOCR's)
    height_ths      detector box-merge height threshold
    add_margin      extra px around each detected box before recognition
    contrast_ths    detector-side contrast boost threshold
    adjust_contrast bool: apply the contrast boost
    mag_ratio       detector-side upscale factor
    allowlist       characters the recognizer may emit, e.g. A-Z0-9.
    text_threshold  minimum box confidence to be considered text
    low_text        lower bound for linking words into lines
    link_threshold  min similarity to merge neighbouring words

Values are parsed as JSON when possible (so booleans and lists work), else as
raw strings. Unknown keys are ignored so a newer caller cannot break an older
wrapper.

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

def parse_tuning(argv):
    """Parse `key=value` pairs into a dict, JSON-decoding values when possible.

    Unknown keys pass through untouched so this wrapper stays forward-compatible
    with a caller that knows about options this version does not.
    """
    tuning = {}
    for arg in argv:
        if '=' not in arg:
            continue
        key, _, raw = arg.partition('=')
        key = key.strip()
        if not key:
            continue
        try:
            tuning[key] = json.loads(raw)
        except Exception:
            tuning[key] = raw
    return tuning

if len(sys.argv) < 2:
    print(json.dumps({"error": "usage: _easyocr_ocr.py <image_path>... [key=value ...]"}))
    sys.exit(1)

# Positional args are image paths; `key=value` args are tuning. More than one
# image switches the wrapper into batch mode (single JSON array on stdout).
_positional = []
TUNING = {}
for _arg in sys.argv[1:]:
    if '=' in _arg and not os.path.exists(_arg):
        _k, _, _v = _arg.partition('=')
        TUNING[_k.strip()] = _v
    else:
        _positional.append(_arg)
# Re-parse tuning values as JSON where possible (booleans, numbers, lists).
for _k, _v in list(TUNING.items()):
    try:
        TUNING[_k] = json.loads(_v)
    except Exception:
        pass

image_paths = _positional
if not image_paths:
    print(json.dumps({"error": "usage: _easyocr_ocr.py <image_path>... [key=value ...]"}))
    sys.exit(1)

batch_mode = len(image_paths) > 1
if batch_mode:
    log(f"Batch mode: {len(image_paths)} image(s), one model load")

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

    # Detection/recognition tuning. Only keys the caller actually passed are
    # forwarded, so EasyOCR's own defaults apply to everything else.
    read_kwargs = {'detail': 1}
    _PASSTHROUGH = (
        'width_ths', 'height_ths', 'add_margin', 'contrast_ths',
        'adjust_contrast', 'mag_ratio', 'allowlist', 'text_threshold',
        'low_text', 'link_threshold',
    )
    for _key in _PASSTHROUGH:
        if _key in TUNING:
            read_kwargs[_key] = TUNING[_key]
    if read_kwargs.get('allowlist'):
        # A caller restricting the charset means exactly that: drop every
        # character outside it, so the recognizer cannot reintroduce them.
        _allowed = set(str(read_kwargs['allowlist']))
        read_kwargs['allowlist'] = ''.join(sorted(_allowed))

    if len(read_kwargs) > 1:
        log(f"readtext tuning: { {k: v for k, v in read_kwargs.items() if k != 'detail'} }")

    def ocr_one(path):
        """OCR a single image and shape it into the parser's schema."""
        t0 = time.time()
        try:
            raw = _READER.readtext(path, **read_kwargs)
        except TypeError as exc:
            # An option this EasyOCR build does not accept must not sink the
            # scan: retry with defaults and say so on stderr.
            log(f"readtext rejected tuning ({exc}); retrying {path} with defaults")
            raw = _READER.readtext(path, detail=1)
        log(f"OCR {os.path.basename(path)} took {time.time()-t0:.1f}s, {len(raw)} detections")

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
            })

        # Group words into lines by center_y proximity.
        words.sort(key=lambda w: (w["top"] + w["height"] / 2, w["left"]))
        line_anchors = []
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

        return {
            "text": "\n".join(lines),
            "lines": lines,
            "words": words,
            "_engine": "easyocr",
            "_image": os.path.basename(path),
            "_detection_count": len(words),
        }

    # One image -> a single JSON object on stdout (the original contract, kept
    # so every existing caller is unaffected).
    #
    # Many images -> ONE JSON ARRAY on stdout, in request order. This is the
    # whole point: EasyOCR loads a ~80MB model per process, so one-spawn-per-
    # frame spent more time loading than reading. Batch mode loads once and
    # then costs only recognition time per image. A single failing image yields
    # an {"error": ...} entry at its index rather than aborting the batch.
    results = []
    for path in image_paths:
        if not os.path.exists(path):
            results.append({"error": f"file not found: {path}", "_image": os.path.basename(path)})
            continue
        try:
            results.append(ocr_one(path))
        except Exception as exc:  # keep going; one bad frame must not kill the batch
            import traceback
            log(f"ERROR on {path}: {exc}")
            results.append({
                "error": str(exc),
                "_image": os.path.basename(path),
                "traceback": traceback.format_exc(),
            })

    if batch_mode:
        print(json.dumps(results))
    else:
        print(json.dumps(results[0]))
except Exception as e:
    import traceback
    log(f"ERROR: {e}")
    log(traceback.format_exc())
    print(json.dumps({"error": str(e), "traceback": traceback.format_exc()}))
    sys.exit(1)
