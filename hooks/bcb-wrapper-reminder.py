#!/usr/bin/env python3
"""
PostToolUse hook: BCB wrapper reminder.

Fires after a Bash tool call that contains bcb_exec, bcb_screenshot, or bcb_tabs.
Checks the last 10 tool_use calls in the transcript to determine if the worker
is in an active bcb flow. If no recent bcb usage is found, prints a reminder to
check for app-specific helper scripts before writing raw bcb calls.

Exit codes:
  0 - always (hook never blocks)
"""

import json
import os
import sys

BCB_COMMANDS = ("bcb_exec", "bcb_screenshot", "bcb_tabs")

# How many recent tool_use blocks to scan when deciding if worker is in an active flow.
# If any of the last N calls used bcb directly, the reminder is suppressed.
RECENT_CALLS_WINDOW = 10

REMINDER = """\
💡 [BCB Tip] You are using bcb_exec directly. Before writing raw JS calls:
  - Check for app-specific helpers first: cat ~/code/browser-console-bridge/glue/catalog.md
  - If a helper exists for what you need, use it instead of raw bcb_exec
  - If no helper exists and this pattern will recur, add it to the glue/ helpers library
  - The library grows in value as you contribute patterns you discover
  New to the helpers? Read ~/glue-browser-helpers-design.md for the design rationale."""


def command_uses_bcb(command) -> bool:
    if not isinstance(command, str):
        return False
    return any(cmd in command for cmd in BCB_COMMANDS)


def count_recent_bcb_calls(transcript_path: str) -> int:
    """Return count of bcb-using tool_use calls among the last RECENT_CALLS_WINDOW tool_use blocks."""
    if not transcript_path or not os.path.isfile(transcript_path):
        return 0

    tool_uses = []
    try:
        with open(transcript_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("type") != "assistant":
                    continue
                content = entry.get("message", {}).get("content", [])
                if not isinstance(content, list):
                    continue
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") != "tool_use":
                        continue
                    tool_input = block.get("input", {})
                    command = tool_input.get("command", "")
                    tool_uses.append(command)
    except OSError as e:
        print(f"bcb-wrapper-reminder: could not read transcript: {e}", file=sys.stderr)
        return 0

    last_n = tool_uses[-RECENT_CALLS_WINDOW:]
    return sum(1 for cmd in last_n if command_uses_bcb(cmd))


def main():
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError) as e:
        print(f"bcb-wrapper-reminder: could not parse hook input: {e}", file=sys.stderr)
        sys.exit(0)

    command = hook_input.get("tool_input", {}).get("command", "")
    transcript_path = hook_input.get("transcript_path", "")

    # Only act on commands that use bcb
    if not command_uses_bcb(command):
        sys.exit(0)

    # If any of the last 10 tool_use calls used bcb, worker is in an active flow
    recent_bcb_count = count_recent_bcb_calls(transcript_path)
    if recent_bcb_count > 0:
        sys.exit(0)

    # First bcb call in recent history — inject the reminder
    output = {
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": REMINDER,
        }
    }
    print(json.dumps(output))
    sys.exit(0)


if __name__ == "__main__":
    main()
