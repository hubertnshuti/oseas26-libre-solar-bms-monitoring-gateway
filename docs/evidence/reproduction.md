# Battery view verification and clean-clone preflight

Recorded on 15 October 2026 by Lucide.
The implementation and its automated checks are delivered; the record below distinguishes them from a clean full-stack installation.

## Sources

| Source              | Revision and result                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| Clean Gateway clone | `027188253f7496f11c1b74e1b0112db9124b7feb`, published `team/bms-monitoring`.                       |
| Layout proposal     | `6e22d5a`, now included through Gateway PR #12 at the clean-clone revision.                        |
| MPM backend         | `677e189f`, published integration baseline with plugin, ingestion, events/status and provisioning. |
| MPM frontend        | `2958b324`, committed on `feat/battery-view-layout`; team-fork push denied to Lucide-Pascale.      |

The frontend branch must be published before an outside reviewer can obtain the complete view.
No upstream merge, stakeholder approval or passing CI is inferred from these local results.

## Environment and isolation

The verification host is Ubuntu 26.04 LTS under WSL, with approximately 3.5 GiB memory available to the environment and 1 GiB swap.
Gateway checks used Node 24.21.0 / npm 11.19.0.
MPM host checks used Lucide's nvm Node 20.18.0; its frontend container reported Node 20.18.3 from the pinned 20.18 Alpine image.
Docker Engine reported 29.4.1 and Compose v5.1.3.
These measurements describe this machine, not a minimum-resource guarantee.

Initial frontend work reused the existing `mpm-bms-review` backend, MySQL, Redis and Horizon.
After an external Docker restart, those same containers were resumed without migrations, seeding or replacement volumes.
Lucide's frontend used a separate project/container/node_modules volume and host port 8001, with backend port 18000.
Only Lucide's frontend compiler was stopped for production builds and restored afterward.
The private development wrapper is not a final full-stack packaging solution; the public MPM frontend guide contains a portable frontend-only Docker example.

A resource snapshot after compilation showed approximately 972 MiB for the frontend, 80 MiB backend, 438 MiB Horizon, 10 MiB Redis and 204 MiB MySQL.
Heavy checks ran sequentially.
The default parallel production build passed but took 258 seconds and nearly exhausted swap.
A temporary `parallel:false` configuration reduced the final build to 87 seconds without stopping shared workers.

## Completed checks

Commands below ran from the MPM checkout's `src/frontend` directory using its pinned runtime.

```sh
node node_modules/jest/bin/jest.js --runInBand --config jest.battery.config.js
node node_modules/eslint/bin/eslint.js --no-fix src/plugins/libre-solar-bms src/__tests__/BatteryOverview.test.js src/__tests__/BatteryPresentation.test.js src/__tests__/BatteryService.test.js jest.battery.config.js scripts/testing/vueScriptTransformer.js src/ExportedRoutes.js
node node_modules/prettier/bin/prettier.cjs --check src/plugins/libre-solar-bms src/__tests__/Battery*.test.js jest.battery.config.js scripts/testing/vueScriptTransformer.js src/ExportedRoutes.js src/assets/locales/*.json
npm run i18n:check-json
```

Observed: 79 tests passed in three suites; scoped lint, formatting and all-locale key/sorting checks passed.
The tests cover zero/null, unknown faults, original-check aging at 150 seconds, malformed API responses, permission/network failures, pagination envelopes, navigation races, polling overlap, timer cleanup and the generated setup event.
Component tests use real Vue instances to exercise scripts, without mounting/rendering templates.
Package and lockfiles were unchanged.
The stock `npm test` command fails before running tests because its existing configuration references absent `setupTests.js`; that baseline failure remains reported.

The final production build used the exact temporary worker-limited command documented in the MPM frontend guide.
Observed: successful compilation in 87 seconds, build hash `7440a7176295a9c0`.
The production JavaScript did not contain the fixture node ID or fixture provider failure text, and did contain the setup-completion hook.
Sass deprecation and old browser-metadata warnings remain; dependencies were not changed merely to silence them.
A first temporary configuration failed before compilation because Vue CLI expected a nearby package file; the corrected temporary directory passed.
The Docker development compiler also passed after final source changes, and the running component hash matched the edited host file.

Actual signed-in API login/list/detail/history reads were checked without printing or saving tokens.
The new frontend service accepted one battery with `source: simulator`, stale integration and two recorded events.
This checks compatibility with actual stored data, not a newly generated MQTT transition or browser rendering.
Health returned HTTP 200 and CORS preflight returned HTTP 204 for the frontend origin.

## Browser evidence

Windows and WSL curl both returned frontend HTTP 200.
Dedicated automated Edge 155 navigation timed out for both localhost and IPv4; a test-only request-forwarding attempt also timed out.
The user reports using the VS Code browser successfully; further Windows browser troubleshooting was stopped at the user's direction.
No automated browser login, screenshots or rendered-state acceptance is claimed here.
No browser/firewall protection was disabled.
The frontend guide supplies exact normal/fault/unknown/zero/stale/error/forbidden preview URLs and manual keyboard, zoom, narrow-screen and network-retry steps.
Capture those actual screens through the working browser, labeling fixture previews explicitly.

## Clean-clone attempt

A separate source clone was created from the published team repository, without copying the working checkout or changing any data stack.
From a Linux terminal:

```sh
git clone --branch team/bms-monitoring --recurse-submodules \
  git@github.com:hubertnshuti/oseas26-libre-solar-bms-monitoring-gateway.git \
  /tmp/lucide-d06-gateway-reproduction
git -C /tmp/lucide-d06-gateway-reproduction rev-parse HEAD
git -C /tmp/lucide-d06-gateway-reproduction status --short
git -C /tmp/lucide-d06-gateway-reproduction submodule status
git -C /tmp/lucide-d06-gateway-reproduction ls-files external deploy .gitmodules
```

The destination was unused when executed; choose another unused destination when reproducing.
Observed: clone succeeded at `027188253f7496f11c1b74e1b0112db9124b7feb`, clean status, no submodule output and no tracked `.gitmodules`.
The only tracked packaging entries were `external/README.md`, `deploy/README.md` and `deploy/mpm-ingest.env.example`.
There was no pinned MPM source or combined deployment to continue from.
The new frontend revision was also unavailable from the team remote because its push was denied.
The attempt therefore stopped before database initialization.
No clean full-stack installation, fresh data volume or independent end-to-end demonstration is claimed.

## Remaining acceptance and ownership

| Requirement                                           | Current result                                                   | Exact next action                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Obtain frontend from published source                 | Blocked by MPM write permission.                                 | Publish `2958b324`, then create the internal MPM PR.                                               |
| Fresh clone selects compatible MPM                    | No submodule/pin.                                                | Integration maintainer pins the published compatible MPM commit.                                   |
| One documented full-stack startup                     | Component guides only.                                           | Integration maintainer publishes combined Docker packaging, then rerun from fresh isolated data.   |
| Real source silence/disconnect/adapter-stop freshness | UI logic tested; adapter status delivery absent.                 | Implement real status delivery and run the documented simulator scenarios.                         |
| Durable lost-response retry and event receipts        | Adapter queue/retry/receipts absent.                             | Implement and verify those integration behaviors; retain producer pending events meanwhile.        |
| Browser screens/usability                             | Manual VS Code browser path available; screenshots not captured. | Capture normal/fault/unknown/stale/error and record keyboard/zoom/narrow-screen results.           |
| Independent clean demonstration                       | Not completed.                                                   | Follow only published instructions after packaging is ready; keep the working installation intact. |

Use the [quickstart](../quickstart.md) and [troubleshooting guide](../troubleshooting.md) for the current run paths and failure diagnostics.
The simulated path is not evidence of physical hardware validation or production readiness.
