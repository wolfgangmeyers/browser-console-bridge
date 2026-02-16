// Browser Console Bridge - Content Script (content.js)
// Runs in ISOLATED world on all pages. Injects console monkey-patch into
// MAIN world, buffers captured entries, forwards to service worker.

const MAX_BUFFER_SIZE = 500;
const consoleBuffer = [];

// --- Listen for console entries from the MAIN world ---

window.addEventListener('__consoleBridge', (event) => {
  const data = event.detail;
  if (!data) return;
  const entry = {
    level: data.method || 'log',
    ts: (data.timestamp || Date.now()) / 1000,  // Convert ms to seconds
    content: formatContent(data.args),
    source: data.source || '',
  };
  consoleBuffer.push(entry);
  if (consoleBuffer.length > MAX_BUFFER_SIZE) {
    consoleBuffer.splice(0, consoleBuffer.length - MAX_BUFFER_SIZE);
  }
  // Forward to service worker (fire-and-forget)
  try {
    chrome.runtime.sendMessage({ type: 'console_entry', data: entry });
  } catch {
    // Extension context may be invalidated on reload; ignore
  }
});

// --- Respond to requests from the service worker ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'get_console_buffer') {
    let entries = consoleBuffer.slice();
    if (message.since) {
      entries = entries.filter(e => e.ts > message.since);
    }
    if (message.levels && Array.isArray(message.levels)) {
      const levelSet = new Set(message.levels);
      entries = entries.filter(e => levelSet.has(e.level));
    }
    sendResponse(entries);
    return false;
  }
});

// --- Inject the MAIN world monkey-patch ---

function injectMainWorldCapture() {
  const script = document.createElement('script');
  script.textContent = `(${mainWorldCapture.toString()})();`;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

function mainWorldCapture() {
  // Guard against double-install
  if (window.__consoleBridgeInstalled) return;
  window.__consoleBridgeInstalled = true;

  const methods = ['log', 'warn', 'error', 'info', 'debug'];
  const originals = {};

  methods.forEach(method => {
    originals[method] = console[method].bind(console);
    console[method] = function (...args) {
      const serialized = args.map(safeSerialize);
      const source = extractSource(new Error());
      dispatch(method, serialized, source);
      originals[method].apply(console, args);
    };
  });

  // Capture uncaught errors
  window.addEventListener('error', (event) => {
    dispatch('error', [{
      type: 'error',
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error && event.error.stack || null,
    }], event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : '');
  });

  // Capture unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    dispatch('error', [{
      type: 'error',
      message: reason && reason.message || String(reason),
      stack: reason && reason.stack || null,
    }], '');
  });

  function dispatch(method, args, source) {
    try {
      window.dispatchEvent(new CustomEvent('__consoleBridge', {
        detail: { method, args, timestamp: Date.now(), source },
      }));
    } catch {
      // Swallow; never interfere with the page
    }
  }

  function extractSource(err) {
    if (!err || !err.stack) return '';
    // Stack lines after the first two are from the call site
    const lines = err.stack.split('\n');
    // Skip "Error", the monkey-patch frame, and the console[method] frame
    for (let i = 3; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line && !line.includes('consoleBridge')) {
        // Extract URL:line:col from e.g. "at https://example.com/app.js:42:5"
        const match = line.match(/(?:at\s+)?(?:\S+\s+\(?)?(https?:\/\/[^\s)]+)/);
        if (match) return match[1];
        // Fallback: return the raw line
        return line.replace(/^\s*at\s+/, '');
      }
    }
    return '';
  }

  function safeSerialize(obj, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 3) return '[max depth]';
    if (obj === null) return null;
    if (obj === undefined) return undefined;

    var type = typeof obj;
    if (type === 'string' || type === 'number' || type === 'boolean') return obj;
    if (type === 'function') return '[Function: ' + (obj.name || 'anonymous') + ']';
    if (type === 'symbol') return obj.toString();
    if (type === 'bigint') return obj.toString() + 'n';

    if (obj instanceof Error) {
      return { __type: 'Error', name: obj.name, message: obj.message, stack: obj.stack };
    }
    // DOM elements
    if (typeof HTMLElement !== 'undefined' && obj instanceof HTMLElement) {
      var tag = obj.tagName.toLowerCase();
      var id = obj.id ? '#' + obj.id : '';
      var cls = obj.className && typeof obj.className === 'string'
        ? '.' + obj.className.trim().split(/\s+/).join('.') : '';
      return '<' + tag + id + cls + '>';
    }

    if (Array.isArray(obj)) {
      return obj.slice(0, 100).map(function (item) {
        return safeSerialize(item, depth + 1);
      });
    }

    if (type === 'object') {
      try {
        // Fast path: try JSON round-trip
        return JSON.parse(JSON.stringify(obj));
      } catch {
        // Slow path: manual serialization with circular reference protection
        var result = {};
        var keys = Object.keys(obj).slice(0, 50);
        for (var i = 0; i < keys.length; i++) {
          try {
            result[keys[i]] = safeSerialize(obj[keys[i]], depth + 1);
          } catch {
            result[keys[i]] = '[unserializable]';
          }
        }
        return result;
      }
    }

    return String(obj);
  }
}

// --- Format serialized args into a single content string ---

function formatContent(args) {
  if (!Array.isArray(args)) return String(args);
  return args.map(arg => {
    if (arg === null) return 'null';
    if (arg === undefined) return 'undefined';
    if (typeof arg === 'string') return arg;
    if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }).join(' ');
}

// --- Initialize ---

injectMainWorldCapture();
