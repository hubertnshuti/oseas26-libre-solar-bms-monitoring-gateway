# Battery setup and display verification

This change selects MPM revision `0687034c646aa821498f637fae447aedc62c198d`.
It corrects plugin onboarding, numeric presentation and browser-side integration ageing.
It also clarifies the local installation workflow and prevents separate Compose projects from sharing mutable build image tags by default.

## Verified checks

| Check                     | Result and scope                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| MPM backend               | 38 battery tests, 353 assertions, using a separate MySQL testing database. Includes transactional rollback/retry and list freshness fields.   |
| MPM frontend              | 87 tests across four suites. Includes setup readiness, empty/error/retry states, completion guards, display precision and integration ageing. |
| Frontend production build | Completed successfully from the selected MPM source, using the demo Dockerfile and locked dependencies.                                       |
| Gateway                   | TypeScript, formatting and all 286 tests across 12 files passed on the gateway integration branch.                                            |
| Packaging                 | Shell syntax, Compose configuration and submodule checks are verified separately from a fresh full installation.                              |

Focused Vue tests execute component scripts and presentation logic; they do not mount templates.
A successful production build establishes compilation, not complete browser acceptance.
Subsequent live installation and browser results are recorded in [clean-install verification](clean-install.md).

## Expected behavior

Opening plugin setup displays a compact access/provisioning check.
Completion is enabled only after a successful read returns at least one provisioned battery.
The ordinary battery dashboard and detail pages are displayed outside the setup dialog.

Percentages and temperatures display at most one decimal place; voltage/current values retain up to three decimal places so small differences remain visible.
API and stored values retain their original precision.
Zero remains a value; missing and unsupported measurements remain unavailable.
Both battery list and detail age the original integration check using the backend-provided threshold.
A stale or absent integration check does not imply a current connection.

The gateway adapter selected by the UI-only release lacked durable HTTP delivery and source-status heartbeats.
Consequently, source details can remain unavailable after the known initial-metadata session conflict, and integration status can remain stale while summaries arrive.
Later transport repairs and their verification are recorded in [adapter recovery](adapter-recovery.md).
Hardware transport and Prospect integration remain outside the demonstrated path.
