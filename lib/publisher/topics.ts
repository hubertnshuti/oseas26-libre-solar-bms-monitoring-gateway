import type { MessageKind } from "../contract/types.js";

export type ProducerTopicKind =
  "telemetry" | "summary" | "attributes" | "events";

export function producerTopic(nodeId: string, kind: ProducerTopicKind): string {
  if (!/^[0-9A-F]{16}$/.test(nodeId)) {
    throw new Error("Invalid node ID for MQTT topic");
  }
  return `libresolar/bms/v1/${nodeId}/${kind}`;
}

export function receiptTopic(nodeId: string): string {
  if (!/^[0-9A-F]{16}$/.test(nodeId)) {
    throw new Error("Invalid node ID for MQTT topic");
  }
  return `libresolar/bms/v1/${nodeId}/receipts/mpm`;
}

export function availabilityTopic(nodeId: string): string {
  if (!/^[0-9A-F]{16}$/.test(nodeId)) {
    throw new Error("Invalid node ID for MQTT topic");
  }
  return `libresolar/bms/v1/${nodeId}/availability`;
}

export function messageKindForTopic(kind: ProducerTopicKind): MessageKind {
  return kind === "events" ? "event" : kind;
}
