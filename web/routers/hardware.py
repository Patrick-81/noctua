"""Hardware panel, profiles, filter wheel, generic property routes."""

import glob
import os
import re
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING

from .common import SanitizedJSONResponse, log

if TYPE_CHECKING:
    from ..server import WebServer


def _scan_serial_ports() -> list[dict]:
    """List serial nodes (ttyUSB/ttyACM) with stable by-id path, udev info, holders."""
    ports: list[dict] = []
    by_id_dir = Path("/dev/serial/by-id")
    links_by_target: dict[str, list[str]] = {}
    if by_id_dir.is_dir():
        for link in by_id_dir.iterdir():
            try:
                target = str(link.resolve())
                links_by_target.setdefault(target, []).append(str(link))
            except OSError:
                continue

    for pattern in ("/dev/ttyUSB*", "/dev/ttyACM*"):
        for path in sorted(glob.glob(pattern)):
            if not os.path.exists(path):
                continue
            by_id = sorted(links_by_target.get(path, []))
            description = ""
            try:
                r = subprocess.run(
                    ["udevadm", "info", "-q", "property", "-n", path],
                    capture_output=True, text=True, timeout=2,
                )
                props = dict(
                    line.split("=", 1)
                    for line in r.stdout.splitlines()
                    if "=" in line
                )
                parts = [props.get("ID_VENDOR", ""), props.get("ID_MODEL", "")]
                description = " ".join(p for p in parts if p).replace("_", " ")
            except (FileNotFoundError, subprocess.SubprocessError, OSError):
                pass
            holders: list[int] = []
            try:
                r = subprocess.run(
                    ["fuser", path], capture_output=True, text=True, timeout=1,
                )
                for tok in r.stdout.split():
                    if tok.strip().isdigit():
                        holders.append(int(tok))
            except (FileNotFoundError, subprocess.SubprocessError, OSError):
                pass
            ports.append({
                "path": path,
                "by_id": by_id,
                "preferred": by_id[0] if by_id else path,
                "description": description,
                "busy": bool(holders),
                "holders": holders,
            })
    return ports


def register(app, server: "WebServer") -> None:
    async def _connect_device(device_name: str) -> dict:
        if not device_name:
            return {"error": "no device specified"}
        dev = server.registry.get(device_name)
        if not dev:
            return {"error": f"device '{device_name}' not found"}
        # Si c'est la monture du profil actif et qu'un port y est renseigné,
        # on le pousse (DEVICE_PORT) avant le CONNECT — indispensable pour LX200.
        try:
            active = server.profiles.list_profiles().get("active")
            prof = server.profiles.get(active) if active else None
            if prof and prof.get("mount") == device_name and prof.get("mount_endpoint"):
                endpoint = prof["mount_endpoint"]
                for prop_name in ("DEVICE_PORT", "DEVICE_PORTS", "CONNECTION_PORT"):
                    pv = dev.get_prop(prop_name)
                    if pv and pv.items:
                        item_name_port = pv.items[0].name
                        for it in pv.items:
                            if it.name.upper() == "PORT":
                                item_name_port = it.name
                                break
                        try:
                            await dev.send_text(prop_name, [{"name": item_name_port, "value": endpoint}])
                            log.info("Applied mount port %s -> %s.%s (single connect)", endpoint, device_name, prop_name)
                        except Exception as e:  # noqa: BLE001
                            log.warning("Failed to set mount port for %s: %s", device_name, e)
                        break
        except Exception:  # noqa: BLE001
            pass
        # Determine the correct item name for CONNECT
        item_name = server.registry._connect_item_names.get(device_name, "CONNECT")
        conn_prop = dev.get_prop("CONNECTION")
        if conn_prop:
            connect_item = conn_prop.get_item("CONNECT") or conn_prop.get_item("CONNECTED")
            if connect_item:
                item_name = connect_item.name
        # Simple : on (re)lance une tentative unique ; l'Alert éventuel
        # remonte via ws:state (pv.message) pour demander le port à l'utilisateur.
        server.registry._auto_connecting.discard(device_name)
        log.info("Manual connect: %s (item=%s)", device_name, item_name)
        server.registry._schedule_connect(device_name, item_name)
        return {"ok": True, "device": device_name}

    async def _disconnect_device(device_name: str) -> dict:
        if not device_name:
            return {"error": "no device specified"}
        dev = server.registry.get(device_name)
        if not dev:
            return {"error": f"device '{device_name}' not found"}
        item_name = server.registry._connect_item_names.get(device_name, "CONNECT")
        conn_prop = dev.get_prop("CONNECTION")
        if conn_prop:
            connect_item = conn_prop.get_item("CONNECT") or conn_prop.get_item("CONNECTED")
            if connect_item:
                item_name = connect_item.name
        server.registry._auto_connecting.discard(device_name)
        await server.registry.client.send_new_switch(
            device_name, "CONNECTION", [{"name": item_name, "value": False}])
        # Marque comme déjà tenté pour éviter un re-connect auto sur le prochain def
        server.registry._auto_connecting.add(device_name)
        log.info("Manual disconnect: %s (item=%s)", device_name, item_name)
        return {"ok": True, "device": device_name}

    @app.get("/api/devices")
    async def get_devices():
        return SanitizedJSONResponse({
            name: dev.state_dict()
            for name, dev in server.registry.all_devices().items()
        })

    @app.get("/api/drivers")
    async def get_drivers():
        return SanitizedJSONResponse(server.registry.drivers_list())

    @app.get("/api/drivers/grouped")
    async def get_drivers_grouped():
        """Drivers loadables groupés par catégorie (mount, camera, …).

        Chaque entrée: {name, label, loaded, category}. Le groupement
        reflète la diversité des drivers exposés par le serveur INDIGO
        (indigo_mount_*, indigo_ccd_*, indigo_wheel_*, …).
        """
        return SanitizedJSONResponse(server.registry.drivers_grouped())

    @app.post("/api/drivers/attach")
    async def attach_driver(body: dict):
        """Attach (load) a driver on the INDIGO server."""
        driver_name = body.get("driver", "")
        if not driver_name:
            return {"error": "no driver specified"}
        c = server.registry.client
        if not c.connected:
            return {"error": "not connected to INDIGO server"}
        await c.send_attach_driver(driver_name)
        log.info("Attach driver: %s", driver_name)
        return {"ok": True, "driver": driver_name}

    @app.post("/api/drivers/detach")
    async def detach_driver(body: dict):
        """Detach (unload) a driver from the INDIGO server (best effort)."""
        driver_name = body.get("driver", "")
        if not driver_name:
            return {"error": "no driver specified"}
        c = server.registry.client
        if not c.connected:
            return {"error": "not connected to INDIGO server"}
        await c.send_detach_driver(driver_name)
        log.info("Detach driver: %s", driver_name)
        return {"ok": True, "driver": driver_name}

    @app.post("/api/device/connect")
    async def connect_device(body: dict):
        """Manually send CONNECT=On to a device."""
        return await _connect_device(body.get("device", ""))

    @app.get("/api/hardware")
    async def get_hardware():
        devices = {
            name: {
                "name": name,
                "type": getattr(dev, "DEVICE_TYPE", "generic"),
                "connected": bool(dev.connected),
            }
            for name, dev in server.registry.all_devices().items()
        }
        return {"devices": devices, "profiles": server.profiles.list_profiles()}

    @app.get("/api/serial/ports")
    async def list_serial_ports():
        """Scan host serial nodes and report active-profile endpoint health.

        Returns discovered ports (preferred stable by-id path first) plus
        ``profile`` showing whether the active profile's mount_endpoint still
        exists after USB re-enumeration (ttyUSB0 → ttyUSB1 → …).
        """
        ports = _scan_serial_ports()
        known_paths = {p["path"] for p in ports}
        known_paths.update(p for p in ports for p in p.get("by_id", []))
        profile_info: dict = {"name": None, "mount_endpoint": None, "exists": None}
        try:
            active = server.profiles.list_profiles().get("active")
            prof = server.profiles.get(active) if active else None
            if prof:
                endpoint = prof.get("mount_endpoint") or ""
                profile_info["name"] = active
                profile_info["mount_endpoint"] = endpoint or None
                if endpoint and re.match(r"^/dev/", endpoint):
                    profile_info["exists"] = os.path.exists(endpoint)
                    profile_info["in_scan"] = endpoint in known_paths
        except Exception as e:  # noqa: BLE001
            log.warning("Serial ports profile check failed: %s", e)
        return SanitizedJSONResponse({
            "ports": ports,
            "profile": profile_info,
        })

    @app.post("/api/hardware/connect")
    async def hardware_connect(body: dict):
        return await _connect_device(body.get("device", ""))

    @app.post("/api/hardware/disconnect")
    async def hardware_disconnect(body: dict):
        return await _disconnect_device(body.get("device", ""))

    @app.post("/api/hardware/connect-all")
    async def hardware_connect_all():
        results = [
            await _connect_device(name)
            for name in list(server.registry.all_devices().keys())
        ]
        return {"ok": True, "results": results}

    @app.post("/api/hardware/disconnect-all")
    async def hardware_disconnect_all():
        results = [
            await _disconnect_device(name)
            for name in list(server.registry.all_devices().keys())
        ]
        return {"ok": True, "results": results}

    @app.get("/api/profiles")
    async def get_profiles():
        return server.profiles.list_profiles()

    @app.post("/api/profiles")
    async def set_profile(body: dict):
        return server.profiles.upsert(body)

    @app.post("/api/profiles/activate")
    async def activate_profile(body: dict):
        return server.profiles.set_active(body.get("name", ""))

    @app.post("/api/profiles/delete")
    async def delete_profile(body: dict):
        return server.profiles.delete(body.get("name", ""))

    @app.post("/api/profiles/apply")
    async def apply_profile(body: dict):
        """Activate a profile and connect all devices it references."""
        name = body.get("name", "")
        act = server.profiles.set_active(name)
        if act.get("error"):
            return act
        # Si le profil précise un port monture, le pousser avant le CONNECT
        # pour que l'Alert éventuel remonte le bon diagnostic.
        prof = server.profiles.get(name)
        if prof and prof.get("mount") and prof.get("mount_endpoint"):
            mdev = server.registry.get(prof["mount"])
            if mdev:
                endpoint = prof["mount_endpoint"]
                for prop_name in ("DEVICE_PORT", "DEVICE_PORTS", "CONNECTION_PORT"):
                    pv = mdev.get_prop(prop_name)
                    if pv and pv.items:
                        item_name = pv.items[0].name
                        for it in pv.items:
                            if it.name.upper() == "PORT":
                                item_name = it.name
                                break
                        try:
                            await mdev.send_text(prop_name, [{"name": item_name, "value": endpoint}])
                            log.info("Applied mount port %s -> %s.%s", endpoint, prof["mount"], prop_name)
                        except Exception as e:  # noqa: BLE001
                            log.warning("Failed to set mount port: %s", e)
                        break
        results = []
        # Auto-attach des drivers manquants : si un device du profil n'est
        # pas encore découvert mais qu'un driver de même catégorie existe
        # côté INDIGO (déclaré non chargé), on demande son chargement.
        # L'appareil apparaîtra au prochain def et l'auto-connect le prendra.
        role_for_dev = {}
        if prof:
            for role in ("mount", "camera", "guide_camera", "focuser", "filter_wheel"):
                v = prof.get(role)
                if v:
                    role_for_dev[v] = role
        for dev_name in server.profiles.devices_for(name):
            if dev_name in server.registry.all_devices():
                results.append(await _connect_device(dev_name))
            else:
                # Tentative d'attach driver de même catégorie
                role = role_for_dev.get(dev_name, "")
                cat_map = {"mount": "mount", "camera": "camera", "guide_camera": "guide_camera",
                           "focuser": "focuser", "filter_wheel": "filter_wheel"}
                wanted = cat_map.get(role, "")
                attached = False
                if wanted and server.registry.client.connected:
                    for d in server.registry.drivers_list():
                        if not d.get("loaded") and d.get("category") == wanted:
                            try:
                                await server.registry.client.send_attach_driver(d["name"])
                                log.info("Auto-attach driver %s for missing device %s (role %s)", d["name"], dev_name, role)
                                attached = True
                            except Exception as e:  # noqa: BLE001
                                log.warning("Auto-attach failed %s: %s", d["name"], e)
                            break
                    # Fallback guide_camera → camera
                    if not attached and wanted == "guide_camera":
                        for d in server.registry.drivers_list():
                            if not d.get("loaded") and d.get("category") == "camera":
                                try:
                                    await server.registry.client.send_attach_driver(d["name"])
                                    log.info("Auto-attach driver %s for missing guide_camera %s", d["name"], dev_name)
                                    attached = True
                                except Exception:  # noqa: BLE001
                                    pass
                                break
                if attached:
                    results.append({"ok": False, "device": dev_name, "error": "device not found — driver attach requested, retry connect after it appears"})
                else:
                    results.append({"ok": False, "device": dev_name, "error": "device not found"})
        return {"ok": True, "active": name, "results": results}

    # ── Filter Wheel ─────────────────────────────────────────

    @app.get("/api/filterwheel")
    async def filterwheel_status():
        """Slots + current slot of the (first) filter wheel."""
        fw = server.registry.get_filterwheel()
        if not fw:
            return {"found": False, "name": None, "slots": [], "current": None}
        attached = fw.is_attached()
        return {
            "found": True,
            "name": fw.name,
            "connected": attached,
            "slots": fw.slots_list(),
            "current": fw.current_slot if attached else None,
        }

    @app.post("/api/filterwheel/slot")
    async def filterwheel_set_slot(body: dict):
        """Select a filter slot by name."""
        fw = server.registry.get_filterwheel()
        if not fw:
            return {"error": "no filter wheel detected"}
        name = body.get("slot", "") or body.get("name", "")
        if not name:
            return {"error": "no slot specified"}
        try:
            await fw.set_slot(name)
        except (RuntimeError, ValueError) as e:
            return {"error": str(e)}
        return {"ok": True, "slot": name}

    # ── Generic property setter ──────────────────────────────

    @app.post("/api/property")
    async def set_property(body: dict):
        """Send a property update to any device.

        body = {
            "device": "LX200 OnStep",
            "property": "DEVICE_PORT",
            "items": [{"name": "PORT", "value": "/dev/ttyUSB0"}]
        }
        """
        device_name = body.get("device", "")
        prop_name = body.get("property", "")
        items = body.get("items", [])

        dev = server.registry.get(device_name)
        if not dev:
            return {"error": f"device '{device_name}' not found"}

        pv = dev.get_prop(prop_name)
        if not pv:
            return {"error": f"property '{prop_name}' not found on '{device_name}'"}

        vtype = pv.vector_type.value
        if vtype == "switch":
            await dev.send_switch(prop_name, items)
        elif vtype == "number":
            await dev.send_number(prop_name, items)
        elif vtype == "text":
            await dev.send_text(prop_name, items)
        else:
            return {"error": f"unsupported vector type: {vtype}"}

        return {"ok": True}
