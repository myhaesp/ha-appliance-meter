export const userStep = (flowId = "new") => ({
  type: "form",
  flow_id: flowId,
  step_id: "user",
  errors: {},
  data_schema: [
    {
      name: "name",
      required: true,
      selector: { text: { multiline: false, multiple: false } },
    },
    {
      name: "appliance_type",
      optional: true,
      default: "physical",
      selector: {
        select: {
          options: [
            { value: "physical", label: "Physical meter" },
            { value: "aggregate", label: "Aggregate / Custom Total" },
          ],
          mode: "dropdown",
          multiple: false,
          custom_value: false,
          sort: false,
        },
      },
    },
    {
      name: "device_id",
      optional: true,
      selector: { device: { multiple: false } },
    },
    {
      name: "price_sensor",
      optional: true,
      description: { suggested_value: "sensor.price" },
      selector: {
        entity: {
          domain: ["sensor"],
          exclude_entities: ["sensor.logical"],
          multiple: false,
          reorder: false,
        },
      },
    },
  ],
});
export const sensorsStep = (errors = {}, flowId = "new") => ({
  type: "form",
  flow_id: flowId,
  step_id: "sensors",
  errors,
  data_schema: [
    {
      name: "power_sensor",
      optional: true,
      description: { suggested_value: "sensor.power" },
      selector: {
        entity: {
          domain: ["sensor"],
          device_class: ["power"],
          include_entities: ["sensor.power"],
          exclude_entities: ["sensor.logical"],
          multiple: false,
          reorder: false,
        },
      },
    },
    {
      name: "energy_sensor",
      optional: true,
      selector: {
        entity: {
          domain: ["sensor"],
          device_class: ["energy"],
          include_entities: ["sensor.energy"],
          exclude_entities: ["sensor.logical"],
          multiple: false,
          reorder: false,
        },
      },
    },
    {
      name: "price_sensor",
      optional: true,
      description: { suggested_value: "sensor.price" },
      selector: {
        entity: { domain: ["sensor"], multiple: false, reorder: false },
      },
    },
  ],
});
export const aggregateStep = () => ({
  type: "form",
  flow_id: "new",
  step_id: "aggregate",
  errors: {},
  data_schema: [
    {
      name: "name",
      required: true,
      description: { suggested_value: "IT" },
      selector: { text: { multiline: false, multiple: false } },
    },
    {
      name: "members",
      required: true,
      selector: {
        select: {
          options: [{ value: "entry-physical", label: "Example Appliance" }],
          multiple: true,
          mode: "dropdown",
          custom_value: false,
          sort: false,
        },
      },
    },
  ],
});
export const metadata = () => ({
  entries: [
    {
      entry_id: "entry-physical",
      name: "Example Appliance",
      type: "physical",
      device_name: "Athom meter",
      state: "loaded",
      members: [],
      affected_totals: [{ entry_id: "entry-group", name: "Example Group" }],
      assignments: {
        power_sensor: { name: "Server power", entity_id: "sensor.power" },
        energy_sensor: { name: "Server energy", entity_id: "sensor.energy" },
        price_sensor: { name: "Electricity price", entity_id: "sensor.price" },
      },
      sensors: {
        power: "sensor.logical_power",
        energy_total: "sensor.logical_energy",
        cost_total: "sensor.logical_cost",
        unpriced_energy: "sensor.logical_unpriced",
      },
    },
    {
      entry_id: "entry-group",
      name: "Example Group",
      type: "aggregate",
      device_name: null,
      state: "loaded",
      members: [
        { entry_id: "entry-physical", name: "Example Appliance", missing: false },
      ],
      assignments: {},
      affected_totals: [],
      sensors: { power: null, energy_total: null, cost_total: null },
    },
  ],
  devices: [{ value: "device-physical", label: "Athom meter", identifiers: ["02:00:00:00:00:01"], entity_ids: ["sensor.power", "sensor.energy"] }],
  entities: [
    {
      entity_id: "sensor.power",
      name: "Server power",
      device_class: "power",
      device_id: "device-physical",
    },
    {
      entity_id: "sensor.energy",
      name: "Server energy",
      device_class: "energy",
      device_id: "device-physical",
    },
    {
      entity_id: "sensor.price",
      name: "Electricity price",
      device_class: null,
      device_id: null,
    },
    {
      entity_id: "sensor.logical",
      name: "Logical",
      device_class: "energy",
      device_id: null,
    },
  ],
});
