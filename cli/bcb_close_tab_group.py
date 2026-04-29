#!/usr/bin/env python3
"""Close every tab in a browser tab group via the BCB server.

Composite operation: the extension queries tabs in the group and removes
them in a single round-trip. The CLI sees one envelope.

Usage:
  bcb-close-tab-group <group_id> [--json]

Exit codes: 0=all closed, 1=one or more failed, 2=communication error
"""

import argparse
import json
import sys

from .client import BcbClient, is_comm_error


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bcb-close-tab-group",
                                     description="Close every tab in a tab group")
    parser.add_argument("group_id", type=int, help="Numeric tab group ID")
    parser.add_argument("--json", action="store_true", dest="as_json", help="Output raw JSON")
    args = parser.parse_args(argv)

    try:
        client = BcbClient()
        result = client.close_tab_group(args.group_id)
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

    if not result.get("success") and result.get("error"):
        # Envelope-level failure (e.g., missing group) — print alongside any
        # per-id errors since they describe different things.
        print(result["error"], file=sys.stderr)

    return 0 if result.get("success") else 1


if __name__ == "__main__":
    sys.exit(main())
