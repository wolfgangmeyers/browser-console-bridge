---
name: browser-console
description: Execute JavaScript in the active browser tab, read console output, list tabs, and capture screenshots via the Browser Console Bridge
---

# Browser Console Bridge

Execute JavaScript in the browser and read console output through a local bridge server. The bridge connects a Python HTTP server (running in tmux) with a Chrome extension that has access to the page context.

**Prefer BCB over Playwright** for any interactive browser testing. BCB works against the real logged-in browser session with no setup. If Chrome isn't open, launch it:

```bash
/opt/google/chrome/chrome --new-window "https://example.com" &
sleep 3 && curl -sf http://localhost:18080/health | python3 -m json.tool
```

## Prerequisites

The BCB Python server must be running in a tmux session, and the Chrome extension must be installed and active.

## Checking Server Status

```bash
python3 "$(dirname "$(realpath "$0")")/../cli/client.py" 2>/dev/null || \
  curl -s http://localhost:${BCB_HTTP_PORT:-18080}/health | python3 -m json.tool
```

Or use the health check directly:

```bash
curl -sf http://localhost:${BCB_HTTP_PORT:-18080}/health | python3 -m json.tool
```

Look for `"extension_connected": true` in the output. If the server is unreachable, it needs to be started first.

## Starting the Server (if not running)

```bash
bash ~/code/browser-console-bridge/bin/bcb-server-start
sleep 2
curl -sf http://localhost:18080/health | python3 -m json.tool
```

## Executing JavaScript

Run JavaScript in the active browser tab and get the return value:

```bash
# Simple expression
python3 -m cli.bcb_exec 'document.title'

# With a specific tab and timeout
python3 -m cli.bcb_exec --tab 123 --timeout 60 'document.querySelectorAll("a").length'

# Multi-line code from stdin
echo 'const items = document.querySelectorAll("li"); items.length;' | python3 -m cli.bcb_exec -
```

- Exit 0: success -- result JSON printed to stdout
- Exit 1: JavaScript error -- error message on stderr
- Exit 2: communication error (server down, extension disconnected, timeout) -- message on stderr

## Reading Console Output

```bash
# All recent console output
python3 -m cli.bcb_console

# Only errors from the last 60 seconds
python3 -m cli.bcb_console --levels error --since 60

# As raw JSON
python3 -m cli.bcb_console --json --limit 50
```

## Listing Open Tabs

```bash
# Human-readable table
python3 -m cli.bcb_tabs

# As JSON
python3 -m cli.bcb_tabs --json
```

## Targeting a Specific Tab

All commands accept `--tab TAB_ID` to target a tab other than the active one. Get tab IDs from `bcb_tabs`.

```bash
# Execute JS in a specific tab
python3 -m cli.bcb_exec --tab 1729111934 'window.location.href'

# Screenshot a specific tab
python3 -m cli.bcb_screenshot --tab 1729111934 --output /tmp/tab1.png
```

## Opening New Tabs (for parallel agent testing)

When multiple agents need to work in parallel, open a dedicated tab for each so they don't interfere with each other's navigation:

```bash
# Open N new tabs from the currently active tab (replace URL as needed)
python3 -m cli.bcb_exec 'Array.from({length: 2}, () => window.open("https://example.com", "_blank") && "opened")'

# Wait for tabs to load, then list them to get their IDs
sleep 2
python3 -m cli.bcb_tabs

# Each agent then uses its assigned tab ID for all commands
python3 -m cli.bcb_exec --tab <TAB_ID_1> '...'
python3 -m cli.bcb_screenshot --tab <TAB_ID_2> --output /tmp/agent2.png
```

## Taking Screenshots

```bash
# Save to default location, prints file path to stdout
python3 -m cli.bcb_screenshot

# Save to a specific path
python3 -m cli.bcb_screenshot --output ./page.png

# JPEG format
python3 -m cli.bcb_screenshot --format jpeg

# Clean up old screenshots
python3 -m cli.bcb_screenshot --cleanup 1h
```

## Error Handling

| Situation | What to do |
|-----------|------------|
| Server not running (connection refused) | Start it via tmux as shown above, wait 1s, retry |
| Extension not connected (`NO_EXTENSION`) | Ask the user to open Chrome and enable the BCB extension |
| Timeout (`TIMEOUT`) | The page may be unresponsive; try a shorter operation or increase `--timeout` |
| JS error (exit code 1) | Read the error message on stderr; fix the JavaScript and retry |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BCB_HOST` | `localhost` | Server hostname |
| `BCB_HTTP_PORT` | `18080` | Server HTTP port |
| `BCB_SCREENSHOT_DIR` | `/tmp/bcb-screenshots` | Screenshot save directory |
| `BCB_SCREENSHOT_MAX_AGE` | `24h` | Screenshot auto-cleanup threshold |
