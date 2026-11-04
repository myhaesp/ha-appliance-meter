# Development and public test data

Use Python 3.14 and an isolated virtual environment:

```sh
python3.14 -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
npm ci
.venv/bin/python -m pytest -q
npm test
.venv/bin/python scripts/validate_package.py --release
git diff --check
```

Tests use temporary HA instances and a simulated DOM. Never connect them to a real
installation. The test dependencies pin Home Assistant 2026.10.4 and its matching
pytest fixtures. Node 20+ is supported; CI uses Node 22.

tests/fixtures/build_synthetic_profiles.py constructs public step functions from
simple declared segments. synthetic_profiles.json contains relative seconds,
synthetic counter baselines and invented positive/negative prices. No Recorder
input or installation snapshot is used. Regenerate it with Python and review
the deterministic diff.

Synthetic replay tests cover early motor onset, heating, a long dishwasher pause,
candidate completion, later auxiliary activity, dryer aftercare, counter/pricing
boundaries and snapshot restoration. Additional adversarial/runtime tests cover
missing/reset data, stale/restored reports, price coverage, admin API access,
Off/Shadow lifecycle, mapping swaps, stable IDs and preserved lifetime totals.
Synthetic success is not prospective validation of real appliance programs.

Private measured references and installation snapshots are deliberately absent.
Public tests and CI must not depend on private datasets, paths or credentials.
Integration checks with the companion Scheduling branch can be run separately in
an isolated temporary HA instance; neither public suite requires the other repo
or a live HA server.

Release versions are maintained in manifest.json and pyproject.toml together.
Public fixtures are synthetic and must not require Scheduling, private data or HA.
