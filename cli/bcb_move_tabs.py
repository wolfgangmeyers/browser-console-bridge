#!/usr/bin/env python3
"""Move one or more browser tabs to a new index via the BCB server.

Usage:
  bcb-move-tabs --index <int> <tab_id> [<tab_id> ...]
  bcb-move-tabs --index <int> --ids 1,2,3
  bcb-move-tabs --index 0 --window 42 --json <tab_id> ...

Exit codes: 0=all moved, 1=one or more failed, 2=communication error
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
    parser = argparse.ArgumentParser(prog="bcb-move-tabs", description="Move browser tabs by ID")
    parser.add_argument("tab_ids", nargs="*", help="Numeric tab IDs to move")
    parser.add_argument("--ids", help="Comma-separated list of tab IDs (alternative to positional)")
    parser.add_argument("--index", type=int, required=True,
                        help="Destination index (use -1 for end of window)")
    parser.add_argument("--window", type=int, default=None, dest="window_id",
                        help="Target window ID (default: keep current window)")
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
        result = client.move_tabs(ids, args.index, window_id=args.window_id)
    except (ConnectionError, TimeoutError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    if is_comm_error(result):
        print(result.get("error", "unknown error"), file=sys.stderr)
        return 2

    if args.as_json:
        print(json.dumps(result, indent=2))
        return 0 if result.get("success") else 1

    moved = result.get("moved", []) or []
    errors = result.get("errors", {}) or {}
    for tid in moved:
        print(f"moved {tid}")
    for tid, err in errors.items():
        print(f"failed {tid}: {err}", file=sys.stderr)

    if not result.get("success") and result.get("error"):
        # Envelope-level failure reason (e.g., bad index/window_id) — print
        # alongside any per-id errors since they describe different things.
        print(result["error"], file=sys.stderr)

    return 0 if result.get("success") else 1


if __name__ == "__main__":
    sys.exit(main())
