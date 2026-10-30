"""One manually configured entry per appliance."""
from homeassistant.const import Platform
from homeassistant.helpers import config_validation as cv

from .accounting import Accounting
from .const import DOMAIN, is_aggregate

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

PLATFORMS = [Platform.SENSOR]


async def async_setup(hass, config):
    """Initialize the management surface without changing appliance state."""
    from .management import async_setup_management
    await async_setup_management(hass)
    return True


async def async_setup_entry(hass, entry):
    """Restore accounting before registering the four logical sensors."""
    if is_aggregate(entry):
        await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
        return True
    accounting = Accounting(hass, entry)
    await accounting.async_start()
    entry.runtime_data = accounting
    try:
        await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    except Exception:
        await accounting.async_close()
        raise
    return True


async def async_unload_entry(hass, entry):
    """Unload the appliance and flush its accounting state."""
    if not await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        return False
    if not is_aggregate(entry):
        await entry.runtime_data.async_close()
    return True


async def async_remove_entry(hass, entry):
    """Permanently remove only this appliance's private accounting store."""
    from .accounting import accounting_store
    await accounting_store(hass, entry).async_remove()
