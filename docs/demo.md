# Demonstration walkthrough

This walkthrough uses a simulated four-cell Libre Solar battery.
Complete [installation](quickstart.md) and Home Assistant MQTT onboarding first.

## Start and inspect normal operation

From the gateway root:

```bash
docker compose up -d --wait --wait-timeout 300
bash deploy/demo.sh scenario normal-cycle
bash deploy/demo.sh verify
docker compose ps
docker compose logs --tail=20 adapter
```

Expected: runtime services are running and the adapter reports accepted or duplicate messages for node `53494D0000000001`.
Routine summaries arrive every 60 seconds; allow time for the first summary and browser refresh.

1. Open Home Assistant at `http://localhost:18123` and navigate to **Settings → Devices & services → MQTT → Devices → Libre Solar BMS (simulated) 53494D0000000001**.
2. Inspect changing electrical and temperature readings; open a numeric entity to see recorded history.
3. Open MPM at `http://localhost:18081`, select **Libre Solar BMS**, then open the provisioned demonstration battery.
4. Compare the node identity and summary observation time. State of health and cycle count should be unavailable, not zero.

With the adapter healthy and new telemetry arriving, source status becomes fresh and integration becomes recent.
After 15 seconds without new telemetry, source status becomes stale; after 150 seconds without a trustworthy adapter check, integration becomes stale.
The display preserves this distinction; see [battery-view semantics](battery-view.md).

## Observe a fault and clearance

Have the Home Assistant Active Faults and Problem Status entities visible, then run:

```bash
bash deploy/demo.sh scenario cell-overvoltage
```

The fault is raised around second 2 and cleared around second 8 after the simulator starts.
Refresh MPM event history after the transition; its 60-second automatic refresh can miss the brief active summary.
The stored events retain the original observation times.
A first fault observation in a new session does not establish when the fault originally began.

Return to normal operation:

```bash
bash deploy/demo.sh scenario normal-cycle
```

Changing scenarios recreates only the simulator and preserves its event outbox.
See [all simulator scenarios](simulator.md#scenario-guide) for missing readings, source silence, disconnect/reconnect, and other faults.

## Evidence and shutdown

[Application screenshots](evidence/screenshots/README.md) illustrate the MPM and Home Assistant views.
[Captured API evidence](evidence/delivery-api.json) includes actual overvoltage and clearance records from the simulator path.
The [verification record](evidence/delivery.md) lists tested behavior and remaining acceptance work.

Stop the demonstration while preserving its data:

```bash
docker compose stop
```

The next ordinary startup reuses the saved database, Home Assistant data, retained MQTT messages, simulator outbox and adapter SQLite queue.
Pending HTTP writes resume with their original identities and timestamps.
Keep the adapter volume: it owns events already acknowledged to the simulator and persists source-status revisions.
Physical hardware transport and Prospect integration are outside the demonstrated path.
