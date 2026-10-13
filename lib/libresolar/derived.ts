/**
 * Libre Solar BMS Derived Measurements
 *
 * Implements pure calculations for:
 * - cell_voltage_delta
 * - cell_temperature_max
 * - component_temperature_max
 *
 * In accordance with strict v1 contract quality rules:
 * - Any missing or non-finite reading in an active set marks the derived value incomplete.
 * - Real numerical zero readings are legitimate observations and not treated as missing.
 * - Floating-point tolerances are handled cleanly.
 */

export interface DerivedCalculationResult {
  value: number | null;
  incomplete: boolean;
}

/**
 * Calculates cell voltage delta (max minus min across configured valid cells).
 *
 * Rules:
 * - Returns `{ value: null, incomplete: true }` if cells is empty or contains null/non-finite entries.
 * - Real 0 V is a valid observation (e.g., dead/shorted cell).
 * - Applies clean 6-decimal rounding to eliminate IEEE 754 floating-point subtraction artifacts.
 */
export function calculateCellVoltageDelta(
  cellVoltages: readonly (number | null)[],
): DerivedCalculationResult {
  if (
    !cellVoltages.length ||
    cellVoltages.some(
      (v) => v === null || typeof v !== "number" || !Number.isFinite(v),
    )
  ) {
    return { value: null, incomplete: true };
  }

  const nums = cellVoltages as readonly number[];
  const max = Math.max(...nums);
  const min = Math.min(...nums);
  const delta = Math.round((max - min) * 1e6) / 1e6;

  return { value: delta, incomplete: false };
}

/**
 * Calculates the maximum battery cell temperature across configured sensors.
 *
 * Rules:
 * - Returns `{ value: null, incomplete: true }` if sensors array is empty or contains null/non-finite entries.
 * - Preserves numeric precision up to 2 decimal places.
 */
export function calculateCellTemperatureMax(
  cellTemps: readonly (number | null)[],
): DerivedCalculationResult {
  if (
    !cellTemps.length ||
    cellTemps.some(
      (t) => t === null || typeof t !== "number" || !Number.isFinite(t),
    )
  ) {
    return { value: null, incomplete: true };
  }

  const nums = cellTemps as readonly number[];
  const max = Math.round(Math.max(...nums) * 1e2) / 1e2;

  return { value: max, incomplete: false };
}

/**
 * Calculates the maximum component temperature across supported electronics sensors
 * (IC die temperature, power MOSFET switch temperature, and shunt temperature if supported).
 *
 * Rules:
 * - Sensors unsupported by the profile are excluded from this calculation by caller.
 * - If any supported component is missing (null or non-finite), the result is incomplete.
 */
export function calculateComponentTemperatureMax(
  componentTemps: readonly (number | null)[],
): DerivedCalculationResult {
  if (
    !componentTemps.length ||
    componentTemps.some(
      (t) => t === null || typeof t !== "number" || !Number.isFinite(t),
    )
  ) {
    return { value: null, incomplete: true };
  }

  const nums = componentTemps as readonly number[];
  const max = Math.round(Math.max(...nums) * 1e2) / 1e2;

  return { value: max, incomplete: false };
}
