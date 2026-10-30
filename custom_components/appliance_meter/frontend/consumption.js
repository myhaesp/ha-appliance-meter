// Compatibility route only: inventory, periods, controls and dialogs have one implementation.
import { ApplianceMeterPanel } from "./panel.js";
export { formatValue } from "./period-presentation.js";
export class ApplianceConsumptionPanel extends ApplianceMeterPanel {}
if (!customElements.get("appliance-consumption-panel"))
  customElements.define(
    "appliance-consumption-panel",
    ApplianceConsumptionPanel,
  );
