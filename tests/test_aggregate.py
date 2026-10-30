"""Custom Totals sum logical lifetimes without owning member accounting."""
from decimal import Decimal

import pytest
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.storage import Store
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.appliance_meter.const import DOMAIN
from custom_components.appliance_meter.config_flow import aggregate_errors

KEYS = ('power', 'energy_total', 'cost_total', 'unpriced_energy')


def entity_id(hass, entry, key):
    return er.async_get(hass).async_get_entity_id('sensor', DOMAIN, f'{entry.entry_id}_{key}')


def state(hass, entry, key):
    return hass.states.get(entity_id(hass, entry, key))


async def physical(hass, name, *, energy='10', power='20', price='2'):
    source = f'sensor.{name.lower()}_physical'
    hass.states.async_set(source, energy, {'unit_of_measurement': 'kWh'})
    hass.states.async_set(source+'_power', power, {'unit_of_measurement': 'W'})
    if price is not None:
        hass.states.async_set(source+'_price', price, {'unit_of_measurement': 'DKK/kWh'})
    entry = MockConfigEntry(domain=DOMAIN, title=name, data={
        'name': name, 'energy_sensor': source, 'power_sensor': source+'_power',
        'price_sensor': source+'_price'})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    hass.states.async_set(source, str(Decimal(energy)+1), {'unit_of_measurement': 'kWh'})
    await hass.async_block_till_done()
    return entry


async def aggregate(hass, members):
    entry = MockConfigEntry(domain=DOMAIN, title='Example Group', data={
        'name': 'Example Group', 'appliance_type': 'aggregate',
        'members': [member.entry_id for member in members]})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def test_sum_metadata_updates_and_no_accounting(hass):
    first = await physical(hass, 'Server')
    second = await physical(hass, 'Cooling', power='30', price=None)
    group = await aggregate(hass, [first, second])
    assert [state(hass, group, k).state for k in KEYS] == ['50', '2', '2', '1']
    for key, unit, device_class in zip(KEYS, ['W', 'kWh', 'DKK', 'kWh'], ['power', 'energy', 'monetary', 'energy']):
        attrs = state(hass, group, key).attributes
        assert attrs['unit_of_measurement'] == unit
        assert attrs['device_class'] == device_class
        assert attrs.get('state_class') == ('measurement' if key == 'power' else None)
    assert await Store(hass, 1, f'{DOMAIN}.{group.entry_id}').async_load() is None
    assert not hasattr(group, 'runtime_data')
    hass.states.async_set('sensor.server_physical', '12', {'unit_of_measurement': 'kWh'})
    await hass.async_block_till_done()
    assert state(hass, group, 'energy_total').state == '3'
    assert state(hass, group, 'cost_total').state == '4'
    # Logical entity renames keep stable member references working.
    old_id = entity_id(hass, first, 'power')
    er.async_get(hass).async_update_entity(old_id, new_entity_id='sensor.renamed_server_power')
    await hass.async_block_till_done()
    assert state(hass, group, 'power').state == '50'


@pytest.mark.parametrize('bad', ['unavailable', 'unknown', 'NaN', 'Infinity', 'bad'])
async def test_missing_value_is_not_zero_and_recovers(hass, bad):
    first = await physical(hass, 'Server')
    second = await physical(hass, 'Cooling')
    group = await aggregate(hass, [first, second])
    source = entity_id(hass, first, 'energy_total')
    hass.states.async_set(source, bad, {'unit_of_measurement': 'kWh'})
    await hass.async_block_till_done()
    assert state(hass, group, 'energy_total').state == 'unavailable'
    assert state(hass, group, 'cost_total').state == '4'
    hass.states.async_set(source, '1', {'unit_of_measurement': 'kWh'})
    await hass.async_block_till_done()
    assert state(hass, group, 'energy_total').state == '2'
    hass.states.async_set('sensor.server_physical_power', 'unavailable', {'unit_of_measurement': 'W'})
    await hass.async_block_till_done()
    assert state(hass, group, 'power').state == 'unavailable'
    assert state(hass, group, 'energy_total').state == '2'


async def test_native_creation_options_membership_and_delete(hass):
    first = await physical(hass, 'Server')
    second = await physical(hass, 'Cooling')
    snapshots = {e.entry_id: (dict(e.data), dict(e.options), e.runtime_data.snapshot()) for e in [first, second]}
    flow = await hass.config_entries.flow.async_init(DOMAIN, context={'source': 'user'})
    flow = await hass.config_entries.flow.async_configure(flow['flow_id'], {
        'name': ' Example Group ', 'appliance_type': 'aggregate'})
    assert flow['step_id'] == 'aggregate'
    field = next(v for k,v in flow['data_schema'].schema.items() if k == 'members')
    assert field.config['multiple'] is True
    assert {o['value'] for o in field.config['options']} == {first.entry_id, second.entry_id}
    for members, error in [([], 'members_required'), ([first.entry_id]*2, 'duplicate_members')]:
        flow = await hass.config_entries.flow.async_configure(flow['flow_id'], {
            'name': 'IT', 'members': members})
        assert flow['errors'] == {'members': error}
    flow = await hass.config_entries.flow.async_configure(flow['flow_id'], {
        'name': ' Example Group ', 'members': [first.entry_id]})
    assert flow['type'] == FlowResultType.CREATE_ENTRY
    group = flow['result']
    await hass.async_block_till_done()
    ids = [entity_id(hass, group, key) for key in KEYS]
    assert state(hass, group, 'energy_total').state == '1'
    for members, expected in [([first.entry_id, second.entry_id], '2'), ([second.entry_id], '1')]:
        flow = await hass.config_entries.options.async_init(group.entry_id)
        flow = await hass.config_entries.options.async_configure(flow['flow_id'], {
            'name': 'Renamed group', 'members': members})
        assert flow['type'] == FlowResultType.CREATE_ENTRY
        await hass.async_block_till_done()
        assert state(hass, group, 'energy_total').state == expected
        assert 'state_class' not in state(hass, group, 'energy_total').attributes
        assert [entity_id(hass, group, key) for key in KEYS] == ids
    assert {e.entry_id: (dict(e.data), dict(e.options), e.runtime_data.snapshot()) for e in [first, second]} == snapshots
    assert set(group.options) == {'name', 'appliance_type', 'members'}
    assert await hass.config_entries.async_remove(group.entry_id)
    await hass.async_block_till_done()
    assert {e.entry_id: (dict(e.data), dict(e.options), e.runtime_data.snapshot()) for e in [first, second]} == snapshots
    assert all(state(hass, e, 'energy_total').state == '1' for e in [first, second])
    hass.states.async_set('sensor.server_physical', '12', {'unit_of_measurement': 'kWh'})
    await hass.async_block_till_done()
    assert all(hass.states.get(eid) is None for eid in ids)


async def test_removed_member_requires_explicit_membership_edit(hass):
    first = await physical(hass, 'Server')
    second = await physical(hass, 'Cooling')
    group = await aggregate(hass, [first, second])
    assert await hass.config_entries.async_remove(first.entry_id)
    await hass.async_block_till_done()
    assert all(state(hass, group, k).state == 'unavailable' for k in KEYS)
    flow = await hass.config_entries.options.async_init(group.entry_id)
    field = next(v for k,v in flow['data_schema'].schema.items() if k == 'members')
    assert any(o['value'] == first.entry_id and 'Missing' in o['label'] for o in field.config['options'])
    flow = await hass.config_entries.options.async_configure(flow['flow_id'], {
        'name': 'IT', 'members': [first.entry_id, second.entry_id]})
    assert flow['errors'] == {'members': 'invalid_member'}
    flow = await hass.config_entries.options.async_configure(flow['flow_id'], {
        'name': 'IT', 'members': [second.entry_id]})
    await hass.async_block_till_done()
    assert state(hass, group, 'energy_total').state == '1'


async def test_restart_order_and_member_baseline_preserved(hass):
    member = await physical(hass, 'Server')
    group = await aggregate(hass, [member])
    baseline = member.runtime_data.snapshot()
    ids = [entity_id(hass, group, k) for k in KEYS]
    assert await hass.config_entries.async_unload(group.entry_id)
    assert await hass.config_entries.async_unload(member.entry_id)
    await hass.async_block_till_done()
    assert await hass.config_entries.async_setup(group.entry_id)
    await hass.async_block_till_done()
    assert all(state(hass, group, k).state == 'unavailable' for k in KEYS)
    assert await hass.config_entries.async_setup(member.entry_id)
    await hass.async_block_till_done()
    assert member.runtime_data.snapshot() == baseline
    assert state(hass, group, 'energy_total').state == '1'
    assert [entity_id(hass, group, k) for k in KEYS] == ids
    hass.states.async_set('sensor.server_physical', '12', {'unit_of_measurement': 'kWh'})
    await hass.async_block_till_done()
    assert state(hass, group, 'energy_total').state == '2'


async def test_duplicates_nested_and_invalid_members_rejected(hass):
    member = await physical(hass, 'Server')
    group = await aggregate(hass, [member])
    for members, error in [([], 'members_required'), ([member.entry_id]*2, 'duplicate_members'),
                           ([group.entry_id], 'invalid_member'), (['removed'], 'invalid_member')]:
        assert aggregate_errors(hass, {'name': 'IT', 'members': members}) == {'members': error}
    flow = await hass.config_entries.options.async_init(group.entry_id)
    field = next(v for k,v in flow['data_schema'].schema.items() if k == 'members')
    assert group.entry_id not in {o['value'] for o in field.config['options']}
    flow = await hass.config_entries.options.async_configure(flow['flow_id'], {
        'name': 'IT', 'members': [member.entry_id, member.entry_id]})
    assert flow['errors'] == {'members': 'duplicate_members'}
    # Corrupt/imported duplicate membership also fails closed at runtime.
    corrupt = MockConfigEntry(domain=DOMAIN, title='Duplicate', data={
        'name': 'Duplicate', 'appliance_type': 'aggregate', 'members': [member.entry_id]*2})
    corrupt.add_to_hass(hass)
    assert await hass.config_entries.async_setup(corrupt.entry_id)
    await hass.async_block_till_done()
    assert all(state(hass, corrupt, k).state == 'unavailable' for k in KEYS)


@pytest.mark.parametrize('attributes', [
    {'unit_of_measurement': 'kWh', 'restored': True},
    {'unit_of_measurement': 'MWh'},
    {},
])
async def test_untrusted_units_and_restored_values_fail_closed(hass, attributes):
    member = await physical(hass, 'Server')
    group = await aggregate(hass, [member])
    assert state(hass, group, 'energy_total').attributes['member_entry_ids'] == [member.entry_id]
    hass.states.async_set(entity_id(hass, member, 'energy_total'), '999', attributes)
    await hass.async_block_till_done()
    assert state(hass, group, 'energy_total').state == 'unavailable'


async def test_disabled_logical_sensor_and_reenable(hass):
    member = await physical(hass, 'Server')
    group = await aggregate(hass, [member])
    registry = er.async_get(hass)
    source = entity_id(hass, member, 'energy_total')
    registry.async_update_entity(source, disabled_by=er.RegistryEntryDisabler.USER)
    await hass.async_block_till_done()
    assert state(hass, group, 'energy_total').state == 'unavailable'
    registry.async_update_entity(source, disabled_by=None)
    assert await hass.config_entries.async_reload(member.entry_id)
    await hass.async_block_till_done()
    assert state(hass, group, 'energy_total').state == '1'


async def test_currency_aggregation_and_deletion_isolation(hass):
    hass.config.currency = 'EUR'
    first = await physical(hass, 'Computer')
    second = await physical(hass, 'Monitor')
    group = await aggregate(hass, [first, second])
    assert state(hass, group, 'cost_total').attributes['unit_of_measurement'] == 'EUR'
    assert state(hass, group, 'cost_total').state == '0'
    hass.config.currency = 'DKK'
    third = await physical(hass, 'Printer')
    mixed = await aggregate(hass, [first, third])
    assert state(hass, mixed, 'cost_total').state == 'unavailable'
    assert state(hass, mixed, 'energy_total').state == '2'
    saved = await first.runtime_data.store.async_load()
    await hass.config_entries.async_remove(group.entry_id)
    assert await first.runtime_data.store.async_load() == saved
    third_store = third.runtime_data.store
    await hass.config_entries.async_remove(third.entry_id)
    assert await third_store.async_load() is None
    assert await first.runtime_data.store.async_load() == saved
