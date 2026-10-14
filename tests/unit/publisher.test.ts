import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  MqttPublisher,
  type MqttTransport,
  type PublishOptions,
} from "../../lib/publisher/index.js";
import { createMeasurementGenerator } from "../../app/simulator/generator.js";
import type { DemoBatteryProfile } from "../../app/simulator/config.js";
import type { ProfileCapabilities } from "../../lib/contract/types.js";
import { validateMessage } from "../../lib/contract/validate.js";

const rawProfile = JSON.parse(
  readFileSync(
    new URL("../../lib/contract/profiles/demo-lfp-4s-v1.json", import.meta.url),
    "utf8",
  ),
) as DemoBatteryProfile;
const capabilities: ProfileCapabilities = {
  source: "simulator",
  cell_count: rawProfile.cell_count,
  cell_channels: rawProfile.cell_channels,
  temperature_sensor_count: rawProfile.temperature_sensor_count,
  temperature_sensor_channels: rawProfile.temperature_sensor_channels,
  supported_fields: rawProfile.supported_fields,
};
const metadata = {
  manufacturer: "Simulator",
  device_type: "Libre Solar BMS demo",
  hardware_version: "not-hardware",
  firmware_version: "reference-only",
  firmware_reference: rawProfile.firmware_reference,
  profile_id: rawProfile.profile_id,
  chemistry: rawProfile.chemistry,
  capacity_ah: rawProfile.capacity_ah,
  cell_count: rawProfile.cell_count,
  cell_channels: rawProfile.cell_channels,
  temperature_sensor_count: rawProfile.temperature_sensor_count,
  temperature_sensor_channels: rawProfile.temperature_sensor_channels,
  supported_fields: rawProfile.supported_fields,
  simulation_time_factor: rawProfile.simulation_time_factor,
};
const sessionId = "15f75ec4-29ab-48ab-93be-81d3e0708a68";

class FakeMqtt extends EventEmitter implements MqttTransport {
  connected = true;
  messages: Array<{ topic: string; payload: string; options: PublishOptions }> =
    [];

  async publishAsync(
    topic: string,
    payload: string,
    options: PublishOptions,
  ): Promise<void> {
    if (!this.connected) throw new Error("disconnected");
    this.messages.push({ topic, payload, options });
  }
}

function setup(
  options: {
    nodeId?: string;
    uuid?: () => string;
    useFixedSession?: boolean;
  } = {},
) {
  const mqtt = new FakeMqtt();
  let wall = new Date("2026-10-13T12:00:00.000Z");
  let monotonic = 0;
  const nodeId = options.nodeId ?? rawProfile.node_id;
  const publisher = new MqttPublisher(mqtt, {
    nodeId,
    source: "simulator",
    clockSource: "simulator_host",
    profile: capabilities,
    attributes: metadata,
    now: () => new Date(wall),
    monotonicNow: () => monotonic,
    ...(options.useFixedSession === false ? {} : { sessionId }),
    ...(options.uuid ? { uuid: options.uuid } : {}),
  });
  const generator = createMeasurementGenerator({
    profile: { ...rawProfile, node_id: nodeId },
    scenario: "normal-cycle",
    seed: 8,
  });
  return {
    mqtt,
    publisher,
    setWall(value: Date) {
      wall = value;
    },
    setMonotonic(value: number) {
      monotonic = value;
    },
    observation(at: Date, id = nodeId) {
      wall = new Date(at);
      const generated = generator.next(at);
      return {
        nodeId: id,
        observedAt: generated.observedAt,
        measurements: generated.measurements,
      };
    },
  };
}

describe("version 1 MQTT publisher", () => {
  it("publishes online and attributes retained at QoS 1 with valid identity", async () => {
    const { mqtt, publisher } = setup();
    await publisher.onConnect();
    expect(mqtt.messages[0]).toMatchObject({
      topic: `libresolar/bms/v1/${rawProfile.node_id}/availability`,
      payload: "online",
      options: { qos: 1, retain: true },
    });
    const attributes = mqtt.messages[1]!;
    expect(attributes).toMatchObject({
      topic: `libresolar/bms/v1/${rawProfile.node_id}/attributes`,
      options: { qos: 1, retain: true },
    });
    const parsed = JSON.parse(attributes.payload);
    expect(
      validateMessage("attributes", parsed, { topic: attributes.topic }).valid,
    ).toBe(true);
    expect(parsed.sequence).toBe(0);
    expect(parsed.session_id).toBe(sessionId);
  });

  it("publishes non-retained QoS 0 telemetry and an initial retained QoS 1 summary", async () => {
    const { mqtt, publisher, observation } = setup();
    await publisher.onConnect();
    const result = await publisher.publishObservation(
      observation(new Date("2026-10-13T12:00:01.000Z")),
    );
    expect(result.summary).toBeDefined();
    const telemetry = mqtt.messages.find((message) =>
      message.topic.endsWith("/telemetry"),
    )!;
    const summary = mqtt.messages.find((message) =>
      message.topic.endsWith("/summary"),
    )!;
    expect(telemetry.options).toEqual({ qos: 0, retain: false });
    expect(summary.options).toEqual({ qos: 1, retain: true });
    expect(
      validateMessage("telemetry", JSON.parse(telemetry.payload), {
        topic: telemetry.topic,
        profile: capabilities,
      }).valid,
    ).toBe(true);
    expect(
      validateMessage("summary", JSON.parse(summary.payload), {
        topic: summary.topic,
        profile: capabilities,
      }).valid,
    ).toBe(true);
  });

  it("publishes summaries at 60 seconds and on BMS state changes", async () => {
    const context = setup();
    await context.publisher.onConnect();
    const first = context.observation(new Date("2026-10-13T12:00:00.000Z"));
    await context.publisher.publishObservation(first);
    const summaryCount = () =>
      context.mqtt.messages.filter((message) =>
        message.topic.endsWith("/summary"),
      ).length;
    await context.publisher.publishObservation(
      context.observation(new Date("2026-10-13T12:00:01.000Z")),
    );
    expect(summaryCount()).toBe(1);
    context.setMonotonic(60_000);
    context.setWall(new Date("2026-10-13T12:01:00.000Z"));
    await context.publisher.publishObservation(
      context.observation(new Date("2026-10-13T12:01:00.000Z")),
    );
    expect(summaryCount()).toBe(2);
    const changed = {
      ...context.observation(new Date("2026-10-13T12:01:01.000Z")),
      measurements: {
        ...context.observation(new Date("2026-10-13T12:01:01.000Z"))
          .measurements,
        bms_state_code: 2,
        bms_state: "DIS" as const,
      },
    };
    await context.publisher.publishObservation(changed);
    expect(summaryCount()).toBe(3);
  });

  it("uses one increasing sequence and keeps session identity through reconnect", async () => {
    const context = setup();
    await context.publisher.onConnect();
    await context.publisher.publishObservation(
      context.observation(new Date("2026-10-13T12:00:01.000Z")),
    );
    context.setWall(new Date("2026-10-13T12:00:03.000Z"));
    await context.publisher.onConnect();
    const reconnectObservation = context.observation(
      new Date("2026-10-13T12:00:03.000Z"),
    );
    const { telemetry, summary } = await context.publisher.publishObservation(
      reconnectObservation,
      { forceSummary: true },
    );
    expect(telemetry.session_id).toBe(sessionId);
    expect(summary?.session_id).toBe(sessionId);
    expect(telemetry.sequence).toBeGreaterThan(2);
    expect(summary!.sequence).toBe(telemetry.sequence + 1);
    expect(telemetry.message_id).toBe(
      `${telemetry.node_id}:${sessionId}:telemetry:${telemetry.sequence}`,
    );
  });

  it("keeps observation time unchanged in an older retained summary", async () => {
    const context = setup();
    await context.publisher.onConnect();
    const old = context.observation(new Date("2026-10-13T11:00:00.000Z"));
    context.setWall(new Date("2026-10-13T12:00:00.000Z"));
    const { summary } = await context.publisher.publishObservation(old);
    expect(summary!.observed_at).toBe("2026-10-13T11:00:00.000Z");
    expect(summary!.last_source_observed_at).toBe(summary!.observed_at);
    expect(summary!.published_at).toBe("2026-10-13T12:00:00.000Z");
  });

  it("rejects a cross-node observation before publishing it", async () => {
    const context = setup();
    await context.publisher.onConnect();
    const before = context.mqtt.messages.length;
    const observation = context.observation(
      new Date("2026-10-13T12:00:01.000Z"),
      "53494D0000000002",
    );
    await expect(
      context.publisher.publishObservation(observation),
    ).rejects.toThrow("Observation node ID does not match publisher node ID");
    expect(context.mqtt.messages).toHaveLength(before);
  });

  it("publishes clean offline availability and preserves stable node topic", async () => {
    const context = setup();
    await context.publisher.onConnect();
    await context.publisher.publishOffline();
    expect(context.mqtt.messages.at(-1)).toMatchObject({
      topic: `libresolar/bms/v1/${rawProfile.node_id}/availability`,
      payload: "offline",
      options: { qos: 1, retain: true },
    });
  });

  it("creates a fresh session UUID for each process publisher", () => {
    let id = 0;
    const uuid = () =>
      id++ === 0 ? sessionId : "25f75ec4-29ab-48ab-93be-81d3e0708a69";
    const first = setup({ uuid, useFixedSession: false }).publisher;
    const second = new MqttPublisher(new FakeMqtt(), {
      nodeId: rawProfile.node_id,
      source: "simulator",
      clockSource: "simulator_host",
      profile: capabilities,
      attributes: metadata,
      uuid,
    });
    expect(first.sessionId).toBe(sessionId);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it("builds contract-valid events with the shared sequence and QoS 1 non-retained", async () => {
    const context = setup();
    await context.publisher.onConnect();
    const normal = await context.publisher.publishObservation(
      context.observation(new Date("2026-10-13T12:00:00.000Z")),
    );
    const fault = await context.publisher.publishObservation(
      context.observation(new Date("2026-10-13T12:00:01.000Z")),
    );
    const event = context.publisher.createFaultEvent(fault.telemetry, {
      kind: "fault_changed",
      previousErrorFlags: 0,
      currentErrorFlags: 2,
      faults: ["cell_overvoltage"],
      addedFaults: ["cell_overvoltage"],
      clearedFaults: [],
    });
    expect(event.sequence).toBeGreaterThan(fault.telemetry.sequence);
    expect(event.telemetry_message_id).toBe(fault.telemetry.message_id);
    expect(
      validateMessage("event", event, {
        topic: `libresolar/bms/v1/${rawProfile.node_id}/events`,
        profile: capabilities,
      }).valid,
    ).toBe(true);
    await context.publisher.publishFaultEvent(event);
    expect(context.mqtt.messages.at(-1)).toMatchObject({
      topic: `libresolar/bms/v1/${rawProfile.node_id}/events`,
      options: { qos: 1, retain: false },
    });
    expect(JSON.parse(context.mqtt.messages.at(-1)!.payload)).toEqual(event);
    expect(normal.telemetry.sequence).toBeLessThan(fault.telemetry.sequence);
  });
});
