"""End-to-end replays of constructed profiles, independent of private Recorder excerpts."""
from decimal import Decimal
import json
from pathlib import Path
import pytest
from custom_components.appliance_meter.sessions import SessionEngine

DATA=json.loads((Path(__file__).parent/'fixtures/synthetic_profiles.json').read_text())
assert DATA['synthetic_only']
RUNS=DATA['runs']

def replay(run, restore_at=None):
    engine=SessionEngine(run['profile'],origin='historical_reconstruction')
    for row in run['prices']:
        engine.prices.add(row['start'],row['end'],row['price'],provenance=row['provenance'])
    events=[(t,0,v) for t,v in run['energy']]+[(t,1,v) for t,v in run['power']]
    events += [(t,2,None) for t in range(0,run['stop']+1,5)]
    restored=False
    for at,kind,value in sorted(events):
        if restore_at is not None and at>=restore_at and not restored:
            engine=SessionEngine.restore(engine.snapshot());restored=True
        if kind==0:engine.on_energy(at,value)
        elif kind==1:engine.on_power(at,value)
        else:engine.advance(at)
    return engine

@pytest.mark.parametrize('run',RUNS,ids=lambda r:r['id'])
def test_synthetic_profile_counter_price_boundaries_and_no_split(run):
    engine=replay(run)
    assert len(engine.records)==1
    row=engine.records[0];expected=run['expected']
    assert row['start']==expected['start']
    assert row['end']==expected['end']
    assert row['energy_complete']
    assert Decimal(row['kwh'])==pytest.approx(Decimal(expected['kwh']),abs=Decimal('1e-20'))
    assert Decimal(row['cost'])==pytest.approx(Decimal(expected['cost']),abs=Decimal('1e-20'))
    assert Decimal(row['unpriced_kwh'])==0
    assert row['duration_seconds']==expected['end']-expected['start']
    if run['profile']=='tumble_dryer':
        assert row['main_end']==expected['main_end']
        assert row['aftercare_seconds']>0
        assert Decimal(row['aftercare_kwh'])>0
    if run['profile']=='dishwasher':
        assert row['status']=='candidate_completed'
        assert row['finish_evidence']['confidence']=='unverified_candidate'
        assert len(row['auxiliary_events'])==2
        assert all(a['start']>row['end'] for a in row['auxiliary_events'])
        assert any(p['state']=='low_load_hold' for p in row['phases'])
    if run['profile']=='washing_machine':
        assert row['start']<300  # Early motor pulses, before the constructed heater.

@pytest.mark.parametrize('run',RUNS,ids=lambda r:r['id'])
def test_synthetic_restore_retains_session_timing_energy_prices_and_quality(run):
    original=replay(run).records[0]
    restored=replay(run,restore_at=500).records[0]
    for key in ['start','end','duration_seconds','kwh','cost','quality','main_end','aftercare_kwh']:
        assert original.get(key)==restored.get(key)
