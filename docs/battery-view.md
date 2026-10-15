# Battery operator view proposal

Status: draft for Hubert's operator review and Diana's API review.
No stakeholder approval or browser verification is claimed.
This proposal describes a simulator monitoring page, with no battery controls or timeseries charts.

## Source baseline

The Gateway baseline is `66a4fbcf1bdda6dd008de45f8f95455408678f45`.
The inspected and fetched MPM integration revision is `677e189f` in [the team fork](https://github.com/hubertnshuti/micropowermanager/tree/677e189f).
Its history includes the generated plugin skeleton (`e6359759`), summary ingestion (`80ee35de`), events/status (`2b60cfb0`), provisioning (`d71b6432`) and backend handover (`d32319e0`).
These changes are merged into `origin/team/bms-monitoring`; no companion backend merge is needed for this proposal.
No existing battery view proposal or Role D branch was found in either fetched origin on 15 October 2026.

Read the [API contract](api-contract.md), [MPM backend handover](https://github.com/hubertnshuti/micropowermanager/blob/677e189f/docs/development/libre-solar-bms-handover.md), and [backend response examples](https://github.com/hubertnshuti/micropowermanager/tree/677e189f/docs/development/libre-solar-bms-examples) together.
The implementation, rather than older statements that the plugin does not exist, establishes current API support.
The schemas and response semantics still require owner review.

## Placement and existing components

Use the generated `src/frontend/src/plugins/libre-solar-bms/` folder.
Keep the existing `/libre-solar-bms/overview` route as the list entry point.
A detail route using the internal battery ID is proposed, subject to placement approval.
Do not generate another plugin or assign batteries to existing customer/device records without an agreed ownership model.

Source inspection covered the Daly BMS overview, credential service/repository, `shared/Widget.vue`, `shared/Paginate.vue`, `Helpers/Paginator.js`, `repositories/Client/AxiosClient.js`, and the generated LibreSolarBms overview.
Reuse the Widget toolbar/card, Vue Material table, buttons, empty state and existing layout classes.
A component calls a plugin service, which calls a repository using the shared Axios client.
That client attaches the signed-in user's token and handles session refresh.
Errors must reach the component as failures, rather than being mistaken for successful data.
The existing Paginator expects Laravel fields at the top level; adapt the BMS nested pagination response in the service before using it.

The [official frontend guide](https://micropowermanager.io/development/frontend.html) prescribes the existing page/module organization and translations.
It links the [MPM brand guide](https://drive.google.com/file/d/1ZBszNtIvf_iNjUou7S3A_9swcIHBr37-/view).
The PDF was inaccessible during this inspection, so typography/spacing approval remains pending.
Use the selected revision's `assets/sass/brand.scss` and existing theme classes, including `$brand-primary` (`#1b75ba`), `$brand-primary-light` (`#28aae1`), `$brand-secondary` (`#fab15b`) and `$brand-accent` (`#81a872`).
Do not introduce a separate palette or replace global typography.
Every status includes readable text; color alone carries no meaning.
Add English translation keys with matching locale keys and explicitly tracked English placeholders for translations awaiting review.

## List sketch

This is a text sketch, not a screenshot of a running screen.

```text
Libre Solar batteries                                      [Refresh]
Simulator data is labeled on each battery.

Name / node ID          Source          SoC      Source assessment
Demo battery            Simulated data  74.2 %   Fresh at last fetch
53494D0000000001                                 Integration: Recent at last fetch
                                                Summary observed: UTC time + age
[Open battery]

Page 1 of 1                  25 per page          [Previous] [Next]
```

Use label when present and node ID as the name fallback; always expose node ID.
Keep SoH/cycles on detail to avoid repeating two unavailable columns on every row.
Faults, imbalance and temperature are detail fields because the list API does not return them.
Do not issue an unbounded detail request per list row to manufacture missing columns.
List freshness is explicitly the assessment at the last successful fetch, not a continuously valid claim.
Display the fetch time and a refresh control; on refresh failure mark the list outdated.
The list API cannot independently age integration freshness because it omits the original check timestamp and threshold.
Approval to extend that response, or acceptance of the qualified list presentation, is required before implementation.

## Detail sketch

```text
[Back to batteries]    Demo battery    [Simulated data]      [Refresh]
Node: 53494D0000000001

Integration: Recent check          Source: Fresh at latest check
Checked: UTC time + age            Source last observed: UTC time + age
Summary observed: UTC time + age   Summary received: UTC time

Battery state
SoC: 74.2 %                 SoH: Not available (unsupported)
Cycles: Not available       Cell imbalance: 0.006 V
Maximum battery temperature: 28.1 °C
BMS state: NORMAL

Electronics
Maximum electronics temperature: 35.6 °C
IC / MOSFET / shunt temperatures: Not available through this API

Faults at summary observation
No known active faults reported

Fault history
Observed (UTC) | Kind          | Added                 | Cleared | Received (UTC)
time + age    | Fault changed | Cell overvoltage, ... | —       | time
Page 1 of N                                      [Previous] [Next]

Source details: profile, firmware reference, sensor/channel layout, quality
```

Display numeric zero with its unit, including `0 %`, `0 V` and `0 °C`.
Use `Not available` for null/missing/unsupported values, with the supplied quality reason when available.
Do not estimate SoH, cycles, power, a health score or missing temperatures.
Individual electronics rows are an explicit API limitation, not guessed values from the combined maximum.
At narrow widths stack cards and preserve accessible labels; keep history horizontally scrollable if necessary.

## Field-to-API mapping

All paths below are relative to the response `data` object unless a collection row is stated.
Read endpoints require the existing user JWT, enabled plugin ID 33 and `libre-solar-bms.view` permission.
Company integration keys never belong in browser configuration.

| Display                                 | Exact source                                                                                                                                        | Rule                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Name and node                           | `label`, `node_id`                                                                                                                                  | Fallback name to node ID; navigation uses `id`, not node string.                       |
| Simulated data badge                    | `source === "simulator"`                                                                                                                            | Persistent text on list and detail; unknown source must not imply hardware.            |
| List SoC                                | row `soc`                                                                                                                                           | `%`; preserve zero.                                                                    |
| List summary observation                | row `observed_at`                                                                                                                                   | Original UTC time plus age; null means unavailable.                                    |
| List status                             | row `source_status`, `integration_status`                                                                                                           | Assessment at last successful fetch only; no local expiry is possible from this shape. |
| Detail SoC                              | `summary.soc`                                                                                                                                       | `%`; consult `summary.quality.soc`.                                                    |
| SoH and cycles                          | `summary.soh`, `summary.cycle_count`                                                                                                                | Not available for pinned firmware; no derived substitute.                              |
| Cell imbalance                          | `summary.cell_voltage_delta`                                                                                                                        | `V`; already calculated upstream, no browser physics.                                  |
| Maximum battery temperature             | `summary.cell_temperature_max`                                                                                                                      | `°C`; unavailable if configured battery sensor coverage is incomplete.                 |
| Maximum electronics temperature         | `summary.component_temperature_max`                                                                                                                 | `°C`; separate from battery temperature.                                               |
| Individual IC/MOSFET/shunt temperatures | No read API field                                                                                                                                   | Explicitly unavailable; do not extract or invent telemetry values.                     |
| BMS state                               | `summary.bms_state`, `summary.bms_state_code`                                                                                                       | Preserve unknown state/code without calling it normal.                                 |
| Active fault codes                      | `summary.faults`, `summary.error_flags`                                                                                                             | Translate known codes; preserve unknown codes/bits with a warning.                     |
| Measurement time                        | `metric_observed_at` / `summary.observed_at`                                                                                                        | Original summary observation plus age; not browser fetch time.                         |
| Latest source observation               | `status.last_source_observed_at`                                                                                                                    | Source-check context; do not replace with newer receipt time.                          |
| Summary source observation              | `summary.last_source_observed_at`                                                                                                                   | Label separately if shown; not a substitute for the latest source check.               |
| Source assessment                       | `status.source_status`                                                                                                                              | Fresh/stale/disconnected/unknown only while the integration check is recent.           |
| Integration age                         | `status.status_checked_at`, `integration_stale_after_seconds`                                                                                       | Expire locally when age reaches threshold; null check means no recent update.          |
| Backend integration assessment          | `integration_status`                                                                                                                                | Respect stale response and independently age its original check on detail.             |
| Delivery times                          | `status_received_at`, `summary_received_at`                                                                                                         | Label received times separately; neither proves recent source observation.             |
| Profile and provenance                  | `attributes.profile_id`, `firmware_reference`, `source`                                                                                             | Firmware reference is under `attributes`; simulation is not hardware validation.       |
| Sensor layout                           | `attributes.cell_count`, `cell_channels`, `temperature_sensor_count`, `temperature_sensor_channels`                                                 | Keys are under `attributes`; unavailable metadata stays unavailable.                   |
| Quality explanation                     | `summary.quality[field]`, `attributes.supported_fields`                                                                                             | Preserve supplied unsupported/unavailable reason; absence does not establish quality.  |
| History                                 | event row `event.kind`, `observed_at`, `added_faults`, `cleared_faults`, `faults`, `previous_error_flags`, `current_error_flags`; row `received_at` | Event keys are under `event`; retain original observations and gap meaning.            |
| Collection navigation                   | response `pagination.page`, `per_page`, `total`, `last_page`                                                                                        | Both list and history; positive integers, per-page maximum 100.                        |

The detail service returns `summary_received_at`, but the copied detail fixture omits it.
Treat a missing fixture value as unavailable; ask Diana to reconcile the example rather than adding a browser-only field.
Reported voltage/current and per-cell arrays are not returned by these signed-in read routes and are outside this layout.

## Freshness and faults

The defaults are one-second source telemetry, a 15-second source timeout assessed by the adapter, a 60-second summary interval, and a 150-second integration timeout.
A 42-second-old summary with a recent fresh source check is not a disconnected battery.
On detail, recompute check age without a database write and display `No recent integration update` at age >= 150 seconds, even if the last stored source status says fresh.
Keep that older source assessment visible only as historical text with its check time, not as a current online claim.
Missing, malformed or implausibly future timestamps produce unavailable timing rather than negative ages or a fresh assertion.
Show the full UTC timestamp with relative age so reviewers can compare API observations; browser clock skew remains a limitation to review.

Known-empty faults plus zero flags allow `No known active faults reported`, qualified by summary observation time.
Null/missing faults or flags show `Fault status unavailable`.
Nonzero flags with no readable codes are not healthy.
Unknown fault bits/codes show `Unrecognized fault information` alongside any known faults; never discard them.
Retained last-known values stay visible with observation times and stale wording when source or integration fails.
A failed request must not make earlier successful readings look newly fetched.

History distinguishes `fault_observed`, `fault_changed` and `observation_gap`.
A first observation is not proof of when a fault began.
Show added/cleared fault names, event observation time and receipt time, plus gap text where continuity is unknown.
Do not turn an empty transition list in an observation gap into a recovery claim.
The backend deduplicates stable event identities; render stable row keys and do not append duplicate pages on retries.
Page contents may move during inserts; browsing is not a snapshot cursor.

## States and acceptance examples

These are proposed text outcomes, not screenshots or completed tests.
Use the MPM review examples at fixture clock `2026-10-08T14:00:00Z`; `.proposed` examples still require owner approval.

| Case              | Input/scenario                                                | Required visible result                                                                              |
| ----------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Normal            | `battery-detail.json`, `battery-list.json`, `event-list.json` | Simulated data, 74.2 %, 0.006 V, 28.1 °C, separate 35.6 °C electronics maximum, original timestamps. |
| Zero              | Contract zero values rendered through agreed summary shape    | `0` with unit, never Not available; dedicated read-response fixture still needed.                    |
| Unsupported/null  | `battery-detail-unknown.proposed.json` and absent summary     | Not available with quality reason; Fault status unavailable; no healthy badge.                       |
| Named fault       | `battery-detail-fault.proposed.json`                          | Readable cell overvoltage and discharge overtemperature; time-qualified active faults and history.   |
| Unknown fault     | Contract unknown-bit fixture adapted by backend owner         | Unrecognized fault information; no healthy claim; read-response fixture needed.                      |
| Loading           | Delayed list/detail/history response                          | Loading batteries/details/history text and progress; repeated controls disabled.                     |
| Empty list        | Successful `data: []`, total 0                                | No batteries available; ask an administrator to provision access, not a browser provisioning action. |
| Empty history     | Successful event `data: []`                                   | No recorded fault events; do not claim battery never faulted.                                        |
| Source silent     | Recent check with `source_status: stale`                      | Source readings are stale; last source observation and last-known summary retained.                  |
| Disconnected      | `battery-detail-disconnected.proposed.json`                   | Source disconnected, last-known values and their times remain visible.                               |
| Integration stale | Advance fixture clock to +150 seconds                         | No recent integration update; last source assessment becomes historical.                             |
| Request failure   | Offline, timeout, proxy HTML or 5xx                           | Could not load batteries/details/history; explicit safe Retry, no fabricated empty success.          |
| Refresh failure   | Failed refresh after prior success                            | Last successful data labeled outdated with fetch/observation times and error text.                   |
| Forbidden         | 403 `forbidden`                                               | You do not have permission to view batteries; no retry loop.                                         |
| Plugin disabled   | `plugin-disabled.json` / 403                                  | Libre Solar BMS is not enabled for this company; administrator action.                               |
| Session expired   | 401 after shared client refresh fails                         | Existing session/login flow; clear battery state on logout.                                          |
| Missing battery   | Detail 404                                                    | Battery not found or unavailable; return to list without leaking other tenants.                      |
| Navigation race   | Slow battery A request completes after selecting B            | A cannot overwrite B, including loading/error/history state.                                         |

Retry repeats only the failed read, never ingestion or provisioning.
Clear the old detail/history immediately when switching IDs.
Proposed refresh interval is 60 seconds after completion of the preceding request, pending owner agreement.
Prevent overlapping requests and clear timers/invalidate pending responses on route change, logout and destruction.
Keep history pagination stable during automatic detail refresh rather than resetting the operator's page.
Fixture mode must be an explicit development/test provider with a visible fixture label and no normal production activation path.
No new test dependencies or global registration changes are required by this proposal.

## Verification and next review

Source/API mapping was checked against MPM's BatteryController, BatteryService, PluginAccess middleware, provisioning command documentation, and saved JSON examples at the revision above.
An independent source review confirmed list-field limitations, pagination shape and separate check/measurement semantics.
Backend health at `http://127.0.0.1:18000/up` returned HTTP 200 on 15 October 2026.
A CORS preflight for `http://localhost:8001` to `/api/auth/login` returned HTTP 204 and allowed POST with content-type/authorization headers.
The disposable demo login returned HTTP 200 with a user token, and an authenticated battery list read returned HTTP 200 with one row and pagination.
No token was printed or saved.
These are API checks, not browser login or end-to-end screen evidence.
Docker CLI was unavailable in Lucide's agent session, including outside the restricted runner.
The `/usr/bin/docker` symlink points to an absent Docker Desktop CLI mount, and `/var/run/docker.sock` is absent.
Docker availability reported from another terminal has not yet been reproduced in this session.
No frontend container was started, no migrations/seeds ran, and no shared services or volumes were stopped or changed.

Browser inspection remains blocked; this proposal must stay draft.
Once Docker access is restored, inspect container identities, effective mounts/environment and port 8001 before starting only Lucide's isolated frontend against the existing backend.
Use MPM's supported `MPM_BACKEND_URL=http://127.0.0.1:18000` and its pinned Node 20.18 container, not Gateway's Node 24 runtime.
Verify CORS from `http://localhost:8001`, sign in with the documented disposable demo account, inspect a related plugin page, and capture real evidence before marking visual review complete.
If port 8001 belongs to Diana's old frontend, confirm its identity before the authorized frontend-only handover; otherwise report the owner conflict.
Do not start another backend/database or use private wrappers as the final full-stack quickstart.

Manual browser check: open `http://localhost:8001`, sign in, confirm successful login and authenticated network requests to port 18000, open a related plugin and then `/libre-solar-bms/overview`.
The latter should still be a generated placeholder at this baseline, not a completed battery screen.
Do not publish tokens or use company integration keys in browser tools.
Later UI cards must capture normal/fault/unknown/stale/error states with exact revisions and scenario steps.
Fresh installation reproduction belongs to the later independent setup card, with isolated fresh data after frontend merge.

## Checks for this proposal

Run from the Gateway root with Node 24.21.0 selected by `.nvmrc` and dependencies installed with `npm ci`.
No application code or dependency lockfile changed for this proposal.

```sh
npm run typecheck
npm run format:check
npm test
git diff --check
```

Observed on 15 October 2026: type checking and formatting passed; tests passed with 285 tests in 12 files; the whitespace check passed.
The initial restricted test run passed 252 tests and failed 33 with loopback `listen EPERM`; rerunning with loopback permission passed all 285 without code changes.
An initial restricted dependency install failed with DNS `EAI_AGAIN`; the authorized network retry completed using the lockfile.
A separate JSON parse check passed for all seven referenced MPM review examples, and the mapping check confirmed list field names and the three schema event-kind names.
These checks validate the documentation against the current source and preserve the Gateway baseline; they do not verify a battery UI.
For a documentation-only change no frontend build is applicable.

## Decisions awaiting review

| Owner                      | Decision or missing evidence                                                                     | Blocks                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Hubert and Diana           | Approve the dedicated plugin page, field list, wording and fixture semantics.                    | D02 implementation approval.                                                                |
| Hubert and Diana           | Accept qualified list freshness, or add check timestamp/threshold to the list API.               | Accurate continuously aging list status.                                                    |
| Diana                      | Supply zero/unknown-bit/empty read fixtures and reconcile missing summary receipt timestamp.     | Complete fixture acceptance coverage.                                                       |
| Hubert and Diana           | Keep individual electronics rows explicitly unavailable, or agree a supported summary extension. | Per-sensor display beyond current API.                                                      |
| Hubert                     | Confirm refresh interval and operator placement; provide accessible brand guide.                 | Final visual and refresh decisions.                                                         |
| Environment owner / Lucide | Restore Docker CLI access and identify frontend port owner.                                      | Running UI inspection, browser login and screenshots.                                       |
| Gateway integration owner  | Implement source-status delivery and durable retry/receipts.                                     | Real source/integration failure scenarios; backend fixture success does not close this gap. |

This draft is ready for review of concrete choices; approval remains pending.
