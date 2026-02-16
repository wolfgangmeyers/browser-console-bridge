# Browser Console Bridge

Execute JavaScript in browser tabs and capture console output, controlled from the command line. Designed as a composable tool for Claude Code agents.

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
  extension/          # Chrome extension (manifest.json, background.js, content.js)
  server/             # Python HTTP server (message broker)
  cli/                # CLI tools (stdlib only)
  bin/                # Server lifecycle scripts (tmux)
  skill/              # Claude Code skill definition
  docs/               # Design documents
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
