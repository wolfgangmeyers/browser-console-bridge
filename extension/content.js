// Browser Console Bridge - Content Script (content.js)
// Runs in ISOLATED world on all pages. Receives console events dispatched by
// console-capture.js (MAIN world), buffers them, and forwards to service worker.

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
  if (message.type === 'clear_console_buffer') {
    consoleBuffer.splice(0, consoleBuffer.length);
    sendResponse({ cleared: true });
    return false;
  }
});

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

// (No explicit init needed — console-capture.js runs in MAIN world via manifest)
