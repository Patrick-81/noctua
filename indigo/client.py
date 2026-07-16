"""
client.py — INDIGO TCP client.

Connects to an INDIGO server via raw TCP socket (typically port 7624),
sends getProperties on connect, and dispatches XML messages to
registered callbacks.

The INDIGO server on this port speaks XML over raw TCP (not WebSocket).
"""

from __future__ import annotations

import asyncio
import logging
import socket
import threading
import time
from typing import Any, Callable

from .protocol import (
    PropertyVector,
    build_get_properties,
    build_new_number_vector,
    build_new_switch_vector,
    build_new_text_vector,
    build_attach_driver,
    parse_xml_message,
)

log = logging.getLogger("indigo.client")

RECONNECT_DELAY = 3.0
MAX_RECONNECT = 10
PROBE_INTERVAL = 10.0
MAX_PROBES = 3


# ── Callback types ─────────────────────────────────────────────────

VectorHandler = Callable[[str, PropertyVector], Any]
DelHandler = Callable[[str, str], Any]
ConnectionHandler = Callable[[bool], Any]
BlobHandler = Callable[[str, str, str, str, bytes], Any]


class IndigoClient:
    """Async INDIGO TCP client."""

    def __init__(self, host_port: str):
        self._host, self._port = host_port.split(":")
        self._port = int(self._port)
        self._sock: socket.socket | None = None
        self._connected = False
        self._reconnect_try = 0
        self._probe_count = 0
        self._recv_buffer = b""

        # Stats
        self._def_count = 0
        self._set_count = 0

        # ── Callbacks ────────────────────────────────────────────
        self.on_connected: ConnectionHandler | None = None
        self.on_property_def: VectorHandler | None = None
        self.on_property_set: VectorHandler | None = None
        self.on_property_new: VectorHandler | None = None
        self.on_property_del: DelHandler | None = None
        self.on_blob: BlobHandler | None = None
        self.on_message: Callable[[str], Any] | None = None
        self.on_probes_done: Callable[[int, int], None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    @property
    def connected(self) -> bool:
        return self._connected

    # ── Connection lifecycle ──────────────────────────────────────

    async def connect(self) -> None:
        """Connect to the INDIGO server with auto-reconnect."""
        self._loop = asyncio.get_running_loop()
        while self._reconnect_try < MAX_RECONNECT:
            try:
                log.info("Connecting to %s:%d ...", self._host, self._port)
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(5)
                sock.connect((self._host, self._port))
                self._sock = sock
                self._connected = True
                self._reconnect_try = 0
                self._recv_buffer = b""
                log.info("Connected to %s:%d", self._host, self._port)

                if self.on_connected:
                    self.on_connected(True)

                # Send getProperties handshake
                msg = build_get_properties()
                await self._send(msg)
                log.info("Sent getProperties handshake")

                # Start receive loop in a thread (blocking recv)
                recv_thread = threading.Thread(target=self._recv_thread, daemon=True)
                recv_thread.start()

                # Start probe loop
                probe_task = asyncio.create_task(self._probe_loop())

                # Wait until disconnected
                while self._connected:
                    await asyncio.sleep(0.5)

                probe_task.cancel()
                try:
                    await probe_task
                except asyncio.CancelledError:
                    pass

            except (ConnectionRefusedError, OSError, socket.timeout) as e:
                log.warning("Connection error: %s", e)
            except Exception as e:
                log.error("Unexpected error: %s", e, exc_info=True)
            finally:
                self._connected = False
                if self._sock:
                    try:
                        self._sock.close()
                    except Exception:
                        pass
                    self._sock = None
                if self.on_connected:
                    self.on_connected(False)

            # Reconnect with backoff
            self._reconnect_try += 1
            delay = RECONNECT_DELAY * min(self._reconnect_try, 5)
            log.info("Reconnecting in %.1fs (attempt %d/%d)...",
                     delay, self._reconnect_try, MAX_RECONNECT)
            await asyncio.sleep(delay)

        log.warning("Max reconnect attempts reached, giving up.")

    async def disconnect(self) -> None:
        self._reconnect_try = MAX_RECONNECT
        self._connected = False
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass

    # ── Sending ───────────────────────────────────────────────────

    async def _send(self, msg: str) -> None:
        if self._sock and self._connected:
            log.debug("send: %s", msg[:200])
            try:
                self._sock.sendall((msg + "\n").encode())
            except Exception as e:
                log.warning("Send error: %s", e)
                self._connected = False

    async def send_get_properties(self, device: str | None = None,
                                  prop_name: str | None = None) -> None:
        await self._send(build_get_properties(device, prop_name))

    async def send_new_number(self, device: str, prop_name: str,
                              items: list[dict]) -> None:
        await self._send(build_new_number_vector(device, prop_name, items))

    async def send_new_switch(self, device: str, prop_name: str,
                              items: list[dict]) -> None:
        await self._send(build_new_switch_vector(device, prop_name, items))

    async def send_new_text(self, device: str, prop_name: str,
                            items: list[dict]) -> None:
        await self._send(build_new_text_vector(device, prop_name, items))

    async def send_attach_driver(self, driver_name: str) -> None:
        await self._send(build_attach_driver(driver_name))

    # ── Receiving (blocking thread) ───────────────────────────────

    def _recv_thread(self) -> None:
        """Blocking receive loop — runs in a daemon thread."""
        while self._connected:
            try:
                data = self._sock.recv(65536)
                if not data:
                    log.warning("Connection closed by server")
                    self._connected = False
                    break
                self._recv_buffer += data
                self._process_buffer()
            except socket.timeout:
                continue
            except Exception as e:
                if self._connected:
                    log.warning("Receive error: %s", e)
                    self._connected = False
                break

    def _process_buffer(self) -> None:
        """Extract complete XML messages from the receive buffer.

        INDIGO XML is multi-line: each message is a complete element
        like <defSwitchVector>...</defSwitchVector> spanning multiple lines.
        We accumulate the buffer and extract messages by detecting
        complete top-level elements.
        """
        text = self._recv_buffer.decode("utf-8", errors="replace")

        # Find complete messages: either self-closing <xxx/> or <xxx>...</xxx>
        # We track open/close of vector-level elements.
        # Known vector tags: def/set/new + Number/Switch/Text/Blob + Vector, delProperty, getProperties
        import re

        complete_messages = []
        remaining = text

        while remaining:
            remaining = remaining.lstrip("\n\r")

            if not remaining:
                break

            # Self-closing tag: <getProperties .../>  or <delProperty .../>
            m = re.match(r'(<(?:getProperties|delProperty)\s[^>]*/>)', remaining)
            if m:
                complete_messages.append(m.group(1))
                remaining = remaining[m.end():]
                continue

            # Opening of a vector element
            m = re.match(r'(<(def|set|new)(Number|Switch|Text|Blob)Vector\s)', remaining)
            if not m:
                # Not a known XML element — skip one line
                nl = remaining.find("\n")
                if nl >= 0:
                    remaining = remaining[nl + 1:]
                else:
                    break  # incomplete, wait for more data
                continue

            # Find the matching close tag
            tag_type = m.group(2) + m.group(3) + "Vector"  # e.g. "defSwitchVector"
            close_tag = f"</{tag_type}>"
            idx = remaining.find(close_tag)
            if idx < 0:
                break  # incomplete message, wait for more data

            msg_end = idx + len(close_tag)
            complete_messages.append(remaining[:msg_end])
            remaining = remaining[msg_end:]

        self._recv_buffer = remaining.encode("utf-8", errors="replace")

        for msg in complete_messages:
            msg = msg.strip()
            if not msg:
                continue
            if self.on_message:
                self._dispatch(self.on_message, msg)
            self._handle_xml(msg)

    def _handle_xml(self, xml_str: str) -> None:
        """Parse and dispatch a single XML message."""
        tag, parsed = parse_xml_message(xml_str)
        if parsed is None:
            return

        if tag == "delProperty" and isinstance(parsed, dict):
            if self.on_property_del:
                self._dispatch(self.on_property_del, parsed["device"], parsed["name"])

        elif isinstance(parsed, PropertyVector):
            if tag.startswith("def"):
                self._def_count += 1
                if self.on_property_def:
                    self._dispatch(self.on_property_def, tag, parsed)
            elif tag.startswith("set"):
                self._set_count += 1
                if self.on_property_set:
                    self._dispatch(self.on_property_set, tag, parsed)
            elif tag.startswith("new"):
                if self.on_property_new:
                    self._dispatch(self.on_property_new, tag, parsed)

    def _dispatch(self, callback, *args) -> None:
        """Call a callback, thread-safe via the stored event loop."""
        if self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(
                self._call_async(callback, *args), self._loop
            )
        else:
            callback(*args)

    @staticmethod
    async def _call_async(callback, *args):
        callback(*args)

    # ── Periodic probing ──────────────────────────────────────────

    async def _probe_loop(self) -> None:
        self._probe_count = 0
        while self._probe_count < MAX_PROBES:
            await asyncio.sleep(PROBE_INTERVAL)
            self._probe_count += 1
            if self._connected:
                log.debug("Probe %d/%d", self._probe_count, MAX_PROBES)
                await self.send_get_properties()

        if self._def_count == 0:
            log.warning(
                "No def*Vector received after %d probes. "
                "INDIGO server may have no devices loaded.",
                MAX_PROBES,
            )
        else:
            log.info(
                "Probes finished. Received %d def, %d set messages.",
                self._def_count, self._set_count,
            )

        if self.on_probes_done:
            self.on_probes_done(self._def_count, self._set_count)
