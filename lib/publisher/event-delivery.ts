import type { FaultEvent, EventReceipt } from "../contract/types.js";
import { validateMessage } from "../contract/validate.js";
import { receiptTopic } from "./topics.js";
import { DurableEventOutbox } from "./outbox.js";

export interface EventDeliveryTransport {
  readonly connected: boolean;
  subscribe(topic: string, options: { qos: 1 }): Promise<unknown>;
  publish(event: FaultEvent): Promise<void>;
}

export interface EventDeliveryOptions {
  nodeId: string;
  source: FaultEvent["source"];
  consumerId: string;
  transport: EventDeliveryTransport;
  outbox: DurableEventOutbox;
  retryBaseMs?: number;
  retryMaxMs?: number;
  onDiagnostic?: (code: string, details?: Record<string, unknown>) => void;
}

export class EventOutboxDelivery {
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly attempts = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly options: EventDeliveryOptions) {
    this.retryBaseMs = options.retryBaseMs ?? 1000;
    this.retryMaxMs = options.retryMaxMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.retryBaseMs) ||
      !Number.isSafeInteger(this.retryMaxMs) ||
      this.retryBaseMs < 1 ||
      this.retryMaxMs < this.retryBaseMs
    )
      throw new Error("Invalid event retry bounds");
  }

  async onConnect(options: { retryPending?: boolean } = {}): Promise<void> {
    const subscription = await this.options.transport.subscribe(
      receiptTopic(this.options.nodeId),
      {
        qos: 1,
      },
    );
    const grants = (subscription as { granted?: Array<{ qos: number }> })
      ?.granted;
    if (grants?.some((grant) => grant.qos === 128))
      throw new Error("Broker denied the producer receipt subscription");
    if (options.retryPending !== false) await this.retryPending();
  }

  onDisconnect(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.inFlight.clear();
  }

  async persistAndPublish(event: FaultEvent): Promise<void> {
    if (event.node_id !== this.options.nodeId)
      throw new Error("Refusing cross-node event delivery");
    await this.options.outbox.enqueue(event);
    await this.publishPending(event.event_id);
  }

  async retryPending(): Promise<void> {
    if (!this.options.transport.connected) return;
    for (const event of this.options.outbox.list())
      await this.publishPending(event.event_id);
  }

  async replay(eventId: string): Promise<void> {
    const event = this.options.outbox
      .list()
      .find((pending) => pending.event_id === eventId);
    if (!event) throw new Error("Requested replay event is not pending");
    if (!this.options.transport.connected)
      throw new Error("Cannot replay while MQTT is disconnected");
    await this.options.transport.publish(event);
  }

  async handleReceipt(topic: string, raw: Buffer | string): Promise<boolean> {
    const expectedTopic = receiptTopic(this.options.nodeId);
    if (topic !== expectedTopic) return this.reject("receipt_wrong_topic");
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      return this.reject("receipt_invalid_json");
    }
    const checked = validateMessage("event-receipt", parsed, {
      topic: expectedTopic,
    });
    if (!checked.valid) return this.reject("receipt_invalid_schema");
    const receipt = checked.payload as EventReceipt;
    if (
      receipt.node_id !== this.options.nodeId ||
      receipt.source !== this.options.source ||
      receipt.consumer_id !== this.options.consumerId ||
      receipt.status !== "stored" ||
      receipt.message_id !==
        `${receipt.event_id}:receipt:${this.options.consumerId}`
    )
      return this.reject("receipt_identity_mismatch");
    const event = this.options.outbox
      .list()
      .find((pending) => pending.event_id === receipt.event_id);
    if (!event) return this.reject("receipt_not_pending");
    if (event.node_id !== receipt.node_id || event.source !== receipt.source)
      return this.reject("receipt_event_mismatch");
    const removed = await this.options.outbox.acknowledge(receipt.event_id);
    if (!removed) return this.reject("receipt_not_pending");
    this.clearTimer(receipt.event_id);
    this.attempts.delete(receipt.event_id);
    return true;
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async publishPending(eventId: string): Promise<void> {
    if (!this.options.transport.connected || this.inFlight.has(eventId)) return;
    const event = this.options.outbox
      .list()
      .find((pending) => pending.event_id === eventId);
    if (!event) return;
    this.clearTimer(eventId);
    this.inFlight.add(eventId);
    try {
      await this.options.transport.publish(event);
    } catch (error) {
      this.options.onDiagnostic?.("event_publish_failed", {
        event_id: eventId,
        message: error instanceof Error ? error.message : "unknown_error",
      });
    } finally {
      this.inFlight.delete(eventId);
      if (this.options.outbox.list().some((item) => item.event_id === eventId))
        this.scheduleRetry(eventId);
    }
  }

  private scheduleRetry(eventId: string): void {
    const attempt = (this.attempts.get(eventId) ?? 0) + 1;
    this.attempts.set(eventId, attempt);
    const delay = Math.min(
      this.retryMaxMs,
      this.retryBaseMs * 2 ** Math.min(attempt - 1, 30),
    );
    this.timers.set(
      eventId,
      setTimeout(() => {
        this.timers.delete(eventId);
        void this.publishPending(eventId);
      }, delay),
    );
  }

  private clearTimer(eventId: string): void {
    const timer = this.timers.get(eventId);
    if (timer) clearTimeout(timer);
    this.timers.delete(eventId);
  }

  private reject(code: string): false {
    this.options.onDiagnostic?.(code);
    return false;
  }
}
