# B04 event and outbox verification

## Environment and commands

Captured on the B04 branch with Node v24.21.0, npm 11.19.0, Docker Engine
29.6.2, and Eclipse Mosquitto 2.1.2. The broker image is pinned to
`sha256:38c0da4f2ef84284d47b3b3eeea1cb3bdeabe81ee10caf0cd5c5ff61ee3ea408`.
Run these from the gateway root with repository dependencies installed:

```bash
npm test -- tests/unit/scenarios.test.ts
npm test -- tests/unit/events.test.ts
npm test -- tests/unit/outbox.test.ts
npm test -- tests/unit/simulator.test.ts
npm test -- tests/unit/publisher.test.ts
npm run typecheck
npm run format:check
npm test
node --import tsx scripts/verify-simulator-mqtt.mjs
node --import tsx scripts/verify-simulator-events.mjs
```

The broker harness creates an isolated authenticated Mosquitto container,
loopback-only port, generated test credentials and ACL, persistent broker data,
and a temporary file-backed receipt test double. It removes its own container
and temporary files. It does not modify shared A06 configuration.

## Actual adapter boundary

The current `app/mpm-ingest` adapter subscribes to `events` and forwards them to
its HTTP endpoint, but does not subscribe to `receipts/mpm`, publish `stored`
receipts, or persist its delivery queue. Its current docs explicitly mark
application receipts and durable delivery as later work. The B04 broker harness
therefore tests the receipt exchange against a faithful MQTT/durable-file test
double that validates event and receipt schemas, commits an event file before
publishing `stored`, and returns the same receipt for duplicate event IDs.
This is not an actual A04 adapter receipt test and does not prove an MPM database
contains exactly one event. Real end-to-end adapter/MPM durability remains
pending A04 receipt support and an available MPM database integration.

## Broker assertions

The final real-broker run passed on 2026-10-14 with result `passed` and
`durableTestDoubleUniqueEvents: 1`. Its assertions covered the producer
starting before the adapter, real `events` QoS 1/non-retained publications,
broker restart, producer restart with exact event ID/time, adapter crash before
storage, suppressed receipt and duplicate retry, adapter restart from its test
store, valid receipt clearance, duplicate replay, outbox capacity degradation,
and connected-silent recovery with `observation_gap`. The captured event and
authorized `stored` receipt are in [simulator-events.json](simulator-events.json).

The code checks completed on this revision: typecheck passed; format check
passed; the five targeted simulator, publisher, event, scenario and outbox test
files passed all 45 tests; the full suite passed all 275 tests. The first full
suite attempt was blocked by sandbox loopback permissions; the successful run
used the approved local-network test environment. The existing B03 Mosquitto
regression also passed with all eight assertions, including retained summary
forwarding through the actual A04 adapter to an HTTP test sink.

The ACL names `producer`, `adapter` and `observer` are test-only. Mosquitto
allows the producer to subscribe to its configured receipt branch, allows the
adapter identity to publish there, and denies producer and anonymous receipt
publishes. The harness checks broker denial logs and observed messages because
MQTT 3 brokers may send PUBACK with reason code 135 for a denied QoS 1 publish.
The actual adapter is not configured with these receipt ACL permissions.

## Captured event handoff

[`simulator-events.json`](simulator-events.json) contains one event and its
`stored` receipt captured through actual broker subscriptions. The receiver is
explicitly identified as the faithful test double. The example is suitable for
reviewing Member 3's event/receipt interface, not evidence of MPM persistence.

## Acceptance status

- Scenario commands and expected outputs are listed in `docs/simulator.md` and
  exercised by `tests/unit/scenarios.test.ts` and the broker harness.
- Missing fault masks remain unknown in the detector tests; the simulator's
  missing current measurement stays null with B02 `not_reported` quality.
- Outbox restart and duplicate idempotency were verified against the durable
  MQTT test double. **Actual A04/MPM adapter receipt and unique database record
  remain pending.** The existing adapter forwards events but does not publish
  receipts, so acceptance of end-to-end event durability and exactly-once MPM
  persistence is not established by this B04 run.
- Capacity exhaustion leaves the existing outbox record intact and emits
  `outbox_capacity_exceeded`; unit and actual-broker harness checks cover it.
