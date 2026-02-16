#!/usr/bin/env python3
"""Execute JavaScript in the browser via the BCB server.

Usage: bcb-exec <javascript_code> [--timeout N] [--tab TAB_ID]
       echo 'code' | bcb-exec -

Exit codes: 0=success, 1=JS error, 2=communication error
"""

import argparse
import json
import sys

from .client import BcbClient


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="bcb-exec", description="Execute JavaScript in the browser"
    )
    parser.add_argument("code", help="JavaScript code to execute (use '-' to read from stdin)")
    parser.add_argument("--timeout", type=float, default=30, help="Timeout in seconds (default: 30)")
    parser.add_argument("--tab", type=int, default=None, dest="tab_id", help="Target tab ID")
    args = parser.parse_args(argv)

    code = sys.stdin.read() if args.code == "-" else args.code

    try:
        client = BcbClient()
        result = client.execute_js(code, tab_id=args.tab_id, timeout=args.timeout)
    except (ConnectionError, TimeoutError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    if result.get("success"):
        print(json.dumps(result.get("result")))
        return 0

    print(result.get("error", "unknown error"), file=sys.stderr)
    # Communication-level errors from the server (NO_EXTENSION, TIMEOUT, etc.)
    if result.get("code") in ("NO_EXTENSION", "TIMEOUT", "INVALID_MESSAGE", "SERVER_ERROR"):
        return 2
    return 1


if __name__ == "__main__":
    sys.exit(main())
