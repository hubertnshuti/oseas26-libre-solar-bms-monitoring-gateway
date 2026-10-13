import {
  normalizeTelemetry,
  type RawBmsReadings,
} from "../../lib/libresolar/index.js";
import type { ProfileCapabilities } from "../../lib/contract/types.js";
import type { DemoBatteryProfile, Scenario } from "./config.js";

export type RandomSource = () => number;

export interface GeneratedObservation {
  observedAt: string;
  raw: RawBmsReadings;
  measurements: ReturnType<typeof normalizeTelemetry>;
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
}

export interface MeasurementGenerator {
  next(observedAt: Date): GeneratedObservation;
}

export function createMeasurementGenerator(
  options: GeneratorOptions,
): MeasurementGenerator {
  const { profile, scenario } = options;
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
  let previousTime: number | undefined;
  let elapsedSeconds = 0;
  let soc = 70;

  return {
    next(observedAt: Date): GeneratedObservation {
      const timestamp = observedAt.getTime();
      if (!Number.isFinite(timestamp))
        throw new Error("Invalid observation time");
      const elapsed =
        previousTime === undefined
          ? 0
          : Math.max(0, (timestamp - previousTime) / 1000);
      previousTime = timestamp;
      elapsedSeconds += elapsed;

      const current = currentAt(profile, scenario, elapsedSeconds, random);
      soc = Math.min(
        100,
        Math.max(
          0,
          soc + (100 * current * elapsed) / (profile.capacity_ah * 3600),
        ),
      );
      const cycleOffset =
        scenario === "normal-cycle" ? Math.sin(elapsedSeconds / 60) * 0.001 : 0;
      const cellVoltages = cellOffsets.map((offset) =>
        roundTo(
          3.3 + offset + cycleOffset + (random() - 0.5) * 0.001,
          1_000_000,
        ),
      );
      const cellSum = cellVoltages.reduce((sum, value) => sum + value, 0);
      const cellTemperatures = Array.from(
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
      const raw: RawBmsReadings = {
        "Meas/rPackVoltage_V": cellSum + 0.01 + (random() - 0.5) * 0.002,
        "Meas/rStackVoltage_V": cellSum - 0.01 + (random() - 0.5) * 0.002,
        "Meas/rPackCurrent_A": current,
        "Meas/rSOC_pct": soc,
        "Meas/rCellVoltages_V": cellVoltages,
        "Meas/rCellAvgVoltage_V": cellSum / profile.cell_count,
        "Meas/rCellMinVoltage_V": Math.min(...cellVoltages),
        "Meas/rCellMaxVoltage_V": Math.max(...cellVoltages),
        "Meas/rCellTemps_degC": cellTemperatures,
        "Meas/rICTemp_degC": roundTo(32 + Math.abs(current) * 0.15, 100),
        "Meas/rMOSFETTemp_degC": roundTo(34 + Math.abs(current) * 0.2, 100),
        "Meas/rShuntTemp_degC": null,
        "Meas/rBmsState": 3,
        "Meas/rBalancingStatus": 0,
        "Meas/rErrorFlags": 0,
      };
      return {
        observedAt: observedAt.toISOString(),
        raw,
        measurements: normalizeTelemetry(raw, capabilities),
      };
    },
  };
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
    (scenario === "normal-cycle" && Math.floor(elapsedSeconds / 300) % 2 === 0);
  const magnitude = charge
    ? profile.scenario_limits.charge_current_a
    : Math.abs(profile.scenario_limits.discharge_current_a);
  return (charge ? 1 : -1) * (magnitude + (random() - 0.5) * 0.2);
}
