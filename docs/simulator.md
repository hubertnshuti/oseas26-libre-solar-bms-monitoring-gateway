# Libre Solar BMS simulator and demo guide

This guide covers the B01–B04 implementation on `team/bms-monitoring` commit
`888557c`. Home Assistant discovery is B05; at the time of writing its code is
on the separate local branch `feat/home-assistant-discovery` at `9dd42ae` and
has not been merged into this base. See [Home Assistant setup](home-assistant.md)
for that dependency and local test arrangement.

Every generated reading and threshold is a **simulated test input**. It is not
from a physical battery, a validated battery model, a recommended protection
setting, or proof of firmware behavior.

## What the simulator does

`app/simulator/` generates repeatable raw readings from the
`demo-lfp-4s-v1` profile. The pure B02 normalizer in `lib/libresolar/` converts
them to supported v1 values and quality reasons. The reusable B03 publisher
validates and publishes those messages. B04 adds observation-based fault events
and a bounded persistent producer outbox.

The MQTT-to-MPM adapter is a separate consumer. The current A04 adapter
forwards summaries/events but does not publish durable `stored` receipts. The
producer therefore retains unacknowledged events. B04's receipt/restart broker
tests use a faithful adapter test double; they do not prove MPM database
storage. Home Assistant is a read-only consumer for frequent measurements and
history. Its B05 discovery implementation requires the separately tracked B05
commit above; neither consumer changes the v1 message contract.

References: [B01 source profile](simulator-source-profile.md),
[B02 normalization](libresolar-normalization.md),
[v1 message contract](message-contract.md),
[B03 MQTT evidence](evidence/simulator-mqtt.md), and
[B04 event/outbox evidence](evidence/simulator-events.md).

## Requirements and project setup

The verification environment used Node.js `24.21.0`, npm `11.19.0`, Docker
Desktop `4.83.0` / Docker Engine `29.6.2`, Eclipse Mosquitto `2.1.2`, and Home
Assistant Container `2026.10.1` for B05. Broker/HA images are pinned by digest
in the evidence documents. There is no integrated A06 Compose stack in this
repository at this baseline. These are verified environment versions, not a
claim that every OS/version combination is tested.

From Ubuntu/WSL, check installed tools:

```bash
git --version
node --version
npm --version
docker version
docker compose version
command -v mosquitto
command -v mosquitto_sub
```

`docker version` must show both client and server. If `mosquitto_sub` is absent,
install your distro's `mosquitto-clients` package; the simulator itself uses the
locked Node MQTT dependency. On Windows, start Docker Desktop with WSL 2
integration enabled for this Ubuntu distribution. Do not install a second
Docker Engine inside WSL.

In the gateway directory, select Node from `.nvmrc` and install locked
dependencies:

```bash
cd /home/evariste/work/oseas/gateway
nvm install
nvm use
npm ci
```

For a clone elsewhere, use that clone's gateway path. The checked-in `.nvmrc`
selects Node `24.21.0`.

## Demo profile

`demo-lfp-4s-v1` is a 4S LFP profile with nominal simulated capacity 100 Ah. It
defines four cell measurements on zero-based test channels `[0, 1, 2, 3]`, two
battery-temperature sensors on `[0, 1]`, and separate IC and MOSFET
temperatures. These channel mappings are not verified board wiring.

Shunt temperature, SoH and cycle count are unsupported and must not be
fabricated. Positive current means charging, negative means discharging, and
zero is a valid reading. `pack_voltage_reported` and
`stack_voltage_reported` retain separate source labels because their physical
terminal interpretation depends on board wiring and switch state. Do not infer
power from either reported voltage without resolving that mapping.

The profile's simulated scenario values are: cell overvoltage 3.65 V/reset
3.50 V; undervoltage 2.80 V/reset 3.00 V; charge overtemperature 45 °C/reset
42 °C; discharge overtemperature 60 °C/reset 57 °C. These are test inputs, not
safe settings or recommendations for a physical pack. See the [B01 source
map](simulator-source-profile.md) for source fields and limitations.

Normal operation starts near 70% simulated SoC and uses approximately +5 A
charge and −5 A discharge. `normal-cycle` switches direction every 300 seconds.
The coulomb-counting update is a small test model, not validated
electrochemistry or a State of Health estimate.

## Start a local broker and simulator

### Locally installed Mosquitto

In terminal 1, from the gateway root:

```bash
mosquitto -c docs/examples/mosquitto.local.conf -v
```

This example listens on `127.0.0.1:1883`, allows anonymous connections, and
disables persistence. It is for local manual inspection only, not production or
a security/ACL test.

In terminal 2, from the gateway root, inspect supported options and scenarios,
then launch the normal feed:

```bash
node --import tsx app/simulator/main.ts --help
node --import tsx app/simulator/main.ts --list-scenarios
node --import tsx app/simulator/main.ts \
  --profile demo-lfp-4s-v1 \
  --scenario normal-cycle \
  --seed 17 \
  --node-id 53494D0000000001 \
  --broker-url mqtt://127.0.0.1:1883 \
  --outbox-path /tmp/bms-normal.events.json
```

The first sample follows connection; later telemetry is scheduled at 1 Hz. The
terminal prints JSON statuses such as `connected`, `published`, `reconnected`
and `stopped`. Press Ctrl+C for a clean stop; retained availability becomes
`offline`. A broker Last Will publishes offline after an unexpected
connection loss. Unacknowledged events remain on disk.

### Real-broker verification scripts

With Docker Desktop running and from the gateway root:

```bash
node --import tsx scripts/verify-simulator-mqtt.mjs
node --import tsx scripts/verify-simulator-events.mjs
```

The scripts create and clean up their own test containers and temporary files.
The first checks B03 against Mosquitto; the second checks B04 receipt behavior
with a durable adapter test double. Review the evidence before interpreting
results. Neither changes shared A06 deployment configuration.

## Configuration reference

`--help` lists runtime options; `--list-scenarios` lists the scenario IDs.
Unknown and repeated CLI options are rejected. `--profile` accepts the built-in
profile ID or a compatible JSON path relative to the current directory.

| Option              | Type / default                              | Accepted values and purpose                                                                                            |
| ------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--profile`         | string / `demo-lfp-4s-v1`                   | Built-in profile ID or compatible JSON profile path.                                                                   |
| `--scenario`        | enum / `normal-cycle`                       | Any of the 11 names listed below.                                                                                      |
| `--seed`            | uint32 / `1`                                | Integer `0..4294967295`; seeds generated measurement variation.                                                        |
| `--node-id`         | string / profile ID                         | Exactly 16 uppercase hexadecimal characters.                                                                           |
| `--broker-url`      | URL / `mqtt://127.0.0.1:1883`               | `mqtt://` or `mqtts://` origin; no URL credentials, path, query or fragment.                                           |
| `--outbox-path`     | path / `.bms-runtime/<node-id>.events.json` | Persistent pending-event file; relative paths resolve from current directory.                                          |
| `--outbox-capacity` | integer / `256`                             | Pending event limit, `1..10000`.                                                                                       |
| `--consumer-id`     | string / `mpm-demo`                         | Expected receipt identity: lowercase letters/digits/`_`/`-`, up to 64 characters.                                      |
| `--gap-ms`          | integer / `15000`                           | Observation-gap threshold `1000..3600000` ms; silence lasts at least threshold plus 1 second (and at least 5 seconds). |
| `--replay-event`    | event ID / unset                            | Republish the exact event already pending at the selected outbox path.                                                 |
| `--help`, `-h`      | flag                                        | Print supported options and exit.                                                                                      |
| `--list-scenarios`  | flag                                        | Print implemented scenario IDs and exit.                                                                               |

The executable also reads optional `MQTT_USERNAME` and `MQTT_PASSWORD`
environment variables. For a secured broker, enter credentials without putting
the password in command history:

```bash
export MQTT_USERNAME='your-local-broker-user'
read -r -s -p 'MQTT password: ' MQTT_PASSWORD
printf '\n'
export MQTT_PASSWORD
node --import tsx app/simulator/main.ts --broker-url mqtt://127.0.0.1:1883
unset MQTT_USERNAME MQTT_PASSWORD
```

Do not use credentials with the anonymous local broker. Retry bounds are not
CLI options: B04 uses exponential backoff from 1 to 30 seconds. Retry timer
state resets on process restart; outbox event IDs and contents persist.

## Observe MQTT messages

In MQTTX, connect to `127.0.0.1:1883` for the local broker (no TLS/login) and
subscribe to `libresolar/bms/v1/#`. Telemetry is non-retained, so subscribe
before starting the simulator. Add `homeassistant/device/+/config` only when
using a B05 build. Do not expose the anonymous local broker to an untrusted or
public network.

With `mosquitto-clients` installed, from another WSL terminal:

```bash
mosquitto_sub -h 127.0.0.1 -p 1883 -t 'libresolar/bms/v1/+/telemetry' -v
```

Other useful subscriptions:

```bash
mosquitto_sub -h 127.0.0.1 -p 1883 -t 'libresolar/bms/v1/+/summary' -v
mosquitto_sub -h 127.0.0.1 -p 1883 -t 'libresolar/bms/v1/+/attributes' -v
mosquitto_sub -h 127.0.0.1 -p 1883 -t 'libresolar/bms/v1/+/availability' -v
mosquitto_sub -h 127.0.0.1 -p 1883 -t 'libresolar/bms/v1/+/events' -v
mosquitto_sub -h 127.0.0.1 -p 1883 -t 'libresolar/bms/v1/+/receipts/mpm' -v
```

| Suffix         | QoS | Retained | Behavior                                                                 |
| -------------- | --: | -------- | ------------------------------------------------------------------------ |
| `telemetry`    |   0 | No       | Current normalized sample each second while connected.                   |
| `summary`      |   1 | Yes      | Startup/current state, every 60 seconds, and relevant BMS/fault changes. |
| `attributes`   |   1 | Yes      | Startup and each successful broker connection.                           |
| `availability` |   1 | Yes      | Online on connect; offline on clean stop or broker Last Will.            |
| `events`       |   1 | No       | Observed fault, fault transition/recovery, or observation gap.           |
| `receipts/mpm` |   1 | No       | Adapter's durable application receipt, if supported.                     |

The prefix is `libresolar/bms/v1/{node_id}/`. A process uses one session UUID
and an increasing message sequence; MQTT reconnect does not reset either.
Missed samples are not fabricated. `observed_at` remains the measurement time;
`published_at` is publication time. A QoS 1 broker PUBACK is not proof of
adapter or MPM database storage.

## Scenario guide

Run each command from the gateway root with a broker at `127.0.0.1:1883`.
Use a unique outbox path per run. Subscribe to telemetry and events using the
commands above. Elapsed scenario timing starts at first observation and has
approximately one second tick resolution. All commands run until stopped.

| Scenario                    | Launch command                                                                                                                                                          | Expected readings, faults/events, availability and recovery                                                                                                                                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normal charging/discharging | `node --import tsx app/simulator/main.ts --scenario normal-cycle --seed 17 --broker-url mqtt://127.0.0.1:1883 --outbox-path /tmp/bms-normal.json`                       | Starts near +5 A charge and changes direction every 300 s. No baseline fault event; availability remains online.                                                                                                                                                          |
| Normal charging             | `node --import tsx app/simulator/main.ts --scenario normal-charge --seed 17 --broker-url mqtt://127.0.0.1:1883 --outbox-path /tmp/bms-normal-charge.json`               | Positive current, small seeded measurement variation, explicitly observed zero fault mask.                                                                                                                                                                                |
| Normal discharging          | `node --import tsx app/simulator/main.ts --scenario normal-discharge --seed 17 --broker-url mqtt://127.0.0.1:1883 --outbox-path /tmp/bms-normal-discharge.json`         | Negative current and explicitly observed zero fault mask.                                                                                                                                                                                                                 |
| Cell overvoltage            | `node --import tsx app/simulator/main.ts --scenario cell-overvoltage --seed 17 --broker-url mqtt://127.0.0.1:1883 --outbox-path /tmp/bms-overvoltage.json`              | About 2–8 s: logical cell 4 is 3.70 V and `cell_overvoltage` is set. At about 8 s it is set to the 3.50 V reset; fault clears and telemetry/summary recover. Expect observed fault and clear event transitions. Availability stays online.                                |
| Cell undervoltage           | `node --import tsx app/simulator/main.ts --scenario cell-undervoltage --seed 17 --broker-url mqtt://127.0.0.1:1883 --outbox-path /tmp/bms-undervoltage.json`            | About 2–8 s: logical cell 1 is 2.75 V and `cell_undervoltage` is set. It resets to 3.00 V at about 8 s and returns to baseline.                                                                                                                                           |
| Over-temperature            | `node --import tsx app/simulator/main.ts --scenario over-temperature --seed 17 --broker-url mqtt://127.0.0.1:1883 --outbox-path /tmp/bms-overtemp.json`                 | First battery sensor crosses the 45 °C charge threshold. At about 5 s current changes to discharge; the scenario switches to 60 °C discharge interpretation. It resets around 8 s. Expect observed fault transition(s) and recovery; electronics sensors remain separate. |
| Increasing cell imbalance   | `node --import tsx app/simulator/main.ts --scenario increasing-cell-imbalance --seed 17 --broker-url mqtt://127.0.0.1:1883 --outbox-path /tmp/bms-imbalance.json`       | Cell 4 diverges from about 2–8 s; `cell_voltage_delta` increases and returns toward baseline by about 12 s. No fault flag/event is invented solely for imbalance.                                                                                                         |
| Missing measurement         | `node --import tsx app/simulator/main.ts --scenario missing-reading --seed 17 --broker-url mqtt://127.0.0.1:1883 --outbox-path /tmp/bms-missing.json`                   | About 2–8 s `pack_current` is JSON `null` with B02 quality `not_reported`. Other fields continue; fault mask is still explicitly zero. This scenario does not omit cell or temperature readings.                                                                          |
| Connected-but-silent        | `node --import tsx app/simulator/main.ts --scenario connected-but-silent --seed 17 --gap-ms 1000 --broker-url mqtt://127.0.0.1:1883 --outbox-path /tmp/bms-silent.json` | MQTT connection remains up. Telemetry pauses after about 3 s for at least 5 s, then resumes and emits `observation_gap` with no invented fault transitions. At default gap 15000 ms the pause is about 16 s.                                                              |
| Disconnect/reconnect        | `node --import tsx app/simulator/main.ts --scenario disconnect-reconnect --seed 17 --broker-url mqtt://127.0.0.1:1883 --outbox-path /tmp/bms-disconnect.json`           | Client stream is interrupted around 3 s. Observe reconnect and fresh telemetry. Broker may publish LWT offline; the process republishes online/attributes and keeps session identity after reconnect.                                                                     |
| Recovery                    | `node --import tsx app/simulator/main.ts --scenario recovery --seed 17 --broker-url mqtt://127.0.0.1:1883 --outbox-path /tmp/bms-recovery.json`                         | Cell 4 and `cell_overvoltage` are observed from about 2–5 s. At about 5 s it uses the 3.50 V reset and clears; expect a recovery event.                                                                                                                                   |

Faults reflect observed masks only. A missing fault mask is unknown, not
healthy. Increasing imbalance has no contract-defined fault. Scenario-specific
cell/temperature profiles reject unsupported layouts instead of inventing
channels. Observe actual messages in MQTTX on `libresolar/bms/v1/#` or use the
`mosquitto_sub` telemetry/events subscriptions above.

## Reproducibility

The seed initializes the PRNG for generated measurement variation. The profile
defines supported fields, channels and threshold inputs; the scenario defines
deterministic transitions. The generator accepts an injected clock and random
source so tests can supply the same time sequence. The executable uses the
host clock for observation timestamps. Same profile, scenario, seed and test
clock produce the same measurement value sequence. Independent process starts
intentionally have different session UUIDs and publication timestamps.

Run the deterministic test from the gateway root:

```bash
npm test -- tests/unit/simulator.test.ts
```

The test compares values independently of session IDs and publication times.

## Durable event outbox and receipt boundary

The default file is `.bms-runtime/<node-id>.events.json`; that directory is
Git-ignored. `--outbox-path` selects another file; `--outbox-capacity` bounds
pending items. The producer persists an event before first publish. Event ID
and original observed time remain stable across retry and producer restart.
Inspect a configured path with `cat <path>` and never commit the runtime file.

Retries use exponential delays from 1 to 30 seconds. A receipt clears an event
only if it validates against the contract and matches the topic, node, source,
event ID, configured consumer and derived receipt message ID with status
`stored`. Broker PUBACK, malformed/wrong-node/wrong-consumer receipt, or
unknown event does not clear it. After broker reconnection, pending events are
retried; after producer restart, the outbox is reopened. If full, the producer
prints `outbox_capacity_exceeded`, exits nonzero, and preserves existing
entries. File errors print `outbox_degraded`; events are not silently dropped.

Replay one existing pending event by copying its ID from the outbox:

```bash
node --import tsx app/simulator/main.ts \
  --scenario normal-charge --node-id 53494D0000000001 \
  --broker-url mqtt://127.0.0.1:1883 \
  --outbox-path /tmp/bms-fault.events.json \
  --replay-event '<existing-pending-event-id>'
```

Replace the placeholder with a real pending ID. Replay fails when the ID is not
present. The current A04 adapter forwards events but has no durable `stored`
receipt support or durable queue. B04 receipt tests use a faithful file-backed
test double. Exactly-once event rows in the MPM database remain unverified.

## Future physical-reader boundary

A future physical reader supplies raw firmware observations and their actual
observation time to B02 normalization using the selected profile. It then
passes normalized measurements to the reusable publisher. The v1 MQTT contract
remains unchanged for MPM and Home Assistant. Hardware code must not depend on
simulator scenarios, seeded random generators or simulation timing. Physical
transport, board wiring and firmware behavior remain separate work. No real
BMS board has been validated here.

## Troubleshooting

| Symptom                         | Check and next action                                                                                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ECONNREFUSED 127.0.0.1:1883`   | Check the broker terminal and its bind output. Start `mosquitto -c docs/examples/mosquitto.local.conf -v` from the gateway root; verify the CLI URL points to a broker reachable from WSL.                       |
| Missing Mosquitto container     | The manual path uses a local `mosquitto` executable. The automated verifier creates its own container; confirm Docker Desktop is running and inspect the verifier error.                                         |
| Docker Desktop unavailable      | Start Docker Desktop, enable WSL integration for the active distro, and confirm `docker version` shows both client and server.                                                                                   |
| Wrong broker host/port          | Use the address/port reachable from the simulator environment. `127.0.0.1` inside a container refers to that container; other containers need a confirmed shared network name. Do not guess an A06 Compose name. |
| MQTT authentication failure     | The local example is anonymous. For an authenticated broker, check `MQTT_USERNAME`/`MQTT_PASSWORD` in the simulator environment and its ACL. Do not put passwords in a URL or repository.                        |
| No subscribed messages          | Subscribe before starting; telemetry is non-retained. Use `libresolar/bms/v1/+/telemetry` or `libresolar/bms/v1/#`, and verify broker endpoint/node ID.                                                          |
| MQTTX shows no data             | Connect MQTTX to the same host and port as the simulator. Check the exact topic prefix and start the simulator after subscription.                                                                               |
| Retained summary seems stale    | Check `observed_at`, `last_source_observed_at`, and retained availability separately. Summary is last-known state, not proof of a current connection.                                                            |
| No fault receipt                | Expected with current A04. Inspect events, outbox and adapter logs. QoS 1 broker acknowledgment is not durable application receipt; do not manually delete pending events.                                       |
| `outbox_capacity_exceeded`      | Preserve the pending file and inspect event IDs. Resolve adapter receipt delivery and acknowledge events through the contract before reclaiming capacity.                                                        |
| Invalid simulator configuration | Check `--help`, `--list-scenarios`, integer ranges, uppercase 16-hex node ID and profile support. Unknown/repeated flags are rejected.                                                                           |
| Unexpected termination          | Inspect JSON errors and broker logs. Broker LWT may set retained availability offline. Restart with the same outbox path to recover events; process session ID will be new.                                      |

## Verification commands

Run from the gateway root:

```bash
npm test -- tests/unit/libresolar.test.ts
npm test -- tests/unit/simulator.test.ts
npm test -- tests/unit/publisher.test.ts
npm test -- tests/unit/scenarios.test.ts
npm test -- tests/unit/events.test.ts
npm test -- tests/unit/outbox.test.ts
npm run typecheck
npm run format:check
npm test
node --import tsx scripts/verify-simulator-mqtt.mjs
node --import tsx scripts/verify-simulator-events.mjs
```

The broker scripts need Docker and loopback access. Their evidence distinguishes
real Mosquitto, the adapter test double, and a real MPM database. See
[demo verification evidence](evidence/simulator-demo.md).
