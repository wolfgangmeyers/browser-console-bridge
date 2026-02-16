# Browser Extension Development Research

Research into Chrome (and Firefox) extension development under Manifest V3, focused on
building an extension that executes JavaScript in the active tab, captures console output,
and communicates results to a local Python server.

---

## Table of Contents

1. [Manifest V3 Fundamentals](#1-manifest-v3-fundamentals)
2. [Executing Arbitrary JavaScript in a Page Context](#2-executing-arbitrary-javascript-in-a-page-context)
3. [Capturing Console Output](#3-capturing-console-output)
4. [Communication Patterns Within Extensions](#4-communication-patterns-within-extensions)
5. [Communicating with External Servers](#5-communicating-with-external-servers)
6. [Recommended Architecture](#6-recommended-architecture)

---

## 1. Manifest V3 Fundamentals

Manifest V3 (MV3) is the current required standard for new Chrome extensions. Google has
deprecated Manifest V2 and all new submissions to the Chrome Web Store must use MV3.

### 1.1 Manifest File Structure

A minimal MV3 manifest looks like this:

```json
{
  "manifest_version": 3,
  "name": "Browser Console Bridge",
  "version": "1.0",
  "description": "Execute JS and capture console output",
  "minimum_chrome_version": "116",
  "permissions": [
    "activeTab",
    "scripting"
  ],
  "host_permissions": [
    "<all_urls>"
  ],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"]
    }
  ],
  "action": {
    "default_title": "Browser Console Bridge"
  }
}
```

### 1.2 Service Workers (Background Scripts)

In MV3, persistent background pages are replaced by **service workers**. Key characteristics:

- **No DOM access.** Service workers cannot interact with the DOM directly. All DOM
  manipulation must happen through content scripts or injected scripts.
- **Event-driven lifecycle.** The service worker starts when an event fires and shuts down
  after approximately 30 seconds of inactivity. There is no persistent state in memory.
- **No `setTimeout`/`setInterval` reliability.** Timers are cancelled when the service
  worker terminates. Use the `chrome.alarms` API for scheduled work, or WebSocket
  keepalives (see Section 5).
- **No global variables for state.** Use `chrome.storage.local` or `chrome.storage.session`
  instead of in-memory globals, since the worker can restart at any time.
- **ES module support.** Declare `"type": "module"` in the manifest to use `import`
  statements within the service worker.
- **Top-level event registration is required.** All `chrome.*.addListener()` calls must
  happen synchronously at the top level of the service worker script. If listeners are
  registered inside async callbacks, they will be missed when the worker restarts.

```javascript
// background.js - service worker
// Register listeners at top level (required)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // handle messages from content scripts
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('Extension installed');
});
```

### 1.3 Content Scripts

Content scripts are JavaScript files injected into web pages. They run in an **isolated
world** -- they share the DOM with the page but have their own JavaScript execution
environment.

**Capabilities:**
- Full access to the page DOM (read and modify)
- Access to a limited set of Chrome APIs: `chrome.runtime`, `chrome.storage`, `chrome.i18n`
- Can communicate with the service worker via message passing

**Limitations:**
- Cannot access the page's JavaScript variables, functions, or objects
- Cannot call page-defined functions directly
- Cannot access most Chrome extension APIs (no `chrome.tabs`, `chrome.scripting`, etc.)
- Run in an isolated world: `window` and global objects are separate from the page's

Content scripts can be declared statically in the manifest or injected dynamically:

```javascript
// Static declaration in manifest.json
"content_scripts": [{
  "matches": ["<all_urls>"],
  "js": ["content.js"],
  "run_at": "document_idle"
}]

// Dynamic injection from service worker
chrome.scripting.registerContentScripts([{
  id: "my-content-script",
  matches: ["<all_urls>"],
  js: ["content.js"],
  runAt: "document_idle"
}]);
```

### 1.4 Permissions Model

MV3 separates permissions into distinct categories:

**`permissions` array** -- Non-host API permissions:
- `activeTab` -- Temporary access to the active tab when the user invokes the extension
  (click, keyboard shortcut, etc.). Grants host permission for the tab's origin only for
  that invocation. This is the least-privilege way to get tab access.
- `scripting` -- Required for `chrome.scripting.executeScript()` and related methods.
- `debugger` -- Required for `chrome.debugger` API (CDP access).
- `nativeMessaging` -- Required for communicating with native applications via stdin/stdout.
- `storage` -- Access to `chrome.storage` API.
- `tabs` -- Access to `url` and `title` properties on `Tab` objects.

**`host_permissions` array** -- URL patterns the extension can interact with:
- `<all_urls>` -- Access to all URLs (triggers a permission warning during install).
- `http://localhost/*` -- Access to localhost only.
- Specific patterns like `https://*.example.com/*`.

**Key distinction:** `activeTab` grants temporary host permission on user gesture without
requiring broad `host_permissions`. For an extension that executes scripts on demand, using
`activeTab` + `scripting` is the minimal permission set. However, if the extension needs to
inject scripts without a user gesture (e.g., automatically on page load), `host_permissions`
with specific URL patterns are needed instead.

### 1.5 Cross-Browser Compatibility: Chrome vs Firefox

Firefox supports MV3 but with significant differences:

| Feature | Chrome | Firefox |
|---|---|---|
| Background scripts | Service workers only | Event pages (non-persistent background scripts). Firefox does **not** support service workers for extensions. |
| `browser_specific_settings` | Ignored (safe to include) | Required for specifying `gecko.id` |
| Host permissions | Granted at install | Treated as optional; user must grant |
| `webRequest` blocking | Removed; use `declarativeNetRequest` | Still supports blocking `webRequest` alongside `declarativeNetRequest` |
| `chrome.*` namespace | Primary | Supports both `browser.*` (with promises) and `chrome.*` (with callbacks) |
| Action API | Unified `action` only | Retains separate `page_action` support |
| `chrome.scripting` world: "MAIN" | Supported | Supported (Firefox 128+) |

**For cross-browser code**, use the `browser.*` namespace with promises where possible, or
use a polyfill like `webextension-polyfill`. Include `browser_specific_settings` in the
manifest for Firefox without affecting Chrome:

```json
{
  "browser_specific_settings": {
    "gecko": {
      "id": "console-bridge@example.com",
      "strict_min_version": "128.0"
    }
  }
}
```

---

## 2. Executing Arbitrary JavaScript in a Page Context

There are several approaches to run JavaScript in a tab's page context, each with different
tradeoffs.

### 2.1 `chrome.scripting.executeScript` API

This is the primary MV3 API for injecting and executing JavaScript in a tab. It must be
called from the service worker (or extension pages), not from content scripts.

**Required permissions:** `scripting` + either `activeTab` or appropriate `host_permissions`.

#### Basic usage -- injecting a function:

```javascript
// background.js (service worker)
async function executeInTab(tabId, code) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: (codeString) => {
      // This runs in the page context if world is MAIN
      return eval(codeString);
    },
    args: [code],
    world: 'MAIN'  // Execute in the page's JS context
  });
  return results[0]?.result;
}
```

#### Execution Worlds: MAIN vs ISOLATED

The `world` parameter controls the execution environment:

**`ISOLATED` (default):**
- Runs in the content script's isolated world
- Shares the DOM but has a separate `window` object and JS globals
- Cannot access page-defined variables or functions
- Has access to `chrome.runtime` for messaging back to the service worker
- Safer; the page cannot interfere with the injected code

**`MAIN`:**
- Runs in the page's actual JavaScript context
- Full access to page-defined variables, functions, and objects
- Can call page APIs (e.g., frameworks like React, page-specific JS)
- The page can see and interfere with injected code
- No access to Chrome extension APIs
- Essential for monkey-patching page-level objects like `console`

#### Return values and serialization:

```javascript
const results = await chrome.scripting.executeScript({
  target: { tabId },
  func: () => {
    return { title: document.title, url: location.href };
  },
  world: 'MAIN'
});

// results is an array of InjectionResult objects:
// [{ documentId: "...", frameId: 0, result: { title: "...", url: "..." } }]
const returnValue = results[0].result;
```

Return values must be JSON-serializable. Functions, DOM elements, and circular references
cannot be returned directly.

#### Injecting into specific frames:

```javascript
chrome.scripting.executeScript({
  target: {
    tabId: tabId,
    frameIds: [0]  // Main frame only; or specify other frame IDs
  },
  func: myFunction,
  args: [arg1, arg2]
});
```

### 2.2 Content Script Injection

Content scripts can also inject code into the page's `MAIN` world by creating a `<script>`
element:

```javascript
// content.js
function injectIntoPageContext(code) {
  const script = document.createElement('script');
  script.textContent = code;
  (document.head || document.documentElement).appendChild(script);
  script.remove();  // Clean up after execution
}

// Inject a function definition into the page
injectIntoPageContext(`
  window.__capturedConsoleLogs = [];
  const originalLog = console.log;
  console.log = function(...args) {
    window.__capturedConsoleLogs.push({ level: 'log', args: args });
    originalLog.apply(console, args);
  };
`);
```

This approach is older and has some downsides:
- Requires the page's Content Security Policy (CSP) to allow inline scripts. Many sites
  have restrictive CSPs that block this.
- `chrome.scripting.executeScript` with `world: 'MAIN'` bypasses CSP restrictions and is
  the preferred MV3 approach.

### 2.3 `chrome.debugger` API (CDP Access)

The `chrome.debugger` API provides access to the Chrome DevTools Protocol (CDP), which is
the most powerful approach for interacting with a page.

**Required permission:** `debugger`

**User-visible warning:** When the debugger is attached, Chrome shows a yellow banner at the
top of the page saying "Extension is debugging this browser." This cannot be suppressed and
is a significant UX drawback.

#### Attaching and evaluating JavaScript:

```javascript
// background.js (service worker)
const target = { tabId: tabId };

// Attach the debugger
await chrome.debugger.attach(target, '1.3');

// Enable the Runtime domain
await chrome.debugger.sendCommand(target, 'Runtime.enable');

// Evaluate JavaScript in the page context
const result = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
  expression: 'document.title',
  returnByValue: true
});
// result.result.value contains the evaluated value

// Detach when done
await chrome.debugger.detach(target);
```

#### Advantages of the debugger approach:
- Full CDP access: can evaluate JS, intercept network requests, capture console output,
  access performance data, and much more
- Captures console output natively via `Runtime.consoleAPICalled` events
- Can evaluate expressions with `await` using `awaitPromise: true`
- Can access objects by reference (not just serialized values)

#### Disadvantages:
- The "debugging this browser" banner is always visible and cannot be hidden
- Only one debugger can be attached per tab (conflicts with DevTools being open)
- More complex API surface than `chrome.scripting`

### 2.4 Comparison of Approaches

| Feature | `chrome.scripting` (MAIN) | `chrome.debugger` (CDP) |
|---|---|---|
| Permission | `scripting` + host | `debugger` |
| CSP bypass | Yes | Yes |
| User-visible indicator | None | Yellow "debugging" banner |
| Console capture | Requires monkey-patching | Native via CDP events |
| Return values | JSON-serializable only | Object references supported |
| Complexity | Low | High |
| Conflicts with DevTools | No | Yes (only one debugger per tab) |
| Promise await support | Manual wrapping needed | Built-in `awaitPromise` |

**Recommendation:** Use `chrome.scripting.executeScript` with `world: 'MAIN'` for executing
JavaScript, and monkey-patch `console` for output capture. Reserve `chrome.debugger` for
cases where richer introspection is needed and the debugging banner is acceptable.

---

## 3. Capturing Console Output

### 3.1 Monkey-Patching Console Methods (Page Context)

The most practical approach is to override `console.log`, `console.warn`, `console.error`,
and related methods in the page's `MAIN` world.

```javascript
// Injected into the page via chrome.scripting.executeScript with world: 'MAIN'
function installConsoleCapture() {
  // Avoid double-installation
  if (window.__consoleBridgeInstalled) return;
  window.__consoleBridgeInstalled = true;

  const methods = ['log', 'warn', 'error', 'info', 'debug', 'trace', 'table'];
  const originalConsole = {};

  methods.forEach(method => {
    originalConsole[method] = console[method].bind(console);
    console[method] = function(...args) {
      // Serialize arguments for transport
      const serializedArgs = args.map(arg => {
        try {
          if (arg instanceof Error) {
            return {
              type: 'error',
              message: arg.message,
              stack: arg.stack,
              name: arg.name
            };
          }
          if (typeof arg === 'function') {
            return { type: 'function', value: arg.toString() };
          }
          if (arg instanceof HTMLElement) {
            return { type: 'element', value: arg.outerHTML.substring(0, 500) };
          }
          // Attempt JSON serialization with circular reference handling
          return { type: typeof arg, value: JSON.parse(JSON.stringify(arg)) };
        } catch (e) {
          return { type: typeof arg, value: String(arg) };
        }
      });

      // Dispatch a custom event to communicate with the content script
      window.dispatchEvent(new CustomEvent('__consoleBridge', {
        detail: {
          method: method,
          args: serializedArgs,
          timestamp: Date.now()
        }
      }));

      // Call the original method so the console still works normally
      originalConsole[method].apply(console, args);
    };
  });

  // Also capture console.clear
  const originalClear = console.clear.bind(console);
  console.clear = function() {
    window.dispatchEvent(new CustomEvent('__consoleBridge', {
      detail: { method: 'clear', args: [], timestamp: Date.now() }
    }));
    originalClear();
  };
}
```

### 3.2 Capturing Uncaught Exceptions and Promise Rejections

Beyond console methods, page errors should also be captured:

```javascript
// Also injected into MAIN world
function installErrorCapture() {
  // Uncaught synchronous errors
  window.addEventListener('error', (event) => {
    window.dispatchEvent(new CustomEvent('__consoleBridge', {
      detail: {
        method: 'uncaughtError',
        args: [{
          type: 'error',
          message: event.message,
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          stack: event.error?.stack || null
        }],
        timestamp: Date.now()
      }
    }));
  });

  // Unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    window.dispatchEvent(new CustomEvent('__consoleBridge', {
      detail: {
        method: 'unhandledRejection',
        args: [{
          type: 'error',
          message: reason?.message || String(reason),
          stack: reason?.stack || null
        }],
        timestamp: Date.now()
      }
    }));
  });
}
```

### 3.3 Communication Bridge: MAIN World to Content Script

Since code in the `MAIN` world cannot use Chrome extension APIs, it must communicate with
the content script through DOM events. The content script (running in `ISOLATED` world)
listens for these events and forwards them to the service worker:

```javascript
// content.js (ISOLATED world) - receives events from the MAIN world
window.addEventListener('__consoleBridge', (event) => {
  // Forward to the service worker
  chrome.runtime.sendMessage({
    type: 'consoleOutput',
    data: event.detail
  });
});
```

This is the standard pattern:
1. **MAIN world** monkey-patches console, dispatches `CustomEvent` on `window`
2. **Content script (ISOLATED)** listens for the custom event, calls `chrome.runtime.sendMessage()`
3. **Service worker** receives the message via `chrome.runtime.onMessage`

### 3.4 Using `chrome.debugger` for Console Capture (Alternative)

The CDP approach captures console output without any monkey-patching:

```javascript
// background.js (service worker)
const target = { tabId: tabId };

await chrome.debugger.attach(target, '1.3');
await chrome.debugger.sendCommand(target, 'Runtime.enable');

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== tabId) return;

  if (method === 'Runtime.consoleAPICalled') {
    // params.type: 'log', 'warn', 'error', 'info', 'debug', etc.
    // params.args: array of RemoteObject values
    // params.stackTrace: stack trace if available
    // params.timestamp: epoch timestamp
    const entry = {
      method: params.type,
      args: params.args.map(arg => {
        if (arg.type === 'string') return arg.value;
        if (arg.type === 'number') return arg.value;
        if (arg.type === 'boolean') return arg.value;
        if (arg.type === 'undefined') return undefined;
        if (arg.type === 'object' && arg.value) return arg.value;
        if (arg.description) return arg.description;
        return String(arg.value);
      }),
      timestamp: params.timestamp,
      stackTrace: params.stackTrace
    };
    // Process the console entry...
  }

  if (method === 'Runtime.exceptionThrown') {
    // params.exceptionDetails contains full error information
    // including lineNumber, columnNumber, stackTrace, exception object
    const details = params.exceptionDetails;
    // Process the exception...
  }
});
```

**CDP advantages for console capture:**
- Captures output from all contexts (page, iframes, web workers)
- Provides full stack traces with source mapping information
- Preserves object references (can be inspected further with `Runtime.getProperties`)
- Captures exceptions that monkey-patching might miss
- No risk of being detected or circumvented by the page

### 3.5 Object Serialization Considerations

Console arguments can contain complex objects. Serialization strategies:

- **Primitive values** (string, number, boolean, null, undefined): pass directly.
- **Plain objects and arrays**: use `JSON.stringify()` with a depth limit or replacer to
  handle circular references.
- **Error objects**: extract `message`, `name`, and `stack` properties.
- **DOM elements**: use `outerHTML` (truncated) or a tag summary like `<div class="foo">`.
- **Functions**: use `toString()` to get the source.
- **Symbols, WeakMaps, Proxies**: convert to a string description.

A safe serializer with depth limiting:

```javascript
function safeSerialize(obj, maxDepth = 3, currentDepth = 0) {
  if (currentDepth >= maxDepth) return '[max depth reached]';
  if (obj === null) return null;
  if (obj === undefined) return undefined;

  const type = typeof obj;
  if (type === 'string' || type === 'number' || type === 'boolean') return obj;
  if (type === 'function') return `[Function: ${obj.name || 'anonymous'}]`;
  if (type === 'symbol') return obj.toString();

  if (obj instanceof Error) {
    return { __type: 'Error', name: obj.name, message: obj.message, stack: obj.stack };
  }

  if (Array.isArray(obj)) {
    return obj.slice(0, 100).map(item => safeSerialize(item, maxDepth, currentDepth + 1));
  }

  if (type === 'object') {
    const result = {};
    const keys = Object.keys(obj).slice(0, 50);
    for (const key of keys) {
      try {
        result[key] = safeSerialize(obj[key], maxDepth, currentDepth + 1);
      } catch (e) {
        result[key] = '[unserializable]';
      }
    }
    return result;
  }

  return String(obj);
}
```

---

## 4. Communication Patterns Within Extensions

### 4.1 One-Time Messages: `sendMessage` / `onMessage`

The simplest messaging pattern. Suitable for request-response interactions.

**Content script to service worker:**

```javascript
// content.js
chrome.runtime.sendMessage(
  { type: 'consoleOutput', data: { method: 'log', args: ['hello'] } },
  (response) => {
    // Optional: handle response from service worker
    console.log('Acknowledged:', response);
  }
);

// Or with promises (MV3 supports this natively):
const response = await chrome.runtime.sendMessage({
  type: 'consoleOutput',
  data: { method: 'log', args: ['hello'] }
});
```

**Service worker receiving messages:**

```javascript
// background.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'consoleOutput') {
    // sender.tab contains the Tab object of the sending content script
    const tabId = sender.tab.id;
    processConsoleOutput(tabId, message.data);
    sendResponse({ status: 'received' });
  }
  // Return true if sendResponse will be called asynchronously
  return true;
});
```

**Service worker to content script:**

```javascript
// background.js - sending to a specific tab's content script
chrome.tabs.sendMessage(tabId, { type: 'executeCode', code: 'console.log("hi")' });
```

### 4.2 Long-Lived Connections: `connect` / `onConnect`

Port-based connections are better for high-frequency messaging (e.g., streaming console
output). The connection stays open until explicitly closed or the other end disconnects.

**Content script opens a port:**

```javascript
// content.js
const port = chrome.runtime.connect({ name: 'console-bridge' });

port.onMessage.addListener((message) => {
  if (message.type === 'executeCode') {
    // Execute the code
  }
});

port.onDisconnect.addListener(() => {
  console.log('Disconnected from service worker');
});

// Send console output over the port
function sendConsoleEntry(entry) {
  port.postMessage({ type: 'consoleOutput', data: entry });
}
```

**Service worker accepts the port:**

```javascript
// background.js
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'console-bridge') return;

  const tabId = port.sender.tab.id;
  console.log(`Console bridge connected for tab ${tabId}`);

  port.onMessage.addListener((message) => {
    if (message.type === 'consoleOutput') {
      forwardToServer(tabId, message.data);
    }
  });

  port.onDisconnect.addListener(() => {
    console.log(`Tab ${tabId} disconnected`);
  });

  // Send commands to the content script
  port.postMessage({ type: 'startCapture' });
});
```

**Advantages of port-based connections:**
- Lower overhead per message (no need to re-establish routing each time)
- Immediate notification when the other side disconnects (`onDisconnect`)
- Bidirectional communication over a single channel
- Can name ports to distinguish different communication channels

### 4.3 Native Messaging

For communicating directly with a local program (e.g., a Python server) via stdin/stdout.
This is a first-class extension API -- no network stack involved.

**Extension manifest permission:**

```json
"permissions": ["nativeMessaging"]
```

**Native messaging host manifest** (e.g., `com.example.console_bridge.json`):

```json
{
  "name": "com.example.console_bridge",
  "description": "Console Bridge Native Host",
  "path": "/absolute/path/to/python_host.py",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://YOUR_EXTENSION_ID_HERE/"
  ]
}
```

**Host manifest location on Linux:**
- Chrome: `~/.config/google-chrome/NativeMessagingHosts/com.example.console_bridge.json`
- Chromium: `~/.config/chromium/NativeMessagingHosts/com.example.console_bridge.json`

**Communication protocol:**
- Each message is JSON, UTF-8 encoded
- Preceded by a 32-bit message length in native byte order (little-endian on x86)
- Max message from host to extension: 1 MB
- Max message from extension to host: 64 MiB

**Extension side -- persistent connection:**

```javascript
// background.js (service worker)
const nativePort = chrome.runtime.connectNative('com.example.console_bridge');

nativePort.onMessage.addListener((response) => {
  console.log('From native host:', response);
});

nativePort.onDisconnect.addListener(() => {
  console.log('Native host disconnected');
  if (chrome.runtime.lastError) {
    console.error('Error:', chrome.runtime.lastError.message);
  }
});

// Send a message
nativePort.postMessage({ type: 'consoleOutput', data: { ... } });
```

**Extension side -- one-time message:**

```javascript
chrome.runtime.sendNativeMessage(
  'com.example.console_bridge',
  { type: 'execute', code: 'print("hello")' },
  (response) => {
    console.log('Response:', response);
  }
);
```

**Python native messaging host:**

```python
#!/usr/bin/env python3
import sys
import json
import struct

def read_message():
    """Read a message from stdin following the native messaging protocol."""
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    length = struct.unpack('<I', raw_length)[0]
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode('utf-8'))

def send_message(message):
    """Send a message to stdout following the native messaging protocol."""
    encoded = json.dumps(message).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()

def main():
    while True:
        message = read_message()
        if message is None:
            break
        # Process the message and send a response
        response = {'status': 'ok', 'received': message}
        send_message(response)

if __name__ == '__main__':
    main()
```

**Important notes:**
- The Python script must be executable (`chmod +x`)
- Must include a shebang line (`#!/usr/bin/env python3`)
- All debug output must go to `stderr`; `stdout` is reserved for the protocol
- The native host is started as a separate process by Chrome
- With `connectNative`, the process persists; with `sendNativeMessage`, a new process is
  spawned per call and only the first response is returned

### 4.4 Messaging Flow Summary

```
Page (MAIN world)
    |
    |  window.dispatchEvent(CustomEvent)
    v
Content Script (ISOLATED world)
    |
    |  chrome.runtime.sendMessage()  or  port.postMessage()
    v
Service Worker (background.js)
    |
    |  WebSocket / HTTP fetch / nativePort.postMessage()
    v
Local Python Server
```

---

## 5. Communicating with External Servers

Three main approaches for getting data from the extension to a local Python server.

### 5.1 HTTP Requests to Localhost

The service worker (or content scripts) can make HTTP requests to a local server.

```javascript
// background.js (service worker)
async function sendToServer(data) {
  try {
    const response = await fetch('http://localhost:8765/api/console', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return await response.json();
  } catch (error) {
    console.error('Failed to reach local server:', error);
  }
}
```

**CORS considerations:**
- Requests from the **service worker** are not subject to CORS restrictions. The service
  worker operates outside the page context and its requests are treated as non-origin
  requests. This is the simplest approach.
- Requests from **content scripts** follow the page's CORS policy as of MV3. Prior to a
  Chrome security change, content scripts had their own origin. Now, content script fetches
  are treated as if they came from the page itself, so the server must set appropriate CORS
  headers or the request will fail.
- **Recommendation:** Always make HTTP requests from the **service worker**, not from
  content scripts. The content script should send messages to the service worker, which then
  makes the HTTP request.

**Server-side CORS headers (if needed for content script requests):**

```python
# Python server (e.g., Flask)
@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'  # Or specific extension origin
    response.headers['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return response
```

**Host permission required in manifest:**

```json
"host_permissions": ["http://localhost/*"]
```

Or, if using a specific port: `"http://localhost:8765/*"`

### 5.2 WebSocket Connections

WebSockets provide a persistent bidirectional channel, ideal for streaming console output
and receiving execution commands in real time.

```javascript
// background.js (service worker)
let ws = null;

function connectWebSocket() {
  ws = new WebSocket('ws://localhost:8765');

  ws.onopen = () => {
    console.log('Connected to local server');
    keepAlive();
  };

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'execute') {
      executeInActiveTab(message.code);
    }
  };

  ws.onclose = () => {
    console.log('WebSocket closed, reconnecting...');
    ws = null;
    // Reconnect after a delay
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
}

function keepAlive() {
  const interval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'keepalive' }));
    } else {
      clearInterval(interval);
    }
  }, 20_000);  // Every 20 seconds, under the 30s service worker timeout
}

function sendConsoleOutput(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'consoleOutput', data }));
  }
}
```

**Service worker keepalive (critical):**
- Chrome terminates the service worker after 30 seconds of inactivity
- Since Chrome 116, WebSocket activity resets the 30-second idle timer
- Sending a keepalive message every 20 seconds prevents termination
- The keepalive can be initiated from either the extension or the server
- Set `"minimum_chrome_version": "116"` in the manifest to ensure this behavior

**Reconnection strategy:**
- The service worker may restart at any time; the WebSocket must reconnect
- Use `chrome.runtime.onStartup` and `chrome.runtime.onInstalled` to initiate connection
- Store connection state in `chrome.storage.session` if needed

### 5.3 Native Messaging (Alternative to Network)

As described in Section 4.3, native messaging communicates with a local program via
stdin/stdout without any network involvement.

**Advantages over HTTP/WebSocket:**
- No network stack; direct IPC through stdin/stdout
- No CORS issues
- No need to run a separate server process (Chrome manages the host process lifecycle)
- Simpler security model: communication is restricted to the specified extension ID

**Disadvantages:**
- Requires installing a native messaging host manifest on the user's system
- 1 MB message size limit (host to extension)
- The host process lifecycle is tied to the extension connection
- More complex setup (system-level file placement)
- Harder to share the host with other clients (only the extension can talk to it)

### 5.4 Security Considerations

**Localhost communication:**
- HTTP to `localhost` is unencrypted. Any local process can potentially intercept or
  impersonate the server.
- Consider adding a shared secret/token that the extension sends with each request and the
  server validates. Generate this token at server startup and pass it to the extension
  (e.g., via native messaging or a config file).
- WebSocket connections to `localhost` are also unencrypted (use `ws://`, not `wss://` for
  local development).

**Extension permissions:**
- Request minimal permissions. `activeTab` is preferred over broad `host_permissions` when
  user-initiated actions are sufficient.
- The `debugger` permission is powerful and shows a warning at install time.
- `<all_urls>` in `host_permissions` triggers a prominent permission warning.

**Code execution risks:**
- Executing arbitrary JavaScript in web pages (via `world: 'MAIN'`) means the page can
  observe and potentially interfere with injected code.
- If the extension executes code received from a local server, ensure the server is
  trustworthy. A compromised server could inject malicious code into any page.

**Content Security Policy (extension's own CSP):**
- MV3 extensions cannot use remotely hosted code. All JavaScript must be bundled with the
  extension.
- The `chrome.scripting.executeScript` API with `func` parameter is fine because the
  function is defined within the extension's own code. Passing a string and using `eval()`
  in the `MAIN` world works because the page's CSP (not the extension's) governs the `MAIN`
  world.

---

## 6. Recommended Architecture

For an extension that executes JavaScript snippets in the active tab, captures all console
output, and sends results to a local Python server, the recommended design is:

### Components

```
+-----------------------+     WebSocket (ws://localhost:8765)     +------------------+
|  Service Worker       | <------------------------------------> |  Python Server   |
|  (background.js)      |     - Receives JS to execute           |  (localhost)     |
|                       |     - Sends console output             |                  |
+-----------+-----------+     - Sends execution results          +------------------+
            |
            | chrome.runtime messages (or port)
            |
+-----------+-----------+
|  Content Script       |
|  (content.js)         |
|  - Listens for        |
|    CustomEvents from  |
|    MAIN world         |
|  - Forwards to SW     |
+-----------+-----------+
            |
            | window CustomEvent ('__consoleBridge')
            |
+-----------+-----------+
|  Page Context         |
|  (MAIN world)         |
|  - Monkey-patched     |
|    console methods    |
|  - Error handlers     |
|  - Executes snippets  |
+-----------------------+
```

### Flow for Executing JavaScript

1. Python server sends `{ type: "execute", code: "..." }` over WebSocket
2. Service worker receives the message
3. Service worker calls `chrome.scripting.executeScript()` with `world: 'MAIN'` on the
   active tab, wrapping the code to capture its return value
4. The result (or error) is sent back over WebSocket to the Python server

### Flow for Console Capture

1. On tab activation or navigation, service worker injects the console monkey-patch via
   `chrome.scripting.executeScript()` with `world: 'MAIN'`
2. Page code calls `console.log(...)`, which triggers the monkey-patch
3. Monkey-patch serializes arguments and dispatches a `CustomEvent` on `window`
4. Content script (ISOLATED world) receives the event, sends it to the service worker
   via `chrome.runtime.sendMessage()` or a port
5. Service worker forwards the console entry to the Python server over WebSocket

### Key Manifest Permissions

```json
{
  "permissions": ["activeTab", "scripting"],
  "host_permissions": ["http://localhost/*"]
}
```

If using native messaging instead of WebSocket:
```json
{
  "permissions": ["activeTab", "scripting", "nativeMessaging"]
}
```

If using the debugger API for console capture:
```json
{
  "permissions": ["debugger"]
}
```

### Decision: WebSocket vs Native Messaging vs HTTP

| Criterion | WebSocket | Native Messaging | HTTP |
|---|---|---|---|
| Bidirectional | Yes | Yes | No (polling needed) |
| Real-time | Yes | Yes | Depends on polling interval |
| Setup complexity | Low (server already needed) | Medium (host manifest + registration) | Low |
| Message size limit | Practical ~16 MB | 1 MB (host to ext) | No hard limit |
| Works without server | No | Yes (host is the server) | No |
| Multiple clients | Easy (server can serve many) | One extension per host process | Easy |

**Recommendation:** Use **WebSocket** for the primary communication channel. It is
bidirectional, real-time, straightforward to implement in both the extension service worker
and a Python server (using `asyncio` + `websockets` library), and has no system-level
registration requirements. The Python server can serve as both the WebSocket endpoint and the
application logic layer.

---

## Sources

- [Manifest V3 Overview - Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
- [Extension Service Worker Basics - Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/basics)
- [chrome.scripting API Reference - Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [chrome.debugger API Reference - Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Chrome DevTools Protocol - Runtime Domain](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/)
- [Native Messaging - Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Message Passing - Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
- [Use WebSockets in Service Workers - Chrome for Developers](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)
- [Declare Permissions - Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [The activeTab Permission - Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Firefox MV3 Migration Guide - Extension Workshop](https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/)
- [scripting.executeScript() - MDN Web Docs](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript)
- [Native Messaging - MDN Web Docs](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)
- [Changes to Cross-Origin Requests in Chrome Extension Content Scripts - Chromium](https://www.chromium.org/Home/chromium-security/extension-content-script-fetches/)
- [Chrome 116 WebSocket Support for Extensions - Chrome for Developers](https://developer.chrome.com/blog/chrome-116-beta-whats-new-for-extensions)
