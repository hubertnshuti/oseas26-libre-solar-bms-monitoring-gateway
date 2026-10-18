# Development guide

## Choose the appropriate setup

For a complete local demonstration, follow the [quickstart](quickstart.md).
It builds the gateway and the pinned MPM submodule together, provisions a simulated battery and starts Home Assistant.
Only Git, Docker with Compose, Bash and OpenSSL are required on the host.
The commands below are for changing and testing source code.

Use Linux or a WSL 2 terminal with Docker Desktop integration enabled.
Keep the checkout in the Linux filesystem when using WSL.
Confirm `docker version` reports both a client and a server, and `docker compose version` succeeds.
Do not install a second Docker engine inside WSL when using Docker Desktop.

## Gateway development

Clone the repository and its pinned dependencies:

```bash
git clone --branch main --recurse-submodules https://github.com/hubertnshuti/oseas26-libre-solar-bms-monitoring-gateway.git gateway
cd gateway
```

For an existing checkout, run `git submodule update --init --recursive` after updating the gateway branch.
Do not use `git submodule update --remote`: that changes the selected MPM version.

Install the Node version recorded in `.nvmrc` using your Node version manager.
The gateway environment checker also requires Python 3.
With an existing nvm installation:

```bash
nvm install
nvm use
npm ci
bash scripts/check-environment.sh
npm run typecheck
npm run format:check
npm test
```

Use `npm ci` to reproduce the committed dependency lockfile.
Do not use `sudo npm install` or replace the lockfile to resolve a setup error.
Tests that create a local HTTP server require permission to bind loopback sockets.

The [adapter guide](mpm-ingest.md) documents standalone adapter configuration.
The [simulator guide](simulator.md) documents deterministic scenarios and standalone execution.
For combined integration testing, use the gateway Compose stack from the quickstart.

## MPM development

The MPM source is the Git submodule at `external/micropowermanager`.
It is a separate repository with its own branches, commits and contribution instructions.
Read its `AGENTS.md` and the relevant backend or frontend instructions before editing.

```bash
cd external/micropowermanager
git status --short
git switch -c fix/your-change
```

A submodule checkout is normally detached at the gateway's recorded revision, so create a branch before making commits.
Configure your own Git commit name and email in both repositories if they are not already configured globally.

Choose one runtime for the work:

- The **gateway demo stack** connects the simulator, adapter, MPM and Home Assistant.
  Its frontend is a static production build; frontend source changes require `docker compose build frontend` followed by `docker compose up -d --no-deps frontend`, run from the gateway root.
  Its backend source is mounted into the container, but schema changes still require explicit migrations.
- The **MPM development stack** provides the upstream development environment and frontend live reload.
  Follow the [MPM development guide](https://micropowermanager.io/development/development-environment.html) from the submodule root.
  Its default ports and services differ from the gateway demonstration.
  Keep its database and volumes separate from the demo stack.

Do not run test migrations or seeders against a demonstration database.
Use the isolated testing database configured by MPM's backend test instructions.
The [MPM battery integration guide](../external/micropowermanager/docs/development/libre-solar-bms.md) describes the plugin and its focused verification commands.

After committing and publishing an MPM change to an accessible branch, return to the gateway and commit the updated submodule reference.
Review `git diff --submodule=log` before staging it.
A gateway commit that references an unpublished MPM commit cannot be reproduced by other contributors.
The demo installer deliberately refuses an uncommitted or mismatched MPM checkout.

## Branch, test and review workflow

Keep fixes on a task branch and integrate them through review.
The shared integration branch is `team/bms-monitoring`; `main` receives verified integration changes.
Check for existing local work before switching branches and preserve it on its current branch.

```bash
git status --short
git fetch origin
git switch -c fix/your-change origin/team/bms-monitoring
```

For gateway changes, run `npm run typecheck`, `npm run format:check` and `npm test`.
For MPM changes, run the backend or frontend checks specified in that repository, including the focused battery tests when affected.
Exercise failure and recovery paths for changes involving network delivery, persisted state or freshness.

Before committing:

```bash
git diff --check
git diff --submodule=log
git status --short
```

Stage only the intended files and inspect `git diff --cached`.
Keep `.env`, `.demo/`, generated data, local planning notes and credentials out of commits.
Preserve contributor attribution and licenses.

The pull request should explain the operational problem, behavior change, engineering trade-offs, exact verification performed and remaining limitations.
Include screenshots for visible changes and installation steps when configuration changes.
Publish MPM commits before the gateway commit that references them.
After integration, rerun affected checks on `team/bms-monitoring` before proposing the change to `main`.
A passing unit suite alone does not establish a successful clean installation or browser workflow.

## Troubleshooting

| Problem                                     | Check and action                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Docker server unavailable                   | Start Docker Desktop or Docker Engine; on WSL, enable integration for the active distribution.                               |
| Wrong Node version                          | Select the version in `.nvmrc` before running `npm ci` or tests.                                                             |
| Missing MPM files                           | Run `git submodule update --init --recursive` from the gateway root.                                                         |
| Installer reports a mismatched MPM revision | Finish the intended MPM change and commit the gateway gitlink, or restore the recorded revision after preserving local work. |
| Formatting fails                            | Format only affected files, review the diff and rerun the check.                                                             |
| Port already allocated                      | Inspect `docker ps`; choose unused demo ports rather than stopping unrelated services.                                       |
| Frontend still shows old behavior           | Rebuild and recreate the gateway frontend, or use the MPM development server for live reload.                                |
| Backend or adapter fails                    | From the gateway root, inspect `docker compose ps -a` and `docker compose logs --tail=80 backend adapter`.                   |
| Git push is denied                          | Confirm access to the target fork and authentication for the configured remote.                                              |

When reporting a failure, include the repository revision, command and relevant error after removing credentials.
Do not use volume deletion, `migrate:fresh` or `git reset --hard` as routine troubleshooting.
