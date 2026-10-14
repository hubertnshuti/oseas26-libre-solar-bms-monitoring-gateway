# Normal BMS simulator and MQTT feed

The gateway simulator produces explicitly simulated readings for the
`demo-lfp-4s-v1` four-cell, 100 Ah LFP profile. It uses the shared B02
normalizer and publishes the v1 MQTT contract. It does not model firmware
protection timing or a physical battery, and it does not implement fault
injection, Home Assistant discovery, or battery controls.

## Requirements and local broker

Use Node 24 with the repository dependencies installed (`npm ci` from the
gateway root). A local Mosquitto broker must be listening on loopback port 1883.
For a locally installed Mosquitto, open a terminal in the gateway root and run:

```bash
mosquitto -c docs/examples/mosquitto.local.conf -v
```

The example configuration listens only on `127.0.0.1`, permits anonymous
connections, and disables persistence. Use it only for a local demonstration.
For an isolated real-broker verification, run the reproducible harness in
[B03 evidence](evidence/simulator-mqtt.md); it starts a digest-pinned broker and
cleans up its own container and temporary files.

## Start the simulator

In a second terminal, from the gateway root:

```bash
node --import tsx app/simulator/main.ts \
  --profile demo-lfp-4s-v1 \
  --scenario normal-cycle \
  --seed 17 \
  --broker-url mqtt://127.0.0.1:1883
```

The first observation publishes immediately after connection; telemetry then
publishes every second. The console reports the node, telemetry sequence and
whether a summary accompanied that sample. Press Ctrl+C for a clean stop; the
publisher sends retained `offline` availability before disconnecting. If the
process or host stops unexpectedly, Mosquitto publishes the configured Last
Will and Testament.

All readings are simulation data (`source: "simulator"`). The simulator starts
SoC at 70% and applies the profile’s simulated ±5 A values. `normal-cycle`
charges first, then alternates charge/discharge every 300 simulation seconds.
`normal-charge` and `normal-discharge` hold one direction. Current variation,
cell spread and temperature variation are repeatable for the selected seed.
SoC changes through simple coulomb counting; it is not a validated electrochemical
model or a SoH estimate. Reported pack and stack voltages are constructed demo
signals that preserve their separate contract names; they make no claim about
physical register interpretation.

## Options and configuration

| Option             | Default                 | Meaning                                                                                               |
| ------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `--profile`        | `demo-lfp-4s-v1`        | Built-in profile ID or path to a compatible simulator profile JSON, relative to the current directory |
| `--scenario`       | `normal-cycle`          | `normal-cycle`, `normal-charge`, or `normal-discharge`                                                |
| `--seed`           | `1`                     | Integer from 0 through 4294967295                                                                     |
| `--node-id`        | Profile node ID         | Override with exactly 16 uppercase hexadecimal characters                                             |
| `--broker-url`     | `mqtt://127.0.0.1:1883` | MQTT or MQTTS broker origin, without credentials or URL paths                                         |
| `--help`           | —                       | Print supported options                                                                               |
| `--list-scenarios` | —                       | Print supported normal scenarios                                                                      |

For a broker requiring login, provide `MQTT_USERNAME` and `MQTT_PASSWORD` in the
process environment. Do not put credentials in command-line arguments or commit
working credentials. The current integration harness uses an isolated local
broker and test-only credentials, not a production broker configuration.

The simulator accepts a clock and random source through its exported generator
API for deterministic tests. The runtime uses the host clock for observation
timestamps and a seeded PRNG for generated values. A repeated profile, scenario,
seed, and explicit clock sequence reproduces the same raw and normalized value
sequence. Session UUIDs and publication times are intentionally generated at
process runtime.

## MQTT topics and lifecycle

For node `53494D0000000001`, the prefix is
`libresolar/bms/v1/53494D0000000001/`.

| Suffix         | QoS | Retained | Behavior                                                                                       |
| -------------- | --: | -------- | ---------------------------------------------------------------------------------------------- |
| `telemetry`    |   0 | No       | Normalized sample every second                                                                 |
| `summary`      |   1 | Yes      | Initial sample, every 60 seconds, and when BMS state or fault mask/codes change                |
| `attributes`   |   1 | Yes      | At process startup and each successful broker connection                                       |
| `availability` |   1 | Yes      | `online` after connection; `offline` on clean stop; `offline` as broker LWT on unexpected loss |

Use the node ID configured for that process when subscribing. For example, from
the gateway root in a third terminal:

```bash
mosquitto_sub -h 127.0.0.1 -p 1883 -t 'libresolar/bms/v1/+/telemetry' -v
```

To inspect retained summaries, subscribe to
`libresolar/bms/v1/+/summary` with a new `mosquitto_sub` client. A late
subscriber receives retained summaries and attributes at QoS 1. The broker
delivers telemetry only while it is being published; it does not retain old
samples. Summary `observed_at` and `last_source_observed_at` refer to the sample,
while `published_at` records its publication time.

The publisher assigns one producer session UUID at process startup and shares a
single increasing sequence across attributes, telemetry, and summaries. A
reconnect keeps the same session and counter, republishes attributes, then
produces a new observation and summary. It does not replay missed one-second
samples. MQTT loss pauses generation; after reconnect the feed resumes with a
current sample, not fabricated historical readings.

The publisher is transport-independent from simulation logic. A future hardware
reader can submit a `nodeId`, `observedAt`, and B02 `NormalizedMeasurements` to
`MqttPublisher.publishObservation`. It must use profile-compatible capabilities
and identity values. Profile changes require a new producer configuration; B03
does not add live profile reload.

## Verification

From the gateway root, run the focused tests and repository checks:

```bash
npm test -- tests/unit/simulator.test.ts
npm test -- tests/unit/publisher.test.ts
npm run typecheck
npm run format:check
npm test
node --import tsx scripts/verify-simulator-mqtt.mjs
```

The integration harness requires Docker and loopback access. It uses a pinned
Eclipse Mosquitto image, starts two simulator processes, validates actual MQTT
messages, exercises retained delivery, restart, clean stop and LWT, and passes a
retained summary through the existing MPM adapter to a local HTTP test sink. The
sink is not an MPM server or database. See [the captured evidence](evidence/simulator-mqtt.md)
for the result from this revision.
