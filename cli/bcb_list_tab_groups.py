#!/usr/bin/env python3
"""List browser tab groups via the BCB server.

Usage:
  bcb-list-tab-groups [--window <id>] [--json]

Exit codes: 0=success, 1=error, 2=communication error
"""

import argparse
import json
import sys

from .client import BcbClient, is_comm_error


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bcb-list-tab-groups",
                                     description="List browser tab groups")
    parser.add_argument("--window", type=int, default=None, dest="window_id",
                        help="Filter by window ID")
    parser.add_argument("--json", action="store_true", dest="as_json", help="Output raw JSON")
    args = parser.parse_args(argv)

    try:
        client = BcbClient()
        result = client.list_tab_groups(window_id=args.window_id)
    except (ConnectionError, TimeoutError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    if not result.get("success"):
        print(result.get("error", "unknown error"), file=sys.stderr)
        if is_comm_error(result):
            return 2
        return 1

    groups = result.get("groups", []) or []
    if args.as_json:
        print(json.dumps(groups, indent=2))
    else:
        for g in groups:
            gid = g.get("id", "?")
            color = g.get("color", "")
            collapsed = "collapsed" if g.get("collapsed") else "expanded"
            wid = g.get("window_id", "?")
            title = g.get("title", "")
            print(f"  {gid:<6} {color:<8} {collapsed:<10} win={wid:<6} {title}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
