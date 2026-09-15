"""Parallel OCR driver for the Revere video pipeline.

Mirrors the intent of tools/parallelDownload.sh: read scanning rows from
data/video_pipeline/state.sqlite and fan out scanVideoWithOcr.js invocations
across N concurrent workers. Written in Python rather than bash+heredoc
because Git Bash on Windows munges Windows-style backslash paths through
`<<<` here-strings + `IFS=...| read`, making it impossible to ship a
correct path into scanVideoWithOcr.js.

Safety model (matches the bash wrapper we previously shipped):

  * Read-only on SQLite. status updates remain the serial run's job.
  * Distinct run-tag = distinct output directory. No probe-log or ffmpeg
    collisions with the in-flight run.
  * SKIP_FROM_TAG=<in-flight-tag> skips any row whose probe log already
    exists under the in-flight run-tag.

Usage:
    python tools/parallelOcrScan.py [workers] [--limit N] [--run-tag TAG]
                                    [--skip-from-tag TAG]
                                    [--ffmpeg-bin PATH]
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import multiprocessing as _mp
import os
import pathlib
import re
import sqlite3
import subprocess
import sys


VIDEO_ID_FILENAME_RE = re.compile(
    r"^(\d{8})_[A-Za-z0-9_\-]{6,15}_[a-f0-9]{8}_whiteboard\.json$"
)


def _collect_jobs(args, workspace_root: pathlib.Path) -> list[tuple[str, str, pathlib.Path]]:
    """Return [(upload_date, video_id, download_path), ...] respecting the
    disk-existence + skip-from-tag filters."""
    db_path = pathlib.Path(args.db_path)
    if not db_path.exists():
        raise SystemExit(f"[parallel-ocr] FAIL: {db_path} not found. Run 'npm run video:init' first.")

    output_root = workspace_root / "data" / f"video_scan_{args.date_tag}" / args.run_tag
    own_dir = output_root / args.run_tag / "ocr_probe" / "logs"

    skip_dir = None
    if args.skip_from_tag:
        skip_dir = (
            workspace_root
            / "data"
            / f"video_scan_{args.date_tag}"
            / args.skip_from_tag
            / args.skip_from_tag
            / "ocr_probe"
            / "logs"
        )

    own_set = _probe_log_stems(own_dir)
    skip_set = _probe_log_stems(skip_dir) if skip_dir else set()

    conn = sqlite3.connect(str(db_path))
    rows = conn.execute(
        "SELECT video_id, upload_date, download_path FROM videos "
        "WHERE status IN ('pending','scanning','error') "
        "AND download_path IS NOT NULL AND download_path != '' "
        "ORDER BY upload_date ASC, video_id ASC"
    ).fetchall()
    conn.close()

    jobs: list[tuple[str, str, pathlib.Path]] = []
    skipped_own = skipped_other = missing = 0
    for video_id, upload_date, download_path in rows:
        if not upload_date or upload_date == "NA":
            continue
        p = pathlib.Path(download_path)
        if not p.exists():
            missing += 1
            continue
        prefix = f"{upload_date}_{video_id}_"
        if any(s.startswith(prefix) for s in own_set):
            skipped_own += 1
            continue
        if args.skip_from_tag and any(s.startswith(prefix) for s in skip_set):
            skipped_other += 1
            continue
        jobs.append((upload_date, video_id, p))

    if args.limit and args.limit > 0:
        jobs = jobs[: args.limit]

    print(
        f"[parallel-ocr] jobs={len(jobs)} skipped_own={skipped_own} "
        f"skipped_other={skipped_other} missing_files={missing}",
        flush=True,
    )
    return jobs


def _probe_log_stems(directory: pathlib.Path | None) -> set[str]:
    """Return the set of `<upload_date>_<video_id>_<hash>` stems for any
    `_whiteboard.json` files in `directory`. Caller can then check
    `prefix.startswith()` for membership tests."""
    if not directory or not directory.exists():
        return set()
    stems: set[str] = set()
    for f in directory.iterdir():
        m = VIDEO_ID_FILENAME_RE.match(f.name)
        if m:
            parts = f.name.split("_")
            # parts: [date, date, video_id, hash, "_whiteboard.json"]
            if len(parts) >= 4:
                stems.add(f"{parts[0]}_{parts[2]}_")
    return stems


def _worker_main(payload: tuple) -> dict:
    """Run inside a multiprocessing.Pool worker. Spawns scanVideoWithOcr.js
    for one job. Returns a result dict that the parent picks up."""
    (
        upload_date,
        video_id,
        download_path_str,
        output_root_str,
        run_tag,
        ffmpeg_bin,
        node_bin,
        date_tag,
    ) = payload

    log_path = pathlib.Path(output_root_str) / f"{run_tag}_{upload_date}_{video_id}.log"
    started_at = _dt.datetime.utcnow().isoformat() + "Z"
    cmd = [
        node_bin or "node",
        "tools/scanVideoWithOcr.js",
        "--video",
        download_path_str,
        "--date",
        upload_date,
        "--output-root",
        output_root_str,
        "--run-tag",
        run_tag,
        "--ffmpeg-bin",
        ffmpeg_bin,
    ]
    try:
        with log_path.open("w", encoding="utf-8") as f:
            f.write(f"# cmd: {' '.join(cmd)}\n")
            f.flush()
            proc = subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT, cwd=os.getcwd())
        return {
            "upload_date": upload_date,
            "video_id": video_id,
            "exit_code": proc.returncode,
            "log_path": str(log_path),
            "started_at": started_at,
            "ended_at": _dt.datetime.utcnow().isoformat() + "Z",
            "ok": proc.returncode == 0,
        }
    except Exception as exc:  # noqa: BLE001 - we want to surface every failure
        return {
            "upload_date": upload_date,
            "video_id": video_id,
            "exit_code": -1,
            "log_path": str(log_path),
            "started_at": started_at,
            "ended_at": _dt.datetime.utcnow().isoformat() + "Z",
            "ok": False,
            "error": repr(exc),
        }


def _parse_args(argv: list[str]) -> argparse.Namespace:
    workspace = pathlib.Path(__file__).resolve().parent.parent

    parser = argparse.ArgumentParser(prog="parallel-ocr-scan", add_help=True)
    parser.add_argument(
        "workers",
        nargs="?",
        type=int,
        default=4,
        help="number of concurrent scanVideoWithOcr.js workers (default: 4)",
    )
    parser.add_argument("--limit", type=int, default=0, help="cap the number of videos scanned (default: 0 = no cap)")
    parser.add_argument(
        "--run-tag",
        default=os.environ.get("RUN_TAG") or None,
        help="output run-tag (default: ocr-parallel-<UTC-timestamp>; honors $RUN_TAG)",
    )
    parser.add_argument(
        "--skip-from-tag",
        default=os.environ.get("SKIP_FROM_TAG") or None,
        help="cooperate with a serial run: skip videos whose probe log already exists under this run-tag (honors $SKIP_FROM_TAG)",
    )
    parser.add_argument("--ffmpeg-bin", default=os.environ.get("FFMPEG_BIN", str(workspace / "tools" / "ffmpeg.exe")), help="ffmpeg binary path")
    parser.add_argument("--node-bin", default=os.environ.get("NODE_BIN", "node"), help="node binary path")
    parser.add_argument("--db-path", default=str(workspace / "data" / "video_pipeline" / "state.sqlite"))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]

    workspace = pathlib.Path(__file__).resolve().parent.parent
    args = _parse_args(argv)

    workers = max(1, args.workers)
    args.run_tag = args.run_tag or f"ocr-parallel-{_dt.datetime.utcnow().strftime('%Y%m%d-%H%M%S')}"
    args.date_tag = _dt.datetime.utcnow().strftime("%Y%m%d")

    output_root = workspace / "data" / f"video_scan_{args.date_tag}" / args.run_tag
    output_root.mkdir(parents=True, exist_ok=True)
    (output_root / args.run_tag / "ocr_probe" / "logs").mkdir(parents=True, exist_ok=True)

    jobs = _collect_jobs(args, workspace)
    if not jobs:
        print(f"[parallel-ocr] nothing to scan under run-tag={args.run_tag}")
        if args.skip_from_tag:
            print(f"[parallel-ocr] (or all candidates were filtered by SKIP_FROM_TAG={args.skip_from_tag})")
        return 0

    print(f"[parallel-ocr] workspace   : {workspace}")
    print(f"[parallel-ocr] run_tag     : {args.run_tag}")
    print(f"[parallel-ocr] output_root : {output_root}")
    print(f"[parallel-ocr] parallelism : {workers} workers")
    print(f"[parallel-ocr] pending     : {len(jobs)} videos")
    if args.skip_from_tag:
        print(f"[parallel-ocr] skip_from   : {args.skip_from_tag} (cooperating with serial run)")

    payload_iter = (
        (
            upload_date,
            video_id,
            str(download_path),
            str(output_root),
            args.run_tag,
            args.ffmpeg_bin,
            args.node_bin,
            args.date_tag,
        )
        for upload_date, video_id, download_path in jobs
    )

    started = _dt.datetime.utcnow()
    results: list[dict] = []
    with _mp.Pool(processes=workers) as pool:
        for result in pool.imap_unordered(_worker_main, payload_iter):
            results.append(result)
            ts = _dt.datetime.utcnow().strftime("%H:%M:%S")
            status = "OK" if result["ok"] else f"ERR exit={result['exit_code']}"
            print(
                f"[parallel-ocr {ts}] {result['upload_date']} {result['video_id']} -> {status}",
                flush=True,
            )

    elapsed = (_dt.datetime.utcnow() - started).total_seconds()
    ok_count = sum(1 for r in results if r["ok"])
    err_count = len(results) - ok_count

    summary_path = output_root / "run_summary.json"
    summary_path.write_text(
        json.dumps(
            {
                "run_tag": args.run_tag,
                "started_at": started.isoformat() + "Z",
                "ended_at": _dt.datetime.utcnow().isoformat() + "Z",
                "elapsed_seconds": elapsed,
                "workers": workers,
                "skip_from_tag": args.skip_from_tag,
                "ffmpeg_bin": args.ffmpeg_bin,
                "results": results,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"[parallel-ocr] done in {elapsed:.1f}s · ok={ok_count} err={err_count}")
    print(f"[parallel-ocr] summary at {summary_path}")
    print(f"[parallel-ocr] aggregate with: node tools/aggregateOcrTimeline.js {args.run_tag}")
    return 0 if err_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
