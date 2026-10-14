import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMeasurementGenerator } from "../../app/simulator/generator.js";
import type {
  DemoBatteryProfile,
  Scenario,
} from "../../app/simulator/config.js";

const profile = JSON.parse(
  readFileSync(
    new URL("../../lib/contract/profiles/demo-lfp-4s-v1.json", import.meta.url),
    "utf8",
  ),
) as DemoBatteryProfile;
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 14, 0, 0, seconds));
const scenarios: Scenario[] = [
  "normal-cycle",
  "normal-charge",
  "normal-discharge",
  "cell-overvoltage",
  "cell-undervoltage",
  "over-temperature",
  "increasing-cell-imbalance",
  "missing-reading",
  "connected-but-silent",
  "disconnect-reconnect",
  "recovery",
];

describe("B04 deterministic scenario behavior", () => {
  it.each(scenarios)("has predictable observations for %s", (scenario) => {
    const left = createMeasurementGenerator({ profile, scenario, seed: 4 });
    const right = createMeasurementGenerator({ profile, scenario, seed: 4 });
    const first = left.next(at(0));
    const repeated = right.next(at(0));
    expect(first).toEqual(repeated);
    expect(first.measurements.cell_voltages).toHaveLength(profile.cell_count);
    expect(first.measurements.cell_temperatures).toHaveLength(
      profile.temperature_sensor_count,
    );
  });

  it("crosses and recovers cell fault thresholds from profile settings", () => {
    const high = createMeasurementGenerator({
      profile,
      scenario: "cell-overvoltage",
      seed: 2,
    });
    high.next(at(0));
    const over = high.next(at(2));
    expect(over.raw["Meas/rCellVoltages_V"]?.[3]).toBeCloseTo(3.7);
    expect(over.measurements.error_flags).toBe(2);
    const recoveredHigh = high.next(at(8));
    expect(recoveredHigh.measurements.error_flags).toBe(0);
    expect(recoveredHigh.measurements.cell_voltages[3]).toBe(3.5);

    const low = createMeasurementGenerator({
      profile,
      scenario: "cell-undervoltage",
      seed: 2,
    });
    low.next(at(0));
    const under = low.next(at(2));
    expect(under.raw["Meas/rCellVoltages_V"]?.[0]).toBe(2.75);
    expect(under.measurements.error_flags).toBe(1);
    const recoveredLow = low.next(at(8));
    expect(recoveredLow.measurements.error_flags).toBe(0);
    expect(recoveredLow.measurements.cell_voltages[0]).toBe(3);
  });

  it("maps over-temperature flags to charge and discharge conditions", () => {
    const generator = createMeasurementGenerator({
      profile,
      scenario: "over-temperature",
      seed: 3,
    });
    generator.next(at(0));
    const charging = generator.next(at(2));
    expect(charging.measurements.error_flags).toBe(512);
    expect(charging.measurements.cell_temperatures[0]).toBe(47);
    const discharging = generator.next(at(5));
    expect(discharging.measurements.error_flags).toBe(128);
    expect(discharging.measurements.cell_temperatures[0]).toBe(62);
    const recovered = generator.next(at(8));
    expect(recovered.measurements.error_flags).toBe(0);
    expect(recovered.measurements.cell_temperatures[0]).toBe(57);
  });

  it("increases cell imbalance without inventing a fault", () => {
    const generator = createMeasurementGenerator({
      profile,
      scenario: "increasing-cell-imbalance",
      seed: 5,
    });
    const baseline = generator.next(at(0)).measurements.cell_voltage_delta;
    const growing = generator.next(at(4)).measurements.cell_voltage_delta;
    const maximum = generator.next(at(8)).measurements.cell_voltage_delta;
    expect(growing).toBeGreaterThan(baseline!);
    expect(maximum).toBeGreaterThan(growing!);
    expect(generator.next(at(12)).measurements.cell_voltage_delta).toBeLessThan(
      maximum!,
    );
    expect(generator.next(at(13)).measurements.faults).toEqual([]);
  });

  it("keeps a missing current unknown and restores it after the scenario", () => {
    const generator = createMeasurementGenerator({
      profile,
      scenario: "missing-reading",
      seed: 6,
    });
    generator.next(at(0));
    const missing = generator.next(at(3));
    expect(missing.raw["Meas/rPackCurrent_A"]).toBeNull();
    expect(missing.measurements.pack_current).toBeNull();
    expect(missing.measurements.quality.pack_current).toBe("not_reported");
    expect(generator.next(at(8)).measurements.pack_current).not.toBeNull();
  });

  it("models connected silence and a deterministic disconnect point", () => {
    const silent = createMeasurementGenerator({
      profile,
      scenario: "connected-but-silent",
      seed: 1,
      gapMs: 2000,
    });
    expect(silent.shouldObserve(at(0))).toBe(true);
    expect(silent.shouldObserve(at(4))).toBe(false);
    expect(silent.shouldObserve(at(9))).toBe(true);
    const disconnected = createMeasurementGenerator({
      profile,
      scenario: "disconnect-reconnect",
      seed: 1,
    });
    expect(disconnected.shouldDisconnect(at(0))).toBe(false);
    expect(disconnected.shouldDisconnect(at(3))).toBe(true);
  });

  it("preserves logical cell ordering for a non-contiguous channel profile", () => {
    const custom = {
      ...profile,
      cell_channels: [0, 2, 5, 9],
    };
    const sample = createMeasurementGenerator({
      profile: custom,
      scenario: "cell-overvoltage",
      seed: 8,
    }).next(at(0));
    expect(sample.measurements.cell_voltages).toHaveLength(4);
    expect(sample.measurements.balancing_mask).toBe(0);
  });
});
