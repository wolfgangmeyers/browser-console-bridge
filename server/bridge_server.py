#!/usr/bin/env python3
"""Browser Console Bridge — HTTP + WebSocket server.

Single-file server that bridges CLI tools to the browser extension.
HTTP server accepts commands from CLI, WebSocket server connects to extension.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import websockets
from websockets.asyncio.server import ServerConnection

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

HOST: str = os.environ.get("BCB_HOST", "127.0.0.1")
HTTP_PORT: int = int(os.environ.get("BCB_HTTP_PORT", "18080"))
WS_PORT: int = int(os.environ.get("BCB_WS_PORT", "18081"))
DEFAULT_TIMEOUT: float = float(os.environ.get("BCB_TIMEOUT", "30"))
LOG_LEVEL: str = os.environ.get("BCB_LOG_LEVEL", "INFO").upper()

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("bcb")

# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------

@dataclass
class PendingCommand:
    msg_id: str
    request: dict[str, Any]
    event: threading.Event = field(default_factory=threading.Event)
    response: dict[str, Any] | None = None
    created_at: float = field(default_factory=time.time)
    timeout: float = DEFAULT_TIMEOUT


lock = threading.Lock()
pending_commands: dict[str, PendingCommand] = {}
extension_ws: ServerConnection | None = None
ws_loop: asyncio.AbstractEventLoop | None = None
start_time: float = time.time()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def error_response(msg_id: str, error: str, code: str) -> dict[str, Any]:
    return {
        "type": "error",
        "msg_id": msg_id,
        "ts": time.time(),
        "success": False,
        "error": error,
        "code": code,
    }


def send_to_extension(data: str) -> None:
    """Schedule a WebSocket send from any thread."""
    ws = extension_ws
    loop = ws_loop
    if ws is None or loop is None:
        return
    asyncio.run_coroutine_threadsafe(ws.send(data), loop)

# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class BridgeHTTPHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        log.debug("HTTP %s", fmt % args)

    def _send_json(self, data: dict[str, Any]) -> None:
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # --- GET -----------------------------------------------------------------

    def do_GET(self) -> None:
        if self.path in ("/health", "/status"):
            with lock:
                n_pending = len(pending_commands)
                connected = extension_ws is not None
            self._send_json({
                "status": "ok",
                "extension_connected": connected,
                "pending_commands": n_pending,
                "uptime": round(time.time() - start_time, 1),
            })
        else:
            self._send_json({})

    # --- POST ----------------------------------------------------------------

    def do_POST(self) -> None:
        if self.path != "/command":
            self._send_json({})
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
        except (json.JSONDecodeError, ValueError):
            self._send_json(error_response("", "malformed JSON", "INVALID_MESSAGE"))
            return

        msg_type = body.get("type")
        if not msg_type:
            self._send_json(error_response(
                body.get("msg_id", ""), "missing 'type' field", "INVALID_MESSAGE",
            ))
            return

        msg_id = body.setdefault("msg_id", str(uuid.uuid4()))
        body.setdefault("ts", time.time())
        timeout = float(body.get("timeout", DEFAULT_TIMEOUT))

        with lock:
            if extension_ws is None:
                self._send_json(error_response(msg_id, "no extension connected", "NO_EXTENSION"))
                return
            pc = PendingCommand(msg_id=msg_id, request=body, timeout=timeout)
            pending_commands[msg_id] = pc

        try:
            send_to_extension(json.dumps(body))
        except Exception:
            with lock:
                pending_commands.pop(msg_id, None)
            self._send_json(error_response(msg_id, "failed to send to extension", "SERVER_ERROR"))
            return

        signaled = pc.event.wait(timeout=timeout)

        with lock:
            pending_commands.pop(msg_id, None)

        if not signaled or pc.response is None:
            self._send_json(error_response(msg_id, f"extension did not respond within {timeout}s", "TIMEOUT"))
        else:
            self._send_json(pc.response)

# ---------------------------------------------------------------------------
# WebSocket handler
# ---------------------------------------------------------------------------

async def ws_handler(ws: ServerConnection) -> None:
    global extension_ws
    log.info("Extension connected from %s", ws.remote_address)

    old_ws: ServerConnection | None = None
    with lock:
        old_ws = extension_ws
        extension_ws = ws

    if old_ws is not None:
        try:
            await old_ws.close()
        except Exception:
            pass

    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                log.warning("Non-JSON message from extension: %s", raw[:120])
                continue

            msg_id = msg.get("msg_id")
            if not msg_id:
                continue

            with lock:
                pc = pending_commands.get(msg_id)
            if pc is not None:
                pc.response = msg
                pc.event.set()
                log.debug("Matched response for %s", msg_id)
            else:
                log.debug("No pending command for msg_id=%s (may have timed out)", msg_id)
    except websockets.ConnectionClosed:
        log.info("Extension disconnected")
    finally:
        with lock:
            if extension_ws is ws:
                extension_ws = None
                # Signal all pending commands so they unblock immediately
                for pc in pending_commands.values():
                    if pc.response is None:
                        pc.response = error_response(
                            pc.msg_id, "extension disconnected", "NO_EXTENSION",
                        )
                        pc.event.set()


async def run_ws_server() -> None:
    global ws_loop
    ws_loop = asyncio.get_running_loop()
    async with websockets.serve(ws_handler, HOST, WS_PORT):
        log.info("WebSocket listening on ws://%s:%d", HOST, WS_PORT)
        await asyncio.Future()  # run forever

# ---------------------------------------------------------------------------
# Cleanup thread
# ---------------------------------------------------------------------------

def cleanup_loop() -> None:
    while True:
        time.sleep(60)
        now = time.time()
        with lock:
            expired = [
                mid for mid, pc in pending_commands.items()
                if now - pc.created_at > pc.timeout + 30
            ]
            for mid in expired:
                pc = pending_commands.pop(mid)
                if not pc.event.is_set():
                    pc.response = error_response(mid, "expired", "TIMEOUT")
                    pc.event.set()
        if expired:
            log.debug("Cleaned up %d expired entries", len(expired))

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    global start_time
    start_time = time.time()

    # Cleanup thread
    t = threading.Thread(target=cleanup_loop, daemon=True)
    t.start()

    # WebSocket server in its own thread
    def run_ws():
        asyncio.run(run_ws_server())

    ws_thread = threading.Thread(target=run_ws, daemon=True)
    ws_thread.start()

    # HTTP server on the main thread
    httpd = ThreadingHTTPServer((HOST, HTTP_PORT), BridgeHTTPHandler)
    log.info("HTTP listening on http://%s:%d", HOST, HTTP_PORT)

    def shutdown(signum: int, frame: Any) -> None:
        log.info("Shutting down (signal %d)…", signum)
        # Signal all pending commands
        with lock:
            for pc in pending_commands.values():
                if not pc.event.is_set():
                    pc.response = error_response(pc.msg_id, "server shutting down", "SERVER_ERROR")
                    pc.event.set()
        httpd.shutdown()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        log.info("Server stopped")


if __name__ == "__main__":
    main()
