# Delivery verification

Reviewed gateway revision: `fe08f88fbd0d1f91377eb8f200f1d18cb40f200a`.
MPM runtime used for the recorded delivery: `9b102f2526167d18fb2e03f4aad297351a4eeef2`.
The table below is historical evidence for the listed revisions.
Results below combine the 15 October integration recording, 16 October gateway checks, and supplied application screenshots.
They are not a fresh acceptance run of every component.

| Check                             | Result                 | Evidence                                                                                                               |
| --------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Gateway TypeScript and formatting | Pass                   | Recorded checks at `fe08f88` on 16 October.                                                                            |
| Gateway tests                     | Pass                   | 286 tests across 12 files; local socket access enabled.                                                                |
| Compose syntax and shell syntax   | Pass                   | Recorded configuration and script checks.                                                                              |
| Static frontend build             | Pass                   | Production image built from the pinned MPM source and served HTTP 200.                                                 |
| Backend authentication and reads  | Pass                   | Actual login and signed-in battery list/detail returned HTTP 200.                                                      |
| Normal MQTT → MPM                 | Pass                   | Accepted summary updated the simulated node's observation time and SoC.                                                |
| Fault MQTT → MPM                  | Pass                   | [Captured API data](delivery-api.json) includes overvoltage and stored raised/cleared events.                          |
| Unsupported measurements          | Pass                   | SoH/cycles remained null and unsupported.                                                                              |
| Browser display                   | Partial                | [Screenshots](screenshots/README.md) show MPM list/detail and the HA device; full browser acceptance remains open.     |
| HA discovery and history          | Component verification | [Registry/recorder evidence](simulator-demo.md) covers discovery, scenarios, and HA restart at its recorded revisions. |
| Combined clean installation       | Not verified           | Public installation workflow has not been independently executed with fresh data.                                      |
| Full outage recovery              | Not implemented        | Adapter durable retries, receipts, and source-status delivery are incomplete.                                          |

## Limitations of the original recording

The recorded combined rehearsal reused an existing initialized backend with a private local Compose override.
This does not establish an independent clean installation.
In the recorded adapter revision, new-session metadata could receive HTTP 409 before the following summary promotes that session.
Summary updates then succeeded, but metadata recovery was incomplete.

That revision did not deliver source-status heartbeats, so MPM could report stale integration while receiving new summaries.
This state remains visible in the supplied screenshots.
The short overvoltage scenario is active approximately from second 2 to second 8; MPM's 60-second polling can miss the active summary while stored events remain available.

See [the demonstration guide](../demo.md) for scenario commands and [the setup guide](../quickstart.md) for installation.
Earlier component evidence retains its original verification scope and revisions.

## Subsequent setup and display corrections

The [setup and display verification](ui-readiness.md) records the later MPM corrections and their own test scope.
The original results above retain their recorded revisions.

## Adapter delivery recovery

The [adapter recovery record](adapter-recovery.md) documents the later durable queue, metadata recovery and source checks against the actual MPM HTTP kernel and an isolated MySQL database.
It does not replace the historical clean-install or browser results above.
