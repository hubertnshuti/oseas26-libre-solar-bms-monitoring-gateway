import { describe, expect, it } from "vitest";
import { decodeFaults } from "../../lib/libresolar/faults.js";
import type { Telemetry } from "../../lib/contract/types.js";
import { FaultEventDetector } from "../../lib/publisher/events.js";

const baseTime = Date.parse("2026-10-14T00:00:00.000Z");
const telemetry = (seconds: number, errorFlags: number | null): Telemetry => {
  const session = "15f75ec4-29ab-48ab-93be-81d3e0708a68";
  const sequence = seconds + 1;
  return {
    schema_version: 1,
    node_id: "53494D0000000001",
    source: "simulator",
    session_id: session,
    sequence,
    message_id: `53494D0000000001:${session}:telemetry:${sequence}`,
    observed_at: new Date(baseTime + seconds * 1000).toISOString(),
    published_at: new Date(baseTime + seconds * 1000).toISOString(),
    clock_source: "simulator_host",
    pack_voltage_reported: 13.2,
    stack_voltage_reported: 13.2,
    pack_current: 0,
    soc: 70,
    cell_voltage_min_reported: 3.3,
    cell_voltage_max_reported: 3.3,
    cell_voltage_avg_reported: 3.3,
    cell_voltages: [3.3, 3.3, 3.3, 3.3],
    cell_voltage_delta: 0,
    cell_temperatures: [27, 27],
    cell_temperature_max: 27,
    ic_temperature: 32,
    mosfet_temperature: 34,
    shunt_temperature: null,
    component_temperature_max: 34,
    bms_state_code: 3,
    bms_state: "NORMAL",
    balancing_mask: 0,
    error_flags: errorFlags,
    faults: decodeFaults(errorFlags),
    soh: null,
    cycle_count: null,
    quality: {},
  };
};

describe("observation-based fault event detection", () => {
  it("reports a first observed active fault and preserves unknown bit 31", () => {
    const detector = new FaultEventDetector();
    const event = detector.observe(telemetry(0, 2 ** 31));
    expect(event).toMatchObject({
      kind: "fault_observed",
      previousErrorFlags: null,
      currentErrorFlags: 2 ** 31,
      faults: ["unknown_bit_31"],
      addedFaults: ["unknown_bit_31"],
      clearedFaults: [],
    });
  });

  it("distinguishes known zero from unavailable mask and never invents a clear", () => {
    const detector = new FaultEventDetector();
    expect(detector.observe(telemetry(0, 0))).toBeUndefined();
    expect(detector.observe(telemetry(1, 2))).toMatchObject({
      kind: "fault_changed",
      previousErrorFlags: 0,
      addedFaults: ["cell_overvoltage"],
    });

    expect(detector.observe(telemetry(2, null))).toBeUndefined();
    expect(detector.observe(telemetry(3, 0))).toBeUndefined();
    expect(detector.observe(telemetry(4, 1))).toMatchObject({
      kind: "fault_changed",
      previousErrorFlags: 0,
      currentErrorFlags: 1,
    });
  });

  it("reports observed recovery with exact cleared faults", () => {
    const detector = new FaultEventDetector();
    detector.observe(telemetry(0, 0));
    detector.observe(telemetry(1, 3));
    expect(detector.observe(telemetry(2, 1))).toMatchObject({
      kind: "fault_changed",
      previousErrorFlags: 3,
      currentErrorFlags: 1,
      addedFaults: [],
      clearedFaults: ["cell_overvoltage"],
    });
    expect(detector.observe(telemetry(3, 0))).toMatchObject({
      kind: "fault_changed",
      previousErrorFlags: 1,
      currentErrorFlags: 0,
      clearedFaults: ["cell_undervoltage"],
    });
  });

  it("emits an observation gap without asserting transitions during it", () => {
    const detector = new FaultEventDetector(2000);
    detector.observe(telemetry(0, 2));
    const gap = detector.observe(telemetry(5, 0));
    expect(gap).toMatchObject({
      kind: "observation_gap",
      previousErrorFlags: null,
      currentErrorFlags: 0,
      faults: [],
      addedFaults: [],
      clearedFaults: [],
    });
    expect(detector.observe(telemetry(6, 0))).toBeUndefined();
  });
});
