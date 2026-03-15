// Browser Console Bridge - Service Worker (background.js)
// Maintains WebSocket to server, dispatches commands to tabs.

const WS_URL = 'ws://localhost:18081';
const KEEPALIVE_MS = 20_000;
const MAX_RECONNECT_MS = 30_000;

let ws = null;
let reconnectDelay = 1000;
let keepaliveTimer = null;

// Console entries received from content scripts, keyed by tab ID.
// Each value is an array of {level, ts, content, source} objects.
const consoleBuffers = new Map();
const MAX_BUFFER_PER_TAB = 500;

// --- Top-level listeners (required for service worker restart) ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'console_entry' && sender.tab) {
    bufferConsoleEntry(sender.tab.id, message.data);
  }
  // Return false = synchronous (no async sendResponse needed here)
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[BCB] Extension installed');
  connectWebSocket();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[BCB] Browser started');
  connectWebSocket();
});

// Also connect immediately when the service worker script loads
// (handles the case where the worker restarts after being idle).
connectWebSocket();

// --- WebSocket connection ---

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    console.warn('[BCB] WebSocket constructor failed:', e.message);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[BCB] Connected to server');
    reconnectDelay = 1000;
    startKeepalive();
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      console.warn('[BCB] Bad message from server:', e.message);
      return;
    }
    handleCommand(msg);
  };

  ws.onclose = () => {
    console.log(`[BCB] Disconnected. Reconnecting in ${reconnectDelay}ms`);
    cleanup();
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.warn('[BCB] WebSocket error');
    // onclose will fire after this
  };
}

function cleanup() {
  ws = null;
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

function scheduleReconnect() {
  setTimeout(() => connectWebSocket(), reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
}

function startKeepalive() {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'keepalive', ts: Date.now() / 1000 }));
    } else {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }, KEEPALIVE_MS);
}

// --- Command dispatch ---

async function handleCommand(msg) {
  let result;
  try {
    switch (msg.type) {
      case 'execute_js':
        result = await handleExecuteJs(msg);
        break;
      case 'read_console':
        result = await handleReadConsole(msg);
        break;
      case 'clear_console':
        result = await handleClearConsole(msg);
        break;
      case 'list_tabs':
        result = await handleListTabs(msg);
        break;
      case 'screenshot':
        result = await handleScreenshot(msg);
        break;
      default:
        result = makeError(msg, `unknown command type: ${msg.type}`);
    }
  } catch (e) {
    result = {
      type: `${msg.type}_result`,
      msg_id: msg.msg_id,
      ts: Date.now() / 1000,
      success: false,
      result: null,
      error: e.message || String(e),
    };
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(result));
  }
}

// --- Resolve target tab ---

async function resolveTabId(tabId) {
  if (tabId != null) return tabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('no active tab found');
  return tab.id;
}

// --- execute_js ---

async function handleExecuteJs(msg) {
  const tabId = await resolveTabId(msg.tab_id);

  // Try CDP first (bypasses CSP), fall back to eval if debugger can't attach
  try {
    return await executeViaCdp(tabId, msg);
  } catch (cdpError) {
    console.warn('[BCB] CDP execution failed, falling back to eval:', cdpError.message);
    return await executeViaEval(tabId, msg);
  }
}

async function executeViaCdp(tabId, msg) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    // Another debugger may already be attached — let caller fall back
    throw new Error(`debugger attach failed: ${e.message}`);
  }
  try {
    const response = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: msg.code,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) {
      const errMsg = response.exceptionDetails.exception?.description
        || response.exceptionDetails.text
        || 'Runtime.evaluate exception';
      return {
        type: 'execute_js_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
        success: false, result: null, error: errMsg,
      };
    }
    return {
      type: 'execute_js_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
      success: true, result: response.result?.value ?? null, error: null,
    };
  } finally {
    try { await chrome.debugger.detach(target); } catch { /* already detached */ }
  }
}

async function executeViaEval(tabId, msg) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (codeString) => {
      try {
        // eslint-disable-next-line no-eval
        const rv = eval(codeString);
        try { return JSON.parse(JSON.stringify(rv)); } catch { return String(rv); }
      } catch (e) {
        throw e;
      }
    },
    args: [msg.code],
    world: 'MAIN',
  });
  const injectionResult = results[0];
  if (injectionResult.error) {
    const errMsg = injectionResult.error.message || JSON.stringify(injectionResult.error);
    return {
      type: 'execute_js_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
      success: false, result: null, error: errMsg,
    };
  }
  return {
    type: 'execute_js_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
    success: true, result: injectionResult.result ?? null, error: null,
  };
}

// --- read_console ---

async function handleReadConsole(msg) {
  const tabId = await resolveTabId(msg.tab_id);

  // Ask the content script for any entries not yet forwarded to the background.
  // Use the latest ts already buffered as a floor so we don't re-add duplicates.
  try {
    const existing = consoleBuffers.get(tabId) || [];
    const latestTs = existing.length ? existing[existing.length - 1].ts : 0;
    const csEntries = await chrome.tabs.sendMessage(tabId, {
      type: 'get_console_buffer',
      since: latestTs || null,
      levels: null,
    });
    if (Array.isArray(csEntries)) {
      for (const entry of csEntries) {
        if (entry.ts > latestTs) {
          bufferConsoleEntry(tabId, entry);
        }
      }
    }
  } catch {
    // Content script may not be ready; that is fine, use what we have
  }

  let entries = consoleBuffers.get(tabId) || [];

  // Filter by timestamp
  if (msg.since) {
    entries = entries.filter(e => e.ts > msg.since);
  }

  // Filter by levels
  if (msg.levels && Array.isArray(msg.levels)) {
    const levelSet = new Set(msg.levels);
    entries = entries.filter(e => levelSet.has(e.level));
  }

  // Apply limit
  const limit = msg.limit || 100;
  entries = entries.slice(-limit);

  return {
    type: 'read_console_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
    success: true, entries, error: null,
  };
}

// --- clear_console ---

async function handleClearConsole(msg) {
  const tabId = await resolveTabId(msg.tab_id);

  // Clear the service worker buffer for this tab
  consoleBuffers.delete(tabId);

  // Also tell the content script to clear its buffer
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'clear_console_buffer' });
  } catch {
    // Content script may not be ready; that is fine
  }

  return {
    type: 'clear_console_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
    success: true, error: null,
  };
}

// --- list_tabs ---

async function handleListTabs(msg) {
  const tabs = await chrome.tabs.query({});
  const tabList = tabs.map(t => ({
    id: t.id,
    url: t.url || '',
    title: t.title || '',
    active: t.active,
  }));
  return {
    type: 'list_tabs_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
    success: true, tabs: tabList, error: null,
  };
}

// --- screenshot ---

async function handleScreenshot(msg) {
  // captureVisibleTab captures the active tab's visible area in the focused window
  const format = msg.format === 'jpeg' ? 'jpeg' : 'png';
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format });
  // Strip the data URL prefix: "data:image/png;base64," -> raw base64
  const base64 = dataUrl.replace(/^data:image\/[a-z]+;base64,/, '');
  return {
    type: 'screenshot_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
    success: true, image_data: base64, format, error: null,
  };
}

// --- Console buffering ---

function bufferConsoleEntry(tabId, entry) {
  if (!consoleBuffers.has(tabId)) {
    consoleBuffers.set(tabId, []);
  }
  const buf = consoleBuffers.get(tabId);
  buf.push(entry);
  // Trim to max size
  if (buf.length > MAX_BUFFER_PER_TAB) {
    buf.splice(0, buf.length - MAX_BUFFER_PER_TAB);
  }
}

// --- Helpers ---

function makeError(msg, errorText) {
  return {
    type: 'error', msg_id: msg.msg_id, ts: Date.now() / 1000,
    success: false, error: errorText,
  };
}
