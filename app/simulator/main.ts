import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { connect } from "mqtt";
import { MqttPublisher } from "../../lib/publisher/index.js";
import { availabilityTopic } from "../../lib/publisher/topics.js";
import { createMeasurementGenerator } from "./generator.js";
import { loadProfile, parseSimulatorArgs, SCENARIOS } from "./config.js";
import { startTelemetrySchedule } from "./scheduler.js";

const HELP = `Libre Solar BMS normal simulator

Usage: node --import tsx app/simulator/main.ts [options]
  --profile <id-or-json-path>  Default: demo-lfp-4s-v1
  --scenario <name>            ${SCENARIOS.join(" | ")}; default: normal-cycle
  --seed <uint32>              Default: 1
  --node-id <16-hex-id>        Default: profile node ID
  --broker-url <mqtt(s) URL>   Default: mqtt://127.0.0.1:1883
`;

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes("--list-scenarios")) {
    process.stdout.write(`${SCENARIOS.join("\n")}\n`);
    return;
  }
  const config = parseSimulatorArgs(argv);
  const loadedProfile = await loadProfile(config.profile);
  const nodeId = config.nodeId ?? loadedProfile.node_id;
  const profile = { ...loadedProfile, node_id: nodeId };
  const generator = createMeasurementGenerator({
    profile,
    scenario: config.scenario,
    seed: config.seed,
  });
  const clock = () => new Date();
  const client = connect(config.brokerUrl, {
    clientId: `bms-${nodeId}-${randomUUID().slice(0, 8)}`,
    clean: true,
    reconnectPeriod: 1000,
    connectTimeout: 10000,
    queueQoSZero: false,
    ...(config.mqttUsername ? { username: config.mqttUsername } : {}),
    ...(config.mqttPassword ? { password: config.mqttPassword } : {}),
    will: {
      topic: availabilityTopic(nodeId),
      payload: "offline",
      qos: 1,
      retain: true,
    },
  });
  const publisher = new MqttPublisher(client, {
    nodeId,
    source: "simulator",
    clockSource: "simulator_host",
    profile: {
      source: "simulator",
      cell_count: profile.cell_count,
      cell_channels: profile.cell_channels,
      temperature_sensor_count: profile.temperature_sensor_count,
      temperature_sensor_channels: profile.temperature_sensor_channels,
      supported_fields: profile.supported_fields,
    },
    attributes: {
      manufacturer: "Simulator",
      device_type: "Libre Solar BMS demo",
      hardware_version: "not-hardware",
      firmware_version: "reference-only",
      firmware_reference: profile.firmware_reference,
      profile_id: profile.profile_id,
      chemistry: profile.chemistry,
      capacity_ah: profile.capacity_ah,
      cell_count: profile.cell_count,
      cell_channels: profile.cell_channels,
      temperature_sensor_count: profile.temperature_sensor_count,
      temperature_sensor_channels: profile.temperature_sensor_channels,
      supported_fields: profile.supported_fields,
      simulation_time_factor: profile.simulation_time_factor,
    },
    now: clock,
  });

  let cancelSchedule: (() => void) | undefined;
  let connectionWork = false;
  let everConnected = false;
  let stopping = false;
  let tickWork = false;

  async function tick(forceSummary: boolean): Promise<void> {
    if (tickWork || stopping || !client.connected) return;
    tickWork = true;
    try {
      const observation = generator.next(clock());
      const result = await publisher.publishObservation(
        {
          nodeId,
          observedAt: observation.observedAt,
          measurements: observation.measurements,
        },
        { forceSummary },
      );
      process.stdout.write(
        `${JSON.stringify({
          result: "published",
          node_id: nodeId,
          sequence: result.telemetry.sequence,
          summary: Boolean(result.summary),
        })}\n`,
      );
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({ result: "publish_failed", message: errorMessage(error) })}\n`,
      );
    } finally {
      tickWork = false;
    }
  }

  client.on("connect", () => {
    if (connectionWork || stopping) return;
    connectionWork = true;
    const reconnect = everConnected;
    everConnected = true;
    void (async () => {
      await publisher.onConnect();
      if (stopping) return;
      await tick(true);
      if (!stopping && !cancelSchedule) {
        cancelSchedule = startTelemetrySchedule(() => void tick(false));
      }
      process.stdout.write(
        `${JSON.stringify({
          result: reconnect ? "reconnected" : "connected",
          node_id: nodeId,
          session_id: publisher.sessionId,
        })}\n`,
      );
    })()
      .catch((error: unknown) => {
        process.exitCode = 1;
        process.stderr.write(
          `${JSON.stringify({ result: "connection_setup_failed", message: errorMessage(error) })}\n`,
        );
        setTimeout(() => void stop(), 0);
      })
      .finally(() => {
        connectionWork = false;
      });
  });
  client.on("close", () => {
    cancelSchedule?.();
    cancelSchedule = undefined;
  });
  client.on("error", (error) => {
    process.stderr.write(
      `${JSON.stringify({ result: "mqtt_error", message: error.message })}\n`,
    );
  });

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    cancelSchedule?.();
    cancelSchedule = undefined;
    while (connectionWork || tickWork)
      await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      await publisher.publishOffline();
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({ result: "offline_publish_failed", message: errorMessage(error) })}\n`,
      );
    }
    await new Promise<void>((resolve) =>
      client.end(false, {}, () => resolve()),
    );
    process.stdout.write(
      `${JSON.stringify({ result: "stopped", node_id: nodeId })}\n`,
    );
  }

  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown_error";
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({ result: "startup_failed", message: errorMessage(error) })}\n`,
    );
    process.exitCode = 1;
  });
}
