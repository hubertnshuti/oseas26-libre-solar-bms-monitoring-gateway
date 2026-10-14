import { randomUUID } from "node:crypto";
import type { ProducerEnvelope } from "../contract/types.js";
import type { Source } from "../contract/types.js";
import type { ProducerTopicKind } from "./topics.js";

export interface SessionOptions {
  nodeId: string;
  source: Source;
  clockSource: ProducerEnvelope["clock_source"];
  sessionId?: string;
  uuid?: () => string;
  now: () => Date;
}

export class ProducerSession {
  readonly sessionId: string;
  private sequence = 0;

  constructor(private readonly options: SessionOptions) {
    this.sessionId = options.sessionId ?? (options.uuid ?? randomUUID)();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        this.sessionId,
      )
    ) {
      throw new Error("Invalid producer session UUID");
    }
  }

  next(kind: ProducerTopicKind, observedAt: string): ProducerEnvelope {
    const sequence = this.sequence++;
    const published = this.options.now();
    if (!Number.isFinite(published.getTime()))
      throw new Error("Invalid publication time");
    const observedTime = new Date(observedAt);
    const publishedTime = new Date(published);
    if (!Number.isFinite(observedTime.getTime()))
      throw new Error("Invalid observation time");
    if (publishedTime < observedTime)
      throw new Error("Publication precedes observation");
    const suffix = kind === "attributes" ? "attributes" : kind;
    return {
      schema_version: 1,
      node_id: this.options.nodeId,
      source: this.options.source,
      session_id: this.sessionId,
      sequence,
      message_id: `${this.options.nodeId}:${this.sessionId}:${suffix}:${sequence}`,
      observed_at: observedTime.toISOString(),
      published_at: publishedTime.toISOString(),
      clock_source: this.options.clockSource,
    };
  }
}
