from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
import shutil

WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PIPELINE_ROOT = WORKSPACE_ROOT / 'data' / 'video_pipeline'
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
    _apply_migrations(connection)


def _apply_migrations(connection: sqlite3.Connection) -> None:
    """Idempotent ALTER TABLE migrations applied after `initialize_schema`.

    Each entry checks whether the column exists before adding it; the backfill
    UPDATE statements are safe to run on every startup because the WHERE clause
    targets only rows that still have the empty-string sentinel value.
    """
    existing = {
        row['name']
        for row in connection.execute('PRAGMA table_info(videos)')
    }
    if 'channel' not in existing:
        connection.execute("ALTER TABLE videos ADD COLUMN channel TEXT NOT NULL DEFAULT ''")
    if 'transcript_path' not in existing:
        connection.execute("ALTER TABLE videos ADD COLUMN transcript_path TEXT NOT NULL DEFAULT ''")
    if 'transcript_segment_count' not in existing:
        connection.execute("ALTER TABLE videos ADD COLUMN transcript_segment_count INTEGER NOT NULL DEFAULT 0")
    if 'transcript_fetched_at' not in existing:
        connection.execute("ALTER TABLE videos ADD COLUMN transcript_fetched_at TEXT NOT NULL DEFAULT ''")

    # Backfill `channel` from `source_url` so legacy Revere rows survive.
    connection.execute(
        "UPDATE videos SET channel = 'revere' WHERE channel = '' AND source_url LIKE '%@revereasset%'"
    )
    connection.execute(
        "UPDATE videos SET channel = 'qullamaggie' WHERE channel = '' AND source_url LIKE '%@Qullamaggie%'"
    )
    connection.execute(
        "UPDATE videos SET channel = 'revere' WHERE channel = ''"
    )
    connection.commit()

    catalog_run_columns = {
        row['name']
        for row in connection.execute('PRAGMA table_info(catalog_runs)')
    }
    if 'channel' not in catalog_run_columns:
        connection.execute("ALTER TABLE catalog_runs ADD COLUMN channel TEXT NOT NULL DEFAULT ''")
        connection.execute(
            "UPDATE catalog_runs SET channel = 'revere' WHERE channel = '' AND source_url LIKE '%@revereasset%'"
        )
        connection.execute(
            "UPDATE catalog_runs SET channel = 'qullamaggie' WHERE channel = '' AND source_url LIKE '%@Qullamaggie%'"
        )
        connection.execute(
            "UPDATE catalog_runs SET channel = 'revere' WHERE channel = ''"
        )
        connection.commit()

    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_videos_channel ON videos(channel)"
    )


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
            created_at
        FROM catalog_runs
        ORDER BY run_id DESC
        LIMIT 1
        '''
    ).fetchone()
    return dict(row) if row else None


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
        set_setting(connection, 'last_local_video_dir', str(video_directory))
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

    if args.cookies_from_browser:
        command.extend(['--cookies-from-browser', args.cookies_from_browser])

    if args.cookies_file:
        command.extend(['--cookies', args.cookies_file])

    if args.extractor_args:
        command.extend(['--extractor-args', args.extractor_args])

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


def build_command_prefix(command_bin: str) -> list[str]:
    command_target = Path(command_bin)
    if command_target.suffix.lower() == '.py':
        return [sys.executable, str(command_target)]

    return [command_bin]


def record_catalog_run(
    connection: sqlite3.Connection,
    *,
    channel: str = '',
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
            channel,
            command_json,
            raw_output_path,
            row_count,
            inserted_count,
            updated_count,
            missing_upload_dates,
            malformed_rows,
            created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''',
        (
            source_url,
            channel,
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
    output_path: str | None = None,
    review_reason: str | None = None,
    selected_score: float | None = None,
    selected_timestamp: float | None = None,
) -> None:
    assignments = ['status = ?', 'updated_at = ?']
    values: list[object] = [status, utc_now_iso()]

    if download_path is not None:
        assignments.append('download_path = ?')
        values.append(download_path)

    if error is not None:
        assignments.append('error = ?')
        values.append(error)

    if output_path is not None:
        assignments.append('output_path = ?')
        values.append(output_path)

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
                str(video_path),
                timestamp,
                timestamp,
            ),
        )

        imported_rows.append({
            'download_path': str(video_path),
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
            download_path = Path(row['download_path'])
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
                source_url = excluded.source_url,
                video_url = excluded.video_url,
                title = excluded.title,
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
        set_setting(connection, 'channel', effective_channel)
        set_setting(connection, 'last_catalog_output_path', str(snapshot_path))
        set_setting(connection, 'last_catalog_import_at', utc_now_iso())
        inserted, updated = upsert_catalog_rows(connection, args.source_url, rows, channel=effective_channel)
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
            channel=effective_channel,
        )

    print(json.dumps({
        'cataloged_rows': len(rows),
        'channel': effective_channel,
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
    catalog_parser.set_defaults(handler=command_catalog)

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
        default='bv*[height<=480]+ba/b[height<=480]',
        help='yt-dlp format selector for low-resolution resumable downloads.',
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