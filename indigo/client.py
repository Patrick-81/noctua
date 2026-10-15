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
    build_detach_driver,
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
        self._connect_count = 0  # incrémenté à chaque connexion établie (détecte les reconnects)
        # Buffer de réception en bytearray : += et del [:n] sont en place
        # (pas de recopie à chaque recv — vital pour un BLOB de 100 Mo :
        # bytes immuables = O(n²) et dizaines de secondes).
        self._recv_buffer = bytearray()
        # Reprise de recherche du close-tag BLOB : offset jusqu'auquel
        # l'absence du tag est déjà prouvée (évite de rescanner 100 Mo à
        # chaque recv de 64 Ko pendant le download — autre O(n²)).
        self._blob_hint = 0
        self._connecting = False
        self._connect_gen = 0  # epoch: chaque connect() invalide les précédents

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
        self.on_blob_url: Callable[[str, str, str, str], Any] | None = None
        self.on_message: Callable[[str], Any] | None = None
        self.on_probes_done: Callable[[int, int], None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    @property
    def connected(self) -> bool:
        return self._connected

    # ── Connection lifecycle ──────────────────────────────────────

    async def connect(self) -> None:
        """Connect to the INDIGO server with auto-reconnect.

        Une seule génération active à la fois : chaque appel invalide les
        tâches connect() précédentes (changement d'IP/host en cours de
        retry), sinon deux sockets/threads se partagent _sock/_recv_buffer
        et les envois/réponses se perdent (park/unpark sans réponse).
        """
        if self._connecting:
            log.warning("connect() already in progress, ignoring duplicate call")
            return
        self._connecting = True
        self._connect_gen += 1
        gen = self._connect_gen
        # Ferme une socket orpheline d'une génération précédente pour
        # réveiller son thread de lecture (qui sort via le contrôle gen).
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass
            self._sock = None
        self._loop = asyncio.get_running_loop()
        while self._reconnect_try < MAX_RECONNECT and gen == self._connect_gen:
            sock: socket.socket | None = None
            try:
                log.info("Connecting to %s:%d ...", self._host, self._port)
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(5)
                sock.connect((self._host, self._port))
                self._sock = sock
                self._connected = True
                self._connect_count += 1
                self._reconnect_try = 0
                self._recv_buffer = bytearray()
                self._blob_hint = 0
                log.info("Connected to %s:%d", self._host, self._port)

                if self.on_connected:
                    self.on_connected(True)

                # Send getProperties handshake
                msg = build_get_properties()
                await self._send(msg)
                log.info("Sent getProperties handshake")

                # Start receive loop in a thread (blocking recv)
                recv_thread = threading.Thread(
                    target=self._recv_thread, args=(sock, gen), daemon=True)
                recv_thread.start()

                # Start probe loop
                probe_task = asyncio.create_task(self._probe_loop())

                # Wait until disconnected (ou génération remplacée)
                while self._connected and gen == self._connect_gen:
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
                if gen == self._connect_gen:
                    self._connected = False
                    # Ne ferme que NOTRE socket (une génération plus récente
                    # a déjà pu installer la sienne).
                    if sock is not None and self._sock is sock:
                        try:
                            self._sock.close()
                        except Exception:
                            pass
                        self._sock = None
                    if self.on_connected:
                        self.on_connected(False)
                else:
                    # Supplanté : ferme juste notre socket si orpheline.
                    if sock is not None and self._sock is not sock:
                        try:
                            sock.close()
                        except Exception:
                            pass

            if gen != self._connect_gen:
                log.info("connect(): superseded by newer generation, stopping")
                break

            # Reconnect with backoff
            self._reconnect_try += 1
            delay = RECONNECT_DELAY * min(self._reconnect_try, 5)
            log.info("Reconnecting in %.1fs (attempt %d/%d)...",
                     delay, self._reconnect_try, MAX_RECONNECT)
            # Sleep in small steps so we can break early if disconnect() is called
            elapsed = 0.0
            while (elapsed < delay and self._reconnect_try < MAX_RECONNECT
                   and gen == self._connect_gen):
                await asyncio.sleep(min(0.5, delay - elapsed))
                elapsed += 0.5

        if gen == self._connect_gen:
            log.warning("Max reconnect attempts reached, giving up.")
        self._connecting = False

    async def disconnect(self) -> None:
        self._connect_gen += 1  # invalide toute tâche connect() en cours
        self._reconnect_try = MAX_RECONNECT
        self._connected = False
        self._connecting = False
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass
            finally:
                self._sock = None

    # ── Sending ───────────────────────────────────────────────────

    async def _send(self, msg: str) -> None:
        if self._sock and self._connected:
            # PARK en INFO pour l'observatoire (était DEBUG invisible)
            if "MOUNT_PARK" in msg or "TELESCOPE_PARK" in msg:
                log.info("SEND: %s", msg.replace("\n", "\\n")[:500])
            else:
                log.debug("SEND: %s", msg.replace("\n", "\\n")[:200])
            try:
                self._sock.sendall((msg + "\n").encode())
            except Exception as e:
                # Ne touche PAS à _connected ici : le thread de réception
                # est seul propriétaire du flag. Un send stale (socket
                # d'une génération supplantée) ne doit pas tuer la
                # connexion fraîche — sinon park/home/slew deviennent
                # aléatoires après un changement d'host/reconnect.
                log.warning("Send error: %s", e)

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

    async def send_enable_blob(self, device: str | None = None,
                               prop_name: str | None = None,
                               mode: str = "URL") -> None:
        """Send <enableBLOB> message to request BLOB delivery.

        mode: 'URL' (v2, default) sends BLOBs as URLs to fetch.
              'Also' (legacy INDI) sends inline binary BLOBs.
        """
        if device and prop_name:
            msg = f'<enableBLOB device="{device}" name="{prop_name}">{mode}</enableBLOB>'
        elif device:
            msg = f'<enableBLOB device="{device}">{mode}</enableBLOB>'
        else:
            msg = f"<enableBLOB>{mode}</enableBLOB>"
        await self._send(msg)

    async def send_attach_driver(self, driver_name: str) -> None:
        await self._send(build_attach_driver(driver_name))

    async def send_detach_driver(self, driver_name: str) -> None:
        await self._send(build_detach_driver(driver_name))

    # ── Receiving (blocking thread) ───────────────────────────────

    def _recv_thread(self, sock: socket.socket, gen: int) -> None:
        """Blocking receive loop — runs in a daemon thread.

        Lié à (sock, gen) : un thread d'une génération supplantée sort
        dès qu'il se réveille (socket fermée par la nouvelle génération).
        """
        while self._connected and gen == self._connect_gen:
            try:
                data = sock.recv(65536)
                if not data:
                    log.warning("Connection closed by server")
                    if gen == self._connect_gen:
                        self._connected = False
                    break
                self._recv_buffer += data
                try:
                    self._process_buffer()
                except Exception as e:
                    log.error("Error processing buffer: %s", e, exc_info=True)
                    # Don't kill the connection for parse errors — skip bad data
                    self._recv_buffer = bytearray()
                    self._blob_hint = 0
            except socket.timeout:
                continue
            except Exception as e:
                if self._connected:
                    msg = str(e)
                    # Bad file descriptor lors d'un close/reconnect volontaire → debug
                    if "Bad file descriptor" in msg or "9" in msg:
                        log.debug("Receive error (expected on close): %s", e)
                    else:
                        log.warning("Receive error: %s", e)
                if gen == self._connect_gen:
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
        # Note: INDIGO uses both BLOB and Blob in tag names
        _re_vector = _re.compile(
            rb'<(def|set|status|new)(Number|Switch|Text|[Bb][Ll][Oo][Bb])Vector[\s/>]',
            _re.IGNORECASE)
        _re_selfclose = _re.compile(
            rb'<(?:getProperties|delProperty)\s[^>]*/>')

        complete_messages = []  # list of (tag_type_str, raw_xml_bytes)
        blob_messages = []      # list of (device, name, size, fmt, binary_data)

        while self._recv_buffer:
            # Strip des séparateurs \n\r SANS recopier le buffer (del en
            # place) — lstrip() copierait 100 Mo à chaque message pendant
            # le download d'un gros BLOB. Tout recadrage invalide le hint.
            if self._recv_buffer[0] in (10, 13):
                _k, _n = 1, len(self._recv_buffer)
                while _k < _n and self._recv_buffer[_k] in (10, 13):
                    _k += 1
                del self._recv_buffer[:_k]
                self._blob_hint = 0
                if not self._recv_buffer:
                    break

            # Self-closing tag
            m = _re_selfclose.match(self._recv_buffer)
            if m:
                complete_messages.append(("selfclose", bytes(m.group(0))))
                del self._recv_buffer[:m.end()]
                self._blob_hint = 0
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
                            "selfclose", bytes(self._recv_buffer[:tag_end])))
                        del self._recv_buffer[:tag_end]
                        self._blob_hint = 0
                        continue
                    # Content element — find matching close tag
                    tag_name = bytes(self._recv_buffer[1:tag_end].split(None, 1)[0])
                    close_tag = b"</" + tag_name + b">"
                    idx = self._recv_buffer.find(close_tag, tag_end)
                    if idx < 0:
                        break  # incomplete
                    msg_end = idx + len(close_tag)
                    complete_messages.append((
                        tag_name.decode("ascii", errors="replace"),
                        bytes(self._recv_buffer[:msg_end])))
                    del self._recv_buffer[:msg_end]
                    self._blob_hint = 0
                    continue
                # Not a known XML element — skip one line
                nl = self._recv_buffer.find(b"\n")
                if nl >= 0:
                    del self._recv_buffer[:nl + 1]
                    self._blob_hint = 0
                else:
                    break  # incomplete, wait for more data
                continue

            tag_type = bytes(m.group(1)) + bytes(m.group(2)) + b"Vector"  # e.g. b"defSwitchVector"
            close_tag = b"</" + tag_type + b">"

            # BLOB vector: extract binary payload inline
            # Only set/new Blob vectors contain binary data;
            # def Blob vectors are pure XML and handled as regular vectors.
            if b"lob" in bytes(m.group(2)).lower() and not tag_type.startswith(b"def"):
                device, prop_name, item_name, fmt, binary_data, consumed = (
                    self._extract_blob(tag_type, close_tag, self._blob_hint))
                if consumed < 0:
                    # Incomplet : mémorise jusqu'où le close-tag est exclu
                    # pour reprendre la recherche là (pas de rescan O(n²)).
                    # Le tag ne peut pas commencer avant cette borne, mais
                    # peut chevaucher la frontière des données à venir.
                    self._blob_hint = max(
                        0, len(self._recv_buffer) - len(close_tag) + 1)
                    break  # incomplete, wait for more data
                self._blob_hint = 0
                if device and self.on_blob and binary_data:
                    self._dispatch(self.on_blob, device, prop_name,
                                   item_name, fmt, binary_data)
                del self._recv_buffer[:consumed]
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
            open_pattern = bytes(m.group(0))  # e.g. b'<setNumberVector '
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
                bytes(self._recv_buffer[:msg_end]),
            ))
            del self._recv_buffer[:msg_end]
            self._blob_hint = 0

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

    def _extract_blob(self, tag_type: bytes, close_tag: bytes, search_from: int = 0):
        """Extract a BLOB from the buffer.

        Returns (device_name, prop_name, item_name, fmt, binary_data,
        consumed_bytes).  consumed_bytes is -1 if the message is incomplete.

        search_from: offset à partir duquel chercher le close-tag (reprise
        après un message incomplet — le début est déjà prouvé sans tag).

        INDIGO uses single quotes for attributes (device='...' name='...').

        Supports three modes:
        - URL-based (v2): oneBLOB with url attribute → dispatches on_blob_url
        - Inline base64 (v1.7/v2): oneBLOB with base64 text between tags → decodes
        - Inline binary (legacy): oneBLOB with raw binary after '>' (size bytes)
        """
        idx = self._recv_buffer.find(close_tag, search_from)
        if idx < 0:
            return None, None, None, "", b"", -1

        # Everything before </setBlobVector>
        blob_section = self._recv_buffer[:idx]

        # Extract device/property from parent vector tag
        header = self._recv_buffer[:idx + 200]
        dev_match = re.search(rb"""device=['"]([^'"]*)['"]""", header)
        device = dev_match.group(1).decode("utf-8", errors="replace") if dev_match else ""
        prop_match = re.search(rb"""name=['"]([^'"]*)['"]""", header)
        prop_name = prop_match.group(1).decode("utf-8", errors="replace") if prop_match else ""

        # Find the <oneBlob>/<oneBLOB>/<defBlob> element
        one_blob_match = re.search(
            rb"""<(?:oneBlob|oneBLOB|defBlob|defBLOB)\s([^>]*?)>""",
            blob_section)
        if not one_blob_match:
            # No blob element found — skip this message
            consumed = idx + len(close_tag)
            _n = len(self._recv_buffer)
            while consumed < _n and self._recv_buffer[consumed] in (10, 13):
                consumed += 1
                consumed += 1
            return device, prop_name, "", "", b"", consumed

        blob_attrs = one_blob_match.group(1)
        blob_tag_end = one_blob_match.end()  # position in blob_section

        # Parse attributes from the oneBlob element
        name_m = re.search(rb"""name=['"]([^'"]*)['"]""", blob_attrs)
        name = name_m.group(1).decode("utf-8", errors="replace") if name_m else ""
        fmt_m = re.search(rb"""format=['"]([^'"]*)['"]""", blob_attrs)
        fmt = fmt_m.group(1).decode("ascii", errors="replace") if fmt_m else ""
        size_m = re.search(rb"""size=['"](\d+)['"]""", blob_attrs)
        size = int(size_m.group(1)) if size_m else 0

        if not prop_name:
            prop_name = name

        # MODE 1: URL/Path-based BLOB (INDIGO v2)
        url_m = re.search(rb"""(?:url|path)=['"]([^'"]*)['"]""", blob_attrs)
        if url_m:
            blob_url = url_m.group(1).decode("utf-8", errors="replace")
            consumed = idx + len(close_tag)
            _n = len(self._recv_buffer)
            while consumed < _n and self._recv_buffer[consumed] in (10, 13):
                consumed += 1
                consumed += 1
            log.debug("BLOB URL: %s.%s [%s] url=%s", device, prop_name, name, blob_url)
            if device and self.on_blob_url:
                self._dispatch(self.on_blob_url, device, prop_name, name, blob_url)
            return device, prop_name, name, fmt, b"", consumed

        # MODE 2: Inline base64 — data between <oneBLOB ...> and </oneBLOB>
        # MODE 3: Inline binary — raw bytes after >, size attribute tells length
        #
        # We detect by checking for </oneBLOB> before the vector close tag.
        # If present → base64 text between tags.
        # If absent → raw binary after > for 'size' bytes.

        # Check for </oneBLOB> / </oneBlob> before </setBlobVector>
        one_blob_close = re.search(rb"</one[Bb][Ll][Oo][Bb]>", blob_section[blob_tag_end:])
        if one_blob_close:
            # Base64 inline: data is between <oneBLOB> closing '>' and </oneBLOB>
            b64_start = blob_tag_end
            b64_end = blob_tag_end + one_blob_close.start()
            b64_text = blob_section[b64_start:b64_end]

            import base64
            # Strip whitespace/newlines from base64 text
            b64_text = re.sub(rb'\s+', b'', b64_text)
            try:
                binary_data = base64.b64decode(b64_text)
            except Exception as e:
                log.error("BLOB base64 decode error for %s.%s: %s",
                          device, prop_name, e)
                consumed = idx + len(close_tag)
                _n = len(self._recv_buffer)
                while consumed < _n and self._recv_buffer[consumed] in (10, 13):
                    consumed += 1
                return device, prop_name, name, fmt, b"", consumed

            # Note : un désaccord taille déclarée / taille décodée ne signifie
            # PAS une troncature transport (TCP garantit la livraison ; une
            # vraie troncature se verrait comme message incomplet, pas comme
            # un base64 valide qui décode). Certains serveurs comptent la
            # taille base64 ou ajoutent un padding — on garde l'image dès que
            # le base64 décode, avec un simple warning. Ne jeter que le vide
            # (échec de décodage). Un rejet strict (!= ou <) jetterait 100 %
            # des images valides (« expose OK, pas d'image »).
            if size and len(binary_data) != size:
                log.warning("BLOB size mismatch %s.%s: declared=%d decoded=%d — keeping",
                            device, prop_name, size, len(binary_data))

            consumed = idx + len(close_tag)
            _n = len(self._recv_buffer)
            while consumed < _n and self._recv_buffer[consumed] in (10, 13):
                consumed += 1

            log.info("BLOB base64: %s.%s [%s] size=%d decoded=%d format=%s",
                     device, prop_name, name, size, len(binary_data), fmt)
            return device, prop_name, name, fmt, binary_data, consumed

        # Raw binary after '>' for 'size' bytes (legacy mode)
        bin_start = blob_tag_end  # blob_tag_end is right after '>'
        bin_end = bin_start + size

        if len(self._recv_buffer) < bin_end:
            return None, None, None, "", b"", -1  # incomplete

        binary_data = bytes(self._recv_buffer[bin_start:bin_end])
        consumed = idx + len(close_tag)
        _n = len(self._recv_buffer)
        while consumed < _n and self._recv_buffer[consumed] in (10, 13):
            consumed += 1

        log.debug("BLOB raw: %s.%s [%s] size=%d format=%s (%d bytes)",
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
            elif tag.startswith("set") or tag.startswith("status"):
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
