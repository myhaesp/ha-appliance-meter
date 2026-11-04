"""Synthetic adversarial coverage of gaps, candidate completion, prices and replay."""
from decimal import Decimal

import pytest

from custom_components.appliance_meter.session_pricing import PriceBook, decimal
from custom_components.appliance_meter.sessions import SessionEngine, integral


def begin(profile='washing_machine', *, counter=True):
    engine = SessionEngine(profile, energy_source=counter)
    engine.prices.add(0, 100000, '2')
    engine.on_energy(0, 10)
    engine.on_power(0, 0)
    engine.on_power(120, 300 if profile == 'tumble_dryer' else 60)
    engine.advance(185)
    assert engine.active
    return engine


def end_wash(engine):
    engine.on_energy(300, 11)
    engine.on_power(300, 0)
    engine.on_energy(360, 11)
    engine.advance(901)
    assert len(engine.records) == 1
    return engine.records[0]


@pytest.mark.parametrize('value', [True, False, None, 'NaN', 'Infinity', '-Infinity', '', 'oops'])
def test_invalid_values_never_become_measured_zero(value):
    assert decimal(value) is None


def test_historical_interval_pricing_missing_currency_never_needs_a_current_price():
    book = PriceBook()
    book.add(0, 900, 2)
    book.add(900, 1800, -1)
    rows = book.allocate(600, 1200, 1)
    assert [Decimal(r['kwh']) for r in rows] == [Decimal('.5'), Decimal('.5')]
    assert sum(Decimal(r['cost']) for r in rows) == Decimal('.5')
    assert book.allocate(1800, 1900, '.1')[0]['price'] is None
    assert not book.add(0, 0, 1)
    assert not book.add(0, 10, float('nan'))
    assert not book.add(0, 10, True)


def test_conflicting_prices_are_unpriced_and_snapshot_restoration_retains_evidence():
    book = PriceBook()
    book.add(0, 900, 2)
    book.add(0, 900, 3)
    row = PriceBook(book.rows).allocate(0, 900, 1)[0]
    assert row['reason'] == 'price_conflict'
    assert row['cost'] is None


def test_exact_counter_energy_and_buffered_start_are_independent_of_confirmation():
    engine = begin()
    row = end_wash(engine)
    assert row['start'] == 120
    assert row['start_confirmed'] > row['start']
    assert row['end'] == 300
    assert row['end_confirmed'] >= 900
    assert Decimal(row['kwh']) == 1
    assert Decimal(row['cost']) == 2
    assert row['duration_seconds'] == 180
    assert row['origin'] == 'shadow_observation'


def test_counter_reset_retains_only_known_segments_and_never_claims_complete_cost():
    engine = begin()
    engine.on_energy(200, 11)
    engine.on_energy(250, 0)
    engine.on_energy(300, '.2')
    engine.on_power(300, 0)
    engine.on_energy(360, '.2')
    engine.advance(901)
    row = engine.records[0]
    assert row['kwh'] is None
    assert Decimal(row['known_kwh']) == Decimal('1.2')
    assert not row['energy_complete']
    assert row['cost'] is None
    assert 'counter_reset' in row['quality']


def test_unavailable_counter_recovers_without_losing_the_valid_baseline():
    engine = begin()
    engine.on_energy(200, None)
    row = end_wash(engine)
    assert Decimal(row['kwh']) == 1
    assert row['energy_complete']
    assert 'counter_unavailable' in row['quality']


def test_missing_end_counter_is_partial_not_zero_or_synthetic_complete_energy():
    engine = begin()
    engine.on_energy(250, '10.2')
    engine.on_power(300, 0)
    engine.advance(901)
    row = engine.records[0]
    assert not row['energy_complete']
    assert 'counter_boundary_missing' in row['quality']
    assert row['cost'] is None


def test_missing_prices_disclose_partial_cost_and_unpriced_energy():
    engine = begin()
    engine.prices.rows.clear()
    row = end_wash(engine)
    assert row['known_cost'] == '0'
    assert row['cost'] is None
    assert Decimal(row['unpriced_kwh']) == 1
    assert 'price_missing' in row['quality']


def test_power_fallback_and_unknown_spans_are_explicit():
    engine = begin(counter=False)
    engine.on_power(240, None)
    engine.on_power(250, 60)
    engine.on_power(300, 0)
    engine.advance(901)
    row = engine.records[0]
    assert row['unknown_power_seconds'] == 10
    assert not row['energy_complete']
    assert row['cost'] is None
    assert row['kwh'] is None
    assert Decimal(row['known_kwh']) == Decimal(60) * 170 / 3600000
    assert 'power_integration' in row['quality']


def test_restart_gap_is_not_a_ten_minute_idle_confirmation():
    engine = begin()
    engine.on_energy(300, 11)
    saved = engine.snapshot()
    restored = SessionEngine.restore(saved)
    restored.resume(2000)
    restored.on_power(2000, 0)
    restored.on_energy(2000, 12)
    assert not restored.records
    assert restored.active
    restored.advance(2500)
    assert not restored.records
    restored.on_energy(2070, 12)
    restored.advance(2601)
    row = restored.records[0]
    assert row['end'] == 2000
    assert 'restart_gap' in row['quality']
    assert 'end_uncertain' in row['quality']


def test_measurement_gap_cannot_end_a_session_or_confirm_a_door_candidate():
    engine = begin('dishwasher')
    engine.on_power(200, 1800)
    engine.on_power(300, None)
    engine.advance(4000)
    assert not engine.records
    assert engine.state == 'measurement_gap'
    engine.on_power(4001, 0)
    engine.advance(10000)
    assert not engine.records  # No door signature: no fabricated program end.


def test_forty_five_minutes_of_low_consumption_remains_inside_one_dishwasher_run():
    engine = begin('dishwasher')
    engine.on_power(200, 1800)
    engine.on_power(400, 0)
    engine.advance(400 + 45 * 60)
    assert engine.active
    assert not engine.records
    assert engine.state == 'low_load_hold'
    engine.on_power(3200, 1800)
    assert engine.state == 'running'


def test_isolated_motor_or_noise_never_starts_a_new_program():
    for profile in ('washing_machine', 'tumble_dryer', 'dishwasher'):
        engine = SessionEngine(profile)
        engine.on_power(0, 0)
        for at in range(120, 2000, 250):
            engine.on_power(at, 9)
            engine.on_power(at + 20, 0)
        engine.advance(3000)
        assert engine.active is None
        assert not engine.records


def test_missing_source_on_startup_is_not_a_confirmed_onset():
    engine = SessionEngine('washing_machine', energy_source=False)
    engine.on_power(120, 60)
    engine.advance(185)
    assert 'start_uncertain' in engine.active['quality']


def test_context_change_interruption_never_invents_end_or_complete_energy():
    engine = begin()
    engine.interrupt(250, 'configuration_changed')
    row = engine.records[0]
    assert row['end'] is None
    assert row['duration_seconds'] is None
    assert row['kwh'] is None
    assert row['status'] == 'interrupted'
    assert 'configuration_changed' in row['quality']


def test_unknown_store_version_and_origin_are_not_silently_migrated():
    with pytest.raises(ValueError):
        SessionEngine.restore({'algorithm': 100})
    with pytest.raises(ValueError):
        SessionEngine('coffee_machine')
    with pytest.raises(ValueError):
        SessionEngine('washing_machine', origin='measured_without_evidence')


def test_late_or_out_of_order_reading_is_rejected_instead_of_rewriting_the_past():
    engine = begin()
    original = engine.snapshot()
    engine.on_power(100, 1000)
    assert engine.power == original['power']
    assert 'out_of_order_data' in engine.active['quality']


def test_a_door_motor_in_isolation_does_not_start_a_program():
    engine = SessionEngine('dishwasher', energy_source=False)
    engine.on_power(0, 0)
    engine.on_power(120, 34)
    engine.on_power(165, 0)
    engine.advance(600)
    assert engine.active is None
    assert not engine.records


def test_same_sensor_constant_price_intervals_and_decimal_conservation():
    book = PriceBook()
    book.add(0, 900, '2')
    book.add(900, 1800, '2')
    pieces = book.allocate(100, 1700, '0.000000123')
    assert sum(Decimal(p['kwh']) for p in pieces) == Decimal('0.000000123')
    assert sum(Decimal(p['cost']) for p in pieces) == Decimal('0.000000246')


def test_coincident_counter_jumps_are_known_energy_with_unknown_time_not_free_cost():
    engine = begin()
    engine.on_energy(250, '10.3')
    engine.on_energy(250, '10.4')
    engine.on_power(300, 0)
    engine.on_energy(360, '10.4')
    engine.advance(901)
    row = engine.records[0]
    assert Decimal(row['kwh']) == Decimal('.4')
    assert Decimal(row['unpriced_kwh']) == Decimal('.1')
    assert row['cost'] is None
    assert 'energy_timing_unknown' in row['quality']


def test_sample_cap_never_presents_truncated_observations_as_complete(monkeypatch):
    import custom_components.appliance_meter.sessions as sessions
    monkeypatch.setattr(sessions, 'MAX_SAMPLES', 10)
    engine = begin()
    for at in range(200, 250):
        engine.on_power(at, 60 + at % 2)
    row = end_wash(engine)
    assert len(engine.power) <= 10
    assert 'sample_limit' in row['quality']
    assert not row['energy_complete']
    assert row['cost'] is None


def test_second_dryer_run_never_inherits_previous_main_phase_boundary():
    engine = begin('tumble_dryer', counter=False)
    engine.on_power(300, 0)
    engine.advance(901)
    assert len(engine.records) == 1
    engine.on_power(1200, 220)
    engine.advance(1265)
    assert engine.active
    assert engine.active['start'] == 1200
    assert engine.active['main_end'] is None
    assert engine.active['aftercare_start'] is None
    engine.on_power(1400, 0)
    engine.advance(1701)
    assert engine.active['main_end'] == 1400


def test_old_negative_price_is_not_applied_outside_its_published_interval():
    book = PriceBook()
    book.add(0, 900, '-1')
    pieces = book.allocate(800, 1000, '.2')
    assert pieces[0]['cost'] == '-0.1'
    assert pieces[1]['price'] is None
    assert pieces[1]['reason'] == 'price_missing'
