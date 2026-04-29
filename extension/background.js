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
      case 'close_tabs':
        result = await handleCloseTabs(msg);
        break;
      case 'move_tabs':
        result = await handleMoveTabs(msg);
        break;
      case 'group_tabs':
        result = await handleGroupTabs(msg);
        break;
      case 'ungroup_tabs':
        result = await handleUngroupTabs(msg);
        break;
      case 'list_tab_groups':
        result = await handleListTabGroups(msg);
        break;
      case 'update_tab_group':
        result = await handleUpdateTabGroup(msg);
        break;
      case 'close_tab_group':
        result = await handleCloseTabGroup(msg);
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

// --- close_tabs ---

async function handleCloseTabs(msg) {
  const rawIds = Array.isArray(msg.tab_ids) ? msg.tab_ids : [];
  const parsedIds = [];
  const errors = {};
  for (const raw of rawIds) {
    const id = Number(raw);
    if (!Number.isFinite(id)) {
      errors[String(raw)] = 'invalid tab id';
      continue;
    }
    parsedIds.push(id);
  }
  const ids = [...new Set(parsedIds)];

  const closed = [];
  const settled = await Promise.allSettled(ids.map(id => chrome.tabs.remove(id)));
  settled.forEach((res, i) => {
    const id = ids[i];
    if (res.status === 'fulfilled') {
      closed.push(id);
    } else {
      errors[String(id)] = res.reason?.message || String(res.reason);
    }
  });

  return {
    type: 'close_tabs_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
    success: Object.keys(errors).length === 0, closed, errors,
    error: Object.keys(errors).length === 0 ? null : 'one or more tabs failed to close',
  };
}

// --- move_tabs ---

async function handleMoveTabs(msg) {
  const rawIds = Array.isArray(msg.tab_ids) ? msg.tab_ids : [];
  const errors = {};
  const parsedIds = [];
  for (const raw of rawIds) {
    const id = Number(raw);
    if (!Number.isFinite(id)) {
      errors[String(raw)] = 'invalid tab id';
      continue;
    }
    parsedIds.push(id);
  }
  const ids = [...new Set(parsedIds)];

  const idx = Number(msg.index);
  if (!Number.isFinite(idx)) {
    return {
      type: 'move_tabs_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
      success: false, moved: [], errors, error: 'index is required and must be an integer',
    };
  }
  const moveProps = { index: idx };
  if (msg.window_id != null) {
    const wid = Number(msg.window_id);
    if (!Number.isFinite(wid)) {
      return {
        type: 'move_tabs_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
        success: false, moved: [], errors, error: 'invalid window_id',
      };
    }
    moveProps.windowId = wid;
  }

  // Sequential moves are order-sensitive: each chrome.tabs.move pushes
  // earlier-moved tabs by one. To make `moved` (and the destination order)
  // match the caller's input order, iterate in REVERSE for non-negative
  // indices and FORWARD for the "end of window" sentinel (-1).
  const moveOrder = idx === -1 ? ids : [...ids].reverse();
  const movedSet = new Set();
  for (const id of moveOrder) {
    try {
      await chrome.tabs.move(id, moveProps);
      movedSet.add(id);
    } catch (e) {
      errors[String(id)] = e?.message || String(e);
    }
  }
  const moved = ids.filter(id => movedSet.has(id));

  const ok = Object.keys(errors).length === 0;
  return {
    type: 'move_tabs_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
    success: ok, moved, errors,
    error: ok ? null : 'one or more tabs failed to move',
  };
}

// --- group_tabs ---

async function handleGroupTabs(msg) {
  const rawIds = Array.isArray(msg.tab_ids) ? msg.tab_ids : [];
  const errors = {};
  const parsedIds = [];
  for (const raw of rawIds) {
    const id = Number(raw);
    if (!Number.isFinite(id)) {
      errors[String(raw)] = 'invalid tab id';
      continue;
    }
    parsedIds.push(id);
  }
  const ids = [...new Set(parsedIds)];
  if (!ids.length) {
    return {
      type: 'group_tabs_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
      success: false, group_id: null, grouped: [], errors,
      error: 'no valid tab ids provided',
    };
  }
  if (msg.group_id != null && msg.create_properties != null) {
    return {
      type: 'group_tabs_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
      success: false, group_id: null, grouped: [], errors,
      error: 'group_id and create_properties are mutually exclusive',
    };
  }
  const opts = { tabIds: ids };
  if (msg.group_id != null) {
    const gid = Number(msg.group_id);
    if (!Number.isFinite(gid)) {
      return {
        type: 'group_tabs_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
        success: false, group_id: null, grouped: [], errors,
        error: 'invalid group_id',
      };
    }
    opts.groupId = gid;
  } else if (msg.create_properties && typeof msg.create_properties === 'object') {
    const cp = {};
    if (msg.create_properties.window_id != null) {
      const wid = Number(msg.create_properties.window_id);
      if (!Number.isFinite(wid)) {
        return {
          type: 'group_tabs_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
          success: false, group_id: null, grouped: [], errors,
          error: 'invalid create_properties.window_id',
        };
      }
      cp.windowId = wid;
    }
    opts.createProperties = cp;
  }

  let groupId;
  try {
    groupId = await chrome.tabs.group(opts);
  } catch (e) {
    return {
      type: 'group_tabs_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
      success: false, group_id: null, grouped: [], errors,
      error: e?.message || String(e),
    };
  }
  // chrome.tabs.group is all-or-nothing — if it resolved, every id in `ids`
  // was grouped. `errors` only ever contains parse-time (non-numeric) raws.
  const ok = Object.keys(errors).length === 0;
  return {
    type: 'group_tabs_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
    success: ok, group_id: groupId, grouped: ids, errors,
    error: ok ? null : 'one or more tab ids were not numeric',
  };
}

// --- ungroup_tabs ---

async function handleUngroupTabs(msg) {
  const rawIds = Array.isArray(msg.tab_ids) ? msg.tab_ids : [];
  const errors = {};
  const parsedIds = [];
  for (const raw of rawIds) {
    const id = Number(raw);
    if (!Number.isFinite(id)) {
      errors[String(raw)] = 'invalid tab id';
      continue;
    }
    parsedIds.push(id);
  }
  const ids = [...new Set(parsedIds)];
  if (!ids.length) {
    return {
      type: 'ungroup_tabs_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
      success: false, ungrouped: [], errors,
      error: 'no valid tab ids provided',
    };
  }

  const ungrouped = [];
  // chrome.tabs.ungroup is all-or-nothing per call, so call it once per id
  // to surface partial failure the same way close_tabs does.
  const settled = await Promise.allSettled(ids.map(id => chrome.tabs.ungroup([id])));
  settled.forEach((res, i) => {
    const id = ids[i];
    if (res.status === 'fulfilled') {
      ungrouped.push(id);
    } else {
      errors[String(id)] = res.reason?.message || String(res.reason);
    }
  });

  const ok = Object.keys(errors).length === 0;
  return {
    type: 'ungroup_tabs_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
    success: ok, ungrouped, errors,
    error: ok ? null : 'one or more tabs failed to ungroup',
  };
}

// --- list_tab_groups ---

async function handleListTabGroups(msg) {
  const query = {};
  if (msg.window_id != null) {
    const wid = Number(msg.window_id);
    if (!Number.isFinite(wid)) {
      return {
        type: 'list_tab_groups_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
        success: false, groups: [], error: 'invalid window_id',
      };
    }
    query.windowId = wid;
  }
  let groups;
  try {
    groups = await chrome.tabGroups.query(query);
  } catch (e) {
    return {
      type: 'list_tab_groups_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
      success: false, groups: [], error: e?.message || String(e),
    };
  }
  const out = groups.map(g => ({
    id: g.id,
    title: g.title || '',
    color: g.color,
    collapsed: g.collapsed,
    window_id: g.windowId,
  }));
  return {
    type: 'list_tab_groups_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
    success: true, groups: out, error: null,
  };
}

// --- update_tab_group ---

const VALID_TAB_GROUP_COLORS = new Set([
  'grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange',
]);

async function handleUpdateTabGroup(msg) {
  const gid = Number(msg.group_id);
  if (!Number.isFinite(gid)) {
    return {
      type: 'update_tab_group_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
      success: false, group: null, error: 'invalid group_id',
    };
  }
  const update = {};
  if (msg.title != null) update.title = String(msg.title);
  if (msg.color != null) {
    if (!VALID_TAB_GROUP_COLORS.has(msg.color)) {
      return {
        type: 'update_tab_group_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
        success: false, group: null, error: `invalid color: ${msg.color}`,
      };
    }
    update.color = msg.color;
  }
  if (msg.collapsed != null) update.collapsed = Boolean(msg.collapsed);

  let group;
  try {
    group = await chrome.tabGroups.update(gid, update);
  } catch (e) {
    return {
      type: 'update_tab_group_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
      success: false, group: null, error: e?.message || String(e),
    };
  }
  return {
    type: 'update_tab_group_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
    success: true,
    group: {
      id: group.id,
      title: group.title || '',
      color: group.color,
      collapsed: group.collapsed,
      window_id: group.windowId,
    },
    error: null,
  };
}

// --- close_tab_group ---

async function handleCloseTabGroup(msg) {
  const gid = Number(msg.group_id);
  if (!Number.isFinite(gid)) {
    return {
      type: 'close_tab_group_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
      success: false, group_id: null, closed: [], errors: {},
      error: 'invalid group_id',
    };
  }

  // Verify the group exists before declaring success on an empty close.
  // chrome.tabGroups.get throws if no such group exists; treating that as
  // success would silently mask typo'd group_ids in caller scripts.
  try {
    await chrome.tabGroups.get(gid);
  } catch (e) {
    return {
      type: 'close_tab_group_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
      success: false, group_id: gid, closed: [], errors: {},
      error: e?.message || `no such group: ${gid}`,
    };
  }

  let tabs;
  try {
    tabs = await chrome.tabs.query({ groupId: gid });
  } catch (e) {
    return {
      type: 'close_tab_group_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
      success: false, group_id: gid, closed: [], errors: {},
      error: e?.message || String(e),
    };
  }
  // Narrow TOCTOU window between get() and query(): if every tab moved out
  // of the group between the two awaits, Chrome will have auto-deleted it
  // and we'll see an empty result. We treat that as a successful no-op
  // since the caller's intent ("group is gone") is satisfied either way.
  const ids = tabs.map(t => t.id).filter(id => Number.isFinite(id));

  const closed = [];
  const errors = {};
  const settled = await Promise.allSettled(ids.map(id => chrome.tabs.remove(id)));
  settled.forEach((res, i) => {
    const id = ids[i];
    if (res.status === 'fulfilled') {
      closed.push(id);
    } else {
      errors[String(id)] = res.reason?.message || String(res.reason);
    }
  });

  const ok = Object.keys(errors).length === 0;
  return {
    type: 'close_tab_group_result', msg_id: msg.msg_id, ts: Date.now() / 1000,
    success: ok, group_id: gid, closed, errors,
    error: ok ? null : 'one or more tabs failed to close',
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
