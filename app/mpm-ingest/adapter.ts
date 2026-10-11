import {
  isAvailability,
  parseMessage,
  type Attributes,
  type ProfileCapabilities,
} from "../../lib/contract/index.js";
import type { AdapterConfig } from "./config.js";
import { MpmClient, type DeliveryKind, type DeliveryOutcome } from "./http.js";

export interface AdapterOutcome {
  result: DeliveryOutcome["result"] | "observed" | "rejected" | "paused";
  nodeId?: string;
  messageId?: string;
  code?: string;
  httpStatus?: number;
}

export class Adapter {
  private readonly profiles = new Map<string, ProfileCapabilities>();
  private paused = false;
  private pending = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: Pick<
      AdapterConfig,
      "nodeIds" | "maxPendingMessages"
    >,
    private readonly client: Pick<MpmClient, "deliver">,
  ) {}

  handle(topic: string, raw: Buffer): Promise<AdapterOutcome> {
    const match =
      /^libresolar\/bms\/v1\/([0-9A-F]{16})\/(summary|events|attributes|telemetry|availability)$/.exec(
        topic,
      );
    const nodeId = match?.[1];
    const suffix = match?.[2];
    if (!nodeId || !suffix || !this.config.nodeIds.includes(nodeId))
      return Promise.resolve({ result: "rejected", code: "unbound_topic" });
    if (suffix === "availability")
      return Promise.resolve({
        result: isAvailability(raw.toString("utf8")) ? "observed" : "rejected",
        nodeId,
        code: "availability",
      });
    const kind =
      suffix === "events"
        ? "event"
        : (suffix as "summary" | "attributes" | "telemetry");
    const parsed = parseMessage(kind, raw, {
      topic,
      profile: this.profiles.get(nodeId),
    });
    if (!parsed.valid)
      return Promise.resolve({
        result: "rejected",
        nodeId,
        code: "invalid_payload",
      });
    const payload = parsed.payload;
    const identity = { nodeId, messageId: payload.message_id };
    if (kind === "telemetry")
      return Promise.resolve({ result: "observed", ...identity });
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
          payload as Parameters<MpmClient["deliver"]>[1],
        );
        if (outcome.result === "configuration_error") this.paused = true;
        // A duplicate may refer to older metadata, not the backend's current profile.
        if (kind === "attributes" && outcome.result === "accepted")
          this.profiles.set(nodeId, payload as Attributes);
        return { ...outcome, ...identity };
      })
      .catch((): AdapterOutcome => ({
        result: "delivery_failed",
        ...identity,
        code: "unexpected_delivery_error",
      }))
      .finally(() => {
        this.pending--;
      });
    this.tail = operation;
    return operation;
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}
