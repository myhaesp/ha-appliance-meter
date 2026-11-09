# Appliance Consumption & Cost

The unified **Appliance Meter** sidebar panel at `/appliance-meter` combines
management with consumption and cost. The old `/appliance-consumption` route
opens the same UI, without a redundant sidebar entry. Both require administrator
access.

List is the default view: Appliance, Meter, kWh Day, kWh month, DKK Day,
DKK month, DKK year, Actions. The Card view shows the same data without graphs. Search, type/status
filters and sorting apply to both views. Names open existing configuration
details; actions reuse the existing edit/delete flows. Creation uses the existing
appliance/Custom Total flow. Only the view preference is stored locally.

Every data header toggles sorting; missing values stay last. Metrics use Danish
formatting with two decimal places. Select or focus a value to see its coverage
explanation. The table scrolls within its container on phones.

## Read-only period projection

`panel.js` owns the unified UI and lifecycle. `consumption.js` is a compatibility
alias. `period-presentation.js` presents the same metric and Partial explanation
in lists and cards. `consumption-data.js` retains the existing transient period
projection, with no new accounting or storage.

Period reads use the management projection, config entry creation timestamps,
Recorder statistics and bounded native history windows, including a midnight
snapshot for today. Identical day/month/year boundaries share one request. The view refreshes on
entry/registry changes, reconnect, Recorder statistics events and calendar rollover
in HA's timezone. Live counters update values without additional history queries.
Requests are coalesced and subscriptions stop on disconnect. Management remains
available when history cannot load. No polling service or additional counters
are created.

## Calendar boundary and identity rules

For each physical metric, the displayed difference is:

```
current recorded cumulative value - recorded boundary value
```

The day starts at local 00:00 today, rather than 24 hours ago. The month starts
at local midnight on the first, and the year at local midnight
on January 1, using `hass.config.time_zone`, independently of browser timezone.
The date conversion accounts for Danish summer/winter time. In Copenhagen,
October 1, 2026 is September 30 at 22:00 UTC; January 1 is December 31 at 23:00 UTC.
Ambiguous unsupported calendar boundaries fail rather than silently using UTC.

A raw Recorder start-state snapshot at the boundary is preferred. When that
history has been purged, a statistics snapshot is usable only if its **end**
equals the boundary: the preceding bucket's closing reading, not the first
bucket after midnight. A bucket whose end is still in the future is never used
as a completed snapshot. For compatible nonresetting counters, this follows
HA's end-of-bucket statistics convention without estimating missing readings.

All observations are fenced by the current config entry's creation timestamp.
Older history/statistics under a reused entity ID cannot become its baseline.
Creation time only locates actual readings: it never implies a zero baseline.
An entity rename is resolved using the existing registry-based mappings.

If the boundary baseline is missing, the earliest valid observed cumulative
reading belonging to this appliance is used, and the resulting subtotal is
explicitly **Partial**, with its actual start date/time. An appliance created
mid-period therefore never appears to cover the whole day/month/year. If there is
no usable observation interval, the cell says **No baseline**, not zero. If
creation metadata is unavailable, historical identity cannot be proven and the
cell also remains without a numeric value.

## Availability, resets and costs

Current missing, nonfinite, unavailable, restored or incompatible-unit readings
are **Unavailable**. A restart/unavailable gap inside an otherwise observed
interval can be bridged by valid persistent cumulative endpoints, following the
existing accountant's recorded values; missing states are never zero-filled.
Explicitly unavailable raw history at the boundary vetoes a supposedly complete
statistics fallback, requiring a later partial baseline instead.

Recorded energy/unpriced-energy decreases, changes in units, resets within the
observed interval, and changes in the statistics `sum - state` offset cause
**Discontinuity**, without silently repairing the data. Companion energy
discontinuities also invalidate the related cost result. An old reset timestamp
before the chosen baseline does not invalidate a later interval.

Cost is calculated solely from the existing **Cost Total** counter. Negative
cost differences remain valid because the accountant supports negative prices.
Unpriced Energy is inspected separately: positive recorded unpriced consumption,
or unknown pricing coverage, makes the cost visibly Partial and explains the
limitation. Missing prices are never backfilled with today's price. Previously
unpriced energy is not retroactively priced.

Values mean **as recorded by Appliance Meter**. Recovery deltas retain the
existing accountant's timing and price treatment. The dashboard cannot recover
unrecorded physical sample times or historical prices that the accountant never
stored. A cost-only unsignalled decrease cannot be distinguished from legitimate
negative-price costs using cumulative counters alone. Likewise, a discontinuity
completely hidden inside already aggregated/purged history cannot always be
identified. No stronger historical accuracy is claimed or new accounting added.

## Custom Totals and double counting

Existing Custom Total lifetime sensors intentionally have **no state class**.
Their values jump when memberships change, so subtracting their historical
lifetime sums would produce artificial consumption. These metadata/accounting
choices remain untouched.

Instead the dashboard sums the period results of each Custom Total's **distinct
current physical members**. The row explicitly says “Custom Total · current
members”; its coverage explanation states this basis. Membership edits therefore
change the set being compared, without adding membership-induced lifetime steps
to consumption. This is the current grouping of member periods, not a history of
which appliances belonged to a group on each day. It may include member period
readings from before the group itself was created.

Every member must exist, be physical and have a valid value for the metric.
Missing members, nested groups and duplicate membership fail closed. A member's
Partial coverage makes the group's metric Partial; intervals may differ and are
not claimed as a common complete day/month/year. Missing member values never become
a misleading partial numeric sum. There is no table footer or aggregate that
adds Custom Totals to their physical members.

## Validation

Run `.venv/bin/python -m pytest -q` and `npm test`. Tests cover native panel/asset
registration, the unified administration UI, calendar/DST/year rollover,
preceding-bucket boundaries, mid-period creation, reused IDs, missing history,
counter discontinuities, legitimate negative costs, unpriced energy, current
grouping, automatic inventory updates, sorting, safe HTML, lifecycle and access.

HA 2026.10.4 Recorder API behavior was checked during development
and returned all 13 configured rows, including Ovn and IT Infrastructure. A real
Chromium layout check used those recorded inputs at 1280×900, 1024×768, 768×1024
and 390×844; sorting and tapping coverage worked, with no page-level horizontal
overflow. Private live data and screenshots are kept outside the repository.

References: [HA long-term statistics](https://www.home-assistant.io/docs/configuration/long-term-statistics/)
and [Recorder statistics semantics](https://contributors.home-assistant.io/data/reference/statistics/).

## Appliance information tabs

Open an appliance name or **Open details** for its existing information popup.
The name and Configuration Status remain above three tabs:

- **Overview** (default): daily kWh and recorded cost bars for six previous local
  calendar dates plus today so far, Total Energy, Total Cost and Average Power.
  One short footnote points to Debug; (*) marks partial/missing coverage.
  Current-day values update with logical counter states.
- **Configuration**: existing assignments/members and the Edit action.
- **Debug**: Refresh statistics and expandable statistics/coverage explanations,
  including local cutoffs, per-day quality reasons and current-membership scope.
  Existing Cost Calculation Debug, last ten in-memory accounting increments and
  Refresh calculations remain available. API warnings are visible outside the
  expandable details. Details retain their open state during live updates.

Daily cost is a difference of Appliance Meter's recorded Cost Total, never a
recalculation using today's prices or a separate session ledger. Its actual
currency is retained (DKK for DKK accounting). Negative costs are valid. Missing
prices exclude the associated energy from recorded cost and mark coverage partial.
No conversion to DKK is attempted for another accounting currency.

Overview uses the same `recorder/statistics_during_period` hourly long-term
statistics API as Home Assistant's Statistics Graph Card. It requests `sum`,
`state` and `last_reset` for energy, accumulated cost and unpriced energy in one
batch, starting one hour before the first local midnight. **Overview never
requests raw history and has no raw-history fallback.** The separate main
consumption dashboard's existing bounded history reads are unchanged.

Daily values are differences of cumulative **sum** readings at local midnight;
`state` differences and reset markers check continuity. Missing predecessor/end
boundaries expose only an observed interval as partial; gaps, null readings,
resets, decreases in energy counters and state/sum corrections are never filled
with zero. New appliances start at their first known statistical reading, not an
assumed zero. Negative cost deltas remain signed and are marked ambiguous because
an unmarked monetary reset cannot be distinguished from negative-price accounting.
Hourly statistics cannot prove uninterrupted source availability inside each hour;
'complete' means statistical interval coverage, not independently audited uptime.

Today is labelled **Today*** on both charts and always marked partial. Its value
is the midnight-to-latest-compiled-hour sum difference plus only the counter delta
from that hourly **state** to the current live reading. This avoids counting the
compiled hour twice. A missing/restored/incompatible live reading or statistics
older than two hours stops the value at its recorded cutoff. Explicit live resets
and observed live energy decreases invalidate the interval until a fresh snapshot.
Totals sum displayed observed values and disclose omitted days. Average W uses
accounted kWh divided by the actual covered duration, including idle time and
23/25-hour DST dates; differing member intervals make the average unavailable.

Custom Totals resolve nested totals to distinct current Physical members. Shared
leaves and duplicate references count once; cycles, missing or empty groups fail
closed. This does not reconstruct historical membership. Incompatible currencies
make cost unavailable. No counters, IDs, configuration, accounting, entities or
persistent records are created or migrated. Configuration/Edit and Debug/Refresh
calculations retain their existing behavior.

### Bounds, caching and updates

Only seven dates are enabled. Resolution is bounded to 64 distinct Physical
members, 512 graph nodes and 2,048 edges. One batched statistics read plus two
shared metadata reads loads the first selection; another selection normally needs
one statistics read, and cached reopening/tab changes need none. Requests select
only member counters. Each series is limited to 171 hourly records (including the
predecessor and DST allowance), at most 32,832 records at the member limit.
Oversized responses are rejected; failure never triggers a raw-history export.

Connection-scoped in-memory caching lasts 60 seconds for eight completed
selections, with independent in-flight deduplication and at most two concurrent
selection loads. Refresh statistics bypasses the completed cache; failed reads are
retried. No polling or persistent storage is added. Only bounded hourly records
and weakly keyed derived day/series proofs are retained.

Closed member/day intervals are prepared once per immutable query snapshot.
Relevant live counter updates reuse them and adjust only today's tail. Unrelated
HA state updates/recreated state objects do not rebuild charts; the dependency
signature includes resolved member counters, units, reset/restore flags, membership
and an elapsed-minute tick for average W. Hidden tabs defer rendering until shown.
Preparation yields cooperatively and cancels when a popup closes or is superseded.

Tests cover predecessor and local-day boundaries, DST, missing/zero statistics,
partial/new days, negative costs, unpriced intervals, resets/corrections, live
cutoffs, nested membership and cycles, request bounds, cache expiry/concurrency,
hidden tabs, and unrelated updates. Public fixtures are synthetic statistics;
private Recorder references and browser profiles remain outside the repository.

### Compact popup presentation

Overview keeps only three summaries, the two daily charts and one short coverage
footnote. Missing values remain Unavailable / em dashes, never zero. Asterisks
and dashed bars mark partial dates (including today) and data-quality warnings;
full explanations are in Debug. Wide desktop popups place charts side by side;
mobile and narrower screens stack them. All colors follow HA theme variables.
The data/statistics loader, calculations, connection cache and accounting are
unchanged. Only the visible Overview or Debug statistics pane is rendered, using
the same model snapshot; tab changes add no statistics queries.
