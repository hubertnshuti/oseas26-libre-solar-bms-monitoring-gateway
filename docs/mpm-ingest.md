# MQTT-to-MPM adapter

The adapter validates the configured nodes' MQTT messages, stores pending work durably, and delivers summaries, events, metadata and source-status checks to MPM.
Telemetry drives freshness checks; individual telemetry samples are not written to the MPM metrics API.
For installation of the complete simulator demonstration, use the [quickstart](quickstart.md).
For test scope and actual integration results, see the [delivery record](evidence/delivery.md).

## Run against an existing backend

Use the Node version in `.nvmrc` (Node 24, including its built-in SQLite module).
Provision the battery and adapter identity in MPM before starting.
Supply a company API key and authenticated MQTT credentials:

```bash
nvm use
npm ci
cp deploy/mpm-ingest.env.example .env.mpm-ingest
# Edit the ignored file with the actual local credentials and bindings.
npm run dev:mpm-ingest
```

A `subscribed` log confirms the broker granted the five subscriptions: `summary`, `events`, `attributes`, `availability` and `telemetry` for each allowed node.
The adapter publishes event receipts to `libresolar/bms/v1/{node_id}/receipts/mpm` with QoS 1, without retention.
Broker ACLs must allow those subscriptions and receipt publication.
It does not subscribe to producer-supplied `status`; source checks belong to the adapter.

Stop with Ctrl+C.
Shutdown stops incoming work, waits for the active HTTP attempt to finish or time out, and preserves pending work for the next start.
A failed durable write stops the process with a nonzero exit code and a `storage_failed` log.

## Configuration

| Setting                          | Meaning                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `MQTT_URL`                       | Required `mqtt://` or `mqtts://` server origin without embedded credentials or paths.                                              |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | Required broker credentials.                                                                                                       |
| `MPM_BASE_URL`                   | Required HTTP(S) server origin; omit `/api`.                                                                                       |
| `MPM_API_KEY`                    | Required company Bearer key from the provisioning workflow.                                                                        |
| `MPM_COMPANY_BINDING`            | Required stable local company label; not sent as tenant authority.                                                                 |
| `BMS_ADAPTER_ID`                 | Required provisioned identity; run one adapter instance per identity.                                                              |
| `BMS_NODE_IDS`                   | Required comma-separated uppercase 16-digit hexadecimal node IDs; maximum 100.                                                     |
| `BMS_SOURCE`                     | `simulator` (default) or `hardware`; must match the provisioned nodes. Selecting hardware does not implement a physical transport. |
| `BMS_STATE_PATH`                 | SQLite state file; defaults to `.local/mpm-ingest.sqlite`. Compose uses `/data/adapter.sqlite` on `adapter_data`.                  |
| `MPM_HTTP_TIMEOUT_MS`            | HTTP timeout, default 10000 ms; maximum 60000.                                                                                     |
| `MQTT_RECONNECT_MS`              | Broker reconnect delay, default 1000 ms; maximum 60000.                                                                            |
| `BMS_MAX_PENDING_MESSAGES`       | Pending plus quarantined records, default 100; maximum 10000. The completed-event receipt cache is bounded by the same count.      |

The state file is bound to the company label, endpoint, source, adapter ID and node allowlist.
Changing that binding requires deliberate reconciliation; startup refuses to reuse another binding's file.
Credential rotation does not change the binding.
Use a persistent local filesystem for the SQLite database and its WAL files, with one state directory per adapter.
Do not delete or recreate `adapter_data` to resolve an error: it contains acknowledged events awaiting delivery and the status revision watermark.
Back up the volume with the adapter stopped, preserving the database and any journal files together.

## Delivery guarantees and limits

Messages pass the shared schema, semantic and topic-node checks before entering the queue.
The configured source is also checked.
Validated attributes are saved as per-session capabilities before HTTP delivery, so a lost metadata response cannot disable profile validation after restart.
Older metadata cannot replace a higher-sequence profile in the same session or affect another session.
MPM selects its tenant from the API key; the adapter never sends a `company_id`.
Payloads retain their original message ID, sequence, observation time and first publication time on every retry.

SQLite transactions use WAL mode and full synchronization.
Every proposed state mutation is validated before commit; invalid mutations roll back without poisoning the next restart.
A `stored` event receipt means the adapter committed responsibility for delivery, **not** that MPM accepted the event.
The producer may then remove the event from its outbox.
Identical producer replays receive the same receipt, including after adapter restart or a lost receipt.
Different content with the same pending/cached ID is rejected as an identity conflict.
MPM remains the long-term duplicate authority; eviction from the bounded completed-event cache is safe because a later replay is stored and delivered again with its original identity.

HTTP writes are serialized.
A validated 200 response must contain the original message ID and `accepted`, `duplicate` or, for current-state messages, `ignored_stale`.
Malformed responses and lost connections are retried.
Transient failures use exponential backoff with jitter, bounded at 30 seconds; valid `Retry-After` values extend the delay, capped at one hour.
Authentication, authorization and content-type failures pause HTTP delivery until configuration is corrected and the adapter restarts.
Permanent errors retain the original record in quarantine for operator reconciliation.
Quarantined events are never silently discarded.

New-session attributes wait until the backend accepts or recognizes a summary from that session.
This avoids using metadata to promote a session, which the backend intentionally forbids.
An unpromotable session's metadata remains pending; its summary conflict is visible for investigation.
Unattempted snapshots may be replaced by a newer snapshot from the same node and session.
Fault events are not coalesced.
At capacity, new records are rejected visibly and events receive no stored receipt, so the producer retains responsibility.
Fix the delivery problem before increasing the capacity.

## Source and integration freshness

Only a genuinely newer, valid, non-retained telemetry observation can establish freshness.
Retained summaries and an `online` availability message cannot establish it.
Future-dated telemetry cannot establish freshness until its observation time is reached.
Backward clock adjustments pause new status checks until the last durable check time is reached again.
The observation watermark survives restarts; replaying the last telemetry sample does not make a restarted adapter fresh.
Source checks start at `unknown`, become `fresh` after a new observation, and become `stale` after 15 seconds of silence.
Explicit source `offline` availability produces `disconnected`; loss of the adapter's broker connection produces `unknown`, because the source's connection cannot then be assessed.
Checks are sent on transitions and every 60 seconds.

Each check has a durable increasing status revision and an original check timestamp.
Retries preserve both.
MPM and the browser independently age the accepted check against the 150-second integration threshold.
A delayed check cannot imply that the integration is currently healthy.
Last-known summary values remain visible with their own observation times.

## Operations and troubleshooting

Logs expose controlled outcome codes and message/node IDs, not credentials, raw payloads or response bodies.
HTTP redirects are refused so a company key cannot be forwarded to another server.
Use loopback HTTP for the local demonstration and verified TLS for remote deployment.

| Log or symptom                                          | Action                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `startup_failed`                                        | Check required settings, state-directory permissions, database integrity and binding. Preserve the database before investigating.          |
| `mqtt_error` / `mqtt_offline`                           | Check broker reachability, credentials and TLS. Reconnection is automatic.                                                                 |
| `subscription_failed`                                   | Correct broker ACLs and restart.                                                                                                           |
| `invalid_payload` / `unbound_topic` / `source_mismatch` | Compare producer data, topic, reviewed profile and configured binding.                                                                     |
| `configuration_error`                                   | Correct the API key, plugin enablement or adapter authorization, then restart. Pending records remain stored.                              |
| `quarantine_required`                                   | Reconcile provisioning or identity conflicts with the backend owner; preserve the state file. No automatic quarantine replay is performed. |
| `delivery_failed`                                       | Restore backend reachability. The adapter retries automatically.                                                                           |
| `capacity_exceeded` / `status_capacity_exceeded`        | Resolve blocked delivery or quarantine before raising the bounded capacity.                                                                |
| `clock_regression`                                      | Correct the host clock; checks resume once time reaches the last persisted check. Do not reset the revision counter.                       |
| `storage_failed`                                        | Restore writable storage/free space and restart. Never substitute an empty state file.                                                     |
| `receipt_publish_failed`                                | Check the receipt ACL and broker connection. The producer retries until it receives the receipt.                                           |

There is no automatic database retention policy in MPM: its event/receipt history preserves replay identity and must be included in capacity planning.
The local Compose credentials and shared broker account are for a loopback demonstration; production identity separation and retention policy require deployment-specific review.

## Verification

```bash
npm run typecheck
npm run format:check
npm test
npm run test:mpm-ingest:broker
```

Unit/integration tests cover queue restart, unchanged replay after a lost response, metadata ordering, quarantine, configuration pauses, capacity, corrupt state, status timing and persisted watermarks.
The broker harness uses real Mosquitto and the actual adapter executable with a fake HTTP endpoint.
It checks credentials, retained data, invalid messages, reconnects, receipts, process-kill recovery, duplicate receipts and connected-but-silent source checks.
It creates and removes only its own temporary container and state directory.
These checks do not by themselves prove real MPM persistence, tenant isolation or browser behavior; those results are recorded separately in the [delivery evidence](evidence/delivery.md).

## Real MPM recovery check

Use the pinned MPM backend source, PHP 8.5, locked Composer dependencies and its `.env.testing` configured for `mpm_testing` at `127.0.0.1:53306`.
Prepare its normal isolated test schema using the backend's documented battery test command first.
Docker must be running for the temporary authenticated Mosquitto broker.
The harness refuses other database names, hosts or ports before creating any test data.

```bash
npm run test:mpm-ingest:recovery
```

If using a separate backend development checkout, set `BMS_TEST_BACKEND` to its `src/backend` directory.
The check creates its own tenant database and test API key, exercises the real MPM HTTP kernel, loses a response after a backend commit, and verifies a single event/receipt after adapter restart and replay.
It also checks new-session metadata recovery and live-to-stale source checks.
The temporary PHP server, broker, tenant database and key are removed afterward.
It does not initialize or reset the demonstration database.
