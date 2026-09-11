from __future__ import annotations

import re
import sys
from pathlib import Path


def parse_option(argv: list[str], flag: str) -> str:
    if flag not in argv:
        return ''

    index = argv.index(flag)
    if index + 1 >= len(argv):
        return ''

    return argv[index + 1]


def parse_scale(argv: list[str]) -> tuple[int, int]:
    filter_value = parse_option(argv, '-vf')
    match = re.search(r'scale=(\d+):(\d+)', filter_value)
    if not match:
        return 8, 8

    return int(match.group(1)), int(match.group(2))


def build_board_frame(width: int, height: int, sharp: bool) -> bytes:
    pixels = []
    for row_index in range(height):
        for column_index in range(width):
            if row_index < max(1, height // 5):
                value = 245
            elif sharp:
                value = 35 if (row_index + column_index) % 2 == 0 else 225
            else:
                value = 120 if (row_index + column_index) % 3 == 0 else 200
            pixels.append(value)

    return bytes(pixels)


def build_nonmatch_frame(width: int, height: int, seed: int) -> bytes:
    pixels = []
    for row_index in range(height):
        for column_index in range(width):
            pixels.append((seed * 17 + row_index * 7 + column_index * 11) % 120)
    return bytes(pixels)


def emit_reference_or_single_frame(argv: list[str]) -> int:
    width, height = parse_scale(argv)
    timestamp_text = parse_option(argv, '-ss')
    timestamp = float(timestamp_text) if timestamp_text else 0.0
    output_target = argv[-1]

    if output_target == '-':
        sharp = timestamp >= 7.0 or parse_option(argv, '-i').endswith('.pgm')
        sys.stdout.buffer.write(build_board_frame(width, height, sharp=sharp))
        return 0

    output_path = Path(output_target)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(f'mock frame at {timestamp:.3f}\n', encoding='utf-8')
    return 0


def emit_sample_stream(argv: list[str]) -> int:
    width, height = parse_scale(argv)
    for index in range(12):
        if 4 <= index <= 8:
            sys.stdout.buffer.write(build_board_frame(width, height, sharp=True))
        else:
            sys.stdout.buffer.write(build_nonmatch_frame(width, height, index))
    return 0


def main(argv: list[str]) -> int:
    if '-vf' in argv and 'fps=' in parse_option(argv, '-vf') and argv[-1] == '-':
        return emit_sample_stream(argv)

    return emit_reference_or_single_frame(argv)


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))