#!/usr/bin/env python3
"""Close one or more browser tabs by ID via the BCB server.

Usage:
  bcb-close-tabs <tab_id> [<tab_id> ...]
  bcb-close-tabs --ids 1,2,3
  bcb-close-tabs --json <tab_id> ...

Exit codes: 0=all closed, 1=one or more failed, 2=communication error
"""

import argparse
import json
import sys

from .client import BcbClient, is_comm_error


def _parse_ids(args: argparse.Namespace) -> list[int]:
    raw: list[str] = list(args.tab_ids)
    if args.ids:
        raw.extend(s for s in args.ids.split(",") if s.strip())
    ids: list[int] = []
    for token in raw:
        try:
            ids.append(int(token))
        except ValueError as exc:
            raise ValueError(f"invalid tab id: {token!r}") from exc
    return ids


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bcb-close-tabs", description="Close browser tabs by ID")
    parser.add_argument("tab_ids", nargs="*", help="Numeric tab IDs to close")
    parser.add_argument("--ids", help="Comma-separated list of tab IDs (alternative to positional)")
    parser.add_argument("--json", action="store_true", dest="as_json", help="Output raw JSON")
    args = parser.parse_args(argv)

    try:
        ids = _parse_ids(args)
    except ValueError as exc:
        parser.error(str(exc))
    if not ids:
        parser.error("at least one tab ID is required")

    try:
        client = BcbClient()
        result = client.close_tabs(ids)
    except (ConnectionError, TimeoutError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    if is_comm_error(result):
        print(result.get("error", "unknown error"), file=sys.stderr)
        return 2

    if args.as_json:
        print(json.dumps(result, indent=2))
        return 0 if result.get("success") else 1

    closed = result.get("closed", []) or []
    errors = result.get("errors", {}) or {}
    for tid in closed:
        print(f"closed {tid}")
    for tid, err in errors.items():
        print(f"failed {tid}: {err}", file=sys.stderr)

    return 0 if result.get("success") else 1


if __name__ == "__main__":
    sys.exit(main())
