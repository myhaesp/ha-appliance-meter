"""Offline package checks; --release also enforces pending maintainer decisions."""
import argparse
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def validate(release=False):
    integration = ROOT / "custom_components" / "appliance_meter"
    manifest = json.loads((integration / "manifest.json").read_text())
    hacs = json.loads((ROOT / "hacs.json").read_text())
    assert manifest["domain"] == "appliance_meter"
    assert re.fullmatch(r"\d+\.\d+\.\d+", manifest["version"])
    assert hacs["render_readme"] is True
    assert sorted(p.name for p in integration.parent.iterdir() if p.is_dir() and p.name != "__pycache__") == ["appliance_meter"]
    assert json.loads((integration / "strings.json").read_text()) == json.loads(
        (integration / "translations/en.json").read_text())
    for path in integration.rglob("*.js"):
        for module in re.findall(r'from\s+"(\.[^"]+)"', path.read_text()):
            assert (path.parent / module).is_file(), (path, module)
    pending = []
    for key in ("documentation", "issue_tracker", "codeowners"):
        if not manifest.get(key):
            pending.append(f"manifest.{key}")
    if not (ROOT / "LICENSE").is_file():
        pending.append("approved LICENSE")
    print("Offline package structure, JSON, English translation parity and JS imports: OK")
    if pending:
        print("Publication pending: " + ", ".join(pending))
    if release and pending:
        raise SystemExit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", action="store_true")
    validate(parser.parse_args().release)
