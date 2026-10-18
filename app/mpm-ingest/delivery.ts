import {
  type EventReceipt,
  type FaultEvent,
  type SourceStatus,
  type Telemetry,
  type Attributes,
} from "../../lib/contract/index.js";
import type { AdapterConfig } from "./config.js";
import {
  type DeliveryKind,
  type DeliveryOutcome,
  type DeliveryPayload,
  type MpmClient,
} from "./http.js";
import { canonical, DeliveryStore, type RecordEntry } from "./store.js";

export type QueueOutcome =
  DeliveryOutcome | { result: "stored" | "queued" | "rejected"; code?: string };
type Observation = { seenAt: number; observedAt: string; offline: boolean };

export class ReliableDelivery {
  private paused = false;
  private flushing?: Promise<void>;
  private inFlight?: string;
  private connected = false;
  private readonly observations = new Map<string, Observation>();
  private readonly checks = new Map<
    string,
    { state: SourceStatus["source_status"]; at: number }
  >();

  constructor(
    private readonly config: Pick<
      AdapterConfig,
      "nodeIds" | "adapterId" | "source" | "maxPendingMessages"
    >,
    readonly store: DeliveryStore,
    private readonly client: Pick<MpmClient, "deliver">,
    private readonly receipt: (receipt: EventReceipt) => Promise<void>,
    private readonly report: (outcome: object) => void,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  async deliver(
    kind: DeliveryKind,
    payload: DeliveryPayload,
  ): Promise<QueueOutcome> {
    if (payload.source !== this.config.source)
      return { result: "rejected", code: "source_mismatch" };
    const result = await this.store.transaction((state): QueueOutcome => {
      const rememberProfile = () => {
        if (kind !== "attributes" || !("profile_id" in payload)) return;
        const key = `${payload.node_id}:${payload.session_id}`;
        const previous = state.profiles[key];
        if (!previous || payload.sequence > previous.sequence)
          state.profiles[key] = structuredClone(payload);
      };
      const existing = state.entries.find(
        (entry) => entry.payload.message_id === payload.message_id,
      );
      if (existing) {
        if (canonical(existing.payload) !== canonical(payload))
          return { result: "rejected", code: "id_conflict" };
        rememberProfile();
        return { result: kind === "event" ? "stored" : "queued" };
      }
      // Snapshots are replaceable only within the same session, before an HTTP attempt.
      // Events and quarantined evidence must never be evicted to make room.
      if (kind !== "event" && kind !== "status" && "sequence" in payload) {
        state.entries = state.entries.filter(
          (entry) =>
            !(
              entry.kind === kind &&
              entry.state === "pending" &&
              entry.attempts === 0 &&
              entry.payload.message_id !== this.inFlight &&
              "sequence" in entry.payload &&
              entry.payload.node_id === payload.node_id &&
              entry.payload.session_id === payload.session_id &&
              entry.payload.sequence < payload.sequence
            ),
        );
      }
      if (
        state.entries.filter((entry) => entry.state !== "completed").length >=
        this.config.maxPendingMessages
      )
        return { result: "rejected", code: "capacity_exceeded" };
      rememberProfile();
      state.entries.push({
        kind,
        payload: structuredClone(payload),
        state: "pending",
        attempts: 0,
        nextAttempt: 0,
      });
      return { result: kind === "event" ? "stored" : "queued" };
    });
    if (result.result === "stored") {
      const event = payload as FaultEvent;
      // Re-publish the same receipt on replay, including after an HTTP acceptance.
      // Do not await PUBACK inside MQTT's incoming-message hook: that would
      // block packet processing, including the receipt's own acknowledgement.
      void this.receipt({
        schema_version: 1,
        node_id: event.node_id,
        source: event.source,
        message_id: `${event.event_id}:receipt:${this.config.adapterId}`,
        event_id: event.event_id,
        consumer_id: this.config.adapterId,
        status: "stored",
      }).catch(() =>
        this.report({
          result: "receipt_publish_failed",
          messageId: payload.message_id,
        }),
      );
    }
    return result;
  }

  profile(nodeId: string, sessionId: string): Attributes | undefined {
    return this.store.snapshot().profiles[`${nodeId}:${sessionId}`];
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
  }

  async observeTelemetry(payload: Telemetry, retained = false): Promise<void> {
    const now = this.now();
    const observed = Date.parse(payload.observed_at);
    if (
      retained ||
      payload.source !== this.config.source ||
      observed > now ||
      now - observed >= 15000
    )
      return;
    const changed = await this.store.transaction((state) => {
      const previous = state.observations[payload.node_id];
      if (
        previous &&
        (observed <= Date.parse(previous.observed_at) ||
          (previous.session_id === payload.session_id &&
            payload.sequence <= previous.sequence))
      )
        return false;
      state.observations[payload.node_id] = {
        session_id: payload.session_id,
        sequence: payload.sequence,
        observed_at: payload.observed_at,
      };
      return true;
    });
    if (changed)
      this.observations.set(payload.node_id, {
        seenAt: now,
        observedAt: payload.observed_at,
        offline: false,
      });
  }

  observeAvailability(nodeId: string, value: string): void {
    const previous = this.observations.get(nodeId);
    if (value === "offline")
      this.observations.set(nodeId, {
        seenAt: previous?.seenAt ?? 0,
        observedAt: previous?.observedAt ?? "",
        offline: true,
      });
    // Online is only a connection hint. It cannot establish a fresh observation.
    else if (previous?.offline) this.observations.delete(nodeId);
  }

  async checkStatus(): Promise<void> {
    for (const nodeId of this.config.nodeIds) {
      const now = this.now();
      const observation = this.observations.get(nodeId);
      const sourceStatus: SourceStatus["source_status"] = !this.connected
        ? "unknown"
        : observation?.offline
          ? "disconnected"
          : !observation
            ? "unknown"
            : now - observation.seenAt >= 15000 ||
                now - Date.parse(observation.observedAt) >= 15000
              ? "stale"
              : "fresh";
      const last = this.checks.get(nodeId);
      if (last && last.state === sourceStatus && now - last.at < 60000)
        continue;
      const saved = await this.store.transaction((state) => {
        if (now < Date.parse(state.checkedAt[nodeId] ?? "1970-01-01T00:00:00Z"))
          return "clock_regression";
        // Superseded checks are safe to replace; in-flight payloads remain immutable.
        state.entries = state.entries.filter(
          (entry) =>
            !(
              entry.kind === "status" &&
              entry.state === "pending" &&
              entry.payload.node_id === nodeId &&
              entry.payload.message_id !== this.inFlight
            ),
        );
        if (
          state.entries.filter((entry) => entry.state !== "completed").length >=
          this.config.maxPendingMessages
        )
          return "capacity_exceeded";
        const revision = (state.revisions[nodeId] ?? 0) + 1;
        if (!Number.isSafeInteger(revision))
          throw new Error("Status revision exhausted");
        state.revisions[nodeId] = revision;
        state.checkedAt[nodeId] = new Date(now).toISOString();
        const payload: SourceStatus = {
          schema_version: 1,
          node_id: nodeId,
          source: this.config.source,
          adapter_id: this.config.adapterId,
          status_revision: revision,
          message_id: `${nodeId}:${this.config.adapterId}:status:${revision}`,
          source_status: sourceStatus,
          last_source_observed_at: observation?.observedAt || null,
          status_checked_at: new Date(now).toISOString(),
        };
        state.entries.push({
          kind: "status",
          payload,
          state: "pending",
          attempts: 0,
          nextAttempt: 0,
        });
        return true;
      });
      if (saved === true)
        this.checks.set(nodeId, { state: sourceStatus, at: now });
      else
        this.report({
          result:
            saved === "clock_regression"
              ? "clock_regression"
              : "status_capacity_exceeded",
          nodeId,
        });
    }
  }

  stop(): void {
    this.paused = true;
  }

  flush(): Promise<void> {
    if (!this.flushing)
      this.flushing = this.run().finally(() => {
        this.flushing = undefined;
      });
    return this.flushing;
  }

  private async run(): Promise<void> {
    // One bounded pass permits incoming MQTT writes and shutdown between retries.
    const ids = this.store
      .snapshot()
      .entries.filter((entry) => entry.state === "pending")
      .map((entry) => entry.payload.message_id);
    for (const id of ids) {
      if (this.paused) break;
      const state = this.store.snapshot();
      const entry = state.entries.find(
        (item) => item.payload.message_id === id,
      );
      if (!entry || entry.state !== "pending" || entry.nextAttempt > this.now())
        continue;
      if (
        entry.kind === "attributes" &&
        "session_id" in entry.payload &&
        !state.sessions[`${entry.payload.node_id}:${entry.payload.session_id}`]
      )
        continue;
      this.inFlight = id;
      try {
        const outcome = await this.client.deliver(entry.kind, entry.payload);
        await this.store.transaction((next) => {
          const current = next.entries.find(
            (item) => item.payload.message_id === id,
          );
          if (!current) return;
          this.apply(current, outcome);
          if (
            entry.kind === "summary" &&
            (outcome.result === "accepted" || outcome.result === "duplicate") &&
            "session_id" in entry.payload
          )
            next.sessions[
              `${entry.payload.node_id}:${entry.payload.session_id}`
            ] = entry.payload.observed_at;
          // Completed event entries form a bounded receipt cache. Evicted replays can
          // be stored again safely; the backend remains the durable deduplication authority.
          const completed = next.entries.filter(
            (item) => item.state === "completed" && item.kind === "event",
          );
          const keep = new Set(
            completed
              .slice(-this.config.maxPendingMessages)
              .map((item) => item.payload.message_id),
          );
          next.entries = next.entries.filter(
            (item) =>
              item.state !== "completed" || keep.has(item.payload.message_id),
          );
        });
        this.report({
          ...outcome,
          nodeId: entry.payload.node_id,
          messageId: id,
        });
      } finally {
        this.inFlight = undefined;
      }
    }
  }

  private apply(entry: RecordEntry, outcome: DeliveryOutcome): void {
    if (["accepted", "duplicate", "ignored_stale"].includes(outcome.result)) {
      entry.state = "completed";
      return;
    }
    entry.attempts++;
    entry.code = outcome.code;
    if (outcome.result === "quarantine_required") {
      entry.state = "quarantined";
      return;
    }
    if (outcome.result === "configuration_error") {
      this.paused = true;
      return;
    }
    const backoff = Math.min(
      30000,
      1000 * 2 ** Math.min(entry.attempts - 1, 10),
    );
    entry.nextAttempt =
      this.now() +
      Math.max(
        outcome.retryAfterMs ?? 0,
        Math.round(backoff * (0.5 + this.random() * 0.5)),
      );
  }
}
