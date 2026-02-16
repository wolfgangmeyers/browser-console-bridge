#!/usr/bin/env python3
"""Read console output from the browser via the BCB server.

Usage: bcb-console [--levels LEVELS] [--since SINCE] [--limit N] [--tab TAB_ID] [--json]

Exit codes: 0=success, 1=error, 2=communication error
"""

import argparse
import json
import sys
import time
from datetime import datetime

from .client import BcbClient


def _format_entry(entry: dict) -> str:
    """Format a single console entry for human-readable output."""
    level = entry.get("level", "log").upper()
    ts = entry.get("ts", 0)
    content = entry.get("content", "")
    source = entry.get("source", "")
    time_str = datetime.fromtimestamp(ts).strftime("%H:%M:%S") if ts else "??:??:??"
    lines = [f"[{level:<5s}] {time_str}  {content}"]
    if source:
        lines.append(f"        {'':8s}  ({source})")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="bcb-console", description="Read browser console output"
    )
    parser.add_argument("--levels", default=None, help="Comma-separated levels (e.g. error,warn)")
    parser.add_argument("--since", type=float, default=None, help="Seconds ago (e.g. 60 = last minute)")
    parser.add_argument("--limit", type=int, default=100, help="Max entries (default: 100)")
    parser.add_argument("--tab", type=int, default=None, dest="tab_id", help="Target tab ID")
    parser.add_argument("--json", action="store_true", dest="as_json", help="Output raw JSON")
    args = parser.parse_args(argv)

    levels = [l.strip() for l in args.levels.split(",")] if args.levels else None
    since = time.time() - args.since if args.since is not None else None

    try:
        client = BcbClient()
        result = client.read_console(
            tab_id=args.tab_id, since=since, levels=levels,
            limit=args.limit,
        )
    except (ConnectionError, TimeoutError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    if not result.get("success"):
        print(result.get("error", "unknown error"), file=sys.stderr)
        if result.get("code") in ("NO_EXTENSION", "TIMEOUT", "INVALID_MESSAGE", "SERVER_ERROR"):
            return 2
        return 1

    entries = result.get("entries", [])
    if args.as_json:
        print(json.dumps(entries, indent=2))
    else:
        for entry in entries:
            print(_format_entry(entry))
    return 0


if __name__ == "__main__":
    sys.exit(main())
