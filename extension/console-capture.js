// Browser Console Bridge - MAIN world console capture (console-capture.js)
// Declared in manifest with world: "MAIN", run_at: "document_start".
// Runs directly in the page's JS context — no script tag injection needed,
// and extension-injected MAIN world scripts bypass page CSP.

// Guard against double-install (e.g. if the page does a soft navigation)
if (!window.__consoleBridgeInstalled) {
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
    const lines = err.stack.split('\n');
    // Skip "Error", the monkey-patch frame, and the console[method] frame
    for (let i = 3; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line && !line.includes('consoleBridge')) {
        const match = line.match(/(?:at\s+)?(?:\S+\s+\(?)?(https?:\/\/[^\s)]+)/);
        if (match) return match[1];
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
        return JSON.parse(JSON.stringify(obj));
      } catch {
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
