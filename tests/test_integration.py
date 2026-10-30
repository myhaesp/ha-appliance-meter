from unittest.mock import patch
import pytest
from homeassistant.data_entry_flow import InvalidData
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import entity_registry as er
from pytest_homeassistant_custom_component.common import MockConfigEntry
from custom_components.appliance_meter.const import DOMAIN


def entry(hass, **data):
    result = MockConfigEntry(domain=DOMAIN, title=data.get('name', 'Washer'), data={'name': 'Washer', **data})
    result.add_to_hass(hass)
    return result


async def test_creation(hass):
    result = await hass.config_entries.flow.async_init(DOMAIN, context={'source': 'user'})
    assert {str(key) for key in result['data_schema'].schema} == {
        'name', 'appliance_type', 'device_id', 'price_sensor'}
    with patch('custom_components.appliance_meter.async_setup_entry', return_value=True):
        result = await hass.config_entries.flow.async_configure(result['flow_id'], {'name': ' Washer '})
        assert result['step_id'] == 'sensors'
        result = await hass.config_entries.flow.async_configure(result['flow_id'], {})
        await hass.async_block_till_done()
    assert result['type'] == FlowResultType.CREATE_ENTRY
    assert result['title'] == 'Washer'


async def test_duplicate_and_blank(hass):
    entry(hass, energy_sensor='sensor.energy')
    result = await hass.config_entries.flow.async_init(DOMAIN, context={'source': 'user'})
    result = await hass.config_entries.flow.async_configure(result['flow_id'], {'name': ' '})
    assert result['errors'] == {'name': 'blank_name'}
    result = await hass.config_entries.flow.async_configure(result['flow_id'], {'name': 'Other'})
    result = await hass.config_entries.flow.async_configure(result['flow_id'], {'energy_sensor': 'sensor.energy'})
    assert result['errors'] == {'energy_sensor': 'energy_in_use'}


async def test_options(hass):
    first = entry(hass, energy_sensor='sensor.energy')
    entry(hass, name='Other', energy_sensor='sensor.other')
    result = await hass.config_entries.options.async_init(first.entry_id)
    result = await hass.config_entries.options.async_configure(result['flow_id'], {'name': 'Renamed', 'energy_sensor': 'sensor.other'})
    assert result['errors'] == {'energy_sensor': 'energy_in_use'}
    result = await hass.config_entries.options.async_configure(result['flow_id'], {'name': 'Renamed', 'energy_sensor': 'sensor.energy'})
    assert result['type'] == FlowResultType.CREATE_ENTRY
    result = await hass.config_entries.options.async_init(first.entry_id)
    result = await hass.config_entries.options.async_configure(result['flow_id'], {'name': 'Renamed'})
    assert result['type'] == FlowResultType.CREATE_ENTRY
    assert first.options == {'name': 'Renamed'}
    assert first.title == 'Renamed'


async def test_entity_lifecycle(hass):
    appliance = entry(hass, power_sensor='sensor.physical')
    hass.states.async_set('sensor.physical', '1.25', {'unit_of_measurement': 'kW'})
    assert await hass.config_entries.async_setup(appliance.entry_id)
    await hass.async_block_till_done()
    registry = er.async_get(hass)
    entities = er.async_entries_for_config_entry(registry, appliance.entry_id)
    assert len(entities) == 4
    ids = {item.unique_id: item.entity_id for item in entities}
    power_id = ids[f'{appliance.entry_id}_power']
    assert float(hass.states.get(power_id).state) == 1250
    for key in ('energy_total', 'cost_total', 'unpriced_energy'):
        assert hass.states.get(ids[f'{appliance.entry_id}_{key}']).state == '0'
    for value in ('unavailable', 'unknown', 'NaN', 'Infinity', 'bad'):
        hass.states.async_set('sensor.physical', value, {'unit_of_measurement': 'W'})
        await hass.async_block_till_done()
        assert hass.states.get(power_id).state == 'unavailable'
    hass.config_entries.async_update_entry(appliance, options={'name': 'Renamed', 'power_sensor': 'sensor.replacement'})
    assert await hass.config_entries.async_reload(appliance.entry_id)
    await hass.async_block_till_done()
    assert {item.unique_id: item.entity_id for item in er.async_entries_for_config_entry(registry, appliance.entry_id)} == ids
    hass.states.async_set('sensor.replacement', '4', {'unit_of_measurement': 'W'})
    await hass.async_block_till_done()
    assert float(hass.states.get(power_id).state) == 4
    assert await hass.config_entries.async_unload(appliance.entry_id)
    await hass.async_block_till_done()


async def test_no_sources_and_feedback(hass):
    appliance = entry(hass)
    assert await hass.config_entries.async_setup(appliance.entry_id)
    await hass.async_block_till_done()
    entities = er.async_entries_for_config_entry(er.async_get(hass), appliance.entry_id)
    assert len(entities) == 4
    assert all(hass.states.get(item.entity_id).state ==
               ('unavailable' if item.unique_id.endswith('_power') else '0')
               for item in entities)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={'source': 'user'})
    result = await hass.config_entries.flow.async_configure(result['flow_id'], {'name': 'Loop'})
    with pytest.raises(InvalidData):
        await hass.config_entries.flow.async_configure(result['flow_id'], {'energy_sensor': entities[0].entity_id})
