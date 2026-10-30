# Release preparation

This checkout is a candidate for the first private push to MyHAEsp/ha-appliance-meter.
Review PUBLICATION.md before any push. Public release and deployment are not authorized.

## Maintainer decisions

- Approve a license (MIT is proposed). No license grant is made by this preparation.
  Add the approved LICENSE with the approved copyright holder before publishing.
- Repository ownership is approved as MyHAEsp/ha-appliance-meter. Documentation
  and issue-tracker URLs are configured. Confirm an individual GitHub maintainer
  handle for codeowners; the organization is not assumed to be a maintainer.
- Confirm rights to license the complete source and any contributed assets.
- Review the exported files and neutral initial commit identity before publishing.
- Approve branding and any later submission to Home Assistant Brands.

## Validation

Run the commands in README.md plus:

```sh
python scripts/validate_package.py
python scripts/validate_package.py --release
```

The offline checker is a packaging preflight, not HACS or hassfest.
The release check intentionally fails until ownership metadata and LICENSE exist.
The GitHub workflow runs the official hassfest and HACS actions; those cannot
pass all publication requirements until ownership metadata and the public
repository exist. Full local hassfest can be run with Docker when available:

```sh
docker run --rm -v "$PWD:/github/workspace" ghcr.io/home-assistant/hassfest:latest
```

References: [HACS integration requirements](https://www.hacs.dev/docs/publish/integration/),
[HACS general requirements](https://hacs.dev/docs/publish/start/),
[hassfest](https://contributors.home-assistant.io/glossary/hassfest/).

## Publication history

This candidate has one fresh root commit with a neutral contributor identity;
it does not contain the development repository’s old commits or references.
Its origin uses `github-myhaesp:MyHAEsp/ha-appliance-meter.git`.

Before a private push, review the complete committed tree and author identity,
verify that the destination is private and empty, and obtain explicit approval.
A local pre-push hook blocks the candidate until that approval is recorded.
Push only the reviewed main branch. Do not use mirror, all-branches, tags, or
force-push options. Local development history remains in the original checkout.

License, copyright holder and individual codeowner remain pending. They do not
need to be invented for a private development repository. Public release, HACS
submission, repository visibility changes, and deployment each require approval.

## Accounting compatibility

Restored energy and price states are ignored. Live source readings retain the
existing delta/reset algorithm. Permanent deletion removes only the matching
per-entry accounting store after Home Assistant unloads its entities/listeners.
Unload/reload and shutdown continue to flush and preserve that store.

Old stores implicitly contain DKK and retain those totals and units. New stores
use Home Assistant’s configured currency, then persist it with the totals.
Changing Home Assistant’s currency does not convert, relabel or reset an existing
store. The added optional currency field needs no config-entry migration; old
stores load without it. Matching currency/kWh prices are required. The ambiguous
kr/kWh alias remains DKK-only. Mixed-currency aggregates never sum costs.
