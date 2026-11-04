# Accounting, currency and continuity

Each physical appliance has four stable logical sensors: Power, Energy Total,
Cost Total and Unpriced Energy. Their unique IDs use the existing config-entry ID.
Power is normalized from supported W/kW units; cumulative energy is normalized
from Wh/kWh. Custom Totals derive sums from their current distinct physical members;
they do not replace individual accounting stores.

The first valid cumulative reading establishes a baseline. Positive differences
increase Energy Total; repeated reports do nothing. A counter decrease establishes
a fresh baseline. Missing, restored, negative, nonfinite and unsupported-unit values
preserve the last valid baseline. Ordinary recovery can include the consumption
since that baseline.

For each incoming delta, the current valid price is applied in the store's fixed
currency. New stores use HA's configured currency; older stores without one retain
DKK. Units must match <currency>/kWh; kr/kWh is accepted for DKK. Negative prices are
valid. A missing or invalid price adds to Unpriced Energy without changing Cost
Total. Old unpriced consumption is not repriced later. After downtime the recovered
delta uses the price then available, not reconstructed historical tariffs.

Changing the configured energy source preserves logical totals, IDs and currency
but invalidates the old physical baseline. The first valid new reading establishes
the new one; its entire lifetime value is never imported. Clearing a source leaves
known accounting totals available. A concealed hardware replacement behind the same
entity ID is not an identifiable source change and must be reviewed separately.

Accounting uses an atomic Home Assistant Store per config entry. Writes are batched
within 30 seconds with startup/unload/shutdown flushes. An abrupt failure may lose
the pending interval; a subsequent reading recovers energy from the saved baseline,
using the then-current price. Runtime/source health and held historical totals
must not be confused.

Session pricing in the development branch is a separate ledger with explicit
historical intervals and quality flags. It does not rewrite lifetime accounting,
helpers, Recorder statistics or prior prices. See [sessions](sessions.md).
