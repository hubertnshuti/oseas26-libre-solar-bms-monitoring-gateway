# Home Assistant battery monitoring

The simulator publishes retained MQTT discovery and frequent measurements for one read-only battery device.
All readings are simulated.
Follow the [setup guide](quickstart.md) for installation, account creation and the MQTT integration.
The Compose broker hostname is `mqtt`, its internal port is `1883`, and credentials come from private `.env` configuration.
The default Home Assistant browser address is http://localhost:18123.

## Device and measurements

Open **Settings → Devices & services → MQTT → Devices → Libre Solar BMS (simulated) 53494D0000000001**.
The demonstration profile provides 16 entities: 13 numeric sensors, two text sensors and one binary sensor.
Open a numeric entity's History view to see samples recorded since setup.

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

## Discovery and availability

The retained configuration topic is `homeassistant/device/53494D0000000001/config`.
Device and entity identifiers remain stable for that node across simulator restarts.
The simulator republishes discovery on broker reconnection and Home Assistant's `online` birth message.
Named Compose volumes preserve the broker's retained messages and Home Assistant's configuration/history.

Availability combines MQTT connection state and measurement expiry.
A connected but silent source becomes unavailable after 15 seconds without readings.
A null measurement remains unknown rather than zero; a null fault mask must not imply a healthy battery.
The missing-reading scenario makes pack current unavailable while other supported measurements continue.
No battery controls are exposed.

## Verify in the browser

From the gateway root with the prepared Compose stack running:

```bash
bash deploy/demo.sh scenario normal-cycle
```

Confirm changing measurements and recorded history for the expected node.
Then run:

```bash
bash deploy/demo.sh scenario cell-overvoltage
```

Confirm Active Faults includes `cell_overvoltage` and Problem Status is on.
Use `normal-cycle` to restore normal readings, or `recovery` to exercise the simulator's timed fault-clear scenario.
Use `missing-reading` to verify unknown pack current and `connected-but-silent` to verify expiry.
The [presentation guide](demo.md) contains the shorter normal/fault sequence.

For a persistence check, record the device identity and history, run `docker compose stop`, then `docker compose up -d --wait --wait-timeout 300`.
Confirm the same device and history remain.
Only claim this check passed after comparing the actual results.
See [current verification](evidence/delivery.md) and [earlier component evidence](evidence/home-assistant-discovery.md).

Home Assistant receives measurements directly from MQTT.
It does not depend on the MPM adapter's HTTP delivery or its unfinished status/receipt features.
Hardware transport has not been verified.
