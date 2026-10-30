import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { calendarPeriods } from "../../custom_components/appliance_meter/frontend/consumption-data.js";

const window = new Window();
for (const key of [
  "document",
  "HTMLElement",
  "customElements",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
])
  globalThis[key] = window[key];
const { formatValue } =
  await import("../../custom_components/appliance_meter/frontend/consumption.js");
const NOW = Date.parse("2026-10-29T12:00:00Z"),
  originalNow = Date.now;
const periods = calendarPeriods(NOW, "Europe/Copenhagen");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  Date.now = () => NOW;
  document.body.replaceChildren();
  window.localStorage.clear();
});
afterEach(() => {
  document.body.replaceChildren();
  Date.now = originalNow;
});

function fakeHass(admin = true) {
  const physical = (id, name) => ({
    entry_id: id,
    name,
    type: "physical",
    device_name: `Athom ${id}`,
    assignments: {},
    affected_totals: [],
    state: "loaded",
    members: [],
    sensors: {
      energy_total: `sensor.${id}_energy`,
      cost_total: `sensor.${id}_cost`,
      unpriced_energy: `sensor.${id}_unpriced`,
    },
  });
  const a = physical("a", "Køleskab"),
    b = physical("b", "Example Appliance");
  const group = {
    entry_id: "g",
    name: "IT Infrastructure",
    type: "aggregate",
    state: "loaded",
    assignments: {},
    affected_totals: [],
    members: [{ entry_id: "b" }],
    sensors: { energy_total: "sensor.group_energy" },
  };
  const metadata = {
    entries: [a, group, b],
    entities: [a, group, b].map((e) => ({
      entity_id: e.sensors.energy_total,
      device_id: `${e.entry_id}-device`,
    })),
  };
  const hass = {
    user: { is_admin: admin },
    config: { time_zone: "Europe/Copenhagen" },
    states: {},
    metadata,
    calls: [],
    events: {},
    messages: [],
    unsubscribed: [],
    partial: false,
    async callWS(q) {
      hass.calls.push(q);
      if (q.type === "appliance_meter/management")
        return structuredClone(hass.metadata);
      if (q.type === "config_entries/get")
        return hass.metadata.entries.map((e) => ({
          entry_id: e.entry_id,
          created_at:
            (hass.partial ? NOW - 86400000 : periods.year - 86400000) / 1000,
        }));
      if (q.type === "recorder/list_statistic_ids") return [];
      if (q.type === "recorder/statistics_during_period") return {};
      if (q.type === "history/history_during_period") {
        const start = Date.parse(q.start_time),
          currentPeriods = calendarPeriods(Date.now(), hass.config.time_zone),
          dayBoundary = start === currentPeriods.day,
          boundary = [currentPeriods.day, currentPeriods.month, currentPeriods.year].includes(start);
        if (hass.partial && boundary) return {};
        const result = {};
        for (const id of q.entity_ids) {
          const energy = id.endsWith("energy"),
            cost = id.endsWith("cost");
          const value = !q.include_start_time_state
            ? 0
            : energy
              ? dayBoundary
                ? (Date.now() > NOW ? 132 : 130)
                : boundary
                ? 100
                : 131
              : cost
                ? dayBoundary
                  ? (Date.now() > NOW ? 75 : 74)
                  : boundary
                  ? 50
                  : 75
                : 0;
          result[id] = [
            {
              s: String(value),
              lu: (q.include_start_time_state ? start : start + 1000) / 1000,
              a: { unit_of_measurement: cost ? "DKK" : "kWh" },
            },
          ];
        }
        return result;
      }
      throw Error(`Unexpected write or API ${q.type}`);
    },
    connection: {
      async subscribeMessage(callback) {
        hass.messages.push(callback);
        return () => hass.unsubscribed.push("entries");
      },
      async subscribeEvents(callback, type) {
        hass.events[type] = callback;
        return () => hass.unsubscribed.push(type);
      },
    },
  };
  for (const entry of [a, b])
    for (const [key, id] of Object.entries(entry.sensors))
      hass.states[id] = {
        state:
          key === "energy_total"
            ? entry.entry_id === "a"
              ? "132.5"
              : "150"
            : key === "cost_total"
              ? entry.entry_id === "a"
                ? "75.75"
                : "90"
              : "0",
        attributes: {
          unit_of_measurement: key === "cost_total" ? "DKK" : "kWh",
        },
        last_updated: new Date(NOW - 1000).toISOString(),
      };
  return hass;
}

async function mount(hass) {
  const panel = document.createElement("appliance-consumption-panel");
  panel.hass = hass;
  document.body.append(panel);
  await tick();
  await tick();
  return panel;
}
const names = (panel) =>
  [...panel.shadowRoot.querySelectorAll("tbody tr")].map(
    (r) => r.cells[0].querySelector(".appliance-name").textContent,
  );

test("unified view has eight compact columns and retains Danish period precision", async () => {
  const panel = await mount(fakeHass()),
    root = panel.shadowRoot;
  assert.deepEqual(names(panel), [
    "Example Appliance",
    "IT Infrastructure",
    "Køleskab",
  ]);
  assert.equal(root.querySelectorAll("th").length, 8);
  assert.match(
    root.querySelectorAll("tbody tr")[2].cells[3].textContent,
    /32,50/,
  );
  assert.match(
    root.querySelectorAll("tbody tr")[2].cells[5].textContent,
    /25,75/,
  );
  assert.equal(root.querySelector(".summary").textContent, "3 appliances");
  assert.equal(root.querySelectorAll("tfoot,nav,.overlay").length, 0);
  assert.equal(formatValue(1234.5), "1.234,50");
  assert.equal(formatValue(-0.001), "0,00");
});

test("all headers sort both directions numerically and missing values stay last", async () => {
  const hass = fakeHass(),
    panel = await mount(hass),
    root = panel.shadowRoot;
  root.querySelector('[data-sort="energy"]').click();
  assert.equal(names(panel)[0], "Køleskab");
  root.querySelector('[data-sort="energy"]').click();
  assert.equal(names(panel).at(-1), "Køleskab");
  for (const key of ["month", "year", "name"]) {
    root.querySelector(`[data-sort="${key}"]`).click();
    assert.equal(
      root
        .querySelector(`[data-sort="${key}"]`)
        .parentElement.getAttribute("aria-sort"),
      "ascending",
    );
  }
  hass.states["sensor.a_energy"] = {
    ...hass.states["sensor.a_energy"],
    state: "unavailable",
  };
  panel.hass = hass;
  root.querySelector('[data-sort="energy"]').click();
  root.querySelector('[data-sort="energy"]').click();
  assert.equal(names(panel).at(-1), "Køleskab");
});

test("names open existing details and Custom Total period basis stays explicit", async () => {
  const panel = await mount(fakeHass()),
    root = panel.shadowRoot;
  const group = root.querySelectorAll("tbody tr")[1];
  assert.equal(group.cells[1].textContent, "Custom Total");
  group.querySelector(".metric").click();
  assert.match(
    root.querySelector('.notes[role="status"]').textContent,
    /current physical members/,
  );
  root.querySelector('[data-entry="a"]').click();
  assert.equal(
    root.querySelector('[role="dialog"].detail-box').getAttribute("aria-label"),
    "Køleskab",
  );
  assert.match(root.querySelector(".detail-summary").textContent, /Athom a/);
});

test("unknown/missing history is never rendered as invented zero and partial coverage is visible", async () => {
  const hass = fakeHass();
  hass.partial = true;
  const panel = await mount(hass);
  assert(
    panel.shadowRoot.querySelectorAll('[data-status="partial"]').length > 0,
  );
  assert.match(
    panel.shadowRoot.querySelector('[data-status="partial"]').title,
    /No beginning-of-period baseline/,
  );
  hass.states["sensor.a_energy"] = {
    ...hass.states["sensor.a_energy"],
    state: "unavailable",
  };
  panel.hass = hass;
  assert.match(
    panel.shadowRoot.querySelector('[data-entry="a"]').closest("tr")
      .textContent,
    /Unavailable/,
  );
});

test("live cumulative updates refresh values without issuing history requests or changing sort", async () => {
  const hass = fakeHass(),
    panel = await mount(hass),
    requests = hass.calls.length;
  panel.shadowRoot.querySelector('[data-sort="month"]').click();
  hass.states["sensor.a_cost"] = {
    ...hass.states["sensor.a_cost"],
    state: "80",
    last_updated: new Date(NOW).toISOString(),
  };
  panel.hass = hass;
  assert.equal(hass.calls.length, requests);
  assert.match(
    panel.shadowRoot.querySelector('[data-entry="a"]').closest("tr").cells[5]
      .textContent,
    /30,00/,
  );
  assert.equal(
    panel.shadowRoot
      .querySelector('[data-sort="month"]')
      .parentElement.getAttribute("aria-sort"),
    "ascending",
  );
});

test("new, removed and renamed appliances update from HA entry events", async () => {
  const hass = fakeHass(),
    panel = await mount(hass);
  hass.metadata.entries[0].name = "Ovn";
  hass.metadata.entries.splice(1, 1);
  hass.messages[0]([{ entry: { domain: "appliance_meter" } }]);
  await tick();
  await tick();
  assert.deepEqual(names(panel), ["Example Appliance", "Ovn"]);
  const entry = structuredClone(hass.metadata.entries[0]);
  entry.entry_id = "new";
  entry.name = "Åben";
  hass.metadata.entries.push(entry);
  hass.messages[0]([{ type: "added" }]);
  await tick();
  await tick();
  assert.deepEqual(names(panel), ["Example Appliance", "Ovn", "Åben"]);
});

test("statistics events refresh native history without a timer or metadata write", async () => {
  const hass = fakeHass(),
    panel = await mount(hass),
    previous = hass.calls.length;
  hass.events.recorder_5min_statistics_generated();
  await tick();
  await tick();
  const messages = hass.calls.slice(previous);
  assert(messages.some((q) => q.type === "recorder/statistics_during_period"));
  assert(!messages.some((q) => q.type === "appliance_meter/management"));
  assert(panel.shadowRoot.querySelector("table"));
});

test("non-admins make no calls, privilege revocation clears readings, and disconnect unsubscribes", async () => {
  const denied = fakeHass(false),
    gate = await mount(denied);
  assert.equal(denied.calls.length, 0);
  assert.match(gate.shadowRoot.textContent, /Administrator access/);
  const hass = fakeHass(),
    panel = await mount(hass);
  hass.user.is_admin = false;
  panel.hass = hass;
  assert.equal(panel.shadowRoot.querySelector("table"), null);
  assert.equal(hass.unsubscribed.length, 4);
  const other = fakeHass(),
    mounted = await mount(other);
  mounted.remove();
  assert.equal(other.unsubscribed.length, 4);
});

test("an in-flight refresh cannot repopulate a disconnected or revoked view", async () => {
  const hass = fakeHass();
  let resolve;
  hass.callWS = () =>
    new Promise((r) => {
      resolve = r;
    });
  const panel = await mount(hass);
  panel.remove();
  resolve(hass.metadata);
  await tick();
  assert.equal(panel._metadata, null);
});

test("HTML in appliance names is text and responsive CSS keeps a scrollable table", async () => {
  const hass = fakeHass();
  hass.metadata.entries[0].name = '<img src=x onerror="throw 1">';
  const panel = await mount(hass);
  assert.equal(panel.shadowRoot.querySelector("img"), null);
  assert.match(
    panel.shadowRoot.querySelector("style").textContent,
    /overflow:auto/,
  );
  assert.equal(panel.shadowRoot.querySelector(".table-host").tabIndex, 0);
});

test("calendar rollover refreshes boundaries using the HA timezone", async () => {
  const hass = fakeHass(),
    panel = await mount(hass),
    before = hass.calls.length;
  Date.now = () => Date.parse("2026-10-31T23:30:00Z");
  panel.hass = hass;
  await tick();
  await tick();
  assert.equal(
    panel._periodData.periods.month,
    Date.parse("2026-10-31T23:00:00Z"),
  );
  assert(
    hass.calls
      .slice(before)
      .some((q) => q.start_time === "2026-10-31T23:00:00.000Z"),
  );
});

test("cards and list show identical period values and preserve numeric sorting without extra reads", async () => {
  const hass = fakeHass(),
    panel = await mount(hass),
    root = panel.shadowRoot;
  root.querySelector('[data-sort="energy"]').click();
  const list = [...root.querySelectorAll(".metric")].map((e) => [
    e.dataset.metric,
    e.textContent,
    e.dataset.status,
  ]);
  const requests = hass.calls.length;
  root.querySelector('[data-view="card"]').click();
  assert.deepEqual(
    [...root.querySelectorAll(".metric")].map((e) => [
      e.dataset.metric,
      e.textContent,
      e.dataset.status,
    ]),
    list,
  );
  assert.equal(
    root.querySelector(".appliance-card .appliance-name").textContent,
    "Køleskab",
  );
  const sort = root.querySelector('[aria-label="Sort appliances"]');
  sort.value = "month:-1";
  sort.dispatchEvent(new Event("change"));
  assert.equal(
    root.querySelector(".appliance-card .appliance-name").textContent,
    "Example Appliance",
  );
  root.querySelector('[data-view="list"]').click();
  assert.equal(names(panel)[0], "Example Appliance");
  assert.equal(
    root
      .querySelector('[data-sort="month"]')
      .parentElement.getAttribute("aria-sort"),
    "descending",
  );
  assert.equal(hass.calls.length, requests);
});

test("both views retain partial/unavailable period semantics and the legacy route is only an alias", async () => {
  const hass = fakeHass();
  hass.partial = true;
  const panel = await mount(hass),
    root = panel.shadowRoot;
  assert(root.querySelector('.metric[data-status="partial"] .partial'));
  for (const key of ["energyDay", "costDay"])
    assert(root.querySelector(`[data-metric="a:${key}"][data-status="partial"] .partial`));
  panel.selectView("card");
  assert(root.querySelector('.appliance-card .metric[data-status="partial"]'));
  hass.states["sensor.a_energy"] = {
    ...hass.states["sensor.a_energy"],
    state: "unavailable",
  };
  panel.hass = hass;
  assert.match(
    [...root.querySelectorAll(".appliance-card")].find(
      (c) => c.querySelector(".appliance-name").textContent === "Køleskab",
    ).textContent,
    /Unavailable/,
  );
  const { ApplianceMeterPanel } =
    await import("../../custom_components/appliance_meter/frontend/panel.js");
  assert(panel instanceof ApplianceMeterPanel);
  assert.equal(root.querySelectorAll(".toolbar").length, 1);
});

for (const view of ["list", "card"]) {
  for (const metricKey of ["month", "costDay"])
  test(`${view} ${metricKey}: automatic metric/history refresh preserves an open menu and defers live sorting`, async () => {
    const hass = fakeHass(), panel = await mount(hass), root = panel.shadowRoot;
    root.querySelector(`[data-sort="${metricKey}"]`).click();
    panel.selectView(view);
    const container = root.querySelector(view === "list" ? "tbody" : ".cards");
    const rows = () => [...container.children];
    const originalRows = rows();
    const appliance = rows().find((row) => row.dataset.row === "a");
    const metric = appliance.querySelector(`[data-metric="a:${metricKey}"]`);
    const unchangedMetric = appliance.querySelector('[data-metric="a:energy"]');
    const unchangedValue = unchangedMetric.firstChild;
    const trigger = appliance.querySelector(".menu-trigger");
    trigger.click();
    const menu = appliance.querySelector('[role="menu"]');
    const edit = [...menu.querySelectorAll("button")].find((b) => b.textContent === "Edit");
    edit.focus();
    const requests = hass.calls.length;
    hass.states["sensor.a_cost"] = {
      ...hass.states["sensor.a_cost"], state: "150",
      last_updated: new Date(NOW).toISOString(),
    };
    panel.hass = hass;
    assert.equal(hass.calls.length, requests);
    assert.equal(appliance.querySelector(`[data-metric="a:${metricKey}"]`), metric);
    assert.match(metric.textContent, metricKey === "month" ? /100,00/ : /76,00/);
    assert.equal(unchangedMetric.firstChild, unchangedValue);
    assert.deepEqual(rows(), originalRows);
    assert.equal(menu.hidden, false);
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.equal(root.activeElement, edit);

    // Recorder refresh and an unchanged metadata projection must also retain nodes.
    await panel.refresh(false);
    await panel.refresh(true);
    assert.deepEqual(rows(), originalRows);
    assert.equal(appliance.querySelector('[role="menu"]'), menu);
    assert.equal(menu.hidden, false);
    assert.equal(root.activeElement, edit);
    assert.equal(panel._view, view);
    assert.equal(panel._sort, metricKey);
    assert.equal(panel._sortDirection, 1);

    let edited;
    panel.openFlow = (id) => { edited = id; };
    edit.click();
    await tick();
    assert.equal(edited, "a");
    assert.equal(menu.hidden, true);
    assert.equal(rows().at(-1), appliance);
    assert.deepEqual(new Set(rows()), new Set(originalRows));
    metric.click();
    assert.equal(root.querySelector(".notes[role=status]").textContent, `Køleskab: ${metric.title}`);
  });
}

for (const view of ["list", "card"]) {
  test(`${view}: local midnight reloads daily baselines in place without closing the menu`, async () => {
    const hass = fakeHass(), panel = await mount(hass), root = panel.shadowRoot;
    panel.selectView(view);
    const row = root.querySelector('[data-row="a"]');
    const energy = row.querySelector('[data-metric="a:energyDay"]');
    const cost = row.querySelector('[data-metric="a:costDay"]');
    assert.match(energy.textContent, /2,50/);
    assert.match(cost.textContent, /1,75/);
    row.querySelector('.menu-trigger').click();
    const menu = row.querySelector('[role="menu"]');
    const before = hass.calls.length;
    Date.now = () => Date.parse("2026-10-29T23:30:00Z");
    panel.hass = hass;
    await tick(); await tick();
    assert.equal(panel._periodData.periods.day, Date.parse("2026-10-29T23:00:00Z"));
    assert.equal(panel._periodData.periods.month, periods.month);
    assert(hass.calls.slice(before).some((q) => q.start_time === "2026-10-29T23:00:00.000Z"));
    assert.equal(root.querySelector('[data-row="a"]'), row);
    assert.equal(row.querySelector('[data-metric="a:energyDay"]'), energy);
    assert.match(energy.textContent, /0,50/);
    assert.match(cost.textContent, /0,75/);
    assert.equal(menu.hidden, false);
    menu.querySelector('button').click();
    assert.equal(root.querySelector('.detail-box').getAttribute('aria-label'), 'Køleskab');
  });
}
