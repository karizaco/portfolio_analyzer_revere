"""Entry point for ``py -3 -m tools.discord_pipeline``.

Default (no args) runs the schema self-test on a temp SQLite — the
quickest smoke check that the package is wired up. Pass ``--list-sources``
to print the currently registered sources (zero rows is fine on a fresh
checkout, exits 0 even without ``DISCORD_BOT_TOKEN``).
"""

from __future__ import annotations

import sys
from pathlib import Path

from tools.discord_pipeline.ingest_channel import (
    DEFAULT_DB_PATH,
    list_sources,
)


def main(argv: list[str] | None = None) -> int:
    raw = list(argv) if argv is not None else sys.argv[1:]
    if "--list-sources" in raw:
        from tools.discord_pipeline.ingest_channel import parse_args
        args = parse_args(raw)
        return list_sources(Path(args.db_path or DEFAULT_DB_PATH))
    from tools.discord_pipeline import self_test
    return self_test()


if __name__ == "__main__":
    raise SystemExit(main())
