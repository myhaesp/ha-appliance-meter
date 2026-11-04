"""Real temporary HA lifecycle; synthetic sources only, never a private server."""
from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

import pytest
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.appliance_meter.const import DOMAIN
from custom_components.appliance_meter.session_runtime import SessionObserver, session_store

BASE = dt_util.parse_datetime('2026-11-03T12:00:00+00:00')


def set_power(hass, value):
    hass.states.async_set('sensor.session_power', str(value), {'unit_of_measurement': 'W'})


def set_energy(hass, value):
    hass.states.async_set('sensor.session_energy', str(value), {'unit_of_measurement': 'kWh'})


def set_price(hass, *, value='2', unit='DKK/kWh', rows=True, restored=False, forecast=False):
    attrs = {'unit_of_measurement': unit, 'restored': restored, 'forecast_data': forecast}
    if rows:
        attrs['prices'] = [{'start': BASE.isoformat(), 'end': (BASE + timedelta(hours=2)).isoformat(), 'price': 2}]
    hass.states.async_set('sensor.session_price', value, attrs)


async def setup(hass, freezer, *, mode='shadow', profile='washing_machine', energy=True):
    freezer.move_to(BASE)
    set_power(hass, 0)
    if energy:
        set_energy(hass, 10)
    set_price(hass)
    data = {'name': 'Existing appliance', 'power_sensor': 'sensor.session_power',
            'price_sensor': 'sensor.session_price'}
    if energy:
        data['energy_sensor'] = 'sensor.session_energy'
    if mode is not None:
        data.update(session_mode=mode, session_profile=profile)
    entry = MockConfigEntry(domain=DOMAIN, data=data)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def tick(hass, freezer, observer, seconds, *, power=0, energy=11):
    freezer.move_to(BASE + timedelta(seconds=seconds))
    set_power(hass, power)
    if energy is not None:
        set_energy(hass, energy)
    await hass.async_block_till_done()
    observer._tick(dt_util.utcnow())
    await hass.async_block_till_done()


async def complete_wash(hass, freezer, entry):
    observer = entry.runtime_data.sessions
    await tick(hass, freezer, observer, 120, power=60, energy=10)
    await tick(hass, freezer, observer, 185, power=60, energy=10)
    assert observer.engine.active is not None
    await tick(hass, freezer, observer, 300)
    for at in range(360, 961, 60):
        await tick(hass, freezer, observer, at)
    return observer


async def test_default_off_creates_only_existing_sensors_and_no_session_store(hass, freezer):
    with patch('custom_components.appliance_meter.SessionObserver') as constructor:
        entry = await setup(hass, freezer, mode=None)
        assert entry.runtime_data.sessions is None
        constructor.assert_not_called()
    assert await session_store(hass, entry).async_load() is None
    assert len(er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)) == 4


async def test_shadow_session_persistence_and_identities_never_touch_legacy_helpers(hass, freezer):
    hass.states.async_set('input_boolean.washing_machine_running', 'off')
    hass.states.async_set('input_number.washing_machine_program_energy', '1.0')
    entry = await setup(hass, freezer)
    entities = er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)
    identities = {x.unique_id: (x.entity_id, x.device_id) for x in entities}
    assert len(identities) == 5
    observer = await complete_wash(hass, freezer, entry)
    assert len(observer.engine.records) == 1
    row = observer.engine.records[0]
    assert Decimal(row['kwh']) == 1
    assert Decimal(row['cost']) == 2
    assert entry.runtime_data.values == {'energy_total': Decimal(1), 'cost_total': Decimal(2), 'unpriced_energy': Decimal(0)}
    assert hass.states.get('input_boolean.washing_machine_running').state == 'off'
    assert hass.states.get('input_number.washing_machine_program_energy').state == '1.0'
    status_id = er.async_get(hass).async_get_entity_id('sensor', DOMAIN, f'{entry.entry_id}_session_observation')
    state = hass.states.get(status_id)
    assert state.state == 'completed'
    assert 'state_class' not in state.attributes
    assert 'device_class' not in state.attributes
    assert state.attributes['mode'] == 'shadow'
    snapshot = entry.runtime_data.snapshot()
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.runtime_data.sessions.engine.records == observer.engine.records
    assert entry.runtime_data.snapshot() == snapshot
    assert {x.unique_id: (x.entity_id, x.device_id) for x in er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)} == identities
    assert observer.closed and not observer.unsubscribers


async def test_shadow_on_off_preserves_all_four_existing_entity_ids_and_totals(hass, freezer):
    entry = await setup(hass, freezer, mode=None)
    registry = er.async_get(hass)
    original = {e.unique_id: (e.entity_id, e.device_id) for e in er.async_entries_for_config_entry(registry, entry.entry_id)}
    original_snapshot = entry.runtime_data.snapshot()
    hass.config_entries.async_update_entry(entry, options={**entry.data, 'session_mode': 'shadow', 'session_profile': 'washing_machine'})
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    observer = entry.runtime_data.sessions
    assert observer is not None
    assert entry.runtime_data.snapshot() == original_snapshot
    for key, identity in original.items():
        entity = registry.async_get(identity[0])
        assert (entity.entity_id, entity.device_id) == identity
        assert entity.unique_id == key
    hass.config_entries.async_update_entry(entry, options={**entry.options, 'session_mode': 'off'})
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert observer.closed and not observer.unsubscribers
    assert entry.runtime_data.sessions is None
    assert entry.runtime_data.snapshot() == original_snapshot
    assert await session_store(hass, entry).async_load() is not None


async def test_reported_unchanged_power_is_a_heartbeat_but_stale_data_is_a_gap(hass, freezer):
    entry = await setup(hass, freezer)
    observer = entry.runtime_data.sessions
    await tick(hass, freezer, observer, 120, power=60, energy=10)
    await tick(hass, freezer, observer, 185, power=60, energy=10)
    assert observer.engine.active
    await tick(hass, freezer, observer, 230, power=60, energy=10)
    assert observer.engine.power_seen == (BASE + timedelta(seconds=230)).timestamp()
    freezer.move_to(BASE + timedelta(seconds=400))
    observer._tick(dt_util.utcnow())
    assert observer.engine.state == 'measurement_gap'
    assert not observer.engine.records


async def test_startup_price_never_prices_prior_downtime_and_bad_units_are_ignored(hass, freezer):
    entry = await setup(hass, freezer)
    observer = entry.runtime_data.sessions
    observer.engine.prices.rows.clear()
    set_price(hass, rows=False)
    await hass.async_block_till_done()
    now = BASE.timestamp()
    rows = observer.engine.prices.allocate(now - 60, now + 60, 1)
    assert rows[0]['price'] is None
    assert rows[-1]['price'] == '2'
    for kwargs in ({'unit': 'EUR/kWh'}, {'restored': True}, {'forecast': True}):
        observer.engine.prices.rows.clear()
        set_price(hass, **kwargs)
        await hass.async_block_till_done()
        assert not observer.engine.prices.rows


async def test_future_or_unreadable_session_store_is_not_overwritten_or_breaking_accounting(hass, freezer, hass_storage):
    entry = await setup(hass, freezer, mode=None)
    original = entry.runtime_data.snapshot()
    saved = {'engine': {'algorithm': 900}, 'context': {'preserve': True}}
    await session_store(hass, entry).async_save(saved)
    hass.config_entries.async_update_entry(entry, options={**entry.data, 'session_mode': 'shadow', 'session_profile': 'washing_machine'})
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.runtime_data.sessions.error == 'session_storage_unavailable'
    assert entry.runtime_data.snapshot() == original
    key = session_store(hass, entry).key
    assert hass_storage[key]['data'] == saved
    assert await hass.config_entries.async_unload(entry.entry_id)
    assert hass_storage[key]['data'] == saved


async def test_context_change_archives_open_session_instead_of_reusing_another_source_baseline(hass, freezer):
    entry = await setup(hass, freezer)
    observer = entry.runtime_data.sessions
    await tick(hass, freezer, observer, 120, power=60, energy=10)
    await tick(hass, freezer, observer, 185, power=60, energy=10)
    assert observer.engine.active
    before = entry.runtime_data.snapshot()
    hass.config_entries.async_update_entry(entry, options={**entry.data, 'session_profile': 'dishwasher'})
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    restored = entry.runtime_data.sessions.engine
    assert len(restored.records) == 1
    assert restored.records[0]['status'] == 'interrupted'
    assert restored.records[0]['end'] is None
    assert restored.active is None
    assert entry.runtime_data.snapshot() == before


async def test_delete_removes_only_the_entry_stores_and_cancels_session_callbacks(hass, freezer):
    entry = await setup(hass, freezer)
    observer = entry.runtime_data.sessions
    await tick(hass, freezer, observer, 120, power=60, energy=10)
    assert observer._pending
    assert (await hass.config_entries.async_remove(entry.entry_id))['require_restart'] is False
    assert observer.closed and not observer.unsubscribers
    assert await observer.store.async_load() is None
    set_power(hass, 100)
    await hass.async_block_till_done()
    assert await observer.store.async_load() is None


async def test_options_validate_explicit_profile_and_power_and_preserve_new_fields_for_old_clients(hass, freezer):
    entry = await setup(hass, freezer, mode=None)
    flow = await hass.config_entries.options.async_init(entry.entry_id)
    invalid = await hass.config_entries.options.async_configure(flow['flow_id'], {'name': 'Existing', 'session_mode': 'shadow', 'session_profile': 'dishwasher'})
    assert invalid['errors']['base'] == 'session_sources_required'
    with patch('custom_components.appliance_meter.async_setup_entry', return_value=True):
        result = await hass.config_entries.options.async_configure(flow['flow_id'], {
            'name': 'Existing', 'power_sensor': 'sensor.session_power', 'session_mode': 'shadow', 'session_profile': 'dishwasher'})
        await hass.async_block_till_done()
    assert result['data']['session_mode'] == 'shadow'
    old_client = await hass.config_entries.options.async_init(entry.entry_id)
    with patch('custom_components.appliance_meter.async_setup_entry', return_value=True):
        preserved = await hass.config_entries.options.async_configure(old_client['flow_id'], {
            'name': 'Renamed', 'power_sensor': 'sensor.session_power'})
        await hass.async_block_till_done()
    assert preserved['data']['session_mode'] == 'shadow'
    assert preserved['data']['session_profile'] == 'dishwasher'
    # An older client cannot silently switch off an already selected observer.


async def test_sessions_websocket_is_admin_only_paginated_readonly_and_survives_off_mode(hass, freezer, hass_ws_client, hass_admin_user):
    from homeassistant.auth.const import GROUP_ID_USER
    from homeassistant.helpers.storage import Store
    from unittest.mock import AsyncMock
    entry = await setup(hass, freezer)
    observer = await complete_wash(hass, freezer, entry)
    token = hass.auth.async_create_access_token(await hass.auth.async_create_refresh_token(hass_admin_user, client_id='https://example.test'))
    client = await hass_ws_client(hass, access_token=token)
    with patch.object(Store, 'async_save', new_callable=AsyncMock) as save:
        await client.send_json({'id': 1, 'type': 'appliance_meter/sessions', 'entry_id': entry.entry_id, 'limit': 1})
        response = await client.receive_json()
        assert response['success']
        assert response['result']['mode'] == 'shadow'
        assert response['result']['total'] == 1
        assert response['result']['sessions'][0]['currency'] == 'DKK'
        await client.send_json({'id': 2, 'type': 'appliance_meter/sessions', 'entry_id': entry.entry_id, 'offset': 1})
        assert (await client.receive_json())['result']['sessions'] == []
        save.assert_not_called()
    await client.send_json({'id': 3, 'type': 'appliance_meter/sessions', 'entry_id': 'missing'})
    assert (await client.receive_json())['error']['code'] == 'not_found'
    await client.send_json({'id': 4, 'type': 'appliance_meter/sessions', 'entry_id': entry.entry_id, 'limit': 101})
    assert not (await client.receive_json())['success']
    user = await hass.auth.async_create_user('Non administrator', group_ids=[GROUP_ID_USER])
    token = hass.auth.async_create_access_token(await hass.auth.async_create_refresh_token(user, client_id='https://example.test'))
    other = await hass_ws_client(hass, access_token=token)
    await other.send_json({'id': 1, 'type': 'appliance_meter/sessions', 'entry_id': entry.entry_id})
    assert (await other.receive_json())['error']['code'] == 'unauthorized'
    hass.config_entries.async_update_entry(entry, options={**entry.data, 'session_mode': 'off'})
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    await client.send_json({'id': 5, 'type': 'appliance_meter/sessions', 'entry_id': entry.entry_id})
    result = (await client.receive_json())['result']
    assert result['mode'] == 'off'
    assert result['sessions'] == observer.engine.records


async def test_open_session_survives_reload_and_observation_gap_is_marked(hass, freezer):
    entry = await setup(hass, freezer)
    observer = entry.runtime_data.sessions
    await tick(hass, freezer, observer, 120, power=60, energy=10)
    await tick(hass, freezer, observer, 185, power=60, energy=10)
    sid = observer.engine.active['id']
    snapshot = entry.runtime_data.snapshot()
    assert await hass.config_entries.async_unload(entry.entry_id)
    freezer.move_to(BASE + timedelta(seconds=200))
    set_energy(hass, 10)
    set_power(hass, 60)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    restored = entry.runtime_data.sessions
    assert restored.engine.active['id'] == sid
    assert 'restart_gap' in restored.engine.active['quality']
    assert entry.runtime_data.snapshot() == snapshot


async def test_power_only_profile_has_session_energy_without_changing_legacy_energy_total(hass, freezer):
    entry = await setup(hass, freezer, energy=False)
    observer = entry.runtime_data.sessions
    await tick(hass, freezer, observer, 120, power=60, energy=None)
    await tick(hass, freezer, observer, 185, power=60, energy=None)
    await tick(hass, freezer, observer, 300, energy=None)
    for at in range(360, 961, 60):
        await tick(hass, freezer, observer, at, energy=None)
    row = observer.engine.records[0]
    assert Decimal(row['kwh']) == Decimal('.003')
    assert 'power_integration' in row['quality']
    assert entry.runtime_data.values['energy_total'] == 0


async def test_snapshot_currency_and_source_identity_remain_on_each_session(hass, freezer):
    entry = await setup(hass, freezer)
    observer = await complete_wash(hass, freezer, entry)
    row = observer.engine.records[0]
    assert row['currency'] == 'DKK'
    assert row['sources'] == {'power_sensor': 'sensor.session_power', 'energy_sensor': 'sensor.session_energy', 'price_sensor': 'sensor.session_price'}
    hass.config.currency = 'EUR'
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.runtime_data.sessions.engine.records[0]['currency'] == 'DKK'
    assert entry.runtime_data.currency == 'DKK'


async def test_shutdown_flushes_session_store_without_late_resurrection(hass, freezer):
    from homeassistant.const import EVENT_HOMEASSISTANT_STOP
    entry = await setup(hass, freezer)
    observer = entry.runtime_data.sessions
    await tick(hass, freezer, observer, 120, power=60, energy=10)
    await tick(hass, freezer, observer, 185, power=60, energy=10)
    sid = observer.engine.active['id']
    hass.bus.async_fire(EVENT_HOMEASSISTANT_STOP)
    await hass.async_block_till_done()
    assert observer.closed
    assert not observer.unsubscribers
    saved = await observer.store.async_load()
    assert saved['engine']['active']['id'] == sid


async def test_aware_published_price_rows_use_utc_and_forecasts_never_price_sessions(hass, freezer):
    entry = await setup(hass, freezer)
    observer = entry.runtime_data.sessions
    observer.engine.prices.rows.clear()
    # UTC 12:00 equals Copenhagen 13:00 in November.
    hass.states.async_set('sensor.session_price', '2', {'unit_of_measurement': 'kr/kWh', 'prices': [
        {'start': '2026-11-03T13:00:00+01:00', 'end': '2026-11-03T13:15:00+01:00', 'price': '-.5'},
        {'start': '2026-11-03T13:15:00+01:00', 'end': '2026-11-03T13:30:00+01:00', 'price': '4', 'forecast': True},
    ]})
    await hass.async_block_till_done()
    parts = observer.engine.prices.allocate(BASE.timestamp(), BASE.timestamp() + 1800, 2)
    assert parts[0]['price'] == '-0.5'
    assert parts[1]['price'] is None


async def test_invalid_json_session_file_is_preserved_without_native_clean_slate(hass, freezer, tmp_path, monkeypatch):
    from pathlib import Path
    entry = await setup(hass, freezer, mode=None)
    original_accounting = entry.runtime_data.snapshot()
    from custom_components.appliance_meter.session_runtime import SessionStore
    path = tmp_path / 'session-ledger'
    monkeypatch.setattr(SessionStore, 'path', property(lambda self: str(path)))
    invalid = b'{"interrupted session ledger'
    await hass.async_add_executor_job(path.write_bytes, invalid)
    hass.config_entries.async_update_entry(entry, options={**entry.data, 'session_mode': 'shadow', 'session_profile': 'washing_machine'})
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.runtime_data.sessions.error == 'session_storage_unavailable'
    assert entry.runtime_data.snapshot() == original_accounting
    assert path.read_bytes() == invalid
    assert not list(path.parent.glob(path.name + '.corrupt.*'))
    assert await hass.config_entries.async_unload(entry.entry_id)
    assert path.read_bytes() == invalid


async def test_price_adapter_accepts_native_datetime_attributes_before_json_serialization(hass, freezer):
    entry = await setup(hass, freezer)
    observer = entry.runtime_data.sessions
    observer.engine.prices.rows.clear()
    hass.states.async_set('sensor.session_price', '2', {'unit_of_measurement': 'kr/kWh', 'prices': [
        {'start': BASE, 'end': BASE + timedelta(minutes=15), 'price': 2},
        {'start': BASE + timedelta(minutes=15), 'end': BASE + timedelta(minutes=30), 'price': 3},
    ]})
    await hass.async_block_till_done()
    parts = observer.engine.prices.allocate(BASE.timestamp(), BASE.timestamp() + 1800, 1)
    assert [p['price'] for p in parts] == ['2', '3']
    assert sum(Decimal(p['cost']) for p in parts) == Decimal('2.5')
