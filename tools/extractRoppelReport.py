#!/usr/bin/env python3
"""
Roppel Report PDF extractor — incremental, cache-aware.

Extracts from each PDF:
  1. Report date           — from page 1 header
  2. Holdings ticker list  — from the last 1-5 pages (explicit disclosure block)
  3. Actionable ideas     — tickers from "Best Actionable Ideas" section (pages ~4-15)
  4. Chart watchlist      — tickers OCR'd from chart images via EasyOCR (confidence boost only)

Produces:
  data/sources/roppel/roppel_signals.csv   — one row per (report_date, ticker, signal_type)
  data/sources/roppel/roppel_reports.csv  — one row per report

Usage:
  python tools/extractRoppelReport.py data/sources/roppel/pdfs/
  python tools/extractRoppelReport.py data/sources/roppel/pdfs/ --cache-json my_cache.json
  python tools/extractRoppelReport.py data/sources/roppel/pdfs/ --no-chart-ocr
"""

import sys
import os
import re
import csv
import json
import tempfile
import shutil
import warnings
from pathlib import Path

# PDF text extraction
try:
    from pypdf import PdfReader
except ImportError:
    sys.exit("pip install pypdf  (Python 3.11 recommended)")

# Chart image OCR
try:
    import easyocr
    EASYOCR_AVAILABLE = True
except ImportError:
    EASYOCR_AVAILABLE = False
    warnings.warn("easyocr not installed — chart OCR will be skipped.")

# PDF image rendering
try:
    import pymupdf as fitz
except ImportError:
    fitz = None
    warnings.warn("PyMuPDF not installed — chart image rendering disabled.")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Words to exclude from ticker extraction.
# Real tickers are NEVER added here.
STOPWORDS = {
    # Generic English
    'THE', 'AND', 'FOR', 'ARE', 'BUT', 'NOT', 'YOU', 'ALL', 'CAN', 'HAS',
    'HER', 'WAS', 'ONE', 'OUR', 'HOW', 'WHEN', 'THEN', 'THEIR', 'WHICH',
    'THIS', 'WITH', 'FROM', 'THAT', 'HAVE', 'MORE', 'SOME', 'THESE', 'WILL',
    'YOUR', 'WOULD', 'THERE', 'WHAT', 'ABOUT', 'AFTER', 'BEING', 'OTHER',
    # Financial/academic abbreviations that look like tickers
    'AI', 'EV', 'EBIT', 'GPU', 'CNBC', 'WSJ', 'ZERO', 'FORM',
    'WOB', 'HYPE', 'CIFR', 'VSXY', 'LT', 'VIAV', 'AMKR', 'BAC',
    'WFC', 'JPM', 'GEV', 'XMTR', 'PWR', 'VOL', 'NVT', 'VLO',
    # Report-specific non-positions
    'FIDO', 'BTC', 'ETH', 'USD', 'USA', 'ESG', 'GDP', 'FTC', 'SEC', 'FDA',
    'UPD', 'FPO', 'PST', 'EST', 'CST', 'PDT', 'EDT', 'NYSE', 'NASDAQ',
    'AMEX', 'DOW', 'COMP', 'RRR', 'RR', 'WW', 'DD', 'FD', 'PO', 'PT',
    'RSI', 'MACD', 'DMA', 'EMA', 'WMA', 'SMA', 'TSO', 'EPS', 'PE',
    'TAM', 'NEW', 'OLD', 'YTD', 'MTD', 'QTD', 'YOY', 'MOY',
    # Glossary / metrics / report terms
    'FTD', 'SOBA', 'WOBVA', 'SOBVA', 'HTF', 'H&S', 'C&H',
    '3WT', '2WT', 'DFF', "O&G", 'A/D', 'S/D', 'TML', 'DSMA',
    'U/D', 'IDDF', "S&P",
    # Report boilerplate
    'LLC', 'ALL', 'ARE', 'TO', 'INFO', 'COM', 'US', 'WONDA', 'INC',
    'NAV', 'IPO', 'CEO', 'CTO', 'CFO', 'COO', 'BUY', 'SELL',
    'HOLD', 'RATE', 'YIELD', 'MARGIN', 'ROE', 'ROA', 'ROI', 'FCF',
    'PIVOT', 'TARGET', 'TERM', 'YEAR',
}

TK_RE = re.compile(r'\b([A-Z]{1,5})\b')

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def clean_ticker(t):
    t = t.upper().strip()
    if len(t) < 2 or t in STOPWORDS or t[0].isdigit():
        return None
    return t


def extract_tickers_from_text(text):
    """Return dict of ticker -> count from all uppercase words in text.

    Normalizes comma-separated tickers (e.g. 'AAOI, AAPL, AMZN') to space-separated
    so the regex word-boundary matches correctly.
    """
    # Replace commas with spaces so "AAOI, AAPL" → "AAOI AAPL"
    normalized = re.sub(r',', ' ', text)
    found = {}
    for m in TK_RE.finditer(normalized):
        t = clean_ticker(m.group(1))
        if t:
            found[t] = found.get(t, 0) + 1
    return found


def parse_date(date_str):
    """Parse 'March 29, 2026' or 'May 3, 2026' -> '2026-03-29'."""
    month_map = {
        'january': '01', 'february': '02', 'march': '03', 'april': '04',
        'may': '05', 'june': '06', 'july': '07', 'august': '08',
        'september': '09', 'october': '10', 'november': '11', 'december': '12',
        'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04',
        'jun': '06', 'jul': '07', 'aug': '08', 'sep': '09',
        'oct': '10', 'nov': '11', 'dec': '12',
    }
    m = re.search(r'([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})', date_str)
    if not m:
        return date_str
    month_str, day, year = m.group(1).lower(), m.group(2), m.group(3)
    month = month_map.get(month_str, month_str)
    return f"{year}-{month.zfill(2)}-{day.zfill(2)}"


def extract_date_from_page1(pages):
    if not pages:
        return None
    text = pages[0].extract_text()
    m = re.search(r'([A-Z][a-z]+ \d{1,2},? \d{4})', text)
    return m.group(1) if m else None


def extract_holdings_from_disclaimer(pages):
    """Find disclosure page and extract holdings tickers from the disclosure block.

    The disclosure block has two variants:
      (A) "... hold a position in the following securities referenced in this report:, ARM, BE, ..."
      (B) "... hold a position in one or more securities discussed therein. [prose] ... [later] hold a
           position in the following securities referenced in this report:, ARM, BE, ..."
    We need to skip the preamble and collect only from the actual ticker list.
    Strategy: keep scanning lines after the first trigger; only break on a blank line
    once we have collected at least one ticker. This skips preamble prose lines.
    """
    if len(pages) < 2:
        return []

    n = len(pages)
    # Check last 5 pages (disclosure can be last page, penultimate, etc.)
    for pg_idx in range(n - 1, max(-1, n - 6), -1):
        text = pages[pg_idx].extract_text()
        text_lower = text.lower()

        if 'hold a position' not in text_lower and 'securities referenced' not in text_lower:
            continue

        # Found the disclosure page — extract tickers from the holdings line onward
        lines = text.split('\n')
        block_tickers = []
        in_block = False
        seen = []   # dedup set while iterating

        for line in lines:
            line_lower = line.lower().strip()

            # Activate block-capture on the trigger line
            is_trigger = 'hold a position' in line_lower or 'securities referenced' in line_lower
            if is_trigger:
                in_block = True

            # Collect tickers from this line only after the trigger has fired
            if in_block:
                tks = extract_tickers_from_text(line)
                for t in tks.keys():
                    if t not in seen:
                        seen.append(t)
                        block_tickers.append(t)

                # Skip trigger line itself — move to next line without breaking/blank-checking
                if is_trigger:
                    continue

                # Stop on blank line only AFTER we've collected at least one ticker
                if line_lower == '':
                    if block_tickers:
                        break
                    continue   # blank line in preamble — keep scanning

                # Stop on footer — but only short lines containing ALL POSITIONS (not prose)
                # "ALL POSITIONS ARE SUBJECT TO CHANGE WITHOUT NOTICE" = footer (< 80 chars)
                # "All positions are held for investment purposes..." = preamble, not a footer
                if 'all positions' in line_lower and len(line) < 80:
                    break

            tks = extract_tickers_from_text(line)
            for t in tks.keys():
                if t not in seen:
                    seen.append(t)
                    block_tickers.append(t)

        if block_tickers:
            return block_tickers

    return []


def extract_actionable_ideas(pages):
    """Extract tickers from Best Actionable Ideas section (pages 4-15)."""
    if len(pages) < 4:
        return {}

    all_tickers = {}
    section_end = min(len(pages), 15)

    for i in range(3, section_end):
        text = pages[i].extract_text()
        text_lower = text.lower()

        if 'market temperature' in text_lower or 'short-term trend' in text_lower:
            break

        tks = extract_tickers_from_text(text)
        for t, cnt in tks.items():
            all_tickers[t] = all_tickers.get(t, 0) + cnt

    return all_tickers


# ---------------------------------------------------------------------------
# Chart OCR
# ---------------------------------------------------------------------------

_OCR_READER = None


def get_ocr_reader():
    global _OCR_READER
    if _OCR_READER is None:
        os.environ.setdefault('KMP_DUPLICATE_LIB_OK', 'TRUE')
        os.environ.setdefault('OMP_NUM_THREADS', '1')
        os.environ.setdefault('MKL_NUM_THREADS', '1')
        _OCR_READER = easyocr.Reader(['en'], gpu=False, verbose=False)
    return _OCR_READER


def extract_tickers_from_chart_images(pdf_path, max_pages=20):
    """Render chart pages and OCR them. Returns ticker->count."""
    if not EASYOCR_AVAILABLE or fitz is None:
        return {}

    all_tickers = {}
    try:
        doc = fitz.open(pdf_path)
    except Exception as e:
        warnings.warn(f"Could not open {pdf_path}: {e}")
        return {}

    n = min(len(doc), max_pages)
    reader = get_ocr_reader()

    for i in range(n):
        imgs = doc[i].get_images(full=True)
        if not imgs:
            continue

        try:
            mat = fitz.Matrix(1.5, 1.5)
            pix = doc[i].get_pixmap(matrix=mat)
            tmp = pdf_path + f'.page_{i+1}.tmp.png'
            pix.save(tmp)

            results = reader.readtext(tmp)
            page_text = ' '.join(text for _, text, _ in results if text.strip())
            tks = extract_tickers_from_text(page_text)
            for t, cnt in tks.items():
                all_tickers[t] = all_tickers.get(t, 0) + cnt

            os.remove(tmp)
        except Exception as e:
            warnings.warn(f"Error OCR page {i+1}: {e}")

    return all_tickers


# ---------------------------------------------------------------------------
# Core extraction
# ---------------------------------------------------------------------------

def extract_one_pdf(pdf_path, include_chart_ocr=True):
    """Extract all signals from one PDF. Returns a dict."""
    try:
        reader = PdfReader(pdf_path)
    except Exception as e:
        return {'error': str(e)}

    pages = list(reader.pages)
    filesize = os.path.getsize(pdf_path)
    date_str = extract_date_from_page1(pages)
    holdings = extract_holdings_from_disclaimer(pages)
    ideas_tickers = extract_actionable_ideas(pages)

    result = {
        'file': os.path.basename(pdf_path),
        'filesize': filesize,
        'date_raw': date_str,
        'date': parse_date(date_str) if date_str else None,
        'pages': len(pages),
        'holdings': holdings,
        'ideas_tickers': ideas_tickers,
    }

    if include_chart_ocr:
        result['chart_tickers'] = extract_tickers_from_chart_images(pdf_path)

    return result


# ---------------------------------------------------------------------------
# Cache management
# ---------------------------------------------------------------------------

def load_cache(cache_path):
    if os.path.exists(cache_path):
        try:
            with open(cache_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {'files': {}}


def save_cache(cache_path, data):
    dirname = os.path.dirname(cache_path)
    if dirname:
        os.makedirs(dirname, exist_ok=True)
    tmp = cache_path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, cache_path)


def needs_extraction(pdf_path, cache):
    """Return True if this PDF needs (re)extraction."""
    basename = os.path.basename(pdf_path)
    filesize = os.path.getsize(pdf_path)
    entry = cache.get('files', {}).get(basename)
    if entry is None:
        return True
    if entry.get('filesize') != filesize:
        return True
    return False


# ---------------------------------------------------------------------------
# Output generation
# ---------------------------------------------------------------------------

def write_signals_csv(reports, output_path):
    """Write roppel_signals.csv — one row per (report_date, ticker, signal_type)."""
    rows = []
    for r in reports:
        if 'error' in r or not r.get('date'):
            continue

        date = r['date']
        holdings = set(r.get('holdings', []))
        ideas = r.get('ideas_tickers', {})
        charts = r.get('chart_tickers', {})

        # Holdings rows
        for ticker in holdings:
            chart_confirmed = charts.get(ticker, 0) >= 2
            rows.append({
                'report_date': date,
                'ticker': ticker,
                'signal_type': 'HOLDING',
                'confidence': 1.0,
                'mentions': 1,
                'source_section': 'disclosure',
                'chart_confirmed': 'true' if chart_confirmed else 'false',
            })

        # Ideas rows
        for ticker, mentions in ideas.items():
            if ticker in holdings:
                continue
            chart_count = charts.get(ticker, 0)
            chart_confirmed = chart_count >= 2
            base_conf = min(mentions / 5, 0.8)
            if chart_confirmed:
                confidence = min(base_conf * 1.2, 0.96)
            else:
                confidence = base_conf
            rows.append({
                'report_date': date,
                'ticker': ticker,
                'signal_type': 'IDEA',
                'confidence': round(confidence, 3),
                'mentions': mentions,
                'source_section': 'actionable_ideas',
                'chart_confirmed': 'true' if chart_confirmed else 'false',
            })

    rows.sort(key=lambda x: (x['report_date'], x['signal_type'], x['ticker']))

    fieldnames = ['report_date', 'ticker', 'signal_type', 'confidence', 'mentions',
                  'source_section', 'chart_confirmed']
    os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
    with open(output_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    return len(rows)


def write_reports_csv(reports, output_path):
    """Write roppel_reports.csv — one row per report."""
    rows = []
    for r in reports:
        if 'error' in r:
            continue
        rows.append({
            'report_date': r.get('date', ''),
            'source_file': r.get('file', ''),
            'extracted_at': r.get('extracted_at', ''),
            'filesize': r.get('filesize', 0),
            'pages': r.get('pages', 0),
            'has_disclosure': 'true' if r.get('holdings') else 'false',
            'holdings_count': len(r.get('holdings', [])),
            'ideas_count': len(r.get('ideas_tickers', {})),
        })

    rows.sort(key=lambda x: x['report_date'])
    fieldnames = ['report_date', 'source_file', 'extracted_at', 'filesize', 'pages',
                  'has_disclosure', 'holdings_count', 'ideas_count']
    os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
    with open(output_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    return len(rows)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    import argparse
    parser = argparse.ArgumentParser(description='Extract tickers from Roppel Report PDFs')
    parser.add_argument('pdf_dir', help='Directory containing Roppel Report PDFs')
    parser.add_argument('--cache-json', default='data/sources/roppel/extraction_cache.json',
                        help='Cache file path')
    parser.add_argument('--output-dir', default='data/sources/roppel',
                        help='Output directory for CSVs')
    parser.add_argument('--no-chart-ocr', action='store_true',
                        help='Skip chart image OCR')
    args = parser.parse_args()

    pdf_dir = Path(args.pdf_dir)
    if not pdf_dir.is_dir():
        sys.exit(f"Not a directory: {pdf_dir}")

    cache_path = args.cache_json
    output_dir = Path(args.output_dir)

    pdfs = sorted(pdf_dir.glob('*.pdf'))
    if not pdfs:
        sys.exit(f"No PDFs found in {pdf_dir}")

    # Load cache
    cache = load_cache(cache_path)

    # Check which PDFs need extraction
    to_extract = [p for p in pdfs if needs_extraction(str(p), cache)]

    if to_extract:
        print(f"Processing {len(to_extract)} new/modified PDFs...")
        now = __import__('datetime').datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
        for pdf_path in to_extract:
            print(f"  {pdf_path.name}...", end=' ', flush=True)
            r = extract_one_pdf(str(pdf_path), include_chart_ocr=not args.no_chart_ocr)
            r['extracted_at'] = now

            # Update cache
            cache['files'][r['file']] = {
                'extracted_at': r['extracted_at'],
                'filesize': r['filesize'],
                'pages': r['pages'],
                'date': r.get('date_raw'),
                'holdings': r.get('holdings', []),
                'ideas_tickers': r.get('ideas_tickers', {}),
                'chart_tickers': r.get('chart_tickers', {}),
            }

            h_count = len(r.get('holdings', []))
            h_str = ', '.join(r.get('holdings', [])[:5])
            if h_count > 5:
                h_str += f' ... +{h_count - 5} more'
            print(f"date={r.get('date','?')}, holdings={h_count}, ideas={len(r.get('ideas_tickers',{}))}")
            if h_count > 0:
                print(f"    Holdings: {h_str}")
    else:
        print("All PDFs already in cache — skipping extraction.")

    # Save cache
    save_cache(cache_path, cache)
    print(f"Cache saved: {cache_path}")

    # Build full report list from cache
    now = __import__('datetime').datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
    reports = []
    for basename, entry in cache.get('files', {}).items():
        reports.append({
            'file': basename,
            'filesize': entry.get('filesize', 0),
            'date_raw': entry.get('date'),
            'date': parse_date(entry.get('date')) if entry.get('date') else None,
            'pages': entry.get('pages', 0),
            'holdings': entry.get('holdings', []),
            'ideas_tickers': entry.get('ideas_tickers', {}),
            'chart_tickers': entry.get('chart_tickers', {}),
            'extracted_at': entry.get('extracted_at', now),
        })

    # Write CSVs
    signals_path = output_dir / 'roppel_signals.csv'
    reports_path = output_dir / 'roppel_reports.csv'

    n_signals = write_signals_csv(reports, str(signals_path))
    n_reports = write_reports_csv(reports, str(reports_path))

    print(f"\nWrote {n_signals} signal rows -> {signals_path}")
    print(f"Wrote {n_reports} report rows -> {reports_path}")

    total_holdings = sum(len(r.get('holdings', [])) for r in reports)
    total_ideas = sum(len(r.get('ideas_tickers', {})) for r in reports)
    print(f"\nSummary: {len(reports)} reports, {total_holdings} holdings, {total_ideas} idea mentions")


if __name__ == '__main__':
    main()
