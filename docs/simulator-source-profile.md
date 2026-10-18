# Libre Solar BMS source mapping and demo battery profile

Firmware reference: [LibreSolar/bms-firmware](https://github.com/LibreSolar/bms-firmware) at `779d20199bff2666e01371ce2f562dcda4d6bda3`.

## 1. Scope and verification boundary

This document describes the field mapping, units, and constructed battery profile used by the simulator and normalized MQTT contract.
Mappings are derived from the versioned repository references: `lib/contract/fields.json`, `lib/contract/types.ts`, `lib/contract/validate.ts`, and `lib/contract/profiles/demo-lfp-4s-v1.json`.
Independent compilation or verification against physical hardware has not been performed.
Any discrepancy found during firmware inspection must be reconciled through the contract/schema review process before changing producer output.

## 2. Source Field Mapping (ThingSet `Meas` Data Objects)

The Libre Solar BMS exposes live telemetry via ThingSet data objects grouped under the `Meas` namespace. The table below documents every supported field, its raw object ID, normalized v1 contract name, units, type, build constraints, and source reference.

| Raw ThingSet Path        | Object ID | Normalized Field Name       | Unit    | Wire Type            | Build Condition & Firmware Mapping                                                                                                                                                 | Contract Reference                                   |
| ------------------------ | --------- | --------------------------- | ------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `Meas/rPackVoltage_V`    | `0x71`    | `pack_voltage_reported`     | `V`     | `number \| null`     | Bound to `total_voltage` in firmware. In the Texas Instruments BQ769x2 driver, populated from the PACK pin register. Terminal physical meaning unresolved; preserve reported name. | [`fields.json`](../lib/contract/fields.json#L5-L10)  |
| `Meas/rStackVoltage_V`   | `0x72`    | `stack_voltage_reported`    | `V`     | `number \| null`     | Bound to `external_voltage` in firmware. In BQ769x2 driver, populated from the STACK pin register. Supported conditionally when power switches are enabled.                        | [`fields.json`](../lib/contract/fields.json#L11-L16) |
| `Meas/rPackCurrent_A`    | `0x73`    | `pack_current`              | `A`     | `number \| null`     | Battery pack current. Conditional switches support. Current sign convention: **positive (+) = charging**, **negative (-) = discharging**. Legitimate zero is `0.0`.                | [`fields.json`](../lib/contract/fields.json#L17-L22) |
| `Meas/rCellTemps_degC`   | `0x74`    | `cell_temperatures`         | `°C`    | `(number \| null)[]` | Array of battery cell thermistors. Maximum 3 sensors bound by firmware architecture. Demo profile defines 2 sensors. Unavailable entries must be `null`.                           | [`fields.json`](../lib/contract/fields.json#L23-L28) |
| `Meas/rICTemp_degC`      | `0x75`    | `ic_temperature`            | `°C`    | `number \| null`     | BMS analog front-end (AFE) monitoring IC internal die temperature.                                                                                                                 | [`fields.json`](../lib/contract/fields.json#L29-L34) |
| `Meas/rMOSFETTemp_degC`  | `0x77`    | `mosfet_temperature`        | `°C`    | `number \| null`     | Power switch MOSFET heatsink temperature. Conditional switches support.                                                                                                            | [`fields.json`](../lib/contract/fields.json#L37-L40) |
| `Meas/rShuntTemp_degC`   | `0x78`    | `shunt_temperature`         | `°C`    | `number \| null`     | Current measurement shunt resistor temperature. Conditional sensor; **unsupported** in demo profile (`null` with `quality: "unsupported"`).                                        | [`fields.json`](../lib/contract/fields.json#L41-L46) |
| `Meas/rSOC_pct`          | `0x7C`    | `soc`                       | `%`     | `number \| null`     | Battery State of Charge, range 0.0% to 100.0%. **Not** a State of Health (SoH) estimate.                                                                                           | [`fields.json`](../lib/contract/fields.json#L47-L52) |
| `Meas/rErrorFlags`       | `0x7E`    | `error_flags`               | bitmask | `integer \| null`    | Unsigned 32-bit integer bitmask. Bits 0–14 mapped to known fault codes; bits 15–31 mapped to `unknown_bit_N`. `null` indicates unavailable.                                        | [`fields.json`](../lib/contract/fields.json#L53-L58) |
| `Meas/rBmsState`         | `0x7F`    | `bms_state_code`            | enum    | `integer \| null`    | Raw uint8 state code (0..4). Unrecognized codes map to state string `"unknown"`.                                                                                                   | [`fields.json`](../lib/contract/fields.json#L59-L64) |
| `Meas/rCellVoltages_V`   | `0x80`    | `cell_voltages`             | `V`     | `(number \| null)[]` | Compact array of individual cell voltages (up to 16 cells max). Demo profile defines 4 cells. Missing cell must be `null`.                                                         | [`fields.json`](../lib/contract/fields.json#L65-L70) |
| `Meas/rCellAvgVoltage_V` | `0x81`    | `cell_voltage_avg_reported` | `V`     | `number \| null`     | Firmware-calculated average cell voltage. Aggregate must not be replaced by gateway calculation.                                                                                   | [`fields.json`](../lib/contract/fields.json#L71-L76) |
| `Meas/rCellMinVoltage_V` | `0x82`    | `cell_voltage_min_reported` | `V`     | `number \| null`     | Firmware-calculated minimum cell voltage.                                                                                                                                          | [`fields.json`](../lib/contract/fields.json#L77-L82) |
| `Meas/rCellMaxVoltage_V` | `0x83`    | `cell_voltage_max_reported` | `V`     | `number \| null`     | Firmware-calculated maximum cell voltage.                                                                                                                                          | [`fields.json`](../lib/contract/fields.json#L83-L88) |
| `Meas/rBalancingStatus`  | `0x84`    | `balancing_mask`            | bitmask | `integer \| null`    | Bitmask of active cell balancing channels. Bits map to **physical hardware channels**, not compact array positions.                                                                | [`fields.json`](../lib/contract/fields.json#L89-L94) |

### Derived and Excluded Metrics

- `bms_state`: String enum derived from `bms_state_code`: `"OFF"`, `"CHG"`, `"DIS"`, `"NORMAL"`, `"SHUTDOWN"`, `"unknown"`, or `null`.
- `faults`: Lexicographically sorted array of decoded fault codes. `[]` when `error_flags == 0`; `null` when `error_flags == null`.
- `cell_voltage_delta`: `max(cell_voltages) - min(cell_voltages)` of configured valid cells. If any configured cell is `null`, delta is `null` with `quality: "incomplete"`.
- `cell_temperature_max`: `max(cell_temperatures)` over all configured battery sensors. If any configured sensor is `null`, max is `null` with `quality: "incomplete"`.
- `component_temperature_max`: `max(ic_temperature, mosfet_temperature)`. If any supported component is missing, max is `null` with `quality: "incomplete"`.
- `soh` and `cycle_count`: Unsupported in pinned firmware reference. Strictly `null` with `quality: "unsupported"`. Never fabricated.
- **MCU Temperature:** Excluded. Not exposed by the supported Libre Solar data model.

---

## 3. Operational Semantics and Data Rules

### A. Current Flow Sign Convention

- **Positive (+) Current:** Energy flowing **into** the battery bank (Charging state).
- **Negative (-) Current:** Energy flowing **out of** the battery bank (Discharging state).
- **Legitimate Zero:** `0.0 A` is a legitimate quiescent reading (pack connected, switches closed or open, no net current). It must **not** be confused with missing data (`null`).

### B. Legitimate Zero vs Missing / Null Readings

- A reading of `0 V` on a cell voltage is a valid physical observation of a dead, shorted, or disconnected cell, whereas a sensor failure where the ADC cannot report a reading must be represented as `null` with an accompanying `quality` reason (`"source_error"`, `"not_reported"`, etc.).
- `error_flags = 0` means no active fault bits were reported; it does not establish overall battery health. `error_flags = null` means the fault register is unavailable.

### C. BMS State Codes

The firmware exposes `rBmsState` as a uint8 code representing the allowed conduction state of the battery switches:

| Code      | State String | Meaning                                                                 |
| --------- | ------------ | ----------------------------------------------------------------------- |
| `0`       | `OFF`        | Both charge and discharge switches open (idle / disconnected).          |
| `1`       | `CHG`        | Charge switch closed; discharge switch open (charging allowed only).    |
| `2`       | `DIS`        | Discharge switch closed; charge switch open (discharging allowed only). |
| `3`       | `NORMAL`     | Both switches closed (normal bidirectional operation).                  |
| `4`       | `SHUTDOWN`   | System in low-power shutdown / fault lockout.                           |
| Any other | `unknown`    | Unrecognized code (forward-compatibility preservation).                 |
| `null`    | `null`       | State reading unavailable (with quality reason).                        |

_Note:_ State describes permitted switch directions, not proof of active current flow.

### D. 15 Known Fault Bits and Unsigned Bit 31

The raw `error_flags` field is a 32-bit unsigned bitmask:

```
Bit  0 (1):      cell_undervoltage
Bit  1 (2):      cell_overvoltage
Bit  2 (4):      short_circuit
Bit  3 (8):      discharge_overcurrent
Bit  4 (16):     charge_overcurrent
Bit  5 (32):     open_wire
Bit  6 (64):     discharge_undertemperature
Bit  7 (128):    discharge_overtemperature
Bit  8 (256):    charge_undertemperature
Bit  9 (512):    charge_overtemperature
Bit 10 (1024):   internal_overtemperature
Bit 11 (2048):   cell_failure
Bit 12 (4096):   discharge_switch_off
Bit 13 (8192):   charge_switch_off
Bit 14 (16384):  mosfet_overtemperature
Bits 15–31:      unknown_bit_15 .. unknown_bit_31
```

> [!CAUTION]
> **JavaScript Bit 31 Sign Overflow:** Standard JavaScript bitwise operators (`|`, `&`, `>>`) operate on 32-bit signed two's-complement integers. Bit 31 (`1 << 31`) evaluates to `-2147483648`. Conversion code must treat masks as unsigned numbers using division/modulo: `Math.floor(mask / 2 ** bit) % 2 === 1`. Bit 31 is unsigned integer `2147483648`.

### E. Cell Balancing Channel Mapping

`balancing_mask` indicates active balancing circuits by **hardware channel**, not logical array index. For instance, if a pack connects cells to channels 0, 1, 2, and 15, balancing on cell 4 trips bit 15 (`32768`), not bit 3. In the demo profile, logical cells 0..3 map to channels 0..3 (`active mask = 15`). Any balancing bit set outside configured channels is rejected by contract validation.

---

## 4. Demo Battery Profile (`demo-lfp-4s-v1`)

The demo battery profile is defined in [`lib/contract/profiles/demo-lfp-4s-v1.json`](../lib/contract/profiles/demo-lfp-4s-v1.json):

```json
{
  "profile_id": "demo-lfp-4s-v1",
  "source": "simulator",
  "node_id": "53494D0000000001",
  "chemistry": "LFP",
  "capacity_ah": 100,
  "cell_count": 4,
  "cell_channels": [0, 1, 2, 3],
  "temperature_sensor_count": 2,
  "temperature_sensor_channels": [0, 1],
  "supported_fields": [
    "balancing_mask",
    "bms_state",
    "bms_state_code",
    "cell_temperature_max",
    "cell_temperatures",
    "cell_voltage_avg_reported",
    "cell_voltage_delta",
    "cell_voltage_max_reported",
    "cell_voltage_min_reported",
    "cell_voltages",
    "component_temperature_max",
    "error_flags",
    "faults",
    "ic_temperature",
    "mosfet_temperature",
    "pack_current",
    "pack_voltage_reported",
    "soc",
    "stack_voltage_reported"
  ],
  "unsupported_fields": ["shunt_temperature", "soh", "cycle_count"],
  "firmware_reference": "779d20199bff2666e01371ce2f562dcda4d6bda3",
  "simulation_time_factor": 1,
  "scenario_limits": {
    "cell_overvoltage_v": 3.65,
    "cell_overvoltage_reset_v": 3.5,
    "cell_undervoltage_v": 2.8,
    "cell_undervoltage_reset_v": 3.0,
    "charge_overtemperature_degc": 45,
    "charge_overtemperature_reset_degc": 42,
    "discharge_overtemperature_degc": 60,
    "discharge_overtemperature_reset_degc": 57,
    "charge_current_a": 5,
    "discharge_current_a": -5
  }
}
```

### Profile Architecture Summary

- **Pack Topology:** 4 cells in series (4S), Lithium Iron Phosphate (`LFP`), nominal voltage 12.8 V (3.2 V/cell), 100 Ah capacity.
- **Hardware Channels:** 4 cells mapped 1:1 to hardware channels `[0, 1, 2, 3]`.
- **Battery Thermistors:** 2 sensors mapped to hardware channels `[0, 1]`.
- **Electronics Thermistors:** IC temperature and MOSFET temperature supported. Shunt temperature unsupported.
- **Scenario Protection Limits:**
  - Cell Overvoltage: Trip `3.65 V`, recovery `3.50 V`.
  - Cell Undervoltage: Trip `2.80 V`, recovery `3.00 V`.
  - Charge Overtemperature: Trip `45 °C`, recovery `42 °C`.
  - Discharge Overtemperature: Trip `60 °C`, recovery `57 °C`.
  - Normal Test Currents: `+5.0 A` (charge), `-5.0 A` (discharge).
- **Testing Notice:** These thresholds are software demonstration values for scenario injection, not manufacturer-certified safety parameters for physical cells.

### Voltage Separation Rationale

In the firmware BQ769x2 driver, `rPackVoltage_V` reads the PACK pin register, while `rStackVoltage_V` reads the STACK pin register. Because terminal connections may reverse or alter physical meaning depending on board layout and switch states, both `pack_voltage_reported` and `stack_voltage_reported` are preserved as distinct measurements. The gateway does **not** compute power (`P = V * I`) using a guessed voltage terminal.

---

## 5. Concrete Raw-to-Normalized Sample Pairs

Standalone JSON files for these examples are stored under [`docs/examples/b01/`](examples/b01/) and verified in CI by `tests/unit/b01-examples.test.ts`.

### Pair 1: Healthy Discharging Operation

#### Raw ThingSet Input (`pair1-healthy-discharging.raw.json`)

```json
{
  "Meas/rPackVoltage_V": 13.21,
  "Meas/rStackVoltage_V": 13.19,
  "Meas/rPackCurrent_A": -5.0,
  "Meas/rSOC_pct": 74.2,
  "Meas/rCellVoltages_V": [3.301, 3.299, 3.305, 3.301],
  "Meas/rCellAvgVoltage_V": 3.302,
  "Meas/rCellMinVoltage_V": 3.299,
  "Meas/rCellMaxVoltage_V": 3.305,
  "Meas/rCellTemps_degC": [27.4, 28.1],
  "Meas/rICTemp_degC": 33.1,
  "Meas/rMOSFETTemp_degC": 35.6,
  "Meas/rShuntTemp_degC": null,
  "Meas/rBmsState": 3,
  "Meas/rBalancingStatus": 0,
  "Meas/rErrorFlags": 0
}
```

#### Normalized v1 Telemetry Output (`pair1-healthy-discharging.telemetry.json`)

```json
{
  "schema_version": 1,
  "node_id": "53494D0000000001",
  "source": "simulator",
  "session_id": "15f75ec4-29ab-48ab-93be-81d3e0708a68",
  "sequence": 120,
  "message_id": "53494D0000000001:15f75ec4-29ab-48ab-93be-81d3e0708a68:telemetry:120",
  "observed_at": "2026-10-13T12:00:00.000Z",
  "published_at": "2026-10-13T12:00:00.000Z",
  "clock_source": "simulator_host",
  "pack_voltage_reported": 13.21,
  "stack_voltage_reported": 13.19,
  "pack_current": -5.0,
  "soc": 74.2,
  "cell_voltages": [3.301, 3.299, 3.305, 3.301],
  "cell_voltage_min_reported": 3.299,
  "cell_voltage_max_reported": 3.305,
  "cell_voltage_avg_reported": 3.302,
  "cell_voltage_delta": 0.006,
  "cell_temperatures": [27.4, 28.1],
  "cell_temperature_max": 28.1,
  "ic_temperature": 33.1,
  "mosfet_temperature": 35.6,
  "shunt_temperature": null,
  "component_temperature_max": 35.6,
  "bms_state_code": 3,
  "bms_state": "NORMAL",
  "balancing_mask": 0,
  "error_flags": 0,
  "faults": [],
  "soh": null,
  "cycle_count": null,
  "quality": {
    "shunt_temperature": "unsupported",
    "soh": "unsupported",
    "cycle_count": "unsupported"
  }
}
```

---

### Pair 2: Fault Condition (Overvoltage + Overtemperature) with Sensor Degradation

#### Raw ThingSet Input (`pair2-fault-overvoltage-overtemp.raw.json`)

```json
{
  "Meas/rPackVoltage_V": 14.52,
  "Meas/rStackVoltage_V": 14.5,
  "Meas/rPackCurrent_A": 5.0,
  "Meas/rSOC_pct": 98.5,
  "Meas/rCellVoltages_V": [3.45, 3.68, 3.445, 3.445],
  "Meas/rCellAvgVoltage_V": 3.505,
  "Meas/rCellMinVoltage_V": 3.445,
  "Meas/rCellMaxVoltage_V": 3.68,
  "Meas/rCellTemps_degC": [46.2, null],
  "Meas/rICTemp_degC": 38.0,
  "Meas/rMOSFETTemp_degC": 42.5,
  "Meas/rShuntTemp_degC": null,
  "Meas/rBmsState": 1,
  "Meas/rBalancingStatus": 2,
  "Meas/rErrorFlags": 514
}
```

_Raw Scenario Observations:_

- Cell 1 voltage is 3.680 V (exceeds 3.65 V threshold). Hardware balancing active on channel 1 (`balancing_mask = 2`).
- Thermistor 0 is 46.2 °C (exceeds 45 °C charge limit). Thermistor 1 is disconnected/unreadable (`null`).
- `error_flags` = 514: Bit 1 (`cell_overvoltage`, value 2) + Bit 9 (`charge_overtemperature`, value 512).

#### Normalized v1 Telemetry Output (`pair2-fault-overvoltage-overtemp.telemetry.json`)

```json
{
  "schema_version": 1,
  "node_id": "53494D0000000001",
  "source": "simulator",
  "session_id": "15f75ec4-29ab-48ab-93be-81d3e0708a68",
  "sequence": 121,
  "message_id": "53494D0000000001:15f75ec4-29ab-48ab-93be-81d3e0708a68:telemetry:121",
  "observed_at": "2026-10-13T12:00:01.000Z",
  "published_at": "2026-10-13T12:00:01.000Z",
  "clock_source": "simulator_host",
  "pack_voltage_reported": 14.52,
  "stack_voltage_reported": 14.5,
  "pack_current": 5.0,
  "soc": 98.5,
  "cell_voltages": [3.45, 3.68, 3.445, 3.445],
  "cell_voltage_min_reported": 3.445,
  "cell_voltage_max_reported": 3.68,
  "cell_voltage_avg_reported": 3.505,
  "cell_voltage_delta": 0.235,
  "cell_temperatures": [46.2, null],
  "cell_temperature_max": null,
  "ic_temperature": 38.0,
  "mosfet_temperature": 42.5,
  "shunt_temperature": null,
  "component_temperature_max": 42.5,
  "bms_state_code": 1,
  "bms_state": "CHG",
  "balancing_mask": 2,
  "error_flags": 514,
  "faults": ["cell_overvoltage", "charge_overtemperature"],
  "soh": null,
  "cycle_count": null,
  "quality": {
    "cell_temperatures[1]": "source_error",
    "cell_temperature_max": "incomplete",
    "shunt_temperature": "unsupported",
    "soh": "unsupported",
    "cycle_count": "unsupported"
  }
}
```

_Contract Invariants Enforced in Pair 2:_

1. `cell_temperature_max` is strictly `null` because sensor 1 is missing. Contract rules prohibit computing a maximum across an incomplete array without marking it `incomplete`.
2. `quality["cell_temperatures[1]"]` is explicitly `"source_error"`.
3. `faults` is lexicographically sorted: `cell_overvoltage` before `charge_overtemperature`.
4. `balancing_mask` bit 1 (channel 1) matches valid configured channel in `cell_channels: [0, 1, 2, 3]`.

---

## 6. Team Handoff

### A. MicroPowerManager backend integration

MPM receives decision-relevant asset metadata and summaries, **not** high-resolution timeseries or per-cell telemetry arrays.

#### Sample Summary Payload (`sample.summary.json`)

```json
{
  "schema_version": 1,
  "node_id": "53494D0000000001",
  "source": "simulator",
  "session_id": "15f75ec4-29ab-48ab-93be-81d3e0708a68",
  "sequence": 122,
  "message_id": "53494D0000000001:15f75ec4-29ab-48ab-93be-81d3e0708a68:summary:122",
  "observed_at": "2026-10-13T12:00:00.000Z",
  "published_at": "2026-10-13T12:00:00.000Z",
  "clock_source": "simulator_host",
  "soc": 74.2,
  "soh": null,
  "cycle_count": null,
  "cell_voltage_delta": 0.006,
  "cell_temperature_max": 28.1,
  "component_temperature_max": 35.6,
  "bms_state_code": 3,
  "bms_state": "NORMAL",
  "error_flags": 0,
  "faults": [],
  "quality": {
    "soh": "unsupported",
    "cycle_count": "unsupported"
  },
  "telemetry_message_id": "53494D0000000001:15f75ec4-29ab-48ab-93be-81d3e0708a68:telemetry:120",
  "last_source_observed_at": "2026-10-13T12:00:00.000Z"
}
```

#### Key Backend Principles

1. **Summary Frequency:** Published every 60 seconds (retained, QoS 1) and on state change, compared to 1 Hz telemetry.
2. **No Per-Cell Array Storage:** `cell_voltages` and `cell_temperatures` are omitted from summaries. Operators need high-level health indicators (`cell_voltage_delta`, `cell_temperature_max`), not timeseries arrays in MySQL.
3. **Observation Tracking:** `last_source_observed_at` and `telemetry_message_id` anchor the summary back to the exact telemetry sample. A delayed delivery does not alter the historical measurement time.
4. **Quality Paths in Summary:** In summaries, `quality` only references fields present in the summary envelope (`soh`, `cycle_count`). Fields not present on summary (such as `shunt_temperature`) must **not** appear in summary quality, or Ajv/semantic validation will reject them.

---

### B. Operator display semantics

The table below explains what each metric means in plain English, how it should be displayed, and expected normal/alarm conditions:

| Display Label              | Contract Field               | Unit | Plain-English Explanation                                                                          | UI Display Guidance                                                                                     |
| -------------------------- | ---------------------------- | ---- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **State of Charge**        | `soc`                        | `%`  | Percentage of usable battery capacity currently remaining (0.0% = empty, 100.0% = full).           | Display the reported percentage without inferring a health score.                                       |
| **Pack Voltage**           | `pack_voltage_reported`      | `V`  | Reported pack-voltage field; physical terminal interpretation is unresolved.                       | Single decimal precision (e.g. `13.2 V`). Label as "Pack Voltage (Reported)".                           |
| **Stack Voltage**          | `stack_voltage_reported`     | `V`  | Reported stack-voltage field; preserve its identity separately from pack voltage.                  | Single decimal precision (e.g. `13.2 V`). Label as "Stack Voltage (Reported)".                          |
| **Battery Current**        | `pack_current`               | `A`  | Current flowing into or out of the battery. Positive = charging, Negative = discharging.           | Display sign and state (e.g. `+5.0 A (Charging)`, `-5.0 A (Discharging)`, `0.0 A (Idle)`).              |
| **Cell Imbalance (Delta)** | `cell_voltage_delta`         | `V`  | Difference between the highest and lowest cell voltage in the pack (`V_max - V_min`).              | Display the numeric spread and unit; derive fault labels only from reported fault information.          |
| **Max Cell Temp**          | `cell_temperature_max`       | `°C` | The highest temperature measured among battery cells.                                              | Display the temperature and unit; protection thresholds depend on the configured battery.               |
| **Max Board Temp**         | `component_temperature_max`  | `°C` | Highest temperature measured among electronic switches (MOSFETs) or the BMS IC.                    | Keep electronics temperature separate from battery temperature; do not invent alarm thresholds.         |
| **BMS Switch State**       | `bms_state`                  | Text | Conduction state of the electronic protection switches: `NORMAL`, `CHG`, `DIS`, `OFF`, `SHUTDOWN`. | Display the state label; switch state alone does not establish battery health or current flow.          |
| **Active Faults**          | `faults`                     | List | Decoded alarm conditions (e.g. `cell_overvoltage`, `charge_overtemperature`).                      | Known empty `[]` means no known active faults reported; null means unavailable. Preserve unknown codes. |
| **Data Freshness**         | `observed_at` vs local clock | Time | How long ago the measurement was taken by the BMS.                                                 | Show observation age separately from source/integration assessments; summary age is not source silence. |

---

## 7. Limitations & Open Technical Boundaries

1. **Firmware Mismatch Open Question:** In the Texas Instruments BQ769x2 driver, PACK and STACK pin bindings differ between firmware revisions. Both fields remain strictly separate; no single "terminal voltage" is guessed.
2. **SoH and Cycles:** Because the pinned Libre Solar firmware does not calculate state of health or cycle counts, both are null. UI must display "Not Supported" rather than "0%".
3. **Event delivery:** The simulator has a persistent file-backed outbox. The adapter commits events to its durable SQLite queue before publishing stored receipts and retries transient backend failures. See the delivery evidence for tested recovery boundaries.

---

## 8. Verification

The examples are covered by contract validation tests:

- `tests/unit/b01-examples.test.ts` validates both telemetry pairs and the summary payload against `validateMessage()`.
- Repository checks pass:
  - `npm run typecheck` (TypeScript strict mode)
  - `npm run format:check` (Prettier code style)
  - `npm test`

Recorded results and their revisions are in [the evidence directory](evidence/README.md).
