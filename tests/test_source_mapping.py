"""Temporary HA only: entry-driven mapping, real options reload and no rebasing totals."""
from datetime import timedelta
from decimal import Decimal

import pytest
from homeassistant.exceptions import TemplateError
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.template import Template
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.appliance_meter.accounting import accounting_store
from custom_components.appliance_meter.const import DOMAIN, settings

BASE = dt_util.parse_datetime('2026-11-03T12:00:00+00:00')


def source(hass, phase, *, power=0, energy=100, restored=False):
    hass.states.async_set(f'sensor.utility_l{phase}_power', str(power), {
        'unit_of_measurement': 'W', 'device_class': 'power', 'state_class': 'measurement'})
    hass.states.async_set(f'sensor.utility_l{phase}_energy', str(energy), {
        'unit_of_measurement': 'kWh', 'device_class': 'energy',
        'state_class': 'total_increasing', 'restored': restored})


def mapping(name, phase, profile, mode):
    return {'name': name, 'power_sensor': f'sensor.utility_l{phase}_power',
            'energy_sensor': f'sensor.utility_l{phase}_energy', 'price_sensor': 'sensor.price',
            'session_profile': profile, 'session_mode': mode}


async def create(hass, name, phase, profile, mode):
    entry = MockConfigEntry(domain=DOMAIN, title=name, data=mapping(name, phase, profile, mode))
    entry.add_to_hass(hass)
    await accounting_store(hass, entry).async_save({
        'currency': 'DKK', 'source': entry.data['energy_sensor'], 'last': '100',
        'energy_total': '12.3456789', 'cost_total': '40.123456789', 'unpriced_energy': '0.125'})
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def edit(hass, entry, values):
    flow = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(flow['flow_id'], values)
    await hass.async_block_till_done()
    return result


def identities(hass, entry):
    return {r.unique_id: (r.entity_id, r.device_id) for r in
            er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)}


@pytest.mark.parametrize(('name', 'profile', 'old', 'new'), [
    ('Dryer', 'tumble_dryer', 1, 3), ('Dishwasher', 'dishwasher', 3, 1)])
@pytest.mark.parametrize('mode', ['off', 'shadow'])
@pytest.mark.parametrize('new_available', [True, False])
async def test_remapping_preserves_identity_totals_and_interrupts_only_old_session(
        hass, freezer, name, profile, old, new, mode, new_available):
    freezer.move_to(BASE)
    source(hass, old)
    source(hass, new, energy=9000 if new_available else 'unavailable')
    hass.states.async_set('sensor.price', '2', {'unit_of_measurement': 'DKK/kWh'})
    hass.states.async_set('input_number.program_energy', '1.25')
    hass.states.async_set('input_boolean.running', 'off')
    entry = await create(hass, name, old, profile, mode)
    ids = identities(hass, entry)
    original_data = dict(entry.data)
    for seconds in (10, 75):
        freezer.move_to(BASE + timedelta(seconds=seconds))
        source(hass, old, power=1000, energy=101)
        await hass.async_block_till_done()
    previous = entry.runtime_data
    observer = previous.sessions
    if observer:
        assert observer.engine.active is not None
        session_id = observer.engine.active['id']
    totals = dict(previous.values)
    assert totals['energy_total'] == Decimal('13.3456789')
    assert totals['cost_total'] == Decimal('42.123456789')
    freezer.move_to(BASE + timedelta(seconds=80))
    result = await edit(hass, entry, mapping(name, new, profile, mode))
    assert result['type'] == 'create_entry'
    assert entry.data == original_data
    assert identities(hass, entry) == ids
    assert previous._closed and not previous.unsubscribers
    assert entry.runtime_data.values == totals
    assert entry.runtime_data.last == (Decimal(9000) if new_available else None)
    for key in ('power', 'energy_total', 'cost_total', 'unpriced_energy'):
        logical = ids[f'{entry.entry_id}_{key}'][0]
        attrs = hass.states.get(logical).attributes
        assert attrs['config_entry_id'] == entry.entry_id
        assert attrs['power_entity_id'] == f'sensor.utility_l{new}_power'
        assert attrs['energy_entity_id'] == f'sensor.utility_l{new}_energy'
        assert attrs['price_entity_id'] == 'sensor.price'
    # Real HA template lookup follows the entry, including the virtual entity's
    # registry identity. HA's built-in config_entry_attr intentionally hides data.
    logical = ids[f'{entry.entry_id}_energy_total'][0]
    template = Template("{{ states(state_attr(appliance, 'power_entity_id')) }}", hass)
    assert template.async_render({'appliance': logical}) == 0
    assert Template("{{ config_entry_id(appliance) }}", hass).async_render({'appliance': logical}) == entry.entry_id
    with pytest.raises(TemplateError, match='Invalid config entry attribute'):
        Template("{{ config_entry_attr(entry, 'data') }}", hass).async_render({'entry': entry.entry_id})
    if observer:
        assert observer.closed and not observer.unsubscribers
        engine = entry.runtime_data.sessions.engine
        assert engine.active is None
        assert len(engine.records) == 1
        interrupted = engine.records[0]
        assert interrupted['id'] == session_id
        assert interrupted['status'] == 'interrupted'
        assert interrupted['sources']['energy_sensor'] == f'sensor.utility_l{old}_energy'
        assert 'configuration_changed' in interrupted['quality']
        assert interrupted['end'] is None and interrupted['kwh'] is None and interrupted['cost'] is None
        assert engine.sources['energy_sensor'] == f'sensor.utility_l{new}_energy'
    else:
        assert entry.runtime_data.sessions is None
    # Removed listeners cannot count old-channel consumption. A delayed first
    # live sample establishes a new baseline even if a restored sample was seen.
    source(hass, old, power=2000, energy=500)
    await hass.async_block_till_done()
    assert entry.runtime_data.values == totals
    if not new_available:
        source(hass, new, energy=0, restored=True)
        await hass.async_block_till_done()
        assert entry.runtime_data.last is None
        source(hass, new, energy=9000)
        await hass.async_block_till_done()
        assert entry.runtime_data.values == totals
    source(hass, new, energy=9001)
    source(hass, new, energy=9001)  # Repeated reports must not duplicate deltas.
    await hass.async_block_till_done()
    assert entry.runtime_data.values == {
        **totals, 'energy_total': totals['energy_total'] + 1, 'cost_total': totals['cost_total'] + 2}
    snapshot = entry.runtime_data.snapshot()
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.runtime_data.snapshot() == snapshot
    assert identities(hass, entry) == ids
    if observer:
        assert entry.runtime_data.sessions.engine.records == [interrupted]
    assert hass.states.get('input_number.program_energy').state == '1.25'
    assert hass.states.get('input_boolean.running').state == 'off'


async def test_two_appliance_swap_rejects_collision_and_preserves_shadow_modes(hass, freezer):
    freezer.move_to(BASE)
    source(hass, 1)
    source(hass, 3)
    hass.states.async_set('sensor.price', '2', {'unit_of_measurement': 'DKK/kWh'})
    dryer = await create(hass, 'Dryer', 1, 'tumble_dryer', 'off')
    dishwasher = await create(hass, 'Dishwasher', 3, 'dishwasher', 'shadow')
    initial = {e.entry_id: (identities(hass, e), dict(e.runtime_data.values)) for e in (dryer, dishwasher)}
    conflict = await edit(hass, dryer, mapping('Dryer', 3, 'tumble_dryer', 'off'))
    assert conflict['errors'] == {'energy_sensor': 'energy_in_use'}
    assert settings(dryer)['energy_sensor'] == 'sensor.utility_l1_energy'
    # Exercise the existing UI's supported staged swap, with appliances idle.
    # No new batch endpoint, second phase table or automatic swap is introduced.
    detached = {**settings(dryer)}
    detached.pop('energy_sensor')
    assert (await edit(hass, dryer, detached))['type'] == 'create_entry'
    assert (await edit(hass, dishwasher, mapping('Dishwasher', 1, 'dishwasher', 'shadow')))['type'] == 'create_entry'
    assert (await edit(hass, dryer, mapping('Dryer', 3, 'tumble_dryer', 'off')))['type'] == 'create_entry'
    for e in (dryer, dishwasher):
        assert (identities(hass, e), e.runtime_data.values) == initial[e.entry_id]
    assert dryer.runtime_data.sessions is None
    assert dishwasher.runtime_data.sessions is not None
    source(hass, 1, energy=101)
    source(hass, 3, energy=102)
    await hass.async_block_till_done()
    assert dishwasher.runtime_data.values['energy_total'] == Decimal('13.3456789')
    assert dryer.runtime_data.values['energy_total'] == Decimal('14.3456789')


async def test_cleared_mapping_has_explicit_null_metadata_without_fallback(hass, freezer):
    freezer.move_to(BASE)
    source(hass, 1)
    entry = await create(hass, 'Dryer', 1, 'tumble_dryer', 'off')
    original = dict(entry.runtime_data.values)
    assert (await edit(hass, entry, {'name': 'Dryer'}))['type'] == 'create_entry'
    for r in er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id):
        attrs = hass.states.get(r.entity_id).attributes
        # HA suppresses extra attributes on unavailable entities (power here).
        assert attrs.get('power_entity_id') is None
        assert attrs.get('energy_entity_id') is None
        if r.unique_id.endswith('_energy_total'):
            assert attrs['config_entry_id'] == entry.entry_id
            assert 'power_entity_id' in attrs and 'energy_entity_id' in attrs
    assert entry.runtime_data.values == original
