#!/usr/bin/env python3
"""List open browser tabs via the BCB server.

Usage: bcb-tabs [--json]

Exit codes: 0=success, 1=error, 2=communication error
"""

import argparse
import json
import sys

from .client import BcbClient


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bcb-tabs", description="List open browser tabs")
    parser.add_argument("--json", action="store_true", dest="as_json", help="Output raw JSON")
    args = parser.parse_args(argv)

    try:
        client = BcbClient()
        result = client.list_tabs()
    except (ConnectionError, TimeoutError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    if not result.get("success"):
        print(result.get("error", "unknown error"), file=sys.stderr)
        if result.get("code") in ("NO_EXTENSION", "TIMEOUT", "INVALID_MESSAGE", "SERVER_ERROR"):
            return 2
        return 1

    tabs = result.get("tabs", [])
    if args.as_json:
        print(json.dumps(tabs, indent=2))
    else:
        for tab in tabs:
            active = "*" if tab.get("active") else " "
            tid = tab.get("id", "?")
            url = tab.get("url", "")
            title = tab.get("title", "")
            print(f"  {tid:<6} {active} {url:<40s} {title}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
