"""Narrow, source-backed semantic profiles, never display-name heuristics.

See docs/energy-resolution.md for the HA 2026.10.4 identity format and Shelly
EMData/EM1Data perpetual-counter contracts. Unknown identities fail closed.
"""
import re

from homeassistant.helpers import device_registry as dr

# Native HA Shelly RPC identities: <MAC>-<component>:<index>-<attribute>.
_RPC_ID = re.compile(r"([0-9a-fA-F]{12})-(emdata|em1data):(0|[1-9][0-9]*)-([a-z_]+)")
_EMDATA_IMPORT = {"total_act", "a_total_act_energy", "b_total_act_energy", "c_total_act_energy"}
_EMDATA_EXPORT = {"total_act_ret", "a_total_act_ret_energy", "b_total_act_ret_energy", "c_total_act_ret_energy"}
_RETURNED_TRANSLATIONS = {"energy_returned", "energy_returned_with_channel_name"}


def shelly_energy_kind(hass, entity):
    """Identify only native, correctly associated EMData/EM1Data counters.

    The MAC prefix checks namespace/association, not vendor identity. A model,
    manufacturer, entity ID, original name or translated label is not evidence.
    """
    if entity.platform != "shelly" or not (match := _RPC_ID.fullmatch(entity.unique_id)):
        return None
    source = hass.config_entries.async_get_entry(entity.config_entry_id)
    device = dr.async_get(hass).async_get(entity.device_id)
    if (source is None or source.domain != "shelly" or device is None
            or source.entry_id not in device.config_entries):
        return None
    mac, component, index, attribute = match.groups()
    if component == "emdata":
        if attribute not in _EMDATA_IMPORT | _EMDATA_EXPORT:
            return None
        kind = "consumption" if attribute in _EMDATA_IMPORT else "returned"
        identifiers = {mac.lower()}
        if attribute[0] in "abc" and attribute[1:2] == "_":
            identifiers.add(f"{mac}-em:{index}-{attribute[0]}".lower())
    else:
        if attribute not in {"total_act_energy", "total_act_ret_energy"}:
            return None
        kind = "consumption" if attribute == "total_act_energy" else "returned"
        identifiers = {mac.lower(), f"{mac}-em1:{index}".lower()}
    associated = any(domain == "shelly" and identifier.lower() in identifiers
                     for domain, identifier in device.identifiers)
    associated |= any(domain == dr.CONNECTION_NETWORK_MAC
                      and address.replace(":", "").lower() == mac.lower()
                      for domain, address in device.connections)
    if not associated:
        return None
    # An explicit contradictory integration translation key vetoes selection.
    if kind == "consumption" and entity.translation_key in _RETURNED_TRANSLATIONS:
        return None
    return kind
