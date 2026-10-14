import {
  encodeFaults,
  normalizeTelemetry,
  type NormalizedMeasurements,
  type RawBmsReadings,
} from "../../lib/libresolar/index.js";
import type { ProfileCapabilities } from "../../lib/contract/types.js";
import type { DemoBatteryProfile, Scenario } from "./config.js";

export type RandomSource = () => number;

export interface GeneratedObservation {
  observedAt: string;
  raw: RawBmsReadings;
  measurements: NormalizedMeasurements;
}

export function createSeededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GeneratorOptions {
  profile: DemoBatteryProfile;
  scenario: Scenario;
  seed: number;
  random?: RandomSource;
  gapMs?: number;
}

export interface MeasurementGenerator {
  next(observedAt: Date): GeneratedObservation;
  shouldObserve(observedAt: Date): boolean;
  shouldDisconnect(observedAt: Date): boolean;
}

export function createMeasurementGenerator(
  options: GeneratorOptions,
): MeasurementGenerator {
  const { profile, scenario } = options;
  validateScenarioProfile(profile, scenario);
  const random = options.random ?? createSeededRandom(options.seed);
  const capabilities: ProfileCapabilities = {
    source: profile.source,
    cell_count: profile.cell_count,
    cell_channels: profile.cell_channels,
    temperature_sensor_count: profile.temperature_sensor_count,
    temperature_sensor_channels: profile.temperature_sensor_channels,
    supported_fields: profile.supported_fields,
  };
  const cellOffsets = Array.from(
    { length: profile.cell_count },
    (_, index) => (index - (profile.cell_count - 1) / 2) * 0.0015,
  );
  let firstTime: number | undefined;
  let previousTime: number | undefined;
  let elapsedSeconds = 0;
  let soc = 70;

  const elapsedAt = (date: Date): number => {
    if (!Number.isFinite(date.getTime()))
      throw new Error("Invalid observation time");
    firstTime ??= date.getTime();
    return Math.max(0, (date.getTime() - firstTime) / 1000);
  };

  return {
    shouldObserve(observedAt) {
      const elapsed = elapsedAt(observedAt);
      if (scenario !== "connected-but-silent") return true;
      const silenceSeconds = Math.max(5, (options.gapMs ?? 15_000) / 1000 + 1);
      return elapsed < 3 || elapsed >= 3 + silenceSeconds;
    },
    shouldDisconnect(observedAt) {
      const elapsed = elapsedAt(observedAt);
      return (
        scenario === "disconnect-reconnect" && elapsed >= 3 && elapsed < 3.1
      );
    },
    next(observedAt: Date): GeneratedObservation {
      const timestamp = observedAt.getTime();
      if (!Number.isFinite(timestamp))
        throw new Error("Invalid observation time");
      const elapsed =
        previousTime === undefined
          ? 0
          : Math.max(0, (timestamp - previousTime) / 1000);
      previousTime = timestamp;
      elapsedSeconds = elapsedAt(observedAt);

      const current = currentAt(profile, scenario, elapsedSeconds, random);
      soc = Math.min(
        100,
        Math.max(
          0,
          soc + (100 * current * elapsed) / (profile.capacity_ah * 3600),
        ),
      );
      const cellVoltages = cellOffsets.map((offset) =>
        roundTo(
          3.3 +
            offset +
            Math.sin(elapsedSeconds / 60) * 0.001 +
            (random() - 0.5) * 0.001,
          1_000_000,
        ),
      );
      const eventActive = activeBetween(elapsedSeconds, scenario);
      const limits = profile.scenario_limits;
      const overvoltageScenario =
        scenario === "cell-overvoltage" || scenario === "recovery";
      if (eventActive && overvoltageScenario)
        cellVoltages[profile.cell_count - 1] = limits.cell_overvoltage_v + 0.05;
      if (
        scenario === "cell-overvoltage" &&
        elapsedSeconds >= 8 &&
        elapsedSeconds < 9
      )
        cellVoltages[profile.cell_count - 1] = limits.cell_overvoltage_reset_v;
      if (eventActive && scenario === "cell-undervoltage")
        cellVoltages[0] = limits.cell_undervoltage_v - 0.05;
      if (
        scenario === "cell-undervoltage" &&
        elapsedSeconds >= 8 &&
        elapsedSeconds < 9
      )
        cellVoltages[0] = limits.cell_undervoltage_reset_v;
      if (scenario === "recovery" && elapsedSeconds >= 5 && elapsedSeconds < 6)
        cellVoltages[profile.cell_count - 1] = limits.cell_overvoltage_reset_v;
      if (scenario === "increasing-cell-imbalance") {
        const fraction =
          elapsedSeconds < 8
            ? Math.min(1, Math.max(0, (elapsedSeconds - 2) / 6))
            : elapsedSeconds < 12
              ? 1 - (elapsedSeconds - 8) / 4
              : 0;
        cellVoltages[profile.cell_count - 1] =
          (cellVoltages[profile.cell_count - 1] ?? 3.3) + fraction * 0.12;
      }
      const cellSum = cellVoltages.reduce((sum, value) => sum + value, 0);
      const temperatures = Array.from(
        { length: profile.temperature_sensor_count },
        (_, index) =>
          roundTo(
            27 +
              index * 0.7 +
              Math.sin(elapsedSeconds / 180) * 0.2 +
              (random() - 0.5) * 0.2,
            100,
          ),
      );
      const overTemperature = eventActive && scenario === "over-temperature";
      if (overTemperature && temperatures.length > 0) {
        const temperatureLimit =
          current >= 0
            ? limits.charge_overtemperature_degc
            : limits.discharge_overtemperature_degc;
        temperatures[0] = temperatureLimit + 2;
      }
      if (
        scenario === "over-temperature" &&
        elapsedSeconds >= 8 &&
        elapsedSeconds < 9 &&
        temperatures.length > 0
      ) {
        temperatures[0] =
          current >= 0
            ? limits.charge_overtemperature_reset_degc
            : limits.discharge_overtemperature_reset_degc;
      }

      let faultCodes: string[] = [];
      if (eventActive && overvoltageScenario) faultCodes = ["cell_overvoltage"];
      if (eventActive && scenario === "cell-undervoltage")
        faultCodes = ["cell_undervoltage"];
      if (overTemperature)
        faultCodes = [
          current >= 0 ? "charge_overtemperature" : "discharge_overtemperature",
        ];
      const faultMask = encodeFaults(faultCodes);
      const missingReading =
        scenario === "missing-reading" &&
        elapsedSeconds >= 2 &&
        elapsedSeconds < 8;
      const raw: RawBmsReadings = {
        "Meas/rPackVoltage_V": cellSum + 0.01 + (random() - 0.5) * 0.002,
        "Meas/rStackVoltage_V": cellSum - 0.01 + (random() - 0.5) * 0.002,
        "Meas/rPackCurrent_A": missingReading ? null : current,
        "Meas/rSOC_pct": soc,
        "Meas/rCellVoltages_V": cellVoltages,
        "Meas/rCellAvgVoltage_V": cellSum / profile.cell_count,
        "Meas/rCellMinVoltage_V": Math.min(...cellVoltages),
        "Meas/rCellMaxVoltage_V": Math.max(...cellVoltages),
        "Meas/rCellTemps_degC": temperatures,
        "Meas/rICTemp_degC": roundTo(32 + Math.abs(current) * 0.15, 100),
        "Meas/rMOSFETTemp_degC": roundTo(34 + Math.abs(current) * 0.2, 100),
        "Meas/rShuntTemp_degC": null,
        "Meas/rBmsState": 3,
        "Meas/rBalancingStatus": 0,
        "Meas/rErrorFlags": faultMask,
      };
      return {
        observedAt: observedAt.toISOString(),
        raw,
        measurements: normalizeTelemetry(raw, capabilities),
      };
    },
  };
}

function validateScenarioProfile(
  profile: DemoBatteryProfile,
  scenario: Scenario,
): void {
  if (
    ["cell-overvoltage", "cell-undervoltage", "recovery"].includes(scenario) &&
    (profile.cell_count < 1 ||
      !profile.supported_fields.includes("cell_voltages"))
  )
    throw new Error(`${scenario} requires supported configured cell voltages`);
  if (
    scenario === "increasing-cell-imbalance" &&
    (profile.cell_count < 2 ||
      !profile.supported_fields.includes("cell_voltages"))
  )
    throw new Error(
      "increasing-cell-imbalance requires at least two supported cells",
    );
  if (
    scenario === "over-temperature" &&
    (profile.temperature_sensor_count < 1 ||
      !profile.supported_fields.includes("cell_temperatures"))
  )
    throw new Error(
      "over-temperature requires a configured supported battery sensor",
    );
  if (
    scenario === "missing-reading" &&
    !profile.supported_fields.includes("pack_current")
  )
    throw new Error("missing-reading requires supported pack_current");
}

function activeBetween(seconds: number, scenario: Scenario): boolean {
  if (scenario === "recovery") return seconds >= 2 && seconds < 5;
  return seconds >= 2 && seconds < 8;
}

function roundTo(value: number, factor: number): number {
  return Math.round(value * factor) / factor;
}

function currentAt(
  profile: DemoBatteryProfile,
  scenario: Scenario,
  elapsedSeconds: number,
  random: RandomSource,
): number {
  const charge =
    scenario === "normal-charge" ||
    (scenario !== "normal-discharge" &&
      !(scenario === "over-temperature" && elapsedSeconds >= 5) &&
      (scenario === "normal-cycle"
        ? Math.floor(elapsedSeconds / 300) % 2 === 0
        : true));
  const magnitude = charge
    ? profile.scenario_limits.charge_current_a
    : Math.abs(profile.scenario_limits.discharge_current_a);
  return (charge ? 1 : -1) * (magnitude + (random() - 0.5) * 0.2);
}
