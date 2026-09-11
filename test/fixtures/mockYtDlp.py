from __future__ import annotations

import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse


VIDEO_ROWS = {
    'abc123': ('20260102', 'Portfolio Update 1'),
    'def456': ('20260103', 'Portfolio Update 2'),
}


def parse_option(argv: list[str], flag: str) -> str:
    if flag not in argv:
        return ''

    index = argv.index(flag)
    if index + 1 >= len(argv):
        return ''

    return argv[index + 1]


def parse_video_id(url: str) -> str:
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    return query.get('v', [''])[0]


def substitute_output_template(template: str, video_id: str, upload_date: str, extension: str) -> Path:
    resolved = template.replace('%(upload_date)s', upload_date)
    resolved = resolved.replace('%(id)s', video_id)
    resolved = resolved.replace('%(ext)s', extension)
    return Path(resolved)


def run_catalog() -> int:
    for video_id, (upload_date, title) in VIDEO_ROWS.items():
        print(f'{video_id}\t{upload_date}\t{title}')
    return 0


def run_download(argv: list[str]) -> int:
    output_template = parse_option(argv, '-o')
    archive_path = parse_option(argv, '--download-archive')
    video_url = argv[-1]
    video_id = parse_video_id(video_url)
    upload_date, _title = VIDEO_ROWS.get(video_id, ('20260101', 'Unknown'))

    output_path = substitute_output_template(output_template, video_id, upload_date, 'mp4')
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(f'mock video for {video_id}\n', encoding='utf-8')

    if archive_path:
        archive_file = Path(archive_path)
        archive_file.parent.mkdir(parents=True, exist_ok=True)
        with archive_file.open('a', encoding='utf-8') as handle:
            handle.write(f'youtube {video_id}\n')

    print(f'[download] {video_id} -> {output_path}')
    return 0


def main(argv: list[str]) -> int:
    if '--version' in argv:
        print('2026.09.01')
        return 0

    if '--flat-playlist' in argv:
        return run_catalog()

    return run_download(argv)


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))