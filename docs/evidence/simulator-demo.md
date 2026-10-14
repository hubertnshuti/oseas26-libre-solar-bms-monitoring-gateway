# B06 simulator and Home Assistant demo evidence

Verification date: **2026-10-14 CAT**. The B06 documentation branch was
created from the refreshed shared integration commit `888557c`. That commit
contains B01–B04; B05 remains a separate local commit
`9dd42ae89de8216f2e7f99333a8d98d5d6c06ddf` and is not in the B06 base.

## Environment

- OS: Ubuntu `26.04.1 LTS` in WSL.
- Node.js: `v24.21.0` (`.nvmrc`).
- npm: `11.19.0`.
- Docker: Docker Desktop `4.83.0`, Docker Engine `29.6.2`.
- Mosquitto: Eclipse Mosquitto `2.1.2`, image digest
  `sha256:38c0da4f2ef84284d47b3b3eeea1cb3bdeabe81ee10caf0cd5c5ff61ee3ea408`.
- Home Assistant: Container `2026.10.1`, image digest
  `sha256:130241f28d01fa80dfa3b44f7d89781c188d8642ecab9024f079f19f9f82baa0`.
- The gateway repository does not contain A06 Compose configuration, so no
  A06 service name or production broker settings are asserted.

The running local HA integration's non-secret broker host/port were
`host.docker.internal:1883`; the simulator host endpoint was
`mqtt://127.0.0.1:1883`, with HA UI at `http://127.0.0.1:8124`. Its saved
username/password fields were not read or copied. A separate B05 helper broker
was running on host port 1885 but was not the broker configured in this HA
instance. Do not combine those two endpoint arrangements.

## Commands and automated checks

Commands ran from `/home/evariste/work/oseas/gateway` unless noted:

```bash
node --import tsx app/simulator/main.ts --help
node --import tsx app/simulator/main.ts --list-scenarios
npm test -- tests/unit/libresolar.test.ts tests/unit/simulator.test.ts tests/unit/publisher.test.ts tests/unit/scenarios.test.ts tests/unit/events.test.ts tests/unit/outbox.test.ts
npm run typecheck
npm run format:check
npm test
node --import tsx scripts/verify-simulator-mqtt.mjs
node --import tsx scripts/verify-simulator-events.mjs
```

Results on the B06 base:

- `--help` listed the parser-supported flags; `--list-scenarios` printed all 11
  implemented names. `MQTT_USERNAME` and `MQTT_PASSWORD` are the only optional
  runtime environment values; retry bounds are fixed in code, not CLI flags.
- Targeted normalization/simulator/publisher/scenario/event/outbox suite:
  **6 files, 121 tests passed**.
- Typecheck, repository formatting check, and `git diff --check`: passed.
- First sandboxed `npm test` attempt failed in 33 A04 HTTP/runtime tests because
  loopback listeners returned `listen EPERM`. Rerun with approved loopback
  access passed: **11 files, 275 tests**.
- B03 `verify-simulator-mqtt.mjs`: passed against real Mosquitto 2.1.2. Assertions
  included contract-valid live messages, QoS/retention, LWT, broker restart with
  same process session, two-node isolation and a retained summary sent through
  the adapter to a local HTTP test sink. The HTTP sink is not an MPM database.
- B04 `verify-simulator-events.mjs`: passed against real Mosquitto 2.1.2.
  Assertions covered persisted pending events, producer/broker restart, receipt
  retry and ACL behavior, capacity degradation and replay. Durable receipt and
  duplicate-record checks used a faithful adapter test double; actual A04 does
  not publish receipts and no MPM database was used.

B05 was checked separately from a temporary source snapshot of local commit
`9dd42ae` (the shared B06 checkout remained at the B04 integration baseline):

- `npm test -- tests/unit/discovery.test.ts`: **1 file, 10 tests passed**.
- Typecheck and formatting check passed.
- B05 `verify-simulator-mqtt.mjs`: passed against real Mosquitto 2.1.2,
  including retained profile-sized read-only discovery, late subscriber
  delivery, simulated HA birth republication, B03 LWT/reconnect/node isolation,
  and the adapter-to-test-sink summary path.

## Actual Home Assistant observations

The local Home Assistant Container returned HTTP 200 at port 8124. A read-only
inspection of only the matching entity/device registries and recorder rows
found:

- Device `53494D0000000001`: **1 device, 16 entities, 16 unique IDs**.
- Entity domains: `sensor` and `binary_sensor`; control-domain count: **0**.
- Recorded normal sensor states, including SoC, current, cell voltages and
  temperatures. After the last clean simulator stop, telemetry entities became
  unavailable as configured.
- A real B05 `cell-overvoltage` run published over the same local broker used by
  HA. Recorder history showed Active Faults `cell_overvoltage`, Problem Status
  `on`, then Active Faults `No active faults` and Problem Status `off` on
  recovery. The producer's temporary outbox held both observed transitions;
  broker logs showed the events on the contract topic with QoS 1 and retain
  false.
- A real B05 `missing-reading` run caused Pack Current to enter `unknown`, not
  zero. Cell Voltage 1 continued to record numeric readings.
- A real B05 `connected-but-silent` run kept the MQTT connection up. SoC history
  transitioned from numeric to `unavailable` about 15 seconds after the last
  observation, then returned to a numeric value when telemetry resumed.
  Clean simulator stop subsequently marked the entities unavailable.
- After restarting the HA container, registry check again returned one device,
  16 entities, 16 unique IDs, the same two domains and zero controls. Recorder
  history remained present (9,644 matching sensor rows immediately after the
  restart check; subsequent normal run raised the count to 9,733).
- A subsequent normal-charge run after HA restart added numeric history rows.

The user's task update reports that the HA UI is functioning. This run did not
capture a screenshot, so the screen appearance is **user-reported**; the
registry and recorder results above were independently inspected. The HA UI
menu path for the reported device is **Settings → Devices & services → MQTT →
Devices**; open the device/entity to view **History** or **Show as graph**.

The actual HA container was restarted and identity/history persistence was
checked. The shared `oseas-mosquitto-dev` broker was not restarted because it is
an existing local service that may serve other consumers. The isolated B03/B05
broker verifiers exercised publisher reconnection after broker restart; an
HA UI/registry check across restart of the configured shared broker remains
pending.

No screenshot is committed. Member 4 should capture the device overview,
entity list, history, fault-on/off, missing-current unknown, silent-source
unavailable/recovery, and restart identity. Crop credentials, usernames,
personal location and browser profile information.

## Independent Member 4 reproduction checklist

This is the handoff checklist; it is not evidence that Member 4 has completed
it. First ensure B05 is merged into the shared baseline and use the actual A06
broker endpoint if available. Follow only the committed guides:

1. Complete prerequisites and setup in `docs/simulator.md` and
   `docs/home-assistant.md`; record the gateway commit, broker endpoint and HA
   version. Never copy another user's credentials.
2. Subscribe MQTTX to `libresolar/bms/v1/#`; in HA confirm the one battery
   device appears without YAML entity definitions and open its history.
3. Run the documented `normal-cycle` command; observe positive charge then
   negative discharge current and new HA history.
4. Run `cell-overvoltage`; observe the v1 event/telemetry flags and HA Active
   Faults/Problem Status on, then run `recovery` and observe them clear.
5. Run `connected-but-silent`; observe MQTT remains connected, telemetry pauses,
   HA values expire after 15 seconds, and readings recover on resume.
6. Record each step's exact command, visible MQTT/HA result, errors and
   screenshots with private data cropped out. Stop simulators with Ctrl+C.
7. Report findings against the table below. If a step is unclear, record its
   exact text and stop there so the public guide can be corrected and retried.

| Independent step                   | Member 4 result | Evidence/link     |
| ---------------------------------- | --------------- | ----------------- |
| Normal charge/discharge            | **Pending**     | Awaiting Member 4 |
| Fault and recovery                 | **Pending**     | Awaiting Member 4 |
| Connected-but-silent and freshness | **Pending**     | Awaiting Member 4 |

## Limits

- B05 is not merged into this B06 branch baseline. Do not open a B06 docs PR
  against a base without B05 and claim that a fresh clone has working discovery.
- No A06 Compose file/service name was present; the documented local endpoint
  is not asserted as the team-wide Compose configuration.
- Actual Home Assistant UI screenshots and Member 4's independent reproduction
  remain outstanding.
- A04 durable receipts and MPM database deduplication remain unimplemented and
  unverified. Mosquitto QoS 1 and the adapter test double are not proof of MPM
  durable event storage.
- No physical BMS board, wiring, firmware timing or battery behavior was
  tested.
