# B05 Home Assistant discovery evidence

## Environment

- Home Assistant Container: `2026.10.1`, image digest
  `sha256:130241f28d01fa80dfa3b44f7d89781c188d8642ecab9024f079f19f9f82baa0`.
- Eclipse Mosquitto: `2.1.2`, image digest
  `sha256:38c0da4f2ef84284d47b3b3eeea1cb3bdeabe81ee10caf0cd5c5ff61ee3ea408`.
- Docker Desktop `4.83.0`, Engine `29.6.2`.
- The B05 helper uses an isolated Docker network. Mosquitto is mapped only to
  host loopback port `1885`; Home Assistant is mapped only to host loopback
  port `8124`. HA reaches the broker at `b05-ha-mosquitto:1883`.
- A06 shared services are not present in this checkout.

Start with `node scripts/home-assistant-local.mjs start`. The actual startup
reported the image digests above, URLs `http://127.0.0.1:8124` and
`mqtt://127.0.0.1:1885`, and a temporary config directory under `/tmp`.
Home Assistant returned HTTP 302 on port 8124 and started successfully.
Initial account creation and MQTT integration setup are interactive; no
credentials are stored in this repository.

## Automated verification

- `npm test -- tests/unit/discovery.test.ts tests/unit/publisher.test.ts tests/unit/simulator.test.ts tests/unit/events.test.ts tests/unit/outbox.test.ts tests/unit/scenarios.test.ts` — **6 files, 55 tests passed**.
- `npm run typecheck` — passed.
- `node --import tsx scripts/verify-simulator-mqtt.mjs` — passed against a real
  Eclipse Mosquitto 2.1.2 broker. This includes retained device discovery,
  the 16-component demo profile, only read-only platforms, late-subscriber
  retained delivery at QoS 1, and republication after a simulated HA `online`
  birth message. Existing B03 LWT, reconnect, node isolation and adapter
  summary checks also passed. The simulated birth test is broker-level; it is
  not counted as a Home Assistant UI test.
- `node --import tsx scripts/verify-simulator-events.mjs` — B04 regression
  passed using its faithful durable adapter/receipt test double. It does not
  verify the real A04 adapter.

The discovery topic is
`homeassistant/device/53494D0000000001/config`. It is retained at QoS 1. Its
demo payload has root `device`/`origin` metadata and 16 stable components: 13
numeric sensors, BMS State, Active Faults and Problem Status. Numeric and
binary-sensor components expire after 15 seconds without telemetry. No
command topic or writable platform is generated. See the broker verifier for
runtime assertions and `docs/home-assistant.md` for the reproducible payload
inspection and simulator command.

## Home Assistant UI verification status

**Pending user onboarding and UI observation.** The user is completing local
first-run onboarding at `http://127.0.0.1:8124`, adding MQTT with host
`b05-ha-mosquitto`, port `1883`, no credentials, and running the normal
simulator against `mqtt://127.0.0.1:1885`. Until they report the visible
device/entities/history, this evidence does not claim entities appeared in the
UI. An early registry check, before confirmation that the simulator had been
started, found zero matching devices and entities; this is not counted as a
failed discovery run. Re-run the registry checker after the user has completed
the setup and simulator steps to record device count, entity count, domains,
stable IDs and absence of controls.

Missing-field, 15-second source-silence, clean offline, HA restart and broker
restart UI observations also remain pending actual execution in that onboarded
instance. MQTT-level retention and simulated-birth behavior are covered above;
they are not substitutes for those UI checks.
