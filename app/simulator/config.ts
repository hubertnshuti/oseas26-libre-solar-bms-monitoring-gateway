import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const SCENARIOS = [
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
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export interface SimulatorConfig {
  profile: string;
  scenario: Scenario;
  seed: number;
  nodeId?: string;
  brokerUrl: string;
  mqttUsername?: string;
  mqttPassword?: string;
  outboxPath: string;
  outboxCapacity: number;
  consumerId: string;
  gapMs: number;
  replayEvent?: string;
}

export interface DemoBatteryProfile {
  profile_id: string;
  source: "simulator";
  node_id: string;
  chemistry: string;
  capacity_ah: number;
  cell_count: number;
  cell_channels: number[];
  temperature_sensor_count: number;
  temperature_sensor_channels: number[];
  supported_fields: string[];
  unsupported_fields: string[];
  firmware_reference: string;
  simulation_time_factor: number;
  scenario_limits: Record<string, number> & {
    cell_overvoltage_v: number;
    cell_overvoltage_reset_v: number;
    cell_undervoltage_v: number;
    cell_undervoltage_reset_v: number;
    charge_overtemperature_degc: number;
    charge_overtemperature_reset_degc: number;
    discharge_overtemperature_degc: number;
    discharge_overtemperature_reset_degc: number;
    charge_current_a: number;
    discharge_current_a: number;
  };
  [key: string]: unknown;
}

export function parseSimulatorArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): SimulatorConfig {
  const options: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!key?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${key ?? ""}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    const name = key.slice(2);
    if (
      ![
        "profile",
        "scenario",
        "seed",
        "node-id",
        "broker-url",
        "outbox-path",
        "outbox-capacity",
        "consumer-id",
        "gap-ms",
        "replay-event",
      ].includes(name)
    ) {
      throw new Error(`Unknown option: ${key}`);
    }
    if (name in options) throw new Error(`Duplicate option: ${key}`);
    options[name] = value;
    index++;
  }

  const scenarioValue = options.scenario ?? "normal-cycle";
  if (!(SCENARIOS as readonly string[]).includes(scenarioValue)) {
    throw new Error(`Invalid --scenario; choose ${SCENARIOS.join(", ")}`);
  }
  const seedText = options.seed ?? "1";
  if (!/^\d+$/.test(seedText) || Number(seedText) > 0xffffffff) {
    throw new Error("Invalid --seed; use an integer from 0 to 4294967295");
  }
  const nodeId = options["node-id"];
  if (nodeId && !/^[0-9A-F]{16}$/.test(nodeId)) {
    throw new Error(
      "Invalid --node-id; use 16 uppercase hexadecimal characters",
    );
  }
  const brokerUrl = options["broker-url"] ?? "mqtt://127.0.0.1:1883";
  const outboxCapacity = parseBoundedInteger(
    options["outbox-capacity"] ?? "256",
    "--outbox-capacity",
    1,
    10000,
  );
  const gapMs = parseBoundedInteger(
    options["gap-ms"] ?? "15000",
    "--gap-ms",
    1000,
    3600000,
  );
  const consumerId = options["consumer-id"] ?? "mpm-demo";
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(consumerId)) {
    throw new Error("Invalid --consumer-id");
  }
  let parsedBroker: URL;
  try {
    parsedBroker = new URL(brokerUrl);
  } catch {
    throw new Error("Invalid --broker-url");
  }
  if (
    !["mqtt:", "mqtts:"].includes(parsedBroker.protocol) ||
    !parsedBroker.hostname ||
    parsedBroker.username ||
    parsedBroker.password ||
    (parsedBroker.pathname !== "" && parsedBroker.pathname !== "/") ||
    parsedBroker.search ||
    parsedBroker.hash
  ) {
    throw new Error("Invalid --broker-url; use an mqtt:// or mqtts:// origin");
  }

  return {
    profile: options.profile ?? "demo-lfp-4s-v1",
    scenario: scenarioValue as Scenario,
    seed: Number(seedText),
    ...(nodeId ? { nodeId } : {}),
    brokerUrl,
    outboxPath: resolve(
      options["outbox-path"] ??
        `.bms-runtime/${nodeId ?? "profile"}.events.json`,
    ),
    outboxCapacity,
    consumerId,
    gapMs,
    ...(options["replay-event"]
      ? { replayEvent: options["replay-event"] }
      : {}),
    ...(env.MQTT_USERNAME ? { mqttUsername: env.MQTT_USERNAME } : {}),
    ...(env.MQTT_PASSWORD ? { mqttPassword: env.MQTT_PASSWORD } : {}),
  };
}

function parseBoundedInteger(
  text: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^\d+$/.test(text)) throw new Error(`Invalid ${name}`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`Invalid ${name}; use ${minimum}..${maximum}`);
  return value;
}

export async function loadProfile(
  profileName: string,
): Promise<DemoBatteryProfile> {
  const profileUrl =
    profileName === "demo-lfp-4s-v1"
      ? new URL(
          "../../lib/contract/profiles/demo-lfp-4s-v1.json",
          import.meta.url,
        )
      : resolve(process.cwd(), profileName);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(profileUrl, "utf8"));
  } catch {
    throw new Error(`Unable to read profile: ${profileName}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid profile: ${profileName}`);
  }
  const profile = parsed as DemoBatteryProfile;
  if (
    profile.source !== "simulator" ||
    !/^[0-9A-F]{16}$/.test(profile.node_id) ||
    !Number.isFinite(profile.capacity_ah) ||
    profile.capacity_ah <= 0 ||
    !Number.isInteger(profile.cell_count) ||
    profile.cell_count < 1 ||
    profile.cell_count > 16 ||
    profile.cell_channels?.length !== profile.cell_count ||
    new Set(profile.cell_channels).size !== profile.cell_count ||
    !Number.isInteger(profile.temperature_sensor_count) ||
    profile.temperature_sensor_count < 0 ||
    profile.temperature_sensor_count > 3 ||
    profile.temperature_sensor_channels?.length !==
      profile.temperature_sensor_count ||
    new Set(profile.temperature_sensor_channels).size !==
      profile.temperature_sensor_count ||
    !Array.isArray(profile.supported_fields) ||
    !profile.scenario_limits ||
    !Number.isFinite(profile.scenario_limits.charge_current_a) ||
    !Number.isFinite(profile.scenario_limits.discharge_current_a) ||
    !Number.isFinite(profile.scenario_limits.cell_overvoltage_v) ||
    !Number.isFinite(profile.scenario_limits.cell_overvoltage_reset_v) ||
    !Number.isFinite(profile.scenario_limits.cell_undervoltage_v) ||
    !Number.isFinite(profile.scenario_limits.cell_undervoltage_reset_v) ||
    !Number.isFinite(profile.scenario_limits.charge_overtemperature_degc) ||
    !Number.isFinite(
      profile.scenario_limits.charge_overtemperature_reset_degc,
    ) ||
    !Number.isFinite(profile.scenario_limits.discharge_overtemperature_degc) ||
    !Number.isFinite(
      profile.scenario_limits.discharge_overtemperature_reset_degc,
    ) ||
    profile.scenario_limits.cell_overvoltage_reset_v >=
      profile.scenario_limits.cell_overvoltage_v ||
    profile.scenario_limits.cell_undervoltage_reset_v <=
      profile.scenario_limits.cell_undervoltage_v ||
    profile.scenario_limits.charge_overtemperature_reset_degc >=
      profile.scenario_limits.charge_overtemperature_degc ||
    profile.scenario_limits.discharge_overtemperature_reset_degc >=
      profile.scenario_limits.discharge_overtemperature_degc
  ) {
    throw new Error(`Invalid simulator profile: ${profileName}`);
  }
  return profile;
}
