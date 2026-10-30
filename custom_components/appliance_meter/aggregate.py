"""Read-only current sums of logical appliances; no accounting or storage."""
from decimal import Decimal

from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.core import callback
from homeassistant.helpers import entity_registry as er

from .accounting import number
from .const import CONF_MEMBERS, DOMAIN, is_aggregate, settings
from .sensor import ApplianceMeterSensor


class AggregateSensor(ApplianceMeterSensor):
    """Publish a sum only when every selected member has a valid logical value."""

    def __init__(self, entry, description):
        super().__init__(entry, description)
        self._members = tuple(settings(entry).get(CONF_MEMBERS, []))
        self._sources = set()
        self._attr_extra_state_attributes = {"member_entry_ids": list(self._members)}
        # Membership edits change lifetime sums discontinuously. Never feed those
        # changes into long-term consumption/cost statistics.
        if self._key != "power":
            self._attr_state_class = None

    async def async_added_to_hass(self):
        self.async_on_remove(self.hass.bus.async_listen(EVENT_STATE_CHANGED, self._state_changed))
        self.async_on_remove(self.hass.bus.async_listen(er.EVENT_ENTITY_REGISTRY_UPDATED, self._registry_changed))
        self._update()

    @callback
    def _registry_changed(self, event):
        self._update()

    @callback
    def _state_changed(self, event):
        entity_id = event.data["entity_id"]
        entity = er.async_get(self.hass).async_get(entity_id)
        if entity_id in self._sources or (entity and entity.config_entry_id in self._members):
            self._update()

    @callback
    def _update(self):
        registry = er.async_get(self.hass)
        self._attr_available = False
        self._attr_native_value = None
        self._sources = set()
        total = Decimal(0)
        currency = None
        valid = bool(self._members) and len(set(self._members)) == len(self._members)
        for member_id in self._members:
            member = self.hass.config_entries.async_get_entry(member_id)
            entity_id = registry.async_get_entity_id("sensor", DOMAIN, f"{member_id}_{self._key}")
            if entity_id:
                self._sources.add(entity_id)
            state = self.hass.states.get(entity_id) if entity_id else None
            value = number(state.state) if state else None
            if self._key == "cost_total" and state:
                member_currency = state.attributes.get("unit_of_measurement")
                if currency is None:
                    currency = member_currency
                    self._attr_native_unit_of_measurement = currency
                elif currency != member_currency:
                    valid = False
            if (member is None or member.domain != DOMAIN or is_aggregate(member)
                    or state is None or state.attributes.get("restored")
                    or state.attributes.get("unit_of_measurement") != self.native_unit_of_measurement
                    or value is None):
                valid = False
            else:
                total += value
        if valid:
            self._attr_available = True
            self._attr_native_value = total
        self.async_write_ha_state()
