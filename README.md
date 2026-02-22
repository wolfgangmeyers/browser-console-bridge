# Browser Console Bridge

Execute JavaScript in browser tabs and capture console output, controlled from the command line. Designed as a composable tool for Claude Code agents.

## Setup

### Prerequisites

- Python 3.10+
- tmux
- Google Chrome
- Claude Code (for the skill integration)

### 1. Install Python dependencies

```bash
cd browser-console-bridge
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

### 2. Install the Chrome extension

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select the `extension/` directory from this repo

The extension icon should appear in the toolbar. It connects automatically when the server is running.

### 3. Start the server

```bash
bash bin/bcb-server-start
sleep 2

# Verify it's running and the extension has connected
curl -sf http://localhost:18080/health | python3 -m json.tool
# Look for: "extension_connected": true
```

The server runs in a tmux session named `bcb-server`. Use `bin/bcb-server-stop` and `bin/bcb-server-restart` to manage it.

### 4. Test it

```bash
# List open tabs
.venv/bin/python3 -m cli.bcb_tabs

# Execute JavaScript in the active tab
.venv/bin/python3 -m cli.bcb_exec 'document.title'

# Take a screenshot
.venv/bin/python3 -m cli.bcb_screenshot --output /tmp/test.png
```

### 5. Set up the Claude Code skill (optional)

Symlink the skill directory so Claude Code can use it:

```bash
ln -s "$(pwd)/.claude/skills/browser-console" ~/.claude/skills/browser-console
```

Then invoke it in Claude Code with `/browser-console`.

**Or use the install skill** to do steps 1–5 automatically. From Claude Code in this repo's directory:

```
/install
```

This sets up the venv, symlinks the skill, and starts the server. Loading the Chrome extension is the one step that must be done manually.

## How It Works

```
Claude Code Skill --> CLI Tools --> Python Server <--> Browser Extension --> Browser Tab
```

Four small components pass messages along a chain:

1. **Browser Extension** (Chrome, Manifest V3) -- connects to the local server, executes JS in the active tab via `chrome.scripting.executeScript` with `world: 'MAIN'`, captures console output via monkey-patching
2. **Python Server** -- message broker running in tmux, correlates requests with responses via message IDs, exposes REST API for CLI and WebSocket/polling for the extension
3. **CLI Tools** -- thin Python scripts (`bcb-exec`, `bcb-console`, `bcb-tabs`) that post commands and block until results arrive, JSON on stdout, errors on stderr
4. **Claude Code Skill** -- ensures server is running, invokes CLI tools, presents results to the agent

## Project Structure

```
browser-console-bridge/
  .claude/skills/browser-console/  # Claude Code skill definition (SKILL.md)
  extension/                        # Chrome extension (manifest.json, background.js, content.js)
  server/                           # Python HTTP server (message broker)
  cli/                              # CLI tools (stdlib only)
  bin/                              # Server lifecycle scripts (tmux)
  docs/                             # Design documents
```

## Design Documents

- [Architecture Overview](docs/architecture-overview.md) -- component responsibilities, data flow, skill integration, security model
- [Message Queue Design](docs/message-queue-design.md) -- message formats, queue mechanics, REST API, WebSocket protocol, CLI client design, tmux integration
- [Browser Extension Research](docs/browser-extension-research.md) -- MV3 fundamentals, JS execution approaches, console capture techniques, communication patterns

## Open Design Decisions

**Extension-server channel: HTTP polling vs WebSocket.** The architecture doc proposes HTTP polling (simpler, no extra dependency). The message queue design and extension research recommend WebSocket (bidirectional, real-time, keeps service worker alive). WebSocket requires the `websockets` Python library as the single external dependency. Trade-off: simplicity vs latency and service worker lifecycle management.

## Design Principles

- **Compose, don't monolith** -- each component independently runnable and testable
- **Minimal dependencies** -- Python stdlib for CLI/server where possible, no npm, no build step
- **Clear contracts** -- JSON on stdout, meaningful exit codes, documented HTTP endpoints
- **Generous defaults** -- works without configuration, everything overridable
- **Code is a liability** -- server under 200 lines, CLI tools under 80 lines each
