# Source mapping and meter changes

The appliance's existing config entry is the authoritative mapping. Assign
power_sensor, energy_sensor and price_sensor in the options flow; never infer a
physical phase from a localized appliance name.

## Unreleased metadata interface

In this development branch, the four existing physical-appliance logical sensors
expose config_entry_id, power_entity_id, energy_entity_id and price_entity_id.
These read-only attributes project the configured assignments. No extra measurement
entity or second mapping table is created. Aggregates have members rather than a
fictional single physical source.

Prefer logical Energy Total as an attribute anchor: it remains available with its
persisted total when the physical source is offline. HA suppresses extra attributes
on unavailable entities, so Power is a less reliable metadata anchor.
Unloaded/deleted entries or cleared assignments return missing/null values; consumers
must not guess a phase or substitute missing measurements with zero.

For ordinary triggers use the stable logical Power entity. A consumer that needs a
raw counter can read state_attr(logical_energy, 'energy_entity_id'), validate the
result and its unit, then retain that source identity with its own baseline.
The administrator management API also exposes assignments. HA's config_entry_attr
does not expose private config-entry data/options to templates.

## Change sources while idle

Edit the existing appliance and preserve its name, session mode/profile and all
unrelated options. A normal reload removes old listeners and preserves entity,
device and config-entry identities, totals and currency.

A new energy entity establishes a fresh baseline; its lifetime reading is not added.
Restored/invalid readings cannot establish that baseline. Old-source updates no
longer count, repeated new-source readings count once, and a same-source reload
retains its baseline.

An active observed session whose source/profile context changes is archived as
interrupted with its original ID and sources. No final duration or energy is
invented across two meters. Lifetime accounting continues independently.

One physical energy entity cannot be assigned to two appliances. A source swap
is not atomic: an explicitly reviewed idle sequence must release an assignment,
move the second and then complete the first. Consumption during an unassigned
interval cannot safely be attributed or backfilled.

The companion Scheduling development branch consumes logical sensors and metadata.
Existing compatibility aliases retain their IDs and restored offsets. They need
not have the same absolute total as Appliance Meter. See its mapping guide.
