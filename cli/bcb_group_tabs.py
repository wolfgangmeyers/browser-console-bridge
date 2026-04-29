#!/usr/bin/env python3
"""Group one or more browser tabs via the BCB server.

Usage:
  bcb-group-tabs <tab_id> [<tab_id> ...]
  bcb-group-tabs --ids 1,2,3
  bcb-group-tabs --group 99 <tab_id> ...     # add tabs to existing group
  bcb-group-tabs --window 42 --ids 1,2,3     # create group in specific window

Exit codes: 0=success, 1=failure, 2=communication error
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
    parser = argparse.ArgumentParser(prog="bcb-group-tabs", description="Group browser tabs by ID")
    parser.add_argument("tab_ids", nargs="*", help="Numeric tab IDs to group")
    parser.add_argument("--ids", help="Comma-separated list of tab IDs (alternative to positional)")
    parser.add_argument("--group", type=int, default=None, dest="group_id",
                        help="Existing group ID to add the tabs to (default: create new group)")
    parser.add_argument("--window", type=int, default=None, dest="window_id",
                        help="Window ID for the new group (only when creating a new group)")
    parser.add_argument("--json", action="store_true", dest="as_json", help="Output raw JSON")
    args = parser.parse_args(argv)

    try:
        ids = _parse_ids(args)
    except ValueError as exc:
        parser.error(str(exc))
    if not ids:
        parser.error("at least one tab ID is required")
    if args.group_id is not None and args.window_id is not None:
        parser.error("--window cannot be combined with --group")

    try:
        client = BcbClient()
        result = client.group_tabs(ids, group_id=args.group_id,
                                   create_window_id=args.window_id)
    except (ConnectionError, TimeoutError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    if is_comm_error(result):
        print(result.get("error", "unknown error"), file=sys.stderr)
        return 2

    if args.as_json:
        print(json.dumps(result, indent=2))
        return 0 if result.get("success") else 1

    grouped = result.get("grouped", []) or []
    errors = result.get("errors", {}) or {}
    gid = result.get("group_id")
    if gid is not None:
        print(f"group_id {gid}")
    for tid in grouped:
        print(f"grouped {tid}")
    for tid, err in errors.items():
        print(f"failed {tid}: {err}", file=sys.stderr)

    if not result.get("success") and result.get("error"):
        print(result["error"], file=sys.stderr)

    return 0 if result.get("success") else 1


if __name__ == "__main__":
    sys.exit(main())
