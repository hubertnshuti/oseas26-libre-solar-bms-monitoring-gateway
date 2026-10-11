# MQTT-to-MPM adapter baseline and handoff

Verified 2026-10-11 in `/home/ngenzi/work/oseas/gateway`, branch
`feat/mpm-ingest-basic`, clean commit
`0373de9062c6d905424aa1c97d947739eac72f3b` before this evidence addition.
Runtime: Node 24.21.0 and npm 11.19.0; existing installed dependencies were used.
A clean install had not been rerun at baseline; the final implementation checks below include it.

| Command from gateway root | Result                   |
| ------------------------- | ------------------------ |
| `npm run typecheck`       | Passed                   |
| `npm run format:check`    | Passed                   |
| `npm test`                | Passed: 1 file, 99 tests |

These are contract checks, not proof of MQTT or HTTP delivery.
At the start of the session, `app/mpm-ingest/` had no implementation.
The subsequent first slice is described below.
Gateway `origin/team/bms-monitoring` is `7bc5c7910a85c16e31705b49b180d40a735b4da0`;
the task branch preserves a subsequent decision-numbering restoration.
Contract PR #4 is present in the integration branch's merge history.
Its [decision record](../decisions/0002-message-contract-v1.md) still records
owner reviews as pending; merge is not evidence that the interface is frozen.

The companion MPM clone is clean on `fix/mpm-local-composer-build` at
`6984e967`; its fetched `origin/team/bms-monitoring` is
`a5097f50ee5f7d329d303685ba8a042eaf1d5a65`.
That team revision has no `src/backend/app/Plugins/LibreSolarBms` or
`src/frontend/src/plugins/libre-solar-bms` directory.
No real endpoint, provisioned battery, simulator feed or screen was verified.

## First adapter slice and owner handoff

Owner: Hubert / role A, in this gateway branch.
Use the existing v1 schemas and fixtures without changing their meaning.
Validate configuration for MQTT credentials, MPM URL/company key, one company
binding and node allowlist; errors and logs must omit secrets.
MQTT.js 5.16.0 is now pinned in the root manifest/lockfile for the subscriber.
The publisher owner should reuse this dependency rather than edit a second lockfile.

Subscribe to allowed nodes' summary, events, attributes, availability and telemetry.
Use `parseMessage` with the actual topic and reviewed profile capabilities;
reject invalid JSON, invalid schema, node mismatch and unbound nodes before HTTP.
Telemetry and availability are observations, not per-sample database writes.
Producer MQTT status is not a defined topic.

Test summary delivery with `tests/fixtures/v1/valid/normal.summary.json`
against a local fake HTTP server using the proposed
`/api/libre-solar-bms/ingest/summaries` route and company Bearer header.
Assert the exact body and unchanged observation/message identity.
Check successful responses against the matching message ID and recognized outcome;
malformed responses, wrong IDs, authentication failures and transient failures
must remain visible and must never be logged as successful writes.
Label this endpoint explicitly as a test substitute.

Backend owner handoff: confirm the routes/header and implement provisioning;
publisher owner handoff: supply a real summary publish command.
Then deliver a simulator summary to the actual MPM endpoint and query the
provisioned battery to verify its source marker and SoC; obtain the screen
evidence from the screen owner.
No successful end-to-end command can be supplied until these components exist.
Durable queue receipts and restart recovery belong to the subsequent reliability
slice; never publish a `stored` event receipt before durable queue commit.

## Implemented slice

`app/mpm-ingest/` now contains configuration validation, a node-bound message
handler, the HTTP client and the MQTT executable.
`deploy/mpm-ingest.env.example` and [the runtime guide](../mpm-ingest.md) describe
start/stop, secret handling, failure outcomes and the in-memory delivery limits.
The executable uses the pinned MQTT.js client; Node's built-in fetch supplies HTTP.
No contract fields or API routes changed.

The HTTP tests use an actual loopback HTTP server as a fake MPM endpoint.
The runtime test launches the executable against a deliberately limited MQTT
protocol peer handling CONNECT/SUBSCRIBE and a single QoS 1 summary PUBLISH.
It checks subscriptions, the authenticated exact HTTP body, accepted logging and
clean shutdown without credential exposure.
This peer is a test substitute, not a real broker or simulator.

The sandbox rejected registry DNS with EAI_AGAIN and loopback listen with EPERM;
installation and socket tests were rerun with the necessary permissions.
One initial executable test timed out before startup output; its isolated unchanged
rerun passed. Final full-suite results are recorded below.
`docker version` failed because Docker Desktop WSL integration is unavailable;
real Mosquitto/MPM and screen evidence remain not run.

There are no durable receipts, retry engine, persisted quarantine or freshness
statuses in this slice. A03 remains awaiting real publisher/backend/screen
integration; A04/A05 reliability behavior is not claimed.

## Final local verification

Verified 2026-10-12 in the gateway root, dirty `feat/mpm-ingest-basic` based on
`0373de9062c6d905424aa1c97d947739eac72f3b`, Node 24.21.0/npm 11.19.0:

| Command                                          | Result                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| `npm ci --fetch-retries=0 --fetch-timeout=20000` | Passed; 90 packages installed, audit reported zero vulnerabilities           |
| `npm run typecheck`                              | Passed                                                                       |
| `npm run format:check`                           | Passed                                                                       |
| `npm test`                                       | Passed: 4 files, 151 tests (99 existing contract tests and 52 adapter tests) |
| `git diff --check`                               | Passed                                                                       |

The package manager noted the existing esbuild postinstall was not covered by its
script approval setting; executable tests still passed without changing that setting.
An earlier check group overlapped dependency replacement and could not find tsc
or prettier; both checks were rerun after install completed and passed.
The complete suite passed after the clean install and again after the review fix
for older duplicate attributes; no checks or assertions were disabled.
There is no new commit, push or PR from this session.

## Real broker follow-up — 2026-10-12

Docker became available after Docker Desktop was opened.
Verified Docker Desktop 4.71.0, Engine 29.4.1 and Compose v5.1.3.
The sandbox denied the Docker socket; the authorized outside-sandbox check worked.
No pre-existing running containers were present.

From `/home/ngenzi/work/oseas/gateway`, dirty `feat/mpm-ingest-basic` based on
`0373de9`, ran `npm run test:mpm-ingest:broker` against Mosquitto 2.1.2:

`eclipse-mosquitto@sha256:38c0da4f2ef84284d47b3b3eeea1cb3bdeabe81ee10caf0cd5c5ff61ee3ea408`

The pinned image comes from the [official Eclipse Mosquitto image](https://hub.docker.com/_/eclipse-mosquitto).
The script generated temporary local test credentials, configured authentication
and the adapter's node-scoped read ACL, launched the real executable with an env
file, and connected it to a real broker and a fake MPM HTTP server.

Result: **passed**, eight checks, exactly two summary HTTP writes.
Wrong broker credentials were rejected; the retained summary preserved its exact
payload and original source times; 20 telemetry packets, malformed/type-invalid
summaries and an unbound topic added no HTTP writes.
The adapter reconnected/resubscribed after broker restart and delivered another
summary; shutdown exited cleanly and logs contained neither test password nor key.
The script removed its own container and temporary files; no user volumes touched.

The first attempt passed initial delivery/rejection checks but timed out on
reconnect. A diagnostic rerun proved Docker had changed the random host port on
restart (46509 to 45119). The verification script now selects an available fixed
loopback port and asserts address stability; the same reconnect assertions pass.
No adapter behavior was changed to bypass this test failure.

This verifies real broker transport, not the absent MPM plugin, database effects,
company isolation, a real simulator process, screens or durable event recovery.

After the follow-up script/documentation changes, typecheck, formatting, all 151
tests in 4 files and `git diff --check` passed again.
`docker ps` confirmed no running containers remained after verification.
