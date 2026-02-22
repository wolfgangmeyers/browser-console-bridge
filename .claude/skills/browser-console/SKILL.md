---
name: browser-console
description: Interact with the browser for UI testing, debugging, and automation. Use this skill when asked to test a UI, interact with a web page, click buttons, fill forms, read the DOM, check console errors, take screenshots, or execute JavaScript in the browser. Requires the Browser Console Bridge server and Chrome extension.
---

# Browser Console Bridge

Execute JavaScript in the browser and read console output through a local bridge server. The bridge connects a Python HTTP/WebSocket server (running in tmux) with a Chrome extension that has access to page context.

**Project location:** `~/code/browser-console-bridge`
**Python venv:** `~/code/browser-console-bridge/.venv`
**Server ports:** HTTP `18080`, WebSocket `18081`

## Step 1: Ensure the Server is Running

```bash
# Check health
curl -sf http://localhost:18080/health | python3 -m json.tool
```

Look for `"extension_connected": true`. If the server is unreachable, start it:

```bash
bash ~/code/browser-console-bridge/bin/bcb-server-start
sleep 2
curl -sf http://localhost:18080/health | python3 -m json.tool
```

The server runs in its own tmux session (`bcb-server`), separate from the mecha session.

If `extension_connected` is `false`, Chrome is not open or the BCB extension has not connected yet. You can launch Chrome from bash:

```bash
/opt/google/chrome/chrome --new-window "https://example.com" &
sleep 3
curl -sf http://localhost:18080/health | python3 -m json.tool
```

**BCB is preferred over Playwright for all interactive testing** — it works against the real logged-in session with no setup. Do NOT fall back to Playwright unless BCB is genuinely unavailable (e.g. headless CI with no display).

## Step 2: Run CLI Commands

All CLI commands are run with the venv Python from the project directory:

```bash
cd ~/code/browser-console-bridge
BCB_PYTHON=".venv/bin/python3"
```

### List Tabs

```bash
cd ~/code/browser-console-bridge && .venv/bin/python3 -m cli.bcb_tabs
# JSON output
cd ~/code/browser-console-bridge && .venv/bin/python3 -m cli.bcb_tabs --json
```

### Execute JavaScript

```bash
# In the active tab
cd ~/code/browser-console-bridge && .venv/bin/python3 -m cli.bcb_exec 'document.title'

# In a specific tab (use tab_id from bcb_tabs)
cd ~/code/browser-console-bridge && .venv/bin/python3 -m cli.bcb_exec --tab 1729110643 'document.title'

# Multi-line code
cd ~/code/browser-console-bridge && .venv/bin/python3 -m cli.bcb_exec '
const items = document.querySelectorAll(".item");
items.length;
'

# With timeout
cd ~/code/browser-console-bridge && .venv/bin/python3 -m cli.bcb_exec --timeout 60 'heavyComputation()'
```

Exit codes: `0` = success (result on stdout), `1` = JS error (stderr), `2` = communication error (stderr)

### Read Console Output

```bash
# All recent output
cd ~/code/browser-console-bridge && .venv/bin/python3 -m cli.bcb_console

# Errors only, last 60 seconds
cd ~/code/browser-console-bridge && .venv/bin/python3 -m cli.bcb_console --levels error --since 60

# Raw JSON
cd ~/code/browser-console-bridge && .venv/bin/python3 -m cli.bcb_console --json --limit 50
```

### Take Screenshots

```bash
# Save to default location (prints path to stdout)
cd ~/code/browser-console-bridge && .venv/bin/python3 -m cli.bcb_screenshot

# Specific path
cd ~/code/browser-console-bridge && .venv/bin/python3 -m cli.bcb_screenshot --output /tmp/page.png

# JPEG
cd ~/code/browser-console-bridge && .venv/bin/python3 -m cli.bcb_screenshot --format jpeg

# Clean up old screenshots
cd ~/code/browser-console-bridge && .venv/bin/python3 -m cli.bcb_screenshot --cleanup 1h
```

## Targeting a Specific Tab

All `bcb_exec` and `bcb_console` commands accept `--tab TAB_ID`. Get IDs from `bcb_tabs`.

```bash
cd ~/code/browser-console-bridge && .venv/bin/python3 -m cli.bcb_exec --tab 1729111934 'window.location.href'
```

## Opening New Tabs (for parallel agent testing)

When multiple agents need to work in parallel, open a dedicated tab for each so their navigations don't interfere:

```bash
# Open N new tabs from the currently active tab
cd ~/code/browser-console-bridge && .venv/bin/python3 -m cli.bcb_exec \
  'Array.from({length: 2}, () => window.open("https://example.com", "_blank") && "opened")'

# Wait, then list tabs to get the new IDs
sleep 2 && cd ~/code/browser-console-bridge && .venv/bin/python3 -m cli.bcb_tabs

# Each agent uses its assigned tab ID for every command
cd ~/code/browser-console-bridge && .venv/bin/python3 -m cli.bcb_exec --tab <TAB_ID_1> '...'
```

## Screenshot Limitation

**`bcb_screenshot` always captures the **active tab**, regardless of any `--tab` argument. The Chrome extension uses `chrome.tabs.captureVisibleTab()`, which only captures the currently visible tab — the `--tab` flag is accepted by the CLI but ignored by the extension. To screenshot a specific tab, make it the active tab first (ask the user to switch to it), or inspect its content via `bcb_exec --tab <id>` and read the DOM instead.

## Error Handling

| Situation | What to do |
|-----------|------------|
| Connection refused | Run `bcb-server-start`, wait 2s, retry |
| `extension_connected: false` | Chrome is not open or hasn't connected yet. Ask the user to open Chrome — the extension is already installed, no setup needed. Do NOT fall back to Playwright. |
| `NO_EXTENSION` error | Same as above — Chrome needs to be open |
| `TIMEOUT` | Page may be slow; try `--timeout 60` or simplify the JS |
| JS error (exit 1) | Fix the JavaScript and retry |
| Screenshot captures wrong tab | `--tab` is a no-op for screenshots. Ask the user to make the target tab active, or use `bcb_exec --tab <id>` to read its DOM instead of screenshotting |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BCB_HOST` | `127.0.0.1` | Server hostname |
| `BCB_HTTP_PORT` | `18080` | Server HTTP port |
| `BCB_WS_PORT` | `18081` | WebSocket port |
| `BCB_TIMEOUT` | `30` | Default command timeout (seconds) |
| `BCB_SCREENSHOT_DIR` | `/tmp/bcb-screenshots` | Screenshot save directory |
| `BCB_SCREENSHOT_MAX_AGE` | `24h` | Screenshot auto-cleanup threshold |
