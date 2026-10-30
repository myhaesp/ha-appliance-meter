/** A registry-backed combobox. Text is a search query, never a device assignment. */
function element(tag, text, attributes = {}) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}
const compact = (text) => text.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");

export function deviceSelector(options, value, id, changed) {
  // Define lazily so schema-only Node consumers need no browser globals.
  if (!customElements.get("appliance-meter-device-picker")) {
    customElements.define("appliance-meter-device-picker", class extends HTMLElement {
      disconnectedCallback() { this.close(); }
      close() {
        this.list.hidden = true;
        this.input.setAttribute("aria-expanded", "false");
        this.input.removeAttribute("aria-activedescendant");
        this.ownerDocument.removeEventListener("pointerdown", this.outside, true);
        this.ownerDocument.removeEventListener("click", this.outside, true);
      }
      initialize(choices, selected, inputId, onChange) {
        this.className = "device-picker";
        const empty = { value: "", label: "No device selected" };
        const current = choices.find((option) => option.value === selected);
        this.selected = current || (selected
          ? { value: selected, label: "Unavailable or missing device", unavailable: true }
          : empty);
        this.choices = [empty, ...choices];
        if (selected && !current) this.choices.push(this.selected);
        this.input = element("input", undefined, {
          id: inputId, type: "text", role: "combobox", autocomplete: "off",
          "aria-autocomplete": "list", "aria-expanded": "false",
          "aria-controls": `${inputId}-devices`, "aria-describedby": `${inputId}-help`,
          placeholder: "Search name, entity ID or hardware identifier",
        });
        this.input.value = this.selected.label;
        this.list = element("ul", undefined, { id: `${inputId}-devices`, role: "listbox", class: "device-results", "aria-label": "Metering devices" });
        this.list.hidden = true;
        const help = element("p", this.selected.unavailable
          ? "This device is unavailable or no longer eligible. Existing sensor assignments are retained."
          : "Choose a result to change device. Sensor assignments change only when you select or clear them.",
        { id: `${inputId}-help`, class: this.selected.unavailable ? "error" : "subtitle" });
        this.append(this.input, this.list, help);
        this.outside = (event) => {
          if (!event.composedPath().includes(this)) this.restore();
        };
        const choose = (option) => {
          this.selected = option;
          help.className = option.unavailable ? "error" : "subtitle";
          help.textContent = option.unavailable
            ? "This device is unavailable or no longer eligible. Existing sensor assignments are retained."
            : "Choose a result to change device. Sensor assignments change only when you select or clear them.";
          this.input.value = option.label;
          this.input.focus();
          this.close();
          onChange(option.value);
        };
        this.show = (query = "") => {
          this.ownerDocument.addEventListener("pointerdown", this.outside, true);
          this.ownerDocument.addEventListener("click", this.outside, true);
          const lower = query.toLocaleLowerCase().trim(), hardware = compact(query);
          this.matches = this.choices.filter((option) => {
            const text = [option.label, ...(option.entity_ids || []), ...(option.identifiers || [])].join(" ").toLocaleLowerCase();
            return text.includes(lower) || (hardware && (option.identifiers || []).some((identifier) => compact(identifier).includes(hardware)));
          });
          this.active = -1;
          this.list.replaceChildren();
          this.input.removeAttribute("aria-activedescendant");
          this.matches.forEach((option, index) => {
            const item = element("li", undefined, {
              id: `${inputId}-device-${index}`, role: "option", "aria-selected": String(option.value === this.selected.value),
            });
            item.append(element("span", option.label));
            const identity = option.identifiers?.[0] || option.entity_ids?.[0];
            if (identity) item.append(element("small", identity));
            if (option.unavailable) item.append(element("small", "Currently unavailable"));
            item.addEventListener("pointerdown", (event) => event.preventDefault());
            item.addEventListener("click", () => choose(option));
            this.list.append(item);
          });
          if (!this.matches.length) this.list.append(element("li", "No matching metering devices", { role: "presentation" }));
          this.list.hidden = false;
          this.input.setAttribute("aria-expanded", "true");
        };
        this.restore = () => {
          this.input.value = this.selected.label;
          this.close();
        };
        this.input.addEventListener("focus", () => { this.show(); this.input.select(); });
        this.input.addEventListener("click", () => { if (this.list.hidden) this.show(); });
        this.input.addEventListener("input", () => this.show(this.input.value));
        this.input.addEventListener("blur", () => this.restore());
        this.input.addEventListener("keydown", (event) => {
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            if (this.list.hidden) this.show();
            if (!this.matches.length) return;
            this.active = event.key === "Home" ? 0 : event.key === "End" ? this.matches.length - 1
              : this.active < 0 ? (event.key === "ArrowUp" ? this.matches.length - 1 : 0)
              : (this.active + (event.key === "ArrowDown" ? 1 : -1) + this.matches.length) % this.matches.length;
            [...this.list.children].forEach((item, index) => item.setAttribute("aria-selected", String(index === this.active)));
            const item = this.list.children[this.active];
            this.input.setAttribute("aria-activedescendant", item.id);
            item.scrollIntoView?.({ block: "nearest" });
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (!this.list.hidden && this.active >= 0) choose(this.matches[this.active]);
            else this.show(this.input.value === this.selected.label ? "" : this.input.value);
          } else if (event.key === "Escape" && !this.list.hidden) {
            event.preventDefault();
            event.stopPropagation();
            this.restore();
          } else if (event.key === "Tab") this.restore();
        });
      }
    });
  }
  const picker = document.createElement("appliance-meter-device-picker");
  picker.initialize(options, value, id, changed);
  return picker;
}
