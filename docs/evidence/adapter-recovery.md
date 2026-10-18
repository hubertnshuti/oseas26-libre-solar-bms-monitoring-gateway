# Adapter delivery recovery

Verified on 18 October 2026 against MPM `0687034c646aa821498f637fae447aedc62c198d`.
The gateway changes are on `fix/bms-delivery-recovery`.
[Captured test API state](adapter-recovery-api.json) contains software fixtures and the resulting database state, without credentials.

## Executed integration check

The check ran the actual adapter executable and an authenticated Mosquitto broker against MPM's real HTTP kernel, ingestion routes, validator, API-key authentication and database service.
It used the guarded `mpm_testing` server at `127.0.0.1:53306` and created a separate temporary tenant database.
The test router binds that owned tenant explicitly because MPM skips normal database switching in its testing environment.
This check does not replace the backend's separate company-isolation tests.
The existing demonstration database and volumes were not used or reset.

| Scenario                                           | Observed result                                                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| HTTP backend unavailable                           | Adapter stored the event and published its durable receipt while HTTP returned 503.                             |
| Adapter forcibly stopped and restarted             | Queue recovered the original event identity, first publication time and observation time.                       |
| Backend committed, HTTP response deliberately lost | Retry returned the backend duplicate outcome; database contained one event and one event identity receipt.      |
| Producer repeated the event after recovery         | Adapter returned the same application receipt.                                                                  |
| New-session metadata arrived before its summary    | No metadata HTTP attempt occurred until the summary was accepted; stored metadata matched the promoted session. |
| Historical or retained telemetry                   | Did not establish fresh source status.                                                                          |
| New telemetry followed by silence                  | Source check became fresh, then stale after the source timeout.                                                 |
| Broker restart                                     | Adapter reconnected and resubscribed.                                                                           |
| Shutdown and cleanup                               | Adapter stopped cleanly; temporary broker, PHP server, tenant database and test key were removed.               |

The backend inspection found exactly one original event and one event receipt.
The retained source metadata was recovered, and the last stored source check was stale after the deliberate silence.
The check exercised a process crash, not a physical host power failure.

## Automated regression coverage

All 305 gateway tests across 13 files, TypeScript and formatting checks passed.
Focused gateway tests cover future-dated telemetry, clock rollback, rollback of invalid state mutations, per-session profile recovery after a lost response, stale metadata replay, SQLite writer serialization, pending capacity, configuration pauses, quarantine and retry timing.
The executable test uses a limited MQTT protocol peer and fake HTTP endpoint.
Its startup allowance accommodates TypeScript/module loading on constrained development machines; HTTP timeout and delivery semantics remain separately tested.

## Reproduce

Follow [adapter verification prerequisites](../mpm-ingest.md#real-mpm-recovery-check), then run:

```bash
npm run test:mpm-ingest:recovery
```

The ordinary broker-only check remains available with `npm run test:mpm-ingest:broker` and uses a fake HTTP endpoint.
The real-MPM check additionally verifies persisted database effects and deliberately suppresses one response after commit.
Both use the same broker scenarios.

## Packaged adapter check

The gateway Docker image built successfully with the locked Node dependencies.
Its actual TypeScript delivery-store module saved a validated profile on a dedicated Docker volume.
A separate container reopened that volume and recovered the profile successfully.
This verifies packaged imports and volume persistence; it is not a full Compose acceptance run.

## Remaining acceptance work

A complete clean Compose installation and full browser/accessibility acceptance remain separate checks.
Hardware transport, physical battery behavior and Prospect integration are not covered.
Quarantined records require operator reconciliation; no automatic quarantine replay or MPM history-retention policy is introduced.
