# Home Assistant MQTT discovery

The gateway exposes one read-only Home Assistant device per configured BMS
`node_id`. Discovery is generated from the active `ProfileCapabilities` and is
published to `homeassistant/device/{node_id}/config` with QoS 1 and retention.
It uses the shared v1 telemetry and availability topics. It does not add
hardware controls or change the v1 contract.

The discovery payload uses Home Assistant's current MQTT device-discovery
structure: required root `device` and `origin` metadata, shared telemetry and
availability settings, and a `components` map whose entries identify their
platform (`sensor` or `binary_sensor`) and stable `unique_id`. See the [MQTT
discovery documentation](https://www.home-assistant.io/integrations/mqtt/#mqtt-discovery),
[MQTT sensor options](https://www.home-assistant.io/integrations/sensor.mqtt/),
and [MQTT binary sensor options](https://www.home-assistant.io/integrations/binary_sensor.mqtt/).

## Tested local setup

The repository has no integrated A06 Home Assistant service or shared Compose
configuration. The local helper starts an isolated network with Eclipse
Mosquitto 2.1.2 and Home Assistant Container 2026.10.1. Its unauthenticated test
broker is reachable only from the isolated Docker network and a host loopback
port; do not reuse the test broker on a LAN or public interface.

Requirements are Docker Desktop with Linux containers, Node 24 and installed
gateway dependencies. From the gateway root:

```bash
node scripts/home-assistant-local.mjs start
```

The command prints the temporary Home Assistant configuration path, support
directory and local URLs. The default URLs are Home Assistant `http://127.0.0.1:8124` and the host
MQTT endpoint `mqtt://127.0.0.1:1885`. The helper uses a Docker network alias
`b05-ha-mosquitto`; from the Home Assistant container, the broker is
`b05-ha-mosquitto:1883`. Override occupied host ports with
`B05_HOME_ASSISTANT_PORT` or `B05_MQTT_PORT`. It does not mount or alter the
existing `oseas-mosquitto-dev` container, A06 files, or a repository-tracked HA
configuration. The generated config contains no credentials.

Complete first-run onboarding in a browser:

1. Open `http://127.0.0.1:8124` and use the Home Assistant setup screen to create
   a local user and complete the initial location/preferences steps. Choose
   your own credentials; none are supplied by the project.
2. Go to **Settings → Devices & services → Add integration → MQTT**.
3. Enter broker `b05-ha-mosquitto`, port `1883`, and no username/password for
   this isolated local test network. Complete setup and confirm the MQTT
   integration appears as configured.
4. In the gateway terminal, start the normal simulator:

   ```bash
   node --import tsx app/simulator/main.ts \
     --profile demo-lfp-4s-v1 \
     --scenario normal-cycle \
     --seed 17 \
     --node-id 53494D0000000001 \
     --broker-url mqtt://127.0.0.1:1885 \
     --outbox-path /tmp/b05-normal.events.json
   ```

5. In Home Assistant, open **Settings → Devices & services → MQTT → Devices**.
   The **Libre Solar BMS 53494D0000000001** device should appear without adding
   individual sensors. Open it to view entities. From an entity's overflow menu,
   choose **Show as graph** or open **History** to inspect recorder history.

After discovery has completed, inspect only the matching entity/device registry
records (no authentication data is read) with the `config_directory` printed by
the start helper:

```bash
node scripts/check-home-assistant-registry.mjs \
  /tmp/libre-solar-b05-ha-XXXXXX/home-assistant \
  53494D0000000001
```

Record the JSON output, restart Home Assistant and Mosquitto, then run the same
command again. The device count, entity count, domains and unique ID list should
match; the script fails if it finds duplicate unique IDs, more than one device,
or any button/number/select/switch entity.

When finished, stop the local containers while preserving the onboarding and
entity registry data:

```bash
node scripts/home-assistant-local.mjs stop
```

The configuration and test-support directories printed by `start` remain on
disk. Reuse the HA configuration by setting `B05_HOME_ASSISTANT_CONFIG` on a
later `start`. Remove those private local directories yourself after deciding
their contents are no longer needed.

## Discovered entities

Entities are included only when their normalized field is supported. Cell and
battery thermistor counts and channel labels come from the active profile.
Array template indices follow the normalized telemetry array order, which B02
maps using the configured logical-to-hardware channel mapping.

| Entity name                       | Platform / class                  | Unit | Source                                                                |
| --------------------------------- | --------------------------------- | ---- | --------------------------------------------------------------------- |
| State of Charge                   | Numeric sensor / battery          | `%`  | `soc`                                                                 |
| Pack Voltage (Reported)           | Numeric sensor / voltage          | `V`  | `pack_voltage_reported`                                               |
| Stack Voltage (Reported)          | Numeric sensor / voltage          | `V`  | `stack_voltage_reported`                                              |
| Pack Current                      | Numeric sensor / current          | `A`  | `pack_current`; preserves positive-charge and negative-discharge sign |
| Cell Voltage N (channel X)        | Numeric sensor / voltage          | `V`  | `cell_voltages[N-1]`                                                  |
| Battery Temperature N (channel X) | Numeric sensor / temperature      | `°C` | `cell_temperatures[N-1]`                                              |
| IC Temperature                    | Numeric sensor / temperature      | `°C` | `ic_temperature`                                                      |
| MOSFET Temperature                | Numeric sensor / temperature      | `°C` | `mosfet_temperature`                                                  |
| Cell Voltage Imbalance            | Numeric sensor / voltage          | `V`  | `cell_voltage_delta`                                                  |
| BMS State                         | Text sensor                       | —    | `bms_state`                                                           |
| Active Faults                     | Text sensor                       | —    | decoded `faults`, including `unknown_bit_N` labels                    |
| Problem Status                    | Read-only binary sensor / problem | —    | `error_flags`                                                         |

Numeric measurement sensors use `state_class: measurement`. The demo profile
creates 16 entities: 13 numeric sensors, BMS State, Active Faults and Problem
Status. It does not create SoH, cycle count, shunt temperature, MCU temperature,
or unsupported channels. Pack and stack voltage retain their contract's
reported labels because their terminal interpretation is unresolved.

The problem binary sensor is `on` for any known nonzero fault mask, `off` only
for the explicitly observed zero mask, and `unknown` for a null/unavailable
mask. The Active Faults sensor shows the normalized fault labels; a null list
appears as unknown, and an empty list appears as “No active faults”.

## Freshness, availability and missing fields

Each telemetry entity uses Home Assistant `expire_after: 15` seconds. The v1
contract publishes telemetry once per second and defines the source as stale
after 15 seconds without fresh telemetry. Telemetry is QoS 0 and not retained;
the retained availability topic is used only for `online`/`offline`, so it does
not make an old measurement appear fresh. Home Assistant's recorder restores
sensor state and the remaining expiry interval across reloads.

The shared entity availability follows
`libresolar/bms/v1/{node_id}/availability`: clean shutdown or broker LWT
`offline` marks all device entities unavailable; reconnect publishes `online`.
Each numeric value template reads the contract value directly. Home Assistant
maps JSON null to its unknown state rather than converting it to zero. Other
valid sensors continue updating. A null fault mask maps the Problem Status
binary sensor to unknown, not off. A connected-but-silent simulator leaves
availability online, but each sensor expires after 15 seconds.

To demonstrate the missing cell and fault-unknown paths while the isolated test
broker is running, stop the simulator cleanly, then publish the contract's
unavailable telemetry example:

```bash
mosquitto_pub -h 127.0.0.1 -p 1885 \
  -t 'libresolar/bms/v1/53494D0000000001/availability' -r -m online
mosquitto_pub -h 127.0.0.1 -p 1885 \
  -t 'libresolar/bms/v1/53494D0000000001/telemetry' \
  -f tests/fixtures/v1/valid/unavailable.telemetry.json
```

The example has `cell_voltages[2]: null` with `source_error` quality and
`error_flags: null` with `not_reported` quality. Cell Voltage 3 and Problem
Status should show unknown; other numeric values should remain visible until
their 15-second expiry. Start the simulator again to restore live readings and
online availability.

To verify silence stale-data behavior use the B04 `connected-but-silent`
scenario. Its pause exceeds 15 seconds with the default gap setting:

```bash
node --import tsx app/simulator/main.ts \
  --profile demo-lfp-4s-v1 \
  --scenario connected-but-silent \
  --seed 17 \
  --node-id 53494D0000000001 \
  --broker-url mqtt://127.0.0.1:1885 \
  --outbox-path /tmp/b05-silent.events.json
```

During the pause, availability remains online while telemetry entities become
unavailable at 15 seconds. On resumed telemetry the same entities recover and
history remains attached to their stable unique IDs. To test an actual MQTT
disconnect, stop the simulator process and verify the retained offline status;
the B03 broker test also verifies broker-published LWT after an unexpected
producer termination.

## Discovery recovery and cleanup

The publisher subscribes to `homeassistant/status` at QoS 1 on every MQTT
connection. It publishes discovery at startup/reconnect and again when the
payload is `online`. The discovery document itself is retained so Home Assistant
can restore entities when it starts before the producer; birth-triggered
republishing covers Home Assistant starting later. Each message replaces the
same node discovery topic and reuses the same component IDs and entity
`unique_id`s. The current Home Assistant implementation removes omitted
components when a device payload is updated, so a smaller active profile does
not leave old cell/sensor components registered.

For normal Home Assistant or broker restarts, no manual discovery cleanup is
needed. The retained config plus birth republish restore the same device and
entity identities. To deliberately remove the entire device and clear its
retained discovery config from the local test broker:

```bash
mosquitto_pub -h 127.0.0.1 -p 1885 \
  -t 'homeassistant/device/53494D0000000001/config' -r -n
```

This removes the discovered device/components from Home Assistant. Do not clear
the topic as a troubleshooting step for duplicates before checking that the
node ID and component `unique_id`s are stable.

No discovery component contains `command_topic`, and only `sensor` and
`binary_sensor` platforms are generated. No switches, buttons, numbers,
selects, or BMS configuration commands are published.

## Limitations

- Values are simulated test data and do not establish physical pack behavior,
  firmware protection timing, or verified board wiring.
- A06 broker/Home Assistant shared services were not present in this checkout;
  the local helper is a separate, disposable development arrangement.
- Initial Home Assistant user creation and MQTT integration setup are
  interactive and are never automated or committed.
- Home Assistant UI/history verification must be recorded against the actual
  running instance; MQTT JSON receipt alone is not UI evidence.
