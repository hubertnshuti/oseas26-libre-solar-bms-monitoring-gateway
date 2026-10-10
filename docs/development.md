# Development guide

## Repositories and prerequisites

Use one local gateway folder and one local MPM folder. Switch Git branches for
tasks. The shared branch is `team/bms-monitoring` in both team forks.

| Work                                           | Repository folder                |
| ---------------------------------------------- | -------------------------------- |
| Simulator, MQTT, adapter, contract, deployment | `~/work/oseas/gateway`           |
| MPM plugin, database changes, battery screens  | `~/work/oseas/micropowermanager` |

Existing contributors may have a differently named gateway folder. Use that
folder consistently; the commands below use `gateway` for a new clone.

Read the repository's contribution guide and any applicable `AGENTS.md` before
editing. Accept the repository owner's GitHub collaboration invitation before
pushing. Use your own GitHub account and commit identity.

### Windows and Ubuntu

If Ubuntu/WSL is not installed, open PowerShell as administrator and run:

```powershell
wsl --install -d Ubuntu
```

Restart if requested. Open Ubuntu from the Start menu and create its username
and password. Check in PowerShell:

```powershell
wsl --list --verbose
```

The distribution must show version 2. If `Ubuntu` shows version 1, run
`wsl --set-version Ubuntu 2`; use the exact listed name if different.

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and
[VS Code](https://code.visualstudio.com/) on Windows. In Docker Desktop, enable
the WSL 2 engine and your distribution under Settings > Resources > WSL Integration.
Use Linux containers. In VS Code, install Microsoft's WSL extension.

Run subsequent commands in Ubuntu. Keep source under `~/work/oseas`.
Docker Desktop supplies the Docker engine; do not install a second engine in Ubuntu.

```bash
sudo apt update && sudo apt install -y git curl unzip python3 ca-certificates gh
git --version
docker version
docker compose version
mkdir -p ~/work/oseas
```

Docker must report both Client and Server. If it does not, start Docker Desktop
and check Ubuntu integration before continuing.

### Node and GitHub sign-in

Run `command -v nvm`. If it prints `nvm`, use the existing installation.
Otherwise install nvm using the maintainers' versioned installer:

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh -o /tmp/oseas-nvm-install.sh &&
bash /tmp/oseas-nvm-install.sh
source ~/.bashrc
command -v nvm
```

The gateway's `.nvmrc` selects Node. Run `nvm install && nvm use` inside the
gateway after cloning. Install dependencies locally; do not use `sudo npm install`.
MPM's frontend container selects its own Node version.

For HTTPS pushes, run `gh auth status`. If your account is not authenticated:

```bash
gh auth login --hostname github.com --git-protocol https --web
```

Follow the displayed browser URL and one-time code, then run:

```bash
gh auth setup-git
gh auth status
```

## Gateway setup

Clone once. Skip the clone if you already have the repository locally.

```bash
cd ~/work/oseas
git clone --branch team/bms-monitoring https://github.com/hubertnshuti/oseas26-libre-solar-bms-monitoring-gateway.git gateway
cd gateway
```

Set your identity in this clone:

```bash
read -rp "Your real name: " COMMIT_NAME
read -rp "Your GitHub commit email: " COMMIT_EMAIL
git config user.name "$COMMIT_NAME"
git config user.email "$COMMIT_EMAIL"
git config core.autocrlf input
```

Then:

```bash
nvm install && nvm use && npm ci
bash scripts/check-environment.sh
npm run typecheck
npm run format:check
code .
```

Stop at a failed command and fix the reported problem. `npm ci` requires both
`package.json` and `package-lock.json`. If either is missing, confirm that you
cloned the shared branch containing tooling. Do not create a second package setup.

This is the gateway development baseline. There is no gateway startup command
or combined gateway/MPM Compose stack in this layout change. Runtime commands
must be added with their implementations and verified before being documented.

## MPM development

Run this setup when working on the MPM plugin/screens or testing ingestion.
Start Docker Desktop first. Clone once:

```bash
cd ~/work/oseas
git clone --branch team/bms-monitoring https://github.com/hubertnshuti/micropowermanager.git micropowermanager
cd micropowermanager
```

Set your identity in this clone too:

```bash
read -rp "Your real name: " COMMIT_NAME
read -rp "Your GitHub commit email: " COMMIT_EMAIL
git config user.name "$COMMIT_NAME"
git config user.email "$COMMIT_EMAIL"
git config core.autocrlf input
```

From the MPM root, build and start its development services:

```bash
docker compose config --quiet &&
docker compose up -d --build &&
docker compose ps
```

The first build downloads dependencies and can take time. Wait for the backend
and database to be healthy. Open <http://localhost:8001/> and use the local demo
account `demo_company_admin@example.com` with password `123123`.
The backend is at <http://localhost:8000/>. Keep this default demo local.
Run only one MPM development stack at a time because its container names and ports are fixed.

For later starts with already built images:

```bash
docker compose up -d --no-build && docker compose ps
```

To stop services while preserving stored data:

```bash
docker compose stop
```

Opening the existing MPM demo verifies MPM setup. The battery feature requires
the companion plugin, adapter, and simulator to be implemented and configured.
Frontend-only work can use the development container. Backend/plugin generation
also needs MPM's documented advanced environment; follow the
[MPM development guide](https://micropowermanager.io/development/development-environment.html)
and its source dependency files. Keep MPM's existing dependency lockfiles.
Use the designated isolated test database for backend tests.

## Branch, test, and PR workflow

Run these steps inside the repository you are changing.

1. Check `git status --short`. It must be empty before starting a new task.
   If it lists changes, finish and commit them on their existing task branch first.
2. Update the shared branch and create your task branch:

```bash
git switch team/bms-monitoring &&
git pull --ff-only origin team/bms-monitoring &&
read -rp "New task branch name: " TASK_BRANCH &&
git switch -c "$TASK_BRANCH"
```

3. Edit the files needed by the task. Agree shared schema, API, dependency, and
   deployment changes with the affected contributors before implementing them.
4. Run the relevant checks. For gateway work, run `npm run typecheck`,
   `npm run format:check`, and `npm test` when test files exist. No tests found is
   not evidence that a feature passed. For MPM, use its documented backend or
   frontend checks. Record the exact commands and results.
5. Inspect and select only the intended files:

```bash
git status --short
git diff --check
git diff
```

Press `q` to close a paged diff. Enter file paths shown by Git, without the
status letters, separated by spaces. These commands assume paths contain no spaces.

```bash
read -rp "Files/folders to include: " -a TASK_PATHS
git add -- "${TASK_PATHS[@]}"
git diff --cached --check
git diff --cached
```

The staged diff includes new files. Review it for secrets, generated data, and
unrelated changes. Then commit and push:

```bash
read -rp "Commit message: " TASK_MESSAGE
git commit -m "$TASK_MESSAGE" && git push -u origin HEAD
git status -sb
```

6. Open Pull requests > New pull request in the corresponding `hubertnshuti`
   fork. Select base `team/bms-monitoring` and compare your task branch.
   Describe the change, actual checks, screenshots for UI changes, and known
   limitations. Request review before merging.
7. After merge, start the next task from the updated shared branch, not the old
   task branch.

To bring teammates' merged changes into an unfinished task, first commit your
current edits, then run `git fetch origin && git merge origin/team/bms-monitoring`.
Resolve conflicts with the other contributor and rerun affected checks before
pushing. `git merge --abort` cancels an unfinished merge.

## Troubleshooting

| Problem                                                  | Next action                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm ci` reports a missing lockfile                      | Confirm repository, branch, and that tooling is merged; do not use `npm init` as a workaround                                              |
| Wrong Node version                                       | Run `nvm install && nvm use` from the gateway root                                                                                         |
| Formatting fails                                         | Format only the named files with `npx prettier --write path/to/file`, review the diff, then rerun the check                                |
| Git push reports permission denied                       | Run `gh auth status`, confirm the HTTPS origin and accepted collaboration invitation                                                       |
| Docker Server unavailable                                | Start Docker Desktop and enable integration for your Ubuntu distribution                                                                   |
| Image pull reports a credential-helper error             | Restart Docker Desktop and retry; if needed, quit Docker Desktop, run `wsl --shutdown` in PowerShell, reopen Docker and Ubuntu, and retry  |
| MPM build reports an invalid Composer installer checksum | Record the failing download. Check whether the reviewed Composer-image fix is included in the team MPM branch; do not disable verification |
| MPM is not ready                                         | Inspect the logs below. If MySQL becomes healthy after a slow first start, rerun `docker compose up -d --no-build`                         |
| Port or container-name conflict                          | Identify and stop the other local stack using it; do not delete its volumes                                                                |

Collect MPM startup evidence from its repository root:

```bash
docker compose ps -a
docker compose logs --tail=80 mysql backend-dev frontend-dev
```

Include your branch, commit, failed command, and relevant error when requesting
help. Remove credentials from output. Do not use `docker compose down -v`,
`migrate:fresh`, or `git reset --hard` as routine troubleshooting.
