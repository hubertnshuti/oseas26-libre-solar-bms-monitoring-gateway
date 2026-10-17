# Event and producer outbox verification

Recorded real-broker run: 14 October 2026.
Environment: Node `24.21.0`, npm `11.19.0`, Docker Engine `29.6.2`, and Eclipse Mosquitto `2.1.2`.
Broker digest: `sha256:38c0da4f2ef84284d47b3b3eeea1cb3bdeabe81ee10caf0cd5c5ff61ee3ea408`.

## Reproduction

From the gateway root with installed dependencies and Docker/local socket access:

```bash
npm run typecheck
npm run format:check
npm test
node --import tsx scripts/verify-simulator-mqtt.mjs
node --import tsx scripts/verify-simulator-events.mjs
```

The event harness creates an isolated authenticated broker, loopback port, test ACL, persistent broker data, and a file-backed receiver test double.
It removes its own resources at exit.

## Recorded results

The event harness returned `passed` with `durableTestDoubleUniqueEvents: 1`.
It covered producer-before-receiver startup, QoS 1/non-retained events, broker restart, producer restart with the original event identity/time, receiver crash before storage, suppressed receipts, duplicate replay, receiver restart, outbox capacity exhaustion, and connected-silent recovery with `observation_gap`.

The receiver validates and durably stores an event before publishing a `stored` receipt.
Identical retries return the same receipt.
The test ACL permits receipt publication only from the receiver identity and checks denial of unauthorized publication.
These ACL credentials and identities are generated or designated for isolated testing.

Typechecking, formatting, 45 targeted tests across five files, and the full 275-test suite passed at the recorded implementation stage.
The existing simulator MQTT regression also passed.

[Captured event and receipt](simulator-events.json) came from actual broker subscriptions, using the receiver test double.

## Delivery boundary

The production adapter forwards events to MPM but does not publish `stored` receipts or persist its HTTP delivery queue.
The harness therefore establishes producer outbox/receipt behavior against the test double, not complete adapter/MPM recovery or exactly-once database effects.
The missing-receipt behavior remains visible in [the adapter guide](../mpm-ingest.md).
Outbox capacity exhaustion preserves existing records and reports `outbox_capacity_exceeded`.
Missing fault masks stay unknown; observation gaps do not invent fault or recovery transitions.
