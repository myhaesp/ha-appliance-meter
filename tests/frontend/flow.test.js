import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { userStep, sensorsStep, aggregateStep, metadata } from "./fixtures.js";
const window = new Window();
for (const key of [
  "document",
  "HTMLElement",
  "customElements",
  "Event",
  "KeyboardEvent",
])
  globalThis[key] = window[key];
const {
  checkSchema,
  formValues,
  submission,
  fieldOptions,
  renderFields,
  FlowSession,
  FlowView,
  UnsupportedSchema,
} = await import("../../custom_components/appliance_meter/frontend/flow.js");
beforeEach(() => document.body.replaceChildren());
const apiQueue = (responses) => {
  const calls = [];
  return {
    calls,
    callApi: async (...args) => {
      calls.push(args);
      if (!responses.length) throw Error("Unexpected call");
      const result = responses.shift();
      if (result instanceof Error) throw result;
      return structuredClone(result);
    },
  };
};

test("current field types render with defaults and friendly member labels", () => {
  const step = userStep(),
    values = formValues(step);
  assert.equal(values.appliance_type, "physical");
  assert.equal(values.price_sensor, "sensor.price");
  const host = document.createElement("form");
  host.append(
    renderFields(
      step.data_schema,
      values,
      metadata(),
      {},
      (key, value) => (values[key] = value),
    ),
  );
  document.body.append(host);
  assert.equal(host.querySelectorAll("select").length, 2);
  assert.equal(host.querySelector('[role="combobox"]').id, "field-device_id");
  host.querySelector(".device-picker").show();
  assert.match(host.textContent, /Athom meter/);
  const input = host.querySelector("input");
  input.value = "IT";
  input.dispatchEvent(new Event("input"));
  assert.equal(values.name, "IT");
  const total = document.createElement("div");
  const selected = { members: [] };
  total.append(
    renderFields(
      aggregateStep().data_schema,
      selected,
      metadata(),
      {},
      (key, value) => (selected[key] = value),
    ),
  );
  assert.match(total.textContent, /Example Appliance/);
  assert.doesNotMatch(total.textContent, /entry-physical/);
  const checkbox = total.querySelector("input[type=checkbox]");
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event("change"));
  assert.deepEqual(selected.members, ["entry-physical"]);
});
test("entity candidates respect domain, class, include and exclusion filters", () => {
  const field = sensorsStep().data_schema[0];
  assert.deepEqual(
    fieldOptions(field, metadata()).map((o) => o.value),
    ["sensor.power"],
  );
  assert(
    !fieldOptions(userStep().data_schema[3], metadata()).some(
      (o) => o.value === "sensor.logical",
    ),
  );
});
test("cleared suggested optional values stay cleared on validation and submission", () => {
  const step = sensorsStep();
  const values = formValues(step, {
    price_sensor: "",
    energy_sensor: "sensor.energy",
  });
  assert.equal(values.price_sensor, "");
  assert(!("price_sensor" in submission(step.data_schema, values)));
  assert.equal(
    submission(step.data_schema, values).energy_sensor,
    "sensor.energy",
  );
  assert.deepEqual(
    submission(aggregateStep().data_schema, { name: "IT", members: [] }),
    { name: "IT", members: [] },
  );
});
test("unavailable assigned sensor is displayed and preserved, never replaced", () => {
  const values = { energy_sensor: "sensor.old" };
  const host = document.createElement("div");
  host.append(
    renderFields(sensorsStep().data_schema, values, metadata(), {}, () => {}),
  );
  assert.match(host.textContent, /Unavailable sensor \(sensor.old\)/);
  assert.equal(host.querySelector("#field-energy_sensor").value, "sensor.old");
});
test("HTML from names is rendered as text", () => {
  const data = metadata();
  data.devices[0].label = '<img src=x onerror="bad()">';
  const host = document.createElement("div");
  host.append(renderFields(userStep().data_schema, {}, data, {}, () => {}));
  host.querySelector(".device-picker").show();
  assert.equal(host.querySelector("img"), null);
  assert.match(host.textContent, /<img/);
});
test("unsupported field, selector semantics and partial forms fail closed", () => {
  for (const field of [
    { name: "password", selector: { text: {} } },
    { name: "name", selector: { text: { multiline: true } } },
    {
      name: "price_sensor",
      selector: { entity: { filter: [{ integration: "esphome" }] } },
    },
    { name: "device_id", selector: { device: { multiple: true } } },
    {
      name: "members",
      selector: { select: { options: [], multiple: true, custom_value: true } },
    },
  ])
    assert.throws(
      () => checkSchema([...userStep().data_schema, field]),
      UnsupportedSchema,
    );
});
test("multi-step creation preserves backend errors and submits only via flow API", async () => {
  const hass = apiQueue([
    userStep(),
    sensorsStep(),
    sensorsStep({ energy_sensor: "energy_in_use" }),
    { type: "create_entry" },
  ]);
  let completed = 0;
  const session = new FlowSession(
    hass,
    metadata(),
    () => {},
    () => completed++,
  );
  await session.start();
  session.values.name = "Server";
  await session.submit();
  assert.equal(session.step.step_id, "sensors");
  assert.equal(session.values.power_sensor, "sensor.power");
  session.values.energy_sensor = "sensor.energy";
  session.values.price_sensor = "";
  await session.submit();
  assert.deepEqual(session.step.errors, { energy_sensor: "energy_in_use" });
  assert.equal(session.values.energy_sensor, "sensor.energy");
  assert.equal(session.values.price_sensor, "");
  await session.submit();
  assert.equal(completed, 1);
  assert.deepEqual(hass.calls[0], [
    "POST",
    "config/config_entries/flow",
    { handler: "appliance_meter" },
  ]);
  assert(!("price_sensor" in hass.calls[2][2]));
});
test("options target existing entry and default assignments can be cleared", async () => {
  const step = sensorsStep();
  step.step_id = "init";
  const hass = apiQueue([step, { type: "create_entry" }]);
  const session = new FlowSession(
    hass,
    metadata(),
    () => {},
    () => {},
  );
  await session.start("entry-physical");
  session.values.power_sensor = "";
  await session.submit();
  assert.deepEqual(hass.calls[0], [
    "POST",
    "config/config_entries/options/flow",
    { handler: "entry-physical" },
  ]);
  assert(!("power_sensor" in hass.calls[1][2]));
});
test("Back cancels then reopens initial form, without replay or creation", async () => {
  const hass = apiQueue([
    userStep(),
    sensorsStep(),
    {},
    userStep("replacement"),
    sensorsStep({}, "replacement"),
  ]);
  const session = new FlowSession(
    hass,
    metadata(),
    () => {},
    () => {
      throw Error("Must not create");
    },
  );
  await session.start();
  session.values.name = "Server";
  await session.submit();
  session.values.energy_sensor = "sensor.energy";
  await session.back();
  assert.equal(session.step.step_id, "user");
  assert.equal(session.values.name, "Server");
  assert.deepEqual(hass.calls.slice(2), [
    ["DELETE", "config/config_entries/flow/new"],
    ["POST", "config/config_entries/flow", { handler: "appliance_meter" }],
  ]);
  await session.submit();
  assert.equal(session.values.energy_sensor, "sensor.energy");
});
test("Back invalidates sensor drafts when device or name changes", async () => {
  const hass = apiQueue([
    userStep(),
    sensorsStep(),
    {},
    userStep("replacement"),
    sensorsStep({}, "replacement"),
  ]);
  const session = new FlowSession(
    hass,
    metadata(),
    () => {},
    () => {},
  );
  await session.start();
  session.values.name = "Server";
  await session.submit();
  session.values.energy_sensor = "sensor.energy";
  await session.back();
  session.values.device_id = "other";
  await session.submit();
  assert.equal(session.values.energy_sensor, undefined);
});
test("unknown schemas and step types cancel flow and expose explicit fallback", async () => {
  for (const result of [
    {
      ...userStep(),
      data_schema: [{ name: "name", selector: { unknown: {} } }],
    },
    { type: "menu", flow_id: "new" },
  ]) {
    const hass = apiQueue([result, {}]);
    const view = new FlowView(
      hass,
      metadata(),
      () => {},
      () => {},
    );
    document.body.append(view.element);
    await view.start();
    assert.match(view.element.textContent, /does not support/);
    assert.equal(view.element.querySelector("a"), null);
    assert.match(view.element.textContent, /Home Assistant Helpers/);
    assert.equal(view.element.querySelector(".flow-actions button").textContent, "Close");
    assert.equal(view.element.querySelector("form"), null);
    assert.equal(hass.calls.at(-1)[0], "DELETE");
  }
});
test("field validation errors render accessibly and retain selected values", async () => {
  const hass = apiQueue([
    userStep(),
    sensorsStep({ energy_sensor: "energy_in_use" }),
  ]);
  const view = new FlowView(
    hass,
    metadata(),
    () => {},
    () => {},
  );
  document.body.append(view.element);
  await view.start();
  view.session.values.name = "Server";
  await view.session.submit();
  assert.match(view.element.textContent, /already assigned/);
  assert.equal(
    view.element
      .querySelector("#field-energy_sensor")
      .getAttribute("aria-invalid"),
    "true",
  );
});
test("transport errors preserve form and cancelling never submits", async () => {
  const hass = apiQueue([userStep(), Error("network"), {}]);
  const session = new FlowSession(
    hass,
    metadata(),
    () => {},
    () => {},
  );
  await session.start();
  session.values.name = "Server";
  await session.submit();
  assert.equal(session.values.name, "Server");
  assert.match(session.error, /not been confirmed/);
  await session.close();
  assert.deepEqual(hass.calls.at(-1), [
    "DELETE",
    "config/config_entries/flow/new",
  ]);
});

test("closing while initial request is in flight cancels its eventual response", async () => {
  let resolve;
  const calls = [];
  const hass = {
    callApi: async (...args) => {
      calls.push(args);
      if (args[0] === "POST") return await new Promise((r) => (resolve = r));
      return {};
    },
  };
  const session = new FlowSession(
    hass,
    metadata(),
    () => {},
    () => assert.fail("Unexpected completion"),
  );
  const pending = session.start();
  await session.close();
  resolve(userStep());
  await pending;
  assert.deepEqual(calls, [
    ["POST", "config/config_entries/flow", { handler: "appliance_meter" }],
    ["DELETE", "config/config_entries/flow/new"],
  ]);
});

test("unknown validation fields do not disappear from a partially supported form", async () => {
  const hass = apiQueue([
    { ...userStep(), errors: { future_field: "new_error" } },
    {},
  ]);
  const session = new FlowSession(
    hass,
    metadata(),
    () => {},
    () => {},
  );
  await session.start();
  assert(session.unsupported);
  assert.equal(hass.calls.at(-1)[0], "DELETE");
});

test("untouched required fields reach the backend as empty values for validation", async () => {
  const hass = apiQueue([
    userStep(),
    { ...userStep(), errors: { name: "blank_name" } },
  ]);
  const session = new FlowSession(
    hass,
    metadata(),
    () => {},
    () => {},
  );
  await session.start();
  await session.submit();
  assert.equal(hass.calls[1][2].name, "");
  assert.equal(session.step.errors.name, "blank_name");
  const values = formValues(aggregateStep());
  assert.deepEqual(values.members, []);
  assert.deepEqual(submission(aggregateStep().data_schema, values), {
    name: "IT",
    members: [],
  });
});

function flowButtons(view, back = false) {
  assert.equal(view.element.querySelector("a"), null);
  const row = view.element.querySelector("form .flow-actions");
  assert(row);
  assert.deepEqual([...row.children].map((button) => button.textContent), back ? ["Back", "Continue", "Close"] : ["Continue", "Close"]);
  assert.equal(row.querySelector('[type="submit"]').className, "primary");
  assert.equal(row.lastElementChild.type, "button");
  assert.equal(row.lastElementChild.classList.contains("primary"), false);
}

test("multi-step dialogs share primary Continue and secondary Close without Helpers links", async () => {
  const hass = apiQueue([userStep(), sensorsStep(), sensorsStep({ energy_sensor: "energy_in_use" }), {}, userStep("replacement"), {}]);
  let closed = 0;
  const view = new FlowView(hass, metadata(), () => assert.fail("Unexpected save"), () => closed++);
  document.body.append(view.element);
  await view.start();
  flowButtons(view);
  assert.equal(view.session.values.price_sensor, "sensor.price");
  view.session.values.name = "Server";
  const pending = view.session.submit();
  const busy = view.element.querySelector(".flow-actions");
  assert.equal(busy.querySelector('[type="submit"]').disabled, true);
  assert.equal(busy.lastElementChild.disabled, true);
  await pending;
  flowButtons(view, true);
  view.session.values.energy_sensor = "sensor.energy";
  await view.session.submit();
  flowButtons(view, true);
  assert.match(view.element.textContent, /already assigned/);
  assert.equal(view.session.values.energy_sensor, "sensor.energy");
  await view.session.back();
  flowButtons(view);
  assert.equal(view.session.values.name, "Server");
  view.element.querySelector(".flow-actions").lastElementChild.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(closed, 1);
  assert.equal(hass.calls.at(-1)[0], "DELETE");
});

test("physical and Custom Total edit dialogs retain defaults in the shared action row", async () => {
  for (const [entry, step] of [["entry-physical", sensorsStep()], ["entry-group", aggregateStep()]]) {
    step.step_id = "init";
    const hass = apiQueue([step]);
    const view = new FlowView(hass, metadata(), () => {}, () => {}, () => {});
    document.body.append(view.element);
    await view.start(entry);
    flowButtons(view);
    assert.equal(view.element.lastElementChild.className, "danger-actions");
    assert.deepEqual(hass.calls[0], ["POST", "config/config_entries/options/flow", { handler: entry }]);
    if (entry === "entry-group") assert.equal(view.session.values.name, "IT");
    else assert.equal(view.session.values.power_sensor, "sensor.power");
  }
});

function deviceSearch(picker, query) {
  picker.input.value = query;
  picker.input.dispatchEvent(new Event("input"));
  return [...picker.querySelectorAll('[role="option"] span')].map((label) => label.textContent);
}
function deviceKey(picker, value) {
  picker.input.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, composed: true, cancelable: true }));
}
function deviceForm(values = {}, data = metadata()) {
  const host = document.createElement("form");
  host.append(renderFields(userStep().data_schema, values, data, {}, (key, value) => { values[key] = value; }));
  document.body.append(host);
  return { host, picker: host.querySelector(".device-picker") };
}

test("device combobox sorts friendly names and searches names, entities and MAC suffixes", () => {
  const data = metadata();
  data.devices = [
    { value: "z", label: "Zulu", identifiers: ["00:11:22:AB:CD:EF"], entity_ids: ["sensor.old_server_power"] },
    { value: "a", label: "alpha", identifiers: ["00:11:22:33:44:55"], entity_ids: ["sensor.router_energy"] },
    { value: "b", label: "Beta", identifiers: ["meter-serial-987"], entity_ids: ["sensor.other_power"] },
  ];
  const values = {}, { picker } = deviceForm(values, data);
  picker.input.focus();
  assert.equal(picker.input.getAttribute("role"), "combobox");
  assert.equal(picker.input.getAttribute("aria-autocomplete"), "list");
  assert.deepEqual([...picker.list.querySelectorAll("span")].map((node) => node.textContent), ["No device selected", "alpha", "Beta", "Zulu"]);
  assert.deepEqual(deviceSearch(picker, "ALPHA"), ["alpha"]);
  assert.deepEqual(deviceSearch(picker, "OLD_SERVER"), ["Zulu"]);
  assert.deepEqual(deviceSearch(picker, "abcdef"), ["Zulu"]);
  assert.deepEqual(deviceSearch(picker, "AB:CD:EF"), ["Zulu"]);
  assert.deepEqual(deviceSearch(picker, "SERIAL-987"), ["Beta"]);
  assert.deepEqual(deviceSearch(picker, "does not exist"), []);
  assert.match(picker.list.textContent, /No matching metering devices/);
  assert.equal(values.device_id, undefined, "searching never assigns a device");
});

test("device combobox supports keyboard selection, Escape, Tab and touch without arbitrary assignments", () => {
  const values = { device_id: "device-physical" }, { picker } = deviceForm(values);
  assert.equal(picker.input.value, "Athom meter");
  picker.input.focus();
  deviceSearch(picker, "00:01");
  deviceKey(picker, "ArrowDown");
  assert.equal(picker.list.children[0].getAttribute("aria-selected"), "true");
  assert.equal(picker.input.getAttribute("aria-activedescendant"), picker.list.children[0].id);
  deviceKey(picker, "Enter");
  assert.equal(values.device_id, "device-physical");
  assert.equal(picker.input.value, "Athom meter");
  assert.equal(picker.list.hidden, true);
  deviceSearch(picker, "uncommitted query");
  deviceKey(picker, "Escape");
  assert.equal(picker.input.value, "Athom meter");
  assert.equal(values.device_id, "device-physical");
  deviceSearch(picker, "another query");
  deviceKey(picker, "Tab");
  assert.equal(picker.input.value, "Athom meter");
  picker.show();
  deviceKey(picker, "End");
  assert.equal(picker.list.lastElementChild.getAttribute("aria-selected"), "true");
  deviceKey(picker, "Home");
  deviceKey(picker, "Enter");
  assert.equal(values.device_id, "");
  assert.equal(picker.input.value, "No device selected");
  picker.show();
  const option = picker.list.lastElementChild;
  option.dispatchEvent(new window.PointerEvent("pointerdown", { pointerType: "touch", bubbles: true, cancelable: true }));
  option.click();
  assert.equal(values.device_id, "device-physical");
  assert.equal(picker.list.hidden, true);
  picker.show();
  document.body.click();
  assert.equal(picker.list.hidden, true);
});

test("duplicate device names remain distinct and missing previous devices are retained explicitly", () => {
  const data = metadata();
  data.devices = [
    { value: "first", label: "Same name", identifiers: ["AA:01"], entity_ids: ["sensor.first_power"] },
    { value: "second", label: "Same name", identifiers: ["AA:02"], entity_ids: ["sensor.second_power"] },
  ];
  const values = { device_id: "missing-internal-device-id" }, { picker } = deviceForm(values, data);
  assert.match(picker.textContent, /Existing sensor assignments are retained/);
  assert.equal(picker.input.value, "Unavailable or missing device");
  assert.doesNotMatch(picker.textContent, /missing-internal-device-id/);
  deviceSearch(picker, "AA02");
  assert.equal(picker.list.children.length, 1);
  picker.list.firstElementChild.click();
  assert.equal(values.device_id, "second");
  assert.equal(picker.input.value, "Same name");
  assert(!picker.querySelector(".error"));
  picker.show();
  picker.remove();
  assert.equal(picker.list.hidden, true, "detaching a form closes its selector and removes outside listeners");
});

test("editing device changes sensor choices without changing current assignments or Price", () => {
  const data = metadata();
  data.devices.push({ value: "other", label: "Other meter", entity_ids: ["sensor.new_power", "sensor.new_energy"] });
  data.entities.push(
    { entity_id: "sensor.new_power", name: "New power", device_id: "other", device_class: "power" },
    { entity_id: "sensor.new_energy", name: "New energy", device_id: "other", device_class: "energy" },
  );
  const schema = [userStep().data_schema[0], userStep().data_schema[2], ...sensorsStep().data_schema.map((field) => {
    const cloned = structuredClone(field);
    delete cloned.selector.entity.include_entities;
    return cloned;
  })];
  const values = { name: "Existing", device_id: "device-physical", power_sensor: "sensor.power", energy_sensor: "sensor.energy", price_sensor: "sensor.price" };
  const host = document.createElement("form");
  host.append(renderFields(schema, values, data, {}, (key, value) => { values[key] = value; }));
  document.body.append(host);
  const picker = host.querySelector(".device-picker");
  assert.equal(picker.input.value, "Athom meter");
  assert.equal(host.querySelector("#field-power_sensor").value, "sensor.power");
  deviceSearch(picker, "Other meter");
  picker.list.firstElementChild.click();
  assert.equal(values.device_id, "other");
  assert.equal(values.power_sensor, "sensor.power");
  assert.equal(values.energy_sensor, "sensor.energy");
  assert.equal(values.price_sensor, "sensor.price");
  const power = host.querySelector("#field-power_sensor");
  assert([...power.options].some((option) => option.value === "sensor.new_power"));
  assert.match(power.selectedOptions[0].textContent, /Current sensor unavailable on this device/);
  power.value = "sensor.new_power";
  power.dispatchEvent(new Event("change"));
  assert.equal(values.power_sensor, "sensor.new_power");
  assert.equal(host.querySelector("#field-price_sensor").value, "sensor.price");
});
