import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
const window = new Window();
globalThis.document = window.document;
const { costDebugContent, CostDebugView } = await import("../../custom_components/appliance_meter/frontend/cost-debug.js");
const sample = (price = "2.5", increment = "0.00025") => ({
  timestamp: "2026-10-29T12:00:00Z", energy_delta: "0.0001", price, cost_increment: increment,
});

test("diagnostics preserve precise operands, price changes, zero/negative costs and bounded history", () => {
  const calculations = [sample("-0.5", "-0.00005"), sample("0", "0"), sample(), sample(null, "0")];
  const content = costDebugContent({ available: true, calculations }, "Europe/Copenhagen");
  assert.match(content.querySelector('.cost-debug-latest').textContent, /0,0001 kWh × -0,5000 DKK\/kWh = -0,00005 DKK/);
  assert.match(content.textContent, /13\.00\.00/);
  assert.equal(content.querySelectorAll('tbody tr').length, 4);
  assert.match(content.textContent, /Unavailable \(unpriced\)/);
  assert.match(content.textContent, /2,5000/);
  assert.match(content.textContent, /0,0000/);
  assert.match(costDebugContent({ available: true, calculations: [sample("1", "1E-8")] }, "UTC").textContent, /1,0000E-8/);
});

test("empty and aggregate diagnostics explain their scope", () => {
  assert.match(costDebugContent({ available: true, calculations: [] }, 'UTC').textContent, /Waiting for the next measured energy change/);
  assert.match(costDebugContent({ available: false }, 'UTC').textContent, /Custom Totals sum their members/);
});

test("closed diagnostics discard pending reads and failures permit explicit retry", async () => {
  const view = new CostDebugView();
  let resolve;
  const hass = { user: { is_admin: true }, connection: {}, states: {}, callWS: () => new Promise(r => { resolve = r; }) };
  view.update(hass, { type: 'physical', entry_id: 'one', sensors: {} });
  view.close();
  resolve({ available: true, calculations: [sample()] });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(view.element.querySelectorAll('table').length, 0);
  const retry = new CostDebugView();
  hass.callWS = async () => { throw Error('offline'); };
  retry.update(hass, { type: 'physical', entry_id: 'one', sensors: {} });
  await new Promise(r => setTimeout(r, 0));
  assert.match(retry.element.textContent, /could not be loaded/);
  hass.callWS = async () => ({ available: true, calculations: [sample()] });
  await retry.refresh();
  assert(retry.element.querySelector('.cost-debug-latest'));
});

test("diagnostics display the persisted accounting currency", () => {
  const content = costDebugContent({
    available: true, currency: "EUR", calculations: [sample()],
  }, "UTC");
  assert.match(content.textContent, /EUR\/kWh/);
  assert.doesNotMatch(content.textContent, /DKK/);
});
