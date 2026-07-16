"""
weblog.py — Logging handler that pushes log records to WebSocket clients.

Thread-safe: works from both main thread and recv thread.
Uses asyncio.run_coroutine_threadsafe() for cross-thread dispatch.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time


class WebLogHandler(logging.Handler):
    """A logging handler that broadcasts records to a list of WebSockets."""

    def __init__(self):
        super().__init__()
        self._clients: list = []
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = threading.Lock()

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Set the event loop for cross-thread scheduling."""
        self._loop = loop

    def add_client(self, ws) -> None:
        with self._lock:
            self._clients.append(ws)

    def remove_client(self, ws) -> None:
        with self._lock:
            if ws in self._clients:
                self._clients.remove(ws)

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = self.format(record)
            payload = json.dumps({
                "type": "log",
                "level": record.levelname.lower(),
                "logger": record.name,
                "msg": msg,
                "ts": time.time(),
            })
            self._broadcast(payload)
        except Exception:
            self.handleError(record)

    def _broadcast(self, payload: str) -> None:
        """Send payload to all clients, thread-safe."""
        if not self._loop or self._loop.is_closed():
            return
        with self._lock:
            clients = list(self._clients)
        for ws in clients:
            try:
                asyncio.run_coroutine_threadsafe(
                    ws.send_text(payload), self._loop
                )
            except Exception:
                pass


handler = WebLogHandler()
handler.setFormatter(logging.Formatter(
    "%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
))
