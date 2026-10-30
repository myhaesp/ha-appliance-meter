# Appliance Meter

Independent Home Assistant custom integration, domain `appliance_meter`. Tracks appliance energy and electricity costs with stable logical sensors and a built-in management panel.

## Installation

Repository: MyHAEsp/ha-appliance-meter. Prepared for private development; no public release or license has been approved.

For manual installation, copy the complete `custom_components/appliance_meter`
directory into your Home Assistant configuration’s `custom_components` directory.
Restart Home Assistant, then add **Appliance Meter** through
**Settings → Devices & services → Helpers**. Create an appliance, confirm its
power/energy sources, and optionally select an electricity price sensor.
The sidebar panel appears once the first appliance is configured.

Once published, add the approved repository URL to HACS as an **Integration**
custom repository, download Appliance Meter, and restart Home Assistant.
HACS installs the integration files; appliance configuration stays in Home Assistant.

Before upgrading, back up your Home Assistant configuration, including
`.storage/appliance_meter.*` and Recorder data. Upgrades retain entry IDs,
source assignments, baselines and totals. Removing an appliance permanently
deletes its private accounting store; Recorder history follows Home Assistant’s
own retention policy. Unloading or reloading an appliance preserves its store.

## Configuration and logical entities

Each manually created config entry represents one appliance. Enter a name and select a metering device using Home Assistant's device registry. Power and Energy are resolved independently using device registry membership, device class, state class, and units. Matching never guesses from names, manufacturer, MAC vendor prefixes, icons, entity ID patterns, or the size of a reading. Power requires measurement state class and W/kW; Energy candidates require total or total_increasing and Wh/kWh. Disabled and unavailable entities remain candidates when their registry metadata is sufficient.


The panel's metering-device control is a searchable keyboard-accessible combobox,
sorted by friendly name. Search matches names, candidate sensor entity IDs, MAC
suffixes (with or without separators), and available registry identifiers. Only
devices with at least one Power (`measurement`, W/kW) or Energy (`total` or
`total_increasing`, Wh/kWh) sensor are offered, including registry-only/offline
sensors. Appliance Meter virtual devices and Custom Totals are excluded by registry
ownership, and the backend rejects them even when submitted outside the panel.
Manufacturer and device-name patterns never determine eligibility.

In Edit, the device is derived from current Power/Energy assignments and is only a
temporary selection aid: no `device_id` is persisted. Changing it filters sensor
choices but retains current assignments until the user explicitly changes or clears
them. The backend checks new choices against the selected device. Missing devices,
unavailable sensors and mixed-device assignments retain their existing sources;
no automatic re-resolution, baseline change or migration runs during editing.

A unique compatible Power sensor is preselected. Energy is suggested only for one unambiguous cumulative candidate: a verified native Shelly EMData/EM1Data consumption identity, or (for other integrations) current, non-restored metadata following [HA's non-resetting-total convention](https://contributors.home-assistant.io/core/entities/sensor/#choosing-between-total-classes). Shelly returned/exported counters are never suggested; unknown Shelly identities remain manual. `total_increasing` alone never proves persistence. Athom and unknown ESPHome `total_increasing` Energy counters retain manual selection because their metadata does not identify a persistent lifetime counter. Every physical appliance creation shows the sensor confirmation form, so suggestions can be changed or cleared before saving. See [energy resolution evidence and scope](docs/energy-resolution.md).

The sensor selectors display candidate names and entity IDs and preselect any independently resolved assignment. Power/Energy choices are restricted to compatible entities on the selected device and revalidated on submit. If a sensor type has no candidates, its selector is omitted; the appliance can still be created with that assignment empty. No sensors are enabled or reassigned in HA. Select any compatible electricity price sensor, or leave it unassigned; there is no provider-specific default. Clearing a suggested optional field leaves it unassigned.

Configure retains the existing options flow for editing name and all sensor assignments. An energy sensor can belong to only one appliance, and logical Appliance Meter sensors cannot be selected as sources. Device resolution runs only during creation; existing entries, baselines, assignments and totals are not migrated or recalculated.

Each entry registers one logical device and four sensors: Power (W), Energy Total (kWh), Cost Total (accounting currency), Unpriced Energy (kWh). Unique IDs use the config entry ID and logical sensor key, so changing the appliance name or source does not replace entities or their history. HA retains any user-customized entity or device names.

Power follows its source through state listeners, supports W and kW, and becomes unavailable for missing, invalid, nonfinite or unavailable readings. All entities are created even without sources. Options changes reload the entry and remove old listeners.

## Management panel

Administrators can open **Appliance Meter** in the Home Assistant sidebar, or
visit `/appliance-meter`. List is the default view, with these columns in order:
**Appliance**, **Meter**, **kWh Day**, **kWh month**, **Cost Day**, **Cost month**,
**Cost year**, **Actions**.
The toolbar provides search, a Card/List toggle, type/status filters and sorting,
and **Create Appliance**. The selected view is remembered in this browser.
Cards show the same meter and period information and actions, without graphs.
Automatic metric refreshes retain rows, cards and open action menus. Numeric
sort reordering waits until the menu closes; inventory/assignment changes rebuild
the results.
Search matches friendly appliance, meter and member names and configuration status.

Names open appliance configuration details. The Actions menu provides details,
Edit and Delete. Create Appliance uses the existing flow, including physical
meters, virtual appliance sensors and Custom Totals. Physical meter names come
from the registry; Custom Totals are labelled explicitly. Configuration problems
remain visible in details and through status indicators and filters.

Appliance details include **Cost Calculation Debug**: timestamp, measured energy
delta, the price actually used and the recorded cost increment, with exact Decimal
precision (at least four decimal places), plus the multiplication and a compact
history. The accountant retains only the last 10 energy increments in memory;
restart or appliance reload clears them. Price changes appear with the next energy
increment that uses them. Missing/invalid prices are explicitly unpriced with no
cost addition. Custom Totals perform no accounting; inspect their members instead.
The trace refreshes with logical energy updates while details are open, or via
Refresh calculations. The separate administrator-only `appliance_meter/cost_debug`
request exposes only this bounded diagnostic data. No additional sensors,
persisted history, accounting rules or totals are introduced.

Open an entry from List for the same configuration details.
Metering device names are derived from the assigned Power/Energy entities, not
stored as a second binding. Mixed or missing device associations are labelled.
Custom Total members use friendly appliance names; config entry IDs remain internal.
Delete requires confirmation and warns about dependent Custom Totals. Removal uses
HA's native config-entry API and the existing integration lifecycle.

Add/Edit submit only through HA config/options flow APIs; backend validation,
energy ownership rules and reload behavior remain authoritative. `frontend/flow.js`
is an isolated, panel-owned HTML form renderer supporting only the integration's
current text, device, entity, appliance-type and member checkbox fields. It honors
server defaults, candidate filters and validation errors. Unsupported schemas or
flow steps stop the form and direct users to Home Assistant Helpers in Settings;
nothing is silently omitted. Add/Edit dialogs keep Continue and Close together,
with Back when available, and do not contain a Helpers link.
It imports no HA frontend modules or bundled copies of HA form controls.

Back cancels the unfinished creation flow and opens a fresh initial form without
replaying submissions. It retains drafts when the original choices are unchanged;
changing those choices discards the later sensor draft. Closing a form cancels its
unfinished flow. No requests are automatically retried after an uncertain save.

The panel uses one administrator-protected, read-only WebSocket command,
`appliance_meter/management`, for allowlisted config-entry and registry metadata.
It never exposes accounting storage, runtime data or arbitrary entry configuration.
Live readings come directly from `hass.states`. HA config-entry and registry change
subscriptions refresh the list after edits through either the panel or Helpers.
Source availability updates arrive through `hass` state updates. Metadata requests
are coalesced while one is in flight; no polling or debounce timers are used.
There are no permanent Refresh/Helpers controls; connection failures ask users to
reload the page. Static JavaScript
contains no credentials or appliance configuration. The complete frontend asset tree
is fingerprinted at integration startup. The panel and its relative imports share
`/appliance_meter_frontend/<content-version>/` URLs, so changes to either module
invalidate both URLs without a frontend build step or manual cache clearing.
A new frontend version requires a Home Assistant restart to register its URL;
reload an already open HA page to receive the updated panel registration. No additional appliance store
or manager config entry is created.

The panel is registered once when the integration is set up, independently of
individual entry unloads/reloads. It remains available after removing the last
entry for the current HA session. With zero Appliance Meter entries after a HA
restart, use **Settings → Devices & services → Helpers** to add the first appliance
and load the integration again.

## Aggregate appliances / Custom Totals

Choose **Aggregate / Custom Total** in Add Integration, enter a name, and select
one or more existing physical Appliance Meter appliances. Configure edits the
name and membership; the native integration entry menu deletes the aggregate.
Duplicate selections and nested aggregates are rejected. Membership stores stable
config entry IDs; logical sensors are resolved through their unique IDs, so entity
renames do not break groups. Legacy entries remain physical without migration.

For example, an Office group can contain a computer, monitor and printer. Its Power, Energy Total, Cost Total and Unpriced Energy are the
current sums of those logical member values, in W, kWh, the shared accounting currency and kWh respectively. Mixed-currency cost totals are unavailable.
An aggregate never binds physical sensors, integrates energy, prices consumption,
creates an accounting store, or modifies its members' configuration or accounting.
The same physical appliance may appear in different groups; summing overlapping
groups elsewhere will double-count it.

**Accounting choice:** current member lifetime sums are simpler and more reliable
than a separate group baseline. They include consumption before a member joined.
Adding or removing a member immediately changes the displayed sum; they do not
mean "consumption since this group was created". Power has state class measurement.
Aggregate totals retain their energy/monetary device classes but deliberately have
**no state class**, excluding them from long-term statistics and Energy Dashboard
consumption calculations. This prevents membership changes from becoming false
consumption, reset or cost spikes. Raw recorder history still shows the actual
membership-induced step; each sensor records `member_entry_ids` to identify its
composition. A group baseline would require additional persisted accounting and
policy for membership, resets and missing data; it is intentionally not implemented.

Each metric requires a valid, finite value with the expected unit from every member.
A missing, disabled, unloaded, restored or unavailable member sensor makes that
aggregate metric unavailable; it never substitutes zero or publishes a partial sum.
Power can be unavailable while persisted member totals remain available. Deleting a
member leaves its ID selected and makes the group unavailable until membership is
explicitly edited. Configure labels missing IDs so they can be removed. Removing
one intentionally changes the sum; it does not erase historical recorder rows.
Restart/reload derives sums again from the members, remaining unavailable until
all required logical sensor values are ready. Aggregate deletion removes only the
group's entities; member identities, assignments, counters and baselines are retained.

## Consumption and cost dashboard

Consumption and cost are part of the unified **Appliance Meter** page.
The old `/appliance-consumption` URL opens the same implementation as a
compatibility route and has no separate sidebar entry. Numbers use Danish
formatting with two decimal places.

Day means today from local 00:00 in Home Assistant's timezone, including DST;
it is never a rolling 24-hour period. Month/year retain their calendar boundaries.
Periods start at calendar midnight in Home Assistant's timezone. Values are
differences of recorded cumulative readings, using native Recorder history and
statistics, never historical kWh multiplied by today's price. Missing
beginning-of-period history is visibly **Partial**, with the actual observation
date available by tapping/focusing the value. Missing readings and detected
discontinuities are explicit, without substituting zero. Custom Totals sum
their distinct **current physical members' period results**; no grand total
double-counts them. Recorded unpriced consumption is disclosed in cost coverage.

The view updates from HA entry/registry/statistics events and live counter
states. It creates no entities, helpers, stored counters, database or polling
service. Management actions reuse the existing flows; accounting is unchanged.
See [period calculations, coverage and limitations](docs/consumption-dashboard.md).

## Persistent accounting

The selected physical energy sensor supplies consumption in Wh or kWh. Its first valid reading establishes a baseline; logical totals start at zero. Positive differences increase Energy Total. Identical readings do nothing, and a decrease (including a reset to zero) establishes a fresh baseline. Missing, restored, unavailable, negative, nonfinite, or unsupported-unit readings preserve the last valid baseline, so recovery includes consumption since that reading.

Each delta uses the selected price sensor's finite value at the time of the update. New appliances use Home Assistant’s configured currency when their accounting store is first created. That currency is saved with the totals and remains fixed across reloads and changes to Home Assistant’s currency. Existing stores without a currency remain DKK, preserving every decimal total. Prices must use `<currency>/kWh`; `kr/kWh` is also accepted for DKK only. There is no currency conversion. Restored price states are rejected. To start accounting in another currency, create a separate appliance with an unassigned or different energy source rather than relabelling old totals. Negative electricity prices are supported. Missing, invalid, or incorrectly labelled prices add the delta to Unpriced Energy without changing Cost Total. Previously unpriced energy is not priced retroactively. After downtime, a recovered delta uses the price available at startup; historical prices cannot be reconstructed.

Home Assistant Store retains the fixed currency, decimal totals, the last normalized physical reading, and the source identity per config entry. Replacing or clearing the source preserves totals and establishes a new baseline. Accounting sensors remain available with their persisted totals even when no physical source is available. Their unique IDs remain unchanged.

Writes are atomic and batched within 30 seconds of the first pending change, with explicit startup, unload, and shutdown flushes. An abrupt process or power failure can lose up to that pending interval; the next reading recovers its energy delta from the saved baseline, using the then-current price.

## Development

Run from your checkout:

```sh
python3.14 -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
.venv/bin/python -m pytest -q
npm ci
npm test
```

Tested with Python 3.14 and Home Assistant 2026.10.4. Install `requirements-test.txt` into a virtual environment. With Node.js 20 or later, run `python -m pytest -q` for the backend suite (including a check of real HA flow schemas against the renderer). Run `npm ci` and `npm test` for the frontend DOM suite. Node dependencies are development-only; HA serves the plain JavaScript modules without a build step. Tests use temporary Home Assistant instances and a simulated browser DOM; they do not connect to the installed Home Assistant.

See [release preparation](docs/releasing.md) for remaining publication decisions and validation.
