/**
 * Libre Solar BMS Fault Decoding
 *
 * Implements unsigned 32-bit bitmask decoding for the 15 known Libre Solar
 * firmware fault flags and unknown bits 15–31 in accordance with the v1 contract.
 */

export const KNOWN_FAULTS = [
  "cell_undervoltage", // bit 0
  "cell_overvoltage", // bit 1
  "short_circuit", // bit 2
  "discharge_overcurrent", // bit 3
  "charge_overcurrent", // bit 4
  "open_wire", // bit 5
  "discharge_undertemperature", // bit 6
  "discharge_overtemperature", // bit 7
  "charge_undertemperature", // bit 8
  "charge_overtemperature", // bit 9
  "internal_overtemperature", // bit 10
  "cell_failure", // bit 11
  "discharge_switch_off", // bit 12
  "charge_switch_off", // bit 13
  "mosfet_overtemperature", // bit 14
] as const;

export type KnownFaultCode = (typeof KNOWN_FAULTS)[number];

/**
 * Plain-English fault labels for operator dashboards.
 */
export const FAULT_LABELS: Readonly<Record<KnownFaultCode, string>> = {
  cell_undervoltage: "Cell Undervoltage",
  cell_overvoltage: "Cell Overvoltage",
  short_circuit: "Short Circuit",
  discharge_overcurrent: "Discharge Overcurrent",
  charge_overcurrent: "Charge Overcurrent",
  open_wire: "Open Sense Wire",
  discharge_undertemperature: "Discharge Undertemperature",
  discharge_overtemperature: "Discharge Overtemperature",
  charge_undertemperature: "Charge Undertemperature",
  charge_overtemperature: "Charge Overtemperature",
  internal_overtemperature: "AFE IC Internal Overtemperature",
  cell_failure: "Cell Failure",
  discharge_switch_off: "Discharge Switch Forced Off",
  charge_switch_off: "Charge Switch Forced Off",
  mosfet_overtemperature: "MOSFET Power Switch Overtemperature",
};

export const MAX_UINT32 = 4294967295;
export const BIT_31_UNSIGNED = 2147483648;

/**
 * Decodes an unsigned 32-bit error flags bitmask into contract-compliant,
 * lexicographically sorted fault codes.
 *
 * Requirements:
 * - Unsigned 32-bit arithmetic avoids JavaScript signed bitwise truncation (bit 31 evaluates to 2147483648).
 * - Null or invalid masks return null.
 * - Mask of 0 returns empty array [] (explicitly healthy / no active faults).
 * - Unknown bits 15–31 are formatted as "unknown_bit_N".
 * - Results are lexicographically sorted.
 */
export function decodeFaults(mask: number | null | undefined): string[] | null {
  if (
    mask === null ||
    mask === undefined ||
    !Number.isSafeInteger(mask) ||
    mask < 0 ||
    mask > MAX_UINT32
  ) {
    return null;
  }

  if (mask === 0) {
    return [];
  }

  const codes: string[] = [];
  for (let bit = 0; bit < 32; bit++) {
    // Math.floor(mask / 2 ** bit) % 2 === 1 handles all bits up to bit 31 without signed overflow
    if (Math.floor(mask / 2 ** bit) % 2 === 1) {
      const code = bit < KNOWN_FAULTS.length ? KNOWN_FAULTS[bit] : undefined;
      codes.push(code ?? `unknown_bit_${bit}`);
    }
  }

  return codes.sort();
}

/**
 * Checks whether a given string is one of the 15 known Libre Solar fault codes.
 */
export function isKnownFault(code: string): code is KnownFaultCode {
  return (KNOWN_FAULTS as readonly string[]).includes(code);
}

/**
 * Returns the bit index (0..31) for a given fault code, or null if unrecognized.
 */
export function getFaultBit(code: string): number | null {
  const index = KNOWN_FAULTS.indexOf(code as KnownFaultCode);
  if (index !== -1) return index;

  const match = /^unknown_bit_(\d+)$/.exec(code);
  if (match) {
    const bit = Number(match[1]);
    if (bit >= 15 && bit <= 31) return bit;
  }

  return null;
}

/**
 * Encodes an array of fault codes into an unsigned 32-bit integer mask.
 * Unknown codes outside the contract definition are ignored.
 */
export function encodeFaults(codes: readonly string[]): number {
  let mask = 0;
  for (const code of codes) {
    const bit = getFaultBit(code);
    if (bit !== null && Math.floor(mask / 2 ** bit) % 2 === 0) {
      mask += 2 ** bit;
    }
  }
  return mask;
}
