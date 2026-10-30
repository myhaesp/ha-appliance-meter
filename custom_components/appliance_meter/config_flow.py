"""Device-assisted appliance creation and editable sensor assignments."""
import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers import device_registry as dr, entity_registry as er, selector

from .energy_profiles import shelly_energy_kind

from .const import (
    DOMAIN, CONF_POWER, CONF_ENERGY, CONF_PRICE, CONF_DEVICE,
    SENSOR_FIELDS, settings,
    CONF_TYPE, TYPE_PHYSICAL, TYPE_AGGREGATE, CONF_MEMBERS, is_aggregate,
)


def schema(flow, values, *, include_name=True, candidates=None):
    """Exclude logical integration entities to prevent feedback loops."""
    hass = flow.hass
    registry = er.async_get(hass)
    excluded = [item.entity_id for item in registry.entities.values()
                if item.platform == DOMAIN]
    fields = {vol.Required("name"): selector.TextSelector()} if include_name else {}
    for key, device_class in ((CONF_POWER, "power"), (CONF_ENERGY, "energy"),
                              (CONF_PRICE, None)):
        if candidates is not None and key in candidates and not candidates[key]:
            continue
        config = {"domain": "sensor", "exclude_entities": excluded}
        if candidates is not None and key in candidates:
            config["include_entities"] = candidates[key]
        if device_class:
            config["device_class"] = device_class
        fields[vol.Optional(key)] = selector.EntitySelector(config)
    return flow.add_suggested_values_to_schema(
        vol.Schema(fields), values)


def sensor_metadata(hass, entity):
    """Combine registry metadata with current attributes without using names."""
    metadata = {**(entity.capabilities or {}),
                "device_class": entity.device_class or entity.original_device_class,
                "unit_of_measurement": entity.unit_of_measurement}
    if state := hass.states.get(entity.entity_id):
        metadata.update(state.attributes)
    return metadata


def is_appliance_device(hass, device_id):
    """Exclude virtual devices by registry ownership, never by display name."""
    device = dr.async_get(hass).async_get(device_id)
    if device is None:
        return False
    owner = hass.config_entries.async_get_entry(device.config_entry_id)
    return bool((owner and owner.domain == DOMAIN)
                or any(domain == DOMAIN for domain, _ in device.identifiers))


def device_error(hass, device_id):
    if dr.async_get(hass).async_get(device_id) is None:
        return "unknown_device"
    if is_appliance_device(hass, device_id):
        return "logical_device"
    return None


def assigned_device(hass, values):
    """Derive the editing aid from assignments without persisting a device binding."""
    registry = er.async_get(hass)
    device_ids = {entity.device_id for key in (CONF_POWER, CONF_ENERGY)
                  if (entity := registry.async_get(values.get(key, ""))) and entity.device_id}
    return next(iter(device_ids)) if len(device_ids) == 1 else None


def device_sensor_candidates(hass, device_id):
    """List accounting-compatible sensors; compatibility does not imply persistence."""
    candidates = {CONF_POWER: [], CONF_ENERGY: []}
    if is_appliance_device(hass, device_id):
        return candidates
    for entity in er.async_entries_for_device(
            er.async_get(hass), device_id, include_disabled_entities=True):
        if entity.domain != "sensor" or entity.platform == DOMAIN:
            continue
        metadata = sensor_metadata(hass, entity)
        device_class = metadata.get("device_class")
        state_class = metadata.get("state_class")
        unit = metadata.get("unit_of_measurement")
        if device_class == "power" and state_class == "measurement" and unit in {"W", "kW"}:
            candidates[CONF_POWER].append(entity.entity_id)
        if (device_class == "energy"
                and state_class in {"total", "total_increasing"}
                and unit in {"Wh", "kWh"}):
            candidates[CONF_ENERGY].append(entity.entity_id)
    return candidates


def persistent_energy(hass, entity):
    """Use HA's TOTAL-without-last_reset convention, never TOTAL_INCREASING alone.

    Generic sensors require current non-restored metadata. Native Shelly
    EMData/EM1Data identities additionally prove perpetual consumption semantics,
    including when offline. Names, icons and readings are never evidence.
    """
    state = hass.states.get(entity.entity_id)
    metadata = sensor_metadata(hass, entity)
    if any(metadata.get(key) is not None for key in (
            "last_reset", "next_reset", "meter_period", "last_period")):
        return False
    if entity.platform == "shelly":
        # Native perpetual-counter semantics establish persistence and direction;
        # TOTAL_INCREASING is only compatibility metadata, never the evidence.
        # Do not fall back to generic TOTAL for returned/unknown Shelly counters.
        return (not metadata.get("restored")
                and shelly_energy_kind(hass, entity) == "consumption")
    if (state is None or state.state in {"unknown", "unavailable"}
            or state.attributes.get("restored") or entity.platform == "utility_meter"):
        return False
    return state.attributes.get("state_class") == "total"


def resolve_device_sensors(hass, device_id):
    """Resolve Power independently; prefer only an unambiguous persistent Energy."""
    candidates = device_sensor_candidates(hass, device_id)
    resolved = {}
    if len(candidates[CONF_POWER]) == 1:
        resolved[CONF_POWER] = candidates[CONF_POWER][0]
    registry = er.async_get(hass)
    persistent = [entity_id for entity_id in candidates[CONF_ENERGY]
                  if persistent_energy(hass, registry.async_get(entity_id))]
    if len(persistent) == 1:
        resolved[CONF_ENERGY] = persistent[0]
    return resolved


def describe_candidates(hass, entity_ids):
    """Display labels for the user without using them to resolve sensors."""
    registry = er.async_get(hass)
    labels = []
    for entity_id in entity_ids:
        entity = registry.async_get(entity_id)
        state = hass.states.get(entity_id)
        name = (entity.name or (state.attributes.get("friendly_name") if state else None)
                or entity.original_name)
        labels.append(f"{name} ({entity_id})" if name else entity_id)
    return ", ".join(labels) or "—"


def validate(hass, data, entry_id=None):
    """Reject blank names, feedback loops, and duplicate energy assignments."""
    errors = {}
    if not data["name"].strip():
        errors["name"] = "blank_name"
    registry = er.async_get(hass)
    for key in SENSOR_FIELDS:
        entity = registry.async_get(data.get(key, ""))
        if entity and (entity.platform == DOMAIN
                       or (entity.device_id and is_appliance_device(hass, entity.device_id))):
            errors[key] = "logical_sensor"
    energy = data.get(CONF_ENERGY)
    if energy and any(entry.entry_id != entry_id and
                      settings(entry).get(CONF_ENERGY) == energy
                      for entry in hass.config_entries.async_entries(DOMAIN)):
        errors[CONF_ENERGY] = "energy_in_use"
    return errors


class ApplianceMeterConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Create exactly one appliance per entry; no discovery."""
    VERSION = 1

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        return ApplianceMeterOptionsFlow()

    async def async_step_user(self, user_input=None):
        if user_input is not None and user_input.get(CONF_TYPE) == TYPE_AGGREGATE:
            return await self.async_step_aggregate({"name": user_input.get("name", "")}, initial=True)
        errors = {}
        if user_input is not None:
            if not user_input["name"].strip():
                errors["name"] = "blank_name"
            device_id = user_input.get(CONF_DEVICE)
            if device_id and (error := device_error(self.hass, device_id)):
                errors[CONF_DEVICE] = error
            if not errors:
                # The device is only a creation aid; persist explicit assignments.
                self._pending = {key: value for key, value in user_input.items()
                                 if key not in (CONF_DEVICE, CONF_TYPE)}
                self._pending["name"] = self._pending["name"].strip()
                self._device_id = device_id
                resolved = resolve_device_sensors(self.hass, device_id) if device_id else {}
                self._pending.update(resolved)
                # Suggestions always need confirmation, so every assignment can
                # be overridden or cleared before any appliance is created.
                return await self.async_step_sensors()
        fields = {
            vol.Required("name"): selector.TextSelector(),
            vol.Optional(CONF_TYPE, default=TYPE_PHYSICAL): selector.SelectSelector({
                "options": [{"value": TYPE_PHYSICAL, "label": "Physical meter"},
                            {"value": TYPE_AGGREGATE, "label": "Aggregate / Custom Total"}],
                "mode": "dropdown"}),
            vol.Optional(CONF_DEVICE): selector.DeviceSelector(),
            vol.Optional(CONF_PRICE): selector.EntitySelector({"domain": "sensor",
                "exclude_entities": [item.entity_id for item in er.async_get(self.hass).entities.values()
                                     if item.platform == DOMAIN]}),
        }
        return self.async_show_form(
            step_id="user", errors=errors,
            data_schema=self.add_suggested_values_to_schema(
                vol.Schema(fields), user_input if user_input is not None
                else {}))

    async def async_step_aggregate(self, user_input=None, *, initial=False):
        data = user_input or {}
        errors = aggregate_errors(self.hass, data) if user_input is not None and not initial else {}
        if user_input is not None and not initial and not errors:
            return self._create_appliance(aggregate_data(data))
        return self.async_show_form(step_id="aggregate", errors=errors,
                                    data_schema=aggregate_schema(self, data))

    async def async_step_sensors(self, user_input=None):
        """Let the user resolve ambiguous channels, or leave sources unassigned."""
        data = (self._pending if user_input is None
                else {"name": self._pending["name"], **user_input})
        candidates = (device_sensor_candidates(self.hass, self._device_id)
                      if self._device_id else {CONF_POWER: [], CONF_ENERGY: []})
        errors = validate(self.hass, data)
        if self._device_id and (error := device_error(self.hass, self._device_id)):
            errors["base"] = error
        if self._device_id:
            for key in (CONF_POWER, CONF_ENERGY):
                if data.get(key) and data[key] not in candidates[key]:
                    errors[key] = "not_device_sensor"
        if user_input is not None and not errors:
            return self._create_appliance(data)
        return self.async_show_form(
            step_id="sensors", errors=errors,
            description_placeholders={
                "power_count": str(len(candidates[CONF_POWER])),
                "energy_count": str(len(candidates[CONF_ENERGY])),
                "power_candidates": describe_candidates(self.hass, candidates[CONF_POWER]),
                "energy_candidates": describe_candidates(self.hass, candidates[CONF_ENERGY]),
            },
            data_schema=schema(self, data, include_name=False,
                               candidates=candidates if self._device_id else None))

    @callback
    def _create_appliance(self, data):
        return self.async_create_entry(title=data["name"], data=data)


class ApplianceMeterOptionsFlow(config_entries.OptionsFlowWithReload):
    """Edit name and all assignments, including removing assignments."""

    async def async_step_init(self, user_input=None):
        if is_aggregate(self.config_entry):
            return await self.async_step_aggregate(user_input)
        errors = {}
        previous = settings(self.config_entry)
        if not hasattr(self, "_original_device"):
            self._original_device = assigned_device(self.hass, previous)
        original_device = self._original_device
        if user_input is not None:
            errors = validate(self.hass, user_input, self.config_entry.entry_id)
            device_id = user_input.get(CONF_DEVICE)
            if device_id:
                error = device_error(self.hass, device_id)
                unchanged = all(user_input.get(key) == previous.get(key)
                                for key in (CONF_POWER, CONF_ENERGY))
                # A missing existing device must not force clearing its assignments.
                if error and not (error == "unknown_device" and device_id == original_device and unchanged):
                    errors[CONF_DEVICE] = error
                if not error:
                    candidates = device_sensor_candidates(self.hass, device_id)
                    for key in (CONF_POWER, CONF_ENERGY):
                        value = user_input.get(key)
                        if (value and value not in candidates[key]
                                and not (device_id == original_device and value == previous.get(key))):
                            errors[key] = "not_device_sensor"
            if not errors:
                data = {key: value for key, value in user_input.items() if key != CONF_DEVICE}
                data["name"] = data["name"].strip()
                self.hass.config_entries.async_update_entry(
                    self.config_entry, title=data["name"])
                return self.async_create_entry(title="", data=data)
        values = dict(user_input) if user_input is not None else dict(previous)
        if user_input is None and original_device:
            values[CONF_DEVICE] = original_device
        fields = {vol.Required("name"): selector.TextSelector(),
                  vol.Optional(CONF_DEVICE): selector.DeviceSelector()}
        fields.update(schema(self, values, include_name=False).schema)
        return self.async_show_form(
            step_id="init", errors=errors,
            data_schema=self.add_suggested_values_to_schema(vol.Schema(fields), values))

    async def async_step_aggregate(self, user_input=None):
        errors = (aggregate_errors(self.hass, user_input, self.config_entry.entry_id)
                  if user_input is not None else {})
        if user_input is not None and not errors:
            data = aggregate_data(user_input)
            self.hass.config_entries.async_update_entry(self.config_entry, title=data["name"])
            return self.async_create_entry(title="", data=data)
        return self.async_show_form(step_id="aggregate", errors=errors,
            data_schema=aggregate_schema(self, settings(self.config_entry)
                                         if user_input is None else user_input))


def aggregate_data(data):
    """Persist only logical membership, never physical assignments."""
    return {"name": data["name"].strip(), CONF_TYPE: TYPE_AGGREGATE,
            CONF_MEMBERS: list(data[CONF_MEMBERS])}


def aggregate_errors(hass, data, entry_id=None):
    errors = {}
    if not data.get("name", "").strip():
        errors["name"] = "blank_name"
    members = data.get(CONF_MEMBERS, [])
    eligible = {entry.entry_id for entry in hass.config_entries.async_entries(DOMAIN)
                if entry.entry_id != entry_id and not is_aggregate(entry)}
    if not members:
        errors[CONF_MEMBERS] = "members_required"
    elif len(members) != len(set(members)):
        errors[CONF_MEMBERS] = "duplicate_members"
    elif any(member not in eligible for member in members):
        errors[CONF_MEMBERS] = "invalid_member"
    return errors


def aggregate_schema(flow, values):
    entries = [entry for entry in flow.hass.config_entries.async_entries(DOMAIN)
               if not is_aggregate(entry)]
    # Retain removed selections in the form so the user can explicitly remove them.
    options = [{"value": entry.entry_id, "label": entry.title}
               for entry in entries]
    known = {entry.entry_id for entry in entries}
    options.extend({"value": member, "label": "Missing appliance"}
                   for member in dict.fromkeys(values.get(CONF_MEMBERS, [])) if member not in known)
    return flow.add_suggested_values_to_schema(vol.Schema({
        vol.Required("name"): selector.TextSelector(),
        vol.Required(CONF_MEMBERS): selector.SelectSelector({"options": options,
            "multiple": True, "mode": "dropdown"}),
    }), values)
