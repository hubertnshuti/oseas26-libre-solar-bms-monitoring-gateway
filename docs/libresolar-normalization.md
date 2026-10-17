# Libre Solar Telemetry & Fault Normalization Library

**Module Reference:** `lib/libresolar`
Validation and implementation details are described below.

---

## 1. Overview and Architecture

The `lib/libresolar` library provides pure, deterministic, and side-effect-free normalization functions that convert raw Libre Solar BMS telemetry (ThingSet data objects) into contract-compliant representations and quality metadata.

### Reusability Boundary

The library contains **no** MQTT client logic, timers, filesystem writes, or network I/O. It is designed to be shared directly by:

1. **The BMS Simulator (`app/simulator`):** Converting simulated battery states into valid v1 payloads.
2. **Future Physical Hardware Readers:** Converting raw ThingSet CAN/UART frames from physical Libre Solar BMS boards into identical contract payloads.

---

## 2. Public API and Signatures

All core functions are exported from `lib/libresolar/index.ts`:

```typescript
import {
  // Telemetry & Summary conversion
  normalizeTelemetry,
  assembleTelemetryPayload,
  assembleSummaryPayload,
  decodeBmsStateCode,
  decodeBalancingStatus,

  // Fault decoding & encoding
  decodeFaults,
  encodeFaults,
  isKnownFault,
  getFaultBit,
  KNOWN_FAULTS,
  FAULT_LABELS,

  // Derived metrics
  calculateCellVoltageDelta,
  calculateCellTemperatureMax,
  calculateComponentTemperatureMax,

  // Types
  type RawBmsReadings,
  type NormalizedMeasurements,
  type NormalizationOptions,
  type BmsState,
  type KnownFaultCode,
} from "./lib/libresolar/index.js";
```

### Key Signatures

```typescript
function normalizeTelemetry(
  raw: RawBmsReadings,
  profile: ProfileCapabilities,
  options?: NormalizationOptions,
): NormalizedMeasurements;

function assembleTelemetryPayload(
  envelope: ProducerEnvelope,
  measurements: NormalizedMeasurements,
): Telemetry;

function assembleSummaryPayload(
  envelope: ProducerEnvelope,
  measurements: NormalizedMeasurements,
  telemetryMessageId: string,
  lastSourceObservedAt: string,
): Summary;

function decodeFaults(mask: number | null | undefined): string[] | null;

function decodeBmsStateCode(code: number | null | undefined): {
  code: number | null;
  state: BmsState;
};

function decodeBalancingStatus(
  mask: number | null | undefined,
  cellChannels: readonly number[],
): {
  mask: number | null;
  activeChannels: number[];
  isBalancingByLogicalCell: boolean[];
};
```

---

## 3. Data Invariants and Quality Rules

### A. Legitimate Zeros vs Missing Readings

- A reading of `0 A` for `pack_current` represents a legitimate quiescent current; it is preserved as `0` and **never** carries a quality exception.
- A cell voltage of `0.0 V` represents a legitimate dead or shorted cell observation; it is preserved as numeric `0` and factors into `cell_voltage_delta`.
- An error flag of `0` means the pack is explicitly healthy (`faults: []`).
- An absent or undefined reading is returned as `null` with a corresponding `quality` reason (`"not_reported"`, `"source_error"`, `"unsupported"`, etc.).

### B. Array Layout & Channel Semantics

- `cell_voltages` is strictly padded to `profile.cell_count` with `null` if the raw array is incomplete. Missing entries receive quality keys `cell_voltages[i]: "not_reported"`.
- `cell_temperatures` is strictly padded to `profile.temperature_sensor_count`. Missing entries receive quality keys `cell_temperatures[i]: "not_reported"`.
- `balancing_mask` maps to **physical hardware channels**, not compact array indices. For example, if cells are on channels `[0, 1, 2, 15]`, bit 15 (`32768`) activates balancing for logical cell index 3.

### C. Derived Calculations

- `cell_voltage_delta`: `max(cell_voltages) - min(cell_voltages)` of all valid configured cells. If any configured cell is `null`, delta is `null` with `quality.cell_voltage_delta: "incomplete"`.
- `cell_temperature_max`: Maximum of configured battery thermistors. Incomplete if any sensor is `null`.
- `component_temperature_max`: Maximum of supported electronics temperatures (`ic_temperature`, `mosfet_temperature`, `shunt_temperature`). Unsupported sensors are excluded; if any supported sensor is missing, the maximum is `null` with `quality.component_temperature_max: "incomplete"`.

---

## 4. Fault Decoding & Unsigned Bit 31

The Libre Solar error bitmask is an unsigned 32-bit integer (`0` to `4294967295`).

### 15 Known Fault Codes (Bits 0–14)

| Bit | Fault Code                   | Display Label                       |
| --- | ---------------------------- | ----------------------------------- |
| 0   | `cell_undervoltage`          | Cell Undervoltage                   |
| 1   | `cell_overvoltage`           | Cell Overvoltage                    |
| 2   | `short_circuit`              | Short Circuit                       |
| 3   | `discharge_overcurrent`      | Discharge Overcurrent               |
| 4   | `charge_overcurrent`         | Charge Overcurrent                  |
| 5   | `open_wire`                  | Open Sense Wire                     |
| 6   | `discharge_undertemperature` | Discharge Undertemperature          |
| 7   | `discharge_overtemperature`  | Discharge Overtemperature           |
| 8   | `charge_undertemperature`    | Charge Undertemperature             |
| 9   | `charge_overtemperature`     | Charge Overtemperature              |
| 10  | `internal_overtemperature`   | AFE IC Internal Overtemperature     |
| 11  | `cell_failure`               | Cell Failure                        |
| 12  | `discharge_switch_off`       | Discharge Switch Forced Off         |
| 13  | `charge_switch_off`          | Charge Switch Forced Off            |
| 14  | `mosfet_overtemperature`     | MOSFET Power Switch Overtemperature |

### Unknown Bits 15–31

- Bits 15 through 31 decode to `unknown_bit_N` (e.g. `unknown_bit_15`, `unknown_bit_31`).
- Bit 31 (`2147483648`) is decoded using unsigned arithmetic (`Math.floor(mask / 2 ** 31) % 2 === 1`), completely avoiding JavaScript 32-bit signed integer truncation.
- Output array is always lexicographically sorted.
- The encoder ignores duplicate fault codes instead of allowing repeated bits to carry into a different flag.
- Balancing masks outside the unsigned 32-bit range are rejected; no partial channel decoding is returned.

Input quality distinguishes absent/null values (`not_reported`), non-finite numbers (`non_finite`), and wrong types or values outside a field's allowed range (`invalid_type`).

---

## 5. Usage Example

```typescript
import {
  normalizeTelemetry,
  assembleTelemetryPayload,
  type RawBmsReadings,
} from "./lib/libresolar/index.js";
import type {
  ProducerEnvelope,
  ProfileCapabilities,
} from "./lib/contract/types.js";

// 1. Raw measurements from ThingSet (BMS CAN/UART or Simulator)
const raw: RawBmsReadings = {
  "Meas/rPackVoltage_V": 13.21,
  "Meas/rStackVoltage_V": 13.19,
  "Meas/rPackCurrent_A": -5.0,
  "Meas/rSOC_pct": 74.2,
  "Meas/rCellVoltages_V": [3.301, 3.299, 3.305, 3.301],
  "Meas/rCellTemps_degC": [27.4, 28.1],
  "Meas/rICTemp_degC": 33.1,
  "Meas/rMOSFETTemp_degC": 35.6,
  "Meas/rBmsState": 3,
  "Meas/rBalancingStatus": 0,
  "Meas/rErrorFlags": 0,
};

// 2. Battery capabilities profile
const profile: ProfileCapabilities = {
  source: "simulator",
  cell_count: 4,
  cell_channels: [0, 1, 2, 3],
  temperature_sensor_count: 2,
  temperature_sensor_channels: [0, 1],
  supported_fields: [
    "soc",
    "pack_voltage_reported",
    "stack_voltage_reported",
    "pack_current",
    "cell_voltages",
    "cell_voltage_delta",
    "cell_temperatures",
    "cell_temperature_max",
    "ic_temperature",
    "mosfet_temperature",
    "component_temperature_max",
    "bms_state_code",
    "bms_state",
    "balancing_mask",
    "error_flags",
    "faults",
  ],
};

// 3. Normalize measurements & quality metadata
const measurements = normalizeTelemetry(raw, profile);

// 4. Assemble with message envelope for MQTT publishing
const envelope: ProducerEnvelope = {
  schema_version: 1,
  node_id: "53494D0000000001",
  source: "simulator",
  session_id: "15f75ec4-29ab-48ab-93be-81d3e0708a68",
  sequence: 1,
  message_id:
    "53494D0000000001:15f75ec4-29ab-48ab-93be-81d3e0708a68:telemetry:1",
  observed_at: new Date().toISOString(),
  published_at: new Date().toISOString(),
  clock_source: "simulator_host",
};

const telemetryPayload = assembleTelemetryPayload(envelope, measurements);
```

---

## 6. Operator display guidance

For MicroPowerManager battery asset screens:

- **Known Fault Codes:** The `FAULT_LABELS` dictionary maps every known fault code to its human-readable title.
- **Handling Unknown High Bits:** If a firmware build sets an unassigned flag (e.g., bit 20 or bit 31), the decoded array will contain `unknown_bit_20` or `unknown_bit_31`. The UI should render this with an amber warning badge (e.g., `Warning: Unrecognized Fault (Bit 31)`).
- **Legitimate Zero Current:** When `pack_current === 0`, display `0.0 A (Idle)` rather than treating the metric as unconfigured.

## 7. Verification

From the gateway repository root, run `npm test -- tests/unit/libresolar.test.ts`,
`npm run typecheck`, `npm run format:check`, and `npm test`. The recorded normalization implementation checks
passed all four commands; the targeted file passed 76 tests and the full suite
passed 230 tests across 6 files. The full suite needed loopback permission for
the existing adapter runtime tests. These checks do not demonstrate simulator,
broker, hardware, or MPM integration.

Consumers can use `FAULT_LABELS` and the normalized output names.
The [simulator guide](simulator.md) describes the publisher that uses this library.
