# Installation and upgrades

The integration is tested with Home Assistant 2026.10.4. Its Python runtime follows
Home Assistant; development tests use Python 3.14.

## HACS

Add the GitHub repository URL as a custom repository, category Integration.
Install the chosen released version and perform a controlled Home Assistant restart.
Add an Appliance Meter integration for each logical appliance. Existing appliances
are configured through their options flow or the sidebar administration page.
For a manual installation, copy only custom_components/appliance_meter to the same
directory in the HA configuration. Do not install two integration directories.

The sidebar combines consumption and management. The legacy /appliance-consumption
route remains a compatibility route, without a second sidebar entry. Custom Totals
are created through the integration's aggregate flow and refer to logical appliances.

## Upgrades

Back up existing integration code, configuration entries, entity/device registry
and accounting stores before changing versions. Keep existing entries and source
identities; never delete/recreate an appliance to upgrade it. A code rollback must
not restore old accounting totals over newer consumption.

The unreleased integration branch contains session observation and source metadata.
It is not installed by downloading v0.1.0. Review its version, tests and
[activation plan](activation-rollback.md) before any separate rollout.

A custom HACS repository is not proof of default-catalog inclusion or successful
provider CI. See [release checks](releasing.md) for validation boundaries.
