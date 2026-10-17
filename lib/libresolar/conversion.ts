/**
 * Libre Solar BMS Telemetry Normalization & Conversion
 *
 * Implements pure conversion functions that transform raw Libre Solar measurements
 * into contract-compliant v1 representations and quality metadata.
 *
 * Key guarantees:
 * - Deterministic and side-effect-free (input objects are never mutated).
 * - Legitimate zeros (0 A current, 0 V cell, 0 error flags) are preserved.
 * - Missing or non-finite readings produce null with explicit quality reasons.
 * - Array lengths strictly match configured profile counts.
 * - Decoded faults and derived metrics adhere to v1 contract validation rules.
 */

import type {
  Metrics,
  ProducerEnvelope,
  ProfileCapabilities,
  Quality,
  QualityReason,
  Summary,
  Telemetry,
} from "../contract/types.js";
import {
  calculateCellTemperatureMax,
  calculateCellVoltageDelta,
  calculateComponentTemperatureMax,
} from "./derived.js";
import { decodeFaults } from "./faults.js";

/**
 * Raw BMS input data supporting ThingSet object paths ("Meas/rPackVoltage_V"),
 * short property names ("rPackVoltage_V"), or normalized names ("pack_voltage_reported").
 */
export interface RawBmsReadings {
  // ThingSet path format
  "Meas/rPackVoltage_V"?: number | null;
  "Meas/rStackVoltage_V"?: number | null;
  "Meas/rPackCurrent_A"?: number | null;
  "Meas/rCellTemps_degC"?: (number | null)[] | null;
  "Meas/rICTemp_degC"?: number | null;
  "Meas/rMOSFETTemp_degC"?: number | null;
  "Meas/rShuntTemp_degC"?: number | null;
  "Meas/rSOC_pct"?: number | null;
  "Meas/rErrorFlags"?: number | null;
  "Meas/rBmsState"?: number | null;
  "Meas/rCellVoltages_V"?: (number | null)[] | null;
  "Meas/rCellAvgVoltage_V"?: number | null;
  "Meas/rCellMinVoltage_V"?: number | null;
  "Meas/rCellMaxVoltage_V"?: number | null;
  "Meas/rBalancingStatus"?: number | null;

  // Short property identifiers
  rPackVoltage_V?: number | null;
  rStackVoltage_V?: number | null;
  rPackCurrent_A?: number | null;
  rCellTemps_degC?: (number | null)[] | null;
  rICTemp_degC?: number | null;
  rMOSFETTemp_degC?: number | null;
  rShuntTemp_degC?: number | null;
  rSOC_pct?: number | null;
  rErrorFlags?: number | null;
  rBmsState?: number | null;
  rCellVoltages_V?: (number | null)[] | null;
  rCellAvgVoltage_V?: number | null;
  rCellMinVoltage_V?: number | null;
  rCellMaxVoltage_V?: number | null;
  rBalancingStatus?: number | null;

  // Normalized field names
  pack_voltage_reported?: number | null;
  stack_voltage_reported?: number | null;
  pack_current?: number | null;
  cell_temperatures?: (number | null)[] | null;
  ic_temperature?: number | null;
  mosfet_temperature?: number | null;
  shunt_temperature?: number | null;
  soc?: number | null;
  error_flags?: number | null;
  bms_state_code?: number | null;
  cell_voltages?: (number | null)[] | null;
  cell_voltage_avg_reported?: number | null;
  cell_voltage_min_reported?: number | null;
  cell_voltage_max_reported?: number | null;
  balancing_mask?: number | null;

  [key: string]: unknown;
}

export type BmsState =
  "OFF" | "CHG" | "DIS" | "NORMAL" | "SHUTDOWN" | "unknown" | null;

export const BMS_STATES: readonly string[] = [
  "OFF",
  "CHG",
  "DIS",
  "NORMAL",
  "SHUTDOWN",
];

/**
 * Normalized telemetry measurements (everything in Telemetry except ProducerEnvelope).
 */
export type NormalizedMeasurements = Omit<Telemetry, keyof ProducerEnvelope>;

export interface NormalizationOptions {
  /** Optional overrides for specific field or array-path quality reasons. */
  qualityOverrides?: Record<string, QualityReason>;
}

/**
 * Decodes a raw BMS state code (0..4) into its normalized state enum string.
 */
export function decodeBmsStateCode(code: number | null | undefined): {
  code: number | null;
  state: BmsState;
} {
  if (
    code === null ||
    code === undefined ||
    typeof code !== "number" ||
    !Number.isInteger(code) ||
    code < 0 ||
    code > 255
  ) {
    return { code: null, state: null };
  }

  const mapped = BMS_STATES[code];
  if (mapped) {
    return { code, state: mapped as BmsState };
  }

  return { code, state: "unknown" };
}

/**
 * Decodes balancing status bitmask and maps active bits to configured hardware channels.
 */
export function decodeBalancingStatus(
  mask: number | null | undefined,
  cellChannels: readonly number[],
): {
  mask: number | null;
  activeChannels: number[];
  isBalancingByLogicalCell: boolean[];
} {
  if (
    mask === null ||
    mask === undefined ||
    typeof mask !== "number" ||
    !Number.isSafeInteger(mask) ||
    mask < 0 ||
    mask > 0xffffffff
  ) {
    return {
      mask: null,
      activeChannels: [],
      isBalancingByLogicalCell: cellChannels.map(() => false),
    };
  }

  const activeChannels: number[] = [];
  for (let bit = 0; bit < 32; bit++) {
    if (Math.floor(mask / 2 ** bit) % 2 === 1) {
      activeChannels.push(bit);
    }
  }

  const isBalancingByLogicalCell = cellChannels.map((channel) =>
    activeChannels.includes(channel),
  );

  return {
    mask,
    activeChannels,
    isBalancingByLogicalCell,
  };
}

/** Resolves a numeric reading across alternative field name conventions. */
function resolveNumber(
  raw: RawBmsReadings,
  thingsetKey: string,
  shortKey: string,
  normalizedKey: string,
): {
  value: number | null;
  rawPresent: boolean;
  nonFinite: boolean;
  invalidType: boolean;
} {
  let val: unknown = undefined;
  if (thingsetKey in raw) val = raw[thingsetKey];
  else if (shortKey in raw) val = raw[shortKey];
  else if (normalizedKey in raw) val = raw[normalizedKey];

  if (val === undefined || val === null) {
    return {
      value: null,
      rawPresent: val !== undefined,
      nonFinite: false,
      invalidType: false,
    };
  }

  if (typeof val === "number") {
    if (Number.isFinite(val)) {
      return {
        value: val,
        rawPresent: true,
        nonFinite: false,
        invalidType: false,
      };
    }
    return {
      value: null,
      rawPresent: true,
      nonFinite: true,
      invalidType: false,
    };
  }

  return { value: null, rawPresent: true, nonFinite: false, invalidType: true };
}

function missingNumberReason(
  result: ReturnType<typeof resolveNumber>,
): QualityReason {
  if (result.nonFinite) return "non_finite";
  if (result.invalidType) return "invalid_type";
  return "not_reported";
}

function rawValueReason(value: unknown): QualityReason {
  if (value === undefined || value === null) return "not_reported";
  if (typeof value !== "number") return "invalid_type";
  if (!Number.isFinite(value)) return "non_finite";
  return "invalid_type";
}

/** Resolves an array reading across alternative field name conventions. */
function resolveArray(
  raw: RawBmsReadings,
  thingsetKey: string,
  shortKey: string,
  normalizedKey: string,
): (number | null)[] | null {
  let val: unknown = undefined;
  if (thingsetKey in raw) val = raw[thingsetKey];
  else if (shortKey in raw) val = raw[shortKey];
  else if (normalizedKey in raw) val = raw[normalizedKey];

  if (val === undefined || val === null || !Array.isArray(val)) {
    return null;
  }

  return val as (number | null)[];
}

/**
 * Normalizes raw BMS readings according to the configured profile capabilities and v1 contract.
 *
 * Deterministic and side-effect free:
 * - Real numerical zero readings (e.g. 0 A current, 0 V cell) remain legitimate numeric 0.
 * - Missing or invalid readings produce null with appropriate quality exceptions.
 * - Cell and thermistor arrays are preserved with exact profile lengths.
 * - Derived calculations (delta, max temps) follow strict contract rules.
 */
export function normalizeTelemetry(
  raw: RawBmsReadings,
  profile: ProfileCapabilities,
  options: NormalizationOptions = {},
): NormalizedMeasurements {
  const quality: Quality = {};
  const overrides = options.qualityOverrides ?? {};

  const setQuality = (path: string, defaultReason: QualityReason) => {
    quality[path] = overrides[path] ?? defaultReason;
  };

  // 1. Pack Voltage (Reported)
  const packV = resolveNumber(
    raw,
    "Meas/rPackVoltage_V",
    "rPackVoltage_V",
    "pack_voltage_reported",
  );
  let pack_voltage_reported: number | null = packV.value;
  if (pack_voltage_reported === null) {
    setQuality("pack_voltage_reported", missingNumberReason(packV));
  }

  // 2. Stack Voltage (Reported)
  const stackV = resolveNumber(
    raw,
    "Meas/rStackVoltage_V",
    "rStackVoltage_V",
    "stack_voltage_reported",
  );
  let stack_voltage_reported: number | null = stackV.value;
  if (stack_voltage_reported === null) {
    setQuality("stack_voltage_reported", missingNumberReason(stackV));
  }

  // 3. Pack Current (A) — Positive = charging, Negative = discharging. Real 0 is valid.
  const curr = resolveNumber(
    raw,
    "Meas/rPackCurrent_A",
    "rPackCurrent_A",
    "pack_current",
  );
  let pack_current: number | null = curr.value;
  if (pack_current === null) {
    setQuality("pack_current", missingNumberReason(curr));
  }

  // 4. State of Charge (%)
  const socVal = resolveNumber(raw, "Meas/rSOC_pct", "rSOC_pct", "soc");
  let soc: number | null = socVal.value;
  if (soc === null) {
    setQuality("soc", missingNumberReason(socVal));
  } else if (soc < 0 || soc > 100) {
    soc = null;
    setQuality("soc", "invalid_type");
  }

  // 5. Unsupported Firmware Fields (always null with quality "unsupported")
  const soh = null;
  setQuality("soh", "unsupported");
  const cycle_count = null;
  setQuality("cycle_count", "unsupported");

  // 6. Cell Voltages (Array length equals profile.cell_count)
  const rawCells = resolveArray(
    raw,
    "Meas/rCellVoltages_V",
    "rCellVoltages_V",
    "cell_voltages",
  );
  const cell_voltages: (number | null)[] = [];
  for (let i = 0; i < profile.cell_count; i++) {
    const item = rawCells?.[i];
    if (
      item !== undefined &&
      item !== null &&
      typeof item === "number" &&
      Number.isFinite(item)
    ) {
      cell_voltages.push(item);
    } else {
      cell_voltages.push(null);
      const isNonFinite =
        item !== undefined &&
        item !== null &&
        (typeof item !== "number" || !Number.isFinite(item));
      setQuality(
        `cell_voltages[${i}]`,
        item !== undefined && item !== null && typeof item !== "number"
          ? "invalid_type"
          : isNonFinite
            ? "non_finite"
            : "not_reported",
      );
    }
  }

  // 7. Firmware-reported aggregates
  const minV = resolveNumber(
    raw,
    "Meas/rCellMinVoltage_V",
    "rCellMinVoltage_V",
    "cell_voltage_min_reported",
  );
  let cell_voltage_min_reported: number | null = minV.value;
  if (cell_voltage_min_reported === null) {
    setQuality("cell_voltage_min_reported", missingNumberReason(minV));
  }

  const maxV = resolveNumber(
    raw,
    "Meas/rCellMaxVoltage_V",
    "rCellMaxVoltage_V",
    "cell_voltage_max_reported",
  );
  let cell_voltage_max_reported: number | null = maxV.value;
  if (cell_voltage_max_reported === null) {
    setQuality("cell_voltage_max_reported", missingNumberReason(maxV));
  }

  const avgV = resolveNumber(
    raw,
    "Meas/rCellAvgVoltage_V",
    "rCellAvgVoltage_V",
    "cell_voltage_avg_reported",
  );
  let cell_voltage_avg_reported: number | null = avgV.value;
  if (cell_voltage_avg_reported === null) {
    setQuality("cell_voltage_avg_reported", missingNumberReason(avgV));
  }

  // 8. Derived Cell Voltage Delta
  const deltaCalc = calculateCellVoltageDelta(cell_voltages);
  let cell_voltage_delta: number | null = deltaCalc.value;
  if (deltaCalc.incomplete) {
    setQuality("cell_voltage_delta", "incomplete");
  }

  // 9. Battery Cell Temperatures (Array length equals profile.temperature_sensor_count)
  const rawTemps = resolveArray(
    raw,
    "Meas/rCellTemps_degC",
    "rCellTemps_degC",
    "cell_temperatures",
  );
  const cell_temperatures: (number | null)[] = [];
  for (let i = 0; i < profile.temperature_sensor_count; i++) {
    const item = rawTemps?.[i];
    if (
      item !== undefined &&
      item !== null &&
      typeof item === "number" &&
      Number.isFinite(item)
    ) {
      cell_temperatures.push(item);
    } else {
      cell_temperatures.push(null);
      const isNonFinite =
        item !== undefined &&
        item !== null &&
        (typeof item !== "number" || !Number.isFinite(item));
      setQuality(
        `cell_temperatures[${i}]`,
        item !== undefined && item !== null && typeof item !== "number"
          ? "invalid_type"
          : isNonFinite
            ? "non_finite"
            : "not_reported",
      );
    }
  }

  // 10. Derived Cell Temperature Max
  const cellTempCalc = calculateCellTemperatureMax(cell_temperatures);
  let cell_temperature_max: number | null = cellTempCalc.value;
  if (cellTempCalc.incomplete) {
    setQuality("cell_temperature_max", "incomplete");
  }

  // 11. Component Temperatures
  let ic_temperature: number | null = null;
  if (profile.supported_fields.includes("ic_temperature")) {
    const ic = resolveNumber(
      raw,
      "Meas/rICTemp_degC",
      "rICTemp_degC",
      "ic_temperature",
    );
    ic_temperature = ic.value;
    if (ic_temperature === null) {
      setQuality("ic_temperature", missingNumberReason(ic));
    }
  } else {
    setQuality("ic_temperature", "unsupported");
  }

  let mosfet_temperature: number | null = null;
  if (profile.supported_fields.includes("mosfet_temperature")) {
    const mos = resolveNumber(
      raw,
      "Meas/rMOSFETTemp_degC",
      "rMOSFETTemp_degC",
      "mosfet_temperature",
    );
    mosfet_temperature = mos.value;
    if (mosfet_temperature === null) {
      setQuality("mosfet_temperature", missingNumberReason(mos));
    }
  } else {
    setQuality("mosfet_temperature", "unsupported");
  }

  let shunt_temperature: number | null = null;
  if (profile.supported_fields.includes("shunt_temperature")) {
    const shunt = resolveNumber(
      raw,
      "Meas/rShuntTemp_degC",
      "rShuntTemp_degC",
      "shunt_temperature",
    );
    shunt_temperature = shunt.value;
    if (shunt_temperature === null) {
      setQuality("shunt_temperature", missingNumberReason(shunt));
    }
  } else {
    setQuality("shunt_temperature", "unsupported");
  }

  // 12. Derived Component Temperature Max across supported sensors
  const supportedComponents: (number | null)[] = [];
  if (profile.supported_fields.includes("ic_temperature")) {
    supportedComponents.push(ic_temperature);
  }
  if (profile.supported_fields.includes("mosfet_temperature")) {
    supportedComponents.push(mosfet_temperature);
  }
  if (profile.supported_fields.includes("shunt_temperature")) {
    supportedComponents.push(shunt_temperature);
  }

  const compTempCalc = calculateComponentTemperatureMax(supportedComponents);
  let component_temperature_max: number | null = compTempCalc.value;
  if (compTempCalc.incomplete) {
    setQuality("component_temperature_max", "incomplete");
  }

  // 13. BMS State Code and Enum String
  let rawStateCode: unknown = undefined;
  if ("Meas/rBmsState" in raw) rawStateCode = raw["Meas/rBmsState"];
  else if ("rBmsState" in raw) rawStateCode = raw.rBmsState;
  else if ("bms_state_code" in raw) rawStateCode = raw.bms_state_code;

  const stateDecoded = decodeBmsStateCode(
    typeof rawStateCode === "number" ? rawStateCode : null,
  );
  let bms_state_code = stateDecoded.code;
  let bms_state = stateDecoded.state;
  if (bms_state_code === null) {
    const reason = rawValueReason(rawStateCode);
    setQuality("bms_state_code", reason);
    setQuality("bms_state", reason);
  }

  // 14. Error Flags & Decoded Faults
  let rawErrorFlags: unknown = undefined;
  if ("Meas/rErrorFlags" in raw) rawErrorFlags = raw["Meas/rErrorFlags"];
  else if ("rErrorFlags" in raw) rawErrorFlags = raw.rErrorFlags;
  else if ("error_flags" in raw) rawErrorFlags = raw.error_flags;

  let error_flags: number | null = null;
  let faults: string[] | null = null;
  if (
    rawErrorFlags !== undefined &&
    rawErrorFlags !== null &&
    typeof rawErrorFlags === "number" &&
    Number.isSafeInteger(rawErrorFlags) &&
    rawErrorFlags >= 0 &&
    rawErrorFlags <= 4294967295
  ) {
    error_flags = rawErrorFlags;
    faults = decodeFaults(rawErrorFlags);
  } else {
    const reason = rawValueReason(rawErrorFlags);
    setQuality("error_flags", reason);
    setQuality("faults", reason);
  }

  // 15. Balancing Mask
  let rawBalancing: unknown = undefined;
  if ("Meas/rBalancingStatus" in raw)
    rawBalancing = raw["Meas/rBalancingStatus"];
  else if ("rBalancingStatus" in raw) rawBalancing = raw.rBalancingStatus;
  else if ("balancing_mask" in raw) rawBalancing = raw.balancing_mask;

  let balancing_mask: number | null = null;
  if (
    rawBalancing !== undefined &&
    rawBalancing !== null &&
    typeof rawBalancing === "number" &&
    Number.isSafeInteger(rawBalancing) &&
    rawBalancing >= 0 &&
    rawBalancing <= 4294967295
  ) {
    balancing_mask = rawBalancing;
  } else {
    setQuality("balancing_mask", rawValueReason(rawBalancing));
  }

  return {
    pack_voltage_reported,
    stack_voltage_reported,
    pack_current,
    soc,
    soh,
    cycle_count,
    cell_voltages,
    cell_voltage_min_reported,
    cell_voltage_max_reported,
    cell_voltage_avg_reported,
    cell_voltage_delta,
    cell_temperatures,
    cell_temperature_max,
    ic_temperature,
    mosfet_temperature,
    shunt_temperature,
    component_temperature_max,
    bms_state_code,
    bms_state,
    balancing_mask,
    error_flags,
    faults,
    quality,
  };
}

/**
 * Combines normalized measurements with a producer envelope to construct a valid Telemetry payload.
 */
export function assembleTelemetryPayload(
  envelope: ProducerEnvelope,
  measurements: NormalizedMeasurements,
): Telemetry {
  return {
    ...envelope,
    ...measurements,
  };
}

/**
 * Constructs a valid v1 Summary payload from normalized metrics and sample metadata.
 *
 * Automatically filters quality paths to include only fields present on Summary,
 * ensuring strict Ajv schema and semantic validation compliance.
 */
export function assembleSummaryPayload(
  envelope: ProducerEnvelope,
  measurements: NormalizedMeasurements,
  telemetryMessageId: string,
  lastSourceObservedAt: string,
): Summary {
  const summaryFields = [
    "soc",
    "soh",
    "cycle_count",
    "cell_voltage_delta",
    "cell_temperature_max",
    "component_temperature_max",
    "bms_state_code",
    "bms_state",
    "error_flags",
    "faults",
  ];

  const summaryQuality: Quality = {};
  for (const [key, value] of Object.entries(measurements.quality)) {
    if (summaryFields.includes(key)) {
      summaryQuality[key] = value;
    }
  }

  const metrics: Metrics = {
    soc: measurements.soc,
    soh: measurements.soh,
    cycle_count: measurements.cycle_count,
    cell_voltage_delta: measurements.cell_voltage_delta,
    cell_temperature_max: measurements.cell_temperature_max,
    component_temperature_max: measurements.component_temperature_max,
    bms_state_code: measurements.bms_state_code,
    bms_state: measurements.bms_state,
    error_flags: measurements.error_flags,
    faults: measurements.faults,
    quality: summaryQuality,
  };

  return {
    ...envelope,
    ...metrics,
    telemetry_message_id: telemetryMessageId,
    last_source_observed_at: lastSourceObservedAt,
  };
}
