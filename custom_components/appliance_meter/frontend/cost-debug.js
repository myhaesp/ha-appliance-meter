/** Diagnostic operands from accounting, never reconstructed from current sensors. */
import { node } from "./flow.js";

// Preserve Decimal strings exactly; pad the mantissa rather than rounding small increments.
const decimal = (value) => {
  const [mantissa, exponent] = String(value).split(/e/i);
  const [whole, fraction = ""] = mantissa.split(".");
  return `${whole},${fraction.padEnd(4, "0")}${exponent === undefined ? "" : `E${exponent}`}`;
};

export function costDebugContent(data, timeZone) {
  const content = node("div");
  if (!data.available) {
    content.append(node("p", "No accountant is active for this appliance. Custom Totals sum their members; open a member to inspect its calculations."));
    return content;
  }
  const currency = data.currency || "DKK";
  const calculations = data.calculations;
  if (!calculations.length) {
    content.append(node("p", "No energy increments recorded since restart or appliance reload. Waiting for the next measured energy change."));
    return content;
  }
  const timestamp = (value) => new Intl.DateTimeFormat("da-DK", {
    timeZone, dateStyle: "short", timeStyle: "medium",
  }).format(new Date(value));
  const price = (value) => value === null ? "Unavailable (unpriced)" : decimal(value);
  const latest = calculations[0], fields = node("dl", undefined, { class: "cost-debug-latest" });
  for (const [label, value] of [
    ["Timestamp", timestamp(latest.timestamp)],
    ["Energy delta (kWh)", decimal(latest.energy_delta)],
    [`Electricity price used (${currency}/kWh)`, price(latest.price)],
    [`Cost increment (${currency})`, decimal(latest.cost_increment)],
    ["Calculation", latest.price === null
      ? `No valid price: energy is unpriced; cost increment is 0,0000 ${currency}.`
      : `${decimal(latest.energy_delta)} kWh × ${decimal(latest.price)} ${currency}/kWh = ${decimal(latest.cost_increment)} ${currency}`],
  ]) fields.append(node("dt", label), node("dd", value));
  content.append(fields);
  const history = node("details"), summary = node("summary", `Last ${calculations.length} calculations (newest first)`);
  const scroll = node("div", undefined, { class: "cost-debug-history" });
  const table = node("table", undefined, { "aria-label": "Cost calculation history" });
  const head = node("thead"), headers = node("tr");
  for (const label of ["Timestamp", "Δ kWh", `Price ${currency}/kWh`, `Δ ${currency}`])
    headers.append(node("th", label, { scope: "col" }));
  head.append(headers);
  const body = node("tbody");
  for (const calculation of calculations) {
    const row = node("tr");
    for (const value of [timestamp(calculation.timestamp), decimal(calculation.energy_delta), price(calculation.price), decimal(calculation.cost_increment)])
      row.append(node("td", value));
    body.append(row);
  }
  table.append(head, body); scroll.append(table); history.append(summary, scroll); content.append(history);
  return content;
}

export class CostDebugView {
  constructor() {
    this.element = node("section", undefined, { class: "cost-debug", "aria-label": "Cost Calculation Debug" });
    this.body = node("div", "Loading calculations…");
    const refresh = node("button", "Refresh calculations", { type: "button" });
    refresh.addEventListener("click", () => void this.refresh());
    this.element.append(node("h3", "Cost Calculation Debug"),
      node("p", "Actual accounting inputs. Last 10 energy increments kept in memory; cleared on restart or appliance reload. Price changes appear when an energy increment uses them.", { class: "notes" }),
      this.body, refresh);
  }
  update(hass, entry) {
    const state = hass.states[entry.sensors.energy_total];
    const changed = this.hass?.connection !== hass.connection || this.state !== state || !this.entry;
    this.hass = hass; this.entry = entry; this.state = state;
    if (changed) void this.refresh();
  }
  async refresh() {
    if (this.closed || !this.hass?.user?.is_admin) return;
    if (this.loading) { this.pending = true; return; }
    this.loading = true;
    const hass = this.hass;
    try {
      const data = this.entry.type === "aggregate" ? { available: false } : await hass.callWS({
        type: "appliance_meter/cost_debug", entry_id: this.entry.entry_id,
      });
      if (!this.closed && this.hass.connection === hass.connection && this.hass.user?.is_admin) {
        const expanded = this.body.querySelector("details")?.open;
        this.body.replaceChildren(costDebugContent(data, hass.config?.time_zone || "UTC"));
        if (expanded && this.body.querySelector("details")) this.body.querySelector("details").open = true;
      }
    } catch {
      if (!this.closed) this.body.replaceChildren(node("p", "Calculations could not be loaded. Use Refresh calculations to retry.", { role: "alert" }));
    } finally {
      this.loading = false;
      if (this.pending) { this.pending = false; void this.refresh(); }
    }
  }
  close() { this.closed = true; }
}
