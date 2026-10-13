/**
 * Libre Solar Normalization & Conversion Library
 *
 * Public entry point for:
 * - Fault decoding (15 known bits + bits 15–31 unsigned)
 * - Derived metrics (delta, max cell temp, max component temp)
 * - Telemetry & summary conversion
 */

export * from "./faults.js";
export * from "./derived.js";
export * from "./conversion.js";
