from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path

WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PIPELINE_ROOT = WORKSPACE_ROOT / 'data' / 'video_pipeline'

DIRECTORY_LAYOUT = {
    'catalog': 'catalog',
    'downloads': 'downloads',
    'frames': 'frames',
    'logs': 'logs',
    'review': 'review',
    'screenshots': 'screenshots',
}

VIDEO_STATUSES = (
    'pending',
    'downloading',
    'scanning',
    'review',
    'done',
    'no_match',
    'error',
)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def utc_timestamp_slug() -> str:
    return datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')


def resolve_pipeline_root(value: str | None) -> Path:
    return Path(value).expanduser().resolve() if value else DEFAULT_PIPELINE_ROOT


def resolve_db_path(pipeline_root: Path, value: str | None) -> Path:
    return Path(value).expanduser().resolve() if value else pipeline_root / 'state.sqlite'


def build_paths(pipeline_root: Path) -> dict[str, Path]:
    return {name: pipeline_root / relative for name, relative in DIRECTORY_LAYOUT.items()}


def ensure_layout(pipeline_root: Path) -> dict[str, Path]:
    pipeline_root.mkdir(parents=True, exist_ok=True)
    paths = build_paths(pipeline_root)
    for target in paths.values():
        target.mkdir(parents=True, exist_ok=True)
    return paths


def connect_database(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA foreign_keys = ON')
    connection.execute('PRAGMA journal_mode = WAL')
    return connection


def initialize_schema(connection: sqlite3.Connection) -> None:
    status_sql = ', '.join(f"'{status}'" for status in VIDEO_STATUSES)
    connection.executescript(
        f'''
        CREATE TABLE IF NOT EXISTS videos (
            video_id TEXT PRIMARY KEY,
            source_url TEXT NOT NULL DEFAULT '',
            video_url TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            upload_date TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ({status_sql})),
            download_path TEXT NOT NULL DEFAULT '',
            output_path TEXT NOT NULL DEFAULT '',
            selected_timestamp REAL,
            selected_score REAL,
            review_reason TEXT NOT NULL DEFAULT '',
            error TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
        CREATE INDEX IF NOT EXISTS idx_videos_upload_date ON videos(upload_date);

        CREATE TABLE IF NOT EXISTS worker_settings (
            setting_key TEXT PRIMARY KEY,
            setting_value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS catalog_runs (
            run_id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_url TEXT NOT NULL,
            command_json TEXT NOT NULL,
            raw_output_path TEXT NOT NULL,
            row_count INTEGER NOT NULL,
            inserted_count INTEGER NOT NULL,
            updated_count INTEGER NOT NULL,
            missing_upload_dates INTEGER NOT NULL,
            malformed_rows INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );
        '''
    )
    connection.commit()


def set_setting(connection: sqlite3.Connection, key: str, value: str) -> None:
    connection.execute(
        '''
        INSERT INTO worker_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = excluded.updated_at
        ''',
        (key, value, utc_now_iso()),
    )
    connection.commit()


def summarize_status(connection: sqlite3.Connection) -> dict[str, int]:
    counts = {status: 0 for status in VIDEO_STATUSES}
    for row in connection.execute('SELECT status, COUNT(*) AS total FROM videos GROUP BY status'):
        counts[row['status']] = row['total']
    return counts


def fetch_recent_videos(connection: sqlite3.Connection, limit: int) -> list[dict[str, str]]:
    rows = connection.execute(
        '''
        SELECT video_id, upload_date, title, status
        FROM videos
        ORDER BY upload_date DESC, video_id DESC
        LIMIT ?
        ''',
        (limit,),
    ).fetchall()
    return [dict(row) for row in rows]


def fetch_latest_catalog_run(connection: sqlite3.Connection) -> dict[str, object] | None:
    row = connection.execute(
        '''
        SELECT
            run_id,
            source_url,
            raw_output_path,
            row_count,
            inserted_count,
            updated_count,
            missing_upload_dates,
            malformed_rows,
            created_at
        FROM catalog_runs
        ORDER BY run_id DESC
        LIMIT 1
        '''
    ).fetchone()
    return dict(row) if row else None


def command_init(args: argparse.Namespace) -> int:
    pipeline_root = resolve_pipeline_root(args.pipeline_root)
    db_path = resolve_db_path(pipeline_root, args.db_path)
    paths = ensure_layout(pipeline_root)

    with connect_database(db_path) as connection:
        initialize_schema(connection)
        set_setting(connection, 'pipeline_root', str(pipeline_root))
        for name, target in paths.items():
            set_setting(connection, f'path_{name}', str(target))

    print(json.dumps({
        'db_path': str(db_path),
        'directories': {name: str(target) for name, target in paths.items()},
        'pipeline_root': str(pipeline_root),
        'status': 'initialized',
    }, indent=2))
    return 0


def command_status(args: argparse.Namespace) -> int:
    pipeline_root = resolve_pipeline_root(args.pipeline_root)
    db_path = resolve_db_path(pipeline_root, args.db_path)
    paths = build_paths(pipeline_root)

    if not db_path.exists():
        print(
            json.dumps(
                {
                    'db_path': str(db_path),
                    'message': 'Worker state has not been initialized yet.',
                    'pipeline_root': str(pipeline_root),
                    'status': 'missing',
                },
                indent=2,
            )
        )
        return 1

    with connect_database(db_path) as connection:
        total_videos = connection.execute('SELECT COUNT(*) AS total FROM videos').fetchone()['total']
        missing_dates = connection.execute(
            "SELECT COUNT(*) AS total FROM videos WHERE upload_date = ''"
        ).fetchone()['total']
        status_counts = summarize_status(connection)
        latest_catalog_run = fetch_latest_catalog_run(connection)
        recent_videos = fetch_recent_videos(connection, max(0, args.list_limit)) if args.list_limit else []

    print(json.dumps({
        'db_path': str(db_path),
        'directories': {name: str(target) for name, target in paths.items()},
        'latest_catalog_run': latest_catalog_run,
        'missing_upload_dates': missing_dates,
        'pipeline_root': str(pipeline_root),
        'recent_videos': recent_videos,
        'status': 'ok',
        'total_videos': total_videos,
        'video_counts': status_counts,
    }, indent=2))
    return 0


def build_catalog_command(args: argparse.Namespace) -> list[str]:
    command = build_yt_dlp_prefix(args.yt_dlp_bin)

    command.extend(['--flat-playlist', '--skip-download', '--ignore-errors'])

    if args.limit:
        command.extend(['--playlist-end', str(args.limit)])

    if args.cookies_from_browser:
        command.extend(['--cookies-from-browser', args.cookies_from_browser])

    if args.cookies_file:
        command.extend(['--cookies', args.cookies_file])

    command.extend([
        '--print',
        '%(id)s\t%(upload_date)s\t%(title)s',
        args.source_url,
    ])
    return command


def build_yt_dlp_prefix(yt_dlp_bin: str) -> list[str]:
    yt_dlp_target = Path(yt_dlp_bin)
    if yt_dlp_target.suffix.lower() == '.py':
        return [sys.executable, str(yt_dlp_target)]

    return [yt_dlp_bin]


def parse_catalog_line(line: str) -> dict[str, str] | None:
    parts = line.rstrip('\n').split('\t', 2)
    if len(parts) != 3:
        return None

    video_id, upload_date, title = parts
    video_id = video_id.strip()
    if not video_id:
        return None

    return {
        'title': title.strip(),
        'upload_date': upload_date.strip(),
        'video_id': video_id,
        'video_url': f'https://www.youtube.com/watch?v={video_id}',
    }


def write_catalog_snapshot(catalog_directory: Path, content: str) -> Path:
    snapshot_path = catalog_directory / f'catalog_{utc_timestamp_slug()}.tsv'
    snapshot_path.write_text(content, encoding='utf-8')
    return snapshot_path


def write_log_file(log_directory: Path, stem: str, stdout: str, stderr: str) -> Path:
    log_path = log_directory / f'{stem}_{utc_timestamp_slug()}.log'
    log_path.write_text(
        '\n'.join([
            'STDOUT:',
            stdout.rstrip(),
            '',
            'STDERR:',
            stderr.rstrip(),
            '',
        ]),
        encoding='utf-8',
    )
    return log_path


def record_catalog_run(
    connection: sqlite3.Connection,
    *,
    command: list[str],
    inserted: int,
    malformed_rows: int,
    missing_upload_dates: int,
    raw_output_path: Path,
    row_count: int,
    source_url: str,
    updated: int,
) -> None:
    connection.execute(
        '''
        INSERT INTO catalog_runs (
            source_url,
            command_json,
            raw_output_path,
            row_count,
            inserted_count,
            updated_count,
            missing_upload_dates,
            malformed_rows,
            created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''',
        (
            source_url,
            json.dumps(command),
            str(raw_output_path),
            row_count,
            inserted,
            updated,
            missing_upload_dates,
            malformed_rows,
            utc_now_iso(),
        ),
    )
    connection.commit()


def update_video_row(
    connection: sqlite3.Connection,
    *,
    video_id: str,
    status: str,
    download_path: str | None = None,
    error: str | None = None,
) -> None:
    assignments = ['status = ?', 'updated_at = ?']
    values: list[object] = [status, utc_now_iso()]

    if download_path is not None:
      assignments.append('download_path = ?')
      values.append(download_path)

    if error is not None:
      assignments.append('error = ?')
      values.append(error)

    values.append(video_id)
    connection.execute(
        f"UPDATE videos SET {', '.join(assignments)} WHERE video_id = ?",
        values,
    )
    connection.commit()


def select_videos_for_download(
    connection: sqlite3.Connection,
    *,
    limit: int,
    video_id: str,
) -> list[sqlite3.Row]:
    if video_id:
        row = connection.execute(
            '''
            SELECT video_id, upload_date, video_url, title, status, download_path
            FROM videos
            WHERE video_id = ?
            ''',
            (video_id,),
        ).fetchone()
        return [row] if row else []

    return connection.execute(
        '''
        SELECT video_id, upload_date, video_url, title, status, download_path
        FROM videos
        WHERE status IN ('pending', 'error', 'downloading')
        ORDER BY upload_date ASC, video_id ASC
        LIMIT ?
        ''',
        (limit,),
    ).fetchall()


def build_download_command(
    args: argparse.Namespace,
    *,
    archive_path: Path,
    download_directory: Path,
    video_url: str,
) -> list[str]:
    command = build_yt_dlp_prefix(args.yt_dlp_bin)
    command.extend([
        '--ignore-errors',
        '--continue',
        '--no-overwrites',
        '--download-archive',
        str(archive_path),
    ])

    if args.cookies_from_browser:
        command.extend(['--cookies-from-browser', args.cookies_from_browser])

    if args.cookies_file:
        command.extend(['--cookies', args.cookies_file])

    if args.extractor_args:
        command.extend(['--extractor-args', args.extractor_args])

    command.extend([
        '-f',
        args.format,
        '-o',
        str(download_directory / '%(upload_date)s_%(id)s.%(ext)s'),
        video_url,
    ])
    return command


def locate_downloaded_file(download_directory: Path, video_id: str) -> Path | None:
    matches = sorted(download_directory.glob(f'*_{video_id}.*'))
    for match in matches:
        if match.suffix == '.part':
            continue
        return match

    return None


def command_download(args: argparse.Namespace) -> int:
    pipeline_root = resolve_pipeline_root(args.pipeline_root)
    db_path = resolve_db_path(pipeline_root, args.db_path)
    paths = ensure_layout(pipeline_root)
    archive_path = pipeline_root / 'download_archive.txt'

    if not db_path.exists():
        print('Worker state is missing. Run `npm run video:init` first.', file=sys.stderr)
        return 1

    with connect_database(db_path) as connection:
        initialize_schema(connection)
        selected_rows = select_videos_for_download(
            connection,
            limit=max(1, args.limit),
            video_id=args.video_id,
        )

    if not selected_rows:
        print(json.dumps({
            'attempted': 0,
            'db_path': str(db_path),
            'downloaded': 0,
            'errored': 0,
            'pipeline_root': str(pipeline_root),
            'status': 'idle',
        }, indent=2))
        return 0

    results = []
    downloaded = 0
    errored = 0

    with connect_database(db_path) as connection:
        for row in selected_rows:
            if not row['video_url']:
                update_video_row(connection, video_id=row['video_id'], status='error', error='Missing video URL.')
                results.append({
                    'error': 'Missing video URL.',
                    'status': 'error',
                    'video_id': row['video_id'],
                })
                errored += 1
                continue

            update_video_row(connection, video_id=row['video_id'], status='downloading', error='')
            command = build_download_command(
                args,
                archive_path=archive_path,
                download_directory=paths['downloads'],
                video_url=row['video_url'],
            )
            result = subprocess.run(command, capture_output=True, text=True, check=False)
            log_path = write_log_file(paths['logs'], f"download_{row['video_id']}", result.stdout, result.stderr)

            if result.returncode != 0:
                message = result.stderr.strip() or result.stdout.strip() or 'yt-dlp download failed.'
                update_video_row(connection, video_id=row['video_id'], status='error', error=message)
                results.append({
                    'error': message,
                    'log_path': str(log_path),
                    'status': 'error',
                    'video_id': row['video_id'],
                })
                errored += 1
                continue

            output_file = locate_downloaded_file(paths['downloads'], row['video_id'])
            if output_file is None:
                message = 'Download completed but no output file matched the expected pattern.'
                update_video_row(connection, video_id=row['video_id'], status='error', error=message)
                results.append({
                    'error': message,
                    'log_path': str(log_path),
                    'status': 'error',
                    'video_id': row['video_id'],
                })
                errored += 1
                continue

            update_video_row(
                connection,
                video_id=row['video_id'],
                status='scanning',
                download_path=str(output_file),
                error='',
            )
            results.append({
                'download_path': str(output_file),
                'log_path': str(log_path),
                'status': 'scanning',
                'video_id': row['video_id'],
            })
            downloaded += 1

    print(json.dumps({
        'archive_path': str(archive_path),
        'attempted': len(selected_rows),
        'db_path': str(db_path),
        'downloaded': downloaded,
        'errored': errored,
        'pipeline_root': str(pipeline_root),
        'results': results,
        'status': 'ok' if not errored else 'partial',
    }, indent=2))
    return 0 if not errored else 1


def upsert_catalog_rows(connection: sqlite3.Connection, source_url: str, rows: list[dict[str, str]]) -> tuple[int, int]:
    inserted = 0
    updated = 0

    for row in rows:
        existing = connection.execute(
            'SELECT status FROM videos WHERE video_id = ?',
            (row['video_id'],),
        ).fetchone()

        timestamp = utc_now_iso()
        connection.execute(
            '''
            INSERT INTO videos (
                video_id,
                source_url,
                video_url,
                title,
                upload_date,
                status,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
            ON CONFLICT(video_id) DO UPDATE SET
                source_url = excluded.source_url,
                video_url = excluded.video_url,
                title = excluded.title,
                upload_date = CASE
                    WHEN excluded.upload_date <> '' THEN excluded.upload_date
                    ELSE videos.upload_date
                END,
                updated_at = excluded.updated_at
            ''',
            (
                row['video_id'],
                source_url,
                row['video_url'],
                row['title'],
                row['upload_date'],
                timestamp,
                timestamp,
            ),
        )

        if existing is None:
            inserted += 1
        else:
            updated += 1

    connection.commit()
    return inserted, updated


def command_catalog(args: argparse.Namespace) -> int:
    pipeline_root = resolve_pipeline_root(args.pipeline_root)
    db_path = resolve_db_path(pipeline_root, args.db_path)
    paths = ensure_layout(pipeline_root)

    if not db_path.exists():
        print('Worker state is missing. Run `npm run video:init` first.', file=sys.stderr)
        return 1

    command = build_catalog_command(args)
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip() or 'yt-dlp catalog command failed.'
        print(message, file=sys.stderr)
        return result.returncode

    rows = []
    malformed_lines = []
    for raw_line in result.stdout.splitlines():
        parsed = parse_catalog_line(raw_line)
        if parsed:
            rows.append(parsed)
        elif raw_line.strip():
            malformed_lines.append(raw_line)

    if not rows:
        print('No catalog rows were returned by yt-dlp.', file=sys.stderr)
        return 1

    missing_upload_dates = sum(1 for row in rows if not row['upload_date'])
    snapshot_path = write_catalog_snapshot(paths['catalog'], result.stdout)

    with connect_database(db_path) as connection:
        initialize_schema(connection)
        set_setting(connection, 'source_url', args.source_url)
        set_setting(connection, 'last_catalog_output_path', str(snapshot_path))
        set_setting(connection, 'last_catalog_import_at', utc_now_iso())
        inserted, updated = upsert_catalog_rows(connection, args.source_url, rows)
        record_catalog_run(
            connection,
            command=command,
            inserted=inserted,
            malformed_rows=len(malformed_lines),
            missing_upload_dates=missing_upload_dates,
            raw_output_path=snapshot_path,
            row_count=len(rows),
            source_url=args.source_url,
            updated=updated,
        )

    print(json.dumps({
        'cataloged_rows': len(rows),
        'db_path': str(db_path),
        'inserted': inserted,
        'malformed_rows': len(malformed_lines),
        'missing_upload_dates': missing_upload_dates,
        'pipeline_root': str(pipeline_root),
        'raw_output_path': str(snapshot_path),
        'source_url': args.source_url,
        'status': 'ok',
        'updated': updated,
        'yt_dlp_command': command,
    }, indent=2))

    if malformed_lines:
        print(json.dumps({'malformed_examples': malformed_lines[:5]}, indent=2), file=sys.stderr)

    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Manage the Revere video-to-whiteboard worker state.'
    )
    parser.add_argument(
        '--pipeline-root',
        default=str(DEFAULT_PIPELINE_ROOT),
        help='Directory for the video worker runtime files.',
    )
    parser.add_argument(
        '--db-path',
        default='',
        help='Optional explicit SQLite database path. Defaults to <pipeline-root>/state.sqlite.',
    )

    subparsers = parser.add_subparsers(dest='command', required=True)

    init_parser = subparsers.add_parser('init', help='Initialize the worker directories and SQLite state.')
    init_parser.set_defaults(handler=command_init)

    status_parser = subparsers.add_parser('status', help='Show the current worker status summary.')
    status_parser.add_argument(
        '--list-limit',
        type=int,
        default=5,
        help='How many recently cataloged videos to include in the status output.',
    )
    status_parser.set_defaults(handler=command_status)

    catalog_parser = subparsers.add_parser('catalog', help='Import playlist or channel metadata through yt-dlp.')
    catalog_parser.add_argument('--source-url', required=True, help='YouTube playlist or channel URL to catalog.')
    catalog_parser.add_argument('--yt-dlp-bin', default='yt-dlp', help='Path to the yt-dlp executable.')
    catalog_parser.add_argument('--limit', type=int, default=0, help='Optional playlist limit for smoke tests.')
    catalog_parser.add_argument(
        '--cookies-from-browser',
        default='',
        help='Optional browser name for yt-dlp --cookies-from-browser.',
    )
    catalog_parser.add_argument(
        '--cookies-file',
        default='',
        help='Optional cookie file path for yt-dlp --cookies.',
    )
    catalog_parser.set_defaults(handler=command_catalog)

    download_parser = subparsers.add_parser('download', help='Download pending videos and mark them ready for scanning.')
    download_parser.add_argument('--yt-dlp-bin', default='yt-dlp', help='Path to the yt-dlp executable.')
    download_parser.add_argument('--limit', type=int, default=1, help='How many pending videos to download in this run.')
    download_parser.add_argument('--video-id', default='', help='Optional specific video ID to download or retry.')
    download_parser.add_argument(
        '--cookies-from-browser',
        default='',
        help='Optional browser name for yt-dlp --cookies-from-browser.',
    )
    download_parser.add_argument(
        '--cookies-file',
        default='',
        help='Optional cookie file path for yt-dlp --cookies.',
    )
    download_parser.add_argument(
        '--extractor-args',
        default='youtube:player_client=tv',
        help='Optional yt-dlp extractor args passed through to the downloader.',
    )
    download_parser.add_argument(
        '--format',
        default='bv*[height<=480]+ba/b[height<=480]',
        help='yt-dlp format selector for low-resolution resumable downloads.',
    )
    download_parser.set_defaults(handler=command_download)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.handler(args)


if __name__ == '__main__':
    raise SystemExit(main())