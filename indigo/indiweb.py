"""indiweb.py — client for the INDI Web Manager (indi-web).

INDI drivers are **not** loadable over the INDI protocol (unlike INDIGO's
``Server/DRIVERS`` vector): they are spawned by ``indiserver``, which is
managed by the INDI Web Manager (``indi-web``, default port 8624).

This module talks to its REST API:

  GET  /api/drivers                 → all installable drivers
  GET  /api/server/drivers          → drivers currently running
  GET  /api/server/status           → indiserver status + active profile
  POST /api/drivers/start/<name>    → start a driver on the running server
  POST /api/drivers/stop/<name>     → stop a driver
  POST /api/server/start/<profile>  → start indiserver with a profile
  POST /api/server/stop             → stop indiserver
"""

from __future__ import annotations

import asyncio
import logging
import time
from urllib.parse import quote

import aiohttp

log = logging.getLogger("indigo.indiweb")

#: INDI driver ``family`` → Noctua UI category.
FAMILY_CATEGORIES = {
    "telescopes": "mount",
    "ccds": "camera",
    "guide cameras": "guide_camera",
    "guiders": "guide_camera",
    "filter wheels": "filter_wheel",
    "focusers": "focuser",
    "domes": "dome",
    "gps": "gps",
    "rotators": "rotator",
    "adaptive optics": "ao",
    "auxiliary": "aux",
    "agents": "agent",
    "weather": "weather",
    "spectrographs": "spectrograph",
    "detectors": "detector",
}

#: Binary prefixes (indi_<...>_<kind>) → category, used when ``family`` is
#: missing or unknown (custom drivers).
BINARY_CATEGORY_HINTS = [
    ("mount", ("telescope", "lx200", "eqmod", "onstep", "synscan", "celestron",
               "ioptron", "skywatcher", "gemini", "temma", "nexstar", "pmc8")),
    ("camera", ("ccd", "camera", "gphoto", "dslr", "asi", "qhy", "sbig",
                "atik", "toupcam", "playerone", "svbony", "altair", "ogma")),
    ("guide_camera", ("guide", "guider")),
    ("filter_wheel", ("wheel", "filter")),
    ("focuser", ("focus", "focuser")),
    ("dome", ("dome",)),
    ("rotator", ("rotator",)),
    ("gps", ("gps",)),
]


def categorize_driver(driver: dict) -> str:
    """Return the Noctua UI category for an indiweb driver entry."""
    family = str(driver.get("family") or "").strip().lower()
    if family in FAMILY_CATEGORIES:
        return FAMILY_CATEGORIES[family]
    binary = str(driver.get("binary") or "").lower()
    for category, hints in BINARY_CATEGORY_HINTS:
        if any(h in binary for h in hints):
            return category
    label = f"{driver.get('name', '')} {driver.get('label', '')}".lower()
    for category, hints in BINARY_CATEGORY_HINTS:
        if any(h in label for h in hints):
            return category
    return "other"


class IndiWebError(RuntimeError):
    """indiweb HTTP error."""


class IndiWebManager:
    """Async REST client for the INDI Web Manager."""

    def __init__(self, base_url: str, timeout: float = 4.0,
                 cache_ttl: float = 2.0):
        self.base_url = (base_url or "").rstrip("/")
        self.timeout = float(timeout)
        self.cache_ttl = float(cache_ttl)
        self._session: aiohttp.ClientSession | None = None
        self._lock = asyncio.Lock()
        self._drivers: list[dict] = []
        self._drivers_at = 0.0
        self._last_error = ""

    # ── HTTP plumbing ────────────────────────────────────────────

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            timeout = aiohttp.ClientTimeout(total=self.timeout)
            self._session = aiohttp.ClientSession(timeout=timeout)
        return self._session

    async def _request(self, method: str, path: str) -> tuple[int, object]:
        if not self.base_url:
            raise IndiWebError("indiweb URL not configured")
        url = f"{self.base_url}{path}"
        session = await self._ensure_session()
        try:
            async with session.request(method, url) as resp:
                text = await resp.text()
                data: object = None
                if text:
                    try:
                        data = await resp.json(content_type=None)
                    except Exception:  # noqa: BLE001
                        data = text
                return resp.status, data
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            self._last_error = str(e)
            raise IndiWebError(f"indiweb {method} {path}: {e}") from e

    async def close(self) -> None:
        if self._session is not None and not self._session.closed:
            await self._session.close()
        self._session = None

    # ── Queries ──────────────────────────────────────────────────

    async def server_status(self) -> dict:
        try:
            _status, data = await self._request("GET", "/api/server/status")
        except IndiWebError:
            return {"server": False, "active_profile": ""}
        if isinstance(data, list):
            # Older bottle release: [{"status": "False"}, {"active_profile": ""}]
            merged: dict = {}
            for part in data:
                if isinstance(part, dict):
                    merged.update(part)
            data = merged
        if not isinstance(data, dict):
            return {"server": False, "active_profile": ""}
        raw = data.get("server", data.get("status", False))
        running = str(raw).lower() in ("true", "1", "running", "on") if not isinstance(raw, bool) else raw
        return {"server": bool(running), "active_profile": data.get("active_profile", "")}

    async def running_driver_names(self) -> set[str]:
        try:
            _status, data = await self._request("GET", "/api/server/drivers")
        except IndiWebError:
            return set()
        names: set[str] = set()
        if not isinstance(data, list):
            return names
        for drv in data:
            if not isinstance(drv, dict):
                continue
            for key in ("name", "label", "binary"):
                val = drv.get(key)
                if val:
                    names.add(str(val))
        return names

    async def list_drivers(self, force: bool = False) -> list[dict]:
        """Return ``[{name,label,loaded,category,binary,family}]``.

        The driver catalogue and the running-driver list are fetched from
        indiweb; results are cached briefly to avoid hammering the API
        (the UI polls ``/api/drivers``).
        """
        async with self._lock:
            now = time.monotonic()
            if not force and self._drivers and now - self._drivers_at < self.cache_ttl:
                return [dict(d) for d in self._drivers]

            try:
                status, data = await self._request("GET", "/api/drivers")
            except IndiWebError as e:
                log.debug("indiweb drivers unavailable: %s", e)
                return [dict(d) for d in self._drivers]
            if status >= 400 or not isinstance(data, list):
                log.warning("indiweb /api/drivers returned %s", status)
                return [dict(d) for d in self._drivers]

            running = await self.running_driver_names()
            drivers: list[dict] = []
            for drv in data:
                if not isinstance(drv, dict):
                    continue
                name = str(drv.get("name") or drv.get("label") or drv.get("binary") or "")
                if not name:
                    continue
                label = str(drv.get("label") or name)
                binary = str(drv.get("binary") or "")
                loaded = bool(
                    name in running or label in running
                    or (binary and binary in running)
                )
                drivers.append({
                    "name": name,
                    "label": label,
                    "loaded": loaded,
                    "category": categorize_driver(drv),
                    "binary": binary,
                    "family": drv.get("family", ""),
                })
            drivers.sort(key=lambda d: (d["category"], d["name"].lower()))
            self._drivers = drivers
            self._drivers_at = now
            return [dict(d) for d in drivers]

    # ── Mutations ────────────────────────────────────────────────

    async def start_driver(self, name: str) -> dict:
        """Start (load) a driver on the running indiserver."""
        status, data = await self._request(
            "POST", f"/api/drivers/start/{quote(name, safe='')}")
        self._drivers_at = 0.0
        if status >= 400:
            raise IndiWebError(self._error_text(status, data))
        return {"ok": True, "driver": name}

    async def stop_driver(self, name: str) -> dict:
        """Stop (unload) a driver from the running indiserver."""
        status, data = await self._request(
            "POST", f"/api/drivers/stop/{quote(name, safe='')}")
        self._drivers_at = 0.0
        if status >= 400:
            raise IndiWebError(self._error_text(status, data))
        return {"ok": True, "driver": name}

    async def start_server(self, profile: str) -> dict:
        status, data = await self._request(
            "POST", f"/api/server/start/{quote(profile, safe='')}")
        self._drivers_at = 0.0
        if status >= 400:
            raise IndiWebError(self._error_text(status, data))
        return {"ok": True, "profile": profile}

    async def stop_server(self) -> dict:
        status, data = await self._request("POST", "/api/server/stop")
        self._drivers_at = 0.0
        if status >= 400:
            raise IndiWebError(self._error_text(status, data))
        return {"ok": True}

    @staticmethod
    def _error_text(status: int, data: object) -> str:
        if isinstance(data, dict):
            return str(data.get("error") or data.get("detail") or data)
        return str(data or f"HTTP {status}")
