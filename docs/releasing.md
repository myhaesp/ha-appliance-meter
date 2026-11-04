# Release checks

Repository: [MyHAEsp/ha-appliance-meter](https://github.com/MyHAEsp/ha-appliance-meter)
Maintainer and code owner: [@SysAdminDk](https://github.com/SysAdminDk).
The project uses the complete [MIT License](../LICENSE),
Copyright (c) 2026 Jan Kristensen.

## Local validation

Run the backend and frontend commands in [development.md](development.md), then:

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

Release 0.2.1 publishes the installed session functionality with HACS metadata
and CONFIG_SCHEMA compatibility. Scheduling is an independent project.
