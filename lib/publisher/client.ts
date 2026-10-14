import type {
  Attributes,
  FaultEvent,
  ProfileCapabilities,
  ProducerEnvelope,
  Source,
  Summary,
  Telemetry,
} from "../contract/types.js";
import {
  assembleSummaryPayload,
  assembleTelemetryPayload,
  type NormalizedMeasurements,
} from "../libresolar/index.js";
import { validateMessage } from "../contract/validate.js";
import { ProducerSession } from "./session.js";
import { availabilityTopic, producerTopic } from "./topics.js";

export interface PublishOptions {
  qos: 0 | 1 | 2;
  retain: boolean;
}

export interface MqttTransport {
  readonly connected: boolean;
  publishAsync(
    topic: string,
    payload: string,
    options: PublishOptions,
  ): Promise<unknown>;
}

export type AttributesPayload = Omit<Attributes, keyof ProducerEnvelope>;

export interface PublisherConfig {
  nodeId: string;
  source: Source;
  clockSource: "simulator_host" | "gateway_host" | "device";
  profile: ProfileCapabilities;
  attributes: AttributesPayload;
  now?: () => Date;
  monotonicNow?: () => number;
  sessionId?: string;
  uuid?: () => string;
  summaryIntervalMs?: number;
}

export interface Observation {
  nodeId: string;
  observedAt: string;
  measurements: NormalizedMeasurements;
}

export interface PublishResult {
  telemetry: Telemetry;
  summary?: Summary;
}

export interface FaultEventTransition {
  kind: FaultEvent["kind"];
  previousErrorFlags: number | null;
  currentErrorFlags: number | null;
  faults: string[] | null;
  addedFaults: string[];
  clearedFaults: string[];
}

export class MqttPublisher {
  private readonly session: ProducerSession;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private readonly summaryIntervalMs: number;
  private lastSummarizedTelemetry?: Telemetry;
  private lastSummaryAt?: number;

  constructor(
    private readonly mqtt: MqttTransport,
    private readonly config: PublisherConfig,
  ) {
    if (config.profile.source !== config.source) {
      throw new Error("Publisher source does not match profile capabilities");
    }
    this.now = config.now ?? (() => new Date());
    this.monotonicNow = config.monotonicNow ?? (() => performance.now());
    this.summaryIntervalMs = config.summaryIntervalMs ?? 60_000;
    this.session = new ProducerSession({
      nodeId: config.nodeId,
      source: config.source,
      clockSource: config.clockSource,
      ...(config.sessionId ? { sessionId: config.sessionId } : {}),
      ...(config.uuid ? { uuid: config.uuid } : {}),
      now: this.now,
    });
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  async onConnect(): Promise<void> {
    await this.publishRaw(availabilityTopic(this.config.nodeId), "online", {
      qos: 1,
      retain: true,
    });
    await this.publishAttributes();
  }

  async publishObservation(
    observation: Observation,
    options: { forceSummary?: boolean } = {},
  ): Promise<PublishResult> {
    if (observation.nodeId !== this.config.nodeId) {
      throw new Error("Observation node ID does not match publisher node ID");
    }
    if (!this.mqtt.connected) throw new Error("MQTT client is disconnected");
    const envelope = this.session.next("telemetry", observation.observedAt);
    const telemetry = assembleTelemetryPayload(
      envelope,
      observation.measurements,
    );
    this.assertValid(
      "telemetry",
      telemetry,
      producerTopic(this.config.nodeId, "telemetry"),
    );
    await this.publishRaw(
      producerTopic(this.config.nodeId, "telemetry"),
      JSON.stringify(telemetry),
      { qos: 0, retain: false },
    );

    const monotonic = this.monotonicNow();
    const summaryChanged =
      !this.lastSummarizedTelemetry ||
      this.lastSummarizedTelemetry.bms_state_code !==
        telemetry.bms_state_code ||
      this.lastSummarizedTelemetry.error_flags !== telemetry.error_flags ||
      JSON.stringify(this.lastSummarizedTelemetry.faults) !==
        JSON.stringify(telemetry.faults);
    const summaryDue =
      this.lastSummaryAt === undefined ||
      monotonic - this.lastSummaryAt >= this.summaryIntervalMs;
    if (options.forceSummary || summaryChanged || summaryDue) {
      const summary = await this.publishSummary(telemetry, monotonic);
      return { telemetry, summary };
    }
    return { telemetry };
  }

  async publishOffline(): Promise<void> {
    if (this.mqtt.connected) {
      await this.publishRaw(availabilityTopic(this.config.nodeId), "offline", {
        qos: 1,
        retain: true,
      });
    }
  }

  createFaultEvent(
    telemetry: Telemetry,
    transition: FaultEventTransition,
  ): FaultEvent {
    if (telemetry.node_id !== this.config.nodeId)
      throw new Error("Telemetry node ID does not match publisher node ID");
    const envelope = this.session.next("events", telemetry.observed_at);
    const event: FaultEvent = {
      ...envelope,
      event_id: envelope.message_id,
      telemetry_message_id: telemetry.message_id,
      kind: transition.kind,
      previous_error_flags: transition.previousErrorFlags,
      current_error_flags: transition.currentErrorFlags,
      faults: transition.faults,
      added_faults: transition.addedFaults,
      cleared_faults: transition.clearedFaults,
    };
    this.assertValid(
      "event",
      event,
      producerTopic(this.config.nodeId, "events"),
    );
    return event;
  }

  async publishFaultEvent(event: FaultEvent): Promise<void> {
    if (event.node_id !== this.config.nodeId)
      throw new Error("Event node ID does not match publisher node ID");
    this.assertValid(
      "event",
      event,
      producerTopic(this.config.nodeId, "events"),
    );
    await this.publishRaw(
      producerTopic(this.config.nodeId, "events"),
      JSON.stringify(event),
      { qos: 1, retain: false },
    );
  }

  private async publishAttributes(): Promise<void> {
    const at = this.now().toISOString();
    const attributes: Attributes = {
      ...this.session.next("attributes", at),
      ...this.config.attributes,
    };
    this.assertValid(
      "attributes",
      attributes,
      producerTopic(this.config.nodeId, "attributes"),
    );
    await this.publishRaw(
      producerTopic(this.config.nodeId, "attributes"),
      JSON.stringify(attributes),
      { qos: 1, retain: true },
    );
  }

  private async publishSummary(
    telemetry: Telemetry,
    monotonic: number,
  ): Promise<Summary> {
    const envelope = this.session.next("summary", telemetry.observed_at);
    const summary = assembleSummaryPayload(
      envelope,
      telemetry,
      telemetry.message_id,
      telemetry.observed_at,
    );
    this.assertValid(
      "summary",
      summary,
      producerTopic(this.config.nodeId, "summary"),
    );
    await this.publishRaw(
      producerTopic(this.config.nodeId, "summary"),
      JSON.stringify(summary),
      { qos: 1, retain: true },
    );
    this.lastSummaryAt = monotonic;
    this.lastSummarizedTelemetry = telemetry;
    return summary;
  }

  private assertValid(
    kind: "telemetry" | "summary" | "attributes" | "event",
    payload: unknown,
    topic: string,
  ): void {
    const result = validateMessage(kind, payload, {
      topic,
      profile: this.config.profile,
    });
    if (!result.valid) {
      throw new Error(
        `Refusing invalid ${kind} message: ${result.issues.map((issue) => `${issue.path}:${issue.code}`).join(",")}`,
      );
    }
  }

  private async publishRaw(
    topic: string,
    payload: string,
    options: PublishOptions,
  ): Promise<void> {
    if (!this.mqtt.connected) throw new Error("MQTT client is disconnected");
    await this.mqtt.publishAsync(topic, payload, options);
  }
}
