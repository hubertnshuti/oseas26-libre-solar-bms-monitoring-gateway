import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSimulatorArgs } from "../../app/simulator/config.js";
import {
  createMeasurementGenerator,
  createSeededRandom,
} from "../../app/simulator/generator.js";
import {
  startTelemetrySchedule,
  TELEMETRY_INTERVAL_MS,
  type TelemetryScheduler,
} from "../../app/simulator/scheduler.js";
import type { DemoBatteryProfile } from "../../app/simulator/config.js";

const profile = JSON.parse(
  readFileSync(
    new URL("../../lib/contract/profiles/demo-lfp-4s-v1.json", import.meta.url),
    "utf8",
  ),
) as DemoBatteryProfile;

function generate(seed: number, times = [0, 1000, 2000, 3000]) {
  const simulator = createMeasurementGenerator({
    profile,
    scenario: "normal-cycle",
    seed,
  });
  return times.map((time) => simulator.next(new Date(time)));
}

describe("B03 normal simulator", () => {
  it("reproduces the same measurement sequence for the same profile, seed and clock", () => {
    expect(generate(187)).toEqual(generate(187));
  });

  it("uses independent seeded variation for different seeds", () => {
    expect(generate(187).map((sample) => sample.raw)).not.toEqual(
      generate(188).map((sample) => sample.raw),
    );
  });

  it("returns profile-sized arrays and B02-normalized measurements", () => {
    const sample = generate(9)[0]!;
    expect(sample.raw["Meas/rCellVoltages_V"]).toHaveLength(4);
    expect(sample.raw["Meas/rCellTemps_degC"]).toHaveLength(2);
    expect(sample.measurements.cell_voltages).toHaveLength(4);
    expect(sample.measurements.cell_temperatures).toHaveLength(2);
    expect(sample.measurements.error_flags).toBe(0);
    expect(sample.measurements.faults).toEqual([]);
    expect(sample.measurements.soh).toBeNull();
    expect(sample.measurements.quality.soh).toBe("unsupported");
  });

  it("models charge and discharge direction and changes direction in normal-cycle", () => {
    const charge = createMeasurementGenerator({
      profile,
      scenario: "normal-charge",
      seed: 2,
    });
    const discharge = createMeasurementGenerator({
      profile,
      scenario: "normal-discharge",
      seed: 2,
    });
    const cycle = createMeasurementGenerator({
      profile,
      scenario: "normal-cycle",
      seed: 2,
    });
    expect(charge.next(new Date(0)).measurements.pack_current).toBeGreaterThan(
      0,
    );
    expect(discharge.next(new Date(0)).measurements.pack_current).toBeLessThan(
      0,
    );
    expect(cycle.next(new Date(0)).measurements.pack_current).toBeGreaterThan(
      0,
    );
    expect(
      cycle.next(new Date(300_000)).measurements.pack_current,
    ).toBeLessThan(0);
  });

  it("accepts an injected random source and clock without using wall-clock scheduling", () => {
    const simulator = createMeasurementGenerator({
      profile,
      scenario: "normal-charge",
      seed: 2,
      random: () => 0.5,
    });
    const first = simulator.next(new Date("2026-01-01T00:00:00.000Z"));
    const second = simulator.next(new Date("2026-01-01T00:00:01.000Z"));
    expect(first.raw["Meas/rPackCurrent_A"]).toBe(5);
    expect(second.measurements.soc).toBeGreaterThan(first.measurements.soc!);
    expect(createSeededRandom(2)()).toBe(createSeededRandom(2)());
  });

  it("rejects an invalid injected observation clock", () => {
    const simulator = createMeasurementGenerator({
      profile,
      scenario: "normal-cycle",
      seed: 2,
    });
    expect(() => simulator.next(new Date(NaN))).toThrow(
      "Invalid observation time",
    );
  });

  it("parses supported CLI options and rejects invalid scenario, node and broker settings", () => {
    expect(
      parseSimulatorArgs([
        "--scenario",
        "normal-discharge",
        "--seed",
        "42",
        "--node-id",
        "53494D0000000042",
        "--broker-url",
        "mqtt://localhost:1883",
      ]),
    ).toMatchObject({
      scenario: "normal-discharge",
      seed: 42,
      nodeId: "53494D0000000042",
      brokerUrl: "mqtt://localhost:1883",
    });
    expect(() => parseSimulatorArgs(["--scenario", "fault"])).toThrow(
      "Invalid --scenario",
    );
    expect(() => parseSimulatorArgs(["--node-id", "bad"])).toThrow(
      "Invalid --node-id",
    );
    expect(() =>
      parseSimulatorArgs(["--broker-url", "http://localhost"]),
    ).toThrow("Invalid --broker-url");
  });

  it("schedules one telemetry callback every contract second and supports clean cancellation", () => {
    let interval: number | undefined;
    let callback: (() => void) | undefined;
    let cancelled = false;
    let ticks = 0;
    const scheduler: TelemetryScheduler = {
      every(next, intervalMs) {
        interval = intervalMs;
        callback = next;
        return () => {
          cancelled = true;
        };
      },
    };
    const stop = startTelemetrySchedule(() => ticks++, scheduler);
    callback?.();
    stop();
    expect(interval).toBe(TELEMETRY_INTERVAL_MS);
    expect(interval).toBe(1000);
    expect(ticks).toBe(1);
    expect(cancelled).toBe(true);
  });
});
