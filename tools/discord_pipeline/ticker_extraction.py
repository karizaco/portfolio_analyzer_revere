"""Shared ticker extraction logic for the Discord pipeline.

Mirrors ``src/normalize/tickerExtraction.js``:
  1. Split text on whitespace and punctuation → token candidates.
  2. Strip residual non-alphanumeric noise from each token.
  3. Reject anything that does not match STRICT_TICKER_PATTERN.
  4. Confirm the token exists in the seed lexicon Set.
"""

from __future__ import annotations

import re

STRICT_TICKER_PATTERN = re.compile(r"^[A-Z]{1,5}(?:\.[A-Z]{1,2})?$")
TOKEN_SPLIT_PATTERN = re.compile(r"[\s,;:()\[\]{}<>/\\|`'\"]+")
NORMALIZE_PATTERN = re.compile(r"[^A-Z0-9.]")


def normalize_ticker_token(raw_token: str) -> str:
    """Strip non-alphanumeric noise so 'TQQQ.' → 'TQQQ'."""
    return NORMALIZE_PATTERN.sub("", str(raw_token or "").upper())


def tokenize_text(text: str) -> list[str]:
    """Split raw text into candidate ticker tokens (non-empty)."""
    if not text or not text.strip():
        return []
    return [t for t in TOKEN_SPLIT_PATTERN.split(text) if t]


def extract_tickers(text: str, lexicon: set[str]) -> list[str]:
    """Extract validated ticker symbols from free-form text.

    Args:
        text: Raw text to scan (e.g. Discord message body).
        lexicon: Set of known-good ticker strings (uppercase).

    Returns:
        Sorted, deduplicated list of matching tickers.
    """
    if not text or not text.strip():
        return []

    seen: set[str] = set()
    matched: list[str] = []

    for raw in TOKEN_SPLIT_PATTERN.split(text):
        token = normalize_ticker_token(raw)
        if not token:
            continue
        if not STRICT_TICKER_PATTERN.match(token):
            continue
        if token not in lexicon:
            continue
        if token in seen:
            continue
        seen.add(token)
        matched.append(token)

    return sorted(matched)
