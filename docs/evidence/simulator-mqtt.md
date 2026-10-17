# Simulator MQTT verification

## Environment and command

Run from the gateway repository root with the locked Node dependencies installed:

```bash
npm test -- tests/unit/simulator.test.ts
npm test -- tests/unit/publisher.test.ts
npm run typecheck
npm run format:check
npm test
node --import tsx scripts/verify-simulator-mqtt.mjs
```

The real-broker harness starts an isolated `eclipse-mosquitto` container pinned
to digest
`sha256:38c0da4f2ef84284d47b3b3eeea1cb3bdeabe81ee10caf0cd5c5ff61ee3ea408`
(Mosquitto 2.1.2), plus two simulator processes, MQTT observers, and the actual
gateway MPM adapter connected to a local HTTP test sink. The temporary broker
configuration and credentials are generated for the test and removed at exit.
No shared Compose service or existing volume is changed.

## Observed broker behavior

The successful harness run verified:

- Live telemetry arrived at subscriber QoS 0 with the retain flag false.
- Summary and attributes arrived at a late subscriber with QoS 1 and retain true.
- The retained availability value changed from online to offline after clean stop.
- Killing a second producer with SIGKILL caused the broker LWT to publish
  retained offline availability at QoS 1.
- Restarting Mosquitto caused the running publisher to reconnect under the same
  session UUID, continue its sequence, and publish a fresh observation/summary.
- Two configured node IDs published only under their own node topics; every
  received telemetry, summary and attributes payload passed the shared v1
  validator.
- The existing MPM adapter received a retained simulator summary and POSTed it
  to `/api/libre-solar-bms/ingest/summaries`. The receiving HTTP endpoint was a
  local test sink, not MPM; no database write is claimed.
- A retained summary delivered to a late subscriber was byte-equivalent as JSON
  to the original summary and retained its original `observed_at` and
  `last_source_observed_at` values.

The broker subscriber negotiated QoS 1 for all test filters. The actual live
telemetry delivery was QoS 0 because that was the publisher's requested QoS;
summary, attributes and availability were delivered at QoS 1. The `retain` flag
was false for live publications and true when retained records were sent to a
new subscriber.

## Captured summary

The payload captured from the real broker is in
[`simulator-mqtt-summary.json`](simulator-mqtt-summary.json). Its topic is
`libresolar/bms/v1/53494D0000000001/summary`; the publisher requests QoS 1 with
retention. The sample is simulation data and passed the same schema/semantic
validator used by the adapter.

## Current limits

This evidence uses a local broker and a fake HTTP destination. It proves MQTT
transport and contract compatibility for this simulator slice, not MPM storage,
Home Assistant entities, hardware behavior, durable events, or production broker
security. Fault/outbox and Home Assistant observations are documented in
their separate verification records.
