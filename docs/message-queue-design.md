# Message Queue Design: Browser Console Bridge

## Overview

This document specifies the communication protocol and architecture for a system that lets CLI tools execute JavaScript in browser tabs and read console output. The system has three components:

```
CLI scripts  ---HTTP--->  Python server (tmux)  <---WebSocket---  Browser extension
```

- **CLI scripts**: Python programs that send a command and block until a response arrives.
- **Server**: A persistent Python HTTP/WebSocket server acting as a message broker.
- **Browser extension**: Connects to the server via WebSocket, executes JS in tabs, captures console output.

The server is the only long-running process. CLI scripts are short-lived. The extension maintains a persistent WebSocket connection.

---

## 1. Message Format

All messages are JSON objects. Every message has a `type` field. Request/response pairs share a `msg_id` for correlation.

### 1.1 Common Fields

| Field      | Type   | Required | Description                              |
|------------|--------|----------|------------------------------------------|
| `type`     | string | yes      | Message type identifier                  |
| `msg_id`   | string | yes      | UUID v4 for request/response correlation |
| `ts`       | number | yes      | Unix timestamp (seconds, float)          |

### 1.2 Execute JavaScript

**CLI -> Server (request)**

```json
{
  "type": "execute_js",
  "msg_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "ts": 1739612345.123,
  "code": "document.title",
  "tab_id": null,
  "timeout": 30
}
```

| Field    | Type        | Default | Description                                              |
|----------|-------------|---------|----------------------------------------------------------|
| `code`   | string      | --      | JavaScript code to execute in the tab                    |
| `tab_id` | int or null | null    | Target tab ID. `null` means the active tab.              |
| `timeout`| number      | 30      | Seconds the CLI will wait before giving up               |

**Server -> Extension (forwarded command)**

The server wraps the request and forwards it over WebSocket:

```json
{
  "type": "execute_js",
  "msg_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "ts": 1739612345.123,
  "code": "document.title",
  "tab_id": null
}
```

**Extension -> Server (result)**

```json
{
  "type": "execute_js_result",
  "msg_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "ts": 1739612347.456,
  "success": true,
  "result": "My Page Title",
  "error": null
}
```

| Field     | Type        | Description                                        |
|-----------|-------------|----------------------------------------------------|
| `success` | bool        | Whether execution completed without error          |
| `result`  | any or null | Return value of the executed code (JSON-serialized) |
| `error`   | string or null | Error message if `success` is false             |

When execution fails:

```json
{
  "type": "execute_js_result",
  "msg_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "ts": 1739612347.456,
  "success": false,
  "result": null,
  "error": "ReferenceError: foo is not defined"
}
```

### 1.3 Read Console Output

**CLI -> Server (request)**

```json
{
  "type": "read_console",
  "msg_id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "ts": 1739612350.000,
  "tab_id": null,
  "since": 1739612300.000,
  "levels": ["log", "warn", "error"],
  "limit": 100,
  "timeout": 10
}
```

| Field    | Type             | Default                          | Description                          |
|----------|------------------|----------------------------------|--------------------------------------|
| `tab_id` | int or null      | null                             | Target tab. `null` = active tab.     |
| `since`  | number or null   | null                             | Only entries after this Unix timestamp. `null` = all buffered. |
| `levels` | list of strings  | `["log","warn","error","info"]`  | Console levels to include            |
| `limit`  | int              | 100                              | Max entries to return                |
| `timeout`| number           | 10                               | Seconds to wait                      |

**Extension -> Server (result)**

```json
{
  "type": "read_console_result",
  "msg_id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "ts": 1739612351.234,
  "success": true,
  "entries": [
    {
      "level": "log",
      "ts": 1739612301.100,
      "content": "Page loaded",
      "source": "https://example.com/app.js:42"
    },
    {
      "level": "error",
      "ts": 1739612302.200,
      "content": "Failed to fetch /api/data: 404",
      "source": "https://example.com/app.js:87"
    }
  ],
  "error": null
}
```

Each console entry:

| Field    | Type   | Description                                   |
|----------|--------|-----------------------------------------------|
| `level`  | string | One of: `log`, `warn`, `error`, `info`, `debug` |
| `ts`     | number | Unix timestamp when the message was logged     |
| `content`| string | The console message text                       |
| `source` | string | Source file and line number (if available)      |

### 1.4 List Tabs

**CLI -> Server (request)**

```json
{
  "type": "list_tabs",
  "msg_id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
  "ts": 1739612360.000,
  "timeout": 10
}
```

**Extension -> Server (result)**

```json
{
  "type": "list_tabs_result",
  "msg_id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
  "ts": 1739612360.500,
  "success": true,
  "tabs": [
    {"id": 123, "url": "https://example.com", "title": "Example", "active": true},
    {"id": 456, "url": "https://google.com", "title": "Google", "active": false}
  ],
  "error": null
}
```

### 1.5 Screenshot

**CLI -> Server (request)**

```json
{
  "type": "screenshot",
  "msg_id": "d4e5f6a7-b8c9-0123-defa-234567890123",
  "ts": 1739612370.000,
  "tab_id": null,
  "format": "png",
  "timeout": 10
}
```

| Field    | Type        | Default | Description                               |
|----------|-------------|---------|-------------------------------------------|
| `tab_id` | int or null | null    | Target tab. `null` = active tab.          |
| `format` | string      | "png"   | Image format: `"png"` or `"jpeg"`.       |

**Extension -> Server (result)**

The extension captures the screenshot using `chrome.tabs.captureVisibleTab()` and sends the base64-encoded image to the server:

```json
{
  "type": "screenshot_result",
  "msg_id": "d4e5f6a7-b8c9-0123-defa-234567890123",
  "ts": 1739612370.800,
  "success": true,
  "image_data": "iVBORw0KGgoAAAANSUhEUgAA...",
  "format": "png",
  "error": null
}
```

| Field        | Type   | Description                                        |
|--------------|--------|----------------------------------------------------|
| `image_data` | string | Base64-encoded image bytes                         |
| `format`     | string | Image format used (`"png"` or `"jpeg"`)            |

**Server processing:** Upon receiving the screenshot result from the extension, the server holds the base64 `image_data` in the result object (in-memory, alongside the normal `PendingCommand` response). The CLI then receives the full result including the base64 payload.

**CLI receives:**

```json
{
  "type": "screenshot_result",
  "msg_id": "d4e5f6a7-b8c9-0123-defa-234567890123",
  "ts": 1739612370.800,
  "success": true,
  "image_data": "iVBORw0KGgoAAAANSUhEUgAA...",
  "format": "png",
  "error": null
}
```

**CLI saves to disk:** The CLI tool decodes the base64 data and writes it to a local file. The output path is configurable (defaults to `/tmp/bcb-screenshots/{msg_id}.{format}`).

```bash
# Take screenshot, save to default location
bcb-screenshot
# stdout: /tmp/bcb-screenshots/d4e5f6a7.png

# Take screenshot, save to specific path
bcb-screenshot --output ./page.png
# stdout: ./page.png

# JPEG format
bcb-screenshot --format jpeg --output ./page.jpg
```

Exit codes: `0` = saved successfully (path on stdout), `1` = capture error, `2` = communication error.

**Screenshot cleanup:** The server runs a background cleanup thread that periodically removes old screenshot data from completed results. The CLI is responsible for saving to disk promptly — once the `PendingCommand` expires from the server's in-memory queue (default 30s), the image data is gone. This is the same cleanup mechanism as other command results, so no special screenshot storage accumulates on the server.

For CLI-saved files, the `bcb-screenshot` tool supports a `--cleanup` flag to delete screenshots older than a threshold:

```bash
# Delete screenshots older than 1 hour from the default directory
bcb-screenshot --cleanup 1h

# Delete screenshots older than 7 days
bcb-screenshot --cleanup 7d
```

The cleanup threshold is also configurable via `BCB_SCREENSHOT_MAX_AGE` (default: `24h`).

### 1.6 Error Response (Server-Generated)

When the server itself must reject a request (no extension connected, invalid message, etc.), it responds directly without forwarding to the extension:

```json
{
  "type": "error",
  "msg_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "ts": 1739612345.500,
  "error": "no extension connected",
  "code": "NO_EXTENSION"
}
```

Error codes:

| Code              | Meaning                                      |
|-------------------|----------------------------------------------|
| `NO_EXTENSION`    | No browser extension is connected            |
| `TIMEOUT`         | Extension did not respond within the timeout |
| `INVALID_MESSAGE` | Malformed request                            |
| `SERVER_ERROR`    | Unexpected server-side error                 |

### 1.6 Health Check

**CLI -> Server (request)**

```
GET /health
```

**Server response (not queued -- answered directly)**

```json
{
  "status": "ok",
  "extension_connected": true,
  "pending_commands": 2,
  "uptime": 3600.5
}
```

---

## 2. Queue Mechanics

### 2.1 Data Structures

The server maintains two in-memory structures:

```python
# Pending commands waiting for extension to pick up and respond
# Key: msg_id, Value: {request, event, response, created_at}
pending: dict[str, PendingCommand] = {}

# Connected extension WebSocket (only one at a time)
extension_ws: WebSocket | None = None
```

```python
@dataclass
class PendingCommand:
    msg_id: str
    request: dict            # The original request payload
    event: threading.Event   # Signaled when response arrives
    response: dict | None    # Filled in when extension responds
    created_at: float        # time.time() when created
    timeout: float           # Seconds before auto-cleanup
```

### 2.2 Request/Response Flow

```
CLI                         Server                        Extension
 |                            |                              |
 |-- POST /command ---------->|                              |
 |                            |-- WebSocket send ----------->|
 |                            |   (execute_js)               |
 |   (blocking on             |                              |
 |    HTTP response)          |                              |-- executes JS
 |                            |                              |
 |                            |<-- WebSocket recv -----------|
 |                            |   (execute_js_result)        |
 |<-- HTTP 200 ---------------|                              |
 |   (execute_js_result)      |                              |
```

Step by step:

1. CLI sends `POST /command` with a JSON body. The server generates `msg_id` if not provided.
2. Server creates a `PendingCommand` with a `threading.Event`.
3. Server forwards the command to the extension over WebSocket.
4. Server blocks the HTTP handler thread on `event.wait(timeout=...)`.
5. Extension processes the command and sends the result back over WebSocket.
6. Server receives the result, matches it by `msg_id`, fills in `response`, and signals the event.
7. The HTTP handler wakes up and returns the response to the CLI.
8. If the event times out, the handler returns a timeout error response and removes the pending entry.

### 2.3 Concurrency

The server uses `threading` (via `http.server.ThreadingHTTPServer`) so multiple CLI requests can be in flight simultaneously. Each request blocks its own thread on its own `threading.Event`. The WebSocket connection to the extension is shared, but sends are serialized by a lock.

### 2.4 Queue Cleanup

A background thread runs every 60 seconds and removes any `PendingCommand` where `time.time() - created_at > timeout + 30`. The extra 30-second grace period handles cases where the HTTP handler thread has already timed out and returned an error but hasn't yet removed its entry. This is a safety net; normal cleanup happens when the HTTP handler returns.

---

## 3. Server Design

### 3.1 Technology

- Python 3.10+ (stdlib only for HTTP)
- `http.server.ThreadingHTTPServer` for the REST API
- `websockets` library (single external dependency) for the extension connection
- Both listeners run in the same process, on different ports

### 3.2 Ports

| Service   | Default Port | Env Var Override  |
|-----------|-------------|-------------------|
| HTTP API  | 18080       | `BCB_HTTP_PORT`   |
| WebSocket | 18081       | `BCB_WS_PORT`     |

### 3.3 REST Endpoints

#### `POST /command`

Send a command to the browser extension and block until the response arrives.

**Request body**: Any valid command message (see Section 1).

**Response**: The result message from the extension, or an error.

**HTTP status**: Always `200`. All errors are reported in the response body via `success: false` and `error`/`code` fields. See [Section 3.5: Uniform 200 Response Policy](#35-uniform-200-response-policy).

**Example**:

```bash
curl -X POST http://localhost:18080/command \
  -H "Content-Type: application/json" \
  -d '{"type": "execute_js", "code": "document.title"}'
```

Success response (200):

```json
{
  "type": "execute_js_result",
  "msg_id": "auto-generated-uuid",
  "ts": 1739612347.456,
  "success": true,
  "result": "My Page Title",
  "error": null
}
```

Error response (still 200):

```json
{
  "type": "error",
  "msg_id": "auto-generated-uuid",
  "ts": 1739612345.500,
  "success": false,
  "error": "no extension connected",
  "code": "NO_EXTENSION"
}
```

#### `GET /health`

Non-blocking health check. Always responds immediately.

**Response** (200):

```json
{
  "status": "ok",
  "extension_connected": true,
  "pending_commands": 0,
  "uptime": 3600.5
}
```

#### `GET /status`

Alias for `/health`. Identical behavior.

#### Any other path

Returns 200 with an empty JSON object `{}`. No 404s.

### 3.4 WebSocket Protocol (Extension Side)

The extension connects to `ws://localhost:18081`. Only one extension connection is accepted at a time. If a new extension connects while one is already connected, the old connection is closed (allows clean reconnection after extension reload).

**Server -> Extension messages**: Command messages (`execute_js`, `read_console`, `list_tabs`).

**Extension -> Server messages**: Result messages (`execute_js_result`, `read_console_result`, `list_tabs_result`).

The extension must include the `msg_id` from the command in its result message.

### 3.5 Uniform 200 Response Policy

**Every HTTP response returns status 200.** The server never returns 400, 404, 408, 500, 502, or any other status code. This prevents information disclosure if something probes the server.

- **Unknown paths**: Return `200` with `{}`. A probe to `/admin`, `/api/v2/secrets`, or any random path gets the same empty response as a typo.
- **Malformed requests**: Return `200` with `{"success": false, "error": "...", "code": "INVALID_MESSAGE"}`. Don't distinguish between bad JSON, missing fields, or unknown message types in the HTTP status.
- **Extension not connected**: Return `200` with the `NO_EXTENSION` error body. Don't reveal server state via HTTP status.
- **Timeouts**: Return `200` with the `TIMEOUT` error body.
- **Server errors**: Return `200` with `{"success": false, "error": "internal error", "code": "SERVER_ERROR"}`. Don't leak stack traces.

CLI tools distinguish success from failure by checking the `success` field in the response body, not the HTTP status code. This is the only contract: `success: true` means it worked, `success: false` means check `error` and `code`.

### 3.6 Server Module Layout

```
server/
    __init__.py
    main.py          # Entry point, starts HTTP + WS servers
    http_handler.py  # ThreadingHTTPServer request handler
    ws_handler.py    # WebSocket connection manager
    queue.py         # PendingCommand and queue management
    config.py        # Ports, timeouts, env var overrides
```

---

## 4. CLI Client Design

### 4.1 Two CLI Tools

#### `bcb-exec` -- Execute JavaScript

```bash
# Execute JS in the active tab
bcb-exec 'document.title'

# Execute in a specific tab
bcb-exec --tab 123 'document.querySelectorAll("a").length'

# Custom timeout
bcb-exec --timeout 60 'await fetch("/api/slow").then(r => r.json())'

# Read from stdin
echo 'document.title' | bcb-exec -
```

Exit codes:
- `0` -- Success. Result printed to stdout as JSON.
- `1` -- JavaScript execution error. Error message printed to stderr.
- `2` -- Communication error (server not running, extension not connected, timeout). Error printed to stderr.

Stdout contains only the result value (JSON-encoded), making it composable:

```bash
title=$(bcb-exec 'document.title' | jq -r .)
```

#### `bcb-console` -- Read Console Output

```bash
# Read all buffered console output from the active tab
bcb-console

# Only errors from the last 60 seconds
bcb-console --levels error --since 60s

# From a specific tab, limit 10 entries
bcb-console --tab 456 --limit 10

# Output as JSON (default is human-readable)
bcb-console --json
```

Default human-readable output format:

```
[ERROR] 12:05:02.200  Failed to fetch /api/data: 404
                      (https://example.com/app.js:87)
[LOG]   12:05:01.100  Page loaded
                      (https://example.com/app.js:42)
```

Exit codes: same as `bcb-exec`.

#### `bcb-tabs` -- List Open Tabs

```bash
bcb-tabs
# Output:
#   123  * https://example.com          Example
#   456    https://google.com            Google
# (* marks the active tab)

bcb-tabs --json
# JSON array output
```

#### `bcb-screenshot` -- Capture Screenshot

```bash
# Save to default location, print path to stdout
bcb-screenshot
# stdout: /tmp/bcb-screenshots/d4e5f6a7.png

# Save to specific path
bcb-screenshot --output ./page.png

# JPEG format
bcb-screenshot --format jpeg

# Specific tab
bcb-screenshot --tab 123

# Cleanup old screenshots
bcb-screenshot --cleanup 1h
```

Exit codes: `0` = saved (path on stdout), `1` = capture error, `2` = communication error.

### 4.2 Client Implementation

Each CLI tool is a thin wrapper around a shared `BcbClient` class:

```python
import json
import sys
import urllib.request
import uuid
import time

class BcbClient:
    def __init__(self, host="localhost", port=18080):
        self.base_url = f"http://{host}:{port}"

    def send_command(self, command: dict, timeout: float = 30) -> dict:
        """Send a command and block until response. Raises on error."""
        if "msg_id" not in command:
            command["msg_id"] = str(uuid.uuid4())
        if "ts" not in command:
            command["ts"] = time.time()
        command["timeout"] = timeout

        data = json.dumps(command).encode()
        req = urllib.request.Request(
            f"{self.base_url}/command",
            data=data,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout + 5) as resp:
                return json.loads(resp.read())
        except urllib.error.URLError as e:
            raise ConnectionError(f"Server not reachable: {e}")
        except TimeoutError:
            raise TimeoutError(f"No response within {timeout}s")

    def execute_js(self, code: str, tab_id=None, timeout=30) -> dict:
        return self.send_command({
            "type": "execute_js",
            "code": code,
            "tab_id": tab_id,
        }, timeout=timeout)

    def read_console(self, tab_id=None, since=None, levels=None,
                     limit=100, timeout=10) -> dict:
        cmd = {"type": "read_console", "tab_id": tab_id, "limit": limit}
        if since is not None:
            cmd["since"] = since
        if levels is not None:
            cmd["levels"] = levels
        return self.send_command(cmd, timeout=timeout)

    def list_tabs(self, timeout=10) -> dict:
        return self.send_command({"type": "list_tabs"}, timeout=timeout)

    def screenshot(self, tab_id=None, format="png", timeout=10) -> dict:
        return self.send_command({
            "type": "screenshot",
            "tab_id": tab_id,
            "format": format,
        }, timeout=timeout)

    def health(self) -> dict:
        req = urllib.request.Request(f"{self.base_url}/health")
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read())
```

The client uses only `urllib` (stdlib). No external dependencies.

Note that the client sets the HTTP timeout to `timeout + 5` seconds. This ensures the server-side timeout fires first, so the client receives a structured timeout error response rather than a raw socket timeout.

### 4.3 Client Module Layout

```
cli/
    __init__.py
    client.py          # BcbClient class
    bcb_exec.py        # Entry point for bcb-exec
    bcb_console.py     # Entry point for bcb-console
    bcb_tabs.py        # Entry point for bcb-tabs
    bcb_screenshot.py  # Entry point for bcb-screenshot
```

---

## 5. Error Handling

### 5.1 Error Scenarios and Responses

All server responses are HTTP 200. CLI tools check the `success` field to determine outcome.

| Scenario                    | Detected by | Response body                                           | CLI exit code |
|-----------------------------|-------------|---------------------------------------------------------|---------------|
| Server not running          | CLI client  | (connection refused, no response)                       | 2             |
| Extension not connected     | Server      | `{"success": false, "code": "NO_EXTENSION", ...}`      | 2             |
| Tab not found               | Extension   | `{"success": false, "error": "tab not found: 999"}`    | 1             |
| JS syntax error             | Extension   | `{"success": false, "error": "SyntaxError: ..."}`      | 1             |
| JS runtime error            | Extension   | `{"success": false, "error": "TypeError: ..."}`        | 1             |
| Extension timeout           | Server      | `{"success": false, "code": "TIMEOUT", ...}`           | 2             |
| Malformed request           | Server      | `{"success": false, "code": "INVALID_MESSAGE", ...}`   | 2             |
| Extension disconnects       | Server      | `{"success": false, "code": "NO_EXTENSION", ...}`      | 2             |
| Unknown URL path            | Server      | `{}`                                                    | 2             |

### 5.2 Extension Reconnection

The extension should reconnect on WebSocket close with exponential backoff:

```
attempt 1: wait 1s
attempt 2: wait 2s
attempt 3: wait 4s
...
max wait: 30s
```

When the extension reconnects, any pending commands that were in flight are already timed out (or will time out shortly) on the server side. The server does not replay them. The CLI client will have already received a timeout error.

### 5.3 Extension Disconnect Detection

The server detects extension disconnect immediately via WebSocket close. It then:
1. Sets `extension_ws = None`
2. Signals all pending command events with an error response (so blocked CLI requests unblock immediately rather than waiting for timeout)

---

## 6. Tmux Integration

### 6.1 Server Startup Script

`bin/bcb-server-start`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="bcb-server"
SERVER_SCRIPT="$(dirname "$0")/../server/main.py"

# Check if already running
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "Server already running in tmux session '$SESSION_NAME'"
    echo "Use: tmux attach -t $SESSION_NAME"
    exit 0
fi

# Start in new tmux session
tmux new-session -d -s "$SESSION_NAME" "python3 $SERVER_SCRIPT"
echo "Server started in tmux session '$SESSION_NAME'"
echo "HTTP API:   http://localhost:${BCB_HTTP_PORT:-18080}"
echo "WebSocket:  ws://localhost:${BCB_WS_PORT:-18081}"
```

### 6.2 Server Status Check

`bin/bcb-server-status`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Check tmux session
if ! tmux has-session -t bcb-server 2>/dev/null; then
    echo "Server tmux session not found"
    exit 1
fi

# Check HTTP health
if curl -sf http://localhost:${BCB_HTTP_PORT:-18080}/health > /dev/null 2>&1; then
    curl -s http://localhost:${BCB_HTTP_PORT:-18080}/health | python3 -m json.tool
else
    echo "Server session exists but HTTP endpoint not responding"
    exit 1
fi
```

### 6.3 Server Restart

`bin/bcb-server-restart`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="bcb-server"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    tmux kill-session -t "$SESSION_NAME"
    echo "Killed existing session"
    sleep 1
fi

exec "$(dirname "$0")/bcb-server-start"
```

### 6.4 Server Shutdown

The server handles `SIGTERM` and `SIGINT` gracefully:
1. Stop accepting new HTTP connections
2. Signal all pending command events with a server-shutdown error
3. Close the WebSocket connection to the extension
4. Exit

---

## 7. Browser Extension Design (Communication Layer)

The extension's communication layer is minimal. It is responsible for:

1. Maintaining a WebSocket connection to the server
2. Receiving command messages and dispatching them
3. Sending result messages back

```javascript
// extension/bridge.js -- communication with the BCB server

class BcbBridge {
  constructor(wsUrl = "ws://localhost:18081") {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.reconnectDelay = 1000;
  }

  connect() {
    this.ws = new WebSocket(this.wsUrl);

    this.ws.onopen = () => {
      console.log("[BCB] Connected to server");
      this.reconnectDelay = 1000; // reset backoff
    };

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      this.handleCommand(msg);
    };

    this.ws.onclose = () => {
      console.log(`[BCB] Disconnected. Reconnecting in ${this.reconnectDelay}ms`);
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    };
  }

  async handleCommand(msg) {
    let result;
    try {
      switch (msg.type) {
        case "execute_js":
          result = await this.executeJs(msg);
          break;
        case "read_console":
          result = await this.readConsole(msg);
          break;
        case "list_tabs":
          result = await this.listTabs(msg);
          break;
        default:
          result = {
            type: "error",
            msg_id: msg.msg_id,
            ts: Date.now() / 1000,
            error: `unknown command type: ${msg.type}`,
          };
      }
    } catch (e) {
      result = {
        type: `${msg.type}_result`,
        msg_id: msg.msg_id,
        ts: Date.now() / 1000,
        success: false,
        result: null,
        error: e.message,
      };
    }
    this.ws.send(JSON.stringify(result));
  }

  async executeJs(msg) {
    const tabId = msg.tab_id ?? (await this.getActiveTabId());
    const [response] = await chrome.scripting.executeScript({
      target: { tabId },
      func: new Function(msg.code),
      world: "MAIN",
    });
    return {
      type: "execute_js_result",
      msg_id: msg.msg_id,
      ts: Date.now() / 1000,
      success: true,
      result: response.result ?? null,
      error: null,
    };
  }

  // readConsole and listTabs follow the same pattern
}
```

---

## 8. Claude Code Skill Integration

A Claude Code skill wraps the CLI tools for use in agentic workflows:

```bash
# .claude/skills/browser.md

## Using the browser console bridge

Execute JavaScript in the browser:
$ bcb-exec 'document.title'

Read console errors:
$ bcb-console --levels error --since 60s

List open tabs:
$ bcb-tabs

Check if the server is running:
$ bcb-server-status
```

The CLI tools return structured output (JSON on stdout, errors on stderr, meaningful exit codes) so Claude Code can parse results and act on them.

---

## 9. Configuration Summary

All configuration is via environment variables with sensible defaults:

| Variable                | Default                  | Description                              |
|-------------------------|--------------------------|------------------------------------------|
| `BCB_HTTP_PORT`         | `18080`                  | HTTP API port                            |
| `BCB_WS_PORT`           | `18081`                  | WebSocket port for extension             |
| `BCB_HOST`              | `localhost`              | Bind address                             |
| `BCB_TIMEOUT`           | `30`                     | Default command timeout (seconds)        |
| `BCB_LOG_LEVEL`         | `INFO`                   | Server log level                         |
| `BCB_SCREENSHOT_DIR`    | `/tmp/bcb-screenshots`   | Default directory for CLI-saved screenshots |
| `BCB_SCREENSHOT_MAX_AGE`| `24h`                    | Auto-cleanup age threshold               |

---

## 10. Project File Structure

```
browser-console-bridge/
    bin/
        bcb-server-start      # Start server in tmux
        bcb-server-stop       # Stop server
        bcb-server-restart    # Restart server
        bcb-server-status     # Check server health
    server/
        __init__.py
        main.py               # Entry point
        http_handler.py       # REST endpoint handler
        ws_handler.py         # WebSocket connection manager
        queue.py              # Pending command queue
        config.py             # Configuration from env vars
    cli/
        __init__.py
        client.py             # BcbClient class (stdlib only)
        bcb_exec.py           # Execute JS command
        bcb_console.py        # Read console output command
        bcb_tabs.py           # List tabs command
    extension/
        manifest.json         # Chrome extension manifest (MV3)
        background.js         # Service worker: WebSocket + command dispatch
        content.js            # Content script: console capture injection
    docs/
        message-queue-design.md   # This document
    requirements.txt          # Server deps: websockets
    setup.py                  # Package with console_scripts entry points
```

---

## 11. Sequence Diagrams

### Happy Path: Execute JS

```
CLI                    Server                   Extension
 |                       |                         |
 |  POST /command        |                         |
 |  {execute_js, code}   |                         |
 |---------------------->|                         |
 |                       |  WS: {execute_js, code} |
 |                       |------------------------>|
 |                       |                         | chrome.scripting
 |                       |                         | .executeScript()
 |                       |  WS: {result, value}    |
 |                       |<------------------------|
 |  HTTP 200             |                         |
 |  {result, value}      |                         |
 |<----------------------|                         |
```

### Error: No Extension

```
CLI                    Server
 |                       |
 |  POST /command        |
 |  {execute_js, code}   |
 |---------------------->|
 |                       |  extension_ws is None
 |  HTTP 200             |
 |  {success: false,     |
 |   code: NO_EXTENSION} |
 |<----------------------|
```

### Error: Timeout

```
CLI                    Server                   Extension
 |                       |                         |
 |  POST /command        |                         |
 |  {execute_js, code}   |                         |
 |---------------------->|                         |
 |                       |  WS: {execute_js, code} |
 |                       |------------------------>|
 |                       |                         | (no response)
 |                       |  event.wait() expires   |
 |  HTTP 200             |                         |
 |  {success: false,     |                         |
 |   code: TIMEOUT}      |                         |
 |<----------------------|                         |
```

### Happy Path: Screenshot

```
CLI                    Server                   Extension
 |                       |                         |
 |  POST /command        |                         |
 |  {screenshot}         |                         |
 |---------------------->|                         |
 |                       |  WS: {screenshot}       |
 |                       |------------------------>|
 |                       |                         | captureVisibleTab()
 |                       |                         | base64 encode
 |                       |  WS: {image_data}       |
 |                       |<------------------------|
 |  HTTP 200             |                         |
 |  {image_data: "..."}  |                         |
 |<----------------------|                         |
 |                                                 |
 | base64 decode                                   |
 | write to disk                                   |
 | stdout: file path                               |
```

---

## 12. Implementation Priority

Build in this order, testing each layer before moving on:

1. **Server queue + HTTP handler** -- POST/GET with in-memory queue, mock responses (no extension yet). Verify that concurrent requests each get their own response and timeouts work.

2. **Server WebSocket handler** -- Accept extension connections, forward commands, route responses. Test with a simple WebSocket client script standing in for the extension.

3. **CLI client + tools** -- `BcbClient` class and the three CLI entry points. Test against the server with the mock WebSocket client.

4. **Browser extension** -- Manifest, service worker with WebSocket connection, `chrome.scripting.executeScript` for JS execution, `chrome.debugger` API for console capture.

5. **Tmux scripts** -- Server lifecycle management.

6. **Claude Code skill** -- Skill file referencing the CLI tools.
