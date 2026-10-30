import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { metadata, userStep } from "./fixtures.js";
const window = new Window();
for (const key of [
  "document",
  "HTMLElement",
  "customElements",
  "Event",
  "KeyboardEvent",
])
  globalThis[key] = window[key];
await import("../../custom_components/appliance_meter/frontend/panel.js");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
});
function fakeHass(admin = true) {
  const events = {},
    messages = [],
    calls = [],
    unsubscribed = [];
  const hass = {
    user: { is_admin: admin },
    locale: { language: "en" },
    config: { time_zone: "Europe/Copenhagen" },
    states: {
      "sensor.logical_power": {
        state: "12.5",
        attributes: { unit_of_measurement: "W" },
      },
      "sensor.logical_energy": {
        state: "3.5",
        attributes: { unit_of_measurement: "kWh" },
      },
      "sensor.logical_cost": {
        state: "4.5",
        attributes: { unit_of_measurement: "DKK" },
      },
    },
    data: metadata(),
    calls,
    events,
    messages,
    unsubscribed,
    callWS: async (message) => {
      calls.push(["WS", message]);
      if (message.type === "appliance_meter/management")
        return structuredClone(hass.data);
      if (
        message.type === "config_entries/get" ||
        message.type === "recorder/list_statistic_ids"
      )
        return [];
      return {};
    },
    callApi: async (...args) => {
      calls.push(args);
      if (args[1].endsWith("/flow")) return userStep();
      return { require_restart: false };
    },
    connection: {
      subscribeMessage: async (callback) => {
        messages.push(callback);
        return () => unsubscribed.push("entries");
      },
      subscribeEvents: async (callback, type) => {
        events[type] = callback;
        return () => unsubscribed.push(type);
      },
    },
  };
  return hass;
}
async function mount(hass) {
  const panel = document.createElement("appliance-meter-panel");
  panel.hass = hass;
  document.body.append(panel);
  await tick();
  return panel;
}
function button(root, text) {
  return [...root.querySelectorAll("button")].find(
    (el) => el.textContent === text,
  );
}

function action(root, label, index = 0) {
  const row = root.matches?.("tr")
    ? root
    : root.querySelectorAll("tbody tr")[index];
  if (!row) return button(root, label);
  row.querySelector(".menu-trigger").click();
  return button(
    row.querySelector('[role="menu"]'),
    label === "Open" ? "Open details" : label,
  );
}

test("administrator gate makes no management calls for non-admins", async () => {
  const hass = fakeHass(false),
    panel = await mount(hass);
  assert.match(panel.shadowRoot.textContent, /Administrator access/);
  assert.equal(hass.calls.length, 0);
});

test("live state updates retain active form drafts and unavailable is explicit", async () => {
  const hass = fakeHass(),
    panel = await mount(hass),
    root = panel.shadowRoot;

  button(root, "Create Appliance").click();
  await tick();
  const input = root.querySelector(".overlay #field-name");
  input.value = "Draft";
  input.dispatchEvent(new Event("input"));
  hass.states["sensor.logical_power"].state = "unavailable";
  panel.hass = hass;
  assert.match(
    root.querySelector(".configuration-status").getAttribute("aria-label"),
    /Unavailable/,
  );
  assert.equal(root.querySelector(".overlay #field-name"), input);
  assert.equal(input.value, "Draft");
});
test("details show existing assignments and friendly device", async () => {
  const hass = fakeHass(),
    panel = await mount(hass);
  action(panel.shadowRoot, "Open").click();
  const detail = panel.shadowRoot.querySelector(".overlay");
  for (const text of [
    "Athom meter",
    "Power sensor",
    "Server power",
    "sensor.energy",
    "Price sensor",
    "sensor.price",
  ])
    assert(detail.textContent.includes(text));
  assert.doesNotMatch(detail.textContent, /entry-physical/);
});
test("external Helpers edits and registry changes refresh the projection", async () => {
  const hass = fakeHass(),
    panel = await mount(hass);
  hass.data.entries[0].name = "Renamed in Helpers";
  hass.messages[0]([{ type: "updated", entry: { domain: "appliance_meter" } }]);
  await tick();
  assert.match(panel.shadowRoot.textContent, /Renamed in Helpers/);
  hass.data.entries[0].device_name = "Renamed physical device";
  hass.events.device_registry_updated({});
  await tick();
  assert.match(panel.shadowRoot.textContent, /Renamed physical device/);
});

test("deletion warns about affected groups and requires explicit confirmation", async () => {
  const hass = fakeHass(),
    panel = await mount(hass);
  action(panel.shadowRoot, "Delete").click();
  await tick();
  const overlay = panel.shadowRoot.querySelector(".overlay");
  assert.match(overlay.textContent, /Affected Custom Totals: Example Group/);
  assert.match(overlay.textContent, /unavailable until you edit/);
  assert.equal(hass.calls.filter((c) => c[0] === "DELETE").length, 0);
  button(overlay, "Cancel").click();
  assert.equal(hass.calls.filter((c) => c[0] === "DELETE").length, 0);
  action(panel.shadowRoot, "Delete").click();
  await tick();
  button(panel.shadowRoot.querySelector(".overlay"), "Remove").click();
  await tick();
  assert.deepEqual(
    hass.calls.filter((c) => c[0] === "DELETE"),
    [["DELETE", "config/config_entries/entry/entry-physical"]],
  );
});
test("disconnect cleans subscriptions and pending unfinished forms", async () => {
  const hass = fakeHass(),
    panel = await mount(hass);
  button(panel.shadowRoot, "Create Appliance").click();
  await tick();
  panel.remove();
  await tick();
  assert.equal(hass.unsubscribed.length, 4);
  assert.deepEqual(
    hass.calls.filter((c) => c[0] === "DELETE"),
    [["DELETE", "config/config_entries/flow/new"]],
  );
});
test("revoked admin removes all management data from the UI", async () => {
  const hass = fakeHass(),
    panel = await mount(hass);
  hass.user.is_admin = false;
  panel.hass = hass;
  assert.match(panel.shadowRoot.textContent, /Administrator access/);
  assert.doesNotMatch(panel.shadowRoot.textContent, /Example Appliance/);
  assert.equal(hass.unsubscribed.length, 4);
});
test("failed metadata refresh blocks deletion with a possibly stale dependency warning", async () => {
  const hass = fakeHass(),
    panel = await mount(hass);
  hass.callWS = async () => {
    throw Error("Network failed");
  };
  action(panel.shadowRoot, "Delete").click();
  await tick();
  assert.equal(panel.shadowRoot.querySelector(".overlay"), null);
  assert.match(panel.shadowRoot.textContent, /out of date/);
  assert.equal(hass.calls.filter((c) => c[0] === "DELETE").length, 0);
});

for (const [index, entryId, name] of [
  [0, "entry-physical", "Example Appliance"],
  [1, "entry-group", "Example Group"],
]) {
  test(`edit dialog deletes ${name} through shared confirmation and refreshes`, async () => {
    const hass = fakeHass(),
      panel = await mount(hass),
      root = panel.shadowRoot;
    const originalApi = hass.callApi;
    hass.callApi = async (...args) => {
      if (args[0] === "POST") {
        hass.calls.push(args);
        return userStep();
      }
      if (args[1] === `config/config_entries/entry/${entryId}`)
        hass.data.entries = hass.data.entries.filter(
          (e) => e.entry_id !== entryId,
        );
      return originalApi(...args);
    };
    action(root, "Edit", index).click();
    await tick();
    const edit = root.querySelector(".flow-box");
    const remove = button(edit, "Delete appliance");
    assert(remove);
    assert.equal(remove.parentElement.className, "danger-actions");
    assert.equal(edit.lastElementChild, remove.parentElement);
    assert(button(edit, "Continue"));
    assert(button(edit, "Close"));
    remove.click();
    await tick();
    const confirmation = root.querySelector(".overlay");
    assert.match(confirmation.textContent, new RegExp(`Remove ${name}\\?`));
    assert.match(
      confirmation.textContent,
      /virtual sensors and associated Appliance Meter accounting state/,
    );
    assert.match(
      confirmation.textContent,
      /does not delete the physical ESPHome\/Shelly device/,
    );
    if (index === 0)
      assert.match(
        confirmation.textContent,
        /Affected Custom Totals: Example Group/,
      );
    assert.equal(
      hass.calls.filter(
        (c) => c[1] === `config/config_entries/entry/${entryId}`,
      ).length,
      0,
    );
    const refreshes = hass.calls.filter(
      (c) => c[0] === "WS" && c[1]?.type === "appliance_meter/management",
    ).length;
    button(confirmation, "Remove").click();
    await tick();
    assert.equal(root.querySelector(".overlay"), null);
    assert.equal(
      hass.calls.filter(
        (c) => c[0] === "WS" && c[1]?.type === "appliance_meter/management",
      ).length,
      refreshes + 1,
    );
    assert.equal(
      [...root.querySelectorAll("tbody td:first-child")].some(
        (el) => el.textContent === name,
      ),
      false,
    );
    assert.deepEqual(
      hass.calls.filter(
        (c) => c[1] === `config/config_entries/entry/${entryId}`,
      ),
      [["DELETE", `config/config_entries/entry/${entryId}`]],
    );
  });
}

for (const failure of ["throw", "negative-response"]) {
  test(`deletion failure (${failure}) stays visible in the dialog and permits retry`, async () => {
    const hass = fakeHass(),
      panel = await mount(hass),
      root = panel.shadowRoot;
    hass.callApi = async (method, path) => {
      if (method === "POST") return userStep();
      if (path.startsWith("config/config_entries/entry/")) {
        if (failure === "throw") throw Error("Network failed");
        return { success: false };
      }
      return {};
    };
    action(root, "Edit").click();
    await tick();
    button(root.querySelector(".overlay"), "Delete appliance").click();
    await tick();
    const dialog = root.querySelector(".overlay");
    button(dialog, "Remove").click();
    assert.equal(button(dialog, "Remove").disabled, true);
    dialog.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    assert.equal(root.querySelector(".overlay"), dialog);
    await tick();
    assert.equal(root.querySelector(".overlay"), dialog);
    assert.match(
      dialog.querySelector('[role="alert"]').textContent,
      /Removal was not confirmed/,
    );
    assert.equal(button(dialog, "Remove").disabled, false);
    assert.equal(button(dialog, "Cancel").disabled, false);
    assert.match(root.querySelector("main").textContent, /Example Appliance/);
  });
}

test("add dialog has no delete action and failed dependency refresh keeps edit open", async () => {
  const hass = fakeHass(),
    panel = await mount(hass),
    root = panel.shadowRoot;

  button(root, "Create Appliance").click();
  await tick();
  assert.equal(
    button(root.querySelector(".overlay"), "Delete appliance"),
    undefined,
  );
  button(root.querySelector(".overlay"), "Close").click();
  await tick();
  hass.callApi = async () => userStep();
  action(root, "Edit").click();
  await tick();
  const edit = root.querySelector(".flow-box");
  hass.callWS = async () => {
    throw Error("Network failed");
  };
  button(edit, "Delete appliance").click();
  await tick();
  assert.equal(root.querySelector(".flow-box"), edit);
  assert.match(edit.querySelector('[role="alert"]').textContent, /out of date/);
});

function change(root, selector, value, event = "change") {
  const input = root.querySelector(selector);
  input.value = value;
  input.dispatchEvent(new Event(event));
  return input;
}
const rowNames = (root) =>
  [...root.querySelectorAll("tbody tr")].map((row) => row.cells[0].textContent);
function availableAssignments(hass) {
  for (const id of ["sensor.power", "sensor.energy", "sensor.price"])
    hass.states[id] = { state: "0", attributes: {} };
}

test("list searches friendly meter and member names, filters and sorts both directions", async () => {
  const hass = fakeHass();
  availableAssignments(hass);
  const panel = await mount(hass),
    root = panel.shadowRoot;
  assert.deepEqual(rowNames(root), ["Example Appliance", "Example Group"]);
  root.querySelector('[data-sort="name"]').click();
  assert.deepEqual(rowNames(root), ["Example Group", "Example Appliance"]);
  assert.equal(
    root.querySelector("th").getAttribute("aria-sort"),
    "descending",
  );
  assert.equal(
    root.querySelector('[aria-label="Sort appliances"]').value,
    "name:-1",
  );
  change(root, '[aria-label="Sort appliances"]', "name:1");
  assert.deepEqual(rowNames(root), ["Example Appliance", "Example Group"]);
  const search = change(
    root,
    '[aria-label="Search appliances"]',
    "ATHOM",
    "input",
  );
  assert.deepEqual(rowNames(root), ["Example Appliance"]);
  assert.equal(root.querySelector('[aria-label="Search appliances"]'), search);
  change(root, '[aria-label="Search appliances"]', "Example Appliance", "input");
  assert.deepEqual(rowNames(root), ["Example Appliance", "Example Group"]);
  change(root, '[aria-label="Filter by appliance type"]', "aggregate");
  assert.deepEqual(rowNames(root), ["Example Group"]);
  change(root, '[aria-label="Filter by status"]', "Not loaded");
  assert.deepEqual(rowNames(root), []);
  assert.match(
    root.querySelector(".table-host").textContent,
    /No appliances match/,
  );
  assert.equal(
    hass.calls.filter(
      (call) =>
        call[0] === "WS" && call[1]?.type === "appliance_meter/management",
    ).length,
    1,
  );
});

test("status filters distinguish missing assignments, unavailable sources, problems and unloaded entries", async () => {
  const hass = fakeHass();
  availableAssignments(hass);
  const panel = await mount(hass),
    root = panel.shadowRoot;
  change(root, '[aria-label="Filter by status"]', "Ready");
  assert.equal(rowNames(root).length, 2);
  hass.data.entries[0].assignments.price_sensor = null;
  await panel.refresh();
  change(root, '[aria-label="Filter by status"]', "Missing assignments");
  assert.deepEqual(rowNames(root), ["Example Appliance"]);
  change(root, '[aria-label="Filter by status"]', "Configuration problem");
  assert.deepEqual(rowNames(root), ["Example Group"]);
  hass.states["sensor.power"].state = "unavailable";
  panel.hass = hass;
  change(root, '[aria-label="Filter by status"]', "Unavailable");
  assert.deepEqual(rowNames(root), ["Example Appliance"]);
  hass.data.entries[0].state = "setup_error";
  await panel.refresh();
  change(root, '[aria-label="Filter by status"]', "Not loaded");
  assert.deepEqual(rowNames(root), ["Example Appliance"]);
});

test("table provides mobile field labels and all row actions, and escapes friendly names", async () => {
  const hass = fakeHass();
  hass.data.entries[0].name = '<img src=x onerror="bad()">';
  const panel = await mount(hass),
    root = panel.shadowRoot;
  assert.equal(root.querySelector("img"), null);
  const row = root.querySelector("tbody tr");
  assert.deepEqual(
    [...row.cells].map((cell) => cell.getAttribute("data-label")),
    ["Appliance", "Meter", "kWh Day", "kWh month", "Cost Day", "Cost month", "Cost year", "Actions"],
  );
  for (const label of ["Open details", "Edit", "Delete"])
    assert(button(row, label));
  assert.equal(row.querySelectorAll(".menu-trigger").length, 1);
  assert.equal(row.querySelector('[role="menu"]').hidden, true);
  assert(root.querySelector('[aria-label="Sort appliances"]'));
  assert.match(
    root.querySelector("style").textContent,
    /@media\(max-width:700px\)/,
  );
  action(row, "Open").click();
  assert.doesNotMatch(
    root.querySelector(".overlay").textContent,
    /Energy Total|Cost Total|12.5 W/,
  );
});

const key = (element, value) =>
  element.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: value,
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );

test("ellipsis menu has accessible state, keyboard navigation and focus return", async () => {
  const panel = await mount(fakeHass()),
    root = panel.shadowRoot;
  const trigger = root.querySelector(".menu-trigger");
  const menu = root.getElementById(trigger.getAttribute("aria-controls"));
  assert.equal(trigger.tagName, "BUTTON");
  assert.equal(trigger.getAttribute("aria-label"), "Actions for Example Appliance");
  assert.equal(trigger.getAttribute("aria-haspopup"), "menu");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(menu.hidden, true);
  assert.equal(menu.getAttribute("role"), "menu");
  assert.deepEqual(
    [...menu.children].map((item) => item.textContent),
    ["Open details", "Edit", "Delete"],
  );
  for (const item of menu.children) {
    assert.equal(item.tagName, "BUTTON");
    assert.equal(item.getAttribute("role"), "menuitem");
    assert.equal(item.tabIndex, -1);
  }
  trigger.focus();
  key(trigger, "ArrowDown");
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(root.activeElement, menu.children[0]);
  key(root.activeElement, "ArrowUp");
  assert.equal(root.activeElement, menu.children[2]);
  key(root.activeElement, "ArrowDown");
  assert.equal(root.activeElement, menu.children[0]);
  key(root.activeElement, "End");
  assert.equal(root.activeElement, menu.children[2]);
  key(root.activeElement, "Home");
  assert.equal(root.activeElement, menu.children[0]);
  key(root.activeElement, "Escape");
  assert.equal(menu.hidden, true);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(root.activeElement, trigger);
  key(trigger, "ArrowUp");
  assert.equal(root.activeElement, menu.children[2]);
  key(root.activeElement, "Tab");
  assert.equal(menu.hidden, true);
  assert.equal(root.activeElement, trigger);
});

test("mouse and touch menus toggle, dismiss outside shadow DOM, and allow only one menu", async () => {
  const panel = await mount(fakeHass()),
    root = panel.shadowRoot;
  const [first, second] = root.querySelectorAll(".menu-trigger");
  const firstMenu = root.getElementById(first.getAttribute("aria-controls"));
  const secondMenu = root.getElementById(second.getAttribute("aria-controls"));
  first.click();
  assert.equal(firstMenu.hidden, false);
  firstMenu.dispatchEvent(
    new window.PointerEvent("pointerdown", {
      bubbles: true,
      composed: true,
      pointerType: "touch",
    }),
  );
  assert.equal(
    firstMenu.hidden,
    false,
    "inside touch must not dismiss the menu before activation",
  );
  first.click();
  assert.equal(firstMenu.hidden, true);
  first.click();
  second.click();
  assert.equal(firstMenu.hidden, true);
  assert.equal(secondMenu.hidden, false);
  document.body.dispatchEvent(
    new window.PointerEvent("pointerdown", {
      bubbles: true,
      composed: true,
      pointerType: "touch",
    }),
  );
  assert.equal(secondMenu.hidden, true);
  first.click();
  root.querySelector("h1").click();
  assert.equal(
    firstMenu.hidden,
    true,
    "outside clicks inside the shadow root dismiss",
  );
  first.click();
  const external = document.createElement("button");
  document.body.append(external);
  external.click();
  assert.equal(
    firstMenu.hidden,
    true,
    "outside clicks in the document dismiss",
  );
  first.click();
  external.focus();
  assert.equal(firstMenu.hidden, true, "focus leaving the menu dismisses it");
});

test("appliance name and Open details menu item open the same details dialog", async () => {
  const hass = fakeHass(),
    panel = await mount(hass),
    root = panel.shadowRoot;
  const row = root.querySelector("tbody tr");
  const name = row.querySelector(".appliance-name");
  assert.equal(name.textContent, "Example Appliance");
  assert.equal(name.getAttribute("aria-haspopup"), "dialog");
  name.focus();
  name.click();
  assert.match(
    root.querySelector(".overlay").textContent,
    /Example Appliance.*Athom meter/s,
  );
  button(root.querySelector(".overlay"), "Close").click();
  assert.equal(root.activeElement, name);
  action(row, "Open").click();
  assert.equal(row.querySelector('[role="menu"]').hidden, true);
  button(root.querySelector(".overlay"), "Close").click();
  assert(root.activeElement === row.querySelector(".menu-trigger"));
  assert.equal(hass.calls.filter((call) => call[0] === "POST").length, 0);
});

test("table refresh, filtering, navigation and disconnect clean up open menus", async () => {
  const hass = fakeHass(),
    panel = await mount(hass),
    root = panel.shadowRoot;
  root.querySelector(".menu-trigger").click();
  const first = panel._actionMenu;
  change(root, '[aria-label="Search appliances"]', "router", "input");
  assert.equal(panel._actionMenu, null);
  assert.equal(first.menu.hidden, true);
  change(root, '[aria-label="Search appliances"]', "", "input");
  root.querySelector(".menu-trigger").click();
  hass.data.entries[0].name = "Updated name";
  await panel.refresh();
  assert.equal(panel._actionMenu, null);
  assert.equal(root.querySelectorAll('[aria-expanded="true"]').length, 0);
  root.querySelector(".menu-trigger").click();
  panel.selectView("card");
  assert.equal(panel._actionMenu, null);
  panel.selectView("list");
  root.querySelector(".menu-trigger").click();
  const last = panel._actionMenu;
  panel.remove();
  assert.equal(panel._actionMenu, null);
  assert.equal(last.menu.hidden, true);
  // An outside event after teardown must not invoke a lingering document listener.
  panel.closeActionMenu = () =>
    assert.fail("Outside listener survived disconnect");
  document.body.click();
  document.body.dispatchEvent(
    new window.PointerEvent("pointerdown", { bubbles: true, composed: true }),
  );
});

test("Delete menu action retains confirmation and visible API failures", async () => {
  const hass = fakeHass(),
    panel = await mount(hass),
    root = panel.shadowRoot;
  hass.callApi = async (...args) => {
    hass.calls.push(args);
    throw Error("Delete failed");
  };
  action(root, "Delete").click();
  await tick();
  const dialog = root.querySelector(".overlay");
  assert.match(dialog.textContent, /Remove Example Appliance/);
  assert.match(dialog.textContent, /Example Group/);
  assert.match(dialog.textContent, /accounting state/);
  assert.equal(hass.calls.filter((call) => call[0] === "DELETE").length, 0);
  button(dialog, "Remove").click();
  await tick();
  assert.equal(root.querySelector(".overlay"), dialog);
  assert.match(
    dialog.querySelector('[role="alert"]').textContent,
    /Removal was not confirmed/,
  );
  assert.equal(button(dialog, "Remove").disabled, false);
  assert.equal(root.querySelectorAll("tbody tr").length, 2);
});

for (const operation of ["Add", "Edit"]) {
  test(`successful ${operation} automatically updates the list and configuration status`, async () => {
    const hass = fakeHass();
    availableAssignments(hass);
    const panel = await mount(hass),
      root = panel.shadowRoot;
    const name = `${operation} result`;
    hass.callApi = async (...args) => {
      hass.calls.push(args);
      if (args[0] === "POST" && args[1].endsWith("/flow")) return userStep();
      if (args[0] === "POST") {
        if (operation === "Add") {
          const entry = structuredClone(hass.data.entries[0]);
          Object.assign(entry, {
            entry_id: "new-entry",
            name,
            affected_totals: [],
          });
          hass.data.entries.push(entry);
        } else {
          hass.data.entries[0].name = name;
          hass.data.entries[0].assignments.price_sensor = null;
        }
        return { type: "create_entry" };
      }
      return {};
    };
    if (operation === "Add") {
      button(root, "Create Appliance").click();
    } else action(root, "Edit").click();
    await tick();
    const requests = hass.calls.filter(
      (call) =>
        call[0] === "WS" && call[1]?.type === "appliance_meter/management",
    ).length;
    root
      .querySelector(".overlay form")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    assert.equal(root.querySelector(".overlay"), null);
    assert.equal(
      hass.calls.filter(
        (call) =>
          call[0] === "WS" && call[1]?.type === "appliance_meter/management",
      ).length,
      requests + 1,
    );
    if (operation === "Add") panel.selectView("list");
    const row = [...root.querySelectorAll("tbody tr")].find(
      (row) => row.cells[0].textContent === name,
    );
    assert(row);
    assert.equal(
      panel.configuration(hass.data.entries.find((e) => e.name === name))
        .status,
      operation === "Add" ? "Ready" : "Missing assignments",
    );
    assert.equal(
      root.querySelectorAll("tbody tr").length,
      operation === "Add" ? 3 : 2,
    );
  });
}

test("successful Delete updates the list and dependent Custom status without user refresh", async () => {
  const hass = fakeHass();
  availableAssignments(hass);
  const panel = await mount(hass),
    root = panel.shadowRoot;
  assert.equal(panel.configuration(hass.data.entries[1]).status, "Ready");
  hass.callApi = async (method, path) => {
    hass.calls.push([method, path]);
    if (path === "config/config_entries/entry/entry-physical") {
      hass.data.entries = hass.data.entries.filter(
        (entry) => entry.entry_id !== "entry-physical",
      );
      return { require_restart: false };
    }
    throw Error("Unexpected API request");
  };
  action(root, "Delete").click();
  await tick();
  button(root.querySelector(".overlay"), "Remove").click();
  await tick();
  assert.deepEqual(rowNames(root), ["Example Group"]);
  assert.equal(
    panel.configuration(hass.data.entries[0]).status,
    "Configuration problem",
  );
  assert.equal(root.querySelector(".overlay"), null);
});

test("external entry creation, removal and status changes refresh immediately from HA events", async () => {
  const hass = fakeHass();
  availableAssignments(hass);
  const panel = await mount(hass),
    root = panel.shadowRoot;
  const added = {
    ...structuredClone(hass.data.entries[0]),
    entry_id: "external",
    name: "External appliance",
  };
  hass.data.entries.push(added);
  const requests = hass.calls.filter(
    (call) =>
      call[0] === "WS" && call[1]?.type === "appliance_meter/management",
  ).length;
  hass.messages[0]([{ type: "added", entry: { domain: "appliance_meter" } }]);
  assert.equal(
    hass.calls.filter(
      (call) =>
        call[0] === "WS" && call[1]?.type === "appliance_meter/management",
    ).length,
    requests + 1,
    "event requests metadata immediately without a debounce timer",
  );
  await tick();
  assert(rowNames(root).includes("External appliance"));
  hass.data.entries[0].state = "setup_error";
  hass.messages[0]([{ type: "updated", entry: { domain: "appliance_meter" } }]);
  await tick();
  assert.equal(panel.configuration(hass.data.entries[0]).status, "Not loaded");
  hass.data.entries = hass.data.entries.filter(
    (entry) => entry.entry_id !== "external",
  );
  hass.messages[0]([{ type: "removed", entry: { domain: "appliance_meter" } }]);
  await tick();
  assert(!rowNames(root).includes("External appliance"));
  const after = hass.calls.length;
  hass.messages[0]([{ type: "updated", entry: { domain: "other_domain" } }]);
  assert(hass.calls.length >= after);
});

test("registry event bursts coalesce during a request and still fetch the final metadata", async () => {
  const hass = fakeHass(),
    panel = await mount(hass),
    root = panel.shadowRoot;
  const stale = structuredClone(hass.data);
  let resolve;
  hass.callWS = async (message) => {
    hass.calls.push(["WS", message]);
    if (!resolve)
      return await new Promise((done) => {
        resolve = done;
      });
    return structuredClone(hass.data);
  };
  const requests = hass.calls.filter(
    (call) =>
      call[0] === "WS" && call[1]?.type === "appliance_meter/management",
  ).length;
  hass.events.entity_registry_updated({});
  hass.events.device_registry_updated({});
  hass.messages[0]([{ type: "updated", entry: { domain: "appliance_meter" } }]);
  hass.data.entries[0].name = "Latest metadata";
  assert.equal(
    hass.calls.filter(
      (call) =>
        call[0] === "WS" && call[1]?.type === "appliance_meter/management",
    ).length,
    requests + 1,
  );
  resolve(stale);
  await tick();
  assert.equal(
    hass.calls.filter(
      (call) =>
        call[0] === "WS" && call[1]?.type === "appliance_meter/management",
    ).length,
    requests + 2,
  );
  assert(rowNames(root).includes("Latest metadata"));
  const after = hass.calls.length;
  hass.states["sensor.power"] = { state: "unavailable", attributes: {} };
  panel.hass = hass;
  assert.equal(
    hass.calls.length,
    after,
    "state availability updates need no metadata request",
  );
  assert.equal(panel.configuration(hass.data.entries[0]).status, "Unavailable");
});

test("one ESPHome-style toolbar, exact list columns, real meter names and direct creation", async () => {
  const hass = fakeHass(),
    panel = await mount(hass),
    root = panel.shadowRoot;
  assert.equal(root.querySelectorAll(".toolbar").length, 1);
  assert.equal(root.querySelector("nav"), null);
  assert.equal(
    root.querySelector('[data-view="list"]').getAttribute("aria-pressed"),
    "true",
  );
  assert.deepEqual(
    [...root.querySelectorAll("th")].map((th) =>
      th.textContent.replace(/ [↑↓]$/, ""),
    ),
    ["Appliance", "Meter", "kWh Day", "kWh month", "Cost Day", "Cost month", "Cost year", "Actions"],
  );
  assert.equal(
    root.querySelector("tbody tr").cells[1].textContent,
    "Athom meter",
  );
  assert.equal(
    root.querySelectorAll("tbody tr")[1].cells[1].textContent,
    "Custom Total",
  );
  const controls = [
    root.querySelector(".search"),
    root.querySelector(".view-toggle"),
    root.querySelector(".filter-holder"),
    root.querySelector(".create"),
  ];
  for (let i = 0; i < controls.length - 1; i++)
    assert(
      controls[i].compareDocumentPosition(controls[i + 1]) &
        window.Node.DOCUMENT_POSITION_FOLLOWING,
    );
  assert.equal(button(root, "Refresh"), undefined);
  assert.equal(button(root, "New"), undefined);
  assert.match(root.querySelector("style").textContent, /margin-left:auto/);
  button(root, "Create Appliance").click();
  await tick();
  assert.deepEqual(
    hass.calls.find((c) => c[0] === "POST"),
    ["POST", "config/config_entries/flow", { handler: "appliance_meter" }],
  );
});

test("view defaults to List and remembers only valid local choices across mounts", async () => {
  const first = await mount(fakeHass());
  assert.equal(first._view, "list");
  first.shadowRoot.querySelector('[data-view="card"]').click();
  assert.equal(window.localStorage.getItem("appliance_meter.view.v1"), "card");
  assert.equal(first.shadowRoot.querySelectorAll(".appliance-card").length, 2);
  first.remove();
  const restored = await mount(fakeHass());
  assert.equal(restored._view, "card");
  assert.equal(restored.shadowRoot.querySelector("table"), null);
  restored.shadowRoot.querySelector('[data-view="list"]').click();
  restored.remove();
  assert.equal((await mount(fakeHass()))._view, "list");
  window.localStorage.setItem("appliance_meter.view.v1", "not-a-view");
  assert.equal((await mount(fakeHass()))._view, "list");
});

test("both views share search, type/status filters, meter sorting and one data pipeline", async () => {
  const hass = fakeHass(),
    panel = await mount(hass),
    root = panel.shadowRoot,
    requests = hass.calls.length;
  const names = () =>
    [...root.querySelectorAll(".appliance-name")].map((e) => e.textContent);
  change(root, '[aria-label="Search appliances"]', "appliance", "input");
  change(root, '[aria-label="Sort appliances"]', "meter:-1");
  panel.selectView("card");
  assert.equal(root.querySelectorAll(".appliance-card").length, 2);
  change(root, '[aria-label="Filter by appliance type"]', "aggregate");
  assert.deepEqual(names(), ["Example Group"]);
  assert.match(
    root.querySelector(".appliance-card").textContent,
    /Custom Total/,
  );
  panel.selectView("list");
  assert.deepEqual(rowNames(root), ["Example Group"]);
  assert.equal(
    root.querySelector('[aria-label="Search appliances"]').value,
    "appliance",
  );
  assert.equal(
    root.querySelector('[aria-label="Sort appliances"]').value,
    "meter:-1",
  );
  assert.equal(
    root.querySelector('[aria-label="Filter by appliance type"]').value,
    "aggregate",
  );
  assert.equal(hass.calls.length, requests);
  assert.equal(root.querySelectorAll("canvas,ha-chart-base,nav").length, 0);
});

test("card names and menus reuse existing details, Edit and Delete confirmations", async () => {
  const hass = fakeHass(),
    panel = await mount(hass),
    root = panel.shadowRoot;
  panel.selectView("card");
  const first = root.querySelector(".appliance-card");
  first.querySelector(".appliance-name").click();
  assert.match(
    root.querySelector(".detail-summary").textContent,
    /Athom meter/,
  );
  button(root.querySelector(".overlay"), "Close").click();
  first.querySelector(".menu-trigger").click();
  button(first.querySelector('[role="menu"]'), "Edit").click();
  await tick();
  assert.deepEqual(
    hass.calls.find((c) => c[0] === "POST"),
    [
      "POST",
      "config/config_entries/options/flow",
      { handler: "entry-physical" },
    ],
  );
  button(root.querySelector(".overlay"), "Close").click();
  await tick();
  root.querySelector(".appliance-card .menu-trigger").click();
  button(root.querySelector('.appliance-card [role="menu"]'), "Delete").click();
  await tick();
  assert.match(
    root.querySelector(".overlay").textContent,
    /Affected Custom Totals: Example Group/,
  );
  assert.equal(
    hass.calls.filter((c) => c[0] === "DELETE" && c[1].includes("/entry/"))
      .length,
    0,
  );
});

test("filter popover closes on Escape/outside and open drafts survive view/history updates", async () => {
  const hass = fakeHass(),
    panel = await mount(hass),
    root = panel.shadowRoot;
  root.querySelector(".filter-trigger").click();
  assert.equal(root.querySelector(".filters").hidden, false);
  key(root.querySelector(".filters"), "Escape");
  assert.equal(root.querySelector(".filters").hidden, true);
  root.querySelector(".filter-trigger").click();
  document.body.dispatchEvent(
    new window.PointerEvent("pointerdown", { bubbles: true, composed: true }),
  );
  assert.equal(root.querySelector(".filters").hidden, true);
  action(root, "Edit").click();
  await tick();
  const draft = root.querySelector("#field-name");
  draft.value = "Keep this draft";
  draft.dispatchEvent(new Event("input"));
  panel.selectView("card");
  await panel.refresh(false);
  assert.equal(root.querySelector("#field-name"), draft);
  assert.equal(draft.value, "Keep this draft");
});

test("appliance details load actual cost diagnostics and refresh only on energy changes", async () => {
  const hass = fakeHass(), callWS = hass.callWS;
  let requests = 0;
  hass.callWS = async (message) => {
    if (message.type !== 'appliance_meter/cost_debug') return callWS(message);
    requests++;
    assert.equal(message.entry_id, 'entry-physical');
    return { available: true, calculations: [{ timestamp: '2026-10-29T12:00:00Z', energy_delta: '0.01', price: requests === 1 ? '2' : '3', cost_increment: requests === 1 ? '0.02' : '0.03' }] };
  };
  const panel = await mount(hass), root = panel.shadowRoot;
  panel.showDetails('entry-physical');
  await tick();
  const debug = root.querySelector('.cost-debug');
  assert.match(debug.textContent, /0,0100 kWh × 2,0000 DKK\/kWh = 0,0200 DKK/);
  debug.querySelector('details').open = true;
  panel.hass = hass;
  assert.equal(requests, 1);
  hass.states['sensor.logical_energy'] = { ...hass.states['sensor.logical_energy'], state: '3.51' };
  panel.hass = hass;
  await tick();
  assert.equal(root.querySelector('.cost-debug'), debug);
  assert.match(debug.textContent, /0,0300 DKK/);
  assert.equal(debug.querySelector('details').open, true);
  assert.equal(requests, 2);
  panel.showDetails('entry-group');
  assert.match(root.querySelector('.cost-debug').textContent, /open a member/);
  assert.equal(requests, 2);
});
