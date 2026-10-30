"""Read-only management projection of config entries and HA registries."""
from hashlib import sha256
from pathlib import Path

import voluptuous as vol

from homeassistant.components import panel_custom, websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import callback
from homeassistant.helpers import device_registry as dr, entity_registry as er

from .accounting import Accounting
from .config_flow import device_sensor_candidates, is_appliance_device
from .const import (
    DOMAIN, CONF_POWER, CONF_ENERGY, CONF_MEMBERS,
    SENSOR_FIELDS, is_aggregate, settings,
)

PANEL_PATH = "appliance-meter"
ASSET_PATH = "/appliance_meter_frontend"


def frontend_version(directory):
    """Version the complete asset tree so relative imports share the same version."""
    digest = sha256()
    for asset in sorted(path for path in directory.rglob("*") if path.is_file()):
        digest.update(asset.relative_to(directory).as_posix().encode())
        digest.update(b"\0")
        digest.update(asset.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()[:16]


async def async_setup_management(hass):
    """Register once per integration, independent of any appliance's lifetime."""
    directory = Path(__file__).parent / "frontend"
    version = await hass.async_add_executor_job(frontend_version, directory)
    asset_path = f"{ASSET_PATH}/{version}"
    await hass.http.async_register_static_paths([
        StaticPathConfig(asset_path, str(directory), cache_headers=False)
    ])
    websocket_api.async_register_command(hass, websocket_management)
    websocket_api.async_register_command(hass, websocket_cost_debug)
    await panel_custom.async_register_panel(
        hass, frontend_url_path=PANEL_PATH, webcomponent_name="appliance-meter-panel",
        sidebar_title="Appliance Meter", sidebar_icon="mdi:power-plug",
        module_url=f"{asset_path}/panel.js", require_admin=True,
    )
    await panel_custom.async_register_panel(
        hass, frontend_url_path="appliance-consumption",
        webcomponent_name="appliance-consumption-panel",
        sidebar_title=None,
        module_url=f"{asset_path}/consumption.js", require_admin=True,
    )


def management_data(hass):
    """Return an allowlisted view; never serialize entry data or runtime storage."""
    entries = hass.config_entries.async_entries(DOMAIN)
    by_id = {entry.entry_id: entry for entry in entries}
    entities = er.async_get(hass)
    devices = dr.async_get(hass)

    def device_name(device):
        return device.name_by_user or device.name or "Unnamed device"

    def sensor_info(entity_id):
        if not entity_id:
            return None
        entity = entities.async_get(entity_id)
        state = hass.states.get(entity_id)
        return {
            "entity_id": entity_id,
            "name": (entity.name if entity else None)
                    or (state.attributes.get("friendly_name") if state else None)
                    or (entity.original_name if entity else None) or entity_id,
            "device_id": entity.device_id if entity else None,
            "device_class": (state.attributes.get("device_class") if state else None)
                            or (entity.device_class or entity.original_device_class if entity else None),
        }

    result = []
    for entry in entries:
        values = settings(entry)
        aggregate = is_aggregate(entry)
        assignments = {} if aggregate else {
            key: sensor_info(values.get(key)) for key in SENSOR_FIELDS
        }
        source_devices = {
            item["device_id"] for key in (CONF_POWER, CONF_ENERGY)
            if (item := assignments.get(key)) and item["device_id"]
        }
        source_assignments = [assignments.get(key) for key in (CONF_POWER, CONF_ENERGY)]
        unresolved = any(item and not item["device_id"] for item in source_assignments)
        if len(source_devices) > 1:
            meter = "Multiple devices"
        elif source_devices:
            device = devices.async_get(next(iter(source_devices)))
            meter = device_name(device) if device else "Device unavailable"
            if unresolved:
                meter += " (some assignments unresolved)"
        else:
            meter = "Device unavailable" if any(source_assignments) else "Unassigned"
        members = [{"entry_id": member_id,
                    "name": by_id[member_id].title if member_id in by_id else "Missing appliance",
                    "missing": member_id not in by_id}
                   for member_id in values.get(CONF_MEMBERS, [])] if aggregate else []
        affected = [{"entry_id": other.entry_id, "name": other.title}
                    for other in entries if is_aggregate(other)
                    and entry.entry_id in settings(other).get(CONF_MEMBERS, [])]
        result.append({
            "entry_id": entry.entry_id, "name": entry.title,
            "type": "aggregate" if aggregate else "physical", "state": entry.state.value,
            "device_name": None if aggregate else meter,
            "assignments": assignments, "members": members, "affected_totals": affected,
            "sensors": {key: entities.async_get_entity_id("sensor", DOMAIN, f"{entry.entry_id}_{key}")
                        for key in ("power", "energy_total", "cost_total", "unpriced_energy")},
        })
    # Registry-only devices/sensors are included for disabled/unavailable choices.
    sensor_ids = {entity.entity_id for entity in entities.entities.values() if entity.domain == "sensor"}
    sensor_ids.update(state.entity_id for state in hass.states.async_all("sensor"))
    metering_devices = []
    for device in devices.devices:
        if is_appliance_device(hass, device.id):
            continue
        candidates = device_sensor_candidates(hass, device.id)
        entity_ids = sorted({entity_id for values in candidates.values() for entity_id in values})
        if not entity_ids:
            continue
        identifiers = {value for kind, value in device.connections if kind == "mac"}
        identifiers.update(value for _, value in device.identifiers)
        if device.serial_number:
            identifiers.add(device.serial_number)
        metering_devices.append({
            "value": device.id, "label": device_name(device),
            "identifiers": sorted(identifiers), "entity_ids": entity_ids,
            "unavailable": all((state := hass.states.get(entity_id)) is None
                               or state.state in {"unknown", "unavailable"}
                               or state.attributes.get("restored") for entity_id in entity_ids),
        })
    return {
        "entries": result,
        "devices": sorted(metering_devices, key=lambda device: device["label"].casefold()),
        "entities": [sensor_info(entity_id) for entity_id in sorted(sensor_ids)],
    }


@websocket_api.websocket_command({"type": "appliance_meter/management"})
@websocket_api.require_admin
@callback
def websocket_management(hass, connection, msg):
    connection.send_result(msg["id"], management_data(hass))


@websocket_api.websocket_command({
    "type": "appliance_meter/cost_debug", vol.Required("entry_id"): str,
})
@websocket_api.require_admin
@callback
def websocket_cost_debug(hass, connection, msg):
    """Expose only the bounded, volatile calculation trace for one appliance."""
    entry = hass.config_entries.async_get_entry(msg["entry_id"])
    if entry is None or entry.domain != DOMAIN:
        connection.send_error(msg["id"], "not_found", "Appliance not found")
        return
    accounting = getattr(entry, "runtime_data", None)
    available = not is_aggregate(entry) and isinstance(accounting, Accounting) and not accounting._closed
    connection.send_result(msg["id"], {
        "available": available,
        "currency": accounting.currency if available else None,
        "calculations": list(reversed(accounting.cost_calculations)) if available else [],
    })
