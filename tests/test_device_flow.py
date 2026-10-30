"""Device registry membership and sensor metadata drive creation, never names."""
import json
from pathlib import Path
from unittest.mock import patch

import pytest
from homeassistant.data_entry_flow import FlowResultType, InvalidData
from homeassistant.helpers import device_registry as dr, entity_registry as er, selector
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.appliance_meter.config_flow import device_sensor_candidates, resolve_device_sensors
from custom_components.appliance_meter.const import CONF_PRICE, DOMAIN


@pytest.fixture
def metering_device(hass):
    source = MockConfigEntry(domain='esphome')
    source.add_to_hass(hass)
    return dr.async_get(hass).async_get_or_create(
        config_entry_id=source.entry_id, identifiers={('esphome', 'physical')},
        manufacturer='Athom', name='Unrelated display name')


def sensor(hass, device, key, device_class, state_class, unit, *, disabled=False, state=None):
    entity = er.async_get(hass).async_get_or_create(
        'sensor', 'esphome', key, suggested_object_id=key, device_id=device.id,
        original_device_class=device_class, capabilities={'state_class': state_class},
        unit_of_measurement=unit,
        disabled_by=er.RegistryEntryDisabler.INTEGRATION if disabled else None)
    if state is not None:
        hass.states.async_set(entity.entity_id, state)
    return entity.entity_id


def pair(hass, device, suffix='', **kwargs):
    # Deliberately unrelated entity IDs: resolution must use metadata alone.
    power = sensor(hass, device, 'alpha'+suffix, 'power', 'measurement', 'W', **kwargs)
    energy = sensor(hass, device, 'beta'+suffix, 'energy', 'total_increasing', 'kWh', **kwargs)
    return {'power_sensor': power, 'energy_sensor': energy}


def persistent_pair(hass, device):
    selected = pair(hass, device)
    er.async_get(hass).async_update_entity(selected['energy_sensor'], capabilities={'state_class': 'total'})
    hass.states.async_set(selected['energy_sensor'], '100', {
        'device_class': 'energy', 'state_class': 'total', 'unit_of_measurement': 'kWh'})
    return selected


async def begin(hass, device=None, **values):
    result = await hass.config_entries.flow.async_init(DOMAIN, context={'source': 'user'})
    fields = result['data_schema'].schema
    assert isinstance(next(v for k, v in fields.items() if k == 'device_id'), selector.DeviceSelector)
    price_field = next(k for k in fields if k == CONF_PRICE)
    assert not price_field.description or 'suggested_value' not in price_field.description
    data = {'name': ' Fridge ', CONF_PRICE: "sensor.example_price", **values}
    if device:
        data['device_id'] = device.id
    return await hass.config_entries.flow.async_configure(result['flow_id'], data)


@pytest.mark.parametrize('availability', ['available', 'unavailable', 'disabled'])
async def test_single_channel_unknown_persistence_requires_confirmation(hass, metering_device, availability):
    expected = pair(hass, metering_device, disabled=availability == 'disabled',
                    state={'available': '1', 'unavailable': 'unavailable', 'disabled': None}[availability])
    # An unrelated sensor, and a valid pair on a different device, must not interfere.
    sensor(hass, metering_device, 'temperature', 'temperature', 'measurement', '°C')
    other = dr.async_get(hass).async_get_or_create(
        config_entry_id=metering_device.config_entry_id, identifiers={('esphome', 'other')})
    pair(hass, other, '_other')
    if availability == 'disabled':
        dr.async_get(hass).async_update_device(metering_device.id, disabled_by=dr.DeviceEntryDisabler.USER)
    with patch('custom_components.appliance_meter.async_setup_entry', return_value=True):
        result = await begin(hass, metering_device)
        assert result['step_id'] == 'sensors'
        fields = result['data_schema'].schema
        power_field = next(k for k in fields if k == 'power_sensor')
        assert power_field.description['suggested_value'] == expected['power_sensor']
        energy_field = next(k for k in fields if k == 'energy_sensor')
        assert 'suggested_value' not in (energy_field.description or {})
        result = await hass.config_entries.flow.async_configure(result['flow_id'], {**expected, CONF_PRICE: "sensor.example_price"})
        await hass.async_block_till_done()
    assert result['type'] == FlowResultType.CREATE_ENTRY
    assert result['data'] == {'name': 'Fridge', CONF_PRICE: "sensor.example_price", **expected}
    assert result['title'] == 'Fridge'


async def test_multichannel_device_requires_manual_selection(hass, metering_device):
    dr.async_get(hass).async_update_device(metering_device.id, manufacturer='Shelly')
    first = pair(hass, metering_device, '_channel_one')
    second = pair(hass, metering_device, '_channel_two')
    assert resolve_device_sensors(hass, metering_device.id) == {}
    result = await begin(hass, metering_device)
    assert result['step_id'] == 'sensors'
    assert result['errors'] == {}
    with patch('custom_components.appliance_meter.async_setup_entry', return_value=True):
        result = await hass.config_entries.flow.async_configure(result['flow_id'], {
            **second, CONF_PRICE: 'sensor.custom_price'})
        await hass.async_block_till_done()
    assert result['data'] == {'name': 'Fridge', **second, CONF_PRICE: 'sensor.custom_price'}
    assert first['energy_sensor'] != result['data']['energy_sensor']


@pytest.mark.parametrize('missing', ['power', 'energy', 'both', 'metadata'])
async def test_missing_sensors_allow_unassigned_creation(hass, metering_device, missing):
    if missing not in ('power', 'both'):
        sensor(hass, metering_device, 'one', 'power', 'measurement', 'W')
    if missing not in ('energy', 'both'):
        sensor(hass, metering_device, 'two', 'energy', None if missing == 'metadata' else 'total', 'Wh')
    result = await begin(hass, metering_device)
    assert result['step_id'] == 'sensors'
    with patch('custom_components.appliance_meter.async_setup_entry', return_value=True):
        result = await hass.config_entries.flow.async_configure(result['flow_id'], {})
        await hass.async_block_till_done()
    assert result['data'] == {'name': 'Fridge'}  # Clearing the suggested price is supported.


@pytest.mark.parametrize('kind,state_class,unit', [
    ('power', 'total', 'W'), ('power', 'measurement', 'VA'),
    ('energy', 'measurement', 'kWh'), ('energy', 'total', 'MWh'),
    ('energy', None, 'kWh')])
async def test_incompatible_metadata_never_auto_selects(hass, metering_device, kind, state_class, unit):
    if kind == 'power':
        sensor(hass, metering_device, 'one', 'power', state_class, unit)
        sensor(hass, metering_device, 'two', 'energy', 'total', 'kWh')
    else:
        sensor(hass, metering_device, 'one', 'power', 'measurement', 'W')
        sensor(hass, metering_device, 'two', 'energy', state_class, unit)
    result = await begin(hass, metering_device)
    assert result['step_id'] == 'sensors'


async def test_live_metadata_and_supported_units(hass, metering_device):
    for key, dc, sc, unit in [('one', 'power', 'measurement', 'kW'), ('two', 'energy', 'total', 'Wh')]:
        entity_id = sensor(hass, metering_device, key, None, None, None)
        hass.states.async_set(entity_id, 'unavailable', {
            'device_class': dc, 'state_class': sc, 'unit_of_measurement': unit})
    assert resolve_device_sensors(hass, metering_device.id) == {'power_sensor': 'sensor.one'}
    hass.states.async_set('sensor.two', '1', {
        'device_class': 'energy', 'state_class': 'total', 'unit_of_measurement': 'Wh'})
    assert resolve_device_sensors(hass, metering_device.id) == {
        'power_sensor': 'sensor.one', 'energy_sensor': 'sensor.two'}


async def test_duplicate_auto_assignment_falls_back_and_rejects(hass, metering_device):
    expected = persistent_pair(hass, metering_device)
    existing = MockConfigEntry(domain=DOMAIN, data={'name': 'Existing', **expected})
    existing.add_to_hass(hass)
    result = await begin(hass, metering_device)
    assert result['step_id'] == 'sensors'
    assert result['errors'] == {'energy_sensor': 'energy_in_use'}
    result = await hass.config_entries.flow.async_configure(result['flow_id'], expected)
    assert result['errors'] == {'energy_sensor': 'energy_in_use'}
    assert existing.data == {'name': 'Existing', **expected}


@pytest.mark.parametrize('price_value', ['sensor.alternative', None])
async def test_auto_price_override_and_clear(hass, metering_device, price_value):
    selected = persistent_pair(hass, metering_device)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={'source': 'user'})
    data = {'name': 'Fridge', 'device_id': metering_device.id}
    if price_value is not None:
        data[CONF_PRICE] = price_value
    with patch('custom_components.appliance_meter.async_setup_entry', return_value=True):
        result = await hass.config_entries.flow.async_configure(result['flow_id'], data)
        assert result['step_id'] == 'sensors'
        assignments = dict(selected)
        if price_value is not None:
            assignments[CONF_PRICE] = price_value
        result = await hass.config_entries.flow.async_configure(result['flow_id'], assignments)
        await hass.async_block_till_done()
    assert result['data'].get(CONF_PRICE) == price_value


async def test_unknown_device(hass):
    result = await hass.config_entries.flow.async_init(DOMAIN, context={'source': 'user'})
    result = await hass.config_entries.flow.async_configure(result['flow_id'], {
        'name': 'Fridge', 'device_id': 'not_registered'})
    assert result['errors'] == {'device_id': 'unknown_device'}


@pytest.mark.parametrize('extra', ['power', 'energy'])
async def test_one_ambiguous_side_is_not_a_pair(hass, metering_device, extra):
    pair(hass, metering_device)
    sensor(hass, metering_device, 'additional', extra,
           'measurement' if extra == 'power' else 'total', 'W' if extra == 'power' else 'kWh',
           disabled=True)
    result = await begin(hass, metering_device)
    assert result['step_id'] == 'sensors'


async def test_existing_entry_keeps_assignments_totals_baseline_and_ids(hass, metering_device):
    selected = pair(hass, metering_device)
    existing = MockConfigEntry(domain=DOMAIN, title='Existing',
                               data={'name': 'Original'}, options={'name': 'Existing', **selected})
    existing.add_to_hass(hass)
    hass.states.async_set(selected['energy_sensor'], '100', {'unit_of_measurement': 'kWh'})
    assert await hass.config_entries.async_setup(existing.entry_id)
    await hass.async_block_till_done()
    hass.states.async_set(selected['energy_sensor'], '101', {'unit_of_measurement': 'kWh'})
    await hass.async_block_till_done()
    registry = er.async_get(hass)
    ids = {e.unique_id: e.entity_id for e in er.async_entries_for_config_entry(registry, existing.entry_id)}
    # New metadata must not re-resolve or rebaseline an existing appliance on reload.
    pair(hass, metering_device, '_new_channel')
    with patch('custom_components.appliance_meter.config_flow.resolve_device_sensors', side_effect=AssertionError):
        assert await hass.config_entries.async_reload(existing.entry_id)
        await hass.async_block_till_done()
    assert existing.data == {'name': 'Original'}
    assert existing.options == {'name': 'Existing', **selected}
    assert existing.runtime_data.source == selected['energy_sensor']
    assert existing.runtime_data.price_source is None
    assert existing.runtime_data.last == 101
    assert tuple(existing.runtime_data.values.values()) == (1, 0, 1)
    assert {e.unique_id: e.entity_id for e in er.async_entries_for_config_entry(registry, existing.entry_id)} == ids


async def test_logical_and_non_sensor_entities_cannot_supply_pair(hass, metering_device):
    sensor(hass, metering_device, 'one', 'power', 'measurement', 'W')
    registry = er.async_get(hass)
    for domain, platform in [('sensor', DOMAIN), ('number', 'esphome')]:
        registry.async_get_or_create(
            domain, platform, 'logical_or_non_sensor', device_id=metering_device.id,
            original_device_class='energy', capabilities={'state_class': 'total_increasing'},
            unit_of_measurement='kWh')
    assert resolve_device_sensors(hass, metering_device.id) == {'power_sensor': 'sensor.one'}


@pytest.fixture
def example_meter_metadata():
    """Synthetic ESPHome-style metadata covering ambiguous energy counters."""
    return json.loads((Path(__file__).parent / 'fixtures/example_meter_sensors.json').read_text())


def register_example_meter(hass, device, rows, *, rename=False, registry_only=False):
    registry = er.async_get(hass)
    mapped = {}
    for index, row in enumerate(rows):
        object_id = f'opaque_{index}' if rename else row['entity_id'].split('.', 1)[1]
        entity = registry.async_get_or_create(
            'sensor', row['platform'], object_id, suggested_object_id=object_id,
            device_id=device.id, original_device_class=row['original_device_class'],
            capabilities=row['capabilities'], unit_of_measurement=row['unit_of_measurement'],
            disabled_by=er.RegistryEntryDisabler.INTEGRATION if registry_only else row['disabled_by'])
        mapped[row['entity_id']] = entity.entity_id
        if not registry_only:
            hass.states.async_set(entity.entity_id, row['state'], row['attributes'])
    return mapped


@pytest.mark.parametrize('rename', [False, True])
async def test_real_example_meter_metadata_reports_genuine_ambiguity(hass, metering_device, example_meter_metadata, rename):
    ids = register_example_meter(hass, metering_device, example_meter_metadata, rename=rename)
    expected_power = [ids['sensor.example_meter_power']]
    expected_energy = [ids[f'sensor.example_meter_{suffix}'] for suffix in (
        'energy', 'total_energy', 'total_energy_since_boot')]
    assert device_sensor_candidates(hass, metering_device.id) == {
        'power_sensor': expected_power, 'energy_sensor': expected_energy}
    assert resolve_device_sensors(hass, metering_device.id) == {'power_sensor': expected_power[0]}
    result = await begin(hass, metering_device)
    assert result['step_id'] == 'sensors'
    assert result['description_placeholders'] == {
        'power_count': '1', 'energy_count': '3',
        'power_candidates': ', '.join(expected_power),
        'energy_candidates': ', '.join(expected_energy)}
    # An explicit user choice, rather than a naming heuristic, resolves ambiguity.
    with patch('custom_components.appliance_meter.async_setup_entry', return_value=True):
        result = await hass.config_entries.flow.async_configure(result['flow_id'], {
            'power_sensor': expected_power[0], 'energy_sensor': expected_energy[1],
            CONF_PRICE: "sensor.example_price"})
        await hass.async_block_till_done()
    assert result['data']['energy_sensor'] == expected_energy[1]


@pytest.mark.parametrize('registry_only', [False, True])
async def test_real_metadata_with_one_resettable_energy_requires_confirmation(hass, metering_device, example_meter_metadata, registry_only):
    # Keep the actual device's metadata, with only one of its equally valid
    # energy entities registered. This is a simulated unambiguous device.
    rows = [row for row in example_meter_metadata if row['original_device_class'] != 'energy'
            or row['entity_id'] == 'sensor.example_meter_energy']
    ids = register_example_meter(hass, metering_device, rows, rename=True, registry_only=registry_only)
    result = await begin(hass, metering_device)
    assert result['step_id'] == 'sensors'
    assert resolve_device_sensors(hass, metering_device.id) == {
        'power_sensor': ids['sensor.example_meter_power']}
    fields = result['data_schema'].schema
    energy_field = next(k for k in fields if k == 'energy_sensor')
    assert 'suggested_value' not in (energy_field.description or {})


@pytest.mark.parametrize('label', ['daily', 'yesterday', 'session', 'lifetime'])
async def test_total_increasing_alone_never_establishes_persistence(hass, metering_device, label):
    selected = pair(hass, metering_device)
    hass.states.async_set(selected['energy_sensor'], '12', {
        'device_class': 'energy', 'state_class': 'total_increasing',
        'unit_of_measurement': 'kWh', 'friendly_name': label})
    assert resolve_device_sensors(hass, metering_device.id) == {'power_sensor': selected['power_sensor']}


async def test_prefer_persistent_total_over_unknown_or_periodic_energy(hass, metering_device):
    selected = persistent_pair(hass, metering_device)
    for key, attributes in [
        ('unknown_cycle', {}), ('periodic', {'last_reset': '2026-10-27T00:00:00+00:00',
                                          'next_reset': '2026-10-28T00:00:00+00:00'})]:
        entity_id = sensor(hass, metering_device, key, 'energy', 'total_increasing', 'kWh')
        hass.states.async_set(entity_id, '2', {
            'device_class': 'energy', 'state_class': 'total_increasing',
            'unit_of_measurement': 'kWh', **attributes})
    assert resolve_device_sensors(hass, metering_device.id) == selected
    with patch('custom_components.appliance_meter.async_setup_entry', return_value=True):
        result = await begin(hass, metering_device)
        assert result['step_id'] == 'sensors'
        fields = result['data_schema'].schema
        energy_field = next(key for key in fields if key == 'energy_sensor')
        assert energy_field.description['suggested_value'] == selected['energy_sensor']
        result = await hass.config_entries.flow.async_configure(result['flow_id'], selected)
        await hass.async_block_till_done()
    assert result['type'] == FlowResultType.CREATE_ENTRY
    assert result['data']['energy_sensor'] == selected['energy_sensor']


@pytest.mark.parametrize('key,value', [
    ('last_reset', '2026-10-27T00:00:00+00:00'),
    ('next_reset', '2026-10-28T00:00:00+00:00'),
    ('meter_period', 'daily'), ('last_period', '0'), ('restored', True)])
async def test_total_with_reset_or_restored_metadata_requires_choice(hass, metering_device, key, value):
    selected = persistent_pair(hass, metering_device)
    hass.states.async_set(selected['energy_sensor'], '100', {
        'device_class': 'energy', 'state_class': 'total',
        'unit_of_measurement': 'kWh', key: value})
    assert resolve_device_sensors(hass, metering_device.id) == {'power_sensor': selected['power_sensor']}


async def test_multiple_persistent_totals_remain_ambiguous(hass, metering_device):
    selected = persistent_pair(hass, metering_device)
    extra = sensor(hass, metering_device, 'second_total', 'energy', 'total', 'kWh')
    hass.states.async_set(extra, '200', {
        'device_class': 'energy', 'state_class': 'total', 'unit_of_measurement': 'kWh'})
    result = await begin(hass, metering_device)
    assert result['step_id'] == 'sensors'
    assert resolve_device_sensors(hass, metering_device.id) == {'power_sensor': selected['power_sensor']}


async def test_energy_resolves_independently_of_ambiguous_power(hass, metering_device):
    selected = persistent_pair(hass, metering_device)
    sensor(hass, metering_device, 'second_power', 'power', 'measurement', 'W')
    assert resolve_device_sensors(hass, metering_device.id) == {'energy_sensor': selected['energy_sensor']}
    result = await begin(hass, metering_device)
    fields = result['data_schema'].schema
    assert result['step_id'] == 'sensors'
    assert next(k for k in fields if k == 'energy_sensor').description['suggested_value'] == selected['energy_sensor']
    assert 'suggested_value' not in (next(k for k in fields if k == 'power_sensor').description or {})


async def test_manual_candidates_are_restricted_to_selected_device(hass, metering_device):
    selected = pair(hass, metering_device)
    other = dr.async_get(hass).async_get_or_create(
        config_entry_id=metering_device.config_entry_id, identifiers={('esphome', 'other')})
    other_pair = pair(hass, other, '_other')
    result = await begin(hass, metering_device)
    fields = result['data_schema'].schema
    for key in ('power_sensor', 'energy_sensor'):
        assert next(v for k, v in fields.items() if k == key).config['include_entities'] == [selected[key]]
        with pytest.raises(InvalidData):
            await hass.config_entries.flow.async_configure(result['flow_id'], {key: other_pair[key]})
    # Revalidate device membership even if it changes after the form is rendered.
    er.async_get(hass).async_update_entity(selected['energy_sensor'], device_id=other.id)
    result = await hass.config_entries.flow.async_configure(result['flow_id'], selected)
    assert result['errors'] == {'energy_sensor': 'not_device_sensor'}


async def test_candidate_display_uses_names_and_ids(hass, metering_device):
    selected = pair(hass, metering_device)
    er.async_get(hass).async_update_entity(selected['energy_sensor'], name='Selected custom label')
    hass.states.async_set(selected['power_sensor'], '1', {'friendly_name': 'Live Power label'})
    result = await begin(hass, metering_device)
    assert result['description_placeholders']['power_candidates'] == f"Live Power label ({selected['power_sensor']})"
    assert result['description_placeholders']['energy_candidates'] == f"Selected custom label ({selected['energy_sensor']})"


async def test_explicit_null_last_reset_is_non_resetting_total(hass, metering_device):
    selected = persistent_pair(hass, metering_device)
    hass.states.async_set(selected['energy_sensor'], '100', {
        'device_class': 'energy', 'state_class': 'total',
        'unit_of_measurement': 'kWh', 'last_reset': None})
    assert resolve_device_sensors(hass, metering_device.id) == selected


async def test_registry_only_total_does_not_prove_reset_behavior(hass, metering_device):
    power = sensor(hass, metering_device, 'one', 'power', 'measurement', 'W', disabled=True)
    sensor(hass, metering_device, 'two', 'energy', 'total', 'kWh', disabled=True)
    assert resolve_device_sensors(hass, metering_device.id) == {'power_sensor': power}
    result = await begin(hass, metering_device)
    assert result['description_placeholders']['energy_count'] == '1'
    assert result['step_id'] == 'sensors'


async def test_utility_meter_cannot_establish_persistence_from_total_alone(hass, metering_device):
    selected = pair(hass, metering_device)
    helper = er.async_get(hass).async_get_or_create(
        'sensor', 'utility_meter', 'periodic', device_id=metering_device.id,
        original_device_class='energy', capabilities={'state_class': 'total'},
        unit_of_measurement='kWh')
    hass.states.async_set(helper.entity_id, '100', {
        'device_class': 'energy', 'state_class': 'total', 'unit_of_measurement': 'kWh'})
    assert resolve_device_sensors(hass, metering_device.id) == {'power_sensor': selected['power_sensor']}


@pytest.mark.parametrize('aggregate', [False, True])
async def test_virtual_device_rejected_by_creation_and_options_even_with_other_platform_sensors(hass, aggregate):
    virtual = MockConfigEntry(domain=DOMAIN, title='Virtual', data={
        'name': 'Virtual', **({'appliance_type': 'aggregate', 'members': []} if aggregate else {})})
    virtual.add_to_hass(hass)
    device = dr.async_get(hass).async_get_or_create(config_entry_id=virtual.entry_id,
        identifiers={(DOMAIN, virtual.entry_id)}, name='Looks like hardware')
    # Suitability alone must not bypass ownership exclusion.
    fake_sensor = sensor(hass, device, 'disguised', 'power', 'measurement', 'W')
    assert device_sensor_candidates(hass, device.id) == {'power_sensor': [], 'energy_sensor': []}
    result = await hass.config_entries.flow.async_init(DOMAIN, context={'source': 'user'})
    result = await hass.config_entries.flow.async_configure(result['flow_id'], {
        'name': 'New', 'device_id': device.id})
    assert result['errors'] == {'device_id': 'logical_device'}
    hass.config_entries.flow.async_abort(result['flow_id'])
    existing = MockConfigEntry(domain=DOMAIN, title='Existing', data={'name': 'Existing'})
    existing.add_to_hass(hass)
    result = await hass.config_entries.options.async_init(existing.entry_id)
    result = await hass.config_entries.options.async_configure(result['flow_id'], {
        'name': 'Existing', 'device_id': device.id})
    assert result['errors'] == {'device_id': 'logical_device'}
    assert existing.options == {}
    result = await hass.config_entries.options.async_configure(result['flow_id'], {
        'name': 'Existing', 'power_sensor': fake_sensor})
    assert result['errors'] == {'power_sensor': 'logical_sensor'}
    assert existing.options == {}
    hass.config_entries.options.async_abort(result['flow_id'])


async def test_options_device_is_derived_transient_and_preserves_accounting_and_entities(hass, metering_device):
    selected = pair(hass, metering_device)
    existing = MockConfigEntry(domain=DOMAIN, title='Existing', data={'name': 'Existing', **selected})
    existing.add_to_hass(hass)
    hass.states.async_set(selected['energy_sensor'], '100', {'unit_of_measurement': 'kWh'})
    assert await hass.config_entries.async_setup(existing.entry_id)
    await hass.async_block_till_done()
    hass.states.async_set(selected['energy_sensor'], '101', {'unit_of_measurement': 'kWh'})
    await hass.async_block_till_done()
    registry = er.async_get(hass)
    ids = {entity.unique_id: entity.entity_id for entity in er.async_entries_for_config_entry(registry, existing.entry_id)}
    original = dict(existing.data)
    with patch('custom_components.appliance_meter.config_flow.resolve_device_sensors', side_effect=AssertionError('Do not re-resolve existing assignments')):
        result = await hass.config_entries.options.async_init(existing.entry_id)
        device_field = next(key for key in result['data_schema'].schema if key == 'device_id')
        assert device_field.description['suggested_value'] == metering_device.id
        result = await hass.config_entries.options.async_configure(result['flow_id'], {
            'name': 'Existing', 'device_id': metering_device.id, **selected})
        await hass.async_block_till_done()
    assert result['type'] == FlowResultType.CREATE_ENTRY
    assert existing.data == original
    assert existing.options == {'name': 'Existing', **selected}
    assert 'device_id' not in existing.options
    assert existing.runtime_data.last == 101
    assert tuple(existing.runtime_data.values.values()) == (1, 0, 1)
    assert {entity.unique_id: entity.entity_id for entity in er.async_entries_for_config_entry(registry, existing.entry_id)} == ids


async def test_edit_device_switch_requires_explicit_sensor_choices_and_keeps_manual_override(hass, metering_device):
    selected = pair(hass, metering_device)
    other = dr.async_get(hass).async_get_or_create(config_entry_id=metering_device.config_entry_id,
        identifiers={('esphome', 'other-device')})
    other_selected = pair(hass, other, '_replacement')
    existing = MockConfigEntry(domain=DOMAIN, title='Existing', data={'name': 'Existing', **selected})
    existing.add_to_hass(hass)
    result = await hass.config_entries.options.async_init(existing.entry_id)
    result = await hass.config_entries.options.async_configure(result['flow_id'], {
        'name': 'Existing', 'device_id': other.id, **selected})
    assert result['errors'] == {'power_sensor': 'not_device_sensor', 'energy_sensor': 'not_device_sensor'}
    assert existing.options == {}
    with patch('custom_components.appliance_meter.async_setup_entry', return_value=True):
        result = await hass.config_entries.options.async_configure(result['flow_id'], {
            'name': 'Existing', 'device_id': other.id, **other_selected})
        await hass.async_block_till_done()
    assert result['data'] == {'name': 'Existing', **other_selected}


@pytest.mark.parametrize('disappears', [False, True])
async def test_edit_retains_unavailable_or_missing_previous_assignments(hass, metering_device, disappears):
    selected = pair(hass, metering_device)
    existing = MockConfigEntry(domain=DOMAIN, title='Existing', data={'name': 'Existing', **selected})
    existing.add_to_hass(hass)
    result = await hass.config_entries.options.async_init(existing.entry_id)
    if disappears:
        dr.async_get(hass).async_remove_device(metering_device.id)
    else:
        for entity_id in selected.values():
            hass.states.async_set(entity_id, 'unavailable')
    with patch('custom_components.appliance_meter.async_setup_entry', return_value=True):
        result = await hass.config_entries.options.async_configure(result['flow_id'], {
            'name': 'Existing', 'device_id': metering_device.id, **selected})
        await hass.async_block_till_done()
    assert result['type'] == FlowResultType.CREATE_ENTRY
    assert existing.options == {'name': 'Existing', **selected}


async def test_device_removed_during_creation_is_revalidated_before_save(hass, metering_device):
    selected = pair(hass, metering_device)
    result = await begin(hass, metering_device)
    dr.async_get(hass).async_remove_device(metering_device.id)
    result = await hass.config_entries.flow.async_configure(result['flow_id'], selected)
    assert result['type'] == FlowResultType.FORM
    assert result['errors']['base'] == 'unknown_device'
    assert hass.config_entries.async_entries(DOMAIN) == []
    hass.config_entries.flow.async_abort(result['flow_id'])
