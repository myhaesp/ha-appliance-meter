"""Source-backed Shelly identities and deliberate ESPHome/Athom abstention."""
from pathlib import Path
import json
from unittest.mock import patch

import pytest
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import device_registry as dr, entity_registry as er
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.appliance_meter.config_flow import device_sensor_candidates, resolve_device_sensors
from custom_components.appliance_meter.const import DOMAIN
from custom_components.appliance_meter.energy_profiles import shelly_energy_kind

MAC = 'AABBCCDDEEFF'  # Synthetic namespace, never a manufacturer/OUI lookup.


@pytest.fixture
def native_shelly(hass):
    entry = MockConfigEntry(domain='shelly'); entry.add_to_hass(hass)
    device = dr.async_get(hass).async_get_or_create(config_entry_id=entry.entry_id,
        identifiers={('shelly', MAC)}, manufacturer='Unrelated label', name='Opaque device')
    return entry, device


def register(hass, entry, device, unique_id, *, device_class='energy', state_class='total_increasing',
             unit='kWh', translation_key=None, attributes=None, disabled=False, live=True, platform=None):
    entity = er.async_get(hass).async_get_or_create('sensor', platform or entry.domain, unique_id,
        config_entry=entry, suggested_object_id=f'opaque_{len(er.async_get(hass).entities)}',
        device_id=device.id, original_name='Arbitrary translated label',
        original_device_class=device_class, capabilities={'state_class': state_class},
        unit_of_measurement=unit, translation_key=translation_key,
        disabled_by=er.RegistryEntryDisabler.USER if disabled else None)
    if live:
        hass.states.async_set(entity.entity_id, '12', {'device_class': device_class,
            'state_class': state_class, 'unit_of_measurement': unit, **(attributes or {})})
    return entity


@pytest.mark.parametrize('component,imported,returned,device_identifier', [
    ('emdata:0', 'total_act', 'total_act_ret', MAC),
    *[('emdata:0', f'{phase}_total_act_energy', f'{phase}_total_act_ret_energy', f'{MAC}-em:0-{phase}')
      for phase in 'abc'],
    ('em1data:0', 'total_act_energy', 'total_act_ret_energy', MAC),
    ('em1data:2', 'total_act_energy', 'total_act_ret_energy', f'{MAC}-em1:2'),
])
async def test_native_shelly_import_export_without_names(hass, native_shelly, component, imported, returned, device_identifier):
    entry, device = native_shelly
    dr.async_get(hass).async_update_device(device.id, new_identifiers={('shelly', device_identifier)})
    consumed = register(hass, entry, device, f'{MAC}-{component}-{imported}')
    exported = register(hass, entry, device, f'{MAC}-{component}-{returned}', translation_key='energy_returned')
    # Opposite display names, user-renamed entity IDs and larger exports must not affect resolution.
    registry = er.async_get(hass)
    registry.async_update_entity(consumed.entity_id, name='Returned energy', new_entity_id='sensor.misleading_export')
    consumed = registry.async_get('sensor.misleading_export')
    registry.async_update_entity(exported.entity_id, name='Persistent consumption total')
    hass.states.async_set(exported.entity_id, '99999', {'device_class': 'energy', 'state_class': 'total_increasing', 'unit_of_measurement': 'kWh'})
    assert shelly_energy_kind(hass, consumed) == 'consumption'
    assert shelly_energy_kind(hass, exported) == 'returned'
    assert resolve_device_sensors(hass, device.id) == {'energy_sensor': consumed.entity_id}
    assert set(device_sensor_candidates(hass, device.id)['energy_sensor']) == {consumed.entity_id, exported.entity_id}


@pytest.mark.parametrize('override', ['export', 'clear'])
async def test_preselection_always_confirmed_and_manually_overridable(hass, native_shelly, override):
    entry, device = native_shelly
    power = register(hass, entry, device, 'opaque-power', device_class='power', state_class='measurement', unit='W')
    imported = register(hass, entry, device, f'{MAC}-emdata:0-total_act')
    exported = register(hass, entry, device, f'{MAC}-emdata:0-total_act_ret', translation_key='energy_returned')
    original_entries = {e.entry_id for e in hass.config_entries.async_entries(DOMAIN)}
    result = await hass.config_entries.flow.async_init(DOMAIN, context={'source': 'user'})
    result = await hass.config_entries.flow.async_configure(result['flow_id'], {
        'name': 'New appliance', 'device_id': device.id})
    assert result['type'] == FlowResultType.FORM and result['step_id'] == 'sensors'
    fields = result['data_schema'].schema
    assert next(k for k in fields if k == 'energy_sensor').description['suggested_value'] == imported.entity_id
    assert {e.entry_id for e in hass.config_entries.async_entries(DOMAIN)} == original_entries
    data = {'power_sensor': power.entity_id}
    if override == 'export':
        data['energy_sensor'] = exported.entity_id
    with patch('custom_components.appliance_meter.async_setup_entry', return_value=True):
        result = await hass.config_entries.flow.async_configure(result['flow_id'], data)
        await hass.async_block_till_done()
    assert result['type'] == FlowResultType.CREATE_ENTRY
    assert result['data'].get('energy_sensor') == (exported.entity_id if override == 'export' else None)


async def test_multiple_consumption_channels_do_not_auto_select(hass, native_shelly):
    entry, device = native_shelly
    register(hass, entry, device, f'{MAC}-emdata:0-total_act')
    register(hass, entry, device, f'{MAC}-emdata:1-total_act')
    register(hass, entry, device, f'{MAC}-emdata:0-total_act_ret')
    assert resolve_device_sensors(hass, device.id) == {}


@pytest.mark.parametrize('unique_id,translation_key', [
    (f'{MAC}-emdata:0-total_act_ret', None),
    (f'{MAC}-em1data:0-total_act_ret_energy', 'energy_consumed'),
    (f'{MAC}-switch:0-energy', None),
    (f'{MAC}-emdata:0-future_total_act', None),
    (f'{MAC}-emdata:0-total_act', 'energy_returned_with_channel_name'),
    ('Energy Consumption Total', 'energy_consumed'),
])
async def test_unknown_or_export_shelly_cannot_use_generic_total_fallback(hass, native_shelly, unique_id, translation_key):
    entry, device = native_shelly
    register(hass, entry, device, unique_id, state_class='total', translation_key=translation_key)
    assert resolve_device_sensors(hass, device.id) == {}


@pytest.mark.parametrize('problem', ['wrong_mac', 'wrong_device_channel', 'wrong_source_domain', 'wrong_device_entry'])
async def test_native_identity_requires_registry_provenance(hass, native_shelly, problem):
    entry, device = native_shelly
    unique_id = f'{MAC}-emdata:0-total_act'
    if problem == 'wrong_mac': unique_id = '112233445566-emdata:0-total_act'
    if problem == 'wrong_device_channel':
        dr.async_get(hass).async_update_device(device.id, new_identifiers={('shelly', f'{MAC}-em:0-b')})
        unique_id = f'{MAC}-emdata:0-a_total_act_energy'
    if problem == 'wrong_source_domain':
        entry = MockConfigEntry(domain='esphome'); entry.add_to_hass(hass)
    if problem == 'wrong_device_entry':
        entry = MockConfigEntry(domain='shelly'); entry.add_to_hass(hass)
    register(hass, entry, device, unique_id, platform='shelly')
    assert resolve_device_sensors(hass, device.id) == {}


@pytest.mark.parametrize('attributes', [
    {'last_reset': '2026-10-27T00:00:00Z'}, {'next_reset': '2026-10-28T00:00:00Z'},
    {'meter_period': 'daily'}, {'last_period': '1'}, {'restored': True},
])
async def test_periodic_or_restored_metadata_vetoes_native_profile(hass, native_shelly, attributes):
    entry, device = native_shelly
    register(hass, entry, device, f'{MAC}-emdata:0-total_act', attributes=attributes)
    assert resolve_device_sensors(hass, device.id) == {}


@pytest.mark.parametrize('availability', ['offline', 'disabled'])
async def test_perpetual_identity_not_state_class_proves_native_persistence(hass, native_shelly, availability):
    entry, device = native_shelly
    entity = register(hass, entry, device, f'{MAC}-emdata:0-total_act', live=False, disabled=availability == 'disabled')
    if availability == 'offline':
        hass.states.async_set(entity.entity_id, 'unavailable', {'device_class': 'energy', 'state_class': 'total_increasing', 'unit_of_measurement': 'kWh'})
    assert resolve_device_sensors(hass, device.id) == {'energy_sensor': entity.entity_id}
    assert er.async_get(hass).async_get(entity.entity_id).disabled_by == entity.disabled_by


@pytest.mark.parametrize('unit,state_class', [('MWh', 'total_increasing'), ('kWh', 'measurement'), ('kWh', None)])
async def test_native_profile_does_not_bypass_compatibility(hass, native_shelly, unit, state_class):
    entry, device = native_shelly
    register(hass, entry, device, f'{MAC}-emdata:0-total_act', unit=unit, state_class=state_class)
    assert resolve_device_sensors(hass, device.id) == {}


async def test_duplicate_energy_ownership_remains_enforced(hass, native_shelly):
    entry, device = native_shelly
    register(hass, entry, device, 'power', device_class='power', state_class='measurement', unit='W')
    imported = register(hass, entry, device, f'{MAC}-emdata:0-total_act')
    existing = MockConfigEntry(domain=DOMAIN, data={'name': 'Existing', 'energy_sensor': imported.entity_id})
    existing.add_to_hass(hass)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={'source': 'user'})
    result = await hass.config_entries.flow.async_configure(result['flow_id'], {'name': 'Other', 'device_id': device.id})
    assert result['errors'] == {'energy_sensor': 'energy_in_use'}
    assert existing.data == {'name': 'Existing', 'energy_sensor': imported.entity_id}


@pytest.mark.parametrize('manufacturer,model', [
    ('China Athom Technology', 'Athom Without Relay Plug'), ('Unknown', 'Custom ESPHome'), ('Shelly', 'Shelly Pro 3EM')])
async def test_athom_and_unknown_esphome_names_do_not_prove_persistence(hass, manufacturer, model):
    entry = MockConfigEntry(domain='esphome'); entry.add_to_hass(hass)
    device = dr.async_get(hass).async_get_or_create(config_entry_id=entry.entry_id,
        connections={('mac', 'aa:bb:cc:dd:ee:ff')}, manufacturer=manufacturer,
        model=model, sw_version='v2.0.11 (ESPHome 2026.10.0)')
    rows = json.loads((Path(__file__).parent/'fixtures/example_meter_sensors.json').read_text())
    for row in rows:
        if row['original_device_class'] not in {'energy', 'power'}:continue
        name = {'sensor.example_meter_power': 'Power', 'sensor.example_meter_energy': 'Energy',
                'sensor.example_meter_total_energy': 'Total Energy',
                'sensor.example_meter_total_energy_since_boot': 'Total Energy Since Boot'}[row['entity_id']]
        # These native API unique IDs are themselves derived from display names.
        entity = register(hass, entry, device, f'AA:BB:CC:DD:EE:FF/0/sensor/{name}',
            device_class=row['original_device_class'], state_class=row['capabilities']['state_class'],
            unit=row['unit_of_measurement'], attributes=row['attributes'])
        er.async_get(hass).async_update_entity(entity.entity_id, name=name)
    resolved = resolve_device_sensors(hass, device.id)
    assert 'power_sensor' in resolved
    assert 'energy_sensor' not in resolved
    assert len(device_sensor_candidates(hass, device.id)['energy_sensor']) == 3


async def test_shelly_shaped_unique_id_on_esphome_is_not_a_profile(hass):
    entry = MockConfigEntry(domain='esphome'); entry.add_to_hass(hass)
    device = dr.async_get(hass).async_get_or_create(config_entry_id=entry.entry_id, identifiers={('shelly', MAC)}, manufacturer='Shelly')
    register(hass, entry, device, f'{MAC}-emdata:0-total_act')
    assert resolve_device_sensors(hass, device.id) == {}


async def test_existing_export_assignment_and_accounting_are_never_reresolved(hass, native_shelly):
    source_entry, device = native_shelly
    imported = register(hass, source_entry, device, f'{MAC}-emdata:0-total_act')
    exported = register(hass, source_entry, device, f'{MAC}-emdata:0-total_act_ret')
    existing = MockConfigEntry(domain=DOMAIN, title='Existing', data={
        'name': 'Existing', 'energy_sensor': exported.entity_id})
    existing.add_to_hass(hass)
    assert await hass.config_entries.async_setup(existing.entry_id)
    hass.states.async_set(exported.entity_id, '13', {
        'device_class': 'energy', 'state_class': 'total_increasing', 'unit_of_measurement': 'kWh'})
    await hass.async_block_till_done()
    saved = existing.runtime_data.snapshot()
    identities = [(e.unique_id, e.entity_id) for e in er.async_entries_for_config_entry(er.async_get(hass), existing.entry_id)]
    assert resolve_device_sensors(hass, device.id)['energy_sensor'] == imported.entity_id
    with patch('custom_components.appliance_meter.config_flow.resolve_device_sensors', side_effect=AssertionError('Existing entry must not resolve')):
        assert await hass.config_entries.async_reload(existing.entry_id)
        await hass.async_block_till_done()
    assert existing.data['energy_sensor'] == exported.entity_id
    assert existing.runtime_data.snapshot() == saved
    assert [(e.unique_id, e.entity_id) for e in er.async_entries_for_config_entry(er.async_get(hass), existing.entry_id)] == identities
