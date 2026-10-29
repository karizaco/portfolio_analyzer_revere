from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
import shutil

WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PIPELINE_ROOT = WORKSPACE_ROOT / 'data' / 'video_pipeline'
SCHEMA_SQL_PATH = WORKSPACE_ROOT / 'data' / 'db' / 'schema.sql'
REFERENCE_SUFFIXES = {'.jpg', '.jpeg', '.pgm', '.png', '.webp'}
VIDEO_SUFFIXES = {'.mp4', '.mov', '.mkv', '.m4v', '.webm'}
THUMBNAIL_WIDTH = 8
THUMBNAIL_HEIGHT = 8
SHARPNESS_WIDTH = 64
SHARPNESS_HEIGHT = 36

DIRECTORY_LAYOUT = {
    'catalog': 'catalog',
    'downloads': 'downloads',
    'frames': 'frames',
    'logs': 'logs',
    'references': 'references',
    'review': 'review',
    'snapshots': 'snapshots',
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


def _get_schema_version(connection: sqlite3.Connection) -> int:
    """Return the highest applied schema version, or 0 if none."""
    row = connection.execute(
        "SELECT MAX(version) AS v FROM schema_version"
    ).fetchone()
    return int(row['v']) if row and row['v'] is not None else 0


def _apply_migrations(connection: sqlite3.Connection) -> None:
    """Apply version-tracked data backfills after schema.sql has been executed.

    This only runs backfill UPDATEs for versions newer than what is recorded
    in ``schema_version``, so it is safe to call on every startup.
    """
    current = _get_schema_version(connection)

    # Version 1: backfill `channel` on `videos` and `catalog_runs` from
    # `source_url` so legacy rows get a channel label.
    if current < 1:
        # The backfills below name `channel`, so the column has to exist
        # first. A database written by an older worker may not have it --
        # and an UPDATE against a missing column aborts the whole migration,
        # which leaves the database unopenable rather than half-migrated.
        for table in ('videos', 'catalog_runs'):
            columns = {
                row['name'] for row in connection.execute(f'PRAGMA table_info({table})')
            }
            if 'channel' not in columns:
                connection.execute(
                    f'ALTER TABLE {table} ADD COLUMN channel TEXT NOT NULL DEFAULT \'\''
                )
        connection.execute(
            "UPDATE videos SET channel = 'revere' "
            "WHERE channel = '' AND source_url LIKE '%@revereasset%'"
        )
        connection.execute(
            "UPDATE videos SET channel = 'qullamaggie' "
            "WHERE channel = '' AND source_url LIKE '%@Qullamaggie%'"
        )
        connection.execute(
            "UPDATE videos SET channel = 'revere' WHERE channel = ''"
        )
        connection.execute(
            "UPDATE catalog_runs SET channel = 'revere' "
            "WHERE channel = '' AND source_url LIKE '%@revereasset%'"
        )
        connection.execute(
            "UPDATE catalog_runs SET channel = 'qullamaggie' "
            "WHERE channel = '' AND source_url LIKE '%@Qullamaggie%'"
        )
        connection.execute(
            "UPDATE catalog_runs SET channel = 'revere' WHERE channel = ''"
        )
        connection.execute(
            "INSERT OR IGNORE INTO schema_version (version) VALUES (1)"
        )
        connection.commit()

    # Version 2: make `catalog_runs` portable and honest.
    #
    # `raw_output_path` held an absolute Windows path, so every pointer in the
    # run history resolved on the machine that made the run and nowhere else.
    # A path inside the repository is rewritten relative to the repository
    # root; a path from another machine has no such form and is left alone --
    # converting it would only make it wrong in a different way.
    #
    # `kind` separates a real catalog run from a test fixture. The fixtures
    # used `example.com/mock-playlist`, which is self-labelling, but they
    # still made up four of the twenty-eight rows in the audit table, and a
    # reader had to know that to discount them.
    if current < 2:
        columns = {
            row['name'] for row in connection.execute('PRAGMA table_info(catalog_runs)')
        }
        if 'kind' not in columns:
            connection.execute(
                "ALTER TABLE catalog_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'live'"
            )
        connection.execute(
            "UPDATE catalog_runs SET kind = 'fixture' "
            "WHERE source_url NOT LIKE '%youtube.com%'"
        )
        prefix = str(WORKSPACE_ROOT)
        rows = connection.execute(
            'SELECT run_id, raw_output_path FROM catalog_runs'
        ).fetchall()
        for row in rows:
            stored = row['raw_output_path'] or ''
            if not stored.lower().startswith(prefix.lower()):
                continue
            relative = stored[len(prefix):].lstrip('\\/').replace('\\', '/')
            connection.execute(
                'UPDATE catalog_runs SET raw_output_path = ? WHERE run_id = ?',
                (relative, row['run_id']),
            )
        connection.execute(
            "INSERT OR IGNORE INTO schema_version (version) VALUES (2)"
        )
        connection.commit()

    # Version 3: make the stored paths portable.
    #
    # `videos.download_path` is the same defect version 2 fixed on a bigger
    # column: 392 of its 716 pointers were absolute Windows paths, so they
    # resolved on the machine that wrote them and nowhere else. The column is
    # the catalog's record of where a download landed, and it is committed to
    # git, so a path that only means something on one machine is a pointer
    # that points at nothing for everyone else.
    #
    # `worker_settings` stores this machine's absolute paths the same way.
    # Those rows are rewritten too. Nothing reads them yet, so the change
    # cannot break a consumer -- but the next reader would have inherited the
    # defect, and that is the moment to fix it.
    if current < 3:
        for row in connection.execute(
            'SELECT video_id, download_path FROM videos'
        ).fetchall():
            stored = row['download_path'] or ''
            if not stored:
                continue
            portable = portable_stored_path(stored)
            if portable != stored:
                connection.execute(
                    'UPDATE videos SET download_path = ? WHERE video_id = ?',
                    (portable, row['video_id']),
                )
        for row in connection.execute(
            'SELECT setting_key, setting_value FROM worker_settings'
        ).fetchall():
            stored = row['setting_value'] or ''
            if not stored:
                continue
            portable = portable_stored_path(stored)
            if portable != stored:
                connection.execute(
                    'UPDATE worker_settings SET setting_value = ?, updated_at = ? '
                    'WHERE setting_key = ?',
                    (portable, utc_now_iso(), row['setting_key']),
                )
        connection.execute(
            "INSERT OR IGNORE INTO schema_version (version) VALUES (3)"
        )
        connection.commit()

    # Version 4: record how many catalog rows a run's listing did not contain.
    #
    # A channel's `/videos` listing is the channel's ground truth of what it
    # currently shows, so a row the catalog holds and the listing does not is
    # worth reporting: the video may have been deleted, made private, or
    # turned into a Short or a members-only upload. It is an OBSERVATION and
    # not proof of deletion, so nothing is deleted -- the count goes in the
    # run's audit row and the ids go in the run's JSON summary.
    if current < 4:
        columns = {
            row['name'] for row in connection.execute('PRAGMA table_info(catalog_runs)')
        }
        if 'not_listed_count' not in columns:
            connection.execute(
                'ALTER TABLE catalog_runs ADD COLUMN not_listed_count INTEGER NOT NULL DEFAULT 0'
            )
        connection.execute(
            "INSERT OR IGNORE INTO schema_version (version) VALUES (4)"
        )
        connection.commit()

    # Version 5: say whether a run's listing covered the whole channel.
    #
    # `not_listed_count` on its own is not interpretable: a run that was
    # truncated reports every row it did not list, and the number means
    # nothing without knowing that. `listing_complete` is 1 when the run's
    # listing was the channel's whole listing, and 0 when it was truncated or
    # a video failed. 0 is also the value for a run recorded before this
    # column existed: such a run made no such claim.
    if current < 5:
        columns = {
            row['name'] for row in connection.execute('PRAGMA table_info(catalog_runs)')
        }
        if 'listing_complete' not in columns:
            connection.execute(
                'ALTER TABLE catalog_runs ADD COLUMN listing_complete INTEGER NOT NULL DEFAULT 0'
            )
        connection.execute(
            "INSERT OR IGNORE INTO schema_version (version) VALUES (5)"
        )
        connection.commit()

    # Version 6: say what `row_count` counts.
    #
    # The column means two different things depending on the run: for a
    # `catalog` run it is the number of rows the channel listing yielded, and
    # for a `fill-dates` run it is the number of videos in the work list. A
    # reader of the audit table could not tell which, and the two are not
    # comparable.
    #
    # The old rows are reconstructed from the artifact each run wrote -- the
    # snapshot's file name says which kind of run it was -- rather than
    # guessed. A run whose artifact name says neither keeps the empty string:
    # it made no such claim.
    if current < 6:
        columns = {
            row['name'] for row in connection.execute('PRAGMA table_info(catalog_runs)')
        }
        if 'row_count_kind' not in columns:
            connection.execute(
                "ALTER TABLE catalog_runs ADD COLUMN row_count_kind TEXT NOT NULL DEFAULT ''"
            )
        for row in connection.execute(
            "SELECT run_id, raw_output_path FROM catalog_runs WHERE row_count_kind = ''"
        ).fetchall():
            name = os.path.basename(str(row['raw_output_path'] or '').replace('\\', '/'))
            if name.startswith('catalog_'):
                kind = 'listing_rows'
            elif name.startswith(('listing_', 'fill_dates_')):
                kind = 'work_list_videos'
            else:
                continue
            connection.execute(
                'UPDATE catalog_runs SET row_count_kind = ? WHERE run_id = ?',
                (kind, row['run_id']),
            )
        connection.execute(
            "INSERT OR IGNORE INTO schema_version (version) VALUES (6)"
        )
        connection.commit()


def initialize_schema(connection: sqlite3.Connection) -> None:
    """Load and execute data/db/schema.sql, then run any pending data migrations."""
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")

    sql_text = SCHEMA_SQL_PATH.read_text(encoding='utf-8')
    connection.executescript(sql_text)
    connection.commit()

    _apply_migrations(connection)


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


def set_path_setting(connection: sqlite3.Connection, key: str, value: str | Path) -> None:
    """Store a path setting so it survives being checked out elsewhere.

    `worker_settings` held this machine's absolute paths, which made them
    meaningless on any other machine. A path inside the repository is stored
    relative to the repository root; one outside it keeps its absolute form,
    because there is no honest relative form for it.
    """
    set_setting(connection, key, portable_stored_path(value))


def summarize_status(connection: sqlite3.Connection) -> dict[str, int]:
    counts = {status: 0 for status in VIDEO_STATUSES}
    for row in connection.execute('SELECT status, COUNT(*) AS total FROM videos GROUP BY status'):
        counts[row['status']] = row['total']
    return counts


def resolve_yt_dlp_prefix(yt_dlp_bin: str) -> list[str]:
    if yt_dlp_bin == 'py-yt-dlp':
        return [sys.executable, '-m', 'yt_dlp']

    if yt_dlp_bin and yt_dlp_bin != 'yt-dlp':
        return build_command_prefix(yt_dlp_bin)

    discovered = shutil.which('yt-dlp')
    if discovered:
        return [discovered]

    if importlib.util.find_spec('yt_dlp'):
        return [sys.executable, '-m', 'yt_dlp']

    candidate_patterns = [
        Path.home() / 'AppData' / 'Local' / 'Python' / 'pythoncore-*' / 'Scripts' / 'yt-dlp.exe',
        Path.home() / 'AppData' / 'Roaming' / 'Python' / 'Python*' / 'Scripts' / 'yt-dlp.exe',
    ]
    for pattern in candidate_patterns:
        matches = sorted(Path().glob(str(pattern))) if '*' in str(pattern) else ([pattern] if pattern.exists() else [])
        if matches:
            return [str(matches[-1])]

    return [yt_dlp_bin]


def resolve_ffmpeg_bin(ffmpeg_bin: str) -> str:
    if ffmpeg_bin and ffmpeg_bin != 'ffmpeg':
        return ffmpeg_bin

    discovered = shutil.which('ffmpeg')
    if discovered:
        return discovered

    candidate_paths = [
        Path('C:/ffmpeg/bin/ffmpeg.exe'),
        Path('C:/Program Files/ffmpeg/bin/ffmpeg.exe'),
        Path.home() / 'AppData' / 'Local' / 'Microsoft' / 'WinGet' / 'Packages',
    ]

    direct_candidates = candidate_paths[:2]
    for candidate in direct_candidates:
        if candidate.exists():
            return str(candidate)

    winget_root = candidate_paths[2]
    if winget_root.exists():
        matches = sorted(winget_root.glob('Gyan.FFmpeg*/*/bin/ffmpeg.exe'))
        if matches:
            return str(matches[-1])

    return ffmpeg_bin


def describe_tool_resolution() -> dict[str, object]:
    return {
        'ffmpeg': resolve_ffmpeg_bin('ffmpeg'),
        'python': sys.executable,
        'yt_dlp_module_available': bool(importlib.util.find_spec('yt_dlp')),
        'yt_dlp': resolve_yt_dlp_prefix('yt-dlp'),
    }


def sanitize_identifier(value: str) -> str:
    sanitized = []
    previous_was_separator = False
    for character in value.lower():
        if character.isalnum():
            sanitized.append(character)
            previous_was_separator = False
            continue

        if not previous_was_separator:
            sanitized.append('_')
            previous_was_separator = True

    return ''.join(sanitized).strip('_') or 'video'


def infer_upload_date(file_path: Path) -> str:
    match = next(iter(re.findall(r'(20\d{6})', file_path.name)), '')
    if match:
        return match

    return datetime.fromtimestamp(file_path.stat().st_mtime, tz=timezone.utc).strftime('%Y%m%d')


def normalize_extensions(raw_value: str) -> set[str]:
    if not raw_value.strip():
        return set(VIDEO_SUFFIXES)

    normalized = set()
    for entry in raw_value.split(','):
        extension = entry.strip().lower()
        if not extension:
            continue
        normalized.add(extension if extension.startswith('.') else f'.{extension}')

    return normalized or set(VIDEO_SUFFIXES)


def discover_local_video_files(video_directory: Path, extensions: set[str]) -> list[Path]:
    if not video_directory.exists():
        return []

    return sorted(
        file_path for file_path in video_directory.iterdir()
        if file_path.is_file() and file_path.suffix.lower() in extensions
    )


def build_local_video_id(file_path: Path, upload_date: str) -> str:
    return f"local_{upload_date}_{sanitize_identifier(file_path.stem)}"


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
            created_at,
            kind
        FROM catalog_runs
        ORDER BY run_id DESC
        LIMIT 1
        '''
    ).fetchone()
    if not row:
        return None
    result = dict(row)
    # The stored path is relative to the repository so it means the same thing
    # on every machine; the one handed back here is absolute, because the
    # person reading it wants to open the file.
    result['raw_output_path'] = resolve_portable_path(result.get('raw_output_path') or '')
    return result


def command_import_local(args: argparse.Namespace) -> int:
    pipeline_root = resolve_pipeline_root(args.pipeline_root)
    db_path = resolve_db_path(pipeline_root, args.db_path)
    ensure_layout(pipeline_root)
    video_directory = Path(args.video_dir).expanduser().resolve()
    extensions = normalize_extensions(args.extensions)

    if not video_directory.exists() or not video_directory.is_dir():
        print(f'Local video directory not found: {video_directory}', file=sys.stderr)
        return 1

    video_paths = discover_local_video_files(video_directory, extensions)
    if args.limit > 0:
        video_paths = video_paths[:args.limit]

    if not video_paths:
        print(json.dumps({
            'db_path': str(db_path),
            'imported': 0,
            'pipeline_root': str(pipeline_root),
            'status': 'idle',
            'video_directory': str(video_directory),
        }, indent=2))
        return 0

    with connect_database(db_path) as connection:
        initialize_schema(connection)
        set_setting(connection, 'last_local_video_dir', portable_stored_path(video_directory))
        inserted, updated, imported_rows = upsert_local_video_rows(
            connection,
            source_directory=video_directory,
            video_paths=video_paths,
        )

    print(json.dumps({
        'db_path': str(db_path),
        'imported': len(imported_rows),
        'inserted': inserted,
        'pipeline_root': str(pipeline_root),
        'results': imported_rows,
        'status': 'ok',
        'updated': updated,
        'video_directory': str(video_directory),
    }, indent=2))
    return 0


def command_init(args: argparse.Namespace) -> int:
    pipeline_root = resolve_pipeline_root(args.pipeline_root)
    db_path = resolve_db_path(pipeline_root, args.db_path)
    paths = ensure_layout(pipeline_root)

    with connect_database(db_path) as connection:
        initialize_schema(connection)
        set_path_setting(connection, 'pipeline_root', pipeline_root)
        for name, target in paths.items():
            set_path_setting(connection, f'path_{name}', target)

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
        'tool_resolution': describe_tool_resolution(),
        'total_videos': total_videos,
        'video_counts': status_counts,
    }, indent=2))
    return 0


def build_catalog_command(args: argparse.Namespace) -> list[str]:
    command = build_yt_dlp_prefix(args.yt_dlp_bin)

    # Drop --flat-playlist so yt-dlp resolves per-video metadata (otherwise
    # upload_date is reported as "NA"). Keep --skip-download so we never pull
    # bytes during the catalog pass.
    command.extend(['--skip-download', '--ignore-errors', '--js-runtimes', 'node'])

    if args.limit:
        command.extend(['--playlist-end', str(args.limit)])

    if args.playlist_items:
        command.extend(['--playlist-items', args.playlist_items])

    if args.cookies_from_browser:
        command.extend(['--cookies-from-browser', args.cookies_from_browser])

    if args.cookies_file:
        command.extend(['--cookies', args.cookies_file])

    if args.extractor_args:
        command.extend(['--extractor-args', args.extractor_args])

    if getattr(args, 'sleep_requests', 0):
        command.extend(['--sleep-requests', str(args.sleep_requests)])

    command.extend([
        '--print',
        '%(id)s\t%(upload_date)s\t%(title)s',
        args.source_url,
    ])
    return command


def build_yt_dlp_prefix(yt_dlp_bin: str) -> list[str]:
    return resolve_yt_dlp_prefix(yt_dlp_bin)


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


def write_catalog_snapshot(catalog_directory: Path, content: str, stderr: str = '') -> tuple[Path, Path]:
    """Write the catalog rows, and yt-dlp's stderr, as a pair of sibling files.

    The stderr file is what tells you WHICH videos the run failed on. On a
    partial run yt-dlp prints one "ERROR: [youtube] <id>: ..." line per
    failed video, and that list is exactly what the next run has to go and
    fetch -- without it, a partial import only says how MANY are missing.
    """
    slug = utc_timestamp_slug()
    snapshot_path = catalog_directory / f'catalog_{slug}.tsv'
    snapshot_path.write_text(content, encoding='utf-8')
    stderr_path = catalog_directory / f'catalog_{slug}.stderr.txt'
    stderr_path.write_text(stderr, encoding='utf-8')
    return snapshot_path, stderr_path


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


def build_command_prefix(command_bin: str) -> list[str]:
    command_target = Path(command_bin)
    if command_target.suffix.lower() == '.py':
        return [sys.executable, str(command_target)]

    return [command_bin]


def portable_path(path: Path) -> str:
    """A path that still means something on another machine.

    The catalog's snapshot paths used to be absolute Windows paths, so every
    pointer in the run history resolved on the machine that made the run and
    nowhere else. A path inside the repository is stored relative to the
    repository root; a path outside it -- a test's temporary directory, say --
    has no such form and keeps its absolute one.
    """
    try:
        return path.resolve().relative_to(WORKSPACE_ROOT).as_posix()
    except ValueError:
        return str(path)


def portable_stored_path(value: str | Path | None) -> str:
    """Store a path so it still means something on another machine.

    `portable_path` takes a `Path`; this takes whatever a caller happens to
    have -- a string from a command line, a `Path` from the filesystem -- and
    returns the form that should go in the database.

    A path that is already relative is left alone: it is already portable, and
    guessing at its base would only make it wrong.
    """
    if value is None:
        return ''
    text = str(value)
    if not text:
        return text
    candidate = Path(text)
    if not candidate.is_absolute():
        return text
    return portable_path(candidate)


def resolve_portable_path(stored: str) -> str:
    """Turn a stored path back into one you can open.

    The inverse of `portable_path`: a relative path is resolved against the
    repository root, an absolute one is left alone.
    """
    if not stored:
        return stored
    candidate = Path(stored)
    if candidate.is_absolute():
        return str(candidate)
    return str((WORKSPACE_ROOT / candidate).resolve())


def catalog_run_kind(source_url: str) -> str:
    """Whether a catalog run was a real one or a test fixture.

    The worker's fixtures point at `example.com/mock-playlist`. They are
    self-labelling, but they still made up four of the twenty-eight rows in the
    audit table, and a reader had to know that to discount them.
    """
    return 'live' if 'youtube.com' in (source_url or '').lower() else 'fixture'


def record_catalog_run(
    connection: sqlite3.Connection,
    *,
    channel: str = '',
    command: list[str],
    inserted: int,
    listing_complete: bool = False,
    malformed_rows: int,
    missing_upload_dates: int,
    not_listed_count: int = 0,
    raw_output_path: Path,
    row_count: int,
    row_count_kind: str = '',
    source_url: str,
    updated: int,
) -> None:
    connection.execute(
        '''
        INSERT INTO catalog_runs (
            source_url,
            channel,
            command_json,
            raw_output_path,
            row_count,
            inserted_count,
            updated_count,
            missing_upload_dates,
            malformed_rows,
            created_at,
            kind,
            not_listed_count,
            listing_complete,
            row_count_kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''',
        (
            source_url,
            channel,
            json.dumps(command),
            portable_path(raw_output_path),
            row_count,
            inserted,
            updated,
            missing_upload_dates,
            malformed_rows,
            utc_now_iso(),
            catalog_run_kind(source_url),
            not_listed_count,
            1 if listing_complete else 0,
            row_count_kind,
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
    output_path: str | None = None,
    review_reason: str | None = None,
    selected_score: float | None = None,
    selected_timestamp: float | None = None,
) -> None:
    assignments = ['status = ?', 'updated_at = ?']
    values: list[object] = [status, utc_now_iso()]

    if download_path is not None:
        assignments.append('download_path = ?')
        values.append(portable_stored_path(download_path))

    if error is not None:
        assignments.append('error = ?')
        values.append(error)

    if output_path is not None:
        assignments.append('output_path = ?')
        values.append(portable_stored_path(output_path))

    if review_reason is not None:
        assignments.append('review_reason = ?')
        values.append(review_reason)

    if selected_score is not None:
        assignments.append('selected_score = ?')
        values.append(selected_score)

    if selected_timestamp is not None:
        assignments.append('selected_timestamp = ?')
        values.append(selected_timestamp)

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
        '--js-runtimes', 'node',
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


def locate_existing_download(download_directory: Path, video_id: str, upload_date: str) -> Path | None:
    """Find a previously-downloaded file on disk for this video id, preferring
    a path whose filename starts with the expected upload_date prefix. Returns
    None when no candidate file is present.

    The date-prefix preference guards against a stale local file from a
    different upload (e.g. someone re-uploaded the same video id at a later
    date) silently being treated as the new copy.
    """
    if upload_date:
        date_prefix_matches = sorted(
            download_directory.glob(f'{upload_date}_{video_id}.*')
        ) if download_directory.exists() else []
        non_part = [match for match in date_prefix_matches if match.suffix != '.part']
        if non_part:
            return non_part[0]

    return locate_downloaded_file(download_directory, video_id)


def resolve_reference_dir(pipeline_root: Path, value: str) -> Path:
    if value:
        return Path(value).expanduser().resolve()

    return pipeline_root / 'references'


def list_reference_images(reference_directory: Path) -> list[Path]:
    if not reference_directory.exists():
        return []

    return sorted(
        file_path for file_path in reference_directory.iterdir()
        if file_path.is_file() and file_path.suffix.lower() in REFERENCE_SUFFIXES
    )


def read_raw_gray_frame(command: list[str], frame_size: int) -> bytes:
    result = subprocess.run(command, capture_output=True, check=False)
    if result.returncode != 0:
        message = result.stderr.decode('utf-8', errors='ignore').strip() or 'ffmpeg frame decode failed.'
        raise RuntimeError(message)

    if len(result.stdout) != frame_size:
        raise RuntimeError(f'Expected {frame_size} grayscale bytes, received {len(result.stdout)}.')

    return result.stdout


def create_scale_filter(width: int, height: int) -> str:
    return (
        f'scale={width}:{height}:force_original_aspect_ratio=decrease,'
        f'pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,format=gray'
    )


def decode_media_hash(ffmpeg_bin: str, media_path: Path, width: int, height: int) -> bytes:
    frame_size = width * height
    command = build_command_prefix(resolve_ffmpeg_bin(ffmpeg_bin))
    command.extend([
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        str(media_path),
        '-frames:v',
        '1',
        '-vf',
        create_scale_filter(width, height),
        '-f',
        'rawvideo',
        '-pix_fmt',
        'gray',
        '-',
    ])
    return read_raw_gray_frame(command, frame_size)


def build_average_hash(pixels: bytes) -> int:
    if not pixels:
        return 0

    average_value = sum(pixels) / len(pixels)
    bit_value = 0
    for pixel in pixels:
        bit_value <<= 1
        if pixel >= average_value:
            bit_value |= 1

    return bit_value


def hash_similarity(left_hash: int, right_hash: int, bit_count: int) -> float:
    difference = (left_hash ^ right_hash).bit_count()
    return 1 - (difference / bit_count)


def load_reference_hashes(reference_directory: Path, ffmpeg_bin: str) -> list[dict[str, object]]:
    references = []
    for reference_path in list_reference_images(reference_directory):
        pixels = decode_media_hash(ffmpeg_bin, reference_path, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT)
        references.append({
            'hash': build_average_hash(pixels),
            'path': str(reference_path),
        })

    return references


def stream_sample_frames(video_path: Path, ffmpeg_bin: str, sample_fps: float) -> list[dict[str, float | int]]:
    frame_size = THUMBNAIL_WIDTH * THUMBNAIL_HEIGHT
    command = build_command_prefix(resolve_ffmpeg_bin(ffmpeg_bin))
    command.extend([
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        str(video_path),
        '-vf',
        f'fps={sample_fps},{create_scale_filter(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT)}',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'gray',
        '-',
    ])

    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frames = []
    index = 0
    sample_interval = 1 / sample_fps

    assert process.stdout is not None
    while True:
        chunk = process.stdout.read(frame_size)
        if not chunk:
            break

        if len(chunk) != frame_size:
            process.kill()
            raise RuntimeError('ffmpeg returned a partial grayscale frame during sampling.')

        frames.append({
            'hash': build_average_hash(chunk),
            'index': index,
            'timestamp': round(index * sample_interval, 3),
        })
        index += 1

    assert process.stderr is not None
    stderr_output = process.stderr.read().decode('utf-8', errors='ignore')
    return_code = process.wait()
    if return_code != 0:
        raise RuntimeError(stderr_output.strip() or 'ffmpeg sampling command failed.')

    return frames


def score_sample_frames(frames: list[dict[str, float | int]], references: list[dict[str, object]]) -> list[dict[str, float | int]]:
    if not references:
        return []

    scored_frames = []
    for frame in frames:
        similarities = [
            hash_similarity(int(frame['hash']), int(reference['hash']), THUMBNAIL_WIDTH * THUMBNAIL_HEIGHT)
            for reference in references
        ]
        scored_frames.append({
            'hash': frame['hash'],
            'index': frame['index'],
            'score': round(max(similarities), 4),
            'timestamp': frame['timestamp'],
        })

    return scored_frames


def group_candidate_windows(scored_frames: list[dict[str, float | int]], threshold: float) -> list[list[dict[str, float | int]]]:
    windows = []
    current_window: list[dict[str, float | int]] = []

    for frame in scored_frames:
        if float(frame['score']) >= threshold:
            current_window.append(frame)
            continue

        if current_window:
            windows.append(current_window)
            current_window = []

    if current_window:
        windows.append(current_window)

    return windows


def choose_best_window(windows: list[list[dict[str, float | int]]]) -> list[dict[str, float | int]]:
    return max(
        windows,
        key=lambda window: (
            len(window),
            sum(float(frame['score']) for frame in window) / len(window),
            float(window[-1]['timestamp']),
        ),
    )


def decode_sharpness_pixels(ffmpeg_bin: str, media_path: Path, timestamp: float) -> bytes:
    frame_size = SHARPNESS_WIDTH * SHARPNESS_HEIGHT
    command = build_command_prefix(resolve_ffmpeg_bin(ffmpeg_bin))
    command.extend([
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        f'{timestamp:.3f}',
        '-i',
        str(media_path),
        '-frames:v',
        '1',
        '-vf',
        create_scale_filter(SHARPNESS_WIDTH, SHARPNESS_HEIGHT),
        '-f',
        'rawvideo',
        '-pix_fmt',
        'gray',
        '-',
    ])
    return read_raw_gray_frame(command, frame_size)


def compute_sharpness(pixels: bytes, width: int, height: int) -> float:
    total = 0
    for row_index in range(height - 1):
        row_offset = row_index * width
        next_row_offset = (row_index + 1) * width
        for column_index in range(width - 1):
            current = pixels[row_offset + column_index]
            total += abs(current - pixels[row_offset + column_index + 1])
            total += abs(current - pixels[next_row_offset + column_index])

    return total / max(1, (width - 1) * (height - 1) * 2)


def choose_final_frame(
    ffmpeg_bin: str,
    video_path: Path,
    window: list[dict[str, float | int]],
    score_margin: float,
    candidate_limit: int,
) -> dict[str, float | int]:
    best_score = max(float(frame['score']) for frame in window)
    eligible = [frame for frame in window if float(frame['score']) >= best_score - score_margin]
    candidates = eligible[-candidate_limit:] if len(eligible) > candidate_limit else eligible
    ranked = []
    for frame in candidates:
        sharpness_pixels = decode_sharpness_pixels(ffmpeg_bin, video_path, float(frame['timestamp']))
        ranked.append({
            **frame,
            'sharpness': round(compute_sharpness(sharpness_pixels, SHARPNESS_WIDTH, SHARPNESS_HEIGHT), 4),
        })

    return max(
        ranked,
        key=lambda frame: (
            float(frame['sharpness']),
            float(frame['timestamp']),
            float(frame['score']),
        ),
    )


def allocate_whiteboard_output_path(screenshot_directory: Path, upload_date: str, video_id: str) -> Path:
    stem = upload_date if upload_date else f'undated_{video_id}'
    candidate = screenshot_directory / f'{stem}_ps.jpg'
    if not candidate.exists():
        return candidate

    suffix = 2
    while True:
        candidate = screenshot_directory / f'{stem}_ps_{suffix}.jpg'
        if not candidate.exists():
            return candidate
        suffix += 1


def allocate_snapshot_output_path(snapshot_directory: Path, upload_date: str, video_id: str) -> Path:
    if not upload_date:
        raise RuntimeError(f'Snapshot output requires an inferred upload date for {video_id}.')

    stem = f'revere_{upload_date}'
    candidate = snapshot_directory / f'{stem}.png'
    if not candidate.exists():
        return candidate

    suffix = 2
    while True:
        candidate = snapshot_directory / f'{stem}_{suffix}.png'
        if not candidate.exists():
            return candidate
        suffix += 1


def allocate_scan_output_path(paths: dict[str, Path], upload_date: str, video_id: str, output_kind: str) -> Path:
    if output_kind == 'snapshot':
        return allocate_snapshot_output_path(paths['snapshots'], upload_date, video_id)

    return allocate_whiteboard_output_path(paths['screenshots'], upload_date, video_id)


def extract_frame_to_file(ffmpeg_bin: str, media_path: Path, timestamp: float, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    command = build_command_prefix(resolve_ffmpeg_bin(ffmpeg_bin))
    command.extend([
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        f'{timestamp:.3f}',
        '-i',
        str(media_path),
        '-frames:v',
        '1',
        '-q:v',
        '2',
        str(output_path),
    ])
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or 'ffmpeg frame extraction failed.')


def select_videos_for_scan(
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
        WHERE status IN ('scanning', 'review') AND download_path <> ''
        ORDER BY upload_date ASC, video_id ASC
        LIMIT ?
        ''',
        (limit,),
    ).fetchall()


def upsert_local_video_rows(
    connection: sqlite3.Connection,
    *,
    source_directory: Path,
    video_paths: list[Path],
) -> tuple[int, int, list[dict[str, str]]]:
    inserted = 0
    updated = 0
    imported_rows = []

    for video_path in video_paths:
        upload_date = infer_upload_date(video_path)
        video_id = build_local_video_id(video_path, upload_date)
        existing = connection.execute(
            'SELECT video_id FROM videos WHERE video_id = ?',
            (video_id,),
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
                download_path,
                output_path,
                selected_timestamp,
                selected_score,
                review_reason,
                error,
                created_at,
                updated_at
            ) VALUES (?, ?, '', ?, ?, 'scanning', ?, '', NULL, NULL, '', '', ?, ?)
            ON CONFLICT(video_id) DO UPDATE SET
                source_url = excluded.source_url,
                title = excluded.title,
                upload_date = excluded.upload_date,
                download_path = excluded.download_path,
                status = CASE
                    WHEN videos.status = 'done' THEN 'done'
                    WHEN videos.status = 'review' THEN 'review'
                    ELSE 'scanning'
                END,
                error = '',
                updated_at = excluded.updated_at
            ''',
            (
                video_id,
                str(source_directory),
                video_path.name,
                upload_date,
                portable_stored_path(video_path),
                timestamp,
                timestamp,
            ),
        )

        imported_rows.append({
            'download_path': portable_stored_path(video_path),
            'source_file': video_path.name,
            'upload_date': upload_date,
            'video_id': video_id,
        })
        if existing is None:
            inserted += 1
        else:
            updated += 1

    connection.commit()
    return inserted, updated, imported_rows


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
    reused = 0
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

            # Disk dedup: if a file matching <upload_date>_<id>.<ext> already
            # exists on disk from a prior session, treat the row as already
            # downloaded and skip the yt-dlp call entirely.
            existing_file = locate_existing_download(
                paths['downloads'],
                row['video_id'],
                row['upload_date'],
            )
            if existing_file is not None:
                update_video_row(
                    connection,
                    video_id=row['video_id'],
                    status='scanning',
                    download_path=str(existing_file),
                    error='',
                )
                results.append({
                    'download_path': str(existing_file),
                    'reused_from_disk': True,
                    'status': 'scanning',
                    'video_id': row['video_id'],
                })
                reused += 1
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
        'reused_from_disk': reused,
        'errored': errored,
        'pipeline_root': str(pipeline_root),
        'results': results,
        'status': 'ok' if not errored else 'partial',
    }, indent=2))
    return 0 if not errored else 1


def command_scan(args: argparse.Namespace) -> int:
    pipeline_root = resolve_pipeline_root(args.pipeline_root)
    db_path = resolve_db_path(pipeline_root, args.db_path)
    paths = ensure_layout(pipeline_root)
    reference_directory = resolve_reference_dir(pipeline_root, args.reference_dir)

    if not db_path.exists():
        print('Worker state is missing. Run `npm run video:init` first.', file=sys.stderr)
        return 1

    reference_hashes = load_reference_hashes(reference_directory, args.ffmpeg_bin)
    if not reference_hashes:
        print(f'No reference images were found in {reference_directory}.', file=sys.stderr)
        return 1

    with connect_database(db_path) as connection:
        initialize_schema(connection)
        selected_rows = select_videos_for_scan(
            connection,
            limit=max(1, args.limit),
            video_id=args.video_id,
        )

    if not selected_rows:
        print(json.dumps({
            'attempted': 0,
            'db_path': str(db_path),
            'pipeline_root': str(pipeline_root),
            'status': 'idle',
        }, indent=2))
        return 0

    results = []
    done_count = 0
    review_count = 0
    no_match_count = 0
    error_count = 0

    with connect_database(db_path) as connection:
        for row in selected_rows:
            download_path = Path(resolve_portable_path(row['download_path']))
            if not download_path.exists():
                message = f'Download file is missing: {download_path}'
                update_video_row(connection, video_id=row['video_id'], status='error', error=message)
                results.append({'error': message, 'status': 'error', 'video_id': row['video_id']})
                error_count += 1
                continue

            try:
                sampled_frames = stream_sample_frames(download_path, args.ffmpeg_bin, args.sample_fps)
                scored_frames = score_sample_frames(sampled_frames, reference_hashes)
                if not scored_frames:
                    raise RuntimeError('No sampled frames were produced for this video.')

                candidate_windows = [
                    window for window in group_candidate_windows(scored_frames, args.similarity_threshold)
                    if len(window) >= args.min_window_length
                ]

                if candidate_windows:
                    best_window = choose_best_window(candidate_windows)
                    selected_frame = choose_final_frame(
                        args.ffmpeg_bin,
                        download_path,
                        best_window,
                        args.score_margin,
                        args.candidate_limit,
                    )
                    output_path = allocate_scan_output_path(paths, row['upload_date'], row['video_id'], args.output_kind)
                    extract_frame_to_file(args.ffmpeg_bin, download_path, float(selected_frame['timestamp']), output_path)
                    summary = {
                        'best_window_end': best_window[-1]['timestamp'],
                        'best_window_length': len(best_window),
                        'output_kind': args.output_kind,
                        'best_window_start': best_window[0]['timestamp'],
                        'output_path': str(output_path),
                        'selected_frame': selected_frame,
                        'video_id': row['video_id'],
                    }
                    log_path = write_log_file(paths['logs'], f"scan_{row['video_id']}", json.dumps(summary, indent=2), '')
                    update_video_row(
                        connection,
                        video_id=row['video_id'],
                        status='done',
                        error='',
                        output_path=str(output_path),
                        review_reason='',
                        selected_score=float(selected_frame['score']),
                        selected_timestamp=float(selected_frame['timestamp']),
                    )
                    results.append({
                        'log_path': str(log_path),
                        'output_path': str(output_path),
                        'score': selected_frame['score'],
                        'status': 'done',
                        'timestamp': selected_frame['timestamp'],
                        'video_id': row['video_id'],
                    })
                    done_count += 1
                    continue

                best_frame = max(scored_frames, key=lambda frame: (float(frame['score']), float(frame['timestamp'])))
                if float(best_frame['score']) >= args.review_threshold:
                    review_path = paths['review'] / f"{row['upload_date'] or row['video_id']}_{row['video_id']}_review.jpg"
                    extract_frame_to_file(args.ffmpeg_bin, download_path, float(best_frame['timestamp']), review_path)
                    summary = {
                        'best_frame': best_frame,
                        'reason': 'review_threshold_only',
                        'review_path': str(review_path),
                        'video_id': row['video_id'],
                    }
                    log_path = write_log_file(paths['logs'], f"scan_{row['video_id']}", json.dumps(summary, indent=2), '')
                    update_video_row(
                        connection,
                        video_id=row['video_id'],
                        status='review',
                        error='',
                        output_path=str(review_path),
                        review_reason='similarity_below_autosave_threshold',
                        selected_score=float(best_frame['score']),
                        selected_timestamp=float(best_frame['timestamp']),
                    )
                    results.append({
                        'log_path': str(log_path),
                        'output_path': str(review_path),
                        'score': best_frame['score'],
                        'status': 'review',
                        'timestamp': best_frame['timestamp'],
                        'video_id': row['video_id'],
                    })
                    review_count += 1
                    continue

                summary = {
                    'best_frame': best_frame,
                    'reason': 'no_candidate_window',
                    'video_id': row['video_id'],
                }
                log_path = write_log_file(paths['logs'], f"scan_{row['video_id']}", json.dumps(summary, indent=2), '')
                update_video_row(
                    connection,
                    video_id=row['video_id'],
                    status='no_match',
                    error='',
                    output_path='',
                    review_reason='no_candidate_window',
                    selected_score=float(best_frame['score']),
                    selected_timestamp=float(best_frame['timestamp']),
                )
                results.append({
                    'log_path': str(log_path),
                    'score': best_frame['score'],
                    'status': 'no_match',
                    'timestamp': best_frame['timestamp'],
                    'video_id': row['video_id'],
                })
                no_match_count += 1
            except RuntimeError as error:
                update_video_row(connection, video_id=row['video_id'], status='error', error=str(error))
                results.append({'error': str(error), 'status': 'error', 'video_id': row['video_id']})
                error_count += 1

    print(json.dumps({
        'attempted': len(selected_rows),
        'db_path': str(db_path),
        'done': done_count,
        'errored': error_count,
        'no_match': no_match_count,
        'pipeline_root': str(pipeline_root),
        'reference_count': len(reference_hashes),
        'reference_directory': str(reference_directory),
        'results': results,
        'review': review_count,
        'status': 'ok' if not error_count else 'partial',
    }, indent=2))
    return 0 if not error_count else 1


def upsert_catalog_rows(connection: sqlite3.Connection, source_url: str, rows: list[dict[str, str]], channel: str = '') -> tuple[int, int]:
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
                channel,
                status,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
            ON CONFLICT(video_id) DO UPDATE SET
                source_url = CASE
                    WHEN excluded.source_url <> '' THEN excluded.source_url
                    ELSE videos.source_url
                END,
                video_url = CASE
                    WHEN excluded.video_url <> '' THEN excluded.video_url
                    ELSE videos.video_url
                END,
                title = CASE
                    WHEN excluded.title <> '' THEN excluded.title
                    ELSE videos.title
                END,
                upload_date = CASE
                    WHEN excluded.upload_date <> '' THEN excluded.upload_date
                    ELSE videos.upload_date
                END,
                channel = CASE
                    WHEN excluded.channel <> '' THEN excluded.channel
                    ELSE videos.channel
                END,
                updated_at = excluded.updated_at
            ''',
            (
                row['video_id'],
                source_url,
                row['video_url'],
                row['title'],
                row['upload_date'],
                channel,
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


def find_not_listed(
    connection: sqlite3.Connection,
    *,
    channel: str,
    listed_video_ids: set[str],
) -> list[str]:
    """The catalog's rows for this channel that the listing did not contain.

    A channel's `/videos` listing is what the channel currently shows, so a
    row the catalog holds and the listing does not is worth reporting. It is
    NOT proof of deletion: a video that became a Short, a livestream or
    members-only content is not listed there either, and neither is one the
    run failed to fetch. So nothing is deleted -- the caller reports it.
    """
    rows = connection.execute(
        'SELECT video_id FROM videos WHERE channel = ? ORDER BY video_id',
        (channel,),
    ).fetchall()
    return [row['video_id'] for row in rows if row['video_id'] not in listed_video_ids]


def listing_is_complete(args: argparse.Namespace, stderr_text: str) -> bool:
    """Could this run's listing have missed a video the channel has?

    Three ways it can: the run was truncated (`--limit`, `--playlist-items`),
    it stopped early (yt-dlp's exit code), or a single video failed -- which
    `--ignore-errors` turns into a line on stderr and an exit code of 0.

    A run that cannot be shown to be complete may still report rows it did
    not list, but the report has to say so.
    """
    if getattr(args, 'limit', 0):
        return False
    if getattr(args, 'playlist_items', ''):
        return False
    if 'ERROR' in (stderr_text or ''):
        return False
    return True


def command_catalog(args: argparse.Namespace) -> int:
    pipeline_root = resolve_pipeline_root(args.pipeline_root)
    db_path = resolve_db_path(pipeline_root, args.db_path)
    paths = ensure_layout(pipeline_root)

    if not db_path.exists():
        print('Worker state is missing. Run `npm run video:init` first.', file=sys.stderr)
        return 1

    # Resolve the effective channel. If `--channel` was omitted, infer from
    # the source URL (handle-based channels only — playlist URLs default to
    # 'revere' for backward compat with existing scripts).
    effective_channel = args.channel or infer_channel_from_url(args.source_url) or 'revere'

    command = build_catalog_command(args)
    result = subprocess.run(command, capture_output=True, text=True, check=False)

    rows = []
    malformed_lines = []
    for raw_line in result.stdout.splitlines():
        parsed = parse_catalog_line(raw_line)
        if parsed:
            rows.append(parsed)
        elif raw_line.strip():
            malformed_lines.append(raw_line)

    if not rows:
        # Nothing usable came back, so there is nothing to import. Report
        # yt-dlp's own failure, which is the more useful message.
        message = result.stderr.strip() or result.stdout.strip() or 'yt-dlp catalog command failed.'
        print(message, file=sys.stderr)
        return result.returncode or 1

    # Write the snapshot BEFORE reporting, so the warning can point at the
    # file that names the videos the run failed on.
    snapshot_path, stderr_path = write_catalog_snapshot(paths['catalog'], result.stdout, result.stderr)

    if result.returncode != 0:
        # yt-dlp failed on SOME videos but printed complete records for the
        # others. Those records are good — a per-video failure on video 600
        # does not invalidate videos 1..599 — so they are imported, and the
        # failure is reported rather than swallowed. The next run fills the
        # gap. (A full Qullamaggie catalog is ~3.5 h; bailing here once cost
        # all of it when DNS blipped near the end.)
        print(
            f'WARNING: yt-dlp exited {result.returncode} but printed {len(rows)} usable rows; '
            'importing them. The videos it failed on are missing and need another run. '
            f'yt-dlp named them here: {stderr_path}',
            file=sys.stderr,
        )

    missing_upload_dates = sum(1 for row in rows if not row['upload_date'])

    with connect_database(db_path) as connection:
        initialize_schema(connection)
        set_setting(connection, 'source_url', args.source_url)
        set_setting(connection, 'channel', effective_channel)
        set_path_setting(connection, 'last_catalog_output_path', snapshot_path)
        set_setting(connection, 'last_catalog_import_at', utc_now_iso())
        inserted, updated = upsert_catalog_rows(connection, args.source_url, rows, channel=effective_channel)
        not_listed = find_not_listed(
            connection,
            channel=effective_channel,
            listed_video_ids={row['video_id'] for row in rows},
        )
        listing_complete = listing_is_complete(args, result.stderr)
        record_catalog_run(
            connection,
            command=command,
            inserted=inserted,
            malformed_rows=len(malformed_lines),
            missing_upload_dates=missing_upload_dates,
            not_listed_count=len(not_listed),
            listing_complete=listing_complete,
            raw_output_path=snapshot_path,
            row_count=len(rows),
            row_count_kind='listing_rows',
            source_url=args.source_url,
            updated=updated,
            channel=effective_channel,
        )

    print(json.dumps({
        'cataloged_rows': len(rows),
        'channel': effective_channel,
        'db_path': str(db_path),
        'inserted': inserted,
        'listing_complete': listing_complete,
        'malformed_rows': len(malformed_lines),
        'missing_upload_dates': missing_upload_dates,
        'not_listed_count': len(not_listed),
        'not_listed_video_ids': not_listed[:50],
        'pipeline_root': str(pipeline_root),
        'raw_output_path': str(snapshot_path),
        'source_url': args.source_url,
        'status': 'ok' if result.returncode == 0 else 'partial',
        'updated': updated,
        'yt_dlp_command': command,
        'yt_dlp_returncode': result.returncode,
        'yt_dlp_stderr_path': str(stderr_path),
    }, indent=2))

    if not_listed:
        qualification = (
            "This run's listing covered the whole channel, so these are the rows the "
            'channel no longer shows.'
            if listing_complete else
            "This run's listing was NOT complete -- it was truncated, or a video failed "
            '-- so a row missing from it proves nothing here.'
        )
        print(
            f'NOTE: {len(not_listed)} catalog row(s) for {effective_channel} were not in this '
            f'run\'s listing. {qualification} A video missing from a /videos listing may '
            'have become a Short, a livestream or members-only content -- it is not proof '
            'of deletion, and nothing was deleted.',
            file=sys.stderr,
        )

    if malformed_lines:
        print(json.dumps({'malformed_examples': malformed_lines[:5]}, indent=2), file=sys.stderr)

    return 0


# The separator in a listing file is not always a tab. The listing documented in
# CLAUDE.md is produced through a shell, and the shell hands yt-dlp the two
# characters backslash-t, which yt-dlp prints verbatim. A listing written from
# Python carries a real tab. Both are read, and the choice is made once per
# file rather than per line, so a title containing a tab cannot shift the
# separator halfway down the file.
LITERAL_TAB = chr(92) + 't'


def read_wanted_rows(path: str) -> list[tuple[str, str]]:
    """Read a TSV of `video_id<TAB>title` — the videos whose metadata is missing.

    The same reader serves the channel listing and the work list built from it;
    they have the same shape.

    Two traps this survives, both of them real on this machine:

    * The separator may be a real tab or a literal backslash-t. Splitting a
      literal-tab listing on a real tab yields one field per line, and the
      whole line -- id AND title -- becomes the video_id.
    * The bytes may not be UTF-8. yt-dlp's stdout passes through the console
      codepage on Windows, so a title with an em-dash lands as cp1252 and
      decoding it as UTF-8 mangles every such title in the file. Decode as
      UTF-8 first and fall back to cp1252 rather than replacing the characters.
    """
    with open(path, 'rb') as handle:
        raw = handle.read()
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        text = raw.decode('cp1252', errors='replace')

    separator = ''
    for candidate in text.splitlines():
        if not candidate.strip():
            continue
        if '\t' in candidate:
            separator = '\t'
        elif LITERAL_TAB in candidate:
            separator = LITERAL_TAB
        break
    if not separator:
        return []

    wanted: list[tuple[str, str]] = []
    seen: set[str] = set()
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = line.split(separator, 1)
        video_id = parts[0].strip()
        if not video_id or video_id in seen:
            continue
        seen.add(video_id)
        title = parts[1].strip() if len(parts) > 1 else ''
        wanted.append((video_id, title))
    return wanted


def build_wanted_from_listing(
    connection: sqlite3.Connection,
    listing: list[tuple[str, str]],
    *,
    refresh: bool = False,
) -> list[tuple[str, str]]:
    """The listing's videos whose upload_date the database does not have.

    The listing is the channel's ground truth of what exists; the database is
    the record of what has been dated. The difference is the work list, and
    deriving it here is what makes the gap-fill runnable from a fresh clone --
    the listing plus the database are the only two inputs, and both are
    reproducible.

    With `refresh`, the videos that already have a date are wanted too. A date
    that was resolved wrongly is otherwise permanent: the skip is what makes a
    second pass cheap, but it is also what makes the error unfalsifiable.
    """
    dated = set() if refresh else {
        row['video_id'] for row in connection.execute(
            "SELECT video_id FROM videos WHERE COALESCE(upload_date, '') <> ''"
        )
    }
    wanted: list[tuple[str, str]] = []
    seen: set[str] = set()
    for video_id, title in listing:
        if video_id in dated or video_id in seen:
            continue
        seen.add(video_id)
        wanted.append((video_id, title))
    return wanted


def fetch_channel_listing(
    source_url: str,
    args: argparse.Namespace,
) -> tuple[list[tuple[str, str]], str, list[str]]:
    """Ask YouTube for a channel's video list: id and title, no dates.

    One yt-dlp invocation over the channel URL, so the listing costs one call
    rather than one call per video. The template carries a REAL tab, which is
    the difference between a listing this reader can parse and the
    shell-produced one it has to special-case.

    Returns the parsed rows, the raw stdout, and the command that produced
    them.
    """
    command = build_yt_dlp_prefix(args.yt_dlp_bin) + [
        '--flat-playlist',
        '--skip-download',
        '--ignore-errors',
        '--js-runtimes', 'node',
        '--extractor-args', args.listing_extractor_args,
        '--print', '%(id)s\t%(title)s',
        source_url,
    ]
    env = dict(os.environ)
    env['PYTHONIOENCODING'] = 'utf-8'
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
        check=False,
        env=env,
    )

    rows: list[tuple[str, str]] = []
    seen: set[str] = set()
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split('\t', 1)
        video_id = parts[0].strip()
        if not video_id or video_id in seen:
            continue
        seen.add(video_id)
        title = parts[1].strip() if len(parts) > 1 else ''
        rows.append((video_id, title))
    return rows, result.stdout, command


def persist_missing_titles(
    connection: sqlite3.Connection,
    entries: list[tuple[str, str]],
    source_url: str,
    channel: str,
) -> int:
    """Store the title of a video whose date could not be fetched.

    A video the channel listing names but that yt-dlp will not resolve -- an
    age-restricted upload, say -- is still a video, and its title is known from
    the listing. The database has a column for it. Leaving that column empty
    means the one piece of information about such a video exists only in a
    scratch file that is not in version control.

    A title is only written where the database has none. The listing is a
    lossy copy of the titles -- the Windows console codepage drops emoji -- so
    a good title already in the database is never replaced by a worse one.
    """
    written = 0
    timestamp = utc_now_iso()
    for video_id, title in entries:
        if not title:
            continue
        row = connection.execute(
            'SELECT title FROM videos WHERE video_id = ?',
            (video_id,),
        ).fetchone()
        if row is None:
            connection.execute(
                '''
                INSERT INTO videos (
                    video_id, source_url, video_url, title, upload_date,
                    channel, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, '', ?, 'pending', ?, ?)
                ''',
                (
                    video_id,
                    source_url,
                    f'https://www.youtube.com/watch?v={video_id}',
                    title,
                    channel,
                    timestamp,
                    timestamp,
                ),
            )
            written += 1
            continue
        if (row['title'] or '').strip():
            continue
        connection.execute(
            'UPDATE videos SET title = ?, updated_at = ? WHERE video_id = ?',
            (title, timestamp, video_id),
        )
        written += 1
    connection.commit()
    return written


def fetch_dates_for(entries: list[tuple[str, str]], args: argparse.Namespace) -> tuple[list[dict], list[str]]:
    """Fetch upload_date for a batch of videos.

    One yt-dlp invocation over a batch file of `watch?v=` URLs. The client set
    matters more than anything else here. Measured on the same videos:
    `mweb` alone took 4.2 s per video, `mweb,ios,android,web` took 8.5 s, and
    `ios,android,web` took 123 s on the 181-video Qullamaggie list. yt-dlp
    queries EVERY client in the list, so a longer list costs time on every
    video, not only on the ones that fail. `web` alone and `web_safari,web`
    both fail outright, and the blocked `web_safari` costs a full failed
    attempt per video.
    """
    handle = tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False, encoding='utf-8')
    try:
        for video_id, _title in entries:
            handle.write(f'https://www.youtube.com/watch?v={video_id}\n')
        handle.close()

        command = build_yt_dlp_prefix(args.yt_dlp_bin) + [
            '--batch-file', handle.name,
            '--skip-download',
            '--ignore-errors',
            '--js-runtimes', 'node',
            '--extractor-args', args.extractor_args,
            '--print', '%(id)s\t%(upload_date)s\t%(title)s',
        ]

        # yt-dlp's stdout is UTF-8, but on Windows Python encodes it with the
        # console codepage, which mangles any title outside ASCII. Pin the
        # child's encoding and decode the parent side the same way.
        env = dict(os.environ)
        env['PYTHONIOENCODING'] = 'utf-8'
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            check=False,
            env=env,
        )
    finally:
        try:
            os.unlink(handle.name)
        except OSError:
            pass

    titles = {video_id: title for video_id, title in entries}
    rows: list[dict] = []
    resolved: set[str] = set()
    for raw_line in result.stdout.splitlines():
        parsed = parse_catalog_line(raw_line)
        if not parsed:
            continue
        resolved.add(parsed['video_id'])
        if not parsed['title']:
            parsed['title'] = titles.get(parsed['video_id'], '')
        rows.append(parsed)

    missing = [video_id for video_id, _ in entries if video_id not in resolved]
    return rows, missing


def command_fill_dates(args: argparse.Namespace) -> int:
    """Fill in the upload_date of videos the catalog listed but could not resolve.

    The catalog resolves every video of a channel one at a time, so a channel
    with thousands of videos takes hours and a per-video failure leaves a row
    with no metadata at all. This command takes the list of videos that are
    still missing a date and resolves them directly, in parallel batches.

    Each video costs ~4 s of network wait and ~0.001 s of CPU, so the work is
    free in CPU terms and parallelises cleanly.

    The work is saved per BATCH, not at the end. A run over thousands of
    videos is long enough to be worth interrupting -- the client set can be
    tuned, the machine is busy, the user wants it stopped -- and a batch that
    has been written is not lost when the run stops. `catalog` has the same
    property: a partial run is kept.
    """
    pipeline_root = resolve_pipeline_root(args.pipeline_root)
    db_path = resolve_db_path(pipeline_root, args.db_path)
    paths = ensure_layout(pipeline_root)

    if not db_path.exists():
        print('Worker state is missing. Run `npm run video:init` first.', file=sys.stderr)
        return 1

    wanted: list[tuple[str, str]] = []
    listing: list[tuple[str, str]] = []
    listing_output = ''
    listing_command: list[str] = []

    effective_channel = args.channel or infer_channel_from_url(args.source_url or '')
    if not effective_channel:
        print('Could not tell which channel this is: pass --channel.', file=sys.stderr)
        return 1

    with connect_database(db_path) as connection:
        initialize_schema(connection)
        source_url = resolve_channel_source_url(connection, effective_channel, args.source_url)

        # The listing is the channel's ground truth of what exists. It can be
        # fetched here or read from a file; either way the work list is derived
        # from it and the database, so nothing outside the repository is needed
        # to decide what is still missing.
        if args.build_listing:
            if not source_url:
                print('Could not tell which channel to list: pass --channel.', file=sys.stderr)
                return 1
            listing, listing_output, listing_command = fetch_channel_listing(source_url, args)
            print(f'Listed {len(listing)} videos from {source_url}.', file=sys.stderr)
        elif args.from_listing:
            listing = read_wanted_rows(args.from_listing)
            print(f'Read {len(listing)} videos from {args.from_listing}.', file=sys.stderr)

        if args.input:
            wanted = read_wanted_rows(args.input)
        else:
            wanted = build_wanted_from_listing(connection, listing, refresh=args.refresh)

        if not wanted:
            print('Nothing to fill: there is no video left without a date.', file=sys.stderr)
            return 1

        # A video that already has a date needs nothing. Skipping them makes a
        # second pass cheap: run the fast client over the whole list, then run
        # the slower fallbacks over the same list and only the stragglers are
        # fetched.
        #
        # `--refresh` turns that skip off. The upsert already overwrites a
        # date with a freshly resolved one, so all this flag has to do is
        # stop the work list from dropping the row before it gets there.
        already_dated = {
            row['video_id'] for row in connection.execute(
                "SELECT video_id FROM videos WHERE COALESCE(upload_date, '') <> ''"
            )
        }
        # The dates as they stand before the run, so the report can say how
        # many of them the refresh actually changed.
        dates_before = {
            row['video_id']: row['upload_date'] for row in connection.execute(
                "SELECT video_id, upload_date FROM videos"
            )
        }
    requested = len(wanted)
    if args.refresh:
        skipped = []
    else:
        skipped = [video_id for video_id, _ in wanted if video_id in already_dated]
        wanted = [(video_id, title) for video_id, title in wanted if video_id not in already_dated]

    jobs = max(1, args.jobs)
    batch_size = max(1, args.batch_size)
    batches = [wanted[i:i + batch_size] for i in range(0, len(wanted), batch_size)]
    print(
        f'Filling {len(wanted)} videos for {effective_channel} '
        f'in {len(batches)} batches of up to {batch_size}, {jobs} at a time '
        f'(client set: {args.extractor_args}); '
        + ('refreshing, so rows that already have a date are re-read.'
           if args.refresh else f'{len(skipped)} already have a date.'),
        file=sys.stderr,
    )

    rows: list[dict] = []
    missing: list[str] = []
    inserted = 0
    updated = 0
    attempted = 0

    with connect_database(db_path) as connection:
        initialize_schema(connection)
        set_setting(connection, 'channel', effective_channel)
        if source_url:
            set_setting(connection, 'source_url', source_url)

        with ThreadPoolExecutor(max_workers=jobs) as pool:
            futures = {pool.submit(fetch_dates_for, batch, args): batch for batch in batches}
            for future in as_completed(futures):
                batch = futures[future]
                try:
                    batch_rows, batch_missing = future.result()
                except Exception as error:  # noqa: BLE001 - one bad batch must not sink the run
                    batch_rows, batch_missing = [], [video_id for video_id, _ in batch]
                    print(f'  batch failed: {error}', file=sys.stderr)

                # Saved as each batch lands, so the work survives a stop.
                batch_inserted, batch_updated = upsert_catalog_rows(
                    connection, source_url, batch_rows, channel=effective_channel
                )
                inserted += batch_inserted
                updated += batch_updated
                rows.extend(batch_rows)
                missing.extend(batch_missing)
                attempted += len(batch)

                set_setting(connection, 'last_catalog_import_at', utc_now_iso())
                print(
                    f'  {attempted}/{len(wanted)} attempted, {len(rows)} dated, '
                    f'{len(missing)} still missing',
                    file=sys.stderr,
                )

    dated = sum(1 for row in rows if row['upload_date'])

    # How many dates the refresh actually changed. "Re-read 1,814 videos and
    # 0 dates changed" is a different claim from "re-read 1,814 videos", and
    # only the first one says the refresh was worth its requests.
    dates_changed = 0
    if args.refresh:
        for row in rows:
            fresh = row.get('upload_date') or ''
            if fresh and dates_before.get(row['video_id']) != fresh:
                dates_changed += 1

    # A video whose date could not be resolved is still a video, and its title
    # is known from the listing. Store it, so the fact that this video exists
    # does not depend on a scratch file that is not in version control.
    missing_entries = [
        (video_id, title)
        for video_id, title in wanted
        if video_id in set(missing)
    ]
    titles_written = 0
    if missing_entries:
        with connect_database(db_path) as connection:
            initialize_schema(connection)
            titles_written = persist_missing_titles(
                connection, missing_entries, source_url, effective_channel
            )

    # The run is recorded, like every other catalog run. Without this the
    # campaign that built the catalog left no trace of its command, its client
    # set, or which videos it could not resolve.
    #
    # The artifact is the listing when the run fetched one -- that is what the
    # run actually read -- and the work list otherwise.
    slug = utc_timestamp_slug()
    if listing_output:
        snapshot_path = paths['catalog'] / f'listing_{slug}.tsv'
        snapshot_path.write_text(listing_output, encoding='utf-8')
    else:
        snapshot_path = paths['catalog'] / f'fill_dates_{slug}.tsv'
        snapshot_path.write_text(
            ''.join(f'{video_id}\t{title}\n' for video_id, title in wanted),
            encoding='utf-8',
        )
    run_command = listing_command or ['fill-dates', '--input', args.input or '']
    if args.refresh and not listing_command:
        run_command = run_command + ['--refresh']
    with connect_database(db_path) as connection:
        initialize_schema(connection)
        record_catalog_run(
            connection,
            channel=effective_channel,
            command=run_command,
            inserted=inserted,
            malformed_rows=0,
            missing_upload_dates=len(missing),
            raw_output_path=snapshot_path,
            row_count=requested,
            row_count_kind='work_list_videos',
            source_url=source_url,
            updated=updated,
        )

    print(json.dumps({
        'channel': effective_channel,
        'dated': dated,
        'inserted': inserted,
        'jobs': jobs,
        'refresh': bool(args.refresh),
        'dates_changed': dates_changed,
        'requested': requested,
        'attempted': attempted,
        'skipped': len(skipped),
        'still_missing': missing,
        'still_missing_count': len(missing),
        'titles_only': len(rows) - dated,
        'titles_written': titles_written,
        'updated': updated,
    }, indent=2))
    return 0


def infer_channel_from_url(source_url: str) -> str:
    """Best-effort channel inference from a YouTube source URL. Returns '' if
    no rule matches so the caller can apply its own default."""
    if not source_url:
        return ''
    lowered = source_url.lower()
    if '@revereasset' in lowered or '/revereasset' in lowered:
        return 'revere'
    if '@qullamaggie' in lowered or '/qullamaggie' in lowered:
        return 'qullamaggie'
    return ''


# The logical channel name is NOT the YouTube handle, and the two do not
# round-trip. 'revere' is listed at @revereasset -- @revere is a DIFFERENT,
# unrelated channel, and the two return completely disjoint video IDs. So a
# channel URL is never built by interpolating the slug; it is looked up here,
# or taken from --source-url, or read back from the database.
CHANNEL_SOURCE_URLS = {
    'revere': 'https://www.youtube.com/@revereasset/videos',
    'qullamaggie': 'https://www.youtube.com/@Qullamaggie/videos',
}


def resolve_channel_source_url(connection: sqlite3.Connection, channel: str, explicit: str = '') -> str:
    """The channel URL a video's source_url should carry.

    An explicit --source-url wins. Otherwise the known handle for the channel
    is used, and only for a channel with no known handle is the URL read back
    from the rows the database already holds. The channel slug is never
    interpolated into a URL -- that produced a source_url pointing at an
    unrelated channel.
    """
    if explicit:
        return explicit
    known = CHANNEL_SOURCE_URLS.get(channel)
    if known:
        return known
    row = connection.execute(
        "SELECT source_url FROM videos WHERE channel = ? AND COALESCE(source_url, '') <> '' LIMIT 1",
        (channel,),
    ).fetchone()
    return row['source_url'] if row else ''


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
    catalog_parser.add_argument(
        '--channel',
        default='',
        help='Logical channel name written to the videos.channel + catalog_runs.channel columns '
             '(e.g. "revere", "qullamaggie"). Inferred from the source URL when omitted.',
    )
    catalog_parser.add_argument('--yt-dlp-bin', default='yt-dlp', help='Path to the yt-dlp executable.')
    catalog_parser.add_argument('--limit', type=int, default=0, help='Optional playlist limit for smoke tests.')
    catalog_parser.add_argument(
        '--playlist-items',
        default='',
        help='Optional yt-dlp --playlist-items selector to skip known-bad '
             'positions in a channel listing (e.g. "1-44,46-50" to skip row 45).',
    )
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
    catalog_parser.add_argument(
        '--extractor-args',
        default='youtube:player_client=ios,android,web_safari,web',
        help='yt-dlp extractor args passed to the catalog command. The default '
             'ios+android+web_safari+web client set is the most permissive '
             'metadata-fetcher for Revere-style channels; the catalog defaults '
             'match the download defaults.',
    )
    catalog_parser.add_argument(
        '--sleep-requests',
        type=float,
        default=0.0,
        help='Seconds to sleep between yt-dlp requests. A full Qullamaggie '
             'catalog is ~700 metadata requests back to back; spacing them out '
             'keeps the run off the rate limiter and off the DNS resolver, and '
             'leaves the request budget free for a download running on another '
             'machine at the same time.',
    )
    catalog_parser.set_defaults(handler=command_catalog)

    fill_dates_parser = subparsers.add_parser(
        'fill-dates',
        help='Resolve the upload_date of a list of videos that the catalog could not.',
    )
    fill_dates_parser.add_argument(
        '--input',
        default='',
        help='TSV of video_id<TAB>title — the videos whose metadata is still missing. '
             'Optional when the work list is derived from a listing instead.',
    )
    fill_dates_parser.add_argument(
        '--from-listing',
        default='',
        help='Derive the work list from a channel listing TSV (id<TAB>title) and the '
             'database: the videos the listing names that the database has no date for.',
    )
    fill_dates_parser.add_argument(
        '--build-listing',
        action='store_true',
        help='Fetch the channel listing with yt-dlp first, then fill. This needs '
             'nothing but the channel and the database, so the gap-fill runs on a '
             'fresh clone.',
    )
    fill_dates_parser.add_argument(
        '--listing-extractor-args',
        default='youtube:player_client=mweb',
        help='yt-dlp extractor args for the channel listing.',
    )
    fill_dates_parser.add_argument(
        '--channel',
        default='',
        help='Logical channel name written to videos.channel.',
    )
    fill_dates_parser.add_argument(
        '--source-url',
        default='',
        help='Source URL recorded on the rows. Defaults to the channel URL.',
    )
    fill_dates_parser.add_argument('--yt-dlp-bin', default='yt-dlp', help='Path to the yt-dlp executable.')
    fill_dates_parser.add_argument(
        '--jobs',
        type=int,
        default=4,
        help='How many yt-dlp batches to run in parallel. Each video is ~4 s of '
             'network wait and ~0.001 s of CPU, so this scales without costing CPU.',
    )
    fill_dates_parser.add_argument(
        '--batch-size',
        type=int,
        default=25,
        help='How many videos one yt-dlp invocation covers. Small batches save '
             'their rows as they finish, so a long run shows progress and can '
             'be interrupted without losing the work already done.',
    )
    fill_dates_parser.add_argument(
        '--refresh',
        action='store_true',
        help='Re-read the videos that already have a date, and overwrite the '
             'date with the freshly resolved one. Without this a row whose '
             'date was resolved wrongly keeps it forever: nothing ever reads '
             'a row that already has a date, so the error is permanent. The '
             'cost is one metadata request per video in the work list.',
    )
    fill_dates_parser.add_argument(
        '--extractor-args',
        default='youtube:player_client=mweb',
        help='yt-dlp extractor args for the per-video fetch. `mweb` alone is '
             'the fast path: 4.2 s per video against 123 s for the '
             'ios,android,web set, and 8.5 s for the two combined (measured '
             'on the same 8 videos -- yt-dlp queries EVERY client in the '
             'list, so extra clients cost time on every video, not only on '
             'the ones that fail). Run the command a second time with '
             '--extractor-args youtube:player_client=ios,android,web for the '
             'videos `mweb` could not resolve; videos that already have a '
             'date are skipped, so that pass only fetches the stragglers.',
    )
    fill_dates_parser.set_defaults(handler=command_fill_dates)

    import_local_parser = subparsers.add_parser('import-local', help='Register local sample videos for direct scanning.')
    import_local_parser.add_argument('--video-dir', required=True, help='Directory containing readable local video files.')
    import_local_parser.add_argument('--limit', type=int, default=0, help='Optional maximum number of local videos to register.')
    import_local_parser.add_argument(
        '--extensions',
        default='.mp4,.mov,.mkv,.m4v,.webm',
        help='Comma-separated local video extensions to include.',
    )
    import_local_parser.set_defaults(handler=command_import_local)

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
        default='youtube:player_client=android,web_safari,web',
        help='Optional yt-dlp extractor args passed through to the downloader. '
             'The default client set bypasses the "page needs to be reloaded" '
             'anti-bot check that the tv client hits on Revere videos.',
    )
    download_parser.add_argument(
        '--format',
        default='bv*[height<=720]+ba/b[height<=720]',
        help='yt-dlp format selector for video downloads. Default 720p; use --format "136" for QMG 720p or "bv*[height<=480]" for fast 360p test downloads.',
    )
    download_parser.set_defaults(handler=command_download)

    scan_parser = subparsers.add_parser('scan', help='Scan downloaded videos for the target whiteboard frame.')
    scan_parser.add_argument('--ffmpeg-bin', default='ffmpeg', help='Path to the ffmpeg executable.')
    scan_parser.add_argument('--reference-dir', default='', help='Directory containing reference stills for the target whiteboard.')
    scan_parser.add_argument('--limit', type=int, default=1, help='How many downloaded videos to scan in this run.')
    scan_parser.add_argument('--video-id', default='', help='Optional specific video ID to scan or rescan.')
    scan_parser.add_argument('--sample-fps', type=float, default=1.0, help='Sampling rate in frames per second for the coarse scan.')
    scan_parser.add_argument('--similarity-threshold', type=float, default=0.9, help='Minimum hash similarity for auto-save candidate windows.')
    scan_parser.add_argument('--review-threshold', type=float, default=0.82, help='Minimum score for keeping a review candidate when no autosave window is found.')
    scan_parser.add_argument('--min-window-length', type=int, default=3, help='Minimum consecutive matching samples required for an auto-save window.')
    scan_parser.add_argument('--score-margin', type=float, default=0.02, help='How close a sampled frame must be to the best score before sharpness ranking applies.')
    scan_parser.add_argument('--candidate-limit', type=int, default=5, help='Maximum number of high-score timestamps to sharpness-rank within the winning window.')
    scan_parser.add_argument(
        '--output-kind',
        choices=['whiteboard', 'snapshot'],
        default='whiteboard',
        help='Whether the extracted frame should feed whiteboard parsing or the existing screenshot extractor.',
    )
    scan_parser.set_defaults(handler=command_scan)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    raw_args = list(argv) if argv is not None else sys.argv[1:]
    reordered_args = []
    deferred_globals = []
    global_flags = {'--pipeline-root', '--db-path'}
    command_names = {'init', 'status', 'catalog', 'import-local', 'download', 'scan'}
    command_seen = False
    index = 0

    while index < len(raw_args):
        argument = raw_args[index]
        next_value = raw_args[index + 1] if index + 1 < len(raw_args) else None

        if argument in command_names:
            command_seen = True
            reordered_args.append(argument)
            index += 1
            continue

        if command_seen and argument in global_flags:
            deferred_globals.append(argument)
            if next_value is not None and not next_value.startswith('--'):
                deferred_globals.append(next_value)
                index += 2
                continue

        reordered_args.append(argument)
        index += 1

    args = parser.parse_args([*deferred_globals, *reordered_args])
    return args.handler(args)


if __name__ == '__main__':
    raise SystemExit(main())