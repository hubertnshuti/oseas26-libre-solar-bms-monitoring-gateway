# Home Assistant discovery verification

## Environment

Recorded component verification used Home Assistant Container `2026.10.1` and Eclipse Mosquitto `2.1.2`.
Image digests:

- Home Assistant: `sha256:130241f28d01fa80dfa3b44f7d89781c188d8642ecab9024f079f19f9f82baa0`.
- Mosquitto: `sha256:38c0da4f2ef84284d47b3b3eeea1cb3bdeabe81ee10caf0cd5c5ff61ee3ea408`.

The isolated helper is `node scripts/home-assistant-local.mjs start`.
Its default host ports are MQTT `1885` and Home Assistant `8124`; the combined Compose demo uses the ports in [quickstart](../quickstart.md).

## Recorded checks

- The targeted discovery/publisher/simulator/event/outbox/scenario tests passed: 55 tests across six files.
- TypeScript checking passed.
- `node --import tsx scripts/verify-simulator-mqtt.mjs` passed against the real broker.
- The event harness passed with its durable receiver test double; it did not exercise real adapter receipts.

The discovery topic is `homeassistant/device/53494D0000000001/config`, retained at QoS 1.
The demo profile produces 16 stable components: 13 numeric sensors, BMS State, Active Faults, and Problem Status.
The broker checks cover read-only platforms, late-subscriber discovery, and republication after a simulated Home Assistant online message.
A simulated birth message is broker evidence, not a Home Assistant browser test.
Numeric and binary-sensor components expire after 15 seconds without telemetry.

Actual device registry, recorder, fault, missing-reading, silence, and restart observations are documented in [simulator integration evidence](simulator-demo.md).
[Application screenshots](screenshots/README.md) show the resulting device page and measurements.
