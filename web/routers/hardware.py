"""Hardware panel, profiles, filter wheel, generic property routes."""

from typing import TYPE_CHECKING

from .common import SanitizedJSONResponse, log

if TYPE_CHECKING:
    from ..server import WebServer


def register(app, server: "WebServer") -> None:
    async def _connect_device(device_name: str) -> dict:
        if not device_name:
            return {"error": "no device specified"}
        dev = server.registry.get(device_name)
        if not dev:
            return {"error": f"device '{device_name}' not found"}
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
