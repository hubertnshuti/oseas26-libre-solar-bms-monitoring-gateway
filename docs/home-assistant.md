# Home Assistant demo setup and verification

This guide describes the read-only MQTT device discovery delivered by B05 and
how to inspect live readings, history, faults and stale-data behavior. It
assumes the B05 discovery commit is integrated with the B04 simulator. At this
B06 branch base (`team/bms-monitoring` commit `888557c`), B05 is **not yet in
shared integration**; its local commit is `9dd42ae`. The B06 branch itself
therefore cannot publish discovery until B05 is merged. Do not treat this
conditional documentation as proof that B05 is present in a fresh checkout.

All readings displayed in this demo are **simulated test inputs**, not physical
BMS readings.

## Architecture and current deployment status

The measurement path is:

```text
Simulator → Mosquitto → Home Assistant MQTT integration → read-only entities/history
```

The simulator uses B02 normalization and the v1 MQTT publisher. Home Assistant
receives telemetry and retained discovery, then stores sensor history using its
recorder. The separate MPM path is:

```text
Simulator → Mosquitto → MQTT-to-MPM adapter → MPM API/plugin
```

The MPM adapter is not on the Home Assistant path. It forwards low-frequency
summaries and fault events; telemetry is not intended as a full-rate MPM
history table. A broker QoS 1 acknowledgement is not an MPM durable receipt.
The current adapter does not publish the B04 `stored` receipt.

There is no integrated A06 Compose file or confirmed A06 service name in the
current gateway repository. Do not guess a Compose hostname. In the running
local HA instance inspected for this guide, the MQTT integration's saved broker
endpoint is `host.docker.internal:1883`; the matching broker container is
`oseas-mosquitto-dev`, published to host loopback as `127.0.0.1:1883`. The
simulator on WSL connects to `mqtt://127.0.0.1:1883`. The HA browser is
`http://127.0.0.1:8124`. This is an observed local arrangement, not an A06
Compose service name; its saved authentication values were not read or copied.

A separate B05 isolated test helper is available in commit `9dd42ae`. It uses
its own Docker network: HA should connect to `b05-ha-mosquitto:1883`; the WSL
simulator connects to `mqtt://127.0.0.1:1885`; HA UI is mapped to
`http://127.0.0.1:8124`. After B05 is merged, run
`node scripts/home-assistant-local.mjs start` from the gateway root to start
that helper. Its anonymous broker is isolated and host-published on loopback
only; never expose it to a LAN or public network. Do not confuse this test
network with the currently inspected `oseas-mosquitto-dev` connection.

Inside HA container, `127.0.0.1` refers to HA itself, not Mosquitto. If A06 is
added, use its actual shared Docker network service name and internal broker
port from the committed Compose configuration. From WSL, use the broker host
port published to WSL, not a container-only hostname. `host.docker.internal`
can reach a host-published port in Docker Desktop where that route is configured;
it is not the service hostname on a shared container network.

## First-run onboarding

The running B05 local test used Home Assistant Container `2026.10.1` at
`http://127.0.0.1:8124`. Use the URL printed by your approved local setup if
the host port differs.

1. Open the Home Assistant URL in a browser.
2. Complete first-run onboarding and create your own local HA account. The
   project provides no default account, password or token.
3. Go to **Settings → Devices & services → Add integration**.
4. Select the official **MQTT** integration. Do not select MQTT JSON,
   MQTT Eventstream, or another similarly named integration.
5. For the observed local setup, the integration uses host
   `host.docker.internal`, port `1883`; use the login values already authorized
   for your local broker. In the separate B05 helper network, use
   `b05-ha-mosquitto:1883` instead. For A06, use its actual documented service
   hostname, port and credentials. Never paste credentials into docs or
   screenshots.
6. Complete setup and confirm MQTT appears under configured integrations.
7. From the gateway root on WSL, start the B05 simulator against the broker's
   host-published port:

   ```bash
   node --import tsx app/simulator/main.ts \
     --profile demo-lfp-4s-v1 \
     --scenario normal-cycle \
     --seed 17 \
     --node-id 53494D0000000001 \
     --broker-url mqtt://127.0.0.1:1883 \
     --outbox-path /tmp/b05-normal.events.json
   ```

8. In HA, open **Settings → Devices & services → MQTT → Devices**. The device
   name is **Libre Solar BMS 53494D0000000001**. It should appear from discovery
   without individually defining sensors in YAML. Open the device to view its
   entities.
9. Open a numeric entity, then use **Show as graph** or **History** to inspect
   recorder history. History begins when HA records observations; it does not
   backfill samples from before discovery.

If B05 is not merged or the running simulator comes from the B04 baseline,
these discovery steps cannot succeed: a B04 simulator does not publish the HA
config topic. First confirm the running executable includes B05.

## Discovered demo entities

Discovery derives available components from the active profile. For the demo
profile, B05 generates 16 entities: 13 numeric sensors, two text sensors, and
one binary sensor. Another profile may yield a different count.

| Entity                                | Platform                | Unit | Meaning/source                                                              |
| ------------------------------------- | ----------------------- | ---- | --------------------------------------------------------------------------- |
| State of Charge                       | Numeric sensor          | %    | Contract `soc`; not SoH.                                                    |
| Pack Voltage (Reported)               | Numeric sensor          | V    | Reported pack voltage value; physical terminal meaning remains unresolved.  |
| Stack Voltage (Reported)              | Numeric sensor          | V    | Reported stack voltage value; physical terminal meaning remains unresolved. |
| Pack Current                          | Numeric sensor          | A    | Positive charge, negative discharge; sign is preserved.                     |
| Cell Voltage 1–4 (channel 0–3)        | Numeric sensors         | V    | Per-cell normalized array entries in profile order.                         |
| Battery Temperature 1–2 (channel 0–1) | Numeric sensors         | °C   | Battery thermistor values, separate from electronics.                       |
| IC Temperature                        | Numeric sensor          | °C   | Internal monitoring-chip temperature.                                       |
| MOSFET Temperature                    | Numeric sensor          | °C   | Power-switch temperature.                                                   |
| Cell Voltage Imbalance                | Numeric sensor          | V    | Derived max-minus-min of configured valid cells.                            |
| BMS State                             | Text sensor             | —    | Contract state label.                                                       |
| Active Faults                         | Text sensor             | —    | Decoded fault names, including readable unknown-bit labels.                 |
| Problem Status                        | Read-only binary sensor | —    | On for observed active flags, off for explicit zero, unknown for null.      |

Numeric measurements use measurement state classes where applicable. No MCU
sensor, shunt temperature, SoH, cycle count, unsupported channel, switch,
button, number, select, command topic or battery-protection control is
published. Pack and stack voltage keep their qualified reported names; this
demo does not assume their terminal interpretation.

## Discovery and restart behavior

The topic is:

```text
homeassistant/device/{node_id}/config
```

For the demo node it is `homeassistant/device/53494D0000000001/config`. B05
publishes the device config at QoS 1 with retention. The device identifier,
component keys and `unique_id`s are stable for the configured node. Repeated
discovery updates the same device; profile changes update its component set.

The publisher subscribes to `homeassistant/status` at QoS 1 and republishes
when HA publishes `online`. It also publishes discovery after the simulator's
MQTT connection/reconnection. Thus a retained config can restore the device
when HA restarts before the simulator; birth republication handles HA starting
later. When Mosquitto restarts, the publisher reconnects with the same process
session and republishes discovery. A broker with persistence disabled can lose
retained records at restart; publisher reconnect is the recovery path. A06
persistence settings must be confirmed from its actual config.

For duplicates, compare node ID and discovery component `unique_id`s before
changing registry data. Do not delete unrelated HA devices or clear broad
retained topics. Only if intentionally removing this test node, the exact B05
retained config topic can be cleared using the project's local `mosquitto_pub`
client; first stop its producer and confirm the node ID. The B05 registry
checker, once present in your checkout, reports only matching node registry
entries and detects controls/duplicate IDs without reading credentials.

## Missing, unknown, stale and offline values

Each B05 telemetry entity has `expire_after: 15` seconds. Telemetry publishes
once per second and is not retained. If a connected producer goes silent,
availability can remain `online` while measurements expire to unavailable after
15 seconds. When observations resume, values recover on the same entities and
history continues under their stable IDs.

- A valid numeric zero is a reading, not missing data.
- A JSON `null` numeric field is unknown for that measurement; it must not be
  converted to zero. Other valid entities continue updating.
- `error_flags: 0` is explicitly observed no-fault/Problem Status off.
- `error_flags: null` or an unavailable mask is unknown, never healthy/off.
- Retained `availability: online` reports connection status only; it cannot
  refresh an old measurement.
- Clean shutdown and broker Last Will set availability `offline`; all device
  entities then become unavailable. Reconnection publishes online and fresh
  telemetry.

The B04 `missing-reading` scenario makes pack current null with quality
`not_reported`; it does not omit cells. For the cell/fault unknown UI path, B05
instructions use the shared unavailable telemetry fixture, which contains a
null configured cell and null error mask with quality reasons. The
`connected-but-silent` scenario keeps MQTT up and pauses longer than the 15 s
expiry. See the [simulator scenario guide](simulator.md) for commands and
expected MQTT output.

## UI and history test checklist

After B05 is integrated and onboarding is complete:

1. Confirm MQTT is configured, then verify the battery device appears
   automatically under **Settings → Devices & services → MQTT → Devices**.
2. Open the device. Confirm its profile-supported entities and expected units;
   check current changes sign for charge/discharge.
3. Open **History** (or the entity's **Show as graph**) and verify new samples
   are recorded after simulator start.
4. Run `cell-overvoltage` and confirm Active Faults and Problem Status change;
   run `recovery` to observe the clear transition.
5. Run `missing-reading` and confirm other valid sensors update. To test a null
   cell and fault mask, publish the documented unavailable fixture while
   availability remains online. The affected value/status should show unknown,
   not zero/healthy.
6. Run `connected-but-silent`; keep the connection alive and verify values
   expire after 15 s. On resumed telemetry, values recover without new device
   identity.
7. Stop the simulator with Ctrl+C; verify offline/unavailable. Restart it and
   check values resume.
8. Restart HA, then the broker using the actual local/A06 service workflow.
   Verify the same device/entities return and existing history remains attached.
9. Confirm there are no writable BMS controls. Do not test by sending commands.

The user reports the local simulator, Mosquitto and HA UI are functioning. A
read-only inspection of the local HA registries found one device, 16 stable
entities, `sensor` plus `binary_sensor` domains, and no control entities. The
recorder contains normal values, `cell_overvoltage`/Problem Status on then off,
a null pack-current state recorded as `unknown` while cell values remained
valid, and `unavailable` after a 15-second silent interval followed by fresh
values. HA restart preserved one device, the same 16 IDs, and recorder rows.
No screenshot was available to this run. Member 4 should capture the device
overview, entity list, history, fault, silence and recovery with usernames,
credentials, personal location and browser profile data cropped out.

## Known boundaries

- B05 implementation commit `9dd42ae` was not part of the shared baseline when
  this B06 branch was created. A fresh checkout of this B06 branch needs B05
  merged before automatic HA discovery is available.
- A06 Compose services and an actual shared Mosquitto hostname/credential set
  are not present in this gateway checkout. The local B05 network is not an
  A06 service topology.
- This guide does not claim that the A04 adapter publishes durable receipts or
  that a real MPM database stores/deduplicates fault events. B04 receipt
  integration currently uses a faithful test double.
- No physical battery, board wiring, firmware thresholds or hardware transport
  was validated.
