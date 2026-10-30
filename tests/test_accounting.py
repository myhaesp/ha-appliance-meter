"""Exercise real HA state events and Store, including fresh runtime restoration."""
import asyncio
from datetime import timedelta
from decimal import Decimal
from unittest.mock import Mock, patch

import pytest
from homeassistant.const import EVENT_HOMEASSISTANT_STOP
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_time_changed

from custom_components.appliance_meter.accounting import Accounting
from custom_components.appliance_meter.const import DOMAIN


def energy(hass, value, unit='kWh', source='sensor.energy'):
    hass.states.async_set(source, str(value), {'unit_of_measurement': unit})


def price(hass, value, unit='DKK/kWh'):
    hass.states.async_set('sensor.price', str(value), {'unit_of_measurement': unit})


async def start(hass, **options):
    entry = MockConfigEntry(domain=DOMAIN, title='Washer', data={
        'name': 'Washer', 'energy_sensor': 'sensor.energy',
        'price_sensor': 'sensor.price', **options})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


def totals(entry):
    return tuple(entry.runtime_data.values.values())


async def test_baseline_prices_and_queued_updates(hass):
    energy(hass, 100)
    price(hass, 2)
    entry = await start(hass)
    assert totals(entry) == (0, 0, 0)
    # Queue events without yielding: each delta must use its own current price.
    energy(hass, 101)
    price(hass, 3)
    energy(hass, 102)
    energy(hass, 102)
    price(hass, -1)
    energy(hass, 103)
    await hass.async_block_till_done()
    assert totals(entry) == (3, 4, 0)
    registry = er.async_get(hass)
    for key, unit, device_class, state_class in (
        ('energy_total', 'kWh', 'energy', 'total_increasing'),
        ('cost_total', 'DKK', 'monetary', 'total')):
        entity_id = registry.async_get_entity_id('sensor', DOMAIN, f'{entry.entry_id}_{key}')
        attributes = hass.states.get(entity_id).attributes
        assert attributes['unit_of_measurement'] == unit
        assert attributes['device_class'] == device_class
        assert attributes['state_class'] == state_class


@pytest.mark.parametrize('bad_price,unit', [
    ('unavailable', 'DKK/kWh'), ('unknown', 'DKK/kWh'), ('NaN', 'DKK/kWh'),
    ('Infinity', 'DKK/kWh'), ('bad', 'DKK/kWh'), ('2', 'EUR/kWh'), ('2', None)])
async def test_unpriced(hass, bad_price, unit):
    energy(hass, 10)
    entry = await start(hass)
    energy(hass, 11)  # Missing price.
    await hass.async_block_till_done()
    price(hass, bad_price, unit)
    energy(hass, 12)
    await hass.async_block_till_done()
    assert totals(entry) == (2, 0, 2)
    price(hass, 2)
    energy(hass, 13)
    await hass.async_block_till_done()
    assert totals(entry) == (3, 2, 2)


async def test_invalid_recovery_resets_and_units(hass):
    entry = await start(hass)
    assert entry.runtime_data.last is None
    energy(hass, 1000, 'Wh')
    await hass.async_block_till_done()
    assert totals(entry) == (0, 0, 0)
    for invalid, unit in [('unavailable', 'kWh'), ('unknown', 'kWh'),
                          ('bad', 'kWh'), ('NaN', 'kWh'), ('Infinity', 'kWh'),
                          (-1, 'kWh'), (500, 'W')]:
        energy(hass, invalid, unit)
        await hass.async_block_till_done()
        assert entry.runtime_data.last == 1
    hass.states.async_remove('sensor.energy')
    await hass.async_block_till_done()
    energy(hass, 2500, 'Wh')
    await hass.async_block_till_done()
    assert totals(entry) == (Decimal('1.5'), 0, Decimal('1.5'))
    energy(hass, 2.5)  # Same reading expressed in kWh.
    await hass.async_block_till_done()
    energy(hass, 0)
    await hass.async_block_till_done()
    assert totals(entry)[0] == Decimal('1.5')
    energy(hass, 0.5)
    await hass.async_block_till_done()
    assert totals(entry) == (2, 0, 2)


async def test_restart_restoration_and_startup_flush(hass):
    energy(hass, 100)
    price(hass, 2)
    entry = await start(hass)
    energy(hass, 101)
    await hass.async_block_till_done()
    assert await hass.config_entries.async_unload(entry.entry_id)
    # Fresh runtime reads persisted Store, including the last physical reading.
    energy(hass, 103)
    restored = Accounting(hass, entry)
    await restored.async_start()
    assert tuple(restored.values.values()) == (3, 6, 0)
    assert restored.last == 103
    # Startup's recovered delta was itself flushed without waiting for a timer.
    saved = await restored.store.async_load()
    assert saved['energy_total'] == '3'
    assert saved['last'] == '103'
    await restored.async_close()
    energy(hass, 'unavailable')
    recovered = Accounting(hass, entry)
    await recovered.async_start()
    assert recovered.last == 103
    energy(hass, 104)
    await hass.async_block_till_done()
    assert tuple(recovered.values.values()) == (4, 8, 0)
    await recovered.async_close()


async def test_replacement_and_removal_preserve_totals_and_ids(hass):
    energy(hass, 100)
    price(hass, 2)
    entry = await start(hass)
    registry = er.async_get(hass)
    ids = {e.unique_id: e.entity_id for e in er.async_entries_for_config_entry(registry, entry.entry_id)}
    energy(hass, 101)
    await hass.async_block_till_done()
    energy(hass, 900, source='sensor.replacement')
    hass.config_entries.async_update_entry(entry, options={
        'name': 'Renamed', 'energy_sensor': 'sensor.replacement', 'price_sensor': 'sensor.price'})
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert totals(entry) == (1, 2, 0)
    energy(hass, 999)  # Old source must no longer count.
    energy(hass, 901, source='sensor.replacement')
    await hass.async_block_till_done()
    assert totals(entry) == (2, 4, 0)
    assert {e.unique_id: e.entity_id for e in er.async_entries_for_config_entry(registry, entry.entry_id)} == ids
    hass.config_entries.async_update_entry(entry, options={'name': 'Renamed'})
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert totals(entry) == (2, 4, 0)
    assert entry.runtime_data.last is None
    hass.config_entries.async_update_entry(entry, options={
        'name': 'Renamed', 'energy_sensor': 'sensor.energy'})
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.runtime_data.last == 999
    assert totals(entry) == (2, 4, 0)


async def test_debounced_writes_and_shutdown_flush(hass, freezer):
    energy(hass, 10)
    entry = await start(hass)
    accounting = entry.runtime_data
    with patch.object(accounting.store, '_async_write_data', wraps=accounting.store._async_write_data) as write:
        for value in range(11, 21):
            energy(hass, value)
        await hass.async_block_till_done()
        assert write.call_count == 0
        freezer.tick(timedelta(seconds=31))
        async_fire_time_changed(hass, dt_util.utcnow(), fire_all=True)
        await hass.async_block_till_done()
        assert write.call_count == 1
        energy(hass, 21)
        await hass.async_block_till_done()
        hass.bus.async_fire(EVENT_HOMEASSISTANT_STOP)
        await hass.async_block_till_done()
        assert write.call_count == 2
    restored = Accounting(hass, entry)
    await restored.async_start()
    assert tuple(restored.values.values()) == (11, 0, 11)
    assert restored.last == 21
    await restored.async_close()


@pytest.mark.parametrize('unit', ['DKK/kWh', 'kr/kWh'])
async def test_danish_price_units_and_availability(hass, unit):
    """Strømligning's kr/kWh label must price deltas like DKK/kWh."""
    energy(hass, 10)
    price(hass, '1.553983', unit)
    entry = await start(hass)
    energy(hass, '10.00009298324585')
    await hass.async_block_till_done()
    delta = Decimal('0.00009298324585')
    assert totals(entry) == (delta, delta * Decimal('1.553983'), 0)

    price(hass, 'unavailable', unit)
    energy(hass, '11.00009298324585')
    await hass.async_block_till_done()
    assert totals(entry) == (delta + 1, delta * Decimal('1.553983'), 1)

    # Recovery and negative prices work with both supported unit labels.
    price(hass, '-0.5', unit)
    energy(hass, '12.00009298324585')
    await hass.async_block_till_done()
    assert totals(entry) == (delta + 2, delta * Decimal('1.553983') - Decimal('0.5'), 1)


@pytest.mark.parametrize('shutdown', [False, True], ids=['unload', 'shutdown'])
async def test_listener_cleanup_once(hass, caplog, shutdown):
    """Repeated start/close and stop-after-unload never remove listeners twice."""
    energy(hass, 10)
    price(hass, 2)
    entry = MockConfigEntry(domain=DOMAIN, data={
        'name': 'Washer', 'energy_sensor': 'sensor.energy', 'price_sensor': 'sensor.price'})
    accounting = Accounting(hass, entry)
    initial_stop_listeners = hass.bus.async_listeners().get(EVENT_HOMEASSISTANT_STOP, 0)
    with patch.object(accounting.store, 'async_save', wraps=accounting.store.async_save) as save:
        await accounting.async_start()
        await accounting.async_start()
        assert save.call_count == 1
        assert hass.bus.async_listeners()[EVENT_HOMEASSISTANT_STOP] == initial_stop_listeners + 1
        removers = [Mock(side_effect=remove) for remove in accounting.unsubscribers]
        accounting.unsubscribers[:] = removers
        stop_remove = Mock(side_effect=accounting._stop_unsubscribe)
        accounting._stop_unsubscribe = stop_remove
        energy(hass, 11)
        await hass.async_block_till_done()
        if shutdown:
            hass.bus.async_fire(EVENT_HOMEASSISTANT_STOP)
            await hass.async_block_till_done()
        await asyncio.gather(accounting.async_close(), accounting.async_close())
        await accounting.async_close()
        assert save.call_count == 2  # One startup flush, one final flush.
        assert all(remove.call_count == 1 for remove in removers)
        assert stop_remove.call_count == (0 if shutdown else 1)
        assert accounting._stop_unsubscribe is None
        assert hass.bus.async_listeners().get(EVENT_HOMEASSISTANT_STOP, 0) == (
            0 if shutdown else initial_stop_listeners)
        hass.bus.async_fire(EVENT_HOMEASSISTANT_STOP)
        energy(hass, 12)
        price(hass, 3)
        await hass.async_block_till_done()
        assert save.call_count == 2
        assert tuple(accounting.values.values()) == (1, 2, 0)
        assert accounting.price_state.state == '2'
        saved = await accounting.store.async_load()
        assert saved['last'] == '11'
        assert saved['energy_total'] == '1'
        assert saved['cost_total'] == '2'
        assert saved['unpriced_energy'] == '0'
    assert 'Unable to remove unknown job listener' not in caplog.text

async def test_cost_debug_displays_actual_recorded_increment(hass, hass_ws_client, hass_admin_user):
    """Render the real diagnostic API result and compare it to the stored cost delta."""
    import json
    import subprocess
    from pathlib import Path

    energy(hass, '100000', 'Wh')
    price(hass, '2.123456')
    entry = await start(hass)
    before = entry.runtime_data.values['cost_total']
    energy(hass, '100000.12', 'Wh')
    await hass.async_block_till_done()
    recorded = entry.runtime_data.values['cost_total'] - before
    price(hass, '99')  # Display must not substitute the price now in hass.states.
    await hass.async_block_till_done()
    token = hass.auth.async_create_access_token(await hass.auth.async_create_refresh_token(hass_admin_user, client_id='https://example.test'))
    client = await hass_ws_client(hass, access_token=token)
    await client.send_json({'id': 1, 'type': 'appliance_meter/cost_debug', 'entry_id': entry.entry_id})
    response = await client.receive_json()
    assert response['success']
    data = response['result']
    calculation = data['calculations'][0]
    assert Decimal(calculation['energy_delta']) == Decimal('0.00012')
    assert calculation['price'] == '2.123456'
    assert Decimal(calculation['cost_increment']) == recorded
    assert Decimal(calculation['energy_delta']) * Decimal(calculation['price']) == recorded
    assert 'cost_calculations' not in entry.runtime_data.snapshot()
    renderer = (Path(__file__).parents[1]/'custom_components/appliance_meter/frontend/cost-debug.js').as_uri()
    script = '''
import {readFileSync} from 'node:fs';
import {Window} from 'happy-dom';
globalThis.document = new Window().document;
const {costDebugContent} = await import(process.argv[1]);
const content = costDebugContent(JSON.parse(readFileSync(0, 'utf8')), 'Europe/Copenhagen');
const fields = Object.fromEntries([...content.querySelectorAll('dt')].map(dt=>[dt.textContent,dt.nextElementSibling.textContent]));
console.log(JSON.stringify(fields));
'''
    rendered = await hass.async_add_executor_job(lambda: subprocess.run(
        ['node', '--input-type=module', '-e', script, renderer], input=json.dumps(data),
        text=True, capture_output=True, timeout=15, cwd=Path(__file__).parents[1]))
    assert rendered.returncode == 0, rendered.stderr
    fields = json.loads(rendered.stdout)
    assert Decimal(fields['Cost increment (DKK)'].replace(',', '.')) == recorded
    assert fields['Electricity price used (DKK/kWh)'] == '2,123456'
    assert fields['Calculation'] == '0,00012 kWh × 2,123456 DKK/kWh = 0,00025481472 DKK'


async def test_cost_debug_bounded_history_prices_resets_and_reload(hass):
    energy(hass, 100)
    price(hass, 2)
    entry = await start(hass)
    accounting = entry.runtime_data
    assert not accounting.cost_calculations
    # Queued price changes must appear in the calculations that actually use them.
    for i in range(1, 13):
        price(hass, i)
        energy(hass, 100 + i)
    await hass.async_block_till_done()
    assert len(accounting.cost_calculations) == 10
    assert [Decimal(row['price']) for row in accounting.cost_calculations] == list(range(3, 13))
    assert [Decimal(row['cost_increment']) for row in accounting.cost_calculations] == list(range(3, 13))
    energy(hass, 112)  # Unchanged values and counter resets are not cost increments.
    energy(hass, 0)
    await hass.async_block_till_done()
    assert len(accounting.cost_calculations) == 10
    price(hass, 'unavailable')
    energy(hass, 1)
    await hass.async_block_till_done()
    assert accounting.cost_calculations[-1]['price'] is None
    assert Decimal(accounting.cost_calculations[-1]['cost_increment']) == 0
    price(hass, '-0.5')
    energy(hass, 2)
    await hass.async_block_till_done()
    assert Decimal(accounting.cost_calculations[-1]['cost_increment']) == Decimal('-0.5')
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert not entry.runtime_data.cost_calculations


@pytest.mark.parametrize('saved_baseline', [None, '100'])
async def test_restored_energy_never_replaces_live_baseline(hass, saved_baseline):
    entry = MockConfigEntry(domain=DOMAIN, data={
        'name': 'Test', 'energy_sensor': 'sensor.energy', 'price_sensor': 'sensor.price'})
    accounting = Accounting(hass, entry)
    if saved_baseline is not None:
        await accounting.store.async_save({
            'source': 'sensor.energy', 'last': saved_baseline,
            'energy_total': '5', 'cost_total': '10', 'unpriced_energy': '0'})
    hass.states.async_set('sensor.energy', '20', {
        'unit_of_measurement': 'kWh', 'restored': True})
    price(hass, 2)
    await accounting.async_start()
    assert accounting.last == (Decimal(saved_baseline) if saved_baseline else None)
    energy(hass, 102)
    await hass.async_block_till_done()
    assert accounting.values['energy_total'] == (7 if saved_baseline else 0)
    hass.states.async_set('sensor.energy', '0', {
        'unit_of_measurement': 'kWh', 'restored': True})
    await hass.async_block_till_done()
    assert accounting.last == 102
    energy(hass, 103)
    await hass.async_block_till_done()
    assert accounting.values['energy_total'] == (8 if saved_baseline else 1)
    await accounting.async_close()


async def test_delete_removes_store_and_cancels_pending_save(hass, freezer):
    energy(hass, 10)
    entry = await start(hass)
    accounting = entry.runtime_data
    energy(hass, 11)
    await hass.async_block_till_done()
    assert accounting._save_pending
    assert (await hass.config_entries.async_remove(entry.entry_id))['require_restart'] is False
    assert await accounting.store.async_load() is None
    energy(hass, 12)
    freezer.tick(timedelta(seconds=60))
    async_fire_time_changed(hass, dt_util.utcnow(), fire_all=True)
    await hass.async_block_till_done()
    assert await accounting.store.async_load() is None


async def test_new_currency_stays_fixed_after_reload(hass):
    hass.config.currency = 'EUR'
    energy(hass, 10)
    price(hass, 2, 'EUR/kWh')
    entry = await start(hass)
    energy(hass, 11)
    await hass.async_block_till_done()
    assert totals(entry) == (1, 2, 0)
    assert entry.runtime_data.currency == 'EUR'
    registry = er.async_get(hass)
    cost_id = registry.async_get_entity_id('sensor', DOMAIN, f'{entry.entry_id}_cost_total')
    assert hass.states.get(cost_id).attributes['unit_of_measurement'] == 'EUR'
    hass.config.currency = 'USD'
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.runtime_data.currency == 'EUR'
    price(hass, 3, 'USD/kWh')
    energy(hass, 12)
    await hass.async_block_till_done()
    assert totals(entry) == (2, 2, 1)


async def test_legacy_dkk_store_is_never_relabelled(hass):
    hass.config.currency = 'EUR'
    energy(hass, 100)
    entry = MockConfigEntry(domain=DOMAIN, data={
        'name': 'Legacy', 'energy_sensor': 'sensor.energy', 'price_sensor': 'sensor.price'})
    accounting = Accounting(hass, entry)
    await accounting.store.async_save({
        'source': 'sensor.energy', 'last': '99',
        'energy_total': '10', 'cost_total': '25.50', 'unpriced_energy': '0'})
    price(hass, 2, 'kr/kWh')
    await accounting.async_start()
    assert accounting.currency == 'DKK'
    assert accounting.values['cost_total'] == Decimal('27.50')
    assert (await accounting.store.async_load())['currency'] == 'DKK'
    await accounting.async_close()


async def test_restored_price_is_unpriced_until_live_recovery(hass):
    energy(hass, 10)
    hass.states.async_set('sensor.price', '2', {
        'unit_of_measurement': 'DKK/kWh', 'restored': True})
    entry = await start(hass)
    energy(hass, 11)
    await hass.async_block_till_done()
    assert totals(entry) == (1, 0, 1)
    price(hass, '-0.5')
    energy(hass, 12)
    await hass.async_block_till_done()
    assert totals(entry) == (2, Decimal('-0.5'), 1)
