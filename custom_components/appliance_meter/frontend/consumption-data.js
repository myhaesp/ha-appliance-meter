/** Read-only projections of HA Recorder data. No counters or accounting state. */
const HOUR = 3600000;
const UNITS = {
  energy_total: "kWh",
  cost_total: "DKK",
  unpriced_energy: "kWh",
};
const energyNoteFormat = new Intl.NumberFormat("da-DK", {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});
export const numeric = (value) => {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (
    typeof value === "string" &&
    !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())
  )
    return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const epsilon = (a, b) =>
  Math.max(1e-9, Number.EPSILON * 64 * Math.max(1, Math.abs(a), Math.abs(b)));
const finiteTime = (value) => Number.isFinite(value) && value > 0;

function localParts(time, timeZone) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(time)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
}

export function localMidnight(year, month, day, timeZone) {
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  for (let i = 0; i < 5; i++) {
    const p = localParts(guess, timeZone);
    const difference =
      target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    if (!difference) return guess;
    guess += difference;
  }
  throw new Error(
    "The Home Assistant timezone has an ambiguous calendar boundary.",
  );
}

export function calendarPeriods(now, timeZone) {
  const p = localParts(now, timeZone);
  return {
    year: localMidnight(p.year, 1, 1, timeZone),
    month: localMidnight(p.year, p.month, 1, timeZone),
    day: localMidnight(p.year, p.month, p.day, timeZone),
    // This is the previous LOCAL calendar day, not a rolling 24-hour period.
    previousYearDay: localMidnight(p.year - 1, 12, 31, timeZone),
    timeZone,
  };
}

const rawPoint = (row) => ({
  time: Number(row.lu) * 1000,
  value: numeric(row.s),
  attributes: row.a || {},
  source: "history",
});
const statPoint = (row) => ({
  time: Number(row.end),
  value: numeric(row.state),
  sum: numeric(row.sum),
  lastReset: row.last_reset,
  source: "statistics",
});
const validRaw = (point, unit) =>
  point.value !== null &&
  finiteTime(point.time) &&
  point.attributes.unit_of_measurement === unit &&
  !point.attributes.restored;
const result = (status, reason, value = null, since = null) => ({
  status,
  reason,
  value,
  since,
});

/** All values are differences of real cumulative readings, never current price. */
export function periodMetric(entry, key, start, data, states, now) {
  const id = entry.sensors[key],
    current = states[id],
    unit = key === "cost_total" ? current?.attributes?.unit_of_measurement : UNITS[key];
  const value = numeric(current?.state);
  if (
    !id ||
    !unit ||
    value === null ||
    current.attributes?.restored ||
    current.attributes?.unit_of_measurement !== unit
  )
    return result(
      "unavailable",
      "Current cumulative reading is unavailable or has incompatible units.",
    );
  if (key !== "cost_total" && value < 0)
    return result(
      "discontinuity",
      "A consumption counter has a negative reading.",
    );
  const created = data.created?.[entry.entry_id];
  if (!finiteTime(created))
    return result(
      "insufficient",
      "Appliance creation metadata is unavailable; historical identity cannot be established.",
    );
  const firstAllowed = Math.max(start, created);
  const metadata = data.statisticsMetadata[id];
  const statisticsOK =
    metadata?.has_sum && metadata.statistics_unit_of_measurement === unit;
  const statistics = statisticsOK
    ? [...(data.daily[id] || []), ...(data.hourly[id] || [])]
        .map(statPoint)
        .filter((p) => finiteTime(p.time) && p.time <= now && p.value !== null)
    : [];
  const boundary = (data.boundaries[start]?.[id] || []).map(rawPoint);
  const exact = boundary.find((p) => p.time === start);
  const initial = (data.initial[id] || []).map(rawPoint);
  const tail = (data.tail[id] || []).map(rawPoint);
  const raw = [
    ...boundary,
    ...initial,
    ...tail,
    ...(data.live?.[id] || []).map(rawPoint),
  ];
  // Explicitly unavailable history at the boundary vetoes a statistics fallback.
  let baseline = null;
  if (created <= start) {
    baseline = exact
      ? validRaw(exact, unit)
        ? exact
        : null
      : statistics.find((p) => p.time === start);
  }
  const full = Boolean(baseline);
  if (!baseline)
    baseline = [...statistics, ...raw.filter((p) => validRaw(p, unit))]
      .filter(
        (p) =>
          p.time >= firstAllowed &&
          p.time <= now &&
          (!exact || validRaw(exact, unit) || p.time > start),
      )
      .sort((a, b) => a.time - b.time)[0];
  if (!baseline)
    return result(
      "insufficient",
      "No recorded baseline is available for this period.",
    );
  if (
    raw.some(
      (p) =>
        p.time >= baseline.time &&
        p.time <= now &&
        p.value !== null &&
        p.attributes.unit_of_measurement !== unit,
    )
  )
    return result(
      "discontinuity",
      "Recorded units changed or became incompatible during this period.",
    );
  const points = [
    ...statistics,
    ...raw.filter((p) => validRaw(p, unit)),
    { time: now, value, source: "live", attributes: current.attributes },
  ]
    .filter((p) => p.time >= baseline.time && p.time <= now)
    .sort(
      (a, b) =>
        a.time - b.time ||
        { statistics: 0, history: 1, live: 2 }[a.source] -
          { statistics: 0, history: 1, live: 2 }[b.source],
    );
  if (baseline.time >= now)
    return result(
      "insufficient",
      "There is not yet a historical interval to compare.",
    );
  let previous = baseline;
  let offset = null;
  for (const point of points) {
    if (
      key !== "cost_total" &&
      point.value < previous.value - epsilon(point.value, previous.value)
    )
      return result(
        "discontinuity",
        "The recorded cumulative counter decreased. This period cannot be reconstructed safely.",
      );
    const reset = point.lastReset || point.attributes?.last_reset;
    const resetTime =
      typeof reset === "number"
        ? reset < 1e12
          ? reset * 1000
          : reset
        : Date.parse(reset);
    if (reset && (!Number.isFinite(resetTime) || resetTime > baseline.time))
      return result(
        "discontinuity",
        "A recorded counter reset makes this period discontinuous.",
      );
    if (point.source === "statistics" && point.sum !== null) {
      const nextOffset = point.sum - point.value;
      if (
        offset !== null &&
        Math.abs(nextOffset - offset) >
          epsilon(nextOffset, offset) + epsilon(point.sum, point.value)
      )
        return result(
          "discontinuity",
          "Recorder reports a reset or statistics correction in this period.",
        );
      offset = nextOffset;
    }
    previous = point;
  }
  // Negative recorded costs are valid: the existing accountant supports negative prices.
  const difference = value - baseline.value;
  return result(
    full ? "complete" : "partial",
    full
      ? `Since the calendar boundary (${baseline.source}).`
      : "No beginning-of-period baseline. Only the observed interval is shown.",
    Math.abs(difference) < 1e-10 ? 0 : difference,
    baseline.time,
  );
}

function costCoverage(cost, energy, unpriced) {
  if (cost.value === null) return cost;
  if (energy.status === "discontinuity")
    return result("discontinuity", energy.reason);
  if (unpriced.value === null)
    return {
      ...cost,
      status: "partial",
      reason: `${cost.reason} Unpriced-energy coverage is unknown.`,
    };
  if (unpriced.value > 1e-8)
    return {
      ...cost,
      status: "partial",
      reason: `${cost.reason} Recorded cost excludes ${unpriced.value < 0.001 ? "<0,001" : energyNoteFormat.format(unpriced.value)} kWh without a known price.`,
    };
  if (unpriced.status !== "complete" && cost.status === "complete")
    return {
      ...cost,
      status: "partial",
      reason: "Unpriced-energy history does not cover the full period.",
    };
  return cost;
}

export function consumptionRows(metadata, data, states, now = Date.now()) {
  const byId = new Map(
    metadata.entries.map((entry) => [entry.entry_id, entry]),
  );
  const values = new Map();
  const { day, month, year } = data.periods;
  for (const entry of metadata.entries.filter((e) => e.type === "physical")) {
    const metric = (key, start) =>
      periodMetric(entry, key, start, data, states, now);
    const energyDay = metric("energy_total", day),
      energyMonth = metric("energy_total", month),
      energyYear = metric("energy_total", year);
    values.set(entry.entry_id, {
      energyDay,
      energy: energyMonth,
      costDay: costCoverage(
        metric("cost_total", day),
        energyDay,
        metric("unpriced_energy", day),
      ),
      month: costCoverage(
        metric("cost_total", month),
        energyMonth,
        metric("unpriced_energy", month),
      ),
      year: costCoverage(
        metric("cost_total", year),
        energyYear,
        metric("unpriced_energy", year),
      ),
    });
  }
  for (const entry of metadata.entries.filter((e) => e.type === "aggregate")) {
    const members = entry.members.map((m) => m.entry_id);
    const valid =
      members.length &&
      new Set(members).size === members.length &&
      members.every(
        (id) => byId.get(id)?.type === "physical" && values.has(id),
      );
    const total = {};
    for (const key of ["energyDay", "energy", "costDay", "month", "year"]) {
      const parts = valid ? members.map((id) => values.get(id)[key]) : [];
      const currencies = new Set(members.map((id) =>
        states[byId.get(id)?.sensors.cost_total]?.attributes?.unit_of_measurement));
      if (!valid || parts.some((p) => p.value === null) ||
          (["costDay", "month", "year"].includes(key) && (currencies.size !== 1 || currencies.has(undefined))))
        total[key] = result(
          "unavailable",
          "A current physical member is missing, unavailable, or lacks usable period history.",
        );
      else {
        const complete = parts.every((p) => p.status === "complete");
        total[key] = result(
          complete ? "complete" : "partial",
          "Sum of distinct current physical members for this period. " +
            (complete
              ? "All members cover the calendar boundary."
              : "One or more members have partial coverage; their observation intervals may differ."),
          parts.reduce((sum, p) => sum + p.value, 0),
          Math.min(...parts.map((p) => p.since)),
        );
      }
    }
    values.set(entry.entry_id, total);
  }
  return metadata.entries.map((entry) => {
    const deviceId = metadata.entities.find(
      (e) => e.entity_id === entry.sensors.energy_total,
    )?.device_id;
    return { entry: { ...entry, currency: states[entry.sensors.cost_total]?.attributes?.unit_of_measurement }, values: values.get(entry.entry_id), deviceId };
  });
}

/** Reads are batched. Only the open view makes requests; no polling service. */
export async function loadConsumptionData(hass, metadata, now = Date.now()) {
  const periods = calendarPeriods(now, hass.config.time_zone);
  const physical = metadata.entries.filter((e) => e.type === "physical");
  const ids = [
    ...new Set(
      physical
        .flatMap((e) => Object.keys(UNITS).map((key) => e.sensors[key]))
        .filter(Boolean),
    ),
  ];
  const data = {
    periods,
    daily: {},
    hourly: {},
    boundaries: {},
    initial: {},
    tail: {},
    statisticsMetadata: {},
    warnings: [],
  };
  if (!ids.length) return data;
  const safe = async (message, label) => {
    try {
      return await hass.callWS(message);
    } catch {
      data.warnings.push(`${label} is unavailable.`);
      return {};
    }
  };
  const history = (start, end, entityIds = ids, includeStart = true) => ({
    type: "history/history_during_period",
    start_time: new Date(start).toISOString(),
    end_time: new Date(end).toISOString(),
    entity_ids: entityIds,
    include_start_time_state: includeStart,
    significant_changes_only: false,
    minimal_response: false,
    no_attributes: false,
  });
  const statistics = (start, period) => ({
    type: "recorder/statistics_during_period",
    start_time: new Date(start).toISOString(),
    end_time: new Date(now).toISOString(),
    statistic_ids: ids,
    period,
    types: ["state", "sum", "last_reset"],
    units: { energy: "kWh" },
  });
  const boundaries = [...new Set([periods.day, periods.month, periods.year])];
  const [entries, statMetadata, daily, hourly, tail, ...snapshots] =
    await Promise.all([
      safe(
        { type: "config_entries/get", domain: "appliance_meter" },
        "Appliance creation metadata",
      ),
      safe(
        { type: "recorder/list_statistic_ids", statistic_type: "sum" },
        "Statistics metadata",
      ),
      safe(statistics(periods.previousYearDay, "day"), "Daily statistics"),
      safe(statistics(periods.day, "hour"), "Hourly statistics"),
      safe(
        history(Math.floor(now / HOUR) * HOUR - HOUR, now),
        "Recent history",
      ),
      ...boundaries.map((start) =>
        safe(
          history(start, Math.min(start + 1000, now)),
          "Calendar boundary history",
        ),
      ),
    ]);
  data.daily = daily;
  data.hourly = hourly;
  data.tail = tail;
  boundaries.forEach((start, i) => {
    data.boundaries[start] = snapshots[i];
  });
  if (Array.isArray(statMetadata))
    data.statisticsMetadata = Object.fromEntries(
      statMetadata
        .filter((m) => ids.includes(m.statistic_id))
        .map((m) => [m.statistic_id, m]),
    );
  // Creation time is only a query hint. A real first reading is required; never assume zero.
  const created = new Map(
    (Array.isArray(entries) ? entries : []).map((e) => [
      e.entry_id,
      e.created_at * 1000,
    ]),
  );
  data.created = Object.fromEntries(created);
  const work = physical.filter(
    (e) =>
      finiteTime(created.get(e.entry_id)) &&
      created.get(e.entry_id) >= periods.year,
  );
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, work.length) }, async () => {
      while (index < work.length) {
        const entry = work[index++],
          start = created.get(entry.entry_id);
        const entityIds = Object.keys(UNITS)
          .map((key) => entry.sensors[key])
          .filter(Boolean);
        if (start <= now && entityIds.length)
          Object.assign(
            data.initial,
            await safe(
              history(
                start - 1000,
                Math.min(start + 5 * 60000, now),
                entityIds,
                false,
              ),
              "Initial recorded readings",
            ),
          );
      }
    }),
  );
  data.warnings = [...new Set(data.warnings)];
  return data;
}
