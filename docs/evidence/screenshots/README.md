# Application screenshots

## Verified installation on 19 October 2026

- [Battery list](05-mpm-verified-list.png): simulated node, rounded state of charge, fresh source assessment and recent integration check.
- [Battery detail and fault history](06-mpm-verified-detail.png): source metadata, unsupported measurements, and stored overvoltage/clearance events.

These captures come from the [fresh installation verification](../clean-install.md) at its recorded revisions.
They show the running application without fixture interception.

## Earlier captures

These captures show the local simulated demonstration in MicroPowerManager and Home Assistant.
The images preserve the original application display, including unavailable measurements and integration-status limitations.

| Screenshot                                                        | Visible behavior                                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [MPM battery list](01-mpm-battery-list.png)                       | Simulated node, state of charge, unavailable source assessment, and no recent integration update |
| [MPM battery detail](02-mpm-battery-detail.png)                   | Last-known readings, unsupported SoH/cycles, cell imbalance, temperatures, and fault assessment  |
| [Home Assistant device](03-home-assistant-device.png)             | Matching simulated node, MQTT device, cell voltages, battery temperatures, and BMS state         |
| [Home Assistant measurements](04-home-assistant-measurements.png) | Electrical readings, electronics temperatures, and normal-state activity                         |

The displayed observations/activity are dated 16 October 2026; exact capture times and deployed commit IDs were not recorded in the images.
The captures were taken at different times and do not establish synchronized readings or complete browser acceptance.
[API evidence](../delivery-api.json) records overvoltage and clearance; no matching fault-history screenshot is included.
