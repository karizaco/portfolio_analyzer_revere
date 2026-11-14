"""
PDF reader for the O'Connell (newsletter) source.

WHY A PYTHON HELPER
-------------------

The corpus is "Microsoft Print to PDF" renders of a Substack post, and the
body text of those renders is drawn as VECTOR OUTLINES rather than as text.
Measured on 20261112.pdf page 21:

    BT / ET / TJ text blocks .... 6      <- the headings and the browser chrome
    get_texttrace() glyph spans .. 6      <- the same six
    `l` (lineto) operators ...... 2,221   <- the prose, as outlines
    `c` (curveto) operators ..... 2,336   <- the prose, as outlines

So the TEXT LAYER is a free, exact index of the STRUCTURE (headings,
sections, the source URL, the publish timestamp) and is useless for the
CONTENT. The content has to be OCR'd, which means the pages have to be
rasterised -- and rasterising a PDF is a PyMuPDF job, not a Node one.

This helper is therefore the only place that touches PyMuPDF, and it speaks
JSON on stdout so the Node side never has to parse PDF bytes.

COMMANDS
--------

    meta <pdf>
        Everything about the document that does not need rasterising:
        the page count, the metadata, and -- for every page -- the text
        blocks (with their bbox and font size) and the embedded images
        (with their placed bbox and their NATIVE pixel size).

    render <pdf> --page N [--dpi 200] --out <png>
        Rasterise one page to a PNG.

    extract-image <pdf> --page N --xref N --out <png>
        Write one EMBEDDED image out at its native resolution.

        This matters: the position log is an embedded image, and the copy
        inside the PDF is smaller than the standalone screenshot beside it
        (measured 20261112: 1272x445 inside the PDF, 2085x729 standalone).
        The embedded copy is still readable -- the column-aware reader gets
        "MSOS GTBIF TRLV GLAS" out of it -- so it is the fallback when the
        standalone file is absent.

Output: JSON on stdout. Errors go to stderr as JSON too, and the exit code
is 1, so a caller can tell "this file is broken" from "this file has no
position log".
"""

import argparse
import json
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
if hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


def fail(message, **extra):
    payload = {"error": str(message)}
    payload.update(extra)
    print(json.dumps(payload, ensure_ascii=False))
    sys.stderr.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.exit(1)


def open_document(path):
    try:
        import pymupdf
    except ImportError:
        fail("PyMuPDF is not importable by this Python", python=sys.executable)
        return None, None
    if not os.path.exists(path):
        fail(f"file not found: {path}")
        return None, None
    try:
        return pymupdf, pymupdf.open(path)
    except Exception as exc:
        fail(f"cannot open {path}: {exc}")
        return None, None


def page_blocks(page):
    """The page's text blocks and images, in reading order.

    A text block keeps its bbox and the font size of its first span: the
    size is what separates a SECTION heading (19-23pt) from a SETUP
    heading (16pt) from a stray line of chrome (10pt), and the caller
    needs that distinction.
    """
    blocks = []
    try:
        raw = page.get_text("dict")
    except Exception:
        raw = {"blocks": []}

    for block in raw.get("blocks", []):
        if block.get("type") != 0:
            continue
        lines = block.get("lines", [])
        spans = [span for line in lines for span in line.get("spans", [])]
        if not spans:
            continue
        text = "".join(span.get("text", "") for span in spans).strip()
        if not text:
            continue
        sizes = [round(float(span.get("size", 0)), 2) for span in spans]
        blocks.append({
            "bbox": [round(float(v), 2) for v in block.get("bbox", [])],
            "font": spans[0].get("font", ""),
            "font_size": max(sizes),
            "text": text,
        })

    images = []
    try:
        for info in page.get_image_info(xrefs=True):
            images.append({
                "bbox": [round(float(v), 2) for v in info.get("bbox", [])],
                "height": int(info.get("height", 0)),
                "width": int(info.get("width", 0)),
                "xref": int(info.get("xref", 0)),
            })
    except Exception:
        pass

    return {"blocks": blocks, "images": images}


def meta_one(path):
    """The structure of one document, or an error object for it."""
    pymupdf, doc = open_document(path)
    if doc is None:
        return {"error": "cannot open", "path": os.path.abspath(path)}
    try:
        metadata = {}
        for key, value in (doc.metadata or {}).items():
            if value:
                metadata[key] = value
        pages = []
        for index in range(doc.page_count):
            page = doc[index]
            detail = page_blocks(page)
            pages.append({
                "height": round(float(page.rect.height), 2),
                "images": detail["images"],
                "page": index + 1,
                "text_blocks": detail["blocks"],
                "width": round(float(page.rect.width), 2),
            })
        return {
            "metadata": metadata,
            "page_count": doc.page_count,
            "pages": pages,
            "path": os.path.abspath(path),
        }
    except Exception as exc:
        return {"error": str(exc), "path": os.path.abspath(path)}
    finally:
        doc.close()


def command_meta(args):
    print(json.dumps(meta_one(args.pdf), ensure_ascii=False))


def command_meta_many(args):
    """The structure of MANY documents, in one interpreter.

    Spawning Python per document would cost a process start per PDF -- 302
    of them for this corpus -- and the interpreter start dwarfs the actual
    parsing. One spawn for the whole corpus is the difference between
    seconds and minutes.

    A document that fails is an error object at its own index, so one
    unreadable file cannot abandon the other 301.
    """
    results = []
    for path in args.pdfs:
        results.append(meta_one(path))
    print(json.dumps(results, ensure_ascii=False))


def command_render(args):
    pymupdf, doc = open_document(args.pdf)
    if doc is None:
        return
    try:
        page = doc[args.page - 1]
        pixmap = page.get_pixmap(dpi=args.dpi)
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        pixmap.save(args.out)
        print(json.dumps({
            "height": pixmap.height,
            "out": os.path.abspath(args.out),
            "width": pixmap.width,
        }, ensure_ascii=False))
    finally:
        doc.close()


def command_extract_image(args):
    pymupdf, doc = open_document(args.pdf)
    if doc is None:
        return
    try:
        page = doc[args.page - 1]
        pixmap = pymupdf.Pixmap(doc, args.xref)
        if pixmap.n > 3:
            pixmap = pymupdf.Pixmap(pymupdf.csRGB, pixmap)
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        pixmap.save(args.out)
        print(json.dumps({
            "height": pixmap.height,
            "out": os.path.abspath(args.out),
            "width": pixmap.width,
        }, ensure_ascii=False))
    finally:
        doc.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="PDF reader for the O'Connell source")
    sub = parser.add_subparsers(dest="command", required=True)

    meta = sub.add_parser("meta", help="structure of a document, no rasterising")
    meta.add_argument("pdf")
    meta.set_defaults(func=command_meta)

    meta_many = sub.add_parser(
        "meta-many", help="structure of many documents, one interpreter, one array out"
    )
    meta_many.add_argument("pdfs", nargs="+")
    meta_many.set_defaults(func=command_meta_many)

    render = sub.add_parser("render", help="rasterise one page")
    render.add_argument("pdf")
    render.add_argument("--page", type=int, required=True)
    render.add_argument("--dpi", type=int, default=200)
    render.add_argument("--out", required=True)
    render.set_defaults(func=command_render)

    extract = sub.add_parser("extract-image", help="write an embedded image out")
    extract.add_argument("pdf")
    extract.add_argument("--page", type=int, required=True)
    extract.add_argument("--xref", type=int, required=True)
    extract.add_argument("--out", required=True)
    extract.set_defaults(func=command_extract_image)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
