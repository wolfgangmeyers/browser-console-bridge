#!/usr/bin/env python3
"""Execute JavaScript in the browser via the BCB server.

Usage: bcb-exec <javascript_code> [--timeout N] [--tab TAB_ID] [--world WORLD]
       echo 'code' | bcb-exec -

Exit codes: 0=success, 1=JS error, 2=communication error
"""

import argparse
import json
import sys

from .client import BcbClient, is_comm_error


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="bcb-exec", description="Execute JavaScript in the browser"
    )
    parser.add_argument("code", help="JavaScript code to execute (use '-' to read from stdin)")
    parser.add_argument("--timeout", type=float, default=30, help="Timeout in seconds (default: 30)")
    parser.add_argument("--tab", type=int, default=None, dest="tab_id", help="Target tab ID")
    parser.add_argument(
        "--world",
        choices=("auto", "cdp", "user", "isolated", "main"),
        default="auto",
        help="JS world: auto (CDP, then user, then isolated, then MAIN), cdp, user, isolated, or main",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="as_json",
        help="Print the full execute_js_result (includes world) instead of just the value",
    )
    args = parser.parse_args(argv)

    code = sys.stdin.read() if args.code == "-" else args.code

    try:
        client = BcbClient()
        result = client.execute_js(
            code, tab_id=args.tab_id, timeout=args.timeout, world=args.world,
        )
    except (ConnectionError, TimeoutError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    if result.get("success"):
        if args.as_json:
            print(json.dumps(result))
        else:
            print(json.dumps(result.get("result")))
        return 0

    print(result.get("error", "unknown error"), file=sys.stderr)
    if is_comm_error(result):
        return 2
    return 1


if __name__ == "__main__":
    sys.exit(main())
