# Release checks

Repository: [MyHAEsp/ha-appliance-meter](https://github.com/MyHAEsp/ha-appliance-meter)
Maintainer and code owner: [@SysAdminDk](https://github.com/SysAdminDk).
The project uses the complete [MIT License](../LICENSE),
Copyright (c) 2026 Jan Kristensen.

## Local validation

Run the backend and frontend commands in README.md, then:

```sh
python scripts/validate_package.py --release
git diff --check
```

The offline checker verifies packaging structure, translation parity, frontend
imports and release metadata. It is not a substitute for HACS or hassfest.
Use actionlint to validate the workflow files when available.

The GitHub workflows run tests and hassfest for private and public repositories.
HACS runs only when the repository is public. The validation workflow listens
to the public event, so changing visibility starts HACS and hassfest; manual
workflow_dispatch is also available. Inspect actual job results before declaring
HACS compatibility. A skipped job is not evidence that its validation passed.

Full local hassfest can be run with Docker when available:

```sh
docker run --rm -v "$PWD:/github/workspace" ghcr.io/home-assistant/hassfest:latest
```

References: [HACS integration requirements](https://www.hacs.xyz/docs/publish/integration/),
[HACS general requirements](https://www.hacs.xyz/docs/publish/start/),
[hassfest](https://contributors.home-assistant.io/glossary/hassfest/).

## Publication

Review the complete reachable Git history, author identities, fixtures, README,
manifest, HACS metadata and workflows for private information. The history starts
at a sanitized root snapshot; do not import earlier development commits.
Push only reviewed changes to main without force or mirror options.

The owner has authorized making this repository public after preparation and
checks. Use authenticated GitHub CLI/API access with repository administration
permission, or change visibility manually in repository settings. If that access
is unavailable, stop before changing visibility and report the manual action.
After the change, verify unauthenticated repository access and the HACS/hassfest
runs. Do not claim publication based on an SSH push alone.

The repository can be used as a HACS custom repository after validation. HACS
requires brand assets, including a brand/icon.png file; this repository does not
yet supply brand assets, so HACS brand validation remains outstanding.
Repository description, topics and enabled issues must also be checked through
authenticated GitHub settings/API access. Catalog inclusion and a versioned
GitHub release are separate steps. No tag, release, or external catalog/brand
submission is created automatically.

## Accounting compatibility

Release preparation changes licensing, ownership metadata, documentation and
workflows. It does not change integration identity, accounting behavior,
persistent totals, config-entry data, source baselines or entity unique IDs.

Legacy stores without a currency retain DKK totals and units. New stores retain
their original configured currency across reloads. No currency conversion,
accounting migration, appliance edits or Home Assistant deployment is performed.
