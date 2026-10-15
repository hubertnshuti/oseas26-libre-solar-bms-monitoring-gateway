# MQTT-to-MPM adapter

The adapter subscribes to configured battery nodes and delivers validated summaries,
events and attributes to the proposed v1 MPM API.
Telemetry and availability are validated without HTTP writes.
Verification includes both a limited MQTT protocol peer and an authenticated real
Mosquitto broker, each with a fake HTTP endpoint.
The simulator, real MPM plugin and battery screen have not been demonstrated together.

## Start and stop

Use Node from `.nvmrc` and run these commands from the gateway root.
Prerequisites for runtime: an authenticated MQTT broker reachable from this machine,
its username/password, an MPM backend with the Libre Solar plugin enabled, a company
API key, and batteries provisioned for the allowed node IDs.
The companion MPM integration branch now contains the Libre Solar backend/plugin at `677e189f`.
Follow its published plugin and isolated Docker guides for explicit-company provisioning.
The [quickstart](quickstart.md) records frontend publication and remaining full-stack limitations.

```bash
nvm use
npm ci
cp deploy/mpm-ingest.env.example .env.mpm-ingest
```

Expected: locked dependencies are installed and an ignored local settings file exists.
If installation fails, check Node and the registry connection before starting.
Edit `.env.mpm-ingest`, replacing the broker credentials and company API key with
values supplied by the broker/backend owners; the placeholders are not working credentials.
Then run:

```bash
npm run dev:mpm-ingest
```

Expected: a JSON `subscribed` log identifies the configured adapter, company label
and node IDs after the broker grants subscriptions.
The runtime subscribes only to those nodes' `summary`, `events`, `attributes`,
`availability` and `telemetry` topics.
There is no producer `status` subscription and no receipt publication.
A delivered fixture produces `accepted`, `duplicate` or `ignored_stale` with its
node/message IDs; an HTTP response must match the original message ID.
Stop with Ctrl+C; the adapter stops accepting messages, disconnects from MQTT and
waits for already accepted HTTP work to finish or time out.
There are no files or volumes to delete for this slice.
Pending work exists only in memory and is lost on a crash.

## Settings

| Setting                          | Meaning                                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `MQTT_URL`                       | Broker origin using `mqtt://` or `mqtts://`; no embedded credentials, path, query or fragment         |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | Required broker credentials; use broker ACLs matching this node allowlist                             |
| `MPM_BASE_URL`                   | Backend server origin using HTTP or HTTPS; omit `/api` and embedded credentials                       |
| `MPM_API_KEY`                    | Required company Bearer key, obtained from the backend owner/provisioning workflow                    |
| `MPM_COMPANY_BINDING`            | Required local label, 1–64 lowercase letters/digits/underscore/hyphen; never sent as tenant authority |
| `BMS_ADAPTER_ID`                 | Required identity in the same format; use one running instance per identity                           |
| `BMS_NODE_IDS`                   | Required comma-separated unique uppercase 16-digit hexadecimal IDs; maximum 100                       |
| `MPM_HTTP_TIMEOUT_MS`            | Request/response timeout; default 10000, range 1–60000 milliseconds                                   |
| `MQTT_RECONNECT_MS`              | Broker reconnect delay; default 1000, range 1–60000 milliseconds                                      |
| `BMS_MAX_PENDING_MESSAGES`       | Maximum in-memory HTTP work including the active request; default 100, range 1–10000                  |

The HTTP client does not follow redirects, so a company key cannot be forwarded
to another server by a redirect.
Logs contain setting names, IDs and controlled outcome codes, without credentials,
raw payloads, URLs or server error bodies.
Use loopback HTTP only for local development; use verified TLS for remote deployment.
Inside containers, use reachable service names rather than the host's loopback address.

## Delivery and limitations

Messages pass the shared schema/semantic validator and topic-node check before delivery.
Wrong-node, oversized and malformed inputs are rejected before HTTP.
Once MPM accepts attributes, those capabilities also constrain subsequent validation.
The company key selects the MPM tenant; this adapter never supplies a `company_id`.
Messages retain their source marker, observation/publication times, sequence and IDs.
MPM remains responsible for duplicate effects and ordering across sessions.

HTTP writes are serialized and pending work is bounded.
At capacity, `capacity_exceeded` is visible; the message is not saved.
Successful HTTP outcomes require status 200, a JSON response, a recognized result
and the matching message ID; `ignored_stale` is not accepted for fault events.
Responses are bounded to 32 KiB.
Authentication/authorization/media-type failures pause all HTTP delivery until restart
after correcting the configuration.
Other permanent failures produce `quarantine_required`; this is a log outcome,
not a persisted quarantine archive.
Network, rate-limit and server failures produce `delivery_failed`.

Automatic retries, durable queues, summary coalescing, application receipts,
status revisions and freshness heartbeats are later reliability work.
The adapter does not publish `stored` event receipts and does not claim reliable
fault recovery after an outage or restart.
Do not use this slice as the only copy of a fault log.
The producer must retain unacknowledged events for the later receipt exchange.
No source-freshness label is inferred from retained summaries or availability.

## Verify and troubleshoot

With dependencies installed, run from the gateway root:

```bash
npm run typecheck
npm run format:check
npm test
```

Expected: all checks pass.
Adapter tests open ephemeral loopback HTTP/TCP ports; the runtime test starts
the real executable against a limited MQTT peer and fake MPM server.
These test substitutes do not prove broker ACLs, retained messages, real tenant
isolation, actual MPM storage or screen behavior.
If a restricted runner rejects socket access with `EPERM`, rerun in an environment
that permits loopback servers; do not disable the tests.
See [verification and handoff evidence](evidence/adapter-baseline.md).

| Log or symptom                      | Next action                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Missing `.env.mpm-ingest`           | Copy the example to the gateway root and fill in actual local values                                                                 |
| `startup_failed`                    | Correct the named setting; do not paste secret values into support logs                                                              |
| `mqtt_error` / `mqtt_offline`       | Check broker reachability, credentials and TLS; reconnect is automatic                                                               |
| `subscription_failed`               | Check broker ACLs for all five suffixes and restart                                                                                  |
| `invalid_payload` / `unbound_topic` | Check v1 fixtures, topic/payload identity and configured node IDs                                                                    |
| `configuration_error` / `paused`    | Correct the company key, plugin permission or API configuration, then restart                                                        |
| `quarantine_required`               | Check provisioning, payload validity or conflict with the backend owner; preserve the producer's original message for reconciliation |
| `delivery_failed`                   | Restore endpoint access and arrange replay from the producer; this slice does not retry automatically                                |
| `capacity_exceeded`                 | Slow the producer or fix the endpoint; increasing the cap does not add durability                                                    |

For the real handoff, the publisher owner supplies the summary publish command,
the backend owner provisions the node and verifies the stored source/SoC, and the
screen owner supplies the corresponding running battery screen evidence.
Record both repository revisions and original message ID; a fake-server result
alone cannot close the first end-to-end delivery task.

## Real Mosquitto verification

With Docker Desktop running and dependencies installed, run from the gateway root:

```bash
npm run test:mpm-ingest:broker
```

Expected: `result: passed`, eight named checks and exactly two HTTP writes.
The script starts an isolated Mosquitto 2.1.2 container pinned by image digest,
with temporary test-only credentials and a node-scoped adapter read rule.
It starts a fake MPM HTTP server and the actual adapter executable using an env file.
It verifies wrong-password rejection, a retained summary without timestamp rewriting,
20 telemetry packets without HTTP writes, malformed/type-invalid summaries,
an unbound topic, broker restart/reconnect/resubscription, post-restart summary
delivery and clean shutdown without credential logs.
The HTTP endpoint remains a test substitute: this does not prove real MPM storage
or company isolation.

The test uses a fixed loopback port selected from an available local port.
An unspecified Docker host port can change on container restart, so the script
also asserts that the published address remains unchanged during the check.
It automatically stops/removes only its own temporary container and removes its
own temporary settings, without deleting any existing volumes or services.
If Docker socket access is denied, run in an environment with authorized Docker
access; if a check fails, inspect the reported assertion before repeating it.
