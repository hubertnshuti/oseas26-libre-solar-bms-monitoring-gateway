# Battery monitoring in MicroPowerManager

The Libre Solar BMS plugin provides a company-scoped battery list, current-state detail, and paginated fault history.
The implementation is included through the pinned `external/micropowermanager` submodule.
See the [installation guide](quickstart.md) to run it and the [API contract](api-contract.md) for authentication and response shapes.

## Navigation and access

Sign in to MPM with an account whose company has the Libre Solar BMS plugin enabled and the `libre-solar-bms.view` permission.
Open **Libre Solar BMS** to view the battery list at `/libre-solar-bms/overview`.
Selecting a battery opens `/libre-solar-bms/batteries/{id}`, where `{id}` is the internal MPM battery ID.
The frontend uses the existing user session; integration API keys are never browser settings.
The initial plugin setup flow can also display the list and complete registration after a successful real API read.

## Measurements and interpretation

| Display                         | API source                           | Meaning                                                           |
| ------------------------------- | ------------------------------------ | ----------------------------------------------------------------- |
| Battery identity                | Battery label and `node_id`          | Provisioned asset and MQTT source                                 |
| Data source                     | `source`                             | Explicit simulation or hardware marker                            |
| State of charge                 | `summary.soc`                        | Reported percentage, not an estimate of state of health           |
| State of health / cycle count   | `summary.soh`, `summary.cycle_count` | Unsupported by the demo profile; shown as unavailable             |
| Cell imbalance                  | `summary.cell_voltage_delta`         | Difference between the highest and lowest configured cell voltage |
| Maximum battery temperature     | `summary.cell_temperature_max`       | Highest configured battery-sensor reading                         |
| Maximum electronics temperature | `summary.component_temperature_max`  | Highest supported electronics-sensor reading                      |
| BMS state and faults            | State code, flags, decoded faults    | Last observed source state and fault assessment                   |
| Observation time                | `summary.observed_at`                | When the displayed measurement was observed                       |

Missing or unsupported measurements remain unavailable with their quality reason.
A real zero keeps its value and unit.
An explicitly empty known fault list means no known active faults were reported; missing fault information does not establish a healthy battery.
Unknown fault codes and bits remain visible.
The detail API exposes an electronics maximum, not separate IC/MOSFET/shunt readings.
Home Assistant provides the individual measurements and time-series view.

## Source status and integration freshness

Source assessment describes the battery feed at the last accepted check.
Integration freshness describes how recently that check was performed.
A recent integration check can report a stale or disconnected source.
A delayed HTTP response cannot turn an old check into a fresh one.

The detail view ages the original source check against the API-provided integration threshold, currently 150 seconds.
Summary measurements normally arrive every 60 seconds; the adapter's 15-second source timeout is not a metric-row expiry rule.
List rows currently lack the original check timestamp and threshold, so list assessments are qualified as valid at the last successful fetch.
When integration is stale, retained measurements are labelled last known.

The current gateway adapter does not send source-status checks.
Consequently, an installation can receive new summaries while the screen reports unavailable source status and no recent integration update.
See [adapter limitations](mpm-ingest.md#delivery-and-limitations).

## Fault history and refresh

Event history distinguishes first observation, fault changes, clearances, and observation gaps.
Original observation time is kept separate from backend receipt time.
A first observation does not prove when a fault began; an observation gap does not prove recovery.
Pagination may shift when new events arrive because the API uses page-based browsing.

Successful reads schedule another refresh after 60 seconds.
Manual refresh is useful after a short fault scenario.
A failed request stops automatic refresh and offers the relevant retry or sign-in/permission action.
Changing batteries clears previous data and ignores late responses for the earlier selection.

## Verification

[Application screenshots](evidence/screenshots/README.md) show the list, detail, and matching Home Assistant device.
The screenshots preserve unavailable/stale labels and unsupported values.
[Captured API evidence](evidence/delivery-api.json) records actual simulator-generated overvoltage and clearance events.
Full browser accessibility, error/recovery, and independent clean-install checks remain separate acceptance work.

For component tests and explicit development-only fixture previews, see the frontend guide in the pinned MPM submodule at `docs/development/libre-solar-bms-frontend.md`.
Fixture previews are labelled and excluded from normal production behavior.
