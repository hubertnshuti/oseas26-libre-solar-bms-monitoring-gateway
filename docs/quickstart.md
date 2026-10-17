# Install and run the local demonstration

Run these commands from the gateway repository root in a Linux or WSL terminal.
Docker Engine/Desktop and Docker Compose must be running; Git, Bash and OpenSSL are the only host tools needed.
Use the VS Code browser if ordinary browser access to WSL localhost does not work.
Do not change firewall settings to follow this guide.

## Sources and configuration

For a new checkout, use the recursive clone command in the [README](../README.md).
For an existing checkout on this delivery branch:

```bash
git submodule update --init --recursive
git submodule status
bash deploy/demo.sh configure
```

Expected: MPM is at `ab3a466f90e25240ea83e9fdcdbcb36ef849a90f`; `.env` contains generated local secrets.
The configuration helper preserves an existing `.env`.
Do not use `git submodule update --remote`: that would select a moving revision instead of the recorded one.

Open `.env` locally and inspect `COMPOSE_PROJECT_NAME` and the four host ports before installation.
The defaults are project `libresolar-demo`, MPM backend `18080`, MPM frontend `18081`, Home Assistant `18123`, MQTT `1886`.
Choose unused values on a shared Docker host.
Check existing containers first:

```bash
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker compose config --quiet
```

Expected: configuration validation exits successfully without output.
No fixed container names are used; all named volumes belong to the selected Compose project.
Do not print full `docker compose config` output in shared logs because it includes secrets.
Keep `.env` and `.demo/` private and backed up; both are excluded from Git.

## First installation

Complete builds and downloads before rehearsal.
On a machine with about 3.5 GiB available to Docker, stop this demo’s application services before rebuilding the frontend; keep unrelated services untouched.
The measured production build took about 18 minutes under memory pressure, so first installation is not instantaneous.
The install command builds sequentially, installs locked backend dependencies, initializes an isolated database, enables the plugin, provisions the simulated node and starts the services.
It creates the standard MPM demonstration company with ID `1`; this is only appropriate for this new demo database.
It must not be pointed at another installation's database or volumes.

```bash
bash deploy/demo.sh install
```

Expected: each build/initialization command succeeds, then Compose reports healthy HTTP/database/broker services.
If a step fails, the script stops; inspect the error and retain its data for diagnosis.
The installer does not erase databases or volumes.
Initialization is explicit; ordinary startup never migrates or seeds.
Provisioning preserves an existing battery and reuses its existing active private key.
The adapter key is copied to `.demo/adapter.key` without printing it and is mounted read-only into the adapter.
Company identity is determined by that authenticated key, not by an HTTP payload field.

The frontend is built once as static files from the pinned MPM source, then served by Nginx.
Its browser API URL is set during the build.
After changing `MPM_BACKEND_PORT`, rebuild with `docker compose build frontend` before restarting it.
Internal connections use `mqtt:1883`, `backend:8000`, `mysql:3306` and `redis:6379`.
Do not substitute browser localhost URLs for those container addresses.

## First browser login

Open http://localhost:18081 for MPM, adjusting the port if configured differently.
The initialized account is MPM's published local demo administrator; its email and password are defined in `external/micropowermanager/src/backend/app/Utils/DemoCompany.php` as `DEMO_COMPANY_ADMIN_EMAIL` and `DEMO_COMPANY_PASSWORD`.
Use those values locally; do not include them in screenshots or presentation slides.
Open the Libre Solar BMS plugin and confirm node `53494D0000000001` is labeled as simulated.
The adapter API key is never used for browser login.

Open http://localhost:18123 for Home Assistant.
Create your own Home Assistant account through the first-run onboarding page.
Then choose **Settings → Devices & services → Add integration → MQTT**.
Enter broker `mqtt`, port `1883`, and the `MQTT_USERNAME` / `MQTT_PASSWORD` values from your private `.env`.
Leave discovery enabled.
These are supported manual steps; Compose does not create your HA account or configure the integration automatically.
See the [official MQTT setup instructions](https://www.home-assistant.io/integrations/mqtt/#configuration).

Open **Settings → Devices & services → MQTT → Devices → Libre Solar BMS (simulated) 53494D0000000001**.
Expected: measurement entities appear through discovery and update while the simulator runs.
Click a numeric entity to inspect its history; history starts when HA begins recording it.
All values in this device come from the simulator.

## Subsequent startup and safe shutdown

Use the same checkout, `.env` and project name:

```bash
docker compose up -d --wait --wait-timeout 300
docker compose ps
```

Expected: nine runtime services are running, with healthchecks passing where defined.
A running adapter process is not proof of successful delivery; confirm its accepted/duplicate logs and the battery observation time.

```bash
docker compose logs --tail=30 adapter simulator
docker compose stop
```

Stop preserves database, MQTT retained messages, simulator outbox and Home Assistant data.
The same startup command resumes them.
Do not use volume deletion as a routine troubleshooting step.
Do not change the project name to resume an existing installation: a new name selects different data.

## Troubleshooting

| Symptom                                                                 | Check and action                                                                                                                    |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Docker unavailable in WSL                                               | Open Docker Desktop and enable integration for the active distro.                                                                   |
| Port already allocated                                                  | Identify its owner with `docker ps`; choose an unused port rather than stopping unrelated services.                                 |
| Build or initialization fails                                           | Inspect the last failing command; do not continue to the next stage or reset data.                                                  |
| Service exits                                                           | Run `docker compose ps -a` and `docker compose logs --tail=80 SERVICE`.                                                             |
| Missing adapter key                                                     | Complete the explicit initialization/provisioning step; never put the key in frontend configuration.                                |
| Adapter `configuration_error` or `paused`                               | Check company key, enabled plugin, node and adapter binding; restart only after correcting configuration.                           |
| Adapter rejects initial attributes with HTTP409 after simulator restart | The new session metadata precedes its promoting summary; summaries still update, but metadata recovery is incomplete.               |
| MPM reports stale integration                                           | Current adapter does not send status heartbeats; check observation time and delivery logs separately.                               |
| HA has no battery                                                       | Confirm MQTT integration is connected to `mqtt:1883`; inspect simulator logs and restart only the simulator to republish discovery. |
| HTTP works but external browser times out                               | Use the working VS Code browser; this does not justify claiming external-browser compatibility.                                     |
| Exit 137                                                                | Inspect `docker inspect CONTAINER --format '{{.State.OOMKilled}}'` and memory use before diagnosing OOM.                            |

The inherited frontend default test command references a missing `setupTests.js`; the plugin has a separate documented test configuration.
Non-English battery strings currently use English placeholders.
The [delivery evidence](evidence/delivery.md) distinguishes live checks, automated tests and unverified browser steps.
