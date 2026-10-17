import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventReceipt, FaultEvent } from "../../lib/contract/types.js";
import {
  DurableEventOutbox,
  OutboxCapacityError,
} from "../../lib/publisher/outbox.js";
import { EventOutboxDelivery } from "../../lib/publisher/event-delivery.js";
import type { DemoBatteryProfile } from "../../app/simulator/config.js";

const directory = await mkdtemp(join(tmpdir(), "bms-outbox-unit-"));
const path = join(directory, "pending.json");
const profile = JSON.parse(
  readFileSync(
    new URL("../../lib/contract/profiles/demo-lfp-4s-v1.json", import.meta.url),
    "utf8",
  ),
) as DemoBatteryProfile;
const event = JSON.parse(
  readFileSync(
    new URL(
      "../../tests/fixtures/v1/valid/first-observed.event.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as FaultEvent;
const capabilities = {
  source: "simulator" as const,
  cell_count: profile.cell_count,
  cell_channels: profile.cell_channels,
  temperature_sensor_count: profile.temperature_sensor_count,
  temperature_sensor_channels: profile.temperature_sensor_channels,
  supported_fields: profile.supported_fields,
};

afterEach(async () => {
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(directory, { recursive: true }),
  );
});

function openOutbox(capacity = 4, file = path) {
  return DurableEventOutbox.open({
    path: file,
    nodeId: event.node_id,
    capacity,
    profile: capabilities,
  });
}

function receipt(forEvent = event, consumerId = "mpm-demo"): EventReceipt {
  return {
    schema_version: 1,
    node_id: forEvent.node_id,
    source: forEvent.source,
    event_id: forEvent.event_id,
    consumer_id: consumerId,
    message_id: `${forEvent.event_id}:receipt:${consumerId}`,
    status: "stored",
  };
}

describe("durable fault event outbox", () => {
  it("persists before publication and recovers the original event after restart", async () => {
    const first = await openOutbox();
    await first.enqueue(event);
    const disk = JSON.parse(await readFile(path, "utf8"));
    expect(disk.pending[0]).toEqual(event);

    const restarted = await openOutbox();
    expect(restarted.list()).toEqual([event]);
    expect(restarted.list()[0]?.observed_at).toBe(event.observed_at);
    expect(restarted.list()[0]?.event_id).toBe(event.event_id);
  });

  it("is idempotent for identical events and rejects event ID conflicts", async () => {
    const outbox = await openOutbox();
    await outbox.enqueue(event);
    await outbox.enqueue(event);
    expect(outbox.list()).toHaveLength(1);
    const conflicting = {
      ...event,
      observed_at: "2026-10-08T14:00:01.000Z",
      published_at: "2026-10-08T14:00:01.000Z",
    };
    await expect(outbox.enqueue(conflicting)).rejects.toThrow(
      "Event ID conflict",
    );
  });

  it("surfaces bounded capacity without replacing pending data", async () => {
    const outbox = await openOutbox(1);
    await outbox.enqueue(event);
    const second = {
      ...event,
      sequence: event.sequence + 1,
      event_id: event.event_id.replace(/:\d+$/, `:${event.sequence + 1}`),
      message_id: event.message_id.replace(/:\d+$/, `:${event.sequence + 1}`),
      telemetry_message_id: event.telemetry_message_id.replace(
        /:\d+$/,
        `:${event.sequence - 1}`,
      ),
    };
    await expect(outbox.enqueue(second)).rejects.toBeInstanceOf(
      OutboxCapacityError,
    );
    expect(outbox.list()).toEqual([event]);
    expect(JSON.parse(await readFile(path, "utf8")).pending).toEqual([event]);
  });

  it("does not silently reset a corrupted persistence file", async () => {
    await writeFile(path, "{broken", "utf8");
    await expect(openOutbox()).rejects.toThrow("Outbox file is corrupt");
    expect(await readFile(path, "utf8")).toBe("{broken");
  });

  it("surfaces storage failures", async () => {
    const outbox = await openOutbox(
      4,
      join(directory, "missing", "pending.json"),
    );
    await rm(join(directory, "missing"), { recursive: true, force: true });
    await writeFile(
      join(directory, "missing"),
      "file blocks directory creation",
    );
    await expect(outbox.enqueue(event)).rejects.toThrow(
      "Could not durably write event outbox",
    );
  });

  it("retries the same event ID and observation time until a valid stored receipt", async () => {
    vi.useFakeTimers();
    const outbox = await openOutbox();
    await outbox.enqueue(event);
    const sent: FaultEvent[] = [];
    const transport = {
      connected: true,
      async subscribe() {},
      async publish(message: FaultEvent) {
        sent.push(structuredClone(message));
      },
    };
    const delivery = new EventOutboxDelivery({
      nodeId: event.node_id,
      source: event.source,
      consumerId: "mpm-demo",
      transport,
      outbox,
      retryBaseMs: 5,
      retryMaxMs: 20,
    });
    await delivery.onConnect();
    await vi.advanceTimersByTimeAsync(5);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.event_id).toBe(sent[1]?.event_id);
    expect(sent[0]?.observed_at).toBe(sent[1]?.observed_at);

    const valid = receipt();
    expect(
      await delivery.handleReceipt(
        `libresolar/bms/v1/${event.node_id}/receipts/mpm`,
        JSON.stringify(valid),
      ),
    ).toBe(true);
    expect(outbox.list()).toEqual([]);
    delivery.close();
  });

  it("rejects wrong topic, consumer, unknown event, malformed receipt and invalid status", async () => {
    const outbox = await openOutbox();
    await outbox.enqueue(event);
    const delivery = new EventOutboxDelivery({
      nodeId: event.node_id,
      source: event.source,
      consumerId: "mpm-demo",
      transport: {
        connected: true,
        async subscribe() {},
        async publish() {},
      },
      outbox,
    });
    const topic = `libresolar/bms/v1/${event.node_id}/receipts/mpm`;
    expect(await delivery.handleReceipt(`${topic}/other`, "{}")).toBe(false);
    expect(await delivery.handleReceipt(topic, "not json")).toBe(false);
    expect(
      await delivery.handleReceipt(
        topic,
        JSON.stringify(receipt(event, "forged-adapter")),
      ),
    ).toBe(false);
    const unknown = {
      ...receipt(),
      event_id: event.event_id.replace(/:\d+$/, ":999"),
      message_id: `${event.event_id.replace(/:\d+$/, ":999")}:receipt:mpm-demo`,
    };
    expect(await delivery.handleReceipt(topic, JSON.stringify(unknown))).toBe(
      false,
    );
    const rejected = { ...receipt(), status: "accepted" };
    expect(await delivery.handleReceipt(topic, JSON.stringify(rejected))).toBe(
      false,
    );
    expect(outbox.list()).toEqual([event]);
    delivery.close();
  });
});
