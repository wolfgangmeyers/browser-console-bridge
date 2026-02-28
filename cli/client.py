"""Shared HTTP client for Browser Console Bridge CLI tools."""
import json, os, time, urllib.error, urllib.request, uuid


class BcbClient:
    """Thin HTTP client for the BCB server. Stdlib only."""

    def __init__(self, host: str | None = None, port: int | None = None) -> None:
        host = host or os.environ.get("BCB_HOST", "localhost")
        port = port or int(os.environ.get("BCB_HTTP_PORT", "18080"))
        self.base_url = f"http://{host}:{port}"

    def send_command(self, command: dict, timeout: float = 30) -> dict:
        """POST to /command, block until response. Returns parsed JSON.

        The server always returns HTTP 200. Success vs failure is determined
        by the ``success`` field in the response body.
        """
        if "msg_id" not in command:
            command["msg_id"] = str(uuid.uuid4())
        if "ts" not in command:
            command["ts"] = time.time()
        command["timeout"] = timeout
        data = json.dumps(command).encode()
        req = urllib.request.Request(
            f"{self.base_url}/command", data=data,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout + 5) as resp:
                return json.loads(resp.read())
        except urllib.error.URLError as exc:
            raise ConnectionError(f"Server not reachable: {exc}") from exc
        except TimeoutError as exc:
            raise TimeoutError(f"No response within {timeout}s") from exc

    def execute_js(self, code: str, tab_id: int | None = None, timeout: float = 30) -> dict:
        return self.send_command(
            {"type": "execute_js", "code": code, "tab_id": tab_id}, timeout=timeout,
        )

    def read_console(self, tab_id: int | None = None, since: float | None = None,
                     levels: list[str] | None = None, limit: int = 100,
                     timeout: float = 10) -> dict:
        cmd: dict = {"type": "read_console", "tab_id": tab_id, "limit": limit}
        if since is not None:
            cmd["since"] = since
        if levels is not None:
            cmd["levels"] = levels
        return self.send_command(cmd, timeout=timeout)

    def clear_console(self, tab_id: int | None = None, timeout: float = 10) -> dict:
        return self.send_command({"type": "clear_console", "tab_id": tab_id}, timeout=timeout)

    def list_tabs(self, timeout: float = 10) -> dict:
        return self.send_command({"type": "list_tabs"}, timeout=timeout)

    def screenshot(self, tab_id: int | None = None, fmt: str = "png",
                   timeout: float = 10) -> dict:
        return self.send_command(
            {"type": "screenshot", "tab_id": tab_id, "format": fmt}, timeout=timeout,
        )

    def health(self) -> dict:
        """GET /health -- returns parsed JSON."""
        req = urllib.request.Request(f"{self.base_url}/health")
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return json.loads(resp.read())
        except urllib.error.URLError as exc:
            raise ConnectionError(f"Server not reachable: {exc}") from exc
