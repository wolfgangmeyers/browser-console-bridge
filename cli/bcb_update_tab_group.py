#!/usr/bin/env python3
"""Update a browser tab group's title, color, or collapsed state.

Usage:
  bcb-update-tab-group <group_id> [--title TEXT] [--color COLOR]
                                  [--collapsed | --expanded]

Exit codes: 0=success, 1=failure, 2=communication error
"""

import argparse
import json
import sys

from .client import BcbClient, is_comm_error

VALID_COLORS = ("grey", "blue", "red", "yellow", "green",
                "pink", "purple", "cyan", "orange")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bcb-update-tab-group",
                                     description="Update a browser tab group")
    parser.add_argument("group_id", type=int, help="Numeric tab group ID")
    parser.add_argument("--title", default=None, help="New group title")
    parser.add_argument("--color", default=None, choices=VALID_COLORS,
                        help="New group color")
    collapse = parser.add_mutually_exclusive_group()
    collapse.add_argument("--collapsed", dest="collapsed", action="store_const", const=True,
                          help="Collapse the group")
    collapse.add_argument("--expanded", dest="collapsed", action="store_const", const=False,
                          help="Expand the group")
    parser.set_defaults(collapsed=None)
    parser.add_argument("--json", action="store_true", dest="as_json", help="Output raw JSON")
    args = parser.parse_args(argv)

    if args.title is None and args.color is None and args.collapsed is None:
        parser.error("at least one of --title, --color, --collapsed/--expanded is required")

    try:
        client = BcbClient()
        result = client.update_tab_group(args.group_id, title=args.title,
                                         color=args.color, collapsed=args.collapsed)
    except (ConnectionError, TimeoutError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    if is_comm_error(result):
        print(result.get("error", "unknown error"), file=sys.stderr)
        return 2

    if args.as_json:
        print(json.dumps(result, indent=2))
        return 0 if result.get("success") else 1

    if not result.get("success"):
        print(result.get("error", "unknown error"), file=sys.stderr)
        return 1

    g = result.get("group", {}) or {}
    print(f"updated {g.get('id', args.group_id)}: "
          f"title={g.get('title', '')!r} color={g.get('color', '')} "
          f"collapsed={g.get('collapsed')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
