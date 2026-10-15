# Five-minute demonstration

All displayed readings in this demonstration are simulated.
Use the live sequence only after completing the checks below.

## Before the presentation

From the gateway root, after first installation and Home Assistant onboarding:

```bash
docker compose up -d --wait --wait-timeout 300
bash deploy/demo.sh scenario normal-cycle
docker compose ps
docker compose logs --tail=20 adapter
```

Expected: all runtime services are running and the adapter reports accepted or duplicate messages for node `53494D0000000001`.
Wait at least one minute for the first low-frequency summary and browser refresh.
Keep builds and image downloads out of the presentation.

Open and sign in to these tabs in the working VS Code browser:

1. Home Assistant at http://localhost:18123: **Settings → Devices & services → MQTT → Devices → Libre Solar BMS (simulated) 53494D0000000001**.
2. MPM at http://localhost:18081: **Libre Solar BMS → battery list → Demo battery** (or the provisioned label).
3. The Gateway README and its setup guide.
4. A terminal in the gateway root with the fault command ready.

Confirm that a HA measurement changes, a graph contains recorded history, and MPM shows the same node and recent summary observation time.
SoH and cycle count must be unavailable, not zero.
Check that the screen visibly identifies the source as simulated.
MPM integration freshness may remain stale because adapter status delivery is unfinished; explain it rather than hiding the label.

Practice the fault command once:

```bash
bash deploy/demo.sh scenario cell-overvoltage
```

Keep HA’s Active Faults/Problem Status visible when running the command.
The scenario raises the fault about two seconds after starting and clears it at eight seconds.
Then refresh MPM history to show the stored fault and clear events; its 60-second automatic refresh can miss the brief active state.
Then restore normal readings:

```bash
bash deploy/demo.sh scenario normal-cycle
```

Scenario changes restart only the simulator while preserving its event outbox.
A new simulator session may begin with a fault observation; do not describe that as a precisely observed fault-start transition.
Routine summaries arrive every 60 seconds; fault changes trigger immediate summaries.
Use the screen’s Refresh action for event history.

Capture actual normal and fault screenshots from both tabs before the pitch, excluding credentials and personal information.
Record capture time and source commit beside the images.
No screenshot is supplied or claimed until captured from the running applications.
Use these captures as an explicitly recorded fallback if live services fail.

## During the five minutes

| Time      | Action                                                                                      | What to say                                                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:30 | Show the architecture in the README.                                                        | “Mini-grid operators need to understand battery conditions and faults. We send one simulated battery feed to two existing tools: detailed live monitoring in Home Assistant and operational summaries in MicroPowerManager.” |
| 0:30–1:00 | Show `docker compose ps` and the documented startup command.                                | “Compose starts the prepared services together. First installation builds and initializes them; subsequent startup reuses those images and saved data.”                                                                      |
| 1:00–2:00 | Show HA device, changing measurement and its History graph.                                 | “The simulator announces the device and its sensors through MQTT discovery. Home Assistant receives the readings and records their history.”                                                                                 |
| 2:00–3:00 | Show the same node in MPM, its timestamp, unsupported values and event list.                | “The adapter sends lower-frequency summaries and fault events into the operator's existing MPM account. We preserve unavailable values and original observation times.”                                                      |
| 3:00–4:00 | Run `bash deploy/demo.sh scenario cell-overvoltage`; show HA fault and refresh MPM history. | “This is a simulated cell-overvoltage condition. Both applications consume the same source. The event records what was observed and when.”                                                                                   |
| 4:00–5:00 | Show recursive clone/setup and the verification record.                                     | “The repository pins our merged MPM version and documents installation. We have kept authentication and company isolation. Hardware validation, durable adapter delivery and freshness heartbeats remain limitations.”       |

If the fault does not arrive within the rehearsed interval, show the previously captured fault evidence, identify it as recorded, and continue.
Do not troubleshoot infrastructure during the five minutes or present a fixture preview as a live integration.
If a step has not passed the verification record, omit its success claim.

### Terms in ordinary language

- **Docker Compose:** one configuration that starts the cooperating services and connects them.
- **MQTT broker:** the message exchange that distributes a battery feed to subscribed applications.
- **Adapter:** the translator/delivery service that validates MQTT messages and sends appropriate summaries and events to MPM.
- **Home Assistant discovery:** the battery announces its sensors so the application creates the device without manually defining each sensor.
- **MPM:** the existing mini-grid management application where an authorized operator sees battery summaries and fault history.

### Questions to prepare for

**Is this real hardware?** No; the current demonstration is a simulator using a documented Libre Solar field mapping.

**Why two applications?** Home Assistant shows live measurements and history; MPM connects battery information to the operator's existing management workflow.

**What happens during outages?** The simulator retains unacknowledged events and MPM recognizes identical event identities, but the adapter has no durable retry queue or receipts yet.
We do not claim complete fault recovery during outages.

**Is it upstream?** The plugin is merged in our team's MPM integration branch; upstream review/acceptance is separate.

**What would you finish next?** Durable adapter delivery, status heartbeats, broader failure/recovery checks and real hardware validation.
