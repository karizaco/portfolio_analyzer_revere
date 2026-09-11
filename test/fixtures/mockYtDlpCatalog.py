from __future__ import annotations

import sys


def main() -> int:
    if '--version' in sys.argv:
        print('2026.09.01')
        return 0

    print('abc123\t20260102\tPortfolio Update 1')
    print('def456\t20260103\tPortfolio Update 2')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())