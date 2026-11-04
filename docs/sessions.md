# Session observation

Available in v0.2.1. Existing entries
remain off unless an administrator explicitly selects Shadow observation and a
profile. This feature observes sources; it never writes an appliance control,
YAML helper, legacy energy/cost total, Recorder statistic or InfluxDB point.

The existing `accounting.py` and its storage format/keys are unchanged. Its four
logical sensors retain their exact unique IDs and device/entry associations.
Their ordinary source-driven accounting continues, including standby and motor
retraction. Historical interval pricing below is **session accounting**; it does
not change how the established Cost Total prices an incoming physical delta.

## Configuration and visibility

In an existing physical appliance's **Edit / Configure** form:

- **Session observation**: Off (default), or Shadow observation.
- **Session detection profile**: Washing machine, Tumble dryer, or Dishwasher.
- Keep the existing Power, Energy and Price assignments. A Power source and
  explicit profile are required for shadow mode. Energy and Price remain optional;
  missing Energy enables labelled power integration, missing prices stay unpriced.
- No profile is inferred from an appliance name, manufacturer or phase label.
  Aggregates do not run detectors. The six legacy learning automations can remain
  as they are during shadow mode: the new observer never competes for helpers.

Shadow mode adds exactly **one diagnostic sensor per opted-in physical entry**:
`Session observation`, unique ID `<entry_id>_session_observation`. HA chooses the
entity ID on first registration, ordinarily
`sensor.<existing_appliance_name>_session_observation`; entity renames are respected.
It belongs to the existing logical device. There is no device class, state class,
energy/monetary total or long-term statistics source on this diagnostic sensor.
No additional entities are created while off, and none of the original IDs change.
Disabling shadow mode leaves its registered diagnostic entity unavailable; it
does not delete its identity or history.

The diagnostic state is `idle`, `running`, `low_load_hold`, `aftercare`,
`measurement_gap`, `finish_candidate`, `completed`, `candidate_completed`, or
`storage_error`. Bounded attributes identify the profile, shadow origin, current
or latest session, start/end and confirmation timestamps, main/aftercare boundary,
last activity, last electrical activity, kWh, cost/known cost/unpriced kWh,
measurement quality and auxiliary event count. Active sessions do not publish
final kWh/cost until the end measurement window has settled.

History is available through the administrator-only, read-only WebSocket command
`appliance_meter/sessions`:

```json
{
  "id": 1,
  "type": "appliance_meter/sessions",
  "entry_id": "<existing-config-entry-id>",
  "offset": 0,
  "limit": 50
}
```

`limit` is 1–100. The response has mode, profile, currency, active observation,
total number of archived observations, and newest-first `sessions`. Page with
`offset`. The endpoint also reads the saved ledger while observation is off,
without starting detection or modifying storage. The existing management/list
page and its period totals are unchanged; no session-history dashboard has been
added. The native diagnostic sensor and this API are the review surfaces.

## Persisted records and isolation

A separate atomic Home Assistant Store,
`.storage/appliance_meter.sessions.<entry_id>`, contains a versioned engine,
source/currency context, the current observation, sample/price buffers and archived
session records. It never replaces `.storage/appliance_meter.<entry_id>`.

Each archived session has its own ID, algorithm version, profile, origin,
currency, source identities, start and confirmed-start time, end and confirmed-end
time, main-program end, aftercare start, last activity, duration, main duration,
aftercare duration, full kWh or null, known kWh, main/aftercare known kWh, known cost, full cost or null,
unpriced kWh, before/after counter samples, compact price allocations, phase
transitions and quality flags. A completed dishwasher observation has
`status: candidate_completed` and `finish_evidence.confidence:
unverified_candidate`, never a firmware-confirmed completion.

Timestamps are UTC Unix seconds; elapsed duration never uses wall-clock subtraction
or a fixed UTC offset. Display them in HA's configured timezone. Monetary and
energy fields are Decimal strings; no extra VAT, tax or tariff is added.
Currency is copied from the existing accountant and retained **on each record**,
so old records cannot be relabelled after a source/currency configuration change.

Writes are batched within 30 seconds and explicitly flushed at startup,
unload/reload and HA shutdown. An abrupt crash can lose that pending observation
window. Restart marks a gap, resets pending completion evidence and retains the
existing session ID; it does not count unseen elapsed time as confirmed standby.
A lost onset may only be recovered as an uncertain start, never a reconstructed
certain one. Source/profile/price/currency context changes archive the open
observation as interrupted, with no invented end or complete session energy.
Existing records remain intact.

Off mode creates no observer/listeners/timer/session store. Switching to off
flushes and preserves existing observations; re-enabling resumes with an
observation gap. Removing an appliance permanently removes its own accounting
and session stores after callbacks are cancelled. This is deletion, not rollback;
the existing confirmation now mentions session history.

An unreadable/future-version session store disables the observer, reports
`storage_error`, and leaves the store and all four established accounting sensors
alone. A failed initial load must never be replaced by an empty session history.

Archived observations are retained; no automatic historical import or pruning
of records is performed. Active power/counter buffers have a 100,000 point cap;
truncation adds `sample_limit`, prevents a complete energy/cost claim, and retains
the original anchor. Compact allocations are grouped by price quarter, phase,
price and provenance instead of retaining every power sample after completion.
Price slots are retained for 14 days or the active observation, whichever needs
an earlier start. Monitor unusually long open observations/store growth rather
than using a time limit to fabricate program completion.

## Individual models and confidence

Common prerequisites: finite, compatible source data; W/kW and Wh/kWh are
normalized once. HA restored states are rejected. Both changed and unchanged
source reports are observed. A five-second timer tests source freshness against
`last_reported` (90 seconds); absence of *state changes* alone is not an outage.
The observer never substitutes unknown power with zero. A finite source recovered
after a gap can resume the open observation; the gap remains in quality metadata.

The following initial thresholds are reference-calibrated hypotheses, not
universal appliance firmware behavior:

| Profile | Start confirmation and buffered onset | Intermediate behavior | Completion observation |
|---|---|---|---|
| Washing machine | At least 30 s above 5 W in a 120 s window, with a peak at least 50 W. Keep the first qualifying activity as onset and the earlier counter baseline. | Motor pauses do not require one continuous minute above 20 W. Different wash programs remain separate records; no guessed temperature/program label. | Ten minutes of observed standby at or below 5 W confirm the preceding activity boundary. Confidence remains inferred, especially with missing onset or a gap. |
| Tumble dryer | At least 60 s above 200 W within 90 s. A 180 s buffer retains its contiguous weaker startup (no quiet gap over 30 s). Short later pulses cannot satisfy this. | A sustained main-load block is followed by a five-minute mean below 50 W and at least 120 s since its end. Record the main-load end retrospectively and enter aftercare. About 10-second pulses every 4:12 stay inside the same session. | Ten minutes of observed standby at or below 5 W confirm the last activity. Main end, aftercare and final activity are separate; they do not prove the machine's internal ready signal. |
| Dishwasher | At least 30 s above 5 W in a 300 s window with peak at least 50 W. This accommodates the weak initial pumps while preventing an isolated 34 W door motor or 9 W retraction from starting a program. | `running ↔ low_load_hold`: five minutes below 100 W can enter low-load hold; later higher load returns to running. No low-load duration ends the program. | Prior heating plus a 90–180 s quiet gap, a 35–65 s block with peak 25–45 W and subsequent standby creates a door-opening **candidate**. Gaps of up to 3.1 s inside that block are joined. Settle the end/counter window for 90 s, then archive as `candidate_completed`. |

Dishwasher progression is `idle → start candidate → running ↔ low_load_hold →
finish_candidate → candidate_completed`, with `measurement_gap` outside normal
phase inference. The candidate keeps a proposed end at the motor's final fall,
not the time at which settlement/confirmation finishes. New activity before
confirmation retracts the candidate. No program-end event, helper update or
appliance action is emitted. Without the signature the observation stays open;
there is no fallback claiming a certain end after 10–15 minutes of low power.

After a completed dishwasher candidate, weak 5–20 W episodes are stored as
separate `auxiliary_events` with unverified classification, integrated power
energy, historical known cost and unpriced coverage. The program's fixed end,
duration, main kWh and cost do not move. A later genuinely confirmed start can
reclassify its initial weak activity into the new program. There is no blind
rearm lockout that prevents another genuine program, and the old program's power
samples are excluded from new-start detection. `last_electrical_activity` is a
separate observation of activity above the 5 W threshold, not program end.

These detection thresholds are implementation hypotheses, not universal program
signals. Public synthetic replays exercise their rules, but do not establish
accuracy on real household programs. Independent prospective validation remains
necessary before any future reliance on completion boundaries. No legacy learning
helpers or scheduling estimates are updated by the observer.

## Measured energy, interval prices and incomplete results

A selected cumulative sensor is primary. The observer buffers its baseline before
start confirmation and uses the latest numeric pre-onset reading and settled
post-end reading. `counter_before`, `counter_after` and
`counter_boundary_window` disclose that measured kWh covers the enclosing counter
window, rather than claiming sub-minute energy accuracy. Aftercare allocations
use measured power to divide a straddling counter interval between phases.
A restart or brief missing counter state retains a valid baseline. A decrease
starts another known segment, marks `counter_reset` and makes the session partial;
energy hidden around the reset is not invented. `known_kwh` retains the measured
partial subtotal and `kwh` is null when energy coverage is incomplete. A missing boundary likewise
prevents a complete cost claim.

Without an Energy assignment, positive active power is integrated over elapsed
seconds. Unknown spans stay unknown, with `power_integration`/`energy_gap` quality
and a partial `known_kwh` result (`kwh` null). Negative power/standby offsets are not imported as negative
consumption and no arbitrary calibration offset is added to a physical counter.

The observer persists the selected price sensor's explicit `prices` rows
(`start`, `end`, `price`) as actual intervals. Starts/ends must be timezone-aware datetimes or ISO strings;
price units must match the fixed accounting currency (DKK also accepts kr/kWh).
Restored price states and explicitly forecast rows/feeds are rejected. A selected
sensor's unflagged interval rows must represent actual prices; there is no
provider-name heuristic validating an arbitrary forecast feed.

At energy settlement, positive measured counter deltas are distributed over the
recorded power profile and historical price boundaries. Unknown power timing uses
an explicitly flagged time-proportional estimate. Scalar-only price observations
are valid only from their observed time until the end of that UTC quarter;
startup's price is never extrapolated backwards over downtime. If interval rows
are unavailable and a scalar remains unchanged into another quarter, coverage
is conservatively missing unless it is observed again; scalar observations are
a fallback, not a historical price service. Proper published interval rows are
recommended (as available on the selected Strømligning Current sensor).

Negative prices are retained. Missing/conflicting prices or unknown energy timing
remain unpriced. `known_cost` is the subtotal; `cost` is null while any kWh is
unpriced or energy coverage is incomplete. Neither null nor missing price means
free consumption. `energy_complete` concerns observed energy coverage, not
certainty about the appliance's internal program boundaries; always inspect
quality and finish confidence too. Closed records are not silently repriced from
later quotes. No new tax/tariff/VAT component is added to an already inclusive
rate, and fixed subscriptions are not allocated by this feature.

## Public validation

The public suite uses constructed step functions and synthetic counter/price
values. No Recorder excerpts, installation snapshots or private reference results
are included. See [development and tests](development.md) and
[activation/rollback](activation-rollback.md). Synthetic success does not prove
real-program accuracy. Historical reconstruction is an engine origin label,
not evidence that public fixtures came from measured observations.
