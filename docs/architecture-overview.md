# Browser Console Bridge: Architecture Overview

## What This Is

A composable pipeline that lets a Claude Code agent execute JavaScript in a
browser tab and read back the results. Four small components -- a Claude Code
skill, CLI tools, a Python HTTP server, and a Chrome extension -- pass messages
along a chain. Each component is independently runnable and testable.

## Architecture Diagram

```
                          localhost:8765
                               |
  Claude Code Agent            |           Browser
  =================            |           =======
                               |
  +---------------+     +------+------+     +-------------------+
  | Claude Code   |     |   Python    |     | Chrome Extension  |
  | Skill         |     |   HTTP      |     | (Manifest V3)     |
  | (skill/)      |     |   Server    |     | (extension/)      |
  |               |     |   (server/) |     |                   |
  | - checks tmux |     |             |     | - polls /poll     |
  | - invokes CLI |     | - /execute  |<--->| - posts /result   |
  | - reads output|     | - /result   |     | - injects JS into |
  +-------+-------+     | - /console  |     |   active tab      |
          |              | - /status   |     | - captures console|
          v              +------+------+     +-------------------+
  +---------------+            |
  | CLI Tools     |            |
  | (cli/)        |            |
  |               |            |
  | execute_js.py +------------+
  | read_console.py            |
  | server_status.py           |
  +----------------------------+
```

**Data flows left to right for commands, right to left for results.**

Detailed request path:

```
1. Skill calls:      python cli/execute_js.py "document.title"
2. CLI posts:        POST /execute  {"id": "abc", "code": "document.title"}
3. Server queues:    pending_commands["abc"] = {...}
4. Extension polls:  GET  /poll     -> receives command "abc"
5. Extension runs:   eval() in page context, patches console.*
6. Extension posts:  POST /result   {"id": "abc", "return_value": "My Page", ...}
7. Server resolves:  results["abc"] = {...}
8. CLI polls:        GET  /result/abc -> receives result
9. Skill reads:      stdout from execute_js.py, returns to agent
```

---

## Component Responsibilities

### 1. Chrome Extension (Manifest V3)

**Location:** `extension/`

**Purpose:** Bridge between the local server and the browser's page context.
This is the only component that can touch the DOM.

**Responsibilities:**

- Connect to the Python server at `http://localhost:8765` via polling
- Receive "execute JS" commands from `GET /poll`
- Inject the received JavaScript into the active tab's page context using
  `chrome.scripting.executeScript`
- Monkey-patch `console.log`, `console.warn`, `console.error`, and
  `console.info` to capture output during execution
- Capture screenshots via `chrome.tabs.captureVisibleTab()`, base64-encode,
  and send back to the server
- Collect the return value, any console output, and any thrown errors
- Post the result back to the server via `POST /result`

**Key files:**

```
extension/
  manifest.json          # Manifest V3, minimal permissions
  background.js          # Service worker: polling loop, message dispatch
  content.js             # Content script: JS injection, console capture
```

**Permissions required (minimal):**

- `activeTab` -- access the current tab only when invoked
- `scripting` -- inject JavaScript into the page context
- `host_permissions: ["http://localhost:8765/*", "<all_urls>"]` -- talk to the local server; `<all_urls>` required for `captureVisibleTab()`

**Polling behavior:**

The service worker runs a `setInterval` loop (e.g., every 500ms) hitting
`GET /poll`. When no commands are pending the server returns `204 No Content`
immediately. When a command is waiting the server returns it as JSON. This
avoids WebSocket complexity while keeping latency acceptable.

---

### 2. Python HTTP Server (Message Broker)

**Location:** `server/`

**Purpose:** In-memory message queue that correlates requests with responses.
The CLI tools and the extension never talk to each other directly; the server
is the rendezvous point.

**Responsibilities:**

- Serve a REST API on `localhost:8765`
- Maintain two in-memory dictionaries:
  - `pending_commands`: commands waiting to be picked up by the extension
  - `results`: completed results waiting to be picked up by the CLI
- Handle request/response correlation via unique command IDs
- Clean up stale entries after a configurable timeout (default: 30s)
- Provide a health/status endpoint

**API surface:**

| Method | Path            | Who calls it | Purpose                              |
|--------|-----------------|--------------|--------------------------------------|
| POST   | `/execute`      | CLI tool     | Submit a JS command for execution    |
| GET    | `/poll`         | Extension    | Fetch next pending command           |
| POST   | `/result`       | Extension    | Submit execution result              |
| GET    | `/result/{id}`  | CLI tool     | Retrieve result for a specific command|
| GET    | `/console`      | CLI tool     | Read captured console output buffer  |
| GET    | `/status`       | CLI / Skill  | Health check, extension connected?   |

**Implementation constraints:**

- Python stdlib only (`http.server`, `json`, `threading`, `uuid`)
- No framework, no pip dependencies
- Single-file server if possible (`server/bridge_server.py`)
- Runs in foreground (tmux manages the session)

**Key files:**

```
server/
  bridge_server.py       # The entire server
```

**Status tracking:**

The server tracks whether the extension is connected by recording the
timestamp of the last `GET /poll` request. If the extension hasn't polled in
the last 5 seconds, `/status` reports it as disconnected. This gives the
skill a clean way to detect when the extension isn't running.

**Timeout and cleanup:**

A background thread runs every 10 seconds and removes entries from
`pending_commands` and `results` that are older than 30 seconds. This
prevents memory leaks from abandoned commands.

---

### 3. CLI Tools

**Location:** `cli/`

**Purpose:** Thin, independently-runnable scripts that translate between
shell invocations and the server's HTTP API. Each tool does one thing.

**Key files:**

```
cli/
  execute_js.py          # Send JS, block until result
  read_console.py        # Read captured console buffer
  screenshot.py          # Capture screenshot, save to disk
  server_status.py       # Check server + extension health
```

#### `execute_js.py`

```
Usage:  python cli/execute_js.py <javascript_code> [--timeout 10]

Stdin:  (not used; JS passed as argument or via --file)
Stdout: JSON result on success
Stderr: Error message on failure
Exit:   0 = success, 1 = error, 2 = timeout
```

Behavior:

1. Generate a UUID for this command
2. `POST /execute` with `{"id": uuid, "code": js_code}`
3. Poll `GET /result/{uuid}` every 200ms until result arrives or timeout
4. Print the result JSON to stdout
5. Exit with appropriate code

Output format:

```json
{
  "id": "abc-123",
  "return_value": "My Page Title",
  "console_output": [
    {"level": "log", "args": ["loaded", 42]},
    {"level": "warn", "args": ["deprecation notice"]}
  ],
  "error": null,
  "duration_ms": 12
}
```

#### `read_console.py`

```
Usage:  python cli/read_console.py [--since <timestamp>] [--clear]

Stdout: JSON array of console entries
Exit:   0 = success, 1 = server unreachable
```

Reads the accumulated console output buffer from the server. Optionally
filters by timestamp or clears the buffer after reading.

#### `server_status.py`

```
Usage:  python cli/server_status.py

Stdout: JSON status object
Exit:   0 = healthy, 1 = server down, 2 = extension disconnected
```

Output format:

```json
{
  "server": "running",
  "extension": "connected",
  "last_poll": "2026-02-15T10:30:00Z",
  "pending_commands": 0,
  "pending_results": 1
}
```

---

### 4. Claude Code Skill

**Location:** `skill/`

**Purpose:** The interface between the Claude Code agent and the CLI tools.
The skill handles server lifecycle, invokes the right CLI tool, and presents
results in a form the agent can reason about.

**Key files:**

```
skill/
  browser-console.md     # Skill definition file
```

#### Skill Definition Format

Claude Code skills are Markdown files that describe tool behavior. The skill
file tells the agent what the tool does, when to use it, and provides the
exact Bash commands to run.

```markdown
---
name: browser-console
description: Execute JavaScript in the active browser tab and capture output
---

# Browser Console Bridge

Execute JavaScript in the browser and read console output.

## Prerequisites

The Python bridge server must be running in a tmux session, and the Chrome
extension must be installed and active.

## Checking Server Status

\`\`\`bash
python /path/to/cli/server_status.py
\`\`\`

## Starting the Server (if not running)

\`\`\`bash
tmux has-session -t browser-bridge 2>/dev/null || \
  tmux new-session -d -s browser-bridge \
  "python /path/to/server/bridge_server.py"
\`\`\`

## Executing JavaScript

\`\`\`bash
python /path/to/cli/execute_js.py "document.title"
\`\`\`

## Reading Console Output

\`\`\`bash
python /path/to/cli/read_console.py
\`\`\`
```

#### Skill Invocation Flow

When the agent needs to interact with the browser, the sequence is:

```
Agent decides to check something in the browser
  |
  v
Skill activates
  |
  v
Step 1: Check server status
  $ python cli/server_status.py
  |
  +--> Server not running?
  |      $ tmux new-session -d -s browser-bridge \
  |          "python server/bridge_server.py"
  |      (wait 1 second for startup)
  |      $ python cli/server_status.py  # verify
  |
  +--> Extension not connected?
  |      Return clear error: "Chrome extension is not connected.
  |      Open Chrome and verify the extension is enabled."
  |
  v
Step 2: Execute the JavaScript
  $ python cli/execute_js.py "<agent's JS code>" --timeout 10
  |
  +--> Timeout?
  |      Return: "Execution timed out after 10s. The page may be
  |      unresponsive or the script is long-running."
  |
  +--> JS error?
  |      Return the error message and stack trace to the agent
  |
  v
Step 3: Return results
  Parse the JSON output, present return_value and console_output
  to the agent in a readable format
```

#### Error Handling and Recovery

| Failure                    | Detection                        | Recovery                                    |
|----------------------------|----------------------------------|---------------------------------------------|
| Server not running         | `server_status.py` exits 1       | Start via tmux, retry                       |
| Extension not connected    | `server_status.py` exits 2       | Tell user to check Chrome                   |
| Execution timeout          | `execute_js.py` exits 2          | Report to agent, suggest shorter operation  |
| JS runtime error           | `error` field in result JSON     | Pass error + stack trace to agent           |
| Server crashed mid-request | Connection refused on poll       | Restart server via tmux, retry once         |
| Stale tmux session         | Server responds but extension gone| Kill session, restart, report extension status|

---

## Data Flow Examples

### Example 1: Agent checks a value on a webpage

The agent wants to know the page title.

```
Agent: "What is the title of the current page?"

Skill runs:
  $ python cli/server_status.py
  -> {"server": "running", "extension": "connected", ...}

  $ python cli/execute_js.py "document.title"
  -> {"return_value": "GitHub - my-repo", "console_output": [], "error": null}

Agent receives: "The page title is 'GitHub - my-repo'."
```

### Example 2: Agent runs a multi-line script with console output

The agent wants to count elements and log details.

```
Agent: "How many list items are on the page? Log their text content."

Skill runs:
  $ python cli/execute_js.py "
    const items = document.querySelectorAll('li');
    items.forEach((el, i) => console.log(i, el.textContent.trim()));
    items.length;
  "
  -> {
       "return_value": 5,
       "console_output": [
         {"level": "log", "args": [0, "First item"]},
         {"level": "log", "args": [1, "Second item"]},
         {"level": "log", "args": [2, "Third item"]},
         {"level": "log", "args": [3, "Fourth item"]},
         {"level": "log", "args": [4, "Fifth item"]}
       ],
       "error": null
     }

Agent receives: "There are 5 list items. Their contents are: ..."
```

### Example 3: Server is not running -- skill auto-starts it

```
Skill runs:
  $ python cli/server_status.py
  -> exit code 1 (connection refused)

  $ tmux has-session -t browser-bridge 2>/dev/null
  -> exit code 1 (no such session)

  $ tmux new-session -d -s browser-bridge \
      "python server/bridge_server.py"

  $ sleep 1

  $ python cli/server_status.py
  -> {"server": "running", "extension": "connected", ...}

  (proceed with execution)
```

### Example 4: Extension is not connected

```
Skill runs:
  $ python cli/server_status.py
  -> {"server": "running", "extension": "disconnected", "last_poll": null}
  -> exit code 2

Agent receives: "The bridge server is running but the Chrome extension
is not connected. Please open Chrome and verify the Browser Console
Bridge extension is enabled."
```

### Example 5: JavaScript execution throws an error

```
Skill runs:
  $ python cli/execute_js.py "document.querySelector('#missing').click()"
  -> {
       "return_value": null,
       "console_output": [],
       "error": "TypeError: Cannot read properties of null (reading 'click')\n    at <anonymous>:1:43"
     }

Agent receives: "The JavaScript threw an error: TypeError: Cannot read
properties of null (reading 'click'). The element '#missing' was not
found on the page."
```

---

## Security Considerations

**Localhost only.** The Python server binds to `127.0.0.1:8765`. It is not
reachable from other machines on the network. There is no authentication
because the threat model assumes the local user is trusted.

**No remote code execution surface.** Commands originate from the local CLI
tools only. The extension only accepts commands from localhost. There is no
inbound path from the internet.

**Minimal extension permissions.** The extension requests:

- `activeTab` -- not blanket tab access; only the tab the user is viewing
- `scripting` -- required to inject JS; scoped to localhost communication
- `host_permissions` limited to `http://localhost:8765/*`

The extension does not request `tabs`, `history`, `cookies`, `webRequest`,
or any other broad permission.

**No persistent storage.** The server holds commands and results in memory
only. Nothing is written to disk. Entries expire after 30 seconds.

**JS execution scope.** Code runs in the page's main world (not an isolated
extension context), which means it can access page-level variables and the
DOM. This is intentional -- it is the whole point of the tool. The user
should be aware that executed JS has the same power as code typed into the
browser's DevTools console.

---

## File Structure

```
browser-console-bridge/
├── extension/
│   ├── manifest.json            # Manifest V3 declaration
│   ├── background.js            # Service worker: poll loop, dispatch
│   └── content.js               # Content script: execute JS, capture console
│
├── server/
│   └── bridge_server.py         # HTTP server, message queue, cleanup thread
│
├── cli/
│   ├── execute_js.py            # Send JS to browser, return result
│   ├── read_console.py          # Read console output buffer
│   ├── screenshot.py            # Capture screenshot, save to disk
│   └── server_status.py         # Health check
│
├── skill/
│   └── browser-console.md       # Claude Code skill definition
│
├── docs/
│   └── architecture-overview.md # This document
│
└── README.md                    # Quick start, installation
```

**Total files:** ~10. Each one has a single clear purpose.

---

## Design Principles

These principles guide implementation decisions:

**Compose, don't monolith.** Each component (extension, server, CLI tool,
skill) runs independently. You can test the server with `curl`. You can run
the CLI without the skill. You can use the extension with a different server.

**Minimal dependencies.** The server uses Python's standard library only. The
CLI tools use Python's standard library only. The extension uses Chrome's
built-in APIs. No npm, no pip, no build step.

**Clear input/output contracts.** CLI tools accept arguments and print JSON to
stdout. The server speaks HTTP with JSON bodies. The extension communicates via
the same HTTP endpoints. Every boundary is documented and testable with
standard tools.

**Generous defaults, explicit overrides.** The server runs on port 8765 and
times out after 30 seconds. The CLI times out after 10 seconds. All of these
are configurable via arguments or environment variables, but the defaults work
without configuration.

**Code is a liability.** Every line has a maintenance cost. The server should
be under 200 lines. Each CLI tool should be under 80 lines. The extension
should be under 150 lines. If a component grows beyond these bounds, it is
doing too much.
