# Message contract v1

Status: review draft. The JSON schemas, semantic validator and versioned examples
are implemented here. The simulator, broker, delivery queues and MPM endpoints
are separate work. Team approval and a working integration are not claimed.

## Files and validation

| File                                        | Purpose                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `lib/contract/schema/*.schema.json`         | Draft 2020-12 wire shapes; common definitions plus six message schemas |
| `lib/contract/fields.json`                  | Source object names, units and interpretation limits                   |
| `lib/contract/types.ts`                     | TypeScript payload interfaces                                          |
| `lib/contract/validate.ts`                  | Schema, topic, identity, quality, fault and profile checks             |
| `lib/contract/profiles/demo-lfp-4s-v1.json` | Proposed explicit simulator profile                                    |
| `tests/fixtures/v1/`                        | Shared valid, invalid, delivery and API examples                       |
| `docs/api-contract.md`                      | Proposed MPM HTTP agreement                                            |

Consumers call `parseMessage(kind, raw, { topic, profile })` at the wire boundary.
It returns `{ valid: true, payload }` or `{ valid: false, issues }`. Issues contain
paths and codes, not copies of the payload. Validate attributes before using them
as profile capabilities. The adapter must also check its configured node allowlist,
company binding and permitted producer/consumer identity.

```typescript
import { parseMessage } from "../lib/contract/index.js";

const result = parseMessage("telemetry", incomingBuffer, {
  topic: incomingTopic,
  profile: validatedCapabilities,
});
```

This is a call example, not a gateway entry point. `incomingBuffer`,
`incomingTopic` and `validatedCapabilities` are supplied by the caller.
The helper uses Node file APIs to load the local schema files; browser support
and standalone bundling are not included. Keep these JSON files with the module.

The default is strict: reject unknown top-level fields, schema versions other
than 1, numeric strings, non-finite numbers, bad dates and malformed IDs. No type
coercion, default insertion or unknown-field removal is enabled. All payloads are
limited to 32 KiB of UTF-8 bytes before parsing, arrays to 16 cells/3 battery
temperature sensors, masks to uint32 and counters to safe JavaScript integers.
Profile-aware validation additionally requires exact active array lengths.
There is no permissive additive-field mode in this draft. New v1 optional fields
require reviewed schema and fixture updates before producers use them.

## Topics and timing

Prefix: `libresolar/bms/v1/{node_id}`. `node_id` is exactly 16 uppercase
hexadecimal characters. It contains no company name, customer name or secret.

| Suffix         | Schema                                | QoS | Retained | Timing                                              |
| -------------- | ------------------------------------- | --- | -------- | --------------------------------------------------- |
| `telemetry`    | `telemetry`                           | 0   | No       | Every 1 second                                      |
| `summary`      | `summary`                             | 1   | Yes      | Every 60 seconds and meaningful changes             |
| `events`       | `event`                               | 1   | No       | Observed fault change or observation gap            |
| `attributes`   | `attributes`                          | 1   | Yes      | Startup and metadata changes                        |
| `availability` | None: plain `online` / `offline` text | 1   | Yes      | Connect, clean stop, last will                      |
| `receipts/mpm` | `event-receipt`                       | 1   | No       | After durable adapter storage, including duplicates |

`status` is an adapter-to-MPM HTTP payload, not a producer MQTT topic. The
validator can check a topic argument for status, but applications must not
interpret that helper behavior as defining another broker subscription.
Home Assistant discovery separately uses `homeassistant/device/{node_id}/config`.
The v1 topics are our normalized application contract, not ThingSet's own mapping.

Retained metadata and summaries provide last known data. They never establish
source freshness after adapter restart. Telemetry is never retained. MQTT QoS 1
can produce duplicates and a PUBACK does not prove application storage.

Defaults are project choices: source stale after **15 seconds** without new valid
telemetry; summary every **60 seconds**; status heartbeat every **60 seconds**;
integration stale after **150 seconds** without a recent trustworthy check.
A healthy source can have a 42-second-old displayed summary. The UI must show
measurement age separately rather than expiring the metric row at 15 seconds.
Freshness uses a local monotonic clock; observation/check timestamps use UTC.
Timing engines and injected-clock freshness tests belong to the adapter work.

## Identity, order and clocks

Producer JSON payloads (`telemetry`, `summary`, `event`, `attributes`) include
`schema_version`, `node_id`, `source`, `session_id`, `sequence`, `message_id`,
`observed_at`, `published_at` and `clock_source`. Source is `simulator` or
`hardware`. A simulator uses `simulator_host`; hardware uses `gateway_host` or
`device`. Times use exactly `YYYY-MM-DDTHH:mm:ss.sssZ` and real UTC calendar dates.

A producer session is a lowercase UUID generated at process start, retained
through MQTT reconnects. Its counter begins at zero and increases for every new
producer JSON message, across all four kinds. Counters are not reset by reconnect.
Retries keep the original payload, ID, sequence and timestamps unchanged.
Different message kinds have different state watermarks: receiving an event or
attributes must not cause a pending summary to be discarded.

Producer IDs use `{node_id}:{session_id}:{topic_suffix}:{sequence}`. Event
`event_id` equals its `message_id`, using `events` as the suffix. Summary and
event `telemetry_message_id` references a smaller sequence from the same node
and session. A summary retains that sample's `observed_at` as both
`observed_at` and `last_source_observed_at`; its first `published_at` can be later.
An event's `observed_at` records when the event was observed, without inventing
the historical fault start time. Publication cannot precede observation.

Receipt and status identities are deliberate exceptions to the producer envelope:

| Payload       | Identity                                          | Time/order                                                    |
| ------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| Event receipt | `{event_id}:receipt:{consumer_id}`                | Same receipt on retry; no new observation or producer counter |
| Source status | `{node_id}:{adapter_id}:status:{status_revision}` | Durable adapter revision; original `status_checked_at`        |

Both contain schema version, node ID, source and message ID. Receipt source is
copied from the stored event; status source comes from the configured battery
binding. `consumer_id` and `adapter_id` are 1–64 lowercase letters/digits/underscore/
hyphen, starting with a letter or digit. Validate against the configured identity;
syntax alone is insufficient. `status_revision` never substitutes for a battery
measurement sequence. See the API contract for session promotion and conflicts.

## Values, units and quality

Snapshot measurement fields are explicit even when unavailable. Missing/unsupported
scalars are `null` with a `quality` reason; never omitted or replaced by zero.
`quality` contains exceptions only. Permitted reasons are `unsupported`,
`not_reported`, `invalid_type`, `non_finite`, `incomplete` and `source_error`.
For a missing array entry, use its zero-based path, such as `cell_voltages[2]`.
Array positions remain intact. An optional whole-array `incomplete` reason is
valid only when that array contains a null. Quality paths must reference a field
in that snapshot; present scalar values cannot carry an exception.

SoH and cycles are always `null`/`unsupported` for the pinned firmware profile.
SoC is percent in [0,100] and is not a SoH estimate. Current is A, positive for
charging and negative for discharging. Voltage is V, temperature is degrees C.
See `fields.json` for the complete field/unit/raw-object mapping.

The pinned firmware binds `rPackVoltage_V` to `total_voltage` and
`rStackVoltage_V` to `external_voltage`, while its BQ769x2 driver fills those
members from STACK and PACK registers respectively. Preserve
`pack_voltage_reported` and `stack_voltage_reported`; terminal interpretation is
unresolved. Do not derive terminal power using a guessed rename.

`cell_voltage_delta` is max minus min of all configured valid cells. Any missing
cell makes it null/incomplete. Zero is a legitimate failure observation, not
padding to discard. Firmware min/average/max remain separate reported values.
`cell_temperature_max` covers configured battery sensors. Partial or empty
coverage makes it null/incomplete. `component_temperature_max` covers supported
IC/MOSFET/shunt sensors; unsupported components are excluded, but a missing
supported sensor makes the result incomplete. Compare derived decimals with a
tolerance, not exact binary floating-point subtraction.

BMS state codes 0–4 map to `OFF`, `CHG`, `DIS`, `NORMAL`, `SHUTDOWN`. Other uint8
codes map to `unknown`; null maps to null with quality. State describes allowed
directions, not proof that current is flowing.

The raw fault mask is uint32 or null. Known bits 0–14 use the pinned firmware
codes, unknown bits 15–31 become `unknown_bit_N`. `faults` is lexicographically
sorted, including unknown bits; null means unavailable, [] means known clear.
No severity classification is attributed to Libre Solar. Bit 31 is explicitly
tested as 2147483648, not a negative signed integer.

## Events and receipt meaning

| Kind              | Previous/current masks                                              | Added/cleared lists                                  |
| ----------------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| `fault_observed`  | Previous null; current known and nonzero                            | Added is the currently observed set; cleared empty   |
| `fault_changed`   | Both known and different, including recovery to zero                | Exact difference between decoded masks               |
| `observation_gap` | Previous null to represent broken continuity; current known or null | Both empty; do not invent transitions during the gap |

Unavailable masks cannot produce a clear event. Persistent unchanged faults do
not generate one event per telemetry packet. Event IDs and content are stable
across retries. A receipt with `status: stored` means the configured adapter
has committed the event to its durable queue. It does not mean MPM has accepted
it. Producers validate node/event/source/consumer identity before retiring their
durable outbox item. Queues, receipts and restart recovery are not implemented
by this contract change.

## Demo profile and review

`demo-lfp-4s-v1` proposes a simulated four-cell LFP battery, capacity 100 Ah,
logical-to-hardware cell channels [0,1,2,3], and two battery temperature sensors
on channels [0,1], all zero-based. It supports IC and MOSFET temperature; shunt
temperature, SoH and cycle count are unsupported. `source: simulator` remains
visible in every payload and MPM read example. The profile's thresholds,
recovery values and ±5 A scenarios are software demonstration values, not
recommended settings for any physical battery. They do not implement firmware
protection delays or establish hardware fidelity.

Before freeze, review [the decision record](decisions/0002-message-contract-v1.md):
member 2 confirms profile/channel/field/event choices, member 3 confirms API and
PHP validation, member 4 confirms read shapes and freshness labels. Freeze only
after recording their actual outcomes. Breaking units or meaning needs a new
major topic version; reviewed additive schema changes need updated fixtures.
