import { node } from "./flow.js";
import { formatValue } from "./period-presentation.js";
import { loadOverviewData, overviewDays, overviewModel, overviewMembers, prepareOverviewData } from "./overview-data.js";
const NS = "http://www.w3.org/2000/svg";
const svgNode = (tag, attributes, text) => {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes || {})) element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
};
const incomplete = (metric, warning = false) => warning || metric.status !== "complete";
const labelValue = (metric, unit, warning = false) =>
  `${metric.value === null ? "Unavailable" : `${formatValue(metric.value)} ${unit}`}${incomplete(metric, warning) ? " *" : ""}`;

export function dailyChart(days, key, unit, timeZone, warning = false) {
  const figure = node("figure", undefined, { class: "daily-chart" });
  const title = key === "energy" ? "Daily energy" : "Daily cost";
  figure.append(node("figcaption", `${title} (${unit})`));
  const chart = svgNode("svg", { viewBox: "0 0 560 230", role: "img", "aria-label": `${title}, last ${days.length} days in ${timeZone}` });
  const available = days.map(d => d[key].value).filter(v => v !== null);
  const low = Math.min(0, ...available), high = Math.max(0, ...available);
  const span = high - low || 1;
  const y = value => 185 - (value - low) / span * 155;
  for (let i = 0; i <= 4; i++) {
    const value = low + span * i / 4, position = y(value);
    chart.append(svgNode("line", { x1: 62, x2: 550, y1: position, y2: position, class: "chart-grid" }));
    chart.append(svgNode("text", { x: 57, y: position + 4, "text-anchor": "end" }, formatValue(value)));
  }
  chart.append(svgNode("line", { x1: 62, x2: 550, y1: y(0), y2: y(0), class: "chart-zero" }));
  const date = new Intl.DateTimeFormat("da-DK", { timeZone, day: "2-digit", month: "2-digit" });
  const table = node("table", undefined, { class: "sr-only", "aria-label": `${title} data` });
  const header = node("tr");
  for (const label of ["Date", unit, "Coverage"]) header.append(node("th", label, { scope: "col" }));
  const head = node("thead"); head.append(header); table.append(head);
  const body = node("tbody");
  days.forEach((day, index) => {
    const metric = day[key], x = 62 + (index + .5) * 488 / days.length;
    const partial = incomplete(metric, warning) || day.today;
    const label = date.format(day.start), coverage = `${day.today ? "Today so far. " : ""}${warning ? "Coverage warning. " : ""}${metric.status}. See Debug for details.`;
    const description = `${label}: ${labelValue(metric, unit, warning)}. ${coverage}`;
    if (metric.value === null) chart.append(svgNode("text", { x, y: y(0) - 7, "text-anchor": "middle" }, "—"));
    else {
      const top = Math.min(y(0), y(metric.value));
      const bar = svgNode("rect", { x: x - 18, y: top, width: 36,
        height: Math.max(2, Math.abs(y(metric.value) - y(0))), class: `chart-bar ${partial ? "chart-partial" : ""}` });
      bar.append(svgNode("title", {}, description)); chart.append(bar);
    }
    chart.append(svgNode("text", { x, y: 210, "text-anchor": "middle" }, day.today ? "Today*" : `${label}${partial ? "*" : ""}`));
    const row = node("tr"); row.append(node("th", label, { scope: "row" }), node("td", labelValue(metric, unit, warning)), node("td", coverage)); body.append(row);
  });
  table.append(body); figure.append(chart, table);
  return figure;
}

export function overviewContent(model, timeZone) {
  const content = node("div"), warning = model.warnings.length > 0;
  const summary = node("dl", undefined, { class: "overview-totals" });
  for (const [name, metric, unit] of [
    ["Total Energy", model.energy, "kWh"], ["Total Cost", model.cost, model.currency || "currency unavailable"],
    ["Average Power", model.average, "W"],
  ]) {
    const group = node("div");
    group.append(node("dt", name), node("dd", labelValue(metric, unit, warning), {
      title: `${warning ? "Coverage warning. " : ""}${metric.status}. See Debug for details.`,
    }));
    summary.append(group);
  }
  const charts = node("div", undefined, { class: "overview-charts" });
  charts.append(dailyChart(model.days, "energy", "kWh", timeZone, warning),
    dailyChart(model.days, "cost", model.currency || "currency unavailable", timeZone, warning));
  content.append(summary, charts, node("p", "(*) Partial coverage. See Debug for details.", { class: "notes overview-footnote" }));
  return content;
}

/** Explanations and unchanged model quality flags belong to Debug, not Overview. */
export function overviewDebugContent(model, timeZone) {
  const content = node("div");
  for (const warning of model.warnings)
    content.append(node("p", warning, { class: "error", role: "alert" }));
  const details = node("details", undefined, { class: "statistics-details" });
  const limited = model.warnings.length || [model.energy, model.cost, model.average].some(m => m.status !== "complete");
  details.append(node("summary", `${limited ? "Partial or unavailable coverage — " : ""}Statistics and coverage details`));
  const text = [
    "Source: Home Assistant Recorder hourly long-term statistics for Appliance Meter energy, accumulated cost and unpriced-energy counters. Daily values are differences of cumulative sums; counter states and reset markers check continuity. Cost uses recorded accounting, never today's price or repricing.",
    `Last ${model.days.length} local calendar dates in ${timeZone}, including today so far. Local midnight boundaries use the actual 23/25-hour DST day. Today's compiled statistics are extended only by the live counter delta since the last compiled state, without counting that hour twice.`,
    "Missing history, baselines, hours or endpoints are not zero. Partial totals include only observed values. Missing or incompatible sensors, resets and corrections limit coverage. Average W is recorded kWh divided by covered elapsed time, including idle time; differing member intervals make it unavailable.",
    "Negative electricity prices can produce negative recorded costs, which remain signed. An unmarked cost-counter reset cannot be distinguished from negative-price accounting. Unpriced consumption is excluded from cost and marked partial, not treated as free energy.",
    "Hourly statistics cannot prove uninterrupted source availability inside each hour. Complete coverage means a known statistical interval, not independently audited source uptime.",
  ];
  if (model.aggregate) text.push("Custom Total: sum of distinct current Physical members' statistics, including nested totals. Duplicate members count once. Past group membership is not reconstructed; missing members are not assumed zero.");
  for (const paragraph of text) details.append(node("p", paragraph, { class: "notes" }));
  const clock = new Intl.DateTimeFormat("da-DK", { timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const cutoff = metric => Number.isFinite(metric?.end) ? clock.format(metric.end) : "unavailable or differing member cutoffs";
  const today = model.days.find(d => d.today);
  if (today) details.append(node("p", `Today: energy accounted through ${cutoff(today.energy)}; cost accounted through ${cutoff(today.cost)} (${timeZone}).`, { class: "notes" }));
  const quality = node("dl", undefined, { class: "overview-quality" });
  for (const [name, metric] of [["Total Energy", model.energy], ["Total Cost", model.cost], ["Average Power", model.average]])
    quality.append(node("dt", name), node("dd", `${metric.status}. ${metric.reason}`));
  details.append(quality);
  const table = node("table", undefined, { class: "overview-coverage-table" });
  table.append(node("caption", "Daily coverage"));
  const header = node("tr");
  for (const name of ["Date", "Energy", "Cost"]) header.append(node("th", name, { scope: "col" }));
  const head = node("thead"); head.append(header); table.append(head);
  const body = node("tbody"), date = new Intl.DateTimeFormat("da-DK", { timeZone, day: "2-digit", month: "2-digit" });
  for (const day of model.days) {
    const row = node("tr"); row.append(node("th", `${date.format(day.start)}${day.today ? " (today so far)" : ""}`, { scope: "row" }));
    for (const metric of [day.energy, day.cost]) row.append(node("td", `${metric.status}. ${metric.reason}`));
    body.append(row);
  }
  table.append(body); details.append(table); content.append(details);
  return content;
}

export class OverviewView {
  constructor() {
    this.element = node("section", undefined, { class: "overview", "aria-label": "7-day overview" });
    this.body = node("div", "Loading 7-day statistics…", { "aria-live": "polite" });
    this.refreshButton = node("button", "Refresh statistics", { type: "button" });
    this.refreshButton.addEventListener("click", () => void this.refresh());
    this.element.append(this.body);
    this.debugElement = node("section", undefined, { class: "overview-debug", "aria-label": "Statistics and coverage" });
    this.debugBody = node("div", "Loading statistics details…");
    this.debugElement.append(node("h3", "Statistics & coverage"), this.refreshButton, this.debugBody);
    this.generation = 0;
  }
  update(hass, metadata, entry) {
    const zone = hass.config?.time_zone || "UTC";
    const signature = JSON.stringify([zone, overviewDays(Date.now(), zone)[0].start,
      entry.entry_id, entry.members, metadata.entries.map(e => [e.entry_id, e.type, e.members, e.sensors])]);
    const changed = signature !== this.signature || this.hass?.connection !== hass.connection;
    this.hass = hass; this.metadata = metadata; this.entry = entry; this.signature = signature;
    if (changed) void this.refresh(false);
    else if (this.data) this.render();
  }
  render() {
    if (this.closed || !this.hass.user?.is_admin) return;
    if (!this.data) return;
    const overviewVisible = !this.element.closest("[hidden]");
    const debugVisible = this.debugElement.isConnected && !this.debugElement.closest("[hidden]");
    if (!overviewVisible && !debugVisible) return;
    const zone = this.hass.config?.time_zone || "UTC";
    const members = overviewMembers(this.metadata, this.entry);
    const signature = JSON.stringify([zone, Math.floor(Date.now() / 60000), this.entry.type,
      members.map(entry => [entry.entry_id, ...["energy_total", "cost_total", "unpriced_energy"].map(key => {
        const id = entry.sensors?.[key], state = this.hass.states[id];
        return [id, state?.state, state?.attributes?.unit_of_measurement,
          state?.attributes?.restored, state?.attributes?.last_reset];
      })])]);
    if (this.renderedData !== this.data || this.renderSignature !== signature) {
      this.model = overviewModel(this.metadata, this.entry, this.data, this.hass.states, Date.now(), zone);
      this.renderedData = this.data; this.renderSignature = signature;
      this.overviewDirty = this.debugDirty = true;
    }
    if (overviewVisible && this.overviewDirty) {
      this.body.replaceChildren(overviewContent(this.model, zone)); this.overviewDirty = false;
    }
    if (debugVisible && this.debugDirty) {
      const expanded = this.debugBody.querySelector("details")?.open;
      this.debugBody.replaceChildren(overviewDebugContent(this.model, zone));
      if (expanded) this.debugBody.querySelector("details").open = true;
      this.debugDirty = false;
    }
  }

  async refresh(force = true) {
    if (this.closed || !this.hass?.user?.is_admin) return;
    const generation = ++this.generation;
    this.data = null; this.renderedData = null; this.model = null; this.renderSignature = null;
    this.refreshButton.disabled = true;
    this.body.replaceChildren(node("p", "Loading 7-day statistics…"));
    this.debugBody.replaceChildren(node("p", "Loading statistics details…"));
    try {
      const data = await loadOverviewData(this.hass, this.metadata, this.entry, Date.now(), 7, force);
      if (this.closed || generation !== this.generation || !this.hass.user?.is_admin) return;
      const current = () => !this.closed && generation === this.generation && Boolean(this.hass.user?.is_admin);
      if (!await prepareOverviewData(this.metadata, this.entry, data, this.hass.states,
        Date.now(), this.hass.config?.time_zone || "UTC", current)) return;
      this.data = data; this.render();
    } catch {
      if (!this.closed && generation === this.generation) {
        this.body.replaceChildren(node("p", "Statistics unavailable*. See Debug.", { role: "alert" }));
        this.debugBody.replaceChildren(node("p", "Statistics could not be loaded. Use Refresh statistics to retry.", { role: "alert" }));
      }
    } finally {
      if (!this.closed && generation === this.generation) this.refreshButton.disabled = false;
    }
  }
  close() { this.closed = true; this.generation++; this.data = null; this.renderedData = null; this.model = null; }
}
