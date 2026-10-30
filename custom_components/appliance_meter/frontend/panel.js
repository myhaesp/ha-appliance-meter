import { FlowView, node } from "./flow.js";
import { CostDebugView } from "./cost-debug.js";
import {
  calendarPeriods,
  consumptionRows,
  loadConsumptionData,
} from "./consumption-data.js";
import { METRIC_COLUMNS, metricButton, updateMetricButton } from "./period-presentation.js";
export { formatValue } from "./period-presentation.js";

const VIEW_KEY = "appliance_meter.view.v1";
const collator = new Intl.Collator("da-DK", {
  sensitivity: "base",
  numeric: true,
});
const COLUMNS = [
  ["name", "Appliance"],
  ["meter", "Meter"],
  ...METRIC_COLUMNS,
];
const CSS = `
:host{display:block;color:var(--primary-text-color,#202124);background:var(--primary-background-color,#f7f8fa);min-height:100%;font:14px/1.45 var(--paper-font-body1_-_font-family,system-ui,sans-serif)}*{box-sizing:border-box}button,input,select{font:inherit;color:inherit}button,a{touch-action:manipulation}button{cursor:pointer;background:var(--card-background-color,#fff);border:1px solid var(--divider-color,#ddd);border-radius:6px;min-height:40px;padding:6px 12px}button:hover{border-color:var(--primary-color,#03a9f4)}button:disabled{opacity:.6;cursor:wait}.sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}.error{color:var(--error-color,#b00020)}.subtitle,.notes{color:var(--secondary-text-color,#666)}.notes{font-size:12px;line-height:1.6;margin:10px 0}a{color:var(--primary-color,#007fa8)}:focus-visible{outline:3px solid var(--primary-color,#03a9f4);outline-offset:2px}[hidden]{display:none!important}
.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:16px 20px;background:var(--card-background-color,#fff);border-bottom:1px solid var(--divider-color,#ddd)}.search{position:relative;flex:1 1 220px;max-width:540px;min-width:160px}.search ha-icon{position:absolute;left:10px;top:10px;--mdc-icon-size:20px;color:var(--secondary-text-color,#666)}.search input{width:100%;height:40px;padding:8px 12px 8px 36px;border:1px solid var(--divider-color,#ddd);border-radius:6px;background:var(--card-background-color,#fff)}.view-toggle{display:flex;border:1px solid var(--divider-color,#ddd);border-radius:6px;overflow:hidden}.view-toggle button{border:0;border-radius:0;padding:6px 10px;min-width:40px;background:transparent}.view-toggle button+button{border-left:1px solid var(--divider-color,#ddd)}.view-toggle button[aria-pressed=true]{color:var(--text-primary-color,#fff);background:var(--primary-color,#03a9f4)}ha-icon{--mdc-icon-size:20px}.filter-holder{position:relative}.filter-trigger{display:flex;gap:6px;align-items:center;border-style:dashed}.create{margin-left:auto;display:flex;align-items:center;gap:6px;font-weight:600;white-space:nowrap}.filters{position:absolute;z-index:6;top:calc(100% + 8px);left:0;width:270px;max-width:calc(100vw - 24px);padding:16px;background:var(--card-background-color,#fff);border:1px solid var(--divider-color,#ddd);border-radius:8px;box-shadow:0 5px 18px #0003}.filters label{display:block;font-size:12px;color:var(--secondary-text-color,#666);margin:0 0 4px}.filters select{width:100%;height:40px;margin-bottom:12px;padding:6px;border:1px solid var(--divider-color,#ddd);border-radius:5px;background:var(--card-background-color,#fff)}.filters select:last-child{margin-bottom:0}
main{width:100%;padding:12px 20px 20px}.summary{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--secondary-text-color,#666);margin:0 0 10px}.summary p{margin:0}.table-host{width:100%;border:1px solid var(--divider-color,#ddd);border-radius:8px;background:var(--card-background-color,#fff);overflow:auto}.table-host.cards-host{border:0;background:transparent;overflow:visible}table{width:100%;min-width:980px;table-layout:fixed;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}th,td{padding:4px 12px;border-bottom:1px solid var(--divider-color,#ddd);vertical-align:middle}th{background:var(--secondary-background-color,#eceef0);font-size:11px;letter-spacing:.03em;text-transform:uppercase;text-align:right;color:var(--secondary-text-color,#555)}th:first-child,th:nth-child(2){width:20%;text-align:left}th:last-child{width:70px;text-align:center}th button{padding:0;min-height:34px;width:100%;border:0;background:transparent;font:inherit;letter-spacing:inherit;text-transform:inherit;text-align:inherit;font-weight:600}td:nth-child(n+3){text-align:right}td:last-child{text-align:center}tr:last-child td{border-bottom:0}tbody tr:hover{background:var(--secondary-background-color,#f5f7f9)}.appliance-name{min-height:36px;max-width:100%;border:0;background:transparent;padding:0;text-align:left;font-weight:600;overflow-wrap:anywhere;color:var(--primary-text-color,#202124)}.appliance-name:hover{color:var(--primary-color,#03a9f4);text-decoration:underline}.meter{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--secondary-text-color,#666)}.configuration-status{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;background:var(--warning-color,#ff9800);vertical-align:middle}.metric{border:0;background:transparent;min-height:36px;padding:0;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.partial{font-size:11px;color:var(--secondary-text-color,#777);vertical-align:super;margin-left:2px}.missing{font-size:11px;color:var(--secondary-text-color,#777);white-space:normal}.empty{padding:16px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr));gap:12px}.appliance-card{padding:12px 16px;background:var(--card-background-color,#fff);border:1px solid var(--divider-color,#ddd);border-radius:8px;min-width:0}.card-heading{display:flex;gap:8px;align-items:center}.card-heading .appliance-name{flex:1;min-width:0}.card-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:12px 0 0;padding-top:10px;border-top:1px solid var(--divider-color,#ddd)}.card-metrics dt{font-size:11px;color:var(--secondary-text-color,#666);font-weight:400}.card-metrics dd{margin:0;min-width:0}.card-metrics .metric{text-align:left}
.row-actions{position:relative;display:inline-block}.menu-trigger{width:36px;min-height:36px;padding:0;font-size:24px;border-color:transparent;background:transparent}.row-menu{position:fixed;z-index:20;min-width:168px;padding:4px;margin:0;background:var(--card-background-color,#fff);border:1px solid var(--divider-color,#ddd);border-radius:7px;box-shadow:0 4px 12px #0003;color:var(--primary-text-color,#202124)}.row-menu button{display:block;width:100%;text-align:left;border:0;background:transparent;min-height:40px;padding:8px 12px;white-space:nowrap}.row-menu button:hover,.row-menu button:focus-visible{background:var(--secondary-background-color,#eee)}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
.device-picker {display:block;position:relative}.device-picker input {width:100%}.device-results {position:absolute;top:44px;left:0;right:0;z-index:15;max-height:240px;overflow:auto;list-style:none;margin:0;padding:4px;background:var(--card-background-color,white);border:1px solid var(--divider-color,#aaa);border-radius:6px;box-shadow:0 4px 12px #0003}.device-results[hidden] {display:none}.device-results li {padding:8px;min-height:44px;cursor:pointer}.device-results li[aria-selected=true],.device-results li:hover {background:var(--secondary-background-color,#eee)}.device-results span,.device-results small {display:block;overflow-wrap:anywhere}.device-results small {color:var(--secondary-text-color,#666)}
.flow-actions {flex-wrap:nowrap}.primary {background:var(--primary-color,#007fa8);color:var(--text-primary-color,white);border-color:var(--primary-color,#007fa8)}
.cost-debug-history{overflow:auto}.cost-debug-history table{min-width:520px;font-size:12px}.cost-debug-history th{width:auto!important;text-align:left}.cost-debug-history td{text-align:left;overflow-wrap:anywhere}.cost-debug summary{cursor:pointer}.cost-debug-latest dd{font-variant-numeric:tabular-nums}
.danger-actions {margin-top:24px;padding-top:20px;border-top:1px solid var(--divider-color,#ddd)}
.overlay {position:fixed;inset:0;z-index:10;background:#0006;display:flex;justify-content:center;align-items:flex-start;overflow:auto;padding:24px}.flow-box,.detail-box {background:var(--card-background-color,white);padding:24px;border-radius:12px;width:min(100%,650px);max-height:calc(100dvh - 48px);overflow:auto}.field {margin:14px 0}.field>label {display:block;margin-bottom:5px}input[type=text],select {width:100%;padding:12px;border:1px solid var(--divider-color,#aaa);border-radius:6px;background:var(--card-background-color,white)}fieldset {border:0;margin:0;padding:0;min-width:0}.field fieldset {border:1px solid var(--divider-color,#ddd);border-radius:6px;padding:10px}.member-choice {display:flex;align-items:center;gap:10px;min-height:44px}.member-choice input {width:20px;height:20px;flex-shrink:0}.member-choice span {min-width:0;overflow-wrap:anywhere}dt {font-weight:600}dd {margin:4px 0 16px;overflow-wrap:anywhere}.status {font-size:13px} :focus-visible {outline:3px solid var(--primary-color,#03a9f4);outline-offset:2px}
@media(max-width:600px) {header {padding:12px}main {padding:12px}.overlay {padding:8px}.flow-box,.detail-box {padding:16px;max-height:calc(100dvh - 16px)}.actions button {flex:1}}

@media(max-width:700px){.toolbar{gap:8px;padding:12px}.search{max-width:none;flex-basis:180px}main{padding:10px 12px}.create{font-size:13px}.filters{left:auto;right:0}th,td{padding:4px 8px}}@media(max-width:440px){.toolbar{padding:8px}.search{flex-basis:calc(100% - 56px)}.view-toggle{margin-left:0}.create{padding:6px 10px}main{padding:8px}.filters{left:0;right:auto}}
`;

export class ApplianceMeterPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._metadata = null;
    this._periodData = null;
    this._unsubscribers = [];
    this._generation = 0;
    this._refreshing = false;
    this._refreshAgain = false;
    this._refreshMetadata = false;
    this._view = "list";
    this._search = "";
    this._typeFilter = "";
    this._statusFilter = "";
    this._sort = "name";
    this._sortDirection = 1;
    this._menuId = 0;
    this._live = {};
    this._lastStates = new Map();
  }
  set hass(hass) {
    this._hass = hass;
    if (!this.isConnected) return;
    if (!hass.user?.is_admin) {
      this.stop();
      this.render();
      return;
    }
    if (this._connection && this._connection !== hass.connection) this.stop();
    if (!this._connection) void this.start();
    if (this._periodData && hass.config?.time_zone) {
      const periods = calendarPeriods(Date.now(), hass.config.time_zone);
      if (
        periods.day !== this._periodData.periods.day ||
        periods.timeZone !== this._periodData.periods.timeZone
      )
        void this.refresh(false);
    }
    this.updateManagement();
  }
  set narrow(value) {
    this._narrow = value;
    if (this._menu) this._menu.narrow = value;
  }
  connectedCallback() {
    try {
      const saved =
        this.ownerDocument.defaultView.localStorage.getItem(VIEW_KEY);
      this._view = saved === "card" ? "card" : "list";
    } catch {
      this._view = "list";
    }
    this.render();
    if (this._hass?.user?.is_admin) void this.start();
  }
  disconnectedCallback() {
    this.stop();
  }
  async start() {
    if (this._connection || !this._hass?.user?.is_admin) return;
    const generation = ++this._generation,
      connection = (this._connection = this._hass.connection);
    const subscribe = async (promise) => {
      try {
        const unsubscribe = await promise;
        if (generation !== this._generation) unsubscribe();
        else this._unsubscribers.push(unsubscribe);
      } catch {
        if (generation === this._generation) {
          this._subscriptionWarning =
            "Automatic updates are unavailable. Reload this page to reconnect.";
          this.updateStatus();
        }
      }
    };
    void subscribe(
      connection.subscribeMessage(() => void this.refresh(true), {
        type: "config_entries/subscribe",
        type_filter: ["helper"],
      }),
    );
    for (const type of ["entity_registry_updated", "device_registry_updated"])
      void subscribe(
        connection.subscribeEvents(() => void this.refresh(true), type),
      );
    void subscribe(
      connection.subscribeEvents(
        () => void this.refresh(false),
        "recorder_5min_statistics_generated",
      ),
    );
    if (connection.addEventListener) {
      const ready = () => void this.refresh(true);
      connection.addEventListener("ready", ready);
      this._unsubscribers.push(() =>
        connection.removeEventListener("ready", ready),
      );
    }
    await this.refresh();
  }
  stop() {
    this.closeActionMenu();
    this.closeFilters();
    this._generation++;
    this._connection = null;
    for (const unsubscribe of this._unsubscribers.splice(0)) unsubscribe();
    this.closeOverlay();
    this._metadata = null;
    this._periodData = null;
    this._live = {};
    this._lastStates.clear();
    this._refreshing = false;
    this._refreshAgain = false;
    this._refreshMetadata = false;
  }
  async refresh(metadata = true) {
    if (!this._hass?.user?.is_admin || !this._connection) return;
    if (this._refreshing) {
      this._refreshAgain = true;
      this._refreshMetadata ||= metadata;
      return;
    }
    const generation = this._generation;
    this._refreshing = true;
    try {
      if (metadata || !this._metadata) {
        try {
          const projection = await this._hass.callWS({
            type: "appliance_meter/management",
          });
          if (generation !== this._generation) return;
          this._metadata = projection;
          this._error = null;
          this.updateManagement();
        } catch {
          if (generation === this._generation) {
            this._error =
              "Could not update Appliance Meter. Displayed assignments may be out of date. Reload this page to retry.";
            this.updateStatus();
          }
          return;
        }
      }
      // Coalesce inventory bursts before starting the expensive history reads.
      if (this._refreshAgain && this._refreshMetadata) return;
      try {
        const data = await loadConsumptionData(this._hass, this._metadata);
        if (generation !== this._generation) return;
        this._periodData = data;
        this._periodError = null;
        const ids = new Set(
          this._metadata.entries
            .filter((e) => e.type === "physical")
            .flatMap((e) => [
              e.sensors.energy_total,
              e.sensors.cost_total,
              e.sensors.unpriced_energy,
            ]),
        );
        for (const id of Object.keys(this._live)) {
          if (!ids.has(id)) {
            delete this._live[id];
            this._lastStates.delete(id);
          } else
            this._live[id] = this._live[id].filter(
              (p) => p.lu * 1000 >= Date.now() - 7200000,
            );
        }
        data.live = this._live;
        this.updateManagement();
      } catch {
        if (generation === this._generation) {
          this._periodError =
            "Period history could not be loaded. Appliance management remains available.";
          this.updateStatus();
        }
      }
    } finally {
      if (generation === this._generation) {
        this._refreshing = false;
        this.updateStatus();
        if (this._refreshAgain) {
          const next = this._refreshMetadata;
          this._refreshAgain = false;
          this._refreshMetadata = false;
          void this.refresh(next);
        }
      }
    }
  }
  observe() {
    if (!this._metadata) return;
    for (const entry of this._metadata.entries.filter(
      (e) => e.type === "physical",
    ))
      for (const key of ["energy_total", "cost_total", "unpriced_energy"]) {
        const id = entry.sensors[key],
          state = this._hass.states[id];
        if (!id || !state || this._lastStates.get(id) === state) continue;
        this._lastStates.set(id, state);
        const time = Date.parse(state.last_updated);
        if (Number.isFinite(time))
          (this._live[id] ||= []).push({
            s: state.state,
            lu: time / 1000,
            a: state.attributes,
          });
      }
  }
  render() {
    this.closeActionMenu();
    this.closeFilters();
    const overlay = this._overlay;
    this.shadowRoot.replaceChildren(node("style", CSS));
    this._tableHost = null;
    if (!this._hass?.user?.is_admin) {
      this.shadowRoot.append(node("p", "Administrator access is required."));
      return;
    }
    this.shadowRoot.append(node("h1", "Appliance Meter", { class: "sr-only" }));
    const toolbar = node("header", undefined, {
      class: "toolbar",
      "aria-label": "Appliance Meter toolbar",
    });
    this._menu = node("ha-menu-button");
    this._menu.hass = this._hass;
    this._menu.narrow = this._narrow;
    const searchBox = node("div", undefined, { class: "search" });
    searchBox.append(
      node("ha-icon", undefined, {
        icon: "mdi:magnify",
        "aria-hidden": "true",
      }),
    );
    const search = node("input", undefined, {
      type: "search",
      placeholder: "Search appliances…",
      "aria-label": "Search appliances",
      value: this._search,
    });
    search.addEventListener("input", () => {
      this._search = search.value;
      this.updateTable();
    });
    searchBox.append(search);
    const views = node("div", undefined, {
      class: "view-toggle",
      role: "group",
      "aria-label": "Appliance view",
    });
    for (const [view, label, icon] of [
      ["card", "Card View", "mdi:view-grid-outline"],
      ["list", "List View", "mdi:format-list-bulleted"],
    ]) {
      const button = node("button", undefined, {
        type: "button",
        "data-view": view,
        "aria-label": label,
        title: label,
        "aria-pressed": String(this._view === view),
      });
      button.append(
        node("ha-icon", undefined, { icon, "aria-hidden": "true" }),
      );
      button.addEventListener("click", () => this.selectView(view));
      views.append(button);
    }
    const holder = node("div", undefined, { class: "filter-holder" });
    this._filterTrigger = node("button", undefined, {
      type: "button",
      class: "filter-trigger",
      "aria-label": "Filters",
      "aria-expanded": "false",
      "aria-controls": "appliance-filters",
    });
    this._filterTrigger.append(
      node("ha-icon", undefined, {
        icon: "mdi:filter-variant",
        "aria-hidden": "true",
      }),
      node("span", "Filters"),
    );
    const filters = (this._filters = node("div", undefined, {
      class: "filters",
      id: "appliance-filters",
      role: "dialog",
      "aria-label": "Appliance filters",
    }));
    filters.hidden = true;
    for (const [key, label, options] of [
      [
        "_typeFilter",
        "Filter by appliance type",
        [
          ["", "All types"],
          ["physical", "Physical"],
          ["aggregate", "Custom Totals"],
        ],
      ],
      [
        "_statusFilter",
        "Filter by status",
        [
          "",
          "Ready",
          "Missing assignments",
          "Unavailable",
          "Configuration problem",
          "Not loaded",
        ].map((x) => [x, x || "All statuses"]),
      ],
      [
        "_sort",
        "Sort appliances",
        COLUMNS.flatMap(([key, label]) => [
          [key + ":1", label + " ↑"],
          [key + ":-1", label + " ↓"],
        ]),
      ],
    ]) {
      const id = `appliance-${key}`;
      filters.append(node("label", label, { for: id }));
      const select = node("select", undefined, { id, "aria-label": label });
      for (const [value, text] of options)
        select.append(node("option", text, { value }));
      select.value =
        key === "_sort" ? `${this._sort}:${this._sortDirection}` : this[key];
      select.addEventListener("change", () => {
        if (key === "_sort") {
          const [sort, direction] = select.value.split(":");
          this._sort = sort;
          this._sortDirection = Number(direction);
        } else this[key] = select.value;
        this.updateTable();
      });
      if (key === "_sort") this._sortControl = select;
      filters.append(select);
    }
    this._filterTrigger.addEventListener("click", () =>
      filters.hidden ? this.openFilters(holder) : this.closeFilters(true),
    );
    holder.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !filters.hidden) {
        event.preventDefault();
        this.closeFilters(true);
      }
    });
    holder.append(this._filterTrigger, filters);
    this._create = node("button", undefined, {
      type: "button",
      class: "create primary",
    });
    this._create.append(
      node("ha-icon", undefined, { icon: "mdi:plus", "aria-hidden": "true" }),
      node("span", "Create Appliance"),
    );
    this._create.addEventListener("click", () => this.openFlow());
    toolbar.append(this._menu, searchBox, views, holder, this._create);
    this.shadowRoot.append(toolbar);
    const main = node("main"),
      summary = node("div", undefined, { class: "summary" });
    this._count = node("p", undefined, { role: "status" });
    summary.append(this._count);
    this._notices = node("div");
    this._tableHost = node("div", undefined, {
      class: "table-host",
      tabindex: "0",
      "aria-label": "Appliance results",
    });
    this._coverage = node(
      "p",
      "* Partial period or priced-cost coverage. Select a value for its coverage details. Custom Totals use current physical members.",
      { role: "status", class: "notes" },
    );
    main.append(summary, this._notices, this._tableHost, this._coverage);
    this.shadowRoot.append(main);
    if (overlay) this.shadowRoot.append(overlay);
    this._tableSignature = null;
    this.updateManagement();
  }
  openFilters(holder) {
    this.closeActionMenu();
    this._filters.hidden = false;
    this._filterTrigger.setAttribute("aria-expanded", "true");
    this._filterOutside = (event) => {
      if (!event.composedPath().includes(holder)) this.closeFilters();
    };
    this.ownerDocument.addEventListener(
      "pointerdown",
      this._filterOutside,
      true,
    );
    this._filters.querySelector("select")?.focus();
  }
  closeFilters(focus = false) {
    if (this._filterOutside)
      this.ownerDocument.removeEventListener(
        "pointerdown",
        this._filterOutside,
        true,
      );
    this._filterOutside = null;
    if (this._filters) this._filters.hidden = true;
    this._filterTrigger?.setAttribute("aria-expanded", "false");
    if (focus) this._filterTrigger?.focus();
  }
  selectView(view) {
    if (!["list", "card"].includes(view)) return;
    this._view = view;
    try {
      this.ownerDocument.defaultView.localStorage.setItem(VIEW_KEY, view);
    } catch {}
    for (const button of this.shadowRoot.querySelectorAll("[data-view]"))
      button.setAttribute("aria-pressed", String(button.dataset.view === view));
    this.updateTable();
  }
  meterName(entry) {
    return entry.type === "aggregate"
      ? "Custom Total"
      : entry.device_name || "Device unavailable";
  }
  updateStatus() {
    if (!this._notices) return;
    this._notices.replaceChildren();
    for (const [message, role] of [
      [this._error, "alert"],
      [this._subscriptionWarning, "status"],
      [this._periodError, "status"],
      [this._periodData?.warnings.join(" "), "status"],
    ])
      if (message)
        this._notices.append(
          node("p", message, {
            role,
            class: role === "alert" ? "error" : "notes",
          }),
        );
    if (this._create) this._create.disabled = !this._metadata;

  }
  visibleRows() {
    const pending = {
      value: null,
      status: "loading",
      reason: "Loading recorded period readings.",
      since: null,
    };
    const rows = this._periodData
      ? consumptionRows(this._metadata, this._periodData, this._hass.states)
      : this._metadata.entries.map((entry) => ({
          entry,
          values: Object.fromEntries(METRIC_COLUMNS.map(([key]) => [key, pending])),
        }));
    const search = this._search.trim().toLocaleLowerCase("da-DK");
    const visible = rows
      .map((row) => ({ ...row, ...this.configuration(row.entry) }))
      .filter(
        ({ entry, status }) =>
          (!this._typeFilter || entry.type === this._typeFilter) &&
          (!this._statusFilter || status === this._statusFilter) &&
          [
            entry.name,
            this.meterName(entry),
            this.typeName(entry),
            this.sourceName(entry),
            status,
          ]
            .join(" ")
            .toLocaleLowerCase("da-DK")
            .includes(search),
      );
    visible.sort((a, b) => {
      if (["name", "meter"].includes(this._sort)) {
        const value = (row) =>
          this._sort === "name" ? row.entry.name : this.meterName(row.entry);
        return (
          this._sortDirection * collator.compare(value(a), value(b)) ||
          collator.compare(a.entry.name, b.entry.name)
        );
      }
      const x = a.values[this._sort].value,
        y = b.values[this._sort].value;
      if (x === null || y === null)
        return x === y
          ? collator.compare(a.entry.name, b.entry.name)
          : x === null
            ? 1
            : -1;
      return (
        this._sortDirection * (x - y) ||
        collator.compare(a.entry.name, b.entry.name)
      );
    });
    return visible;
  }
  nameButton(row) {
    const button = node("button", row.entry.name, {
      type: "button",
      class: "appliance-name",
      "data-entry": row.entry.entry_id,
      "aria-haspopup": "dialog",
    });
    button.addEventListener("click", () =>
      this.showDetails(row.entry.entry_id),
    );
    if (row.status !== "Ready")
      button.prepend(
        node("span", undefined, {
          class: "configuration-status",
          role: "img",
          "aria-label": row.status,
          title: row.issues.join("; "),
        }),
      );
    return button;
  }
  periodMetric(row, key) {
    return metricButton(
      row.values[key],
      key,
      row.entry,
      this._periodData?.periods.timeZone ||
        this._hass.config?.time_zone ||
        "UTC",
      (name, details) => {
        this._coverage.textContent = `${name}: ${details}`;
      },
    );
  }
  updateTable() {
    if (!this._tableHost) return;
    if (!this._metadata) {
      this._tableHost.replaceChildren(
        node("p", "Loading appliances…", { class: "empty" }),
      );
      return;
    }
    const rows = this.visibleRows(),
      signature = JSON.stringify([
        this._metadata.entries,
        rows.map((row) => row.entry.entry_id).sort(),
        this._view,
        this._sort,
        this._sortDirection,
        this._search,
        this._typeFilter,
        this._statusFilter,
      ]);
    if (signature === this._tableSignature) {
      const parent = this._tableHost.querySelector(this._view === "card" ? ".cards" : "tbody");
      const elements = new Map([...parent.children].map((element) => [element.dataset.row, element]));
      for (const row of rows) {
        const element = elements.get(row.entry.entry_id);
        for (const [key] of METRIC_COLUMNS)
          updateMetricButton(
            [...element.querySelectorAll("[data-metric]")].find((button) => button.dataset.metric === `${row.entry.entry_id}:${key}`),
            row.values[key], key, row.entry,
            this._periodData?.periods.timeZone || this._hass.config?.time_zone || "UTC",
          );
        const name = element.querySelector(".appliance-name");
        let indicator = name.querySelector(".configuration-status");
        if (row.status === "Ready") indicator?.remove();
        else {
          if (!indicator) {
            indicator = node("span", undefined, { class: "configuration-status", role: "img" });
            name.prepend(indicator);
          }
          indicator.setAttribute("aria-label", row.status);
          indicator.title = row.issues.join("; ");
        }
      }
      // Keep the menu's anchor still until it closes, then apply the latest sort.
      if (this._actionMenu) this._pendingOrder = true;
      else {
        this._pendingOrder = false;
        rows.forEach((row, index) => {
          const element = elements.get(row.entry.entry_id);
          if (parent.children[index] !== element)
            parent.insertBefore(element, parent.children[index] || null);
        });
      }
      return;
    }
    this._tableSignature = signature;
    const active = this.shadowRoot.activeElement?.dataset || {};
    this.closeActionMenu();
    this._tableHost.className =
      this._view === "card" ? "table-host cards-host" : "table-host";
    const content =
      this._view === "card" ? this.renderCards(rows) : this.renderTable(rows);
    this._tableHost.replaceChildren(content);
    this._count.textContent = `${rows.length} appliance${rows.length === 1 ? "" : "s"}${rows.length !== this._metadata.entries.length ? ` of ${this._metadata.entries.length}` : ""}`;
    this._filterTrigger.querySelector("span").textContent =
      `Filters${this._typeFilter || this._statusFilter ? ` (${Number(Boolean(this._typeFilter)) + Number(Boolean(this._statusFilter))})` : ""}`;
    if (!rows.length)
      this._tableHost.append(
        node("p", "No appliances match these filters.", { class: "empty" }),
      );
    for (const key of ["sort", "entry", "metric"])
      if (active[key]) {
        [...this._tableHost.querySelectorAll(`[data-${key}]`)]
          .find((e) => e.dataset[key] === active[key])
          ?.focus();
        break;
      }
  }
  renderTable(rows) {
    const table = node("table", undefined, { "aria-label": "Appliances" }),
      head = node("thead"),
      headings = node("tr");
    for (const [key, label] of COLUMNS) {
      const th = node("th", undefined, {
        scope: "col",
        "aria-sort":
          this._sort === key
            ? this._sortDirection === 1
              ? "ascending"
              : "descending"
            : "none",
      });
      const sort = node(
        "button",
        label +
          (this._sort === key ? (this._sortDirection === 1 ? " ↑" : " ↓") : ""),
        { type: "button", "data-sort": key },
      );
      sort.addEventListener("click", () => {
        this._sortDirection = this._sort === key ? -this._sortDirection : 1;
        this._sort = key;
        this._sortControl.value = `${key}:${this._sortDirection}`;
        this.updateTable();
        this._tableHost.querySelector(`[data-sort="${key}"]`)?.focus();
      });
      th.append(sort);
      headings.append(th);
    }
    headings.append(node("th", "Actions", { scope: "col" }));
    head.append(headings);
    const body = node("tbody");
    for (const row of rows) {
      const tr = node("tr", undefined, { "data-row": row.entry.entry_id }),
        name = node("td", undefined, { "data-label": "Appliance" });
      name.append(this.nameButton(row));
      const meter = node("td", undefined, { "data-label": "Meter" });
      meter.append(
        node("span", this.meterName(row.entry), {
          class: "meter",
          title: this.meterName(row.entry),
        }),
      );
      tr.append(name, meter);
      for (const [key] of METRIC_COLUMNS) {
        const cell = node("td", undefined, {
          "data-label": COLUMNS.find(([k]) => k === key)[1],
        });
        cell.append(this.periodMetric(row, key));
        tr.append(cell);
      }
      const actions = node("td", undefined, { "data-label": "Actions" });
      actions.append(this.rowActionMenu(row.entry));
      tr.append(actions);
      body.append(tr);
    }
    table.append(head, body);
    return table;
  }
  renderCards(rows) {
    const cards = node("div", undefined, {
      class: "cards",
      "aria-label": "Appliances",
    });
    for (const row of rows) {
      const card = node("article", undefined, {
          "data-row": row.entry.entry_id,
          class: "appliance-card",
          "aria-label": row.entry.name,
        }),
        heading = node("div", undefined, { class: "card-heading" });
      heading.append(this.nameButton(row), this.rowActionMenu(row.entry));
      card.append(
        heading,
        node("span", this.meterName(row.entry), {
          class: "meter",
          title: this.meterName(row.entry),
        }),
      );
      const metrics = node("dl", undefined, { class: "card-metrics" });
      for (const [key] of METRIC_COLUMNS) {
        const holder = node("div");
        holder.append(node("dt", COLUMNS.find(([k]) => k === key)[1]));
        const value = node("dd");
        value.append(this.periodMetric(row, key));
        holder.append(value);
        metrics.append(holder);
      }
      card.append(metrics);
      cards.append(card);
    }
    return cards;
  }

  typeName(entry) {
    return entry.type === "physical" ? "Physical" : "Custom Total";
  }
  sourceName(entry) {
    return entry.type === "physical"
      ? entry.device_name
      : entry.members.map((member) => member.name).join(", ") || "No members";
  }
  configuration(entry, visited = new Set()) {
    const issues = [];
    let status = "Ready";
    if (visited.has(entry.entry_id))
      return {
        status: "Configuration problem",
        issues: ["Circular membership"],
      };
    visited = new Set([...visited, entry.entry_id]);
    if (entry.type === "physical") {
      for (const [key, label] of [
        ["power_sensor", "Power"],
        ["energy_sensor", "Energy"],
        ["price_sensor", "Price"],
      ]) {
        const sensor = entry.assignments?.[key];
        if (!sensor) {
          issues.push(`${label} sensor unassigned`);
          if (status === "Ready") status = "Missing assignments";
        } else {
          const state = this._hass.states[sensor.entity_id];
          if (
            !state ||
            ["unknown", "unavailable", ""].includes(state.state?.trim()) ||
            state.attributes?.restored
          ) {
            issues.push(`${label} sensor unavailable: ${sensor.name}`);
            status = "Unavailable";
          }
        }
      }
      if (
        ["Device unavailable", "Multiple devices"].includes(
          entry.device_name,
        ) ||
        entry.device_name?.includes("unresolved")
      ) {
        issues.push(`Physical meter: ${entry.device_name}`);
        status = "Configuration problem";
      }
    } else {
      if (!entry.members.length) issues.push("No member appliances selected");
      for (const member of entry.members) {
        const source = this._metadata.entries.find(
          (candidate) => candidate.entry_id === member.entry_id,
        );
        if (member.missing || !source)
          issues.push(`Missing member: ${member.name}`);
        else if (this.configuration(source, visited).status !== "Ready")
          issues.push(`Member needs attention: ${member.name}`);
      }
      if (issues.length) status = "Configuration problem";
    }
    if (entry.state !== "loaded") {
      issues.push(`Home Assistant configuration state: ${entry.state}`);
      status = "Not loaded";
    }
    return { status, issues };
  }
  openActionMenu(holder, menu, trigger) {
    this.closeActionMenu();
    this.closeFilters();
    menu.hidden = false;
    // Native top layer keeps menus outside the table's horizontal scroll clip.
    if (typeof menu.showPopover === "function") {
      menu.setAttribute("popover", "manual");
      menu.showPopover();
    }
    trigger.setAttribute("aria-expanded", "true");
    const outside = (event) => {
      if (!event.composedPath().includes(holder)) this.closeActionMenu();
    };
    this._actionMenu = { menu, trigger, outside };
    this.ownerDocument.addEventListener("pointerdown", outside, true);
    this.ownerDocument.addEventListener("click", outside, true);
    const viewport = this.ownerDocument.defaultView;
    const rect = trigger.getBoundingClientRect();
    const width = Math.max(menu.offsetWidth, 168),
      height = Math.max(menu.offsetHeight, 128);
    menu.style.left = `${Math.max(8, Math.min(rect.right - width, viewport.innerWidth - width - 8))}px`;
    menu.style.top = `${rect.bottom + height + 4 <= viewport.innerHeight - 8 ? rect.bottom + 4 : Math.max(8, rect.top - height - 4)}px`;
  }
  closeActionMenu(restoreFocus = false) {
    const active = this._actionMenu;
    if (!active) return;
    this._actionMenu = null;
    if (
      typeof active.menu.hidePopover === "function" &&
      active.menu.hasAttribute("popover")
    )
      active.menu.hidePopover();
    active.menu.hidden = true;
    active.trigger.setAttribute("aria-expanded", "false");
    this.ownerDocument.removeEventListener("pointerdown", active.outside, true);
    this.ownerDocument.removeEventListener("click", active.outside, true);
    if (restoreFocus && active.trigger.isConnected) active.trigger.focus();
    if (this._pendingOrder) {
      this._pendingOrder = false;
      queueMicrotask(() => this.updateTable());
    }
  }
  rowActionMenu(entry) {
    const holder = node("div", undefined, { class: "row-actions" });
    const id = `appliance-actions-${++this._menuId}`;
    const trigger = node("button", "⋮", {
      type: "button",
      class: "menu-trigger",
      "aria-label": `Actions for ${entry.name}`,
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "aria-controls": id,
    });
    const menu = node("div", undefined, {
      id,
      class: "row-menu",
      role: "menu",
      "aria-label": `Actions for ${entry.name}`,
    });
    menu.hidden = true;
    const items = [];
    for (const [label, handler] of [
      ["Open details", () => this.showDetails(entry.entry_id)],
      ["Edit", () => this.openFlow(entry.entry_id)],
      ["Delete", () => this.confirmRemoval(entry.entry_id)],
    ]) {
      const item = node("button", label, {
        type: "button",
        role: "menuitem",
        tabindex: "-1",
      });
      if (label === "Delete") item.className = "error";
      item.addEventListener("click", () => {
        this.closeActionMenu(true);
        handler();
      });
      items.push(item);
      menu.append(item);
    }
    const open = (last = false) => {
      this.openActionMenu(holder, menu, trigger);
      items[last ? items.length - 1 : 0].focus();
    };
    trigger.addEventListener("click", () => {
      if (menu.hidden) open();
      else this.closeActionMenu(true);
    });
    holder.addEventListener("keydown", (event) => {
      const active = this.shadowRoot.activeElement;
      if (active === trigger && ["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        open(event.key === "ArrowUp");
      } else if (!menu.hidden) {
        const index = items.indexOf(active);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    items.length) %
                  items.length;
          items[next].focus();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          this.closeActionMenu(true);
        } else if (event.key === "Tab") this.closeActionMenu(true);
      }
    });
    holder.addEventListener("focusout", (event) => {
      if (
        event.relatedTarget &&
        !holder.contains(event.relatedTarget) &&
        this._actionMenu?.menu === menu
      )
        this.closeActionMenu();
    });
    holder.append(trigger, menu);
    return holder;
  }
  configurationSummary(entry) {
    const summary = node("div");
    const { status, issues } = this.configuration(entry);
    summary.append(
      node("p", `Configuration Status: ${status}`, {
        class: status === "Ready" ? "" : "error",
      }),
    );
    if (issues.length) {
      const list = node("ul", undefined, {
        class: "error",
        "aria-label": "Configuration issues",
      });
      for (const issue of issues) list.append(node("li", issue));
      summary.append(list);
    }
    const list = node("dl");
    list.append(node("dt", "Type"), node("dd", this.typeName(entry)));
    if (entry.type === "physical") {
      list.append(node("dt", "Physical meter"), node("dd", entry.device_name));
      for (const [key, label] of [
        ["power_sensor", "Power sensor"],
        ["energy_sensor", "Energy sensor"],
        ["price_sensor", "Price sensor"],
      ]) {
        const sensor = entry.assignments?.[key];
        const value = node("dd", sensor ? sensor.name : "Unassigned");
        if (sensor)
          value.append(node("div", sensor.entity_id, { class: "subtitle" }));
        list.append(node("dt", label), value);
      }
    } else
      list.append(node("dt", "Members"), node("dd", this.sourceName(entry)));
    summary.append(list);
    return summary;
  }
  updateManagement() {
    this.observe();
    this.updateTable();
    this.updateStatus();
    if (this._detailEntry) {
      const entry = this._metadata?.entries.find(
        (e) => e.entry_id === this._detailEntry,
      );
      const summary = this._overlay?.querySelector(".detail-summary");
      if (!entry) this.closeOverlay();
      else {
        if (summary) summary.replaceChildren(this.configurationSummary(entry));
        this._costDebug?.update(this._hass, entry);
      }
    }
  }
  closeOverlay() {
    this._costDebug?.close();
    this._costDebug = null;
    if (this._flow) void this._flow.session.close();
    this._flow = null;
    this._detailEntry = null;
    this._overlay?.remove();
    this._overlay = null;
    if (this.isConnected) this._returnFocus?.focus();
  }
  overlay(content) {
    this.closeFilters();
    this.closeActionMenu();
    const active = this.shadowRoot.activeElement;
    const returnFocus = this._overlay?.contains(active)
      ? this._returnFocus
      : active;
    this.closeOverlay();
    this._returnFocus = returnFocus;
    this._overlay = node("div", undefined, { class: "overlay" });
    this._overlay.append(content);
    this.shadowRoot.append(this._overlay);
    content.tabIndex = -1;
    content.focus();
    // Keep keyboard focus inside dialogs. Escape never discards an in-flight save.
    this._overlay.addEventListener("keydown", (event) => {
      if (
        event.key === "Escape" &&
        !this._flow?.session.busy &&
        !this._removing
      ) {
        event.preventDefault();
        this.closeOverlay();
      }
      if (event.key === "Tab") {
        const focusable = [
          ...content.querySelectorAll(
            "button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled)",
          ),
        ];
        if (!focusable.length) return;
        const first = focusable[0],
          last = focusable.at(-1),
          active = this.shadowRoot.activeElement;
        if (event.shiftKey && (active === first || active === content)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || active === content)) {
          event.preventDefault();
          first.focus();
        }
      }
    });
  }
  openFlow(entryId = null, type = "physical") {
    if (!this._metadata || !this._hass.user?.is_admin) return;
    const flow = new FlowView(
      this._hass,
      this._metadata,
      () => {
        this.closeOverlay();
        void this.refresh();
      },
      () => this.closeOverlay(),
      (id) => this.confirmRemoval(id),
    );
    this.overlay(flow.element);
    this._flow = flow;
    void flow.start(entryId, type);
  }
  showDetails(entryId) {
    const entry = this._metadata?.entries.find((e) => e.entry_id === entryId);
    if (!entry) {
      this.closeOverlay();
      return;
    }
    const detail = node("section", undefined, {
      class: "detail-box",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": entry.name,
    });
    detail.append(node("h2", entry.name));
    const summary = node("div", undefined, { class: "detail-summary" });
    summary.append(this.configurationSummary(entry));
    detail.append(summary);
    this.overlay(detail);
    this._detailEntry = entryId;
    this._costDebug = new CostDebugView();
    detail.append(this._costDebug.element);
    this._costDebug.update(this._hass, entry);
    const actions = node("div", undefined, { class: "actions" });
    const edit = node("button", "Edit", { type: "button" });
    edit.addEventListener("click", () => this.openFlow(entryId));
    const close = node("button", "Close", { type: "button" });
    close.addEventListener("click", () => this.closeOverlay());
    actions.append(edit, close);
    detail.append(actions);
  }
  async confirmRemoval(entryId) {
    // Refresh the dependent-group warning immediately before asking the user.
    await this.refresh();
    if (this._error) {
      this._flow?.element.append(
        node("p", this._error, { role: "alert", class: "error" }),
      );
      return;
    }
    const entry = this._metadata?.entries.find((e) => e.entry_id === entryId);
    if (!entry) return;
    const detail = node("section", undefined, {
      class: "detail-box",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Confirm removal",
    });
    detail.append(
      node("h2", `Remove ${entry.name}?`),
      node(
        "p",
        "Deleting this appliance removes its virtual sensors and associated Appliance Meter accounting state. It does not delete the physical ESPHome/Shelly device or other appliances.",
      ),
    );
    if (entry.affected_totals.length)
      detail.append(
        node(
          "p",
          `Affected Custom Totals: ${entry.affected_totals.map((e) => e.name).join(", ")}. Their values will be unavailable until you edit their membership.`,
          { class: "error" },
        ),
      );
    const actions = node("div", undefined, { class: "actions" });
    const cancel = node("button", "Cancel", { type: "button" });
    cancel.addEventListener("click", () => this.closeOverlay());
    const remove = node("button", "Remove", { type: "button" });
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      cancel.disabled = true;
      this._removing = true;
      try {
        const result = await this._hass.callApi(
          "DELETE",
          `config/config_entries/entry/${entryId}`,
        );
        if (!result || result.success === false)
          throw new Error("Deletion was not confirmed");
        this._removing = false;
        this.closeOverlay();
        if (result.require_restart)
          this._subscriptionWarning =
            "Home Assistant reports that a restart is needed to finish removal.";
        await this.refresh();
      } catch {
        this._removing = false;
        detail.append(
          node(
            "p",
            "Removal was not confirmed. Reload this page before retrying.",
            { role: "alert", class: "error" },
          ),
        );
        remove.disabled = false;
        cancel.disabled = false;
      }
    });
    actions.append(cancel, remove);
    detail.append(actions);
    this.overlay(detail);
  }
}
if (!customElements.get("appliance-meter-panel"))
  customElements.define("appliance-meter-panel", ApplianceMeterPanel);
