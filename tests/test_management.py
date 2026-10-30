"""Management is an admin-only, read-only projection; it owns no accounting."""
import json
from urllib.parse import urljoin
from unittest.mock import AsyncMock, patch

from homeassistant.auth.const import GROUP_ID_USER
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.appliance_meter.const import DOMAIN
from custom_components.appliance_meter.management import frontend_version, management_data


def appliance(hass, title, **data):
    entry = MockConfigEntry(domain=DOMAIN, title=title, data={'name': title, **data})
    entry.add_to_hass(hass)
    return entry


def test_management_projection_and_allowlist(hass):
    physical = appliance(hass, 'Køleskab', power_sensor='sensor.original', secret='DO NOT EXPOSE')
    # Existing options replace entry data; do not resurrect an old assignment.
    hass.config_entries.async_update_entry(physical, options={
        'name': 'Køleskab', 'energy_sensor': 'sensor.energy', 'price_sensor': 'sensor.price'})
    group = appliance(hass, 'Example Group', appliance_type='aggregate', members=[physical.entry_id, 'missing-entry'])
    source = MockConfigEntry(domain='esphome'); source.add_to_hass(hass)
    device = dr.async_get(hass).async_get_or_create(config_entry_id=source.entry_id,
        identifiers={('esphome', 'meter')}, name='Original name')
    dr.async_get(hass).async_update_device(device.id, name_by_user='Friendly meter')
    entities = er.async_get(hass)
    energy = entities.async_get_or_create('sensor', 'esphome', 'energy',
        suggested_object_id='energy', device_id=device.id, original_name='Meter Energy',
        original_device_class='energy', capabilities={'state_class': 'total'},
        unit_of_measurement='kWh', disabled_by=er.RegistryEntryDisabler.USER)
    price = entities.async_get_or_create('sensor', 'esphome', 'price', suggested_object_id='price', original_name='Price')
    logical = entities.async_get_or_create('sensor', DOMAIN, f'{physical.entry_id}_energy_total',
        config_entry=physical, suggested_object_id='logical_total')
    original = (dict(physical.data), dict(physical.options), dict(group.data))
    result = management_data(hass)
    row = next(e for e in result['entries'] if e['entry_id'] == physical.entry_id)
    assert row['device_name'] == 'Friendly meter'
    assert row['assignments']['power_sensor'] is None
    assert row['assignments']['energy_sensor']['entity_id'] == energy.entity_id
    assert row['sensors']['energy_total'] == logical.entity_id
    assert row['affected_totals'] == [{'entry_id': group.entry_id, 'name': 'Example Group'}]
    total = next(e for e in result['entries'] if e['entry_id'] == group.entry_id)
    assert total['assignments'] == {}
    assert total['members'] == [{'entry_id': physical.entry_id, 'name': 'Køleskab', 'missing': False},
                                {'entry_id': 'missing-entry', 'name': 'Missing appliance', 'missing': True}]
    assert result['devices'] == [{'value': device.id, 'label': 'Friendly meter',
                                 'identifiers': ['meter'], 'entity_ids': [energy.entity_id], 'unavailable': True}]
    assert energy.entity_id in [e['entity_id'] for e in result['entities']]
    assert price.entity_id in [e['entity_id'] for e in result['entities']]
    assert 'DO NOT EXPOSE' not in json.dumps(result)
    assert 'secret' not in json.dumps(result)
    assert (dict(physical.data), dict(physical.options), dict(group.data)) == original
    entities.async_update_entity(logical.entity_id, new_entity_id='sensor.renamed_total')
    assert management_data(hass)['entries'][0]['sensors']['energy_total'] == 'sensor.renamed_total'


def test_device_derivation_multiple_missing_and_unassigned(hass):
    first = appliance(hass, 'No sources')
    second = appliance(hass, 'Missing', power_sensor='sensor.missing')
    source = MockConfigEntry(domain='esphome'); source.add_to_hass(hass)
    registry = er.async_get(hass)
    for key in ['power', 'energy']:
        device = dr.async_get(hass).async_get_or_create(config_entry_id=source.entry_id, identifiers={('esphome', key)}, name=key)
        registry.async_get_or_create('sensor', 'esphome', key, suggested_object_id=key, device_id=device.id)
    third = appliance(hass, 'Multiple', power_sensor='sensor.power', energy_sensor='sensor.energy')
    result = {e['entry_id']: e for e in management_data(hass)['entries']}
    assert result[first.entry_id]['device_name'] == 'Unassigned'
    assert result[second.entry_id]['device_name'] == 'Device unavailable'
    assert result[third.entry_id]['device_name'] == 'Multiple devices'


async def test_panel_registration_assets_and_single_lifecycle(hass, hass_client):
    assert await async_setup_component(hass, DOMAIN, {})
    panel = hass.data['frontend_panels']['appliance-meter']
    assert panel.require_admin is True
    module_url = panel.config['_panel_custom']['module_url']
    assert module_url.startswith('/appliance_meter_frontend/')
    assert module_url.endswith('/panel.js')
    assert len(module_url.split('/')[-2]) == 16
    consumption = hass.data['frontend_panels']['appliance-consumption']
    assert consumption.require_admin is True
    assert consumption.sidebar_title is None
    assert panel.sidebar_title == 'Appliance Meter'
    consumption_url = consumption.config['_panel_custom']['module_url']
    assert consumption_url == urljoin(module_url, 'consumption.js')
    assert await async_setup_component(hass, DOMAIN, {})
    assert hass.data['frontend_panels']['appliance-meter'] is panel
    client = await hass_client()
    for asset in ['panel.js', 'flow.js', 'device-selector.js', 'consumption.js', 'consumption-data.js', 'period-presentation.js', 'cost-debug.js']:
        response = await client.get(urljoin(module_url, asset))
        assert response.status == 200
        text = await response.text()
        assert 'DO NOT EXPOSE' not in text
        if asset == 'panel.js':
            assert 'from "./flow.js"' in text
            assert 'Create Appliance' in text
            assert 'rowActionMenu' in text


def test_frontend_version_changes_with_any_asset(tmp_path):
    (tmp_path / 'panel.js').write_text('import "./flow.js";')
    (tmp_path / 'flow.js').write_text('export const value = 1;')
    initial = frontend_version(tmp_path)
    assert frontend_version(tmp_path) == initial
    (tmp_path / 'flow.js').write_text('export const value = 2;')
    dependency_changed = frontend_version(tmp_path)
    assert dependency_changed != initial
    (tmp_path / 'panel.js').write_text('import "./flow.js"; // updated')
    assert frontend_version(tmp_path) != dependency_changed
    (tmp_path / 'panel.js').write_text('import "./flow.js";')
    (tmp_path / 'flow.js').write_text('export const value = 1;')
    assert frontend_version(tmp_path) == initial


async def test_websocket_admin_readonly_and_non_admin_denial(hass, hass_ws_client, hass_admin_user):
    entry = appliance(hass, 'Existing', price_sensor='sensor.price', secret='hidden')
    assert await async_setup_component(hass, DOMAIN, {})
    token = hass.auth.async_create_access_token(await hass.auth.async_create_refresh_token(hass_admin_user, client_id='https://example.test'))
    admin = await hass_ws_client(hass, access_token=token)
    original = (dict(entry.data), dict(entry.options))
    with patch('homeassistant.helpers.storage.Store.async_save', new_callable=AsyncMock) as save:
        await admin.send_json({'id': 1, 'type': 'appliance_meter/management'})
        response = await admin.receive_json()
        assert response['success'] is True
        assert response['result']['entries'][0]['name'] == 'Existing'
        assert 'hidden' not in json.dumps(response)
        save.assert_not_called()
    await admin.send_json({'id': 2, 'type': 'appliance_meter/cost_debug', 'entry_id': entry.entry_id})
    response = await admin.receive_json()
    assert response['success']
    assert response['result'] == {'available': True, 'currency': 'DKK', 'calculations': []}
    await admin.send_json({'id': 3, 'type': 'appliance_meter/cost_debug', 'entry_id': 'missing'})
    assert (await admin.receive_json())['error']['code'] == 'not_found'
    user = await hass.auth.async_create_user('Non administrator' , group_ids=[GROUP_ID_USER])
    token = hass.auth.async_create_access_token(await hass.auth.async_create_refresh_token(user, client_id='https://example.test'))
    nonadmin = await hass_ws_client(hass, access_token=token)
    await nonadmin.send_json({'id': 1, 'type': 'appliance_meter/management'})
    response = await nonadmin.receive_json()
    assert response['success'] is False
    assert response['error']['code'] == 'unauthorized'
    assert 'result' not in response
    await nonadmin.send_json({'id': 2, 'type': 'appliance_meter/cost_debug', 'entry_id': entry.entry_id})
    response = await nonadmin.receive_json()
    assert response['error']['code'] == 'unauthorized'
    assert (dict(entry.data), dict(entry.options)) == original


async def test_actual_ha_flow_schemas_match_renderer(hass, hass_client):
    """Check real serialized HA schemas, not just hand-written JS fixtures."""
    import subprocess
    from pathlib import Path

    first = appliance(hass, 'Existing', energy_sensor='sensor.assigned')
    total = appliance(hass, 'IT', appliance_type='aggregate', members=[first.entry_id])
    assert await async_setup_component(hass, DOMAIN, {})
    assert await async_setup_component(hass, 'config', {})
    client = await hass_client()
    steps = []
    response = await client.post('/api/config/config_entries/flow', json={'handler': DOMAIN})
    initial = await response.json(); assert response.status == 200
    steps.append(initial)
    flow_id = initial['flow_id']
    response = await client.post('/api/config/config_entries/flow/'+flow_id, json={'name': ''})
    blank = await response.json(); assert blank['errors'] == {'name': 'blank_name'}
    steps.append(blank)
    response = await client.post('/api/config/config_entries/flow/'+flow_id, json={'name': 'Manual'})
    sensors = await response.json(); assert sensors['step_id'] == 'sensors'
    steps.append(sensors)
    response = await client.post('/api/config/config_entries/flow/'+flow_id, json={'energy_sensor': 'sensor.assigned'})
    error = await response.json(); assert error['errors'] == {'energy_sensor': 'energy_in_use'}
    steps.append(error)
    await client.delete('/api/config/config_entries/flow/'+flow_id)
    response = await client.post('/api/config/config_entries/flow', json={'handler': DOMAIN})
    flow_id = (await response.json())['flow_id']
    response = await client.post('/api/config/config_entries/flow/'+flow_id, json={'name': 'IT', 'appliance_type': 'aggregate'})
    aggregate = await response.json(); assert aggregate['step_id'] == 'aggregate'
    steps.append(aggregate)
    await client.delete('/api/config/config_entries/flow/'+flow_id)
    for entry in [first, total]:
        response = await client.post('/api/config/config_entries/options/flow', json={'handler': entry.entry_id})
        step = await response.json(); assert response.status == 200
        steps.append(step)
        await client.delete('/api/config/config_entries/options/flow/'+step['flow_id'])
    renderer = (Path(__file__).parents[1]/'custom_components/appliance_meter/frontend/flow.js').as_uri()
    script = '''
import {readFileSync} from 'node:fs';
const {checkSchema, formValues} = await import(process.argv[1]);
for (const step of JSON.parse(readFileSync(0, 'utf8'))) {
    checkSchema(step.data_schema); formValues(step);
}
'''
    result = await hass.async_add_executor_job(lambda: subprocess.run(
        ['node', '--input-type=module', '-e', script, renderer], input=json.dumps(steps),
        text=True, capture_output=True, timeout=15))
    assert result.returncode == 0, result.stderr
    assert {e.entry_id for e in hass.config_entries.async_entries(DOMAIN)} == {first.entry_id, total.entry_id}


def test_metering_devices_filter_metadata_and_ownership_without_name_heuristics(hass):
    registry = dr.async_get(hass)
    entities = er.async_get(hass)
    expected = []
    for index, (domain, label, dc, sc, unit) in enumerate([
        ('esphome', 'zeta meter', 'power', 'measurement', 'kW'),
        ('shelly', 'Alpha device', 'energy', 'total_increasing', 'Wh'),
        ('unrelated_vendor', 'Unusual hardware', 'energy', 'total', 'kWh'),
        ('esphome', 'Athom invalid unit', 'power', 'measurement', 'VA'),
        ('esphome', 'Temperature only', 'temperature', 'measurement', '°C'),
        ('esphome', 'Wrong state class', 'energy', 'measurement', 'kWh'),
        (DOMAIN, 'Physical virtual appliance', 'power', 'measurement', 'W'),
        (DOMAIN, 'Custom Total', 'energy', 'total', 'kWh'),
    ]):
        entry = MockConfigEntry(domain=domain); entry.add_to_hass(hass)
        device = registry.async_get_or_create(config_entry_id=entry.entry_id,
            identifiers={(domain, f'identity-{index}')}, connections={('mac', f'00:11:22:33:44:{index:02x}')}, name=label)
        entity = entities.async_get_or_create('sensor', domain, f'meter_{index}',
            device_id=device.id, original_device_class=dc, capabilities={'state_class': sc},
            unit_of_measurement=unit, disabled_by=er.RegistryEntryDisabler.USER)
        if index < 3:
            expected.append(device.id)
            if index == 1:
                registry.async_update_device(device.id, name_by_user='a FRIENDLY name')
    unrelated = MockConfigEntry(domain='esphome'); unrelated.add_to_hass(hass)
    registry.async_get_or_create(config_entry_id=unrelated.entry_id,
                                identifiers={('esphome', 'no-sensors')}, name='Athom Shelly meter')
    devices = management_data(hass)['devices']
    assert {device['value'] for device in devices} == set(expected)
    assert [device['label'] for device in devices] == ['a FRIENDLY name', 'Unusual hardware', 'zeta meter']
    assert all(device['entity_ids'] and device['identifiers'] for device in devices)
    assert '00:11:22:33:44:01' in devices[0]['identifiers']
    assert all(device['unavailable'] for device in devices)
