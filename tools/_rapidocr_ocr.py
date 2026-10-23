"""
RapidOCR wrapper for the QMG chart-stream pipeline.

Outputs JSON with the SAME schema as _easyocr_ocr.py:
    { text, lines, words[{text,left,top,width,height,conf,line}],
      _engine, _image, _detection_count }

so src/ocr/easyocrAdapter.js needs no special case for it.

WHY A SECOND ENGINE
EasyOCR's errors on the position list are STABLE: the same pixels give the
same mis-reading at every scale and every resampling, because the
information is not in the picture. A second opinion from the SAME
recogniser cannot fix that — only a second RECOGNISER can, because
RapidOCR runs PP-OCR's detector and recogniser, a different architecture
that fails in different places.

That is the whole point of a second engine here: not more readings, but
DIFFERENT readings. The decoder (src/normalize/tickerDecode.js) then picks
the ticker both engines agree on, and falls back to the confident one when
the other is silent.

Usage:
    python _rapidocr_ocr.py <image_path>... [key=value ...]

Optional tuning keys (all optional):

    allowlist       characters the recogniser may emit, e.g. A-Z0-9.
    use_det         bool: run the text detector (default true). False
                    recognises the whole image as one box, which is what
                    the caller wants when it already knows where the text
                    is — the detector's box merging drops the leading
                    letter of a 6px-tall ticker ("FCX" -> "KX").
    det_box_thresh  detector box score threshold
    det_limit_side_len  detector input side limit
    use_angle_cls   bool: use the angle classifier
    drop_score      minimum score for a detection to be kept

Values are parsed as JSON when possible, else as raw strings. Unknown keys
are ignored so a newer caller cannot break an older wrapper.

Output: JSON to stdout (a single object for one image, an array for many).
"""

import sys
import json
import time
import os
import traceback

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        try:
            _stream.reconfigure(encoding='utf-8')
        except Exception:
            pass


def log(msg):
    print(f"[rapidocr] {msg}", file=sys.stderr, flush=True)


def parse_tuning(argv):
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
    print(json.dumps({"error": "usage: _rapidocr_ocr.py <image_path>... [key=value ...]"}))
    sys.exit(1)

_positional = []
TUNING = {}
for _arg in sys.argv[1:]:
    if '=' in _arg and not os.path.exists(_arg):
        _k, _, _v = _arg.partition('=')
        TUNING[_k.strip()] = _v
    else:
        _positional.append(_arg)
for _k, _v in list(TUNING.items()):
    try:
        TUNING[_k] = json.loads(_v)
    except Exception:
        pass

image_paths = _positional
if not image_paths:
    print(json.dumps({"error": "usage: _rapidocr_ocr.py <image_path>... [key=value ...]"}))
    sys.exit(1)

batch_mode = len(image_paths) > 1
if batch_mode:
    log(f"Batch mode: {len(image_paths)} image(s), one model load")

# Same line-grouping tolerance as the EasyOCR wrapper, so the two engines
# produce comparable line ids.
LINE_TOLERANCE_PX = 15

try:
    from rapidocr_onnxruntime import RapidOCR

    global _ENGINE
    try:
        _ENGINE
    except NameError:
        log("Loading RapidOCR (PP-OCRv3 ONNX models)...")
        t0 = time.time()
        _ENGINE = RapidOCR()
        log(f"RapidOCR loaded in {time.time()-t0:.1f}s")

    # The engine's own call signature differs between rapidocr v1 and v2.
    # v1: engine(img, **kwargs) -> (result, elapse)
    # v2: engine(img, **kwargs) -> result, where result has .txts/.boxes/.scores
    def _call(img, kwargs):
        out = _ENGINE(img, **kwargs)
        if isinstance(out, tuple):
            result = out[0]
        else:
            result = out
        if result is None:
            return []
        # v2 returns an object with attributes rather than a list of rows.
        if hasattr(result, 'txts'):
            boxes = getattr(result, 'boxes', None) or []
            txts = getattr(result, 'txts', None) or []
            scores = getattr(result, 'scores', None) or []
            return [[boxes[i], txts[i], scores[i]] for i in range(len(txts))]
        return result

    _use_det = bool(TUNING.get('use_det', True))
    _allowlist = TUNING.get('allowlist')
    if _allowlist:
        # A caller restricting the charset means exactly that: drop every
        # character outside it, so the recogniser cannot reintroduce them.
        _allowed = set(str(_allowlist))
        _allowlist = ''.join(sorted(_allowed))

    _kwargs = {}
    if not _use_det:
        _kwargs['use_det'] = False
    if _allowlist:
        _kwargs['rec_char_dict_path'] = None  # placeholder; handled by filtering below
    for _key in ('det_box_thresh', 'det_limit_side_len', 'use_angle_cls', 'drop_score'):
        if _key in TUNING:
            _kwargs[_key] = TUNING[_key]

    def ocr_one(path):
        t0 = time.time()
        raw = _call(path, _kwargs)
        log(f"OCR {os.path.basename(path)} took {time.time()-t0:.1f}s, {len(raw)} detections")

        words = []
        for row in raw:
            try:
                box, text, score = row[0], row[1], row[2]
            except Exception:
                continue
            text = str(text)
            if _allowlist:
                text = ''.join(ch for ch in text if ch in _allowlist)
                if not text:
                    continue
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            words.append({
                "text": text,
                "left": float(min(xs)),
                "top": float(min(ys)),
                "width": float(max(xs) - min(xs)),
                "height": float(max(ys) - min(ys)),
                "conf": float(score),
            })

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
            "_engine": "rapidocr",
            "_image": os.path.basename(path),
            "_detection_count": len(words),
        }

    results = []
    for path in image_paths:
        if not os.path.exists(path):
            results.append({"error": f"file not found: {path}", "_image": os.path.basename(path)})
            continue
        try:
            results.append(ocr_one(path))
        except Exception as exc:
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
    log(f"ERROR: {e}")
    log(traceback.format_exc())
    print(json.dumps({"error": str(e), "traceback": traceback.format_exc()}))
    sys.exit(1)
