import { deviceSelector } from "./device-selector.js";

/** Narrow compatibility boundary: HA flow HTTP API plus our own HTML controls.
 * No native frontend module imports. Unknown schema semantics fail closed.
 */
export const HELPERS_URL = "/config/helpers";
const FIELDS = new Set([
  "name",
  "device_id",
  "appliance_type",
  "power_sensor",
  "energy_sensor",
  "price_sensor",
  "members",
]);
const LABELS = {
  name: "Name",
  device_id: "Metering device",
  appliance_type: "Appliance type",
  power_sensor: "Power sensor",
  energy_sensor: "Energy sensor",
  price_sensor: "Price sensor",
  members: "Member appliances",
};
const ERRORS = {
  blank_name: "Enter a name.",
  energy_in_use: "This Energy sensor is already assigned to another appliance.",
  logical_sensor: "Select a physical sensor from another integration.",
  unknown_device: "Select an existing metering device.",
  logical_device: "Select a physical metering device from another integration, not an Appliance Meter virtual device.",
  not_device_sensor: "Select a compatible sensor on the selected device.",
  members_required: "Select at least one appliance.",
  duplicate_members: "Select each appliance only once.",
  invalid_member:
    "Remove missing members and select existing physical appliances.",
};
export class UnsupportedSchema extends Error {}
function fail() {
  throw new UnsupportedSchema(
    "This form needs controls this panel does not support. Continue in Home Assistant Helpers.",
  );
}
function keysAllowed(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
function stringList(value) {
  return (
    typeof value === "string" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

export function checkSchema(schema) {
  if (!Array.isArray(schema)) fail();
  const names = new Set();
  for (const field of schema) {
    if (
      !keysAllowed(field, [
        "name",
        "selector",
        "required",
        "optional",
        "default",
        "description",
      ]) ||
      !FIELDS.has(field.name) ||
      names.has(field.name) ||
      !keysAllowed(field.selector, ["text", "entity", "device", "select"]) ||
      Object.keys(field.selector).length !== 1 ||
      (field.description &&
        !keysAllowed(field.description, ["suggested_value"]))
    )
      fail();
    names.add(field.name);
    const [kind, config] = Object.entries(field.selector)[0];
    if (kind === "text") {
      if (
        field.name !== "name" ||
        !keysAllowed(config, ["multiline", "multiple"]) ||
        config.multiple ||
        config.multiline
      )
        fail();
    } else if (kind === "device") {
      if (
        field.name !== "device_id" ||
        !keysAllowed(config, ["multiple"]) ||
        config.multiple
      )
        fail();
    } else if (kind === "entity") {
      if (
        !["power_sensor", "energy_sensor", "price_sensor"].includes(
          field.name,
        ) ||
        !keysAllowed(config, [
          "domain",
          "device_class",
          "include_entities",
          "exclude_entities",
          "multiple",
          "reorder",
        ]) ||
        config.multiple ||
        config.reorder
      )
        fail();
      for (const key of ["domain", "device_class"])
        if (config[key] !== undefined && !stringList(config[key])) fail();
      for (const key of ["include_entities", "exclude_entities"])
        if (
          config[key] !== undefined &&
          (!Array.isArray(config[key]) ||
            !config[key].every((v) => typeof v === "string"))
        )
          fail();
    } else if (kind === "select") {
      if (
        !["appliance_type", "members"].includes(field.name) ||
        !keysAllowed(config, [
          "options",
          "multiple",
          "mode",
          "custom_value",
          "sort",
        ]) ||
        config.custom_value ||
        (config.mode && config.mode !== "dropdown") ||
        !Array.isArray(config.options) ||
        config.options.some(
          (o) =>
            typeof o !== "string" &&
            (!keysAllowed(o, ["value", "label"]) ||
              typeof o.value !== "string" ||
              typeof o.label !== "string"),
        ) ||
        (field.name === "members"
          ? config.multiple !== true
          : Boolean(config.multiple))
      )
        fail();
    } else fail();
  }
  return schema;
}

export function formValues(step, previous = {}) {
  checkSchema(step.data_schema);
  const values = {};
  for (const field of step.data_schema) {
    if (Object.hasOwn(previous, field.name))
      values[field.name] = structuredClone(previous[field.name]);
    else if (Object.hasOwn(field.description || {}, "suggested_value"))
      values[field.name] = structuredClone(field.description.suggested_value);
    else if (Object.hasOwn(field, "default"))
      values[field.name] = structuredClone(field.default);
    else if (field.required && field.selector.text) values[field.name] = "";
    else if (field.required && field.selector.select?.multiple)
      values[field.name] = [];
  }
  return values;
}
export function submission(schema, values) {
  checkSchema(schema);
  return Object.fromEntries(
    schema
      .filter(
        (f) =>
          Object.hasOwn(values, f.name) &&
          values[f.name] !== undefined &&
          values[f.name] !== null &&
          (values[f.name] !== "" || f.required),
      )
      .map((f) => [f.name, structuredClone(values[f.name])]),
  );
}
function asList(value) {
  return Array.isArray(value) ? value : [value];
}
export function fieldOptions(field, metadata, deviceId) {
  const [kind, config] = Object.entries(field.selector)[0];
  if (kind === "device") return [...metadata.devices].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  if (kind === "select")
    return config.options.map((o) =>
      typeof o === "string" ? { value: o, label: o } : o,
    );
  if (kind !== "entity") return [];
  return metadata.entities
    .filter(
      (e) =>
        (!deviceId || !["power_sensor", "energy_sensor"].includes(field.name)
          || metadata.devices.find((device) => device.value === deviceId)?.entity_ids?.includes(e.entity_id)) &&
        (!config.domain ||
          asList(config.domain).includes(e.entity_id.split(".")[0])) &&
        (!config.device_class ||
          asList(config.device_class).includes(e.device_class)) &&
        (!config.include_entities ||
          config.include_entities.includes(e.entity_id)) &&
        !(config.exclude_entities || []).includes(e.entity_id),
    )
    .map((e) => ({
      value: e.entity_id,
      label: e.name === e.entity_id ? e.name : `${e.name} (${e.entity_id})`,
    }));
}
export function node(tag, text, attributes = {}) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  for (const [key, value] of Object.entries(attributes))
    el.setAttribute(key, value);
  return el;
}
export function renderFields(schema, values, metadata, errors, changed) {
  checkSchema(schema); // Check the entire form before rendering any part of it.
  const fragment = document.createDocumentFragment();
  const sensorControls = [];
  const fillSelect = (field, input) => {
    const config = Object.values(field.selector)[0];
    input.replaceChildren();
    if (!field.required) input.append(node("option", "Unassigned", { value: "" }));
    const options = fieldOptions(field, metadata, values.device_id);
    if (config.sort) options.sort((a, b) => a.label.localeCompare(b.label));
    const labels = new Map();
    for (const option of options) {
      const count = (labels.get(option.label) || 0) + 1;
      labels.set(option.label, count);
      input.append(node("option", option.label + (count > 1 ? ` (${count})` : ""), { value: option.value }));
    }
    const value = values[field.name] ?? "";
    if (value && !options.some((option) => option.value === value)) {
      input.append(node("option", field.selector.entity
        ? (values.device_id ? `Current sensor unavailable on this device (${value})` : `Unavailable sensor (${value})`)
        : "Unavailable selection", { value }));
    }
    input.value = value;
  };
  for (const field of schema) {
    const wrapper = node("div", undefined, { class: "field" });
    const id = `field-${field.name}`;
    const label = LABELS[field.name];
    const [kind, config] = Object.entries(field.selector)[0];
    let input, control;
    if (kind === "select" && config.multiple) {
      input = node("fieldset", undefined, { id });
      input.append(node("legend", label));
      const options = fieldOptions(field, metadata);
      const selected = values[field.name] || [];
      if (!Array.isArray(selected)) fail();
      if (selected.some((value) => !options.some((o) => o.value === value)))
        fail();
      if (!options.length)
        input.append(node("p", "No physical appliances available."));
      const labels = new Map();
      for (const option of options) {
        const item = node("label", undefined, { class: "member-choice" });
        const checkbox = node("input", undefined, {
          type: "checkbox",
          value: option.value,
        });
        checkbox.checked = selected.includes(option.value);
        checkbox.addEventListener("change", () =>
          changed(
            field.name,
            [...input.querySelectorAll("input:checked")].map((el) => el.value),
          ),
        );
        const count = (labels.get(option.label) || 0) + 1;
        labels.set(option.label, count);
        item.append(
          checkbox,
          node("span", option.label + (count > 1 ? ` (${count})` : "")),
        );
        input.append(item);
      }
    } else {
      wrapper.append(node("label", label, { for: id }));
      if (kind === "text") {
        input = node("input", undefined, {
          id,
          type: "text",
          autocomplete: "off",
        });
        input.value = values[field.name] ?? "";
        input.addEventListener("input", () => changed(field.name, input.value));
      } else if (kind === "device") {
        control = deviceSelector(fieldOptions(field, metadata), values[field.name] || "", id, (value) => {
          values[field.name] = value;
          changed(field.name, value);
          for (const [sensorField, select] of sensorControls) fillSelect(sensorField, select);
        });
        input = control.querySelector("input");
      } else {
        input = node("select", undefined, { id });
        fillSelect(field, input);
        if (kind === "entity") sensorControls.push([field, input]);
        input.addEventListener("change", () =>
          changed(field.name, input.value),
        );
      }
    }
    if (field.required) input.setAttribute("aria-required", "true");
    if (errors?.[field.name]) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", [input.getAttribute("aria-describedby"), `${id}-error`].filter(Boolean).join(" "));
      wrapper.append(
        control || input,
        node(
          "p",
          ERRORS[errors[field.name]] ||
            "Check this field in Home Assistant Helpers.",
          { id: `${id}-error`, class: "error", role: "alert" },
        ),
      );
    } else wrapper.append(control || input);
    fragment.append(wrapper);
  }
  return fragment;
}

/** Supports the actual two-step creation and single-step options flows.
 * Back cancels and restarts at the initial form; it never replays submissions
 * (a replay could unexpectedly create an entry after device metadata changed).
 */
export class FlowSession {
  constructor(hass, metadata, changed, complete) {
    Object.assign(this, {
      hass,
      metadata,
      changed,
      complete,
      history: [],
      values: {},
      busy: false,
      disposed: false,
    });
  }
  async start(entryId = null, preferredType = "physical") {
    this.entryId = entryId;
    this.preferredType = preferredType;
    this.base = entryId
      ? "config/config_entries/options/flow"
      : "config/config_entries/flow";
    await this.run(async () => {
      const step = await this.hass.callApi("POST", this.base, {
        handler: entryId || "appliance_meter",
      });
      this.flowId = step.flow_id;
      this.accept(step, entryId ? {} : { appliance_type: preferredType });
    });
  }
  accept(step, previous = {}) {
    this.step = step;
    if (step.type === "create_entry") {
      this.flowId = null;
      if (!this.disposed) this.complete();
      return;
    }
    if (step.type !== "form") fail();
    this.values = formValues(step, previous);
    if (
      Object.keys(step.errors || {}).some(
        (key) =>
          key !== "base" &&
          !step.data_schema.some((field) => field.name === key),
      )
    )
      fail();
  }
  async run(operation) {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.error = null;
    this.changed();
    try {
      await operation();
    } catch (error) {
      if (error instanceof UnsupportedSchema) {
        this.unsupported = error.message;
        await this.cancelFlow();
      } else
        this.error =
          "Home Assistant could not complete this request. Your changes have not been confirmed. Try again or open Helpers.";
    } finally {
      this.busy = false;
      if (this.disposed) await this.cancelFlow();
      else this.changed();
    }
  }
  async submit() {
    await this.run(async () => {
      const previous = {
        step: this.step,
        values: structuredClone(this.values),
      };
      const data = submission(this.step.data_schema, this.values);
      const next = await this.hass.callApi(
        "POST",
        `${this.base}/${this.flowId}`,
        data,
      );
      if (next.type === "form" && next.step_id !== this.step.step_id) {
        if (this.history.length) fail();
        this.history.push(previous);
      }
      let draft = previous.values;
      if (next.step_id !== previous.step.step_id) {
        draft =
          this.backDraft &&
          JSON.stringify(data) === this.backDraft.origin &&
          next.step_id === this.backDraft.stepId
            ? this.backDraft.values
            : {};
      }
      this.accept(next, draft);
    });
  }
  async back() {
    if (!this.history.length) return;
    await this.run(async () => {
      const first = this.history[0];
      this.backDraft = {
        origin: JSON.stringify(
          submission(first.step.data_schema, first.values),
        ),
        stepId: this.step.step_id,
        values: structuredClone(this.values),
      };
      await this.cancelFlow(true);
      const next = await this.hass.callApi("POST", this.base, {
        handler: this.entryId || "appliance_meter",
      });
      this.flowId = next.flow_id;
      this.history = [];
      this.accept(next, first.values);
    });
  }
  async cancelFlow(strict = false) {
    if (!this.flowId) return;
    const id = this.flowId;
    try {
      await this.hass.callApi("DELETE", `${this.base}/${id}`);
      this.flowId = null;
    } catch (error) {
      // HA also expires or completes flows. Other failures remain visible.
      if (error?.status_code === 404 || error?.status === 404)
        this.flowId = null;
      else {
        this.error =
          "Could not cancel the unfinished form. Open Helpers to check before retrying.";
        if (strict) throw error;
      }
    }
  }
  async close() {
    this.disposed = true;
    if (!this.busy) await this.cancelFlow();
  }
}

export class FlowView {
  constructor(hass, metadata, complete, close, remove) {
    this.element = node("section", undefined, {
      class: "flow-box",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Configure appliance",
    });
    this.session = new FlowSession(
      hass,
      metadata,
      () => this.render(),
      complete,
    );
    this.closeCallback = close;
    this.removeCallback = remove;
  }
  async start(entryId, type) {
    await this.session.start(entryId, type);
    this.element.querySelector("input,select,button")?.focus();
  }
  render() {
    const session = this.session;
    const title = session.entryId ? "Edit appliance" : "Add appliance";
    this.element.replaceChildren(node("h2", title));
    if (session.error)
      this.element.append(
        node("p", session.error, { role: "alert", class: "error" }),
      );
    if (session.unsupported) {
      this.element.append(
        node("p", session.unsupported, { role: "alert" }),
      );
    } else if (session.step?.type === "form") {
      try {
        const form = node("form");
        form.noValidate = true; // The existing backend flow is authoritative.
        const descriptions = {
          user: "Choose an appliance type. For a physical appliance, select its metering device.",
          sensors:
            "Check the selected sensors. Choose Energy manually when several counters are available.",
          aggregate:
            "Select appliances to combine. Changing members changes the displayed totals.",
          init: "Clear an optional field to remove its assignment.",
        };
        if (descriptions[session.step.step_id])
          form.append(node("p", descriptions[session.step.step_id]));
        if (session.step.errors?.base)
          form.append(
            node(
              "p",
              ERRORS[session.step.errors.base] ||
                "Home Assistant rejected these settings. Check the fields or open Helpers.",
              { role: "alert", class: "error" },
            ),
          );
        const fields = node("fieldset");
        fields.disabled = session.busy;
        fields.append(
          renderFields(
            session.step.data_schema,
            session.values,
            session.metadata,
            session.step.errors,
            (key, value) => {
              session.values[key] = value;
            },
          ),
        );
        form.append(fields);
        const actions = node("div", undefined, { class: "actions" });
        if (session.history.length) {
          const back = node("button", "Back", { type: "button" });
          back.disabled = session.busy;
          back.addEventListener("click", () => void session.back());
          actions.append(back);
        }
        const save = node("button", session.busy ? "Saving…" : "Continue", {
          type: "submit", class: "primary",
        });
        save.disabled = session.busy;
        actions.append(save);
        form.append(actions);
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          void session.submit();
        });
        this.element.append(form);
      } catch (error) {
        if (!(error instanceof UnsupportedSchema)) throw error;
        session.unsupported = error.message;
        void session.cancelFlow();
        this.render();
        return;
      }
    } else if (!session.unsupported)
      this.element.append(
        node("p", session.busy ? "Loading…" : "Unable to open the form."),
      );
    const cancel = node("button", "Close", { type: "button" });
    cancel.disabled = session.busy;
    cancel.addEventListener("click", async () => {
      await session.close();
      this.closeCallback();
    });
    let actions = this.element.querySelector("form .actions");
    if (!actions) {
      actions = node("div", undefined, { class: "actions" });
      this.element.append(actions);
    }
    actions.classList.add("flow-actions");
    actions.append(cancel);
    if (session.entryId && this.removeCallback) {
      const actions = node("div", undefined, { class: "danger-actions" });
      const remove = node("button", "Delete appliance", {
        type: "button",
        class: "error",
      });
      remove.disabled = session.busy;
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          await this.removeCallback(session.entryId);
        } finally {
          remove.disabled = session.busy;
        }
      });
      actions.append(remove);
      this.element.append(actions);
    }
    if (this.element.isConnected && !session.busy) {
      queueMicrotask(() => {
        if (!this.element.isConnected) return;
        let target = this.element.querySelector(
          "[aria-invalid='true'],input:not(:disabled),select:not(:disabled),button:not(:disabled),a[href]",
        );
        if (target?.tagName === "FIELDSET")
          target = target.querySelector("input");
        target?.focus();
      });
    }
  }
}
