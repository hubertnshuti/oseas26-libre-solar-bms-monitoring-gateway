# 0001: Development and repository baseline

Recorded: 11 October 2026.

## Context

The TypeScript gateway and the PHP/Vue MicroPowerManager application have different runtimes and release boundaries.
A reproducible integration must identify compatible source revisions without duplicating application code.

## Decision

Keep gateway services, MQTT contracts, simulation, and deployment orchestration in this repository.
Keep MPM plugin/backend/frontend changes in the companion MPM repository, pinned through `external/micropowermanager`.
The integration branch is `team/bms-monitoring`; `main` is the merge target for the assembled delivery.
A submodule pin records a compatible revision without implying upstream acceptance.

Pin gateway Node to `24.21.0` through `.nvmrc` and commit exact dependencies and the npm lockfile.
Use strict TypeScript checks and versioned message fixtures.
MPM retains the runtime versions supplied by its own dependency files and containers.
Gateway checks exclude external MPM source; MPM has separate checks.

Linux and Ubuntu/WSL with Docker Compose are the documented development environments.
The [quickstart](../quickstart.md) provides the combined local demonstration, including explicit database initialization and ordinary startup as separate operations.
The [development guide](../development.md) covers component tooling.

## Source references

| Reference                    | Revision                                   |
| ---------------------------- | ------------------------------------------ |
| Original gateway challenge   | `1c7fc12dbdcf804ca288c610833dcaa8c844d012` |
| Libre Solar firmware mapping | `779d20199bff2666e01371ce2f562dcda4d6bda3` |
| MPM application baseline     | `8cabe6e3f2957b2274aff3fa09c48d3e5ec30533` |

These identify the researched baselines, not hardware-validation results.
The current MPM revision is recorded by the submodule rather than a moving branch.
The original requirements remain in [CHALLENGE.md](../../CHALLENGE.md).

## Consequences

Contributors need a recursive clone to obtain the application source.
Dependencies and revisions are reproducible while repositories retain separate ownership and review.
A physical BMS transport and independent full-stack reproduction require their own evidence.
Message semantics and compatibility rules are documented in [decision 0002](0002-message-contract-v1.md).
