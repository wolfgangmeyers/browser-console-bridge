#!/usr/bin/env python3
"""Capture a browser screenshot via the BCB server.

Usage: bcb-screenshot [--output PATH] [--format png|jpeg] [--tab TAB_ID] [--timeout N]
       bcb-screenshot --cleanup DURATION

Exit codes: 0=success, 1=capture error, 2=communication error
"""
import argparse, base64, os, re, sys, time
from .client import BcbClient

SCREENSHOT_DIR = os.environ.get("BCB_SCREENSHOT_DIR", "/tmp/bcb-screenshots")
_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def _parse_duration(s: str) -> float:
    m = re.fullmatch(r"(\d+)\s*([smhd])", s.strip().lower())
    if not m:
        raise ValueError(f"Invalid duration: {s!r} (use e.g. 30m, 1h, 7d)")
    return int(m.group(1)) * _UNITS[m.group(2)]


def _cleanup(duration_str: str) -> int:
    max_age, now, count = _parse_duration(duration_str), time.time(), 0
    if not os.path.isdir(SCREENSHOT_DIR):
        return 0
    for name in os.listdir(SCREENSHOT_DIR):
        path = os.path.join(SCREENSHOT_DIR, name)
        if os.path.isfile(path) and now - os.path.getmtime(path) > max_age:
            os.remove(path)
            count += 1
    print(f"Removed {count} file(s) from {SCREENSHOT_DIR}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="bcb-screenshot", description="Capture browser screenshot")
    p.add_argument("--output", default=None, help="Output file path")
    p.add_argument("--format", default="png", choices=["png", "jpeg"], dest="fmt")
    p.add_argument("--tab", type=int, default=None, dest="tab_id")
    p.add_argument("--timeout", type=float, default=10)
    p.add_argument("--cleanup", default=None, metavar="DURATION", help="Delete old screenshots (e.g. 1h, 7d)")
    args = p.parse_args(argv)
    if args.cleanup:
        return _cleanup(args.cleanup)
    try:
        result = BcbClient().screenshot(tab_id=args.tab_id, fmt=args.fmt, timeout=args.timeout)
    except (ConnectionError, TimeoutError) as exc:
        print(str(exc), file=sys.stderr); return 2
    if not result.get("success"):
        print(result.get("error", "unknown error"), file=sys.stderr)
        return 2 if result.get("code") in ("NO_EXTENSION", "TIMEOUT", "INVALID_MESSAGE", "SERVER_ERROR") else 1
    image_data = base64.b64decode(result["image_data"])
    out_path = args.output or os.path.join(SCREENSHOT_DIR, f"{result.get('msg_id', 'screenshot')}.{args.fmt}")
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(image_data)
    print(out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
