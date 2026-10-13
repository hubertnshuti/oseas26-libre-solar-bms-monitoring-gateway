import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assembleSummaryPayload,
  assembleTelemetryPayload,
  BIT_31_UNSIGNED,
  calculateCellTemperatureMax,
  calculateCellVoltageDelta,
  calculateComponentTemperatureMax,
  decodeBalancingStatus,
  decodeBmsStateCode,
  decodeFaults,
  encodeFaults,
  FAULT_LABELS,
  getFaultBit,
  isKnownFault,
  KNOWN_FAULTS,
  MAX_UINT32,
  normalizeTelemetry,
  type RawBmsReadings,
} from "../../lib/libresolar/index.js";
import {
  validateMessage,
  type ProducerEnvelope,
  type ProfileCapabilities,
} from "../../lib/contract/index.js";

const profile = JSON.parse(
  readFileSync(
    new URL("../../lib/contract/profiles/demo-lfp-4s-v1.json", import.meta.url),
    "utf8",
  ),
) as ProfileCapabilities;

const envelope: ProducerEnvelope = {
  schema_version: 1,
  node_id: "53494D0000000001",
  source: "simulator",
  session_id: "15f75ec4-29ab-48ab-93be-81d3e0708a68",
  sequence: 120,
  message_id:
    "53494D0000000001:15f75ec4-29ab-48ab-93be-81d3e0708a68:telemetry:120",
  observed_at: "2026-10-13T12:00:00.000Z",
  published_at: "2026-10-13T12:00:00.000Z",
  clock_source: "simulator_host",
};

describe("Libre Solar Fault Decoding (lib/libresolar/faults)", () => {
  // Independent test mapping: Hardcoded expected codes calculated independently
  const expectedKnownFaults: [number, string][] = [
    [0, "cell_undervoltage"],
    [1, "cell_overvoltage"],
    [2, "short_circuit"],
    [3, "discharge_overcurrent"],
    [4, "charge_overcurrent"],
    [5, "open_wire"],
    [6, "discharge_undertemperature"],
    [7, "discharge_overtemperature"],
    [8, "charge_undertemperature"],
    [9, "charge_overtemperature"],
    [10, "internal_overtemperature"],
    [11, "cell_failure"],
    [12, "discharge_switch_off"],
    [13, "charge_switch_off"],
    [14, "mosfet_overtemperature"],
  ];

  it.each(expectedKnownFaults)(
    "decodes individual known fault bit %i as %s",
    (bit, code) => {
      const mask = 2 ** bit;
      const decoded = decodeFaults(mask);
      expect(decoded).toEqual([code]);
    },
  );

  it("decodes bit 31 explicitly as unsigned 2147483648 without signed overflow", () => {
    expect(BIT_31_UNSIGNED).toBe(2147483648);
    const decoded = decodeFaults(BIT_31_UNSIGNED);
    expect(decoded).toEqual(["unknown_bit_31"]);
  });

  it.each([15, 16, 20, 25, 30])("decodes unknown bit %i correctly", (bit) => {
    const mask = 2 ** bit;
    const decoded = decodeFaults(mask);
    expect(decoded).toEqual([`unknown_bit_${bit}`]);
  });

  it("decodes multiple simultaneous faults sorted lexicographically", () => {
    // Bit 1 (cell_overvoltage) + Bit 7 (discharge_overtemperature) = 2 + 128 = 130
    const decoded = decodeFaults(130);
    expect(decoded).toEqual(["cell_overvoltage", "discharge_overtemperature"]);
  });

  it("decodes a full uint32 mask (4294967295) including all 15 known and 17 unknown bits", () => {
    const decoded = decodeFaults(MAX_UINT32);
    expect(decoded).toHaveLength(32);
    expect(decoded).toContain("cell_undervoltage");
    expect(decoded).toContain("mosfet_overtemperature");
    expect(decoded).toContain("unknown_bit_15");
    expect(decoded).toContain("unknown_bit_31");
    // Verify lexicographical order
    const sortedCopy = [...decoded!].sort();
    expect(decoded).toEqual(sortedCopy);
  });

  it("returns an empty array when error flags is zero (explicitly healthy)", () => {
    expect(decodeFaults(0)).toEqual([]);
  });

  it.each([null, undefined, -1, NaN, Infinity, -Infinity, 4294967296, 1.5])(
    "returns null for invalid/unavailable error flags: %s",
    (invalid) => {
      expect(decodeFaults(invalid as unknown as number)).toBeNull();
    },
  );

  it("checks known fault predicate and bit indexing", () => {
    expect(isKnownFault("cell_undervoltage")).toBe(true);
    expect(isKnownFault("mosfet_overtemperature")).toBe(true);
    expect(isKnownFault("unknown_bit_15")).toBe(false);
    expect(isKnownFault("not_a_fault")).toBe(false);

    expect(getFaultBit("cell_undervoltage")).toBe(0);
    expect(getFaultBit("mosfet_overtemperature")).toBe(14);
    expect(getFaultBit("unknown_bit_31")).toBe(31);
    expect(getFaultBit("invalid_code")).toBeNull();
  });

  it("encodes fault codes into unsigned bitmask", () => {
    expect(encodeFaults(["cell_undervoltage"])).toBe(1);
    expect(
      encodeFaults(["cell_overvoltage", "discharge_overtemperature"]),
    ).toBe(130);
    expect(encodeFaults(["unknown_bit_31"])).toBe(BIT_31_UNSIGNED);
    expect(encodeFaults(["cell_undervoltage", "cell_undervoltage"])).toBe(1);
  });

  it("provides readable fault labels for all 15 known faults", () => {
    expect(Object.keys(FAULT_LABELS)).toHaveLength(15);
    for (const fault of KNOWN_FAULTS) {
      expect(FAULT_LABELS[fault]).toBeDefined();
      expect(typeof FAULT_LABELS[fault]).toBe("string");
    }
  });
});

describe("Libre Solar State & Balancing (lib/libresolar/conversion)", () => {
  it.each([
    [0, "OFF"],
    [1, "CHG"],
    [2, "DIS"],
    [3, "NORMAL"],
    [4, "SHUTDOWN"],
  ])("decodes known BMS state code %i as %s", (code, state) => {
    expect(decodeBmsStateCode(code)).toEqual({ code, state });
  });

  it.each([5, 6, 99, 255])(
    "decodes unknown state code %i as 'unknown'",
    (code) => {
      expect(decodeBmsStateCode(code)).toEqual({ code, state: "unknown" });
    },
  );

  it.each([null, undefined, -1, 256, 1.5, NaN, Infinity])(
    "decodes invalid/unavailable state code %s as null",
    (invalid) => {
      expect(decodeBmsStateCode(invalid as unknown as number)).toEqual({
        code: null,
        state: null,
      });
    },
  );

  it("decodes balancing mask with contiguous hardware channels [0, 1, 2, 3]", () => {
    // Channel 1 active (bit 1 = 2)
    const result = decodeBalancingStatus(2, [0, 1, 2, 3]);
    expect(result.mask).toBe(2);
    expect(result.activeChannels).toEqual([1]);
    expect(result.isBalancingByLogicalCell).toEqual([
      false,
      true,
      false,
      false,
    ]);
  });

  it("decodes balancing mask with non-contiguous channels [0, 1, 2, 15]", () => {
    // Channel 15 active (2^15 = 32768)
    const result = decodeBalancingStatus(32768, [0, 1, 2, 15]);
    expect(result.mask).toBe(32768);
    expect(result.activeChannels).toEqual([15]);
    // Logical cell index 3 corresponds to hardware channel 15
    expect(result.isBalancingByLogicalCell).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it("handles zero and null balancing status cleanly", () => {
    const zero = decodeBalancingStatus(0, [0, 1, 2, 3]);
    expect(zero.mask).toBe(0);
    expect(zero.activeChannels).toEqual([]);
    expect(zero.isBalancingByLogicalCell).toEqual([false, false, false, false]);

    const nullVal = decodeBalancingStatus(null, [0, 1, 2, 3]);
    expect(nullVal.mask).toBeNull();
    expect(nullVal.activeChannels).toEqual([]);
    expect(nullVal.isBalancingByLogicalCell).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("rejects balancing masks outside the unsigned 32-bit source range", () => {
    expect(decodeBalancingStatus(4294967296, [0, 1])).toEqual({
      mask: null,
      activeChannels: [],
      isBalancingByLogicalCell: [false, false],
    });
  });
});

describe("Derived Measurements (lib/libresolar/derived)", () => {
  it("calculates cell voltage delta correctly for balanced cells", () => {
    const result = calculateCellVoltageDelta([3.301, 3.299, 3.305, 3.301]);
    expect(result).toEqual({ value: 0.006, incomplete: false });
  });

  it("calculates cell voltage delta with a dead cell reading 0.0 V", () => {
    const result = calculateCellVoltageDelta([3.3, 0.0, 3.3, 3.3]);
    expect(result).toEqual({ value: 3.3, incomplete: false });
  });

  it("marks cell voltage delta incomplete when an element is null", () => {
    const result = calculateCellVoltageDelta([3.301, null, 3.305, 3.301]);
    expect(result).toEqual({ value: null, incomplete: true });
  });

  it("marks cell voltage delta incomplete for empty array or non-finite values", () => {
    expect(calculateCellVoltageDelta([])).toEqual({
      value: null,
      incomplete: true,
    });
    expect(calculateCellVoltageDelta([3.3, NaN, 3.3])).toEqual({
      value: null,
      incomplete: true,
    });
  });

  it("calculates max battery cell temperature correctly", () => {
    const result = calculateCellTemperatureMax([27.4, 28.1]);
    expect(result).toEqual({ value: 28.1, incomplete: false });
  });

  it("marks max battery cell temperature incomplete if any sensor is null or non-finite", () => {
    expect(calculateCellTemperatureMax([27.4, null])).toEqual({
      value: null,
      incomplete: true,
    });
    expect(calculateCellTemperatureMax([])).toEqual({
      value: null,
      incomplete: true,
    });
    expect(calculateCellTemperatureMax([27.4, Infinity])).toEqual({
      value: null,
      incomplete: true,
    });
  });

  it("calculates max component temperature across supported electronics", () => {
    const result = calculateComponentTemperatureMax([33.1, 35.6]);
    expect(result).toEqual({ value: 35.6, incomplete: false });
  });

  it("marks component max temperature incomplete if any supported component is null", () => {
    const result = calculateComponentTemperatureMax([33.1, null]);
    expect(result).toEqual({ value: null, incomplete: true });
  });
});

describe("Telemetry Normalization (lib/libresolar/conversion)", () => {
  const healthyRaw: RawBmsReadings = {
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
    "Meas/rErrorFlags": 0,
  };

  it("converts healthy discharging readings into contract-compliant measurements", () => {
    const norm = normalizeTelemetry(healthyRaw, profile);

    expect(norm.pack_voltage_reported).toBe(13.21);
    expect(norm.stack_voltage_reported).toBe(13.19);
    expect(norm.pack_current).toBe(-5.0);
    expect(norm.soc).toBe(74.2);
    expect(norm.soh).toBeNull();
    expect(norm.cycle_count).toBeNull();
    expect(norm.cell_voltages).toEqual([3.301, 3.299, 3.305, 3.301]);
    expect(norm.cell_voltage_delta).toBe(0.006);
    expect(norm.cell_temperatures).toEqual([27.4, 28.1]);
    expect(norm.cell_temperature_max).toBe(28.1);
    expect(norm.ic_temperature).toBe(33.1);
    expect(norm.mosfet_temperature).toBe(35.6);
    expect(norm.shunt_temperature).toBeNull();
    expect(norm.component_temperature_max).toBe(35.6);
    expect(norm.bms_state_code).toBe(3);
    expect(norm.bms_state).toBe("NORMAL");
    expect(norm.balancing_mask).toBe(0);
    expect(norm.error_flags).toBe(0);
    expect(norm.faults).toEqual([]);

    expect(norm.quality).toEqual({
      shunt_temperature: "unsupported",
      soh: "unsupported",
      cycle_count: "unsupported",
    });
  });

  it("preserves zero current (0 A) as valid 0 without quality exception", () => {
    const raw: RawBmsReadings = { ...healthyRaw, "Meas/rPackCurrent_A": 0 };
    const norm = normalizeTelemetry(raw, profile);

    expect(norm.pack_current).toBe(0);
    expect(norm.quality.pack_current).toBeUndefined();
  });

  it("marks missing current (null/undefined) as null with quality not_reported", () => {
    const raw: RawBmsReadings = { ...healthyRaw };
    delete raw["Meas/rPackCurrent_A"];
    const norm = normalizeTelemetry(raw, profile);

    expect(norm.pack_current).toBeNull();
    expect(norm.quality.pack_current).toBe("not_reported");
  });

  it("handles partial cell-voltage arrays and pads missing cells with null and quality reasons", () => {
    const raw: RawBmsReadings = {
      ...healthyRaw,
      "Meas/rCellVoltages_V": [3.301, 3.299], // Only 2 cells provided; profile requires 4
    };
    const norm = normalizeTelemetry(raw, profile);

    expect(norm.cell_voltages).toHaveLength(4);
    expect(norm.cell_voltages).toEqual([3.301, 3.299, null, null]);
    expect(norm.quality["cell_voltages[2]"]).toBe("not_reported");
    expect(norm.quality["cell_voltages[3]"]).toBe("not_reported");
    expect(norm.cell_voltage_delta).toBeNull();
    expect(norm.quality.cell_voltage_delta).toBe("incomplete");
  });

  it("handles partial temperature sensor arrays cleanly", () => {
    const raw: RawBmsReadings = {
      ...healthyRaw,
      "Meas/rCellTemps_degC": [27.4, null],
    };
    const norm = normalizeTelemetry(raw, profile, {
      qualityOverrides: { "cell_temperatures[1]": "source_error" },
    });

    expect(norm.cell_temperatures).toEqual([27.4, null]);
    expect(norm.quality["cell_temperatures[1]"]).toBe("source_error");
    expect(norm.cell_temperature_max).toBeNull();
    expect(norm.quality.cell_temperature_max).toBe("incomplete");
  });

  it("marks missing electronics temperatures with not_reported", () => {
    const raw: RawBmsReadings = {
      ...healthyRaw,
      "Meas/rICTemp_degC": null,
      "Meas/rMOSFETTemp_degC": null,
    };
    const norm = normalizeTelemetry(raw, profile);

    expect(norm.ic_temperature).toBeNull();
    expect(norm.mosfet_temperature).toBeNull();
    expect(norm.quality.ic_temperature).toBe("not_reported");
    expect(norm.quality.mosfet_temperature).toBe("not_reported");
    expect(norm.component_temperature_max).toBeNull();
    expect(norm.quality.component_temperature_max).toBe("incomplete");
  });

  it("handles non-finite values and out-of-range SoC", () => {
    const raw: RawBmsReadings = {
      ...healthyRaw,
      "Meas/rPackVoltage_V": NaN,
      "Meas/rSOC_pct": 105, // Out of bounds [0, 100]
    };
    const norm = normalizeTelemetry(raw, profile);

    expect(norm.pack_voltage_reported).toBeNull();
    expect(norm.quality.pack_voltage_reported).toBe("non_finite");
    expect(norm.soc).toBeNull();
    expect(norm.quality.soc).toBe("invalid_type");
  });

  it("distinguishes invalid input types from non-finite numeric readings", () => {
    const raw: RawBmsReadings = {
      ...healthyRaw,
      "Meas/rPackCurrent_A": "5" as unknown as number,
      "Meas/rCellVoltages_V": [3.3, "3.3", 3.3, 3.3] as unknown as number[],
      "Meas/rErrorFlags": "0" as unknown as number,
    };
    const norm = normalizeTelemetry(raw, profile);

    expect(norm.pack_current).toBeNull();
    expect(norm.quality.pack_current).toBe("invalid_type");
    expect(norm.cell_voltages[1]).toBeNull();
    expect(norm.quality["cell_voltages[1]"]).toBe("invalid_type");
    expect(norm.error_flags).toBeNull();
    expect(norm.faults).toBeNull();
    expect(norm.quality.error_flags).toBe("invalid_type");
    expect(norm.quality.faults).toBe("invalid_type");
  });

  it("is deterministic: repeated conversions of identical input produce identical output", () => {
    const norm1 = normalizeTelemetry(healthyRaw, profile);
    const norm2 = normalizeTelemetry(healthyRaw, profile);
    expect(norm1).toEqual(norm2);
  });

  it("does not mutate raw input object or profile object", () => {
    const rawSnapshot = JSON.parse(JSON.stringify(healthyRaw));
    const profileSnapshot = JSON.parse(JSON.stringify(profile));

    normalizeTelemetry(healthyRaw, profile);

    expect(healthyRaw).toEqual(rawSnapshot);
    expect(profile).toEqual(profileSnapshot);
  });
});

describe("Contract Payload Assembly & Validation", () => {
  it("assembles and validates Pair 1 telemetry payload against v1 contract schemas", () => {
    const raw: RawBmsReadings = JSON.parse(
      readFileSync(
        new URL(
          "../../docs/examples/b01/pair1-healthy-discharging.raw.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );

    const measurements = normalizeTelemetry(raw, profile);
    const payload = assembleTelemetryPayload(envelope, measurements);

    const validation = validateMessage("telemetry", payload, {
      profile,
      topic: `libresolar/bms/v1/${payload.node_id}/telemetry`,
    });

    expect(validation.valid).toBe(true);
    if (!validation.valid) {
      console.error("Pair 1 validation issues:", validation.issues);
    }
  });

  it("assembles and validates Pair 2 (overvoltage + overtemp) telemetry payload against v1 contract", () => {
    const raw: RawBmsReadings = JSON.parse(
      readFileSync(
        new URL(
          "../../docs/examples/b01/pair2-fault-overvoltage-overtemp.raw.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );

    const measurements = normalizeTelemetry(raw, profile, {
      qualityOverrides: {
        "cell_temperatures[1]": "source_error",
      },
    });

    const envPair2 = {
      ...envelope,
      sequence: 121,
      message_id: `${envelope.node_id}:${envelope.session_id}:telemetry:121`,
    };
    const payload = assembleTelemetryPayload(envPair2, measurements);

    const validation = validateMessage("telemetry", payload, {
      profile,
      topic: `libresolar/bms/v1/${payload.node_id}/telemetry`,
    });

    expect(validation.valid).toBe(true);
    if (!validation.valid) {
      console.error("Pair 2 validation issues:", validation.issues);
    }
  });

  it("assembles and validates Summary payload against v1 contract", () => {
    const raw: RawBmsReadings = JSON.parse(
      readFileSync(
        new URL(
          "../../docs/examples/b01/pair1-healthy-discharging.raw.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );

    const measurements = normalizeTelemetry(raw, profile);
    const summaryEnv: ProducerEnvelope = {
      ...envelope,
      sequence: 122,
      message_id: `${envelope.node_id}:${envelope.session_id}:summary:122`,
    };

    const summary = assembleSummaryPayload(
      summaryEnv,
      measurements,
      envelope.message_id,
      envelope.observed_at,
    );

    const validation = validateMessage("summary", summary, {
      profile,
      topic: `libresolar/bms/v1/${summary.node_id}/summary`,
    });

    expect(validation.valid).toBe(true);
    if (!validation.valid) {
      console.error("Summary validation issues:", validation.issues);
    }
  });
});
