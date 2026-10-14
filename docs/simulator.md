# Normal BMS simulator and MQTT feed

The gateway simulator produces explicitly simulated readings for the
`demo-lfp-4s-v1` four-cell, 100 Ah LFP profile. It uses the shared B02
normalizer and publishes the v1 MQTT contract. Named B04 scenarios exercise
faults, missing values, silent observation, connection loss and recovery. They
are test inputs, not physical battery measurements or firmware behavior. Home
Assistant discovery and battery controls are not implemented.

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

| Option              | Default                           | Meaning                                                                                               |
| ------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `--profile`         | `demo-lfp-4s-v1`                  | Built-in profile ID or path to a compatible simulator profile JSON, relative to the current directory |
| `--scenario`        | `normal-cycle`                    | Normal, fault, recovery, missing-reading, silent and disconnect scenarios below                       |
| `--seed`            | `1`                               | Integer from 0 through 4294967295                                                                     |
| `--node-id`         | Profile node ID                   | Override with exactly 16 uppercase hexadecimal characters                                             |
| `--broker-url`      | `mqtt://127.0.0.1:1883`           | MQTT or MQTTS broker origin, without credentials or URL paths                                         |
| `--help`            | —                                 | Print supported options                                                                               |
| `--list-scenarios`  | —                                 | Print all supported scenarios                                                                         |
| `--outbox-path`     | `.bms-runtime/<node>.events.json` | Producer-owned persistent pending-event file                                                          |
| `--outbox-capacity` | `256`                             | Maximum number of unacknowledged events, range 1–10000                                                |
| `--consumer-id`     | `mpm-demo`                        | Expected adapter receipt identity                                                                     |
| `--gap-ms`          | `15000`                           | Minimum missed-observation interval for `observation_gap`, range 1000–3600000 ms                      |
| `--replay-event`    | —                                 | Republish the exact payload for a pending event ID after connection                                   |

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

## Failure and recovery scenarios

Scenario time starts at the first simulator tick. Cell, temperature, current,
profile channel layout and reset values come from the selected profile. These
are explicitly simulated values; threshold timings do not reproduce firmware
delay logic. Each command below runs from the gateway root with a local broker
already running. A second terminal can subscribe to events with
`mosquitto_sub -h 127.0.0.1 -p 1883 -t 'libresolar/bms/v1/+/events' -v`.

| Scenario ID                 | Launch command (`--broker-url` may be changed)                                                    | Expected telemetry, summary, event and availability behavior                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normal-cycle`              | `node --import tsx app/simulator/main.ts --scenario normal-cycle --seed 17`                       | Baseline charge/discharge values; no fault events; normal QoS/timing and online availability.                                                                                                                                                     |
| `normal-charge`             | `node --import tsx app/simulator/main.ts --scenario normal-charge --seed 17`                      | Positive current; no fault event unless an observed fault changes.                                                                                                                                                                                |
| `normal-discharge`          | `node --import tsx app/simulator/main.ts --scenario normal-discharge --seed 17`                   | Negative current; no fault event unless an observed fault changes.                                                                                                                                                                                |
| `cell-overvoltage`          | `node --import tsx app/simulator/main.ts --scenario cell-overvoltage --seed 17`                   | Logical last configured cell exceeds the profile trip threshold from 2–8 s, reaches its reset value at 8 s, then returns to baseline. Telemetry flags the configured `cell_overvoltage`; event and summary follow the observed set and clear.     |
| `cell-undervoltage`         | `node --import tsx app/simulator/main.ts --scenario cell-undervoltage --seed 17`                  | Logical first configured cell crosses the profile undervoltage threshold, returns to its reset value, then baseline; event records the observed fault and clear.                                                                                  |
| `over-temperature`          | `node --import tsx app/simulator/main.ts --scenario over-temperature --seed 17`                   | First configured battery sensor rises above the charge threshold, current changes to discharge after 5 s and uses the discharge threshold/fault, then reaches its matching reset value. No electronics sensor is misreported as a battery sensor. |
| `increasing-cell-imbalance` | `node --import tsx app/simulator/main.ts --scenario increasing-cell-imbalance --seed 17`          | Cell delta grows to a peak at 8 s and returns toward baseline by 12 s. No invented fault flag/event is emitted solely for imbalance.                                                                                                              |
| `missing-reading`           | `node --import tsx app/simulator/main.ts --scenario missing-reading --seed 17`                    | `pack_current` is null with B02 `not_reported` quality from 2–8 s, then resumes; the fault mask remains known zero.                                                                                                                               |
| `connected-but-silent`      | `node --import tsx app/simulator/main.ts --scenario connected-but-silent --seed 17 --gap-ms 1000` | MQTT stays online while telemetry pauses from 3 s for 5 s; on resume, one `observation_gap` event has no invented added/cleared faults.                                                                                                           |
| `disconnect-reconnect`      | `node --import tsx app/simulator/main.ts --scenario disconnect-reconnect --seed 17`               | The simulator drops its MQTT stream once at 3 s. Mosquitto publishes LWT offline; MQTT.js reconnects under the same process session, republishes online, attributes and a fresh observation.                                                      |
| `recovery`                  | `node --import tsx app/simulator/main.ts --scenario recovery --seed 17`                           | Simulated cell overvoltage is observed at 2 s, reaches the profile reset value at 5 s, clears the flag and emits an observed `fault_changed` recovery.                                                                                            |

The scenario-specific cell and temperature cases require the corresponding
profile-supported measurements. They reject incompatible custom profiles
rather than synthesizing unsupported sensor arrays. The gap threshold defaults
to 15 seconds; `--gap-ms` is a local detector setting, not a new wire field.

## Events, receipts and durable outbox

The detector consumes published normalized telemetry. A first known non-zero
mask produces `fault_observed`; a change between known masks, including recovery
to zero, produces `fault_changed`; an observation delayed longer than `--gap-ms`
produces `observation_gap` with both transition lists empty. A null fault mask
stays unknown and never becomes zero. After an unknown mask, the next known mask
establishes a baseline; it does not infer an unseen transition.

Before an event is first published, the producer atomically writes it to the
JSON outbox file. The default is `.bms-runtime/<node-id>.events.json`, which is
ignored by Git. Set `--outbox-path` to choose another local file and
`--outbox-capacity` to bound pending events. Writes use a mode-0600 temporary
file, `fsync`, atomic rename and directory sync. Corrupt files or write errors
stop startup/delivery visibly; they are never silently reset. If capacity is
full, the process logs `outbox_capacity_exceeded`, exits degraded, and keeps all
existing pending events intact. Inspect pending events with
`cat .bms-runtime/<node-id>.events.json` (replace the node ID with the actual
configured ID).

Events publish to `libresolar/bms/v1/{node_id}/events` at QoS 1, non-retained.
The producer subscribes to its node's `receipts/mpm` at QoS 1. It removes an
event only after the shared validator accepts a matching receipt with the
configured `--consumer-id`, exact node/source/event identity, derived receipt
message ID, and contract status `stored`. PUBACK, malformed, unknown, wrong-node,
wrong-consumer or wrong-topic messages do not clear the outbox. Retry delay is
bounded exponential backoff from 1 second to 30 seconds. On process restart,
pending event IDs and original observed timestamps are replayed unchanged; new
observations use a fresh session.

For duplicate replay diagnostics, copy a pending `event_id` from the outbox and
start the simulator with the same `--outbox-path` and
`--replay-event <event-id>`. This publishes the exact event payload again; it
does not create a new event. Stop with Ctrl+C to leave unacknowledged events on
disk. An absent adapter or broker therefore leaves the producer's event durable.

The current A04 gateway adapter does not yet publish `stored` receipts and has
an in-memory delivery queue. B04's real Mosquitto harness uses a separate
faithful MQTT/durable-file adapter test double, not the A04 adapter or MPM
database. Its ACL gives the producer read access to receipt topics but write
access only to producer topics; only the adapter test identity can write
receipts. The anonymous `docs/examples/mosquitto.local.conf` broker cannot
authenticate that identity and is for manual scenario inspection only. Do not
use it to claim receipt security or end-to-end fault durability.

See [B04 broker evidence](evidence/simulator-events.md) and the captured
[event and stored receipt](evidence/simulator-events.json) for actual observed
messages, restart results, ACL checks and the adapter limitation.

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
