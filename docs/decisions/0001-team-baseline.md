# 0001: Team development baseline

Date recorded: 2026-10-11. Status: development baseline established;
independent setup verification pending.

## Problem

The gateway and MPM are separate repositories with different runtimes.
Contributors need a shared starting point, clear ownership and reproducible tools.
This record documents the existing baseline; it does not establish a working
battery integration or component-owner approval of the message contract.

## Source references

| Source                       | Reference revision                         |
| ---------------------------- | ------------------------------------------ |
| Original gateway challenge   | `1c7fc12dbdcf804ca288c610833dcaa8c844d012` |
| Libre Solar firmware mapping | `779d20199bff2666e01371ce2f562dcda4d6bda3` |
| MPM application baseline     | `8cabe6e3f2957b2274aff3fa09c48d3e5ec30533` |

The challenge's original brief is preserved in [CHALLENGE.md](../../CHALLENGE.md).
The root README provides developer guidance.
The firmware revision is the mapping reference, not a tested hardware build.
MPM dependency files determine its runtime requirements; older version numbers
in the challenge are not installation instructions for this application revision.

## Decisions and ownership

Use the gateway and MPM team forks, with `team/bms-monitoring` as the shared
integration branch in both. Internal feature pull requests target that branch
in the corresponding fork. Keep one existing working clone for each repository
and preserve local work when switching branches.

| Owner                    | Responsibility                                                                 |
| ------------------------ | ------------------------------------------------------------------------------ |
| Hubert, integration lead | Shared contract, MQTT-to-MPM adapter, integration, deployment and coordination |
| Member 2                 | Simulator, source mapping, MQTT publisher and Home Assistant                   |
| Member 3                 | MPM backend, authentication, provisioning and battery storage                  |
| Member 4                 | MPM screens and independent setup verification                                 |

Gateway source stays in this repository. MPM PHP and Vue changes stay in the
[companion fork](https://github.com/hubertnshuti/micropowermanager).
An integrated kit with a submodule pinned to a published MPM fork commit is
planned; no submodule is implemented by this baseline.

Use Windows with Ubuntu/WSL 2 and Linux containers as the primary team setup.
Keep repositories in the WSL Linux filesystem. Docker Desktop supplies the
engine for Windows development. Follow the [development guide](../development.md)
for installation, authentication and repository commands.
This setup choice does not claim independent verification on every machine.

Pin gateway Node to `24.21.0` in `.nvmrc`. Keep gateway tools separate from MPM's
frontend container runtime. Use private ESM TypeScript tooling, strict typechecks,
exact dependency versions and a committed npm lockfile. Gateway checks cover
`app/`, `lib/` and `tests/`, excluding external MPM source.

These repository, runtime and ownership choices are team decisions.
Firmware field meanings and MPM dependency requirements come from their pinned
source references. Message names, timings, API routes and demo settings belong
to [the separate contract decision](0002-message-contract-v1.md), whose owner
reviews remain pending.

## Existing implementation and consequences

Gateway foundation merged at `aedc513c4b7384c40e809d17a0446794288b89a6`;
tooling merged at `c03a8a9a3ddf3cad0f4406331007e17b90f15678`;
layout and developer guidance merged at `fb2428088225a5c45719d75ad66e0e00c49c64ed`.

The MPM development Composer fix merged at
`a5097f50ee5f7d329d303685ba8a042eaf1d5a65`. Its development Dockerfiles copy
Composer `2.8.8` from the official Composer image. This confirms the merged
build change, not a new runtime or battery integration test.

Shared fixtures and separate component reviews keep boundaries reviewable.
Using a separate MPM clone avoids copying plugin code into the gateway.
Alternatives such as one combined source tree or unpinned tool versions would
make ownership and reproduction harder to track.

Another team member must still verify the documented setup independently.
Keep hardware demonstration requirements from the challenge visible:
simulator testing does not prove either real transport path.
