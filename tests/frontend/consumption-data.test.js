import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calendarPeriods,
  consumptionRows,
  loadConsumptionData,
  numeric,
  periodMetric,
} from "../../custom_components/appliance_meter/frontend/consumption-data.js";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const periods = calendarPeriods(NOW, "Europe/Copenhagen");
const unit = (key) => (key === "cost_total" ? "DKK" : "kWh");
const raw = (value, time, key = "energy_total", extra = {}) => ({
  s: String(value),
  lu: time / 1000,
  a: { unit_of_measurement: unit(key), ...extra },
});
export function fixture() {
  const entry = {
    entry_id: "one",
    name: "Køleskab",
    type: "physical",
    members: [],
    sensors: {
      energy_total: "sensor.energy",
      cost_total: "sensor.cost",
      unpriced_energy: "sensor.unpriced",
    },
  };
  const states = {},
    boundaries = { [periods.day]: {}, [periods.month]: {}, [periods.year]: {} };
  for (const [key, id] of Object.entries(entry.sensors)) {
    states[id] = {
      state:
        key === "energy_total" ? "132.5" : key === "cost_total" ? "75.75" : "0",
      attributes: { unit_of_measurement: unit(key) },
    };
    boundaries[periods.day][id] = [
      raw(key === "energy_total" ? 125 : key === "cost_total" ? 70 : 0, periods.day, key),
    ];
    boundaries[periods.month][id] = [
      raw(
        key === "energy_total" ? 100 : key === "cost_total" ? 50 : 0,
        periods.month,
        key,
      ),
    ];
    boundaries[periods.year][id] = [
      raw(
        key === "energy_total" ? 10 : key === "cost_total" ? 10 : 0,
        periods.year,
        key,
      ),
    ];
  }
  const metadata = {
    entries: [entry],
    entities: [{ entity_id: "sensor.energy", device_id: "logical-device" }],
  };
  const data = {
    periods,
    boundaries,
    created: { one: periods.year - 86400000 },
    initial: {},
    daily: {},
    hourly: {},
    tail: {},
    statisticsMetadata: {},
    warnings: [],
  };
  return { entry, states, metadata, data };
}

test("calendar periods use HA timezone, including Danish DST and year rollover", () => {
  assert.equal(
    new Date(periods.month).toISOString(),
    "2026-09-30T22:00:00.000Z",
  );
  assert.equal(
    new Date(periods.year).toISOString(),
    "2025-12-31T23:00:00.000Z",
  );
  const april = calendarPeriods(
    Date.parse("2026-04-15T12:00:00Z"),
    "Europe/Copenhagen",
  );
  assert.equal(new Date(april.month).toISOString(), "2026-03-31T22:00:00.000Z");
  const jan = calendarPeriods(
    Date.parse("2026-12-31T23:30:00Z"),
    "Europe/Copenhagen",
  );
  assert.equal(jan.month, jan.year);
  assert.equal(new Date(jan.year).toISOString(), "2026-12-31T23:00:00.000Z");
});

test("finite parsing never converts absent/empty/unavailable values into zero", () => {
  for (const value of [
    null,
    undefined,
    false,
    "",
    " ",
    "unavailable",
    "unknown",
    "NaN",
    Infinity,
    "0x10",
  ])
    assert.equal(numeric(value), null);
  assert.equal(numeric("0"), 0);
  assert.equal(numeric("-1.2e-3"), -0.0012);
});

test("exact calendar readings derive energy and separately recorded costs", () => {
  const { metadata, data, states } = fixture();
  const [row] = consumptionRows(metadata, data, states, NOW);
  assert.equal(row.values.energyDay.value, 7.5);
  assert.equal(row.values.costDay.value, 5.75);
  assert.equal(row.values.costDay.status, "complete");
  assert.equal(row.values.energy.value, 32.5);
  assert.equal(row.values.month.value, 25.75);
  assert.equal(row.values.year.value, 65.75);
  assert.equal(row.values.year.status, "complete");
  assert.equal(row.deviceId, "logical-device");
});

test("mid-period creation uses a real zero reading and is visibly partial", () => {
  const { entry, data, states } = fixture();
  data.boundaries = {};
  data.initial[entry.sensors.energy_total] = [raw(0, NOW - 86400000)];
  const result = periodMetric(
    entry,
    "energy_total",
    periods.month,
    data,
    states,
    NOW,
  );
  assert.equal(result.value, 132.5);
  assert.equal(result.status, "partial");
  assert.equal(result.since, NOW - 86400000);
});

test("missing initial history subtracts earliest observed value, never assumes zero", () => {
  const { entry, data, states } = fixture();
  data.boundaries = {};
  data.tail[entry.sensors.energy_total] = [raw(130, NOW - 3600000)];
  let value = periodMetric(
    entry,
    "energy_total",
    periods.month,
    data,
    states,
    NOW,
  );
  assert.equal(value.value, 2.5);
  assert.equal(value.status, "partial");
  data.tail = {};
  value = periodMetric(entry, "energy_total", periods.month, data, states, NOW);
  assert.equal(value.status, "insufficient");
  assert.equal(value.value, null);
});

test("statistics baseline uses the closing reading of the PRECEDING bucket", () => {
  const { entry, data, states } = fixture();
  data.boundaries = {};
  const id = entry.sensors.energy_total;
  data.statisticsMetadata[id] = {
    has_sum: true,
    statistics_unit_of_measurement: "kWh",
  };
  data.daily[id] = [
    {
      start: periods.month - 86400000,
      end: periods.month,
      state: 100,
      sum: 80,
    },
    {
      start: periods.month,
      end: periods.month + 86400000,
      state: 110,
      sum: 90,
    },
    { start: NOW, end: NOW + 86400000, state: 99999, sum: 99999 },
  ];
  const result = periodMetric(
    entry,
    "energy_total",
    periods.month,
    data,
    states,
    NOW,
  );
  assert.equal(result.value, 32.5);
  assert.equal(result.status, "complete");
  data.daily[id].shift();
  const partial = periodMetric(
    entry,
    "energy_total",
    periods.month,
    data,
    states,
    NOW,
  );
  assert.equal(partial.value, 22.5);
  assert.equal(partial.status, "partial");
});

test("an unavailable boundary is not replaced with an apparently complete statistics baseline", () => {
  const { entry, data, states } = fixture();
  const id = entry.sensors.energy_total;
  data.boundaries[periods.month][id] = [raw("unavailable", periods.month)];
  data.statisticsMetadata[id] = {
    has_sum: true,
    statistics_unit_of_measurement: "kWh",
  };
  data.daily[id] = [{ end: periods.month, state: 100, sum: 80 }];
  data.tail[id] = [raw(130, NOW - 1000)];
  const value = periodMetric(
    entry,
    "energy_total",
    periods.month,
    data,
    states,
    NOW,
  );
  assert.equal(value.status, "partial");
  assert.equal(value.value, 2.5);
});

test("current unavailable, restored and incompatible units remain explicit", () => {
  for (const change of [
    (s) => {
      s.state = "unavailable";
    },
    (s) => {
      s.attributes.restored = true;
    },
    (s) => {
      s.attributes.unit_of_measurement = "Wh";
    },
  ]) {
    const { entry, data, states } = fixture();
    change(states[entry.sensors.energy_total]);
    assert.equal(
      periodMetric(entry, "energy_total", periods.month, data, states, NOW)
        .status,
      "unavailable",
    );
  }
});

test("HA restart gaps inside a period do not replace missing readings with zero", () => {
  const { entry, data, states } = fixture();
  data.tail[entry.sensors.energy_total] = [
    raw(120, NOW - 30000),
    raw("unavailable", NOW - 20000),
    raw(130, NOW - 10000),
  ];
  const metric = periodMetric(
    entry,
    "energy_total",
    periods.month,
    data,
    states,
    NOW,
  );
  assert.equal(metric.status, "complete");
  assert.equal(metric.value, 32.5);
});

test("recorded decreases, resets and Recorder reset adjustments fail closed", () => {
  for (const kind of ["raw", "statistics", "last_reset", "live"]) {
    const { entry, data, states } = fixture(),
      id = entry.sensors.energy_total;
    if (kind === "raw")
      data.tail[id] = [raw(125, NOW - 30000), raw(120, NOW - 20000)];
    if (kind === "live") data.live = { [id]: [raw(140, NOW - 30000)] };
    if (kind === "last_reset")
      data.tail[id] = [
        raw(125, NOW - 20000, "energy_total", {
          last_reset: "2026-10-20T00:00:00Z",
        }),
      ];
    if (kind === "statistics") {
      data.statisticsMetadata[id] = {
        has_sum: true,
        statistics_unit_of_measurement: "kWh",
      };
      data.daily[id] = [
        { end: periods.month + 86400000, state: 110, sum: 10 },
        { end: periods.month + 2 * 86400000, state: 120, sum: 40 },
      ];
    }
    assert.equal(
      periodMetric(entry, "energy_total", periods.month, data, states, NOW)
        .status,
      "discontinuity",
      kind,
    );
  }
});

test("negative historical cost is valid and unpriced energy is disclosed", () => {
  const { metadata, data, states } = fixture();
  states["sensor.cost"].state = "40";
  let row = consumptionRows(metadata, data, states, NOW)[0];
  assert.equal(row.values.month.value, -10);
  assert.equal(row.values.month.status, "complete");
  states["sensor.unpriced"].state = ".5";
  row = consumptionRows(metadata, data, states, NOW)[0];
  assert.equal(row.values.month.value, -10);
  assert.equal(row.values.month.status, "partial");
  assert.match(row.values.month.reason, /0,500 kWh/);
});

test("Custom Totals sum current distinct physical period results, not membership-induced lifetime steps", () => {
  const { metadata, data, states } = fixture();
  metadata.entries.push({
    entry_id: "group",
    name: "IT",
    type: "aggregate",
    members: [{ entry_id: "one" }],
    sensors: { energy_total: "sensor.group" },
  });
  states["sensor.group"] = {
    state: "9999",
    attributes: { unit_of_measurement: "kWh" },
  };
  const rows = consumptionRows(metadata, data, states, NOW);
  assert.equal(rows.length, 2);
  for (const key of ["energyDay", "costDay", "energy", "month", "year"])
    assert.equal(rows[1].values[key].value, rows[0].values[key].value);
  assert.match(rows[1].values.energy.reason, /current physical members/);
  metadata.entries[1].members.push({ entry_id: "one" });
  assert.equal(
    consumptionRows(metadata, data, states, NOW)[1].values.energy.value,
    null,
  );
  metadata.entries[1].members = [{ entry_id: "missing" }];
  assert.equal(
    consumptionRows(metadata, data, states, NOW)[1].values.year.status,
    "unavailable",
  );
  metadata.entries[1].members = [{ entry_id: "group" }];
  assert.equal(
    consumptionRows(metadata, data, states, NOW)[1].values.energy.value,
    null,
  );
});

test("Custom Totals propagate incomplete member coverage and never publish partial sums for missing members", () => {
  const { metadata, data, states } = fixture();
  metadata.entries.push({
    entry_id: "group",
    name: "IT",
    type: "aggregate",
    members: [{ entry_id: "one" }],
    sensors: {},
  });
  delete data.boundaries[periods.month]["sensor.energy"];
  data.tail["sensor.energy"] = [raw(130, NOW - 1000)];
  assert.equal(
    consumptionRows(metadata, data, states, NOW)[1].values.energy.status,
    "partial",
  );
  states["sensor.energy"].state = "unavailable";
  assert.equal(
    consumptionRows(metadata, data, states, NOW)[1].values.energy.status,
    "unavailable",
  );
});

test("loader uses native read-only APIs, bounded raw history and real creation hints", async () => {
  const { metadata } = fixture(),
    calls = [];
  const hass = {
    config: { time_zone: "Europe/Copenhagen" },
    async callWS(q) {
      calls.push(q);
      if (q.type === "config_entries/get")
        return [{ entry_id: "one", created_at: (NOW - 86400000) / 1000 }];
      if (q.type === "recorder/list_statistic_ids") return [];
      return {};
    },
  };
  const data = await loadConsumptionData(hass, metadata, NOW);
  assert.equal(data.periods.day, periods.day);
  assert(calls.some((q) => q.type === "history/history_during_period" && Date.parse(q.start_time) === periods.day));
  assert.equal(data.periods.month, periods.month);
  assert(
    calls.every((q) =>
      [
        "config_entries/get",
        "recorder/list_statistic_ids",
        "recorder/statistics_during_period",
        "history/history_during_period",
      ].includes(q.type),
    ),
  );
  const histories = calls.filter(
    (q) => q.type === "history/history_during_period",
  );
  assert(
    histories.every(
      (q) => Date.parse(q.end_time) - Date.parse(q.start_time) <= 2 * 3600000,
    ),
  );
  assert(histories.some((q) => !q.include_start_time_state));
  assert.deepEqual(data.initial, {});
});

test("missing Recorder/history capabilities produce clear warnings, never fake readings", async () => {
  const { metadata } = fixture();
  const data = await loadConsumptionData(
    {
      config: { time_zone: "Europe/Copenhagen" },
      callWS: async () => {
        throw Error("unavailable");
      },
    },
    metadata,
    NOW,
  );
  assert(data.warnings.length > 0);
  assert.deepEqual(data.daily, {});
});

test("history/statistics predating the current appliance identity are never reused", () => {
  const { entry, data, states } = fixture();
  const created = NOW - 86400000;
  data.created.one = created;
  data.statisticsMetadata["sensor.energy"] = {
    has_sum: true,
    statistics_unit_of_measurement: "kWh",
  };
  data.daily["sensor.energy"] = [
    { end: periods.month, state: 999, sum: 999 },
    { end: created - 1000, state: 999, sum: 999 },
  ];
  data.initial["sensor.energy"] = [raw(10, created + 1000)];
  const value = periodMetric(
    entry,
    "energy_total",
    periods.month,
    data,
    states,
    NOW,
  );
  assert.equal(value.status, "partial");
  assert.equal(value.value, 122.5);
  assert.equal(value.since, created + 1000);
  data.created = {};
  assert.equal(
    periodMetric(entry, "energy_total", periods.month, data, states, NOW)
      .status,
    "insufficient",
  );
});

test("old reset metadata does not invalidate a later period, but unit changes do", () => {
  const { entry, data, states } = fixture();
  data.tail["sensor.energy"] = [
    raw(125, NOW - 10000, "energy_total", {
      last_reset: "2025-01-01T00:00:00Z",
    }),
  ];
  assert.equal(
    periodMetric(entry, "energy_total", periods.month, data, states, NOW)
      .status,
    "complete",
  );
  data.tail["sensor.energy"] = [
    raw(125, NOW - 10000, "energy_total", { unit_of_measurement: "Wh" }),
  ];
  assert.equal(
    periodMetric(entry, "energy_total", periods.month, data, states, NOW)
      .status,
    "discontinuity",
  );
});

test("a small counter decrease is still detected with a large lifetime total", () => {
  const { entry, data, states } = fixture();
  data.boundaries[periods.month]["sensor.energy"] = [
    raw(1000000, periods.month),
  ];
  states["sensor.energy"].state = "999999.99999";
  assert.equal(
    periodMetric(entry, "energy_total", periods.month, data, states, NOW)
      .status,
    "discontinuity",
  );
});

test("daily boundary follows local midnight across DST and midnight rollover", () => {
  const zone = "Europe/Copenhagen";
  const cases = [
    ["2026-03-28T23:30:00Z", "2026-03-28T23:00:00Z"],
    ["2026-03-29T22:30:00Z", "2026-03-29T22:00:00Z"],
    ["2026-10-24T22:30:00Z", "2026-10-24T22:00:00Z"],
    ["2026-10-25T23:30:00Z", "2026-10-25T23:00:00Z"],
    ["2026-10-29T22:59:59Z", "2026-10-28T23:00:00Z"],
    ["2026-10-29T23:00:00Z", "2026-10-29T23:00:00Z"],
  ];
  for (const [now, midnight] of cases)
    assert.equal(calendarPeriods(Date.parse(now), zone).day, Date.parse(midnight));
  assert.equal(calendarPeriods(Date.parse(cases[1][0]), zone).day - calendarPeriods(Date.parse(cases[0][0]), zone).day, 23 * 3600000);
  assert.equal(calendarPeriods(Date.parse(cases[3][0]), zone).day - calendarPeriods(Date.parse(cases[2][0]), zone).day, 25 * 3600000);
});

test("daily missing baselines show only observed partial differences, never invented zero", () => {
  const { metadata, data, states } = fixture();
  delete data.boundaries[periods.day];
  for (const [id, value, key] of [["sensor.energy", 130, "energy_total"], ["sensor.cost", 74, "cost_total"], ["sensor.unpriced", 0, "unpriced_energy"]])
    data.tail[id] = [raw(value, NOW - 3600000, key)];
  const row = consumptionRows(metadata, data, states, NOW)[0];
  assert.equal(row.values.energyDay.value, 2.5);
  assert.equal(row.values.costDay.value, 1.75);
  assert.equal(row.values.energyDay.status, "partial");
  assert.equal(row.values.costDay.status, "partial");
  assert.equal(row.values.energyDay.since, NOW - 3600000);
  data.tail = {};
  const missing = consumptionRows(metadata, data, states, NOW)[0];
  assert.equal(missing.values.energyDay.value, null);
  assert.equal(missing.values.costDay.status, "insufficient");
});

test("daily costs use recorded cost differences including negative prices and unpriced coverage", () => {
  const { metadata, data, states } = fixture();
  states["sensor.cost"].state = "68";
  let row = consumptionRows(metadata, data, states, NOW)[0];
  assert.equal(row.values.costDay.value, -2);
  assert.equal(row.values.costDay.status, "complete");
  states["sensor.unpriced"].state = "0.5";
  row = consumptionRows(metadata, data, states, NOW)[0];
  assert.equal(row.values.costDay.value, -2);
  assert.equal(row.values.costDay.status, "partial");
  assert.match(row.values.costDay.reason, /0,500 kWh/);
});

test("daily statistics use the preceding closing bucket and respect unavailable midnight history", () => {
  const { entry, data, states } = fixture();
  delete data.boundaries[periods.day];
  data.statisticsMetadata["sensor.energy"] = { has_sum: true, statistics_unit_of_measurement: "kWh" };
  data.daily["sensor.energy"] = [{ end: periods.day, state: 125, sum: 125 }];
  assert.equal(periodMetric(entry, "energy_total", periods.day, data, states, NOW).status, "complete");
  data.boundaries[periods.day] = { "sensor.energy": [raw("unavailable", periods.day)] };
  data.hourly["sensor.energy"] = [{ end: periods.day + 3600000, state: 126, sum: 126 }];
  const partial = periodMetric(entry, "energy_total", periods.day, data, states, NOW);
  assert.equal(partial.status, "partial");
  assert.equal(partial.value, 6.5);
});

test("daily Custom Totals propagate partial and unavailable member results", () => {
  const { metadata, data, states } = fixture();
  metadata.entries.push({ entry_id: "group", type: "aggregate", members: [{ entry_id: "one" }], sensors: {} });
  data.created.one = periods.day + 3600000;
  for (const [id, value, key] of [["sensor.energy", 120, "energy_total"], ["sensor.cost", 60, "cost_total"], ["sensor.unpriced", 0, "unpriced_energy"]])
    data.initial[id] = [raw(value, data.created.one, key)];
  let group = consumptionRows(metadata, data, states, NOW)[1];
  assert.equal(group.values.energyDay.value, 12.5);
  assert.equal(group.values.costDay.value, 15.75);
  assert.equal(group.values.energyDay.status, "partial");
  assert.equal(group.values.costDay.status, "partial");
  metadata.entries[1].members.push({ entry_id: "missing" });
  group = consumptionRows(metadata, data, states, NOW)[1];
  assert.equal(group.values.energyDay.value, null);
  assert.equal(group.values.costDay.status, "unavailable");
});

test("loader deduplicates coincident day/month/year midnight requests", async () => {
  const { metadata } = fixture(), calls = [];
  const now = Date.parse("2026-12-31T23:30:00Z");
  await loadConsumptionData({ config: { time_zone: "Europe/Copenhagen" }, callWS: async (q) => { calls.push(q); return []; } }, metadata, now);
  const boundaryRequests = calls.filter((q) => q.type === "history/history_during_period" && q.start_time === "2026-12-31T23:00:00.000Z");
  assert.equal(boundaryRequests.length, 1);
});

test("foreign currency period costs retain their units and reject mixed-currency sums", () => {
  const { entry, states, metadata, data } = fixture();
  states[entry.sensors.cost_total].attributes.unit_of_measurement = "EUR";
  for (const boundary of Object.values(data.boundaries))
    boundary[entry.sensors.cost_total][0].a.unit_of_measurement = "EUR";
  const rows = consumptionRows(metadata, data, states, NOW);
  assert.equal(rows[0].entry.currency, "EUR");
  assert.equal(rows[0].values.month.value, 25.75);
  const second = { ...entry, entry_id: "two", sensors: { ...entry.sensors, cost_total: "sensor.cost_two" } };
  states["sensor.cost_two"] = { state: "100", attributes: { unit_of_measurement: "USD" } };
  data.created.two = data.created.one;
  for (const boundary of Object.values(data.boundaries))
    boundary["sensor.cost_two"] = [{ ...boundary[entry.sensors.cost_total][0], a: { unit_of_measurement: "USD" } }];
  const group = { entry_id: "group", type: "aggregate", name: "Group",
    members: [{ entry_id: "one" }, { entry_id: "two" }], sensors: {} };
  metadata.entries.push(second, group);
  const mixed = consumptionRows(metadata, data, states, NOW).at(-1);
  assert.equal(mixed.values.month.status, "unavailable");
  assert.equal(mixed.values.energy.value, 65);
});
