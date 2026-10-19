# Libre Solar BMS Monitoring Gateway

Battery monitoring for mini-grid operators: live electrical readings in Home Assistant, with battery summaries and fault history in MicroPowerManager (MPM).
One MQTT feed serves both applications.
**This demonstration uses simulated readings, not a physical battery.**

```text
Simulator → MQTT broker → Home Assistant: discovery, live readings, history
                      └→ Gateway adapter → MPM: battery summaries and fault events
```

An operator can inspect a simulated battery, identify an observed fault, and see when the measurement was taken.
The integration is read-only: it does not control batteries, change protection settings, or affect customer payments.
Unsupported state-of-health and cycle-count measurements remain unavailable.

## Run the demonstration

Prerequisites: Git, Docker with Compose, Bash and OpenSSL.
Use Linux or a WSL terminal with Docker Desktop integration enabled.
First installation downloads/builds images and initializes a private local demo database; allow time and disk space.
No host Node, npm, PHP or Composer installation is needed to run the demo.

```bash
git clone --branch main --recurse-submodules https://github.com/hubertnshuti/oseas26-libre-solar-bms-monitoring-gateway.git gateway
cd gateway
bash deploy/demo.sh configure
```

Review `.env` for an unused project name and ports, then install:

```bash
bash deploy/demo.sh install
bash deploy/demo.sh verify
```

Follow the [first-installation guide](docs/quickstart.md) for login, Home Assistant configuration and troubleshooting.
After installation, the ordinary startup command is:

```bash
docker compose up -d --wait --wait-timeout 300
```

| Application        | Default local URL         |
| ------------------ | ------------------------- |
| MicroPowerManager  | http://localhost:18081    |
| Home Assistant     | http://localhost:18123    |
| MPM backend health | http://localhost:18080/up |

Complete Home Assistant onboarding once, using the exact MQTT settings in the setup guide.
Saved configuration and history persist across `docker compose stop` and the startup command.

## Delivery status

The MPM submodule pins the backend and battery screens to the revision recorded by this gateway commit.
Run `git submodule status` to inspect that exact revision; the installer checks it before building.
The battery screens provide a compact setup check, readable measurement precision and independently aging integration status.
The simulator, MQTT contract, discovery publisher, adapter, backend and screens are implemented.
A separate public checkout with fresh database and service volumes has passed installation, live battery delivery and authenticated API checks.
`bash deploy/demo.sh verify` checks the running services and actual battery data without requiring host development tools.
See the [clean-install verification](docs/evidence/clean-install.md) for the tested revision, browser results and remaining scope.

The adapter persists pending deliveries in SQLite, retries transient backend failures, and acknowledges events only after local commit.
New-session metadata waits for its summary to establish the backend session.
Source checks use new telemetry, become stale after 15 seconds of silence, and keep their original check times on retries.
Keep the `adapter_data` volume: it contains acknowledged events awaiting backend delivery and the durable status revision.
See [adapter operations](docs/mpm-ingest.md) for capacity, quarantine and recovery instructions.
Hardware transport and Prospect integration are not demonstrated.
This local HTTP setup is a demonstration, not a production deployment.

## Technical references

- [Message contract and timing](docs/message-contract.md)
- [API authentication, tenant ownership and response shapes](docs/api-contract.md)
- [Adapter behavior and limitations](docs/mpm-ingest.md)
- [Simulator scenarios and field mapping](docs/simulator.md)
- [Home Assistant entities and discovery](docs/home-assistant.md)
- [Battery screen layout and field mapping](docs/battery-view.md)
- [Development and checks](docs/development.md)
- [Original challenge](CHALLENGE.md)

Gateway application code is in `app/`, shared schemas/normalization/publishing in `lib/`, and tests in `tests/`.
Docker packaging is in `compose.yaml` and `deploy/`.
MPM remains a separate repository under `external/micropowermanager`, pinned by Git rather than copied into this source tree.
Internal team merges and upstream acceptance are separate; this delivery does not claim upstream acceptance.
