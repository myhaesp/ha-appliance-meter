# Energy preselection evidence

Investigated against Home Assistant 2026.10.4 on 2026-10-27. This is creation-time
assistance only. It never revisits an existing appliance's assignment, counter,
baseline, entity identity or accounting storage.

## Decision policy

1. Device registry membership, sensor device class, compatible state class and
   Wh/kWh units determine the manual candidates. All compatible candidates remain
   available, including returned energy and disabled/unavailable entities.
2. Native Shelly EMData/EM1Data entities can establish both cumulative-counter
   semantics and import/return direction from their integration-owned identities.
3. The existing generic HA `total` without reset metadata convention remains a
   fallback for other integrations, with current, available, non-restored metadata.
   `utility_meter` entities cannot establish persistence this way. Unknown native
   Shelly identities do not use this fallback: an unclassified returned counter
   must not become a consumption suggestion merely because it reports `total`.
4. Exactly one evidence-backed candidate is suggested. Multiple supported import
   counters, unknown/resettable-only candidates, contradictory metadata or invalid
   associations leave Energy unselected. Power continues to resolve independently.
5. Every physical creation visits the sensor confirmation form, even if both
   sensors resolve. Users can change or clear either suggestion before saving.
   Options flows retain existing assignments; they do not run resolution.

`total_increasing` establishes compatibility with accounting, not persistence.
Reset/period metadata vetoes preselection. Display names, entity ID patterns,
manufacturer/model labels, icons, readings and MAC vendor prefixes never establish
counter semantics.

## Native Shelly: supported and bounded

The versioned [HA sensor descriptions](https://github.com/home-assistant/core/blob/2026.10.4/homeassistant/components/shelly/sensor.py)
map the following attributes to energy sensors:

| RPC component | Consumption/import | Returned/export |
| --- | --- | --- |
| `emdata:<index>` | `total_act` | `total_act_ret` |
| `emdata:<index>`, phase a/b/c | `<phase>_total_act_energy` | `<phase>_total_act_ret_energy` |
| `em1data:<index>` | `total_act_energy` | `total_act_ret_energy` |

Shelly documents these as perpetual counters, backed by flash storage, with
separate active and returned-energy fields. Persistence evidence comes from these
specific protocol semantics, not their HA state class:
[EMData](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/EMData/),
[EM1Data](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/EM1Data/).
Device reset, explicit counter reset, replacement and finite flash-write intervals
can still cause discontinuities; these counters are not guaranteed immutable.
Existing accounting already handles resets, and is unchanged here.

[HA's entity implementation](https://github.com/home-assistant/core/blob/2026.10.4/homeassistant/components/shelly/entity.py)
constructs RPC unique IDs as `<MAC>-<component>:<index>-<attribute>`.
[Its device association helpers](https://github.com/home-assistant/core/blob/2026.10.4/homeassistant/components/shelly/utils.py)
associate parent devices by network MAC and child devices by integration identifiers.

The profile requires platform `shelly`, a Shelly config entry associated with the
selected device, the exact known attribute/component format, and a matching parent,
phase or EM1 channel identity. The MAC is checked only as an identity namespace,
never used to identify a vendor. A returned-energy translation key contradicting
an otherwise recognized import identity vetoes preselection. User renaming and
localization cannot turn an export sensor into an automatic import choice.

Offline or registry-only counters may still be suggested when this native identity
and compatible registry metadata establish the semantics; no entity is enabled.
Restored or reset/period-marked metadata vetoes the profile. Other native Shelly
counters (including unverified Gen1 and switch/PM1 identities) remain manual until
an equally specific persistence/direction contract is implemented and tested.
There is no catch-all rule for Shelly hardware or arbitrary matching suffixes.

## Athom ESPHome: why Energy stays manual

The official [Athom Without Relay Plug v2.0.11 source](https://github.com/athom-tech/athom-configs/blob/c4a7c122b74002090cbf98ee1a282a07dd72aa07/athom-without-relay-plug.yaml)
uses a `restore_value` global for its template Total Energy counter. Its raw Energy
comes from the metering chip, while Total Energy Since Boot uses a different
component. The YAML proves how this particular firmware implements its counter;
it does not provide a machine-readable HA registry persistence marker.

The observed HA entities all report energy / kWh / `total_increasing`. Their
native unique IDs have the shape `MAC/0/sensor/Total Energy`; that suffix is a
sensor name, not an immutable component role. [aioesphomeapi 46.6.0](https://github.com/esphome/aioesphomeapi/blob/v46.6.0/aioesphomeapi/model.py),
used by HA 2026.10.4, builds the identity from entity metadata and exposes neither
the template lambda/global restoration configuration nor a lifetime-counter role
in `SensorInfo`. Manufacturer/model/project/version fields describe the firmware
project; they do not prove the implementation or attach persistence to a specific
sensor. Custom firmware can retain those fields and change restoration behavior.

Consequently, choosing a suffix named Total Energy, matching the Athom manufacturer
or trusting `total_increasing` would be a name/manufacturer heuristic. None is
implemented. Athom and unknown ESPHome counters with these indistinguishable
attributes remain manually selectable. A future automatic profile would need an
explicit, stable semantic marker or independently verified firmware/component
contract; a new naming pattern is insufficient.

Regression tests use real metadata shapes with synthetic identities, reversed
names, native import/export pairs, channel ambiguity, provenance failures, disabled
and offline candidates, contradictory/reset metadata, ownership validation,
manual override/clear and preserved accounting on existing-entry reload.
