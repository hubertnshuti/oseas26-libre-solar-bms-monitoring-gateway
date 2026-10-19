# Clean installation and live delivery verification

Verified on 19 October 2026 from a separate recursive public clone of gateway `667e7aeda47fe29938148e1f0cf14811537070ca` (included in main merge `d8fd91e`).
MPM was pinned to `0687034c646aa821498f637fae447aedc62c198d`.
The readiness helper in this change was then executed against that installation.

## Installation conditions

The checkout used a new Compose project and fresh database, backend dependency, Redis, MQTT, adapter, simulator and Home Assistant volumes.
No existing MPM database, tenant, account or private Compose override was reused.
Host ports were changed to avoid collisions; Docker's build cache was available.
The machine provided about 3.5 GiB of memory plus 1 GiB of swap.
The existing demonstration was stopped during verification to avoid running two stacks on this host.

The documented installer built the backend, gateway and frontend, installed locked dependencies, created the demonstration company and provisioned its simulated battery.
Docker disconnected after successful provisioning; after Docker was restored, the documented ordinary startup command resumed the same installation without resetting data.
A credential-free Docker configuration was used locally to work around a failing Docker Desktop credential helper when accessing public images.
These host-specific interruptions are recorded so this result is not mistaken for an uninterrupted cold-cache installation on every platform.

## Results

| Check                                   | Result                                                                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Recursive public clone and MPM revision | Passed; the recorded submodule was fetched successfully.                                                                                        |
| Fresh initialization                    | Passed; standard company, administrator, enabled plugin, battery and private adapter key created.                                               |
| Runtime startup                         | Passed; all nine services running and all configured healthchecks healthy.                                                                      |
| Demo administrator authentication       | Passed against the real HTTP endpoint.                                                                                                          |
| MQTT → adapter → MPM                    | Passed; current simulated summary, matching source metadata, fresh source assessment and recent integration check.                              |
| Unsupported measurements                | Passed; state of health and cycle count remain null with `unsupported` quality.                                                                 |
| Readiness failure detection             | Passed; stopping the simulator makes `bash deploy/demo.sh verify` fail and identify the stopped service.                                        |
| Chromium browser                        | Passed; real demo login, compact setup completion, battery list/detail navigation, rounded values, source details and unsupported-value labels. |
| Fault history                           | Passed; `cell-overvoltage` produced an added fault and a clearance in the browser and actual API.                                               |
| Full stop/start                         | Passed; all services and live checks recovered, both original fault payloads were preserved, and summary time/status revision advanced.         |
| Gateway regression checks               | Passed; TypeScript and 305 tests across 13 files.                                                                                               |

## Browser and API evidence

The [battery list](screenshots/05-mpm-verified-list.png) and [battery detail with fault history](screenshots/06-mpm-verified-detail.png) were captured from the running production frontend at a 1440-pixel viewport.
They show real simulated data delivered through MQTT and the adapter, with no fixture interception.
The detail view includes both the overvoltage transition and its clearance, recovered source metadata, and recent integration/source checks.
[Captured API responses](clean-install-api.json) record the matching battery and event data without authentication tokens.
A 768-pixel viewport was also inspected; this is not a complete accessibility or device-compatibility audit.

## Reproduce the readiness check

Follow [the installation guide](../quickstart.md), keep `normal-cycle` running, and execute:

```bash
bash deploy/demo.sh verify
```

This command checks actual authenticated battery reads as well as service state.
It waits up to 90 seconds for complete recent delivery, returns a failing exit code when the checks fail, and does not print credentials.
It does not create accounts, provision batteries, change scenarios or repair data.

## Scope

The general MPM cluster map emitted Leaflet errors during browser testing; battery navigation and reads remained available.
That inherited map behavior requires separate investigation.
Home Assistant HTTP readiness is covered here; its account setup, MQTT onboarding and recorder history are not yet independently rechecked in this fresh installation.
The earlier [Home Assistant component evidence](simulator-demo.md) retains its own revision and scope.
No physical battery, hardware transport, Prospect integration, other browser engine or production deployment is certified by these checks.
