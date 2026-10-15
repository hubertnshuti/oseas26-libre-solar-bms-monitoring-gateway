# Battery demo troubleshooting

Start with the repository/revision, exact failing command and the affected service.
Use the [quickstart](quickstart.md) to distinguish shared development from a fresh isolated installation.
Preserve existing volumes, credentials and another person's processes.

| Symptom                                     | Safe check                                                                                                  | Next action                                                                                                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MPM frontend branch not visible             | In MPM run `git log -1 --oneline` and `git ls-remote --heads origin feat/battery-view-layout`.              | Commit `2958b324` exists locally; its push was denied to Lucide-Pascale. Accept the team repository invitation or grant write access, then push the existing branch.    |
| Layout branch missing in MPM                | Inspect the repository name.                                                                                | `docs/battery-view-plan` is in the Gateway fork, commit `6e22d5a`.                                                                                                      |
| No Docker CLI/server after restart          | Run `docker version` and `docker compose version`.                                                          | Open Docker Desktop and verify WSL integration. Inspect existing stopped containers before resuming only known required services. Do not install another Docker engine. |
| Port 8001 is busy                           | Run `docker ps --format 'table {{.Names}}\t{{.Ports}}'`.                                                    | Confirm the owner; use a distinct frontend project/container/volume. Only stop an explicitly authorized frontend.                                                       |
| HTTP succeeds but Windows browser times out | Record both the curl result and exact browser error.                                                        | Use the working VS Code browser for review. Do not disable firewall/browser protections or repeat setup loops. Successful HTML is not login evidence.                   |
| Requests use backend port 8000              | Inspect the effective frontend Compose environment and browser Network panel.                               | Set supported `MPM_BACKEND_URL` to the actual browser-reachable backend, then recreate only that frontend.                                                              |
| Login request fails                         | Inspect its HTTP status and CORS preflight, without copying tokens.                                         | Use the correct account/backend and allow the actual frontend origin through backend configuration. Do not place a company key in the browser.                          |
| Battery reads return 403                    | Inspect response code `plugin_disabled` versus `forbidden`.                                                 | Enable the plugin for that authenticated company or grant `libre-solar-bms.view` through authorized roles. Sidebar visibility alone is not permission.                  |
| Battery list is empty                       | Check the signed-in account's tenant and authorized provisioning output.                                    | Provision the correct company/node explicitly; do not seed or reset a shared database.                                                                                  |
| Ingestion returns 401/403/404               | Check key validity, plugin state, adapter binding and provisioned node against published guides.            | Correct the specific binding; never add caller-supplied company ownership or switch to a user token for ingestion.                                                      |
| Integration remains stale                   | Inspect original `status.status_checked_at`, separately from summary/receipt times.                         | Current adapter lacks status delivery; integration work must supply accepted original checks. Do not infer freshness from a recent summary.                             |
| Summary is 42 seconds old                   | Inspect the separate source check and 60-second summary cadence.                                            | This alone is not disconnect evidence; source timeout belongs to the adapter.                                                                                           |
| MQTT works on host but HA has no entities   | Confirm HA's MQTT endpoint, credentials and active discovery-capable simulator.                             | Use a hostname reachable from the HA container; do not substitute its own loopback for the broker. Complete HA onboarding.                                              |
| Events remain in simulator outbox           | Inspect adapter receipt capability.                                                                         | Current adapter does not publish stored receipts. Retain pending events; broker acknowledgement does not prove MPM storage.                                             |
| `npm test` fails before MPM tests           | Read the missing setupTests.js validation error.                                                            | Run the documented dedicated battery Jest config; retain the baseline failure in reports. Do not claim the whole suite passed.                                          |
| Build is slow or exits 137                  | Stop only your dev compiler, inspect `docker stats --no-stream` and the exited container's OOMKilled state. | Run heavy checks sequentially; use the documented worker-limited build. Exit 137 alone does not prove OOM.                                                              |
| New clone lacks full demo                   | Inspect `.gitmodules`, `external/` and deployment files.                                                    | Pin/publish compatible MPM source and finish combined packaging; component tests are not a clean end-to-end installation.                                               |

For current runtime inspection from the MPM root, use only read-only diagnostics:

```sh
git status --short
git log -1 --oneline
docker ps -a --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}'
docker stats --no-stream
```

Expect these to identify the selected revision and actual container/port/resource state.
Inspect logs only for the identified service and remove secrets or customer data before sharing output.
Never use `down -v`, `migrate:fresh`, forced Git resets or an unqualified shared-machine Compose startup as troubleshooting shortcuts.
