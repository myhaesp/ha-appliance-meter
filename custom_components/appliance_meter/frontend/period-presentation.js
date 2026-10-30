/** One period presentation shared by list cells and cards. Accounting stays in HA. */
import { node } from "./flow.js";

export const METRIC_COLUMNS = [
  ["energyDay", "kWh Day"],
  ["energy", "kWh month"],
  ["costDay", "Cost Day"],
  ["month", "Cost month"],
  ["year", "Cost year"],
];
const labels = Object.fromEntries(METRIC_COLUMNS);

const numberFormat = new Intl.NumberFormat("da-DK", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
export const formatValue = (value) =>
  numberFormat.format(Math.abs(value) < 0.005 ? 0 : value);

export function metricButton(metric, key, entry, timeZone, explain) {
  const button = node("button", undefined, {
    type: "button", class: "metric", "data-metric": `${entry.entry_id}:${key}`,
  });
  updateMetricButton(button, metric, key, entry, timeZone);
  button.addEventListener("focus", () => explain(entry.name, button.title));
  button.addEventListener("click", () => explain(entry.name, button.title));
  return button;
}

export function updateMetricButton(button, metric, key, entry, timeZone) {
  const signature = JSON.stringify([metric, timeZone, entry.currency]);
  if (button._metricSignature === signature) return;
  button._metricSignature = signature;
  const date = metric.since
    ? new Intl.DateTimeFormat("da-DK", {
        timeZone,
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(metric.since)
    : null;
  const valueLabel = metric.value === null ? metric.status : formatValue(metric.value) +
    (["costDay", "month", "year"].includes(key) && entry.currency ? ` ${entry.currency}` : "");
  const details = metric.reason + (date ? ` Observed from ${date}.` : "");
  button.dataset.status = metric.status;
  button.title = details;
  button.setAttribute("aria-label", `${entry.name}, ${labels[key]}: ${valueLabel}. ${metric.status === "partial" ? "Partial. " : ""}${details}`);
  button.replaceChildren();
  if (metric.value !== null) {
    button.append(
      node("span", valueLabel, { class: "metric-value" }),
    );
    if (metric.status === "partial")
      button.append(
        node("span", "*", { class: "partial", "aria-hidden": "true" }),
      );
  } else
    button.append(
      node(
        "span",
        {
          insufficient: "No baseline",
          discontinuity: "Discontinuity",
          unavailable: "Unavailable",
          loading: "…",
        }[metric.status] || "Unavailable",
        { class: "missing" },
      ),
    );
}
