# Run and review the battery monitoring demo

This project helps an operator identify a battery, see its latest useful readings and understand faults or missing updates.
Home Assistant receives frequent telemetry and history; MPM displays low-frequency summaries and fault events.
The demonstrated source is a simulator, not validated battery hardware.

## Available sources and current limits

| Component                           | Revision inspected                         | Availability                                                           |
| ----------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| Gateway, simulator and HA discovery | `027188253f7496f11c1b74e1b0112db9124b7feb` | Published on the team integration branch.                              |
| MPM backend/plugin                  | `677e189f`                                 | Published on the companion integration branch.                         |
| MPM battery screens                 | `2958b324` on `feat/battery-view-layout`   | Published on the team fork task branch; internal review/merge pending. |

The screen revision is now published on `feat/battery-view-layout`; use that branch to obtain the view until it is reviewed and merged.
The gateway currently has no pinned MPM submodule or combined Docker deployment.
A recursive clean clone therefore cannot yet reproduce the whole demonstration.
The [reproduction record](evidence/reproduction.md) separates verified results from these remaining delivery steps.
Do not run a second database stack on a shared development machine to work around missing packaging.

## Existing shared installation

Use the existing checkout and backend already authorized for that installation.
Do not rerun migrations, seeding, plugin generation or database initialization for frontend work.
The reviewed shared installation uses backend `http://127.0.0.1:18000` and Lucide's separate frontend `http://localhost:8001`.
MySQL, Redis and Horizon are required backend services; HA/MQTT are separate consumers/services.
The observed practice HA and MQTT host ports are 8124 and 1885, but their credentials and network endpoints must come from their owner.

From the MPM repository root in a Linux/WSL terminal:

```sh
git status --short
git log -1 --oneline
docker ps --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}'
```

Expect the desired source revision and the existing backend/data service identities before starting a frontend.
The frontend implementation includes `docs/development/libre-solar-bms-frontend.md`, with a portable standalone frontend-only Compose example using its own project/container/dependency volume.
Follow that guide after obtaining the screen revision; it starts only frontend-dev with `--no-deps` and configures `MPM_BACKEND_URL` through MPM's supported environment.
It includes exact startup/stop commands and a reduced-memory production build.
Do not use the gateway's Node version for MPM: the frontend image pins Node 20.18.

Open the frontend in the browser that works in your environment, including the VS Code browser when Windows browser forwarding is unreliable.
The upstream disposable MPM demo account is `demo_company_admin@example.com` / `123123`.
Use it only with the local disposable demo, or obtain an authorized account for your installation.
Successful login must show requests to the configured backend, then an enabled Libre Solar plugin and its battery list.
The list is `/libre-solar-bms/overview`; detail is `/libre-solar-bms/batteries/{id}`, using an ID returned by the signed-in API.
A company integration API key never belongs in browser configuration.

## Gateway tools and simulator

Prerequisites: Git, nvm with network access, Docker/Compose, an authorized MQTT broker endpoint and its credentials, and the provisioned MPM node/key for real ingestion.
From the gateway root in Linux/WSL:

```sh
nvm use
npm ci
node --import tsx app/simulator/main.ts --help
node --import tsx app/simulator/main.ts --list-scenarios
```

Expected: Node 24.21.0 from `.nvmrc`, a locked install and eleven supported scenario names.
If Node is absent, use `nvm install` first; do not install Windows npm or change MPM's runtime.
See the [simulator guide](simulator.md) for all accepted options, timing and persistent producer outbox behavior.
Simulator and HA discovery code are present in the inspected integration revision, despite older historical merge-status notes in those guides.

For real delivery, configure the existing ignored `.env.mpm-ingest` using [the adapter settings](mpm-ingest.md).
If it does not exist, copy `deploy/mpm-ingest.env.example` to that filename; do not overwrite an existing configuration.
Set the real broker endpoint/credentials, `MPM_BASE_URL`, the provisioned company key, adapter identity and node allowlist.
On the reviewed shared backend `MPM_BASE_URL` is `http://127.0.0.1:18000`.
Obtain secrets through the authorized provisioning workflow; do not paste them into source, logs or screenshots.

From the gateway root, with that configuration complete:

```sh
npm run dev:mpm-ingest
```

Expected: a `subscribed` status for the configured node set.
Start the simulator in another gateway terminal using the exact broker URL and scenario command from the simulator guide.
The source node ID must match the backend's provisioned battery and adapter allowlist.
Use Ctrl+C for a clean simulator/adapter stop and retain the producer outbox file.

For HA, follow [the onboarding guide](home-assistant.md) with the actual broker host/port reachable from the HA container.
A host loopback URL and a container service hostname are different addresses.
Create an HA account and configure its MQTT integration; discovery does not perform those first-run steps.
Do not start the HA helper on ports already owned by a teammate's HA/MQTT services.

## A genuinely new installation

Perform this separately when the frontend revision is published and deployment is ready for review.
Use a new clone, an unused Compose project name, unused HTTP ports and fresh named data volumes.
Preserve the shared installation and its volumes.
The [published MPM isolated Docker guide](https://github.com/hubertnshuti/micropowermanager/blob/677e189f/docs/development/libre-solar-compose.md) documents required backend, Horizon, frontend, MySQL and Redis startup, locked installs and explicit one-time initialization.
Use it only for new isolated disposable data; its initialization commands are not routine startup instructions.
The [plugin guide](https://github.com/hubertnshuti/micropowermanager/blob/677e189f/docs/development/libre-solar-bms-plugin.md) documents explicit-company provisioning, read permissions and private company key creation.
No combined gateway/MPM/HA initialization is claimed by these component guides.
Record each missing step before asking its owner, then update and retest the written instruction.

## Operator demonstration

1. Sign into MPM and open the real battery list/detail, with fixture mode absent.
2. Show the source label, measured values, original UTC observations, source assessment and integration freshness separately.
3. Explain that a missing reading is unavailable while zero stays zero, and unknown faults never imply healthy.
4. Show paginated fault events and their original observation times; a first observation does not establish when a fault began.
5. Use the frontend guide's explicit development preview URLs to demonstrate fault/unknown/zero/stale/error presentation if live scenarios are not ready, keeping the fixture banner visible.
6. Show HA readings/history only from an actually running, verified simulator/HA setup; do not present a fixture or old recording as current integration.

The current gateway adapter does not deliver source-status checks, durable HTTP retries/outbox or stored-event receipts.
A real MPM battery can therefore correctly show stale integration even while a summary was accepted.
Do not call that current or hide it for a pitch.
No hardware validation, battery controls, estimated SoH/cycles or MPM timeseries charts are included.
