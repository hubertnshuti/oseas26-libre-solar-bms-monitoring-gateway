import {
  isAvailability,
  parseMessage,
  validateMessage,
  type Attributes,
  type ProfileCapabilities,
  type Telemetry,
} from "../../lib/contract/index.js";
import type { AdapterConfig } from "./config.js";
import { type DeliveryKind, type DeliveryPayload } from "./http.js";
import type { QueueOutcome } from "./delivery.js";

export interface AdapterOutcome {
  result: QueueOutcome["result"] | "observed" | "rejected" | "paused";
  nodeId?: string;
  messageId?: string;
  code?: string;
  httpStatus?: number;
}

export class Adapter {
  private readonly profiles = new Map<string, Attributes>();
  private paused = false;
  private pending = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: Pick<
      AdapterConfig,
      "nodeIds" | "maxPendingMessages"
    > &
      Partial<Pick<AdapterConfig, "source">>,
    private readonly client: {
      deliver(
        kind: DeliveryKind,
        payload: DeliveryPayload,
      ): Promise<QueueOutcome>;
      profile?(
        nodeId: string,
        sessionId: string,
      ): ProfileCapabilities | undefined;
      observeTelemetry?(payload: Telemetry, retained: boolean): Promise<void>;
      observeAvailability?(nodeId: string, value: string): void;
    },
  ) {}

  handle(
    topic: string,
    raw: Buffer,
    retained = false,
  ): Promise<AdapterOutcome> {
    const match =
      /^libresolar\/bms\/v1\/([0-9A-F]{16})\/(summary|events|attributes|telemetry|availability)$/.exec(
        topic,
      );
    const nodeId = match?.[1];
    const suffix = match?.[2];
    if (!nodeId || !suffix || !this.config.nodeIds.includes(nodeId))
      return Promise.resolve({ result: "rejected", code: "unbound_topic" });
    if (suffix === "availability") {
      if (isAvailability(raw.toString("utf8")))
        this.client.observeAvailability?.(nodeId, raw.toString("utf8"));
      return Promise.resolve({
        result: isAvailability(raw.toString("utf8")) ? "observed" : "rejected",
        nodeId,
        code: "availability",
      });
    }
    const kind =
      suffix === "events"
        ? "event"
        : (suffix as "summary" | "attributes" | "telemetry");
    const parsed = parseMessage(kind, raw, { topic });
    if (!parsed.valid)
      return Promise.resolve({
        result: "rejected",
        nodeId,
        code: "invalid_payload",
      });
    const payload = parsed.payload;
    if (this.config.source && payload.source !== this.config.source)
      return Promise.resolve({
        result: "rejected",
        nodeId,
        code: "source_mismatch",
      });
    const profileKey = `${nodeId}:${payload.session_id}`;
    const profile =
      this.client.profile?.(nodeId, payload.session_id) ??
      this.profiles.get(profileKey);
    if (
      kind !== "attributes" &&
      profile &&
      !validateMessage(kind, payload, { profile }).valid
    )
      return Promise.resolve({
        result: "rejected",
        nodeId,
        code: "invalid_payload",
      });
    const identity = { nodeId, messageId: payload.message_id };
    if (kind === "telemetry")
      return (
        this.client.observeTelemetry?.(payload as Telemetry, retained) ??
        Promise.resolve()
      ).then(() => ({ result: "observed", ...identity }));
    if (this.paused)
      return Promise.resolve({
        result: "paused",
        ...identity,
        code: "configuration_error",
      });
    if (this.pending >= this.config.maxPendingMessages)
      return Promise.resolve({
        result: "rejected",
        ...identity,
        code: "capacity_exceeded",
      });
    this.pending++;
    const operation = this.tail
      .then(async (): Promise<AdapterOutcome> => {
        if (this.paused)
          return { result: "paused", ...identity, code: "configuration_error" };
        const outcome = await this.client.deliver(
          kind as DeliveryKind,
          payload as DeliveryPayload,
        );
        if (outcome.result === "configuration_error") this.paused = true;
        // A duplicate may refer to older metadata, not the backend's current profile.
        if (kind === "attributes" && outcome.result === "accepted") {
          const previous = this.profiles.get(profileKey);
          if (!previous || payload.sequence > previous.sequence)
            this.profiles.set(profileKey, payload as Attributes);
        }
        return { ...outcome, ...identity };
      })
      .finally(() => {
        this.pending--;
      });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}
