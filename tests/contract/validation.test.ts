import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isAvailability,
  MAX_PAYLOAD_BYTES,
  parseMessage,
  validateMessage,
  type MessageKind,
  type ProfileCapabilities,
  type Telemetry,
} from "../../lib/contract/index.js";

const fixtureRoot = new URL("../fixtures/v1/", import.meta.url);
function read<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(new URL(file, fixtureRoot), "utf8")) as T;
}
const profile = JSON.parse(
  readFileSync(
    new URL("../../lib/contract/profiles/demo-lfp-4s-v1.json", import.meta.url),
    "utf8",
  ),
) as ProfileCapabilities;
const normal = () => read<Telemetry>("valid/normal.telemetry.json");
function kindOf(file: string): MessageKind {
  return file.split(".").at(-2) as MessageKind;
}

describe("version 1 fixtures", () => {
  for (const file of readdirSync(new URL("valid/", fixtureRoot)).filter(
    (file) => file.endsWith(".json"),
  )) {
    it(`accepts ${file}`, () => {
      const result = validateMessage(kindOf(file), read(`valid/${file}`), {
        profile,
      });
      expect(result).toEqual({ valid: true, payload: read(`valid/${file}`) });
    });
  }
  for (const file of readdirSync(new URL("invalid/", fixtureRoot)).filter(
    (file) => file.endsWith(".json"),
  )) {
    it(`rejects ${file}`, () => {
      expect(
        validateMessage(kindOf(file), read(`invalid/${file}`), { profile })
          .valid,
      ).toBe(false);
    });
  }
  it("lists every payload fixture in the manifest", () => {
    const manifest = read<{ valid: string[]; invalid: string[] }>(
      "manifest.json",
    );
    for (const folder of ["valid", "invalid"] as const) {
      const files = readdirSync(new URL(`${folder}/`, fixtureRoot))
        .map((file) => file.replace(/\.json$/, ""))
        .sort();
      expect([...manifest[folder]].sort()).toEqual(files);
    }
  });
});

describe("boundary validation", () => {
  it("rejects a topic/payload node mismatch", () => {
    expect(
      validateMessage("telemetry", normal(), {
        topic: "libresolar/bms/v1/53494D0000000002/telemetry",
      }),
    ).toMatchObject({ valid: false, issues: [{ code: "topic_mismatch" }] });
  });
  it("rejects the wrong topic kind", () => {
    expect(
      validateMessage("telemetry", normal(), {
        topic: "libresolar/bms/v1/53494D0000000001/summary",
      }).valid,
    ).toBe(false);
  });
  it("accepts the documented topic", () => {
    expect(
      validateMessage("telemetry", normal(), {
        topic: "libresolar/bms/v1/53494D0000000001/telemetry",
      }).valid,
    ).toBe(true);
  });
  it.each([NaN, Infinity, -Infinity])(
    "rejects non-finite in-memory numbers: %s",
    (number) => {
      const value = normal();
      value.pack_current = number;
      expect(validateMessage("telemetry", value).valid).toBe(false);
    },
  );
  it("rejects JSON exponent overflow", () => {
    const raw = JSON.stringify(normal()).replace('"soc":74.2', '"soc":1e999');
    expect(parseMessage("telemetry", raw).valid).toBe(false);
  });
  it("rejects malformed JSON", () => {
    expect(parseMessage("telemetry", "{")).toMatchObject({
      valid: false,
      issues: [{ code: "invalid_json" }],
    });
  });
  it("applies the wire byte limit before parsing", () => {
    expect(
      parseMessage("telemetry", " ".repeat(MAX_PAYLOAD_BYTES + 1)),
    ).toMatchObject({ valid: false, issues: [{ code: "payload_too_large" }] });
  });
  it("counts UTF-8 bytes, rather than characters", () => {
    expect(
      parseMessage("telemetry", "é".repeat(MAX_PAYLOAD_BYTES / 2 + 1)),
    ).toMatchObject({ valid: false, issues: [{ code: "payload_too_large" }] });
  });
  it("does not coerce or mutate missing values", () => {
    const value = read("valid/unavailable.telemetry.json");
    const before = structuredClone(value);
    expect(validateMessage("telemetry", value, { profile }).valid).toBe(true);
    expect(value).toEqual(before);
  });
  it("requires profile-specific array lengths", () => {
    const value = normal();
    value.cell_voltages.push(3.3);
    expect(validateMessage("telemetry", value, { profile }).valid).toBe(false);
  });
  it("rejects a temperature array beyond firmware's three-sensor bound", () => {
    const value = normal();
    value.cell_temperatures = [27, 28, 29, 30];
    expect(validateMessage("telemetry", value).valid).toBe(false);
  });
  it("checks balancing against hardware channels instead of logical indices", () => {
    const value = normal();
    value.balancing_mask = 32768;
    const noncontiguous = { ...profile, cell_channels: [0, 1, 2, 15] };
    expect(
      validateMessage("telemetry", value, { profile: noncontiguous }).valid,
    ).toBe(true);
    value.balancing_mask = 8;
    expect(
      validateMessage("telemetry", value, { profile: noncontiguous }).valid,
    ).toBe(false);
  });
  it("rejects a partial sensor set presented as a complete maximum", () => {
    const value = normal();
    value.cell_temperatures[1] = null;
    value.quality["cell_temperatures[1]"] = "source_error";
    expect(validateMessage("telemetry", value).valid).toBe(false);
    value.cell_temperature_max = null;
    value.quality.cell_temperature_max = "incomplete";
    expect(validateMessage("telemetry", value).valid).toBe(true);
  });
  it("rejects unsupported profile fields reported as measurements", () => {
    const value = normal();
    value.shunt_temperature = 35;
    delete value.quality.shunt_temperature;
    expect(validateMessage("telemetry", value, { profile }).valid).toBe(false);
  });
  it("does not accept an arbitrary quality path", () => {
    const value = normal();
    value.quality["cell_voltages[16]"] = "source_error";
    expect(validateMessage("telemetry", value).valid).toBe(false);
  });
  it("rejects a false unknown state", () => {
    const value = normal();
    value.bms_state = "unknown";
    expect(validateMessage("telemetry", value).valid).toBe(false);
  });
  it("keeps firmware aggregates distinct from configured-cell calculations", () => {
    const value = read<Telemetry>("valid/zero-cell.telemetry.json");
    expect(value.cell_voltage_min_reported).toBe(3.299);
    expect(value.cell_voltage_delta).toBe(3.301);
    expect(validateMessage("telemetry", value, { profile }).valid).toBe(true);
  });
  it.each(["online", "offline"])(
    "accepts plain-text availability %s",
    (value) => {
      expect(isAvailability(value)).toBe(true);
    },
  );
  it.each(['"online"', "connected", " online", "ONLINE"])(
    "rejects invalid availability %s",
    (value) => {
      expect(isAvailability(value)).toBe(false);
    },
  );
  it("does not allow a simulated observation to claim a device clock", () => {
    const value = normal();
    value.clock_source = "device";
    expect(validateMessage("telemetry", value).valid).toBe(false);
  });
  it("rejects a receipt with a malformed embedded session UUID", () => {
    const receipt = read<Record<string, any>>(
      "valid/stored.event-receipt.json",
    );
    receipt.event_id = receipt.event_id.replace(
      "15f75ec4-29ab-48ab-93be-81d3e0708a68",
      "------------------------------------",
    );
    receipt.message_id = `${receipt.event_id}:receipt:${receipt.consumer_id}`;
    expect(validateMessage("event-receipt", receipt).valid).toBe(false);
  });
  it("rejects a receipt referencing a counter outside the safe-integer range", () => {
    const receipt = read<Record<string, any>>(
      "valid/stored.event-receipt.json",
    );
    receipt.event_id = receipt.event_id.replace(":123", ":9007199254740992");
    receipt.message_id = `${receipt.event_id}:receipt:${receipt.consumer_id}`;
    expect(validateMessage("event-receipt", receipt).valid).toBe(false);
  });
});

describe("unsigned fault evidence", () => {
  const codes = [
    "cell_undervoltage",
    "cell_overvoltage",
    "short_circuit",
    "discharge_overcurrent",
    "charge_overcurrent",
    "open_wire",
    "discharge_undertemperature",
    "discharge_overtemperature",
    "charge_undertemperature",
    "charge_overtemperature",
    "internal_overtemperature",
    "cell_failure",
    "discharge_switch_off",
    "charge_switch_off",
    "mosfet_overtemperature",
    ...Array.from({ length: 17 }, (_, index) => `unknown_bit_${index + 15}`),
  ];
  it.each(codes.map((code, bit) => ({ code, bit })))(
    "accepts bit $bit as $code",
    ({ code, bit }) => {
      const value = normal();
      value.error_flags = 2 ** bit;
      value.faults = [code];
      expect(validateMessage("telemetry", value).valid).toBe(true);
      value.faults = [];
      expect(validateMessage("telemetry", value).valid).toBe(false);
    },
  );
  it("accepts the full uint32 mask without signed overflow", () => {
    const value = normal();
    value.error_flags = 4294967295;
    value.faults = [...codes].sort();
    expect(validateMessage("telemetry", value).valid).toBe(true);
  });
  it("rejects unsorted decoded faults", () => {
    const value = normal();
    value.error_flags = 130;
    value.faults = ["discharge_overtemperature", "cell_overvoltage"];
    expect(validateMessage("telemetry", value).valid).toBe(false);
  });
});

describe("delivery examples (payload validity, not an implemented ordering engine)", () => {
  it("includes schema-valid duplicate, reordered, and retained-old inputs", () => {
    const cases = read<
      {
        name: string;
        kind: MessageKind;
        files: string[];
        retained: boolean[];
      }[]
    >("delivery-cases.json");
    expect(cases.map((value) => value.name)).toEqual([
      "duplicate event",
      "out-of-order telemetry",
      "retained old summary",
    ]);
    for (const value of cases)
      for (const file of value.files)
        expect(validateMessage(value.kind, read(file), { profile }).valid).toBe(
          true,
        );
    expect(
      cases.find((value) => value.name === "retained old summary")?.retained,
    ).toEqual([true]);
  });
  it("keeps status revisions separate from measurement sequence", () => {
    const status = read<Record<string, unknown>>("valid/fresh.status.json");
    expect(status).not.toHaveProperty("sequence");
    expect(status).not.toHaveProperty("soc");
    expect(validateMessage("status", { ...status, sequence: 120 }).valid).toBe(
      false,
    );
  });
  it("checks read-response examples against the same payload contract", () => {
    const detail = read<{
      data: { attributes: unknown; summary: unknown; status: unknown };
    }>("api/battery-detail.json");
    expect(validateMessage("attributes", detail.data.attributes).valid).toBe(
      true,
    );
    expect(
      validateMessage("summary", detail.data.summary, { profile }).valid,
    ).toBe(true);
    expect(validateMessage("status", detail.data.status).valid).toBe(true);
  });
});
