"""Constants for appliance_meter."""
DOMAIN = "appliance_meter"
CONF_DEVICE = "device_id"
CONF_POWER = "power_sensor"
CONF_ENERGY = "energy_sensor"
CONF_PRICE = "price_sensor"
SENSOR_FIELDS = (CONF_POWER, CONF_ENERGY, CONF_PRICE)
CONF_TYPE = "appliance_type"
TYPE_PHYSICAL = "physical"
TYPE_AGGREGATE = "aggregate"
CONF_MEMBERS = "members"


def settings(entry):
    """Options are a complete replacement, allowing assignments to be cleared."""
    return entry.options if entry.options else entry.data


def is_aggregate(entry):
    """Legacy entries remain physical without a migration."""
    return settings(entry).get(CONF_TYPE, TYPE_PHYSICAL) == TYPE_AGGREGATE
