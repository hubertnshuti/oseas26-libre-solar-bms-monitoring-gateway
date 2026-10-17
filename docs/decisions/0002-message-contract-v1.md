# 0002: Versioned battery message contract

Recorded: 10 October 2026.
Status: implementation reference; interface changes require review.

## Context

A shared MQTT feed serves frequent measurements to Home Assistant and low-frequency summaries/events to MPM.
Both consumers need consistent units, explicit missing values, source identity, and observation times.
Transport acknowledgements alone do not establish application storage.

## Decision

Use the `libresolar/bms/v1/{node_id}` topic prefix and Draft 2020-12 JSON schemas with strict Ajv validation.
Semantic checks supplement schemas for topic/node consistency, profile layout, derived values, quality reasons, fault masks, and message identity.
Unknown fields and numeric strings are rejected rather than silently coerced.

Separate telemetry, summaries, events, attributes, source checks, and event receipts.
Keep last-known measurements separate from source/integration freshness.
Preserve the original identity and observation time when retrying a message.
Missing/unsupported values remain null with a quality reason; legitimate zero remains zero.

The demo profile is a simulated four-cell LFP battery with two battery-temperature channels.
State of health and cycle count are unsupported.
Pack and stack voltage retain their reported names because their physical interpretation depends on the selected firmware and wiring.
No terminal-power or battery-health estimate is inferred from those fields.

Use shared versioned fixtures on the TypeScript and PHP sides, with source revision and checksums recorded in MPM.
Breaking changes to units or meaning require a new major topic version.
Reviewed additive fields require matching schema/fixture changes before producer use.

## Consequences and remaining work

The [message contract](../message-contract.md) defines wire behavior and the [API contract](../api-contract.md) defines the backend boundary.
Strict validation makes incompatible changes visible at ingestion.
A durable producer outbox is implemented, but the current adapter still lacks durable HTTP retries, stored-event receipts, and source-status delivery.
Schema acceptance does not establish those runtime guarantees; see the [verification records](../evidence/README.md).
Hardware mapping and protection behavior require validation against physical equipment before deployment.
