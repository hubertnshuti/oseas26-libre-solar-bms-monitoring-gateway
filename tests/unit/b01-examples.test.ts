import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  validateMessage,
  type ProfileCapabilities,
  type Summary,
  type Telemetry,
} from "../../lib/contract/index.js";

const profile = JSON.parse(
  readFileSync(
    new URL("../../lib/contract/profiles/demo-lfp-4s-v1.json", import.meta.url),
    "utf8",
  ),
) as ProfileCapabilities;

const readExample = <T>(filename: string): T =>
  JSON.parse(
    readFileSync(
      new URL(`../../docs/examples/b01/${filename}`, import.meta.url),
      "utf8",
    ),
  ) as T;

describe("B01 Documentation Examples Validation", () => {
  it("validates Pair 1 healthy discharging telemetry against the v1 contract", () => {
    const telemetry = readExample<Telemetry>(
      "pair1-healthy-discharging.telemetry.json",
    );
    const result = validateMessage("telemetry", telemetry, {
      profile,
      topic: `libresolar/bms/v1/${telemetry.node_id}/telemetry`,
    });
    expect(result).toEqual({ valid: true, payload: telemetry });
  });

  it("validates Pair 2 fault condition telemetry against the v1 contract", () => {
    const telemetry = readExample<Telemetry>(
      "pair2-fault-overvoltage-overtemp.telemetry.json",
    );
    const result = validateMessage("telemetry", telemetry, {
      profile,
      topic: `libresolar/bms/v1/${telemetry.node_id}/telemetry`,
    });
    expect(result).toEqual({ valid: true, payload: telemetry });
  });

  it("validates sample summary against the v1 contract", () => {
    const summary = readExample<Summary>("sample.summary.json");
    const result = validateMessage("summary", summary, {
      profile,
      topic: `libresolar/bms/v1/${summary.node_id}/summary`,
    });
    expect(result).toEqual({ valid: true, payload: summary });
  });
});
