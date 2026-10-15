# Delivery verification

Gateway branch: `feat/demo-compose`.
MPM pinned revision: `9b102f2526167d18fb2e03f4aad297351a4eeef2`, merged through team PR8.
This record is updated as checks are performed; pending entries are not success claims.

| Check                        | Result  | Evidence                                                                                                           |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| Public MPM revision          | Pass    | Git fetch confirms merged backend/frontend; public commit page HTTP200.                                            |
| Compose syntax               | Pass    | `docker compose config --quiet`.                                                                                   |
| Existing backend health      | Pass    | Existing initialized backend `/up` HTTP200.                                                                        |
| Existing user authentication | Pass    | Actual login API and signed-in battery list return HTTP200.                                                        |
| Existing battery semantics   | Pass    | Node53494D0000000001 is simulator; SoH/cycles null, source unknown, integration stale.                             |
| Combined startup             | Pending | Requires finished image builds and initialization.                                                                 |
| Normal MQTT → MPM            | Pass    | Actual adapter accepted summary; signed-in API shows updated observation time and SoC for the same simulated node. |
| Fault MQTT → MPM             | Pending | Fault scenario still to run.                                                                                       |
| HA browser discovery/history | Pending | User verification in working browser required.                                                                     |
| MPM browser display          | Pending | User verification in working browser required.                                                                     |
| Restart persistence          | Pending | Must compare saved state before/after stop/start.                                                                  |
| Separate clean installation  | Pending | Existing initialized backend is not clean-install proof.                                                           |

Earlier component evidence is retained under this directory and describes its original revisions.
Do not treat historical test substitutes as current end-to-end verification.

## Observed integration limitation

On a new simulator session against an existing battery, initial attributes receive HTTP409 because metadata arrives before the summary that promotes the new session.
The following summary is accepted and updates the battery.
Metadata delivery after restart is therefore incomplete; no metadata recovery claim is made.
No backend session guard was relaxed to hide this conflict.

## Current rehearsal evidence

Gateway typecheck and 286 tests across 12 files pass.
Scoped formatting, shell syntax and Compose configuration checks pass.
The static frontend production image built successfully from the pinned MPM source and serves HTTP200.
The injected browser API URL targets the initialized backend; this is not proof of browser login.
The running MQTT broker retains discovery for 16 entities and an explicitly simulated device name.
[Captured API evidence](delivery-api.json) contains actual simulated overvoltage measurements and stored events, not fixture responses.
The brief fault is active from approximately second2 to second8; automatic MPM polling can miss that active window, while event history remains visible.

The rehearsal uses an existing initialized backend and a private Compose override; the new broker, simulator, adapter, static frontend and HA use a distinct project.
No shared database was reset or reseeded.
The full public first-installation workflow has not been executed in fresh data; configuration validation alone is not proof of a clean install.
Browser login, HA entity rendering/history and screenshots await the presenter's manual verification.
No recorded screen evidence is fabricated or bundled.
