# Development activation and rollback

Session observation is unreleased and defaults to Off. Local integration and tests
do not authorize installation, restart, appliance operations or historical import.

Before a separately approved rollout, back up then-current code, config entries,
entity/device registry, lifetime accounting stores and any session stores.
Record stable IDs, sources, totals and baselines; review the precise diff and version.
Deploy code with entries Off, using a separately approved controlled restart.
Confirm identity and total continuity before enabling Shadow on one idle appliance.

Observe new independently confirmed runs before relying on detector boundaries.
Dishwasher candidates are not firmware confirmation. Keep existing learning helpers
and automations separate: Shadow never writes them or commands a device.
No live historical backfill/import endpoint is provided.

To stop observation, set the existing entry Off. Flush/preserve its separate ledger;
its diagnostic entity may remain registered but unavailable. Do not delete entries,
purge statistics or restore old totals.

A code rollback restores previous code after authorization while preserving the
CURRENT accounting store, entries and registry. Keep additional session stores
backed up; older code can ignore them. Data restoration is a distinct corruption-
recovery decision because old accounting files can lose or duplicate new consumption.

Stop rollout if identities change, totals jump/reset, stores fail to load, pauses
split sessions or completion uncertainty disappears. No automatic production
rollback, reload or restart is part of this development branch.
