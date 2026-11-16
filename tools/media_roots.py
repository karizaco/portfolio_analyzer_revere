"""Resolve optional media roots for video downloads.

Mirrors src/video/mediaRoots.js so Python tools honor the same overrides:

  Env (first match wins per key):
    PORTFOLIO_PIPELINE_ROOT
    PORTFOLIO_DOWNLOADS_1080P
    PORTFOLIO_DOWNLOADS_HIRES
    PORTFOLIO_DOWNLOADS
    PORTFOLIO_MEDIA_EXTRA_DIRS   (comma/semicolon-separated extra search folders)

  Config file: <repo>/data/video_pipeline/media_roots.json
    {
      "pipeline_root": "D:/portfolio_media/video_pipeline",
      "downloads_1080p": null,
      "downloads_hires": null,
      "downloads": null,
      "extra_dirs": ["D:/data/portfolio_analyzer_revere/videos"]
    }

Primary dirs are where new downloads are written. extra_dirs are searched
for existing media so a library can span C: and D: at the same time.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Iterable

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PIPELINE = REPO_ROOT / "data" / "video_pipeline"
CONFIG_PATH = DEFAULT_PIPELINE / "media_roots.json"

ENV_KEYS = {
    "pipeline_root": "PORTFOLIO_PIPELINE_ROOT",
    "downloads_1080p": "PORTFOLIO_DOWNLOADS_1080P",
    "downloads_hires": "PORTFOLIO_DOWNLOADS_HIRES",
    "downloads": "PORTFOLIO_DOWNLOADS",
    "extra_dirs": "PORTFOLIO_MEDIA_EXTRA_DIRS",
}

_cached: dict[str, Any] | None = None


def _expand(value: Any) -> Path | None:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    if s.startswith("~"):
        home = Path.home()
        s = str(home / s[1:].lstrip("\\/"))
    p = Path(s)
    if p.is_absolute() or (len(s) >= 2 and s[1] == ":"):
        return p.resolve()
    return (REPO_ROOT / p).resolve()


def _split_path_list(value: Any) -> list[str]:
    if value is None or value == "":
        return []
    if isinstance(value, (list, tuple)):
        out: list[str] = []
        for item in value:
            out.extend(_split_path_list(item))
        return out
    return [part.strip() for part in re.split(r"[;,]", str(value)) if part.strip()]


def unique_resolved_dirs(dirs: Iterable[Path | str | None]) -> list[Path]:
    out: list[Path] = []
    seen: set[str] = set()
    for d in dirs:
        if d is None or d == "":
            continue
        resolved = Path(d).resolve()
        key = str(resolved).replace("\\", "/").lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(resolved)
    return out


def _parse_extra_dirs(file_cfg: dict[str, Any], environ: Any) -> list[Path]:
    parts = [
        *_split_path_list(environ.get(ENV_KEYS["extra_dirs"]) if hasattr(environ, "get") else None),
        *_split_path_list(file_cfg.get("extra_dirs")),
        *_split_path_list(file_cfg.get("search_dirs")),
    ]
    return unique_resolved_dirs(p for p in (_expand(x) for x in parts) if p is not None)


def _read_config() -> dict[str, Any]:
    try:
        if not CONFIG_PATH.is_file():
            return {}
        raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def reset_media_roots_cache() -> None:
    global _cached
    _cached = None


def get_media_roots(
    *,
    env: dict[str, str] | None = None,
    config: dict[str, Any] | None = None,
    force: bool = False,
) -> dict[str, Any]:
    global _cached
    if _cached is not None and not force and env is None and config is None:
        return _cached

    file_cfg = config if config is not None else _read_config()
    environ = env if env is not None else os.environ

    pipeline = (
        _expand(environ.get(ENV_KEYS["pipeline_root"]))
        or _expand(file_cfg.get("pipeline_root"))
        or DEFAULT_PIPELINE
    )

    def resolve_dir(key: str) -> Path:
        from_env = _expand(environ.get(ENV_KEYS[key]))
        if from_env is not None:
            return from_env
        from_file = _expand(file_cfg.get(key))
        if from_file is not None:
            return from_file
        return (pipeline / key).resolve()

    extra_dirs = _parse_extra_dirs(file_cfg, environ)

    roots: dict[str, Any] = {
        "repo_root": REPO_ROOT,
        "config_path": CONFIG_PATH,
        "pipeline_root": pipeline.resolve() if isinstance(pipeline, Path) else Path(pipeline).resolve(),
        "downloads_1080p": resolve_dir("downloads_1080p"),
        "downloads_hires": resolve_dir("downloads_hires"),
        "downloads": resolve_dir("downloads"),
        "extra_dirs": extra_dirs,
    }
    if env is None and config is None:
        _cached = roots
    return roots


def get_download_dir(kind: str = "1080p") -> Path:
    roots = get_media_roots()
    if kind in ("1080p", "downloads_1080p"):
        return roots["downloads_1080p"]
    if kind in ("hires", "720p", "downloads_hires"):
        return roots["downloads_hires"]
    if kind in ("downloads", "legacy"):
        return roots["downloads"]
    raise ValueError(f"unknown download kind: {kind}")


def media_search_dirs() -> list[Path]:
    """All dirs to search for existing media (1080 + extras + hires + legacy)."""
    roots = get_media_roots()
    return unique_resolved_dirs(
        [
            roots["downloads_1080p"],
            *list(roots.get("extra_dirs") or []),
            roots["downloads_hires"],
            roots["downloads"],
        ]
    )


def media_1080_search_dirs() -> list[Path]:
    """1080-class search: primary downloads_1080p plus extra_dirs only."""
    roots = get_media_roots()
    return unique_resolved_dirs(
        [
            roots["downloads_1080p"],
            *list(roots.get("extra_dirs") or []),
        ]
    )


def resolve_media_path(
    download_path: str | os.PathLike[str] | None,
    *,
    cwd: Path | None = None,
) -> Path | None:
    if download_path is None:
        return None
    raw = str(download_path).strip()
    if not raw:
        return None
    normalised = raw.replace("\\", "/")
    base = cwd or REPO_ROOT
    marker = "data/"
    idx = normalised.lower().find(marker)
    if idx != -1:
        after = normalised[idx:]
        if (
            after.startswith("data/video_pipeline")
            or after.startswith("data/video_ocr_probe")
            or after.lower().startswith("data/video_scan_")
        ):
            return (base / after).resolve()
    if (len(raw) >= 2 and raw[1] == ":") or normalised.startswith("/") or normalised.startswith("//"):
        return Path(raw).resolve()
    return (base / raw).resolve()
