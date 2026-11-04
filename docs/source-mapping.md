# Source mapping and meter changes

The appliance's existing config entry is the authoritative mapping. Assign
power_sensor, energy_sensor and price_sensor in the options flow; never infer a
physical phase from a localized appliance name.

External consumers configure their own sensor references. Appliance Meter does
not publish extra sensor attributes for Scheduling or require it to be installed.
The projects can be maintained and released independently.

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
