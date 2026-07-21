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
import re
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

    def __init__(self, host_port: str, protocol: str = "connect"):
        self._host, self._port = host_port.split(":")
        self._port = int(self._port)
        self._protocol = protocol
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

                # Log raw messages for debugging
                self.on_message = lambda msg: log.debug("RAW: %s", msg[:300])

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
        """Extract complete XML messages and BLOB binary data from the receive buffer.

        INDIGO BLOB messages contain binary image data inline between XML tags:
            <setBlobVector ...>
                <oneBlob name="CCD_IMAGE" size="12345" format="image/fits">
                <binary payload — 12345 bytes, NOT valid UTF-8>
                </oneBlob>
            </setBlobVector>

        This method keeps the buffer as raw bytes, detects BLOB vectors,
        extracts the binary payload by size, and dispatches both XML and
        BLOB data through the appropriate callbacks.
        """
        import re as _re

        # Regex for vector-level elements (works on both str and bytes)
        _re_vector = _re.compile(
            rb'<(def|set|new)(Number|Switch|Text|Blob)Vector[\s/>]')
        _re_selfclose = _re.compile(
            rb'<(?:getProperties|delProperty)\s[^>]*/>')

        complete_messages = []  # list of (tag_type_str, raw_xml_bytes)
        blob_messages = []      # list of (device, name, size, fmt, binary_data)

        while self._recv_buffer:
            self._recv_buffer = self._recv_buffer.lstrip(b"\n\r")
            if not self._recv_buffer:
                break

            # Self-closing tag
            m = _re_selfclose.match(self._recv_buffer)
            if m:
                complete_messages.append(("selfclose", m.group(0)))
                self._recv_buffer = self._recv_buffer[m.end():]
                continue

            # Opening of a vector element
            m = _re_vector.match(self._recv_buffer)
            if not m:
                # Handle non-self-closing delProperty / getProperties
                if self._recv_buffer.startswith(b"<delProperty") or \
                   self._recv_buffer.startswith(b"<getProperties"):
                    close = self._recv_buffer.find(b">")
                    if close < 0:
                        break  # incomplete
                    tag_end = close + 1
                    # Check for self-closing />
                    if tag_end < len(self._recv_buffer) and \
                       self._recv_buffer[tag_end - 2:tag_end] == b'/>':
                        complete_messages.append((
                            "selfclose", self._recv_buffer[:tag_end]))
                        self._recv_buffer = self._recv_buffer[tag_end:]
                        continue
                    # Content element — find matching close tag
                    tag_name = self._recv_buffer[1:tag_end].split(None, 1)[0]
                    close_tag = b"</" + tag_name + b">"
                    idx = self._recv_buffer.find(close_tag, tag_end)
                    if idx < 0:
                        break  # incomplete
                    msg_end = idx + len(close_tag)
                    complete_messages.append((
                        tag_name.decode("ascii", errors="replace"),
                        self._recv_buffer[:msg_end]))
                    self._recv_buffer = self._recv_buffer[msg_end:]
                    continue
                # Not a known XML element — skip one line
                nl = self._recv_buffer.find(b"\n")
                if nl >= 0:
                    self._recv_buffer = self._recv_buffer[nl + 1:]
                else:
                    break  # incomplete, wait for more data
                continue

            tag_type = m.group(1) + m.group(2) + b"Vector"  # e.g. b"defSwitchVector"
            close_tag = b"</" + tag_type + b">"

            # BLOB vector: extract binary payload inline
            if b"Blob" in m.group(2):
                device, prop_name, item_name, fmt, binary_data, consumed = (
                    self._extract_blob(tag_type, close_tag))
                if consumed < 0:
                    break  # incomplete, wait for more data
                if device and self.on_blob and binary_data:
                    self._dispatch(self.on_blob, device, prop_name,
                                   item_name, fmt, binary_data)
                self._recv_buffer = self._recv_buffer[consumed:]
                continue

            # Regular XML vector: find matching close tag
            # Use nesting count to ensure we find the right close tag
            # (in case two vectors of the same type are in the buffer)
            idx = self._recv_buffer.find(close_tag)
            if idx < 0:
                break  # incomplete message, wait for more data

            # Verify this close tag belongs to the current vector:
            # count open tags of same type before idx — should be exactly 1
            open_count = 0
            search_start = 0
            open_pattern = m.group(0)  # e.g. b'<setNumberVector '
            while True:
                pos = self._recv_buffer.find(open_pattern, search_start, idx)
                if pos < 0:
                    break
                open_count += 1
                search_start = pos + 1
            if open_count > 1:
                # Close tag belongs to a later vector — wait for the first
                # vector's close tag to arrive
                break

            msg_end = idx + len(close_tag)
            complete_messages.append((
                tag_type.decode("ascii", errors="replace"),
                self._recv_buffer[:msg_end],
            ))
            self._recv_buffer = self._recv_buffer[msg_end:]

        # Dispatch XML messages
        for tag_type, raw_xml in complete_messages:
            if tag_type == "selfclose":
                xml_str = raw_xml.decode("utf-8", errors="replace").strip()
                if not xml_str:
                    continue
                if self.on_message:
                    self._dispatch(self.on_message, xml_str)
                self._handle_xml(xml_str)
                continue

            xml_str = raw_xml.decode("utf-8", errors="replace").strip()
            if not xml_str:
                continue
            if self.on_message:
                self._dispatch(self.on_message, xml_str)
            self._handle_xml(xml_str)

        if complete_messages or blob_messages:
            log.debug("Processed %d XML messages, %d BLOBs",
                      len(complete_messages), len(blob_messages))

    def _extract_blob(self, tag_type: bytes, close_tag: bytes):
        """Extract a BLOB from the buffer.

        Returns (device_name, prop_name, item_name, fmt, binary_data,
        consumed_bytes).  consumed_bytes is -1 if the message is incomplete.

        INDIGO uses single quotes for attributes (device='...' name='...').
        """
        idx = self._recv_buffer.find(close_tag)
        if idx < 0:
            return None, None, None, "", b"", -1

        # Extract the XML part before the binary payload
        blob_section = self._recv_buffer[:idx]

        # Parse metadata from the oneBlob/defBlob element
        # Accept both single and double quotes for INDIGO compatibility
        blob_match = re.search(
            rb"""<(?:oneBlob|defBlob)\s[^>]*?name=['"]([^'"]*)['"][^>]*?"""
            rb"""size=['"](\d+)['"][^>]*?format=['"]([^'"]*)['"]""",
            blob_section)
        if not blob_match:
            blob_match = re.search(
                rb"""<(?:oneBlob|defBlob)\s[^>]*?format=['"]([^'"]*)['"][^>]*?"""
                rb"""name=['"]([^'"]*)['"][^>]*?size=['"](\d+)['"]""",
                blob_section)
            if blob_match:
                fmt = blob_match.group(1).decode("ascii", errors="replace")
                name = blob_match.group(2).decode("utf-8", errors="replace")
                size = int(blob_match.group(3))
            else:
                size_match = re.search(rb"""size=['"](\d+)['"]""", blob_section)
                size = int(size_match.group(1)) if size_match else 0
                name = ""
                fmt = ""
        else:
            name = blob_match.group(1).decode("utf-8", errors="replace")
            size = int(blob_match.group(2))
            fmt = blob_match.group(3).decode("ascii", errors="replace")

        # Extract device name and property name from the parent vector tag
        header = self._recv_buffer[:idx + 200]
        dev_match = re.search(rb"""device=['"]([^'"]*)['"]""", header)
        device = dev_match.group(1).decode("utf-8", errors="replace") if dev_match else ""
        prop_match = re.search(rb"""name=['"]([^'"]*)['"]""", header)
        prop_name = prop_match.group(1).decode("utf-8", errors="replace") if prop_match else name

        # The binary payload sits between the last '>' of the XML part and the close tag
        last_gt = blob_section.rfind(b">")
        if last_gt < 0:
            return device, prop_name, name, fmt, b"", -1

        bin_start = last_gt + 1
        bin_end = bin_start + size

        # Ensure we have enough data
        if len(self._recv_buffer) < bin_end:
            return None, None, None, "", b"", -1  # incomplete

        binary_data = self._recv_buffer[bin_start:bin_end]
        consumed = bin_end + len(close_tag)  # past the close tag

        # Skip any trailing newlines after the close tag
        while consumed < len(self._recv_buffer) and self._recv_buffer[consumed:consumed + 1] in (b"\n", b"\r"):
            consumed += 1

        log.info("BLOB: %s.%s [%s] size=%d format=%s (%d bytes)",
                 device, prop_name, name, size, fmt, len(binary_data))

        return device, prop_name, name, fmt, binary_data, consumed

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
