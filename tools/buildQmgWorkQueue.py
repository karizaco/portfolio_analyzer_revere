"""Build an executable QMG work queue from catalog + disk + OCR logs.

Writes:
  data/qmg_work_queue.json
  data/qmg_work_queue.md
  data/qmg_work_queue/*.txt
  data/qmg_work_queue/ocr_chunks.ps1
  data/qmg_work_queue/ocr_chunks.sh

Usage:
  py -3 tools/buildQmgWorkQueue.py
"""
from __future__ import annotations

import json
import re
import sqlite3
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATE_RE = re.compile(r"(20\d{6})")
YT_ID_RE = re.compile(r"([A-Za-z0-9_-]{11})$")


def norm_date(ud) -> str | None:
    s = str(ud or "").replace("-", "")[:8]
    return s if re.fullmatch(r"20\d{6}", s) else None


def main() -> None:
    con = sqlite3.connect(str(ROOT / "data" / "video_pipeline" / "state.sqlite"))
    con.row_factory = sqlite3.Row
    qmg = [
        dict(r)
        for r in con.execute(
            "SELECT video_id, title, upload_date, download_path, status, analysis_state, "
            "source_url, video_url FROM videos WHERE channel='qullamaggie' "
            "ORDER BY upload_date DESC, video_id"
        )
    ]
    by_id = {r["video_id"]: r for r in qmg}

    # Prefer SQLite production-profile outcomes over log-filename archaeology.
    # analysis_state is file retention only and is intentionally ignored here.
    PRODUCTION_PROFILE_ID = "qmg-production-v1"
    outcome_ok_dates: set[str] = set()
    outcome_ok_vids: set[str] = set()
    try:
        for row in con.execute(
            "SELECT video_id, upload_date FROM ocr_scan_outcomes "
            "WHERE status='ok' AND profile_id=?",
            (PRODUCTION_PROFILE_ID,),
        ):
            vid = row["video_id"]
            if vid:
                outcome_ok_vids.add(vid)
            d = norm_date(row["upload_date"])
            if d:
                outcome_ok_dates.add(d)
    except sqlite3.OperationalError:
        # Table missing until migration 10 / ensureOcrScanOutcomesTable runs.
        outcome_ok_dates = set()
        outcome_ok_vids = set()

    cat_dates: set[str] = set()
    date_to_vids: dict[str, list[str]] = defaultdict(list)
    for r in qmg:
        d = norm_date(r["upload_date"])
        if d:
            cat_dates.add(d)
            date_to_vids[d].append(r["video_id"])

    avail: set[str] = set()
    media_paths: dict[str, list[str]] = defaultdict(list)

    def match_vid(stem: str) -> str | None:
        m = re.match(r"^(\d{8})_(.+)$", stem)
        cand = m.group(2) if m else stem
        # strip leading underscore artifact from some partial names
        if cand in by_id:
            return cand
        if stem in by_id:
            return stem
        if cand.startswith("_") and cand[1:] in by_id:
            return cand[1:]
        if stem.startswith("_") and stem[1:] in by_id:
            return stem[1:]
        m2 = YT_ID_RE.search(cand) or YT_ID_RE.search(stem)
        if m2 and m2.group(1) in by_id:
            return m2.group(1)
        return None

    def consider_mp4(f: Path) -> None:
        vid = match_vid(f.stem)
        if not vid:
            return
        avail.add(vid)
        media_paths[vid].append(str(f.relative_to(ROOT)).replace("\\", "/"))

    for dname in ["downloads_1080p", "downloads_hires", "downloads"]:
        d = ROOT / "data" / "video_pipeline" / dname
        if not d.exists():
            continue
        for f in d.glob("*.mp4"):
            consider_mp4(f)

    path_ok: set[str] = set()
    path_stale: set[str] = set()
    no_path: set[str] = set()
    for r in qmg:
        dp = r.get("download_path")
        if not dp or not str(dp).strip():
            no_path.add(r["video_id"])
            continue
        p = Path(dp)
        if not p.is_absolute():
            p = ROOT / p
        if p.exists():
            path_ok.add(r["video_id"])
            avail.add(r["video_id"])
            media_paths[r["video_id"]].append(str(p.relative_to(ROOT) if p.is_relative_to(ROOT) else p).replace("\\", "/"))
        else:
            path_stale.add(r["video_id"])

    # Partials: unique paths only
    partials = []
    seen_parts: set[str] = set()
    part_dir = ROOT / "data" / "video_pipeline" / "downloads_1080p"
    if part_dir.exists():
        part_files = {f.resolve() for f in part_dir.glob("*.part")}
        part_files |= {f.resolve() for f in part_dir.glob("*.mp4.part")}
        for f in sorted(part_files, key=lambda x: x.name):
            key = str(f)
            if key in seen_parts:
                continue
            seen_parts.add(key)
            stem = f.name
            if stem.endswith(".mp4.part"):
                stem = stem[: -len(".mp4.part")]
            elif stem.endswith(".part"):
                stem = stem[: -len(".part")]
            vid = match_vid(stem)
            if not vid:
                continue
            rel = str(f.relative_to(ROOT)).replace("\\", "/")
            partials.append(
                {
                    "video_id": vid,
                    "upload_date": norm_date(by_id[vid]["upload_date"]),
                    "part_path": rel,
                    "part_bytes": f.stat().st_size,
                    "title": by_id[vid].get("title"),
                }
            )
    partials.sort(key=lambda x: (x.get("upload_date") or "", x["video_id"]), reverse=True)

    # OCR dates from logs (catalog dates only)
    ocr_dates: set[str] = set()
    ocr_runs_by_date: dict[str, set[str]] = defaultdict(set)

    def harvest_logs(run_name: str, folders) -> None:
        for folder in folders:
            if not folder:
                continue
            folder = Path(folder)
            if not folder.exists():
                continue
            for f in folder.glob("*.json"):
                for m in DATE_RE.findall(f.stem):
                    if m in cat_dates:
                        ocr_dates.add(m)
                        ocr_runs_by_date[m].add(run_name)

    rerun = ROOT / "data" / "video_scan_test" / "_rerun"
    if rerun.exists():
        for child in rerun.iterdir():
            if child.is_dir() and (child.name.startswith("qmg-") or child.name.startswith("rerun_")):
                harvest_logs(child.name, [child / "ocr_probe" / "logs", child / "logs"])

    probe = ROOT / "data" / "video_ocr_probe"
    if probe.exists():
        for child in probe.iterdir():
            if child.is_dir() and any(
                s in child.name
                for s in ["qmg", "1080", "easyocr", "fixed", "final", "batch", "lowcpu", "s3", "720"]
            ):
                harvest_logs("probe:" + child.name, [child / "logs", child / "ocr_probe" / "logs"])

    for child in sorted((ROOT / "data").glob("video_scan_*")):
        if not child.is_dir():
            continue
        logs_dirs = []
        for logs in child.rglob("logs"):
            if logs.is_dir() and "frames" not in logs.parts:
                logs_dirs.append(logs)
        harvest_logs(child.name, logs_dirs)

    gt_path = ROOT / "data" / "qmg_ground_truth.json"
    gt_dates: set[str] = set()
    if gt_path.exists():
        gt = json.loads(gt_path.read_text(encoding="utf-8"))
        gt_dates = {d for d in gt if re.fullmatch(r"20\d{6}", d)}

    def video_row(vid: str, extra=None) -> dict:
        r = by_id[vid]
        d = norm_date(r["upload_date"])
        item = {
            "video_id": vid,
            "upload_date": d,
            "title": r.get("title"),
            "download_path": r.get("download_path"),
            "media_paths": sorted(set(media_paths.get(vid, []))),
            "has_media": vid in avail,
            "path_ok": vid in path_ok,
            "path_stale": vid in path_stale,
            "no_path": vid in no_path,
            "analysis_state": r.get("analysis_state") or "",
            "status": r.get("status") or "",
            "source_url": r.get("source_url")
            or r.get("video_url")
            or f"https://www.youtube.com/watch?v={vid}",
            "ocr_date_seen": bool(d and d in ocr_dates),
            "production_outcome_ok": bool(vid in outcome_ok_vids or (d and d in outcome_ok_dates)),
            "in_ground_truth": bool(d and d in gt_dates),
            "ocr_runs": sorted(ocr_runs_by_date.get(d, [])) if d else [],
        }
        if extra:
            item.update(extra)
        return item

    year_priority = {
        "2023": 3,
        "2022": 3,
        "2021": 4,
        "2020": 5,
        "2019": 6,
        "2018": 6,
        "2017": 6,
    }

    # Modern coverage = successful qmg-production-v1 outcome.
    # Legacy log dates remain as secondary signal for reporting only.
    def needs_production_ocr(vid: str) -> bool:
        if vid in outcome_ok_vids:
            return False
        d = norm_date(by_id[vid]["upload_date"])
        if d and d in outcome_ok_dates:
            return False
        return True

    local_no_ocr_vids = []
    for vid in sorted(avail, key=lambda v: (norm_date(by_id[v]["upload_date"]) or "", v), reverse=True):
        d = norm_date(by_id[vid]["upload_date"])
        if not d:
            continue
        if needs_production_ocr(vid):
            reason = (
                "media_on_disk_but_no_production_ocr_outcome"
                if d in ocr_dates
                else "media_on_disk_but_no_ocr_log_for_upload_date"
            )
            local_no_ocr_vids.append(
                video_row(
                    vid,
                    {
                        "queue": "local_not_ocrd",
                        "priority": 2,
                        "action": "ocr_scan",
                        "reason": reason,
                        "legacy_ocr_log_seen": bool(d in ocr_dates),
                        "production_outcome_ok": False,
                    },
                )
            )

    local_no_ocr_dates = sorted(
        {
            norm_date(by_id[vid]["upload_date"])
            for vid in avail
            if norm_date(by_id[vid]["upload_date"]) and needs_production_ocr(vid)
        },
        reverse=True,
    )

    date_queue_local_not_ocrd = []
    for d in local_no_ocr_dates:
        vids = [v for v in date_to_vids[d] if v in avail]
        date_queue_local_not_ocrd.append(
            {
                "upload_date": d,
                "video_ids": vids,
                "n_videos_on_disk": len(vids),
                "titles": [by_id[v].get("title") for v in vids],
                "action": "ocr_scan",
                "suggested_cmd": f"node tools/runQmgOcrBatch.js --dates {d} --low-cpu --parallel 1",
            }
        )

    missing = [r for r in qmg if r["video_id"] not in avail]
    missing_by_year: dict[str, list] = defaultdict(list)
    for r in missing:
        y = (norm_date(r["upload_date"]) or "unknown")[:4]
        missing_by_year[y].append(
            video_row(
                r["video_id"],
                {
                    "queue": "missing_media",
                    "priority": year_priority.get(y, 7),
                    "action": "download",
                    "reason": (
                        "no_download_path"
                        if r["video_id"] in no_path
                        else "stale_download_path"
                        if r["video_id"] in path_stale
                        else "media_not_found"
                    ),
                },
            )
        )

    local_ocrd_dates = sorted(
        {
            norm_date(by_id[vid]["upload_date"])
            for vid in avail
            if norm_date(by_id[vid]["upload_date"]) and norm_date(by_id[vid]["upload_date"]) in ocr_dates
        },
        reverse=True,
    )

    ocr_chunks = []
    chunk_size = 5
    for i in range(0, len(local_no_ocr_dates), chunk_size):
        chunk = local_no_ocr_dates[i : i + chunk_size]
        ocr_chunks.append(
            {
                "chunk_index": i // chunk_size + 1,
                "dates": chunk,
                "n_dates": len(chunk),
                "n_videos": sum(len([v for v in date_to_vids[d] if v in avail]) for d in chunk),
                "suggested_cmd": (
                    "node tools/runQmgOcrBatch.js --dates "
                    + ",".join(chunk)
                    + " --low-cpu --parallel 1"
                ),
            }
        )

    download_years = {}
    for y in sorted(missing_by_year.keys(), reverse=True):
        items = sorted(
            missing_by_year[y],
            key=lambda x: (x.get("upload_date") or "", x["video_id"]),
            reverse=True,
        )
        download_years[y] = {
            "year": y,
            "count": len(items),
            "priority": items[0]["priority"] if items else None,
            "video_ids": [it["video_id"] for it in items],
            "items": items,
        }

    generated_at = datetime.now(timezone.utc).isoformat()
    summary = {
        "generated_at": generated_at,
        "channel": "qullamaggie",
        "catalog_total": len(qmg),
        "media_on_disk": len(avail),
        "missing_media": len(missing),
        "path_ok": len(path_ok),
        "path_stale": len(path_stale),
        "no_path": len(no_path),
        "partial_downloads": len(partials),
        "unique_ocr_catalog_dates": len(ocr_dates),
        "production_outcome_ok_dates": len(outcome_ok_dates),
        "production_outcome_ok_videos": len(outcome_ok_vids),
        "production_profile_id": PRODUCTION_PROFILE_ID,
        "ground_truth_dates": len(gt_dates),
        "local_not_ocrd_dates": len(local_no_ocr_dates),
        "local_not_ocrd_videos": len(local_no_ocr_vids),
        "local_ocrd_dates": len(local_ocrd_dates),
        "missing_by_year": {y: len(missing_by_year[y]) for y in sorted(missing_by_year)},
        "queues": [
            {"id": "1_partials", "action": "finish_or_redownload_partial", "count": len(partials)},
            {
                "id": "2_local_not_ocrd",
                "action": "ocr_scan",
                "dates": len(local_no_ocr_dates),
                "videos": len(local_no_ocr_vids),
            },
            {
                "id": "3_missing_2022_2023",
                "action": "download",
                "count": len(missing_by_year.get("2022", [])) + len(missing_by_year.get("2023", [])),
            },
            {"id": "4_missing_2021", "action": "download", "count": len(missing_by_year.get("2021", []))},
            {"id": "5_missing_2020", "action": "download", "count": len(missing_by_year.get("2020", []))},
            {
                "id": "6_missing_2017_2019",
                "action": "download",
                "count": sum(len(missing_by_year.get(y, [])) for y in ["2017", "2018", "2019"]),
            },
        ],
        "notes": [
            "OCR coverage prefers ocr_scan_outcomes rows with status=ok and profile_id=qmg-production-v1.",
            "Legacy log-filename dates are reported but no longer clear the OCR queue by themselves.",
            "analysis_state/status in SQLite are NOT used as OCR progress (file retention only).",
            "Prefer --low-cpu and small chunks for OCR. Use visios + cookies for downloads.",
            "Do not expand the hardcoded 39 720p-only ID list from format-unavailable errors.",
            "downloads_hires is mixed (Revere + QMG). Queue only uses QMG catalog ids.",
            "Regenerate with: py -3 tools/buildQmgWorkQueue.py",
        ],
    }

    payload = {
        "summary": summary,
        "partials": partials,
        "local_not_ocrd": {
            "dates": date_queue_local_not_ocrd,
            "videos": local_no_ocr_vids,
            "ocr_chunks_of_5": ocr_chunks,
        },
        "local_already_ocrd_dates": local_ocrd_dates,
        "missing_media_by_year": download_years,
        "skip_hints": {
            "ground_truth_dates": sorted(gt_dates),
            "ocr_dates_seen": sorted(ocr_dates),
        },
    }

    out_json = ROOT / "data" / "qmg_work_queue.json"
    out_json.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    lines = []
    lines.append("# QMG work queue")
    lines.append("")
    lines.append(f"Generated: `{generated_at}`")
    lines.append("")
    lines.append("Regenerate:")
    lines.append("")
    lines.append("```bash")
    lines.append("py -3 tools/buildQmgWorkQueue.py")
    lines.append("```")
    lines.append("")
    lines.append("Artifacts:")
    lines.append("")
    lines.append("- [`data/qmg_work_queue.json`](qmg_work_queue.json) — full machine-readable queue")
    lines.append("- [`data/qmg_work_queue/`](qmg_work_queue/) — plain id/date lists + OCR chunk commands")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append("| Metric | Count |")
    lines.append("|---|---:|")
    lines.append(f"| Catalogued | {summary['catalog_total']} |")
    lines.append(f"| Media on disk | {summary['media_on_disk']} |")
    lines.append(f"| Missing media | {summary['missing_media']} |")
    lines.append(f"| Partial downloads | {summary['partial_downloads']} |")
    lines.append(f"| Local dates with no OCR log | {summary['local_not_ocrd_dates']} |")
    lines.append(f"| Local videos on those dates | {summary['local_not_ocrd_videos']} |")
    lines.append(f"| Catalog dates already seen in OCR logs | {summary['unique_ocr_catalog_dates']} |")
    lines.append("")
    lines.append("### Missing media by year")
    lines.append("")
    lines.append("| Year | Missing | Priority |")
    lines.append("|---:|---:|---:|")
    for y in sorted(summary["missing_by_year"].keys(), reverse=True):
        pr = download_years[y]["priority"]
        lines.append(f"| {y} | {summary['missing_by_year'][y]} | {pr} |")
    lines.append("")
    lines.append("## Queue order")
    lines.append("")
    lines.append("### 1) Finish partial downloads")
    lines.append("")
    lines.append(f"Count: **{len(partials)}**")
    lines.append("")
    if partials:
        lines.append("| upload_date | video_id | part_MB | title |")
        lines.append("|---|---|---:|---|")
        for it in partials:
            mb = round(it["part_bytes"] / 1024 / 1024, 1)
            title = (it.get("title") or "").replace("|", "/")
            lines.append(f"| {it.get('upload_date')} | `{it['video_id']}` | {mb} | {title[:60]} |")
    else:
        lines.append("_None_")
    lines.append("")
    lines.append("### 2) OCR local media with no OCR log (highest ROI)")
    lines.append("")
    lines.append(f"Dates: **{len(local_no_ocr_dates)}** · Videos: **{len(local_no_ocr_vids)}**")
    lines.append("")
    lines.append("Run in chunks of 5. Always use `--low-cpu`. Check orphans between chunks.")
    lines.append("")
    lines.append("#### Suggested chunks")
    lines.append("")
    for ch in ocr_chunks:
        lines.append(f"**Chunk {ch['chunk_index']}** — {ch['n_dates']} dates, {ch['n_videos']} videos")
        lines.append("")
        lines.append("```bash")
        lines.append(ch["suggested_cmd"])
        lines.append("```")
        lines.append("")
        lines.append("Dates: " + ", ".join(f"`{d}`" for d in ch["dates"]))
        lines.append("")
    lines.append("#### Full date list (newest first)")
    lines.append("")
    lines.append("| upload_date | videos_on_disk | video_ids |")
    lines.append("|---|---:|---|")
    for d in date_queue_local_not_ocrd:
        ids = ", ".join(f"`{v}`" for v in d["video_ids"])
        lines.append(f"| {d['upload_date']} | {d['n_videos_on_disk']} | {ids} |")
    lines.append("")
    lines.append("### 3–6) Download missing media by year")
    lines.append("")
    lines.append("Use visios + cookies; one careful campaign at a time. Pause 30–60 min if rate-limited.")
    lines.append("")
    for y in sorted(download_years.keys(), reverse=True):
        block = download_years[y]
        lines.append(f"#### {y} — {block['count']} missing (priority {block['priority']})")
        lines.append("")
        lines.append(
            f"Ids: `data/qmg_work_queue/missing_{y}_video_ids.txt` "
            f"(also JSON `missing_media_by_year.{y}.video_ids`)."
        )
        lines.append("")
        lines.append("Sample (newest 15):")
        lines.append("")
        lines.append("| upload_date | video_id | reason | title |")
        lines.append("|---|---|---|---|")
        for it in block["items"][:15]:
            title = (it.get("title") or "").replace("|", "/")
            lines.append(
                f"| {it.get('upload_date')} | `{it['video_id']}` | {it.get('reason')} | {title[:50]} |"
            )
        if block["count"] > 15:
            lines.append(f"| ... | _{block['count'] - 15} more_ | | |")
        lines.append("")

    lists_dir = ROOT / "data" / "qmg_work_queue"
    lists_dir.mkdir(parents=True, exist_ok=True)

    def write_lines(path: Path, values: list[str]) -> None:
        path.write_text(("\n".join(values) + ("\n" if values else "")), encoding="utf-8")

    write_lines(lists_dir / "partials_video_ids.txt", [it["video_id"] for it in partials])
    write_lines(lists_dir / "local_not_ocrd_dates.txt", local_no_ocr_dates)
    write_lines(lists_dir / "local_not_ocrd_video_ids.txt", [it["video_id"] for it in local_no_ocr_vids])
    write_lines(lists_dir / "local_already_ocrd_dates.txt", local_ocrd_dates)
    for y, block in download_years.items():
        write_lines(lists_dir / f"missing_{y}_video_ids.txt", block["video_ids"])

    chunk_lines = [
        "# QMG OCR chunks for local-not-ocrd dates",
        "# Always --low-cpu; run one chunk at a time; check orphans between chunks",
        "",
    ]
    ps1_lines = []
    for ch in ocr_chunks:
        chunk_lines.append(f"# chunk {ch['chunk_index']} ({ch['n_dates']} dates, {ch['n_videos']} videos)")
        chunk_lines.append(ch["suggested_cmd"])
        chunk_lines.append("")
        ps1_lines.append(f"# chunk {ch['chunk_index']}: {', '.join(ch['dates'])}")
        ps1_lines.append(ch["suggested_cmd"])
        ps1_lines.append("")
    (lists_dir / "ocr_chunks.sh").write_text("\n".join(chunk_lines), encoding="utf-8")
    (lists_dir / "ocr_chunks.ps1").write_text("\n".join(ps1_lines), encoding="utf-8")

    md_path = ROOT / "data" / "qmg_work_queue.md"
    md_path.write_text("\n".join(lines), encoding="utf-8")

    print(json.dumps(summary, indent=2))
    print(f"WROTE {out_json.relative_to(ROOT)}")
    print(f"WROTE {md_path.relative_to(ROOT)}")
    print(f"WROTE {lists_dir.relative_to(ROOT)}/")


if __name__ == "__main__":
    main()
