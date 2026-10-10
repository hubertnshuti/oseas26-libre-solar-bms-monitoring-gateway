# Libre Solar BMS Monitoring Gateway

Battery monitoring through a shared MQTT feed, with Home Assistant telemetry
and battery summaries and faults displayed inside MicroPowerManager (MPM).

## Development status

This repository is being developed. The setup below installs gateway tooling;
it does not start a working simulator or a complete battery integration.
MPM's existing demo can be run separately using the development guide.

The planned components are a simulator, a versioned MQTT contract, a publisher,
Home Assistant discovery, and an adapter delivering summaries and events to MPM.
The MPM backend and screens are developed in the companion MPM fork.

## Start development

Prerequisites: Git, Python 3, Node through nvm, and Docker with Compose.
On Windows, use Ubuntu/WSL 2 and Docker Desktop with Ubuntu integration enabled.
See [development setup](docs/development.md) for installation and sign-in steps.

Clone once; if the folder already exists, open the existing clone.

```bash
mkdir -p ~/work/oseas
cd ~/work/oseas
git clone --branch team/bms-monitoring https://github.com/hubertnshuti/oseas26-libre-solar-bms-monitoring-gateway.git gateway
cd gateway
nvm install && nvm use && npm ci
bash scripts/check-environment.sh
npm run typecheck
npm run format:check
```

Run each command in order. Resolve failures before continuing.
The environment check requires Docker Desktop to be running.

Create a task branch before editing. Follow the [branch, test, and PR workflow](docs/development.md#branch-test-and-pr-workflow).
For MPM backend or frontend work, follow [MPM setup](docs/development.md#mpm-development).

## Repository layout

| Directory            | Purpose                                                     |
| -------------------- | ----------------------------------------------------------- |
| `app/simulator/`     | Simulated battery readings and repeatable scenarios         |
| `app/mpm-ingest/`    | MQTT-to-MPM delivery service                                |
| `lib/contract/`      | Versioned JSON schemas, shared types, and field definitions |
| `lib/libresolar/`    | Libre Solar field, unit, channel, and fault conversion      |
| `lib/publisher/`     | MQTT publishing and Home Assistant discovery                |
| `tests/unit/`        | Isolated component behavior                                 |
| `tests/contract/`    | Valid and invalid message validation                        |
| `tests/fixtures/`    | Shared, versioned test examples                             |
| `tests/integration/` | Behavior across services                                    |
| `deploy/`            | Gateway deployment configuration as it is implemented       |
| `scripts/`           | Environment and development utilities                       |
| `docs/decisions/`    | Technical choices and their reasons                         |
| `docs/evidence/`     | Reproduction steps and actual verification results          |
| `external/`          | Companion source references; MPM submodule planned          |

Empty component directories contain `.gitkeep` so Git preserves their paths.
Remove a directory's `.gitkeep` when adding its first implementation files.

## Integration boundaries

- The simulator and future hardware sources publish the same documented contract.
- Home Assistant receives telemetry for live readings and history.
- The adapter sends lower-frequency summaries and fault events to MPM.
- MPM owns authentication, company separation, battery records, and its screens.
- Missing readings remain distinguishable from zero. Simulated data is labeled.

MPM source belongs in the [companion fork](https://github.com/hubertnshuti/micropowermanager).
For current development, clone it beside the gateway. The planned integrated
delivery will reference an exact published MPM commit through a Git submodule
and build that code with Docker. The submodule and combined deployment are
not added by this layout change.

## Checks

`npm run typecheck` checks TypeScript. `npm run format:check` checks formatting
in the gateway source and documentation. `npm test` runs the contract validation
suite. These tests cover message shapes and semantic rules; they do not prove a
working simulator, MQTT connection, MPM integration or restart recovery.

The [message contract v1](docs/message-contract.md),
[MPM API agreement](docs/api-contract.md), schemas and
[versioned fixtures](tests/fixtures/v1/README.md) are ready for component review.
The [decision record](docs/decisions/0001-message-contract-v1.md) tracks pending
owner questions and the review required before freezing the first slice.

## Project references

- [Original challenge brief](CHALLENGE.md)
- [Contribution guide](CONTRIBUTING.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [MPM plugin development](https://micropowermanager.io/development/plugins.html)
- [Libre Solar firmware](https://github.com/LibreSolar/bms-firmware)

The challenge includes a real BMS transport demonstration, with the simulator
as fallback. See the challenge brief for the complete expected outcomes.
