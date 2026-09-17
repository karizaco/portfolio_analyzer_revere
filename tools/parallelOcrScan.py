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
                                    [--prefilter-profile whiteboard|chart_stream]
                                    [--basename NAME]
                                    [--chart-stream-parser]
                                    [--channel revere|qullamaggie]
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
    r"^(\d{8})_(\d{8})_([A-Za-z0-9_\-]{6,15})_([a-f0-9]{8})_whiteboard\.json$"
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
    sql = (
        "SELECT video_id, upload_date, download_path FROM videos "
        "WHERE status IN ('pending','scanning','error') "
        "AND download_path IS NOT NULL AND download_path != '' "
    )
    sql_params: list = []
    if args.channel:
        sql += "AND (channel = ? OR (channel = '' AND ? = 'revere')) "
        sql_params.extend([args.channel, args.channel])
    sql += "ORDER BY upload_date ASC, video_id ASC"
    rows = conn.execute(sql, sql_params).fetchall()
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
        prefix = f"{upload_date}_{video_id}_".lower()
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
            # groups: (date1, date2, video_id, hash) — both dates are equal in
            # current scanner output. Using regex groups keeps video_ids that
            # contain underscores intact (e.g. "eai-qmrf_t0").
            date1, _date2, vid, _hash = m.groups()
            stems.add(f"{date1}_{vid}_".lower())
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
        prefilter_profile,
        basename,
        chart_stream_parser,
        output_kind,
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
        "--output-kind",
        output_kind or "whiteboard",
        "--prefilter-profile",
        prefilter_profile or "whiteboard",
        "--basename",
        basename or "revere",
    ]
    if chart_stream_parser:
        cmd.append("--chart-stream-parser")
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
    parser.add_argument(
        "--channel",
        default=os.environ.get("CHANNEL") or "",
        help="filter videos to this channel value in the catalog (e.g. 'revere', 'qullamaggie'). Honors $CHANNEL.",
    )
    parser.add_argument(
        "--prefilter-profile",
        default=os.environ.get("PREFILTER_PROFILE", "whiteboard"),
        choices=["whiteboard", "chart_stream"],
        help="prefilter score profile forwarded to scanVideoWithOcr.js (default: whiteboard). Honors $PREFILTER_PROFILE.",
    )
    parser.add_argument(
        "--basename",
        default=os.environ.get("BASENAME") or "",
        help="snapshot PNG prefix + screenshot discovery stem forwarded to scanVideoWithOcr.js (default: 'revere' or the channel). Honors $BASENAME.",
    )
    parser.add_argument(
        "--chart-stream-parser",
        action="store_true",
        default=os.environ.get("CHART_STREAM_PARSER") == "1",
        help="forward --chart-stream-parser to scanVideoWithOcr.js (Qullamaggie). Honors $CHART_STREAM_PARSER=1.",
    )
    parser.add_argument(
        "--date-tag",
        default=os.environ.get("DATE_TAG") or None,
        help="calendar date tag (YYYYMMDD) for the data/video_scan_<date>/ directory. "
             "Defaults to today (UTC). Honors $DATE_TAG. "
             "Use this to write into yesterday's data/video_scan_<date>/ directory when resuming.",
    )
    parser.add_argument(
        "--output-kind",
        default=os.environ.get("OUTPUT_KIND") or "",
        help="output kind forwarded to scanVideoWithOcr.js (whiteboard | snapshot). "
             "Default: 'snapshot' when --chart-stream-parser is set, else 'whiteboard'. "
             "Honors $OUTPUT_KIND.",
    )
    return parser.parse_args(argv)


def _write_status_json(
    *,
    output_root: pathlib.Path,
    run_tag: str,
    started_at: _dt.datetime,
    finished_at: _dt.datetime,
    expected_total: int,
    results: list[dict],
    next_step: str,
) -> None:
    """Write data/video_scan_<date>/<run-tag>/.STATUS.json so a future
    session can pick up progress without re-scanning probe-logs. Mirrors the
    shape of runAllOcr.js' writeRunStatus helper.

    Errors are swallowed — the status file is best-effort bookkeeping."""
    try:
        probe_logs_dir = output_root / run_tag / "ocr_probe" / "logs"
        probe_log_count = 0
        last_probe_log = None
        if probe_logs_dir.exists():
            files = sorted(p.name for p in probe_logs_dir.iterdir() if p.name.endswith(".json"))
            probe_log_count = len(files)
            last_probe_log = files[-1] if files else None

        seen: set[tuple[str, str]] = set()
        unique_done = 0
        unique_errored = 0
        for r in results:
            key = (r.get("upload_date") or "unknown", r.get("video_id") or "")
            if key in seen:
                continue
            seen.add(key)
            if r.get("ok"):
                unique_done += 1
            else:
                unique_errored += 1

        status_path = output_root / ".STATUS.json"
        status_path.write_text(
            json.dumps(
                {
                    "run_tag": run_tag,
                    "driver": "parallelOcrScan.py",
                    "started_at": started_at.isoformat() + "Z",
                    "finished_at": finished_at.isoformat() + "Z",
                    "last_update_at": _dt.datetime.utcnow().isoformat() + "Z",
                    "probe_log_count": probe_log_count,
                    "unique_videos_done": unique_done,
                    "unique_videos_errored": unique_errored,
                    "expected_total": expected_total,
                    "last_probe_log": last_probe_log,
                    "next_step": next_step,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception as exc:  # noqa: BLE001 - best-effort bookkeeping
        print(f"[parallel-ocr] WARN: failed to write .STATUS.json: {exc!r}", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]

    workspace = pathlib.Path(__file__).resolve().parent.parent
    args = _parse_args(argv)

    workers = max(1, args.workers)
    args.run_tag = args.run_tag or f"ocr-parallel-{_dt.datetime.utcnow().strftime('%Y%m%d-%H%M%S')}"
    args.date_tag = args.date_tag or _dt.datetime.utcnow().strftime("%Y%m%d")
    # Resolve basename default: explicit --basename wins, otherwise derive from
    # the channel so Qullamaggie runs land in `qmg_<DATE>.png` instead of
    # `revere_<DATE>.png`. Empty string means "let scanVideoWithOcr default".
    if not args.basename and args.channel and args.channel != "revere":
        args.basename = args.channel
    effective_basename = args.basename or "revere"

    # Resolve output kind default: explicit --output-kind wins, otherwise
    # default to 'snapshot' when the chart-stream parser is on (the parser
    # is only valid with --output-kind snapshot), else 'whiteboard'.
    if not args.output_kind:
        args.output_kind = "snapshot" if args.chart_stream_parser else "whiteboard"
    effective_output_kind = args.output_kind

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
    if args.channel:
        print(f"[parallel-ocr] channel     : {args.channel}")
    print(f"[parallel-ocr] prefilter   : {args.prefilter_profile}")
    print(f"[parallel-ocr] basename    : {effective_basename}")
    if args.chart_stream_parser:
        print(f"[parallel-ocr] parser      : chart-stream")
    print(f"[parallel-ocr] output_kind : {effective_output_kind}")
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
            args.prefilter_profile,
            effective_basename,
            bool(args.chart_stream_parser),
            effective_output_kind,
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

    # Write .STATUS.json (parallel-friendly mirror of runAllOcr.js' helper) so
    # future sessions can pick up progress without re-scanning probe-logs.
    _write_status_json(
        output_root=output_root,
        run_tag=args.run_tag,
        started_at=started,
        finished_at=_dt.datetime.utcnow(),
        expected_total=len(results),
        results=results,
        next_step=(
            f"run npm run video:stamp-types -- --run-tag {args.run_tag} "
            f"then node tools/aggregateOcrTimeline.js {args.run_tag}"
            if err_count == 0
            else f"inspect {len(results) - ok_count} failed job log(s); then aggregate with node tools/aggregateOcrTimeline.js {args.run_tag}"
        ),
    )

    print(f"[parallel-ocr] done in {elapsed:.1f}s · ok={ok_count} err={err_count}")
    print(f"[parallel-ocr] summary at {summary_path}")
    print(f"[parallel-ocr] aggregate with: node tools/aggregateOcrTimeline.js {args.run_tag}")
    return 0 if err_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
