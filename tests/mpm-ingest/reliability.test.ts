import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DeliveryStore } from "../../app/mpm-ingest/store.js";
import { ReliableDelivery } from "../../app/mpm-ingest/delivery.js";
import { Adapter } from "../../app/mpm-ingest/adapter.js";
import type {
  DeliveryKind,
  DeliveryOutcome,
  DeliveryPayload,
} from "../../app/mpm-ingest/http.js";
import type {
  EventReceipt,
  FaultEvent,
  Summary,
  Telemetry,
  Attributes,
  SourceStatus,
} from "../../lib/contract/index.js";

const nodeId = "53494D0000000001";
const config = {
  nodeIds: [nodeId],
  adapterId: "mpm-demo",
  source: "simulator" as const,
  maxPendingMessages: 10,
};
async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(
    await readFile(
      new URL(`../fixtures/v1/valid/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
}
let directory: string;
let store: DeliveryStore;
let delivery: ReliableDelivery;
let clock: number;
let outcome: DeliveryOutcome;
let received: { kind: DeliveryKind; payload: DeliveryPayload }[];
let receipts: EventReceipt[];
let event: FaultEvent;
let summary: Summary;
let telemetry: Telemetry;
let attributes: Attributes;
function instance() {
  return new ReliableDelivery(
    config,
    store,
    {
      deliver: async (kind, payload) => {
        received.push({ kind, payload: structuredClone(payload) });
        return outcome;
      },
    },
    async (receipt) => {
      const persisted = store.snapshot();
      expect(
        persisted.entries.some(
          (entry: any) => entry.payload.message_id === receipt.event_id,
        ),
      ).toBe(true);
      receipts.push(receipt);
    },
    () => {},
    () => clock,
    () => 1,
  );
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "bms-delivery-"));
  store = await DeliveryStore.open(
    join(directory, "state.json"),
    "test-company",
  );
  clock = Date.parse("2026-10-08T14:00:00.000Z");
  outcome = { result: "accepted" };
  received = [];
  receipts = [];
  delivery = instance();
  [event, summary, telemetry, attributes] = await Promise.all([
    fixture<FaultEvent>("fault.event"),
    fixture<Summary>("normal.summary"),
    fixture<Telemetry>("normal.telemetry"),
    fixture<Attributes>("demo.attributes"),
  ]);
});
afterEach(async () => {
  store.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await rm(directory, { recursive: true, force: true });
});

it("commits before receipt; recovers unchanged events after a lost response and process restart", async () => {
  expect((await delivery.deliver("event", event)).result).toBe("stored");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(receipts).toHaveLength(1);
  outcome = { result: "delivery_failed" };
  await delivery.flush();
  expect(store.snapshot().entries[0]!.nextAttempt).toBe(clock + 1000);
  store.close();
  store = await DeliveryStore.open(store.path, "test-company");
  delivery = instance();
  await delivery.flush();
  expect(received).toHaveLength(1);
  clock += 1000;
  outcome = { result: "duplicate" };
  await delivery.flush();
  expect(received.map((item) => item.payload)).toEqual([event, event]);
  expect(store.snapshot().entries[0]!.state).toBe("completed");
  await delivery.deliver("event", event);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(receipts[1]).toEqual(receipts[0]);
});

it("defers new-session attributes until a summary is accepted, including retained delivery order", async () => {
  await delivery.deliver("attributes", attributes);
  await delivery.flush();
  expect(received).toHaveLength(0);
  await delivery.deliver("summary", summary);
  await delivery.flush();
  await delivery.flush();
  expect(received.map((item) => item.kind)).toEqual(["summary", "attributes"]);
});

it("does not release metadata after an ignored or rejected session", async () => {
  await delivery.deliver("attributes", attributes);
  await delivery.deliver("summary", summary);
  outcome = { result: "ignored_stale" };
  await delivery.flush();
  await delivery.flush();
  expect(received.map((item) => item.kind)).toEqual(["summary"]);
});

it("accepts JSON key reordering as replay but refuses changed content with the same ID", async () => {
  await delivery.deliver("event", event);
  const reordered = Object.fromEntries(
    Object.entries(event).reverse(),
  ) as unknown as FaultEvent;
  expect((await delivery.deliver("event", reordered)).result).toBe("stored");
  expect(
    await delivery.deliver("event", {
      ...event,
      published_at: "2026-10-08T14:00:01.000Z",
    }),
  ).toMatchObject({ result: "rejected", code: "id_conflict" });
  expect(store.snapshot().entries).toHaveLength(1);
});

it("persists quarantine, pauses configuration failures, and honors Retry-After", async () => {
  await delivery.deliver("event", event);
  outcome = { result: "delivery_failed", retryAfterMs: 10000 };
  await delivery.flush();
  clock += 9999;
  await delivery.flush();
  expect(received).toHaveLength(1);
  clock++;
  outcome = { result: "quarantine_required", code: "http_422" };
  await delivery.flush();
  store.close();
  store = await DeliveryStore.open(store.path, "test-company");
  delivery = instance();
  await delivery.flush();
  expect(received).toHaveLength(2);
  expect(store.snapshot().entries[0]!.state).toBe("quarantined");
  await delivery.deliver("summary", summary);
  outcome = { result: "configuration_error" };
  await delivery.flush();
  await delivery.flush();
  expect(received).toHaveLength(3);
});

it("bounds pending capacity without losing an already-receipted event", async () => {
  const small = new ReliableDelivery(
    { ...config, maxPendingMessages: 1 },
    store,
    { deliver: async () => outcome },
    async () => {},
    () => {},
    () => clock,
  );
  await small.deliver("event", event);
  expect(await small.deliver("summary", summary)).toMatchObject({
    result: "rejected",
    code: "capacity_exceeded",
  });
  await small.checkStatus();
  expect(store.snapshot().entries.map((item) => item.payload)).toEqual([event]);
});

it("keeps disk failures visible and sends no receipt for failed persistence", async () => {
  vi.spyOn(store, "transaction").mockRejectedValue(new Error("disk full"));
  await expect(delivery.deliver("event", event)).rejects.toThrow();
  expect(receipts).toHaveLength(0);
});

it("refuses a corrupt store or changed tenant binding without replacing evidence", async () => {
  await expect(
    DeliveryStore.open(store.path, "another-company"),
  ).rejects.toThrow();
  const corrupt = join(directory, "corrupt.sqlite");
  await writeFile(corrupt, "broken");
  await expect(DeliveryStore.open(corrupt, "test-company")).rejects.toThrow();
  expect(await readFile(corrupt, "utf8")).toBe("broken");
});

it("uses new telemetry only; reports silence, source disconnect and broker outage distinctly", async () => {
  delivery.setConnected(true);
  await delivery.checkStatus();
  const latest = () =>
    store
      .snapshot()
      .entries.filter((entry) => entry.kind === "status")
      .at(-1)!.payload as SourceStatus;
  expect(latest().source_status).toBe("unknown");
  await delivery.observeTelemetry(telemetry, true);
  await delivery.checkStatus();
  expect(latest().source_status).toBe("unknown");
  await delivery.observeTelemetry(telemetry);
  await delivery.checkStatus();
  expect(latest().source_status).toBe("fresh");
  clock += 15000;
  await delivery.observeTelemetry(telemetry);
  await delivery.checkStatus();
  expect(latest().source_status).toBe("stale");
  delivery.observeAvailability(nodeId, "offline");
  await delivery.checkStatus();
  expect(latest().source_status).toBe("disconnected");
  delivery.setConnected(false);
  await delivery.checkStatus();
  expect(latest().source_status).toBe("unknown");
});

it("persists revision and observation watermark; restart cannot reuse telemetry as fresh", async () => {
  delivery.setConnected(true);
  await delivery.observeTelemetry(telemetry);
  await delivery.checkStatus();
  const first = store.snapshot().entries[0]!.payload as SourceStatus;
  store.close();
  store = await DeliveryStore.open(store.path, "test-company");
  delivery = instance();
  delivery.setConnected(true);
  await delivery.observeTelemetry(telemetry);
  await delivery.checkStatus();
  const second = store.snapshot().entries.at(-1)!.payload as SourceStatus;
  expect(second.source_status).toBe("unknown");
  expect(second.status_revision).toBeGreaterThan(first.status_revision);
  clock += 60000;
  await delivery.checkStatus();
  expect(
    (store.snapshot().entries.at(-1)!.payload as SourceStatus)
      .status_checked_at,
  ).toBe(new Date(clock).toISOString());
});

it("never changes a status check's original time on HTTP retry", async () => {
  await delivery.checkStatus();
  outcome = { result: "delivery_failed" };
  await delivery.flush();
  clock += 1000;
  outcome = { result: "accepted" };
  await delivery.flush();
  expect(received[0]!.payload).toEqual(received[1]!.payload);
});

it("validates MQTT payloads before adding anything to durable storage", async () => {
  const adapter = new Adapter(config, delivery);
  expect(
    (
      await adapter.handle(
        `libresolar/bms/v1/${nodeId}/events`,
        Buffer.from("{}"),
      )
    ).result,
  ).toBe("rejected");
  expect(store.snapshot().entries).toHaveLength(0);
});

it("rejects future telemetry for freshness without poisoning persisted status or restart", async () => {
  delivery.setConnected(true);
  const future = {
    ...telemetry,
    observed_at: new Date(clock + 1000).toISOString(),
    published_at: new Date(clock + 1000).toISOString(),
  };
  await delivery.observeTelemetry(future);
  await delivery.checkStatus();
  expect(
    (store.snapshot().entries.at(-1)!.payload as SourceStatus).source_status,
  ).toBe("unknown");
  expect(store.snapshot().observations[nodeId]).toBeUndefined();
  store.close();
  store = await DeliveryStore.open(store.path, "test-company");
  delivery = instance();
  delivery.setConnected(true);
  clock += 1000;
  await delivery.observeTelemetry(future);
  await delivery.checkStatus();
  expect(
    (store.snapshot().entries.at(-1)!.payload as SourceStatus).source_status,
  ).toBe("fresh");
});

it("rolls back an invalid state mutation and reopens the original committed data", async () => {
  await delivery.deliver("event", event);
  await expect(
    store.transaction((state) => {
      state.entries.push({
        kind: "status",
        payload: { ...event } as unknown as SourceStatus,
        state: "pending",
        attempts: 0,
        nextAttempt: 0,
      });
    }),
  ).rejects.toThrow("Invalid delivery store");
  store.close();
  store = await DeliveryStore.open(store.path, "test-company");
  expect(store.snapshot().entries.map((entry) => entry.payload)).toEqual([
    event,
  ]);
});

it("preserves session profile validation when metadata was accepted but its HTTP response was lost", async () => {
  await delivery.deliver("attributes", attributes);
  await delivery.deliver("summary", summary);
  await delivery.flush();
  outcome = { result: "delivery_failed" };
  await delivery.flush();
  store.close();
  store = await DeliveryStore.open(store.path, "test-company");
  delivery = instance();
  expect(delivery.profile(nodeId, attributes.session_id)).toEqual(attributes);
  outcome = { result: "duplicate" };
  clock += 1000;
  await delivery.flush();
  expect(delivery.profile(nodeId, attributes.session_id)).toEqual(attributes);
  const adapter = new Adapter(config, delivery);
  const wrongChannels = {
    ...telemetry,
    cell_voltages: [3.3, 3.3],
    cell_voltage_delta: 0,
  };
  expect(
    (
      await adapter.handle(
        `libresolar/bms/v1/${nodeId}/telemetry`,
        Buffer.from(JSON.stringify(wrongChannels)),
      )
    ).result,
  ).toBe("rejected");
});

it("does not roll back a session profile on older metadata replay or apply it to another session", async () => {
  const older = { ...attributes, cell_count: 2, cell_channels: [0, 1] };
  await delivery.deliver("attributes", older);
  const newer = {
    ...attributes,
    sequence: 10,
    message_id: `${nodeId}:${attributes.session_id}:attributes:10`,
  };
  await delivery.deliver("attributes", newer);
  await delivery.deliver("attributes", older);
  expect(delivery.profile(nodeId, attributes.session_id)).toEqual(newer);
  expect(delivery.profile(nodeId, "another-session")).toBeUndefined();
});

it("does not regress a status check or revision after wall-clock rollback across restart", async () => {
  await delivery.checkStatus();
  const first = store.snapshot().entries.at(-1)!.payload as SourceStatus;
  store.close();
  store = await DeliveryStore.open(store.path, "test-company");
  delivery = instance();
  clock -= 5000;
  await delivery.checkStatus();
  expect(store.snapshot().entries.at(-1)!.payload).toEqual(first);
  expect(store.snapshot().revisions[nodeId]).toBe(first.status_revision);
  clock += 5001;
  await delivery.checkStatus();
  expect(
    (store.snapshot().entries.at(-1)!.payload as SourceStatus).status_revision,
  ).toBe(first.status_revision + 1);
});

it("does not lose an acknowledged event when another SQLite connection commits concurrently", async () => {
  const second = await DeliveryStore.open(store.path, "test-company");
  try {
    await delivery.deliver("event", event);
    await second.transaction((state) => {
      state.revisions[nodeId] = 10;
    });
    expect(store.snapshot().entries[0]!.payload).toEqual(event);
    expect(store.snapshot().revisions[nodeId]).toBe(10);
  } finally {
    second.close();
  }
});

it("rejects a different producer source before changing its observation watermark", async () => {
  const adapter = new Adapter(config, delivery);
  const hardware = {
    ...telemetry,
    source: "hardware",
    clock_source: "gateway_host",
  };
  expect(
    await adapter.handle(
      `libresolar/bms/v1/${nodeId}/telemetry`,
      Buffer.from(JSON.stringify(hardware)),
    ),
  ).toMatchObject({ result: "rejected", code: "source_mismatch" });
  expect(store.snapshot().observations[nodeId]).toBeUndefined();
});
