# Simulator and Home Assistant integration verification

Recorded on 14 October 2026 with Node `24.21.0`, npm `11.19.0`, Mosquitto `2.1.2`, and Home Assistant Container `2026.10.1`.
Simulator baseline: `888557ce7de84528210318c105d03667c0f680db`.
Discovery checks used `9dd42ae89de8216f2e7f99333a8d98d5d6c06ddf` separately from that baseline.
These are historical component results, not a new combined-Compose clean-install run.

## Commands and automated results

Commands were run from the gateway root with installed locked dependencies and Docker access:

```bash
npm run typecheck
npm run format:check
npm test
node --import tsx scripts/verify-simulator-mqtt.mjs
node --import tsx scripts/verify-simulator-events.mjs
```

Typechecking and formatting passed.
The simulator baseline suite passed 275 tests across 11 files with local socket access enabled.
The separate discovery test file passed 10 tests.
Both broker harnesses passed; the event harness used a durable receiver test double and the adapter harness used an HTTP test destination.

## Actual Home Assistant observations

Read-only inspection of the matching device/entity registries and recorder showed:

- One simulated battery device, 16 entities, 16 unique IDs, and zero control-domain entities.
- Recorded normal SoC, current, cell voltages, and temperatures.
- `cell-overvoltage` produced Active Faults `cell_overvoltage` and Problem Status `on`, followed by `No active faults` and `off` after clearance.
- `missing-reading` changed Pack Current to `unknown` while other cell readings remained numeric.
- `connected-but-silent` changed SoC to `unavailable` about 15 seconds after the last observation, then restored numeric readings after telemetry resumed.
- Clean simulator stop made telemetry entities unavailable.
- Restarting Home Assistant preserved the device, all 16 unique entity IDs, and recorded history; a subsequent normal run added further history rows.

The shared broker was not restarted during the Home Assistant registry checks.
Broker-restart behavior was exercised separately by isolated transport harnesses.

## Browser evidence and remaining checks

[Supplied application captures](screenshots/README.md) show the simulated device, its electrical/temperature readings, and normal-state activity.
The recorded fault/silence results above come from registry/recorder inspection; no matching fault-history screenshot is included.
A fresh independent installation, full browser scenario acceptance, and Home Assistant identity/history checks across shared-broker restart remain unverified.
Real MPM storage is covered separately in [delivery verification](delivery.md).
