"""Logical entities with stable identities independent of physical sensors."""
from decimal import Decimal, InvalidOperation
from homeassistant.components.sensor import SensorEntity, SensorDeviceClass, SensorStateClass
from homeassistant.const import UnitOfPower, UnitOfEnergy
from homeassistant.core import callback
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.event import async_track_state_change_event
from .const import DOMAIN, CONF_POWER, settings, is_aggregate

DESCRIPTIONS = (
    ("power", "Power", UnitOfPower.WATT, SensorDeviceClass.POWER, SensorStateClass.MEASUREMENT),
    ("energy_total", "Energy Total", UnitOfEnergy.KILO_WATT_HOUR, SensorDeviceClass.ENERGY, SensorStateClass.TOTAL_INCREASING),
    ("cost_total", "Cost Total", "DKK", SensorDeviceClass.MONETARY, SensorStateClass.TOTAL),
    ("unpriced_energy", "Unpriced Energy", UnitOfEnergy.KILO_WATT_HOUR, SensorDeviceClass.ENERGY, SensorStateClass.TOTAL_INCREASING),
)


async def async_setup_entry(hass, entry, async_add_entities):
    if is_aggregate(entry):
        from .aggregate import AggregateSensor
        async_add_entities(AggregateSensor(entry, description) for description in DESCRIPTIONS)
    else:
        async_add_entities(ApplianceMeterSensor(entry, description) for description in DESCRIPTIONS)


class ApplianceMeterSensor(SensorEntity):
    """Stable logical sensors backed by shared persistent accounting."""
    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, entry, description):
        key, name, unit, device_class, state_class = description
        self._key = key
        self._accounting = getattr(entry, "runtime_data", None)
        self._source = settings(entry).get(CONF_POWER) if key == "power" else None
        self._attr_unique_id = f"{entry.entry_id}_{key}"
        self._attr_name = name
        self._attr_native_unit_of_measurement = (
            self._accounting.currency if key == "cost_total" and self._accounting else unit)
        self._attr_device_class = device_class
        self._attr_state_class = state_class
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)}, name=settings(entry)["name"])
        self._attr_available = False
        self._attr_native_value = None

    async def async_added_to_hass(self):
        if self._key != "power":
            self._accounting.listeners.add(self._accounting_changed)
            self.async_on_remove(lambda: self._accounting.listeners.discard(self._accounting_changed))
            self._accounting_changed()
        if self._source:
            self.async_on_remove(async_track_state_change_event(
                self.hass, [self._source], self._source_changed))
            self._read_power()

    @callback
    def _accounting_changed(self):
        self._attr_available = True
        self._attr_native_value = self._accounting.values[self._key]
        self.async_write_ha_state()

    @callback
    def _source_changed(self, event):
        self._read_power()
        self.async_write_ha_state()

    @callback
    def _read_power(self):
        state = self.hass.states.get(self._source)
        self._attr_available = False
        self._attr_native_value = None
        if state is None:
            return
        try:
            value = Decimal(state.state)
        except InvalidOperation:
            return
        factor = {"W": 1, "kW": 1000}.get(state.attributes.get("unit_of_measurement"))
        if value.is_finite() and factor is not None:
            self._attr_native_value = value * factor
            self._attr_available = True
