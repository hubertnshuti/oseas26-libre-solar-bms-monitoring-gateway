import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { default as formats } from "ajv-formats";
import type { AnySchema, ValidateFunction } from "ajv";
import type { MessageKind, Payloads, ProfileCapabilities } from "./types.js";

export const MAX_PAYLOAD_BYTES = 32 * 1024;
export const MESSAGE_KINDS: readonly MessageKind[] = [
  "telemetry",
  "summary",
  "event",
  "attributes",
  "status",
  "event-receipt",
];
export interface ValidationIssue {
  path: string;
  code: string;
}
export type ValidationResult<K extends MessageKind> =
  | { valid: true; payload: Payloads[K] }
  | { valid: false; issues: ValidationIssue[] };
export interface ValidationOptions {
  topic?: string;
  profile?: ProfileCapabilities;
}

const ajv = new Ajv2020({ strict: true, allErrors: true });
// CommonJS package exports a callable default under Node ESM.
const addFormats = formats as unknown as (instance: Ajv2020) => void;
addFormats(ajv);
function loadSchema(name: string): AnySchema {
  return JSON.parse(
    readFileSync(
      new URL(`schema/${name}.schema.json`, import.meta.url),
      "utf8",
    ),
  ) as AnySchema;
}
ajv.addSchema(loadSchema("common"));
const validators = Object.fromEntries(
  MESSAGE_KINDS.map((kind) => [kind, ajv.compile(loadSchema(kind))]),
) as Record<MessageKind, ValidateFunction>;
const knownFields = Object.keys(
  JSON.parse(readFileSync(new URL("fields.json", import.meta.url), "utf8"))
    .fields,
) as string[];
const knownFaults = [
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
];
const states = ["OFF", "CHG", "DIS", "NORMAL", "SHUTDOWN"];
const suffixes: Record<MessageKind, string> = {
  telemetry: "telemetry",
  summary: "summary",
  event: "events",
  attributes: "attributes",
  status: "status",
  "event-receipt": "receipts/mpm",
};

function decoded(mask: number | null): string[] | null {
  if (mask === null) return null;
  const codes: string[] = [];
  for (let bit = 0; bit < 32; bit++) {
    if (Math.floor(mask / 2 ** bit) % 2 === 1)
      codes.push(knownFaults[bit] ?? `unknown_bit_${bit}`);
  }
  return codes.sort();
}
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Validates JSON shape plus cross-field rules; it does not implement delivery ordering. */
export function validateMessage<K extends MessageKind>(
  kind: K,
  value: unknown,
  options: ValidationOptions = {},
): ValidationResult<K> {
  const issues: ValidationIssue[] = [];
  const reject = (path: string, code: string) => {
    issues.push({ path, code });
  };
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) reject("", "not_json");
    else if (Buffer.byteLength(encoded, "utf8") > MAX_PAYLOAD_BYTES)
      reject("", "payload_too_large");
  } catch {
    reject("", "not_json");
  }
  if (issues.length) return { valid: false, issues };
  const schemaValidate = validators[kind];
  if (!schemaValidate(value))
    return {
      valid: false,
      issues: (schemaValidate.errors ?? []).map((error) => ({
        path: error.instancePath,
        code: error.keyword,
      })),
    };
  // The schema has established the object shape before semantic checks.
  const p = value as Record<string, any>;
  if (
    options.topic &&
    options.topic !== `libresolar/bms/v1/${p.node_id}/${suffixes[kind]}`
  )
    reject("/node_id", "topic_mismatch");
  if (options.profile && p.source !== options.profile.source)
    reject("/source", "profile_mismatch");
  if (["telemetry", "summary", "event", "attributes"].includes(kind)) {
    if (
      p.message_id !==
      `${p.node_id}:${p.session_id}:${suffixes[kind]}:${p.sequence}`
    )
      reject("/message_id", "identity_mismatch");
    if (Date.parse(p.published_at) < Date.parse(p.observed_at))
      reject("/published_at", "before_observation");
    if (p.source === "simulator" && p.clock_source !== "simulator_host")
      reject("/clock_source", "source_mismatch");
    if (p.source === "hardware" && p.clock_source === "simulator_host")
      reject("/clock_source", "source_mismatch");
  }
  if (kind === "summary" || kind === "event") {
    const prefix = `${p.node_id}:${p.session_id}:telemetry:`;
    if (
      !p.telemetry_message_id.startsWith(prefix) ||
      !Number.isSafeInteger(
        Number(p.telemetry_message_id.slice(prefix.length)),
      ) ||
      Number(p.telemetry_message_id.slice(prefix.length)) >= p.sequence
    )
      reject("/telemetry_message_id", "invalid_sample_reference");
  }
  if (kind === "summary" && p.last_source_observed_at !== p.observed_at)
    reject("/last_source_observed_at", "observation_mismatch");
  if (kind === "telemetry" || kind === "summary") {
    const quality = p.quality as Record<string, string>;
    for (const field of knownFields.filter((field) => field in p)) {
      const reading = p[field];
      if (reading === null && !quality[field])
        reject(`/${field}`, "missing_quality");
      if (reading !== null && !Array.isArray(reading) && quality[field])
        reject(`/quality/${field}`, "quality_on_present_value");
      if (Array.isArray(reading) && field !== "faults") {
        reading.forEach((item, index) => {
          if (item === null && !quality[`${field}[${index}]`])
            reject(`/${field}/${index}`, "missing_quality");
        });
      }
    }
    for (const [path, reason] of Object.entries(quality)) {
      const match = /^([a-z_]+)(?:\[(\d+)\])?$/.exec(path);
      const field = match?.[1];
      const index = match?.[2];
      if (!field || !knownFields.includes(field) || !(field in p)) {
        reject(`/quality/${path}`, "unknown_quality_path");
        continue;
      }
      if (index !== undefined) {
        if (
          !Array.isArray(p[field]) ||
          Number(index) >= p[field].length ||
          p[field][Number(index)] !== null
        )
          reject(`/quality/${path}`, "quality_on_present_value");
      } else if (
        Array.isArray(p[field]) &&
        (reason !== "incomplete" || !p[field].includes(null))
      )
        reject(`/quality/${path}`, "invalid_array_quality");
    }
    if (quality.soh !== "unsupported" || quality.cycle_count !== "unsupported")
      reject("/quality", "unsupported_firmware_field");
    if (!same(p.faults, decoded(p.error_flags)))
      reject("/faults", "mask_mismatch");
    const state =
      p.bms_state_code === null
        ? null
        : (states[p.bms_state_code] ?? "unknown");
    if (p.bms_state !== state) reject("/bms_state", "state_mismatch");
    if (options.profile) {
      for (const field of knownFields.filter((field) => field in p)) {
        if (
          !options.profile.supported_fields.includes(field) &&
          (p[field] !== null || quality[field] !== "unsupported")
        )
          reject(`/${field}`, "unsupported_profile_field");
        if (
          options.profile.supported_fields.includes(field) &&
          quality[field] === "unsupported"
        )
          reject(`/quality/${field}`, "profile_mismatch");
      }
    }
  }
  if (kind === "telemetry") {
    const cells = p.cell_voltages as (number | null)[];
    const temperatures = p.cell_temperatures as (number | null)[];
    if (options.profile && cells.length !== options.profile.cell_count)
      reject("/cell_voltages", "profile_count_mismatch");
    if (
      options.profile &&
      temperatures.length !== options.profile.temperature_sensor_count
    )
      reject("/cell_temperatures", "profile_count_mismatch");
    const checkDerived = (
      name: string,
      entries: (number | null)[],
      delta = false,
    ) => {
      if (!entries.length || entries.includes(null)) {
        if (p[name] !== null) reject(`/${name}`, "incomplete_derived_value");
        return;
      }
      const numbers = entries as number[];
      const expected =
        Math.max(...numbers) - (delta ? Math.min(...numbers) : 0);
      if (p[name] === null || Math.abs(p[name] - expected) > 1e-9)
        reject(`/${name}`, "derived_value_mismatch");
    };
    checkDerived("cell_voltage_delta", cells, true);
    checkDerived("cell_temperature_max", temperatures);
    const components = [
      "ic_temperature",
      "mosfet_temperature",
      "shunt_temperature",
    ]
      .filter((field) => p.quality[field] !== "unsupported")
      .map((field) => p[field] as number | null);
    checkDerived("component_temperature_max", components);
    if (options.profile && p.balancing_mask !== null) {
      const active = options.profile.cell_channels.reduce(
        (mask, channel) => mask + 2 ** channel,
        0,
      );
      for (let bit = 0; bit < 32; bit++)
        if (
          Math.floor(p.balancing_mask / 2 ** bit) % 2 &&
          !(Math.floor(active / 2 ** bit) % 2)
        )
          reject("/balancing_mask", "inactive_channel");
    }
  }
  if (kind === "event") {
    if (p.event_id !== p.message_id) reject("/event_id", "identity_mismatch");
    const current = decoded(p.current_error_flags);
    const previous = decoded(p.previous_error_flags);
    if (!same(p.faults, current)) reject("/faults", "mask_mismatch");
    if (p.kind === "fault_changed") {
      if (
        current === null ||
        previous === null ||
        p.current_error_flags === p.previous_error_flags
      )
        reject("/kind", "invalid_transition");
      else {
        if (
          !same(
            p.added_faults,
            current.filter((code) => !previous.includes(code)),
          )
        )
          reject("/added_faults", "transition_mismatch");
        if (
          !same(
            p.cleared_faults,
            previous.filter((code) => !current.includes(code)),
          )
        )
          reject("/cleared_faults", "transition_mismatch");
      }
    } else if (p.kind === "fault_observed") {
      if (
        p.previous_error_flags !== null ||
        !current?.length ||
        !same(p.added_faults, current) ||
        p.cleared_faults.length
      )
        reject("/kind", "invalid_first_observation");
    } else if (
      p.previous_error_flags !== null ||
      p.added_faults.length ||
      p.cleared_faults.length
    )
      reject("/kind", "invented_gap_transition");
  }
  if (kind === "attributes") {
    if (p.cell_count !== p.cell_channels.length)
      reject("/cell_count", "channel_count_mismatch");
    if (p.temperature_sensor_count !== p.temperature_sensor_channels.length)
      reject("/temperature_sensor_count", "channel_count_mismatch");
    if (
      p.supported_fields.includes("soh") ||
      p.supported_fields.includes("cycle_count")
    )
      reject("/supported_fields", "unsupported_firmware_field");
    if ((p.source === "simulator") !== (p.simulation_time_factor !== null))
      reject("/simulation_time_factor", "source_mismatch");
  }
  if (kind === "status") {
    if (
      p.message_id !==
      `${p.node_id}:${p.adapter_id}:status:${p.status_revision}`
    )
      reject("/message_id", "identity_mismatch");
    if (p.source_status === "fresh" && p.last_source_observed_at === null)
      reject("/last_source_observed_at", "missing_fresh_observation");
    if (
      p.last_source_observed_at !== null &&
      Date.parse(p.last_source_observed_at) > Date.parse(p.status_checked_at)
    )
      reject("/status_checked_at", "before_observation");
  }
  if (kind === "event-receipt") {
    const eventSequence = Number(p.event_id.split(":").at(-1));
    if (
      !p.event_id.startsWith(`${p.node_id}:`) ||
      !p.event_id.includes(":events:") ||
      !Number.isSafeInteger(eventSequence)
    )
      reject("/event_id", "identity_mismatch");
    if (p.message_id !== `${p.event_id}:receipt:${p.consumer_id}`)
      reject("/message_id", "identity_mismatch");
  }
  return issues.length
    ? { valid: false, issues }
    : { valid: true, payload: value as Payloads[K] };
}

/** Apply the byte limit before parsing MQTT/HTTP input. Availability is plain text. */
export function parseMessage<K extends MessageKind>(
  kind: K,
  raw: string | Buffer,
  options: ValidationOptions = {},
): ValidationResult<K> {
  if (Buffer.byteLength(raw) > MAX_PAYLOAD_BYTES)
    return { valid: false, issues: [{ path: "", code: "payload_too_large" }] };
  let value: unknown;
  try {
    value = JSON.parse(raw.toString());
  } catch {
    return { valid: false, issues: [{ path: "", code: "invalid_json" }] };
  }
  return validateMessage(kind, value, options);
}

export function isAvailability(value: string): value is "online" | "offline" {
  return value === "online" || value === "offline";
}
