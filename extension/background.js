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
  ensureUserScriptWorld().catch((e) => {
    console.warn('[BCB] userScripts world not configured:', e.message);
  });
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
//
// Worlds:
//   cdp      — page JS via chrome.debugger Runtime.evaluate (bypasses page CSP)
//   user     — chrome.userScripts.execute in USER_SCRIPT world (one-shot, no register).
//              Exempt from page CSP. This is the Slack path: MAIN eval is blocked by
//              Slack, isolated eval is blocked by the extension isolated-world CSP,
//              and debugger attach fails on this tab ("chrome-extension:// URL of
//              different extension").
//   isolated — extension isolated world via content script / executeScript + eval
//   main     — page JS via executeScript + eval (blocked by Slack-style script-src)
//   auto     — CDP, then user, then isolated, then MAIN.
//
// userScripts.execute does not persist a registration, so it does not leak scripts
// across calls. Isolated-world window bindings from the *user's* JS can still live
// until the tab closes.

const VALID_WORLDS = new Set(['auto', 'cdp', 'user', 'isolated', 'main']);
const USER_SCRIPT_WORLD_CSP = "script-src 'self' 'unsafe-eval' 'unsafe-inline' 'wasm-unsafe-eval'";
const USER_SCRIPTS_DISABLED_ERROR =
  "userScripts API disabled. Chrome 138+: open the BCB extension details page and enable Allow User Scripts. Earlier Chrome: enable Developer mode on chrome://extensions, then reload the extension.";

let userWorldReady = false;

async function handleExecuteJs(msg) {
  const tabId = await resolveTabId(msg.tab_id);
  const world = normalizeWorld(msg.world);

  if (world === 'cdp') {
    return await executeViaCdp(tabId, msg);
  }
  if (world === 'user') {
    return await executeViaUserScript(tabId, msg);
  }
  if (world === 'isolated') {
    return await executeViaIsolated(tabId, msg);
  }
  if (world === 'main') {
    return await executeViaEval(tabId, msg, 'MAIN');
  }

  try {
    const cdpResult = await executeViaCdp(tabId, msg);
    // Attach worked. Keep real JS errors (ReferenceError, etc.). Fall back only
    // when the page CSP/Trusted Types blocked evaluation.
    if (cdpResult.success || !isCspEvalError(cdpResult.error)) {
      return cdpResult;
    }
    console.warn('[BCB] CDP blocked by page CSP, falling back to userScripts:', cdpResult.error);
  } catch (cdpError) {
    console.warn('[BCB] CDP execution failed, falling back to userScripts:', cdpError.message);
  }

  let userDisabled = false;
  try {
    const userResult = await executeViaUserScript(tabId, msg);
    if (userResult.success) return userResult;
    userDisabled = /userScripts API disabled/i.test(userResult.error || '');
    // Real JS errors stay. Disabled/CSP fall through so MAIN can still work on
    // pages that allow eval when the userScripts toggle is off.
    if (!userDisabled && !isCspEvalError(userResult.error)) {
      return userResult;
    }
    console.warn('[BCB] userScripts failed, falling back:', userResult.error);
  } catch (userError) {
    console.warn('[BCB] userScripts failed, falling back:', userError.message);
  }

  try {
    const isolatedResult = await executeViaIsolated(tabId, msg);
    if (isolatedResult.success) return isolatedResult;
    if (!isCspEvalError(isolatedResult.error)) return isolatedResult;
    console.warn('[BCB] Isolated execution failed, falling back to MAIN eval:', isolatedResult.error);
  } catch (isolatedError) {
    console.warn('[BCB] Isolated execution failed, falling back to MAIN eval:', isolatedError.message);
  }

  const mainResult = await executeViaEval(tabId, msg, 'MAIN');
  if (mainResult.success || !userDisabled || !isCspEvalError(mainResult.error)) {
    return mainResult;
  }
  // Slack-style wall: isolated and MAIN both blocked eval. The fix is the toggle.
  return jsResult(msg, {
    success: false,
    error: USER_SCRIPTS_DISABLED_ERROR,
    world: 'user',
  });
}

function normalizeWorld(world) {
  if (world == null || world === '') return 'auto';
  const normalized = String(world).toLowerCase();
  if (!VALID_WORLDS.has(normalized)) {
    throw new Error(`invalid world: ${world} (expected auto, cdp, user, isolated, or main)`);
  }
  return normalized;
}

function isUserScriptsAvailable() {
  try {
    if (!chrome.userScripts || typeof chrome.userScripts.execute !== 'function') {
      return false;
    }
    // Sync throw when the permission or Allow User Scripts toggle is off.
    chrome.userScripts.getScripts();
    return true;
  } catch {
    return false;
  }
}

async function ensureUserScriptWorld() {
  if (userWorldReady) return;
  if (!isUserScriptsAvailable()) {
    throw new Error(USER_SCRIPTS_DISABLED_ERROR);
  }
  await chrome.userScripts.configureWorld({
    csp: USER_SCRIPT_WORLD_CSP,
    messaging: false,
  });
  userWorldReady = true;
}

function wrapUserCode(code) {
  // USER_SCRIPT world is exempt from the page CSP. We still wrap so statement
  // lists, promises, and thrown errors match the existing bcb_exec contract.
  // This eval is in the user-script world, not MAIN, and that world's CSP is
  // set by configureWorld (unsafe-eval allowed). One-shot execute, no register.
  return `(async () => {
    try {
      const rv = eval(${JSON.stringify(code)});
      const value = await rv;
      try { return { ok: true, result: JSON.parse(JSON.stringify(value)) }; }
      catch { return { ok: true, result: String(value) }; }
    } catch (e) {
      return { ok: false, error: (e && (e.stack || e.message)) || String(e) };
    }
  })()`;
}

async function executeViaUserScript(tabId, msg) {
  if (!isUserScriptsAvailable()) {
    return jsResult(msg, {
      success: false,
      error: USER_SCRIPTS_DISABLED_ERROR,
      world: 'user',
    });
  }
  try {
    await ensureUserScriptWorld();
    const results = await chrome.userScripts.execute({
      target: { tabId },
      world: 'USER_SCRIPT',
      injectImmediately: true,
      js: [{ code: wrapUserCode(msg.code) }],
    });
    const injectionResult = results && results[0];
    if (!injectionResult) {
      return jsResult(msg, {
        success: false,
        error: 'userScripts.execute returned no result',
        world: 'user',
      });
    }
    if (injectionResult.error) {
      return jsResult(msg, {
        success: false,
        error: injectionResult.error,
        world: 'user',
      });
    }
    const payload = injectionResult.result;
    if (payload && payload.ok === false) {
      return jsResult(msg, {
        success: false,
        error: payload.error || 'user script failed',
        world: 'user',
      });
    }
    if (payload && payload.ok === true) {
      return jsResult(msg, {
        success: true,
        result: payload.result ?? null,
        world: 'user',
      });
    }
    let result = injectionResult.result;
    try {
      result = JSON.parse(JSON.stringify(result));
    } catch {
      result = result == null ? null : String(result);
    }
    return jsResult(msg, { success: true, result: result ?? null, world: 'user' });
  } catch (e) {
    userWorldReady = false;
    const err = (e && e.message) || String(e);
    if (/not enabled|Allow User Scripts|user scripts|must be enabled/i.test(err)) {
      return jsResult(msg, { success: false, error: USER_SCRIPTS_DISABLED_ERROR, world: 'user' });
    }
    return jsResult(msg, { success: false, error: err, world: 'user' });
  }
}

function isCspEvalError(errorText) {
  if (!errorText) return false;
  return /EvalError|Content Security Policy|unsafe-eval|Trusted Type/i.test(String(errorText));
}

function jsResult(msg, { success, result = null, error = null, world = null }) {
  return {
    type: 'execute_js_result',
    msg_id: msg.msg_id,
    ts: Date.now() / 1000,
    success,
    result,
    error,
    world,
  };
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
      return jsResult(msg, { success: false, error: errMsg, world: 'cdp' });
    }
    return jsResult(msg, {
      success: true,
      result: response.result?.value ?? null,
      world: 'cdp',
    });
  } finally {
    try { await chrome.debugger.detach(target); } catch { /* already detached */ }
  }
}

async function executeViaIsolated(tabId, msg) {
  // Prefer the already-injected content script (proven to load on Slack).
  // If this tab has no content script (chrome://, not yet loaded), inject.
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'execute_js',
      code: msg.code,
    });
    if (response && response.ok === false) {
      return jsResult(msg, { success: false, error: response.error || 'isolated eval failed', world: 'isolated' });
    }
    if (response && response.ok === true) {
      return jsResult(msg, { success: true, result: response.result ?? null, world: 'isolated' });
    }
  } catch (e) {
    console.warn('[BCB] Isolated content script missing, injecting:', e.message);
  }
  return await executeViaEval(tabId, msg, 'ISOLATED');
}

async function executeViaEval(tabId, msg, world) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (codeString) => {
      // Catch inside the injected function. MAIN-world EvalError from page CSP
      // becomes an uncaught page exception and used to surface as success+null.
      try {
        // eslint-disable-next-line no-eval
        const rv = eval(codeString);
        const value = await rv;
        let result;
        try {
          result = JSON.parse(JSON.stringify(value));
        } catch {
          result = String(value);
        }
        return { ok: true, result };
      } catch (e) {
        return {
          ok: false,
          error: (e && (e.stack || e.message)) || String(e),
        };
      }
    },
    args: [msg.code],
    world,
  });
  const injectionResult = results[0];
  const worldName = world === 'ISOLATED' ? 'isolated' : 'main';
  if (injectionResult.error) {
    const errMsg = injectionResult.error.message || JSON.stringify(injectionResult.error);
    return jsResult(msg, { success: false, error: errMsg, world: worldName });
  }
  const payload = injectionResult.result;
  if (payload && payload.ok === false) {
    return jsResult(msg, { success: false, error: payload.error || 'eval failed', world: worldName });
  }
  if (payload && payload.ok === true) {
    return jsResult(msg, { success: true, result: payload.result ?? null, world: worldName });
  }
  return jsResult(msg, { success: false, error: 'eval returned no result', world: worldName });
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
