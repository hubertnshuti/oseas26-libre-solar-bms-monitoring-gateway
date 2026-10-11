# MPM battery API contract v1

Status: proposed interface for backend and adapter review. These routes and
database behavior are not implemented by the gateway contract branch. Examples
live in `tests/fixtures/v1/api/`; write payloads use the matching schemas and
`valid/` fixtures. The MPM backend must implement and test every agreed rule.

## Ownership and authentication

The adapter has one company binding and node allowlist. Send
`Authorization: Bearer <company-api-key>`, `Content-Type: application/json` and
`Accept: application/json`. Resolve the tenant exclusively from the validated
company API key, never a payload company ID. Register the ingestion prefix with
`ThirdPartyApiResolverService` and a company-key resolver using MPM's existing
pattern. Adding `auth:api-key` alone does not establish correct tenant resolution.
Member 3 must confirm this header and route wiring against the actual fork.

Ingestion requires the plugin to be enabled, a provisioned battery-to-node link
in that tenant, and an allowed adapter identity for status. Attributes update
metadata only: they cannot create batteries, change ownership or link customers.
Provisioning is an authenticated operator/administrative operation outside these
ingest endpoints; its command and permissions must be implemented by the plugin
owner. Two companies may use the same node string and still own distinct records.
Do not expose battery data across tenants. Read endpoints use existing MPM user
authentication and permissions, not ingestion company keys or sidebar visibility.

## Routes and bodies

Every POST accepts **one object**, directly as the body, not `{data: ...}` or a
batch. UTF-8 JSON has a 32 KiB maximum, checked before decoding; unknown fields
are rejected. Apply the same v1 schemas and semantic rules as the gateway.
Validate finite numbers, exact types, timestamps, array/profile limits and IDs.
Request examples are fixed software fixtures, not production credentials.

| Method and path                                  | Body/example                 | Effect                                                  |
| ------------------------------------------------ | ---------------------------- | ------------------------------------------------------- |
| POST `/api/libre-solar-bms/ingest/summaries`     | `valid/normal.summary.json`  | Update current metrics without a per-cell history table |
| POST `/api/libre-solar-bms/ingest/events`        | `valid/fault.event.json`     | Append one observed event                               |
| POST `/api/libre-solar-bms/ingest/attributes`    | `valid/demo.attributes.json` | Update metadata of the provisioned battery              |
| POST `/api/libre-solar-bms/ingest/status`        | `valid/fresh.status.json`    | Update independent source status/check watermark        |
| GET `/api/libre-solar-bms/batteries`             | `api/battery-list.json`      | Company-authorized list                                 |
| GET `/api/libre-solar-bms/batteries/{id}`        | `api/battery-detail.json`    | Current metrics, metadata and status                    |
| GET `/api/libre-solar-bms/batteries/{id}/events` | `api/event-list.json`        | Authorized event history                                |

`{id}` is a positive internal MPM battery ID, separate from `node_id`. Summary
does not contain per-cell arrays. Detail returns the versioned summary, attributes
and status objects unchanged under `data`, plus backend receipt/check information.
List returns selected labels and current metrics. Read responses use `source` to
label simulation and preserve unsupported SoH/cycle count as null.

Collections accept integer `page` (default 1, minimum 1) and `per_page` (default
25, range 1–100). Invalid query values return 422. Return `data` and `pagination`
with page/per_page/total/last_page; an empty collection has `data: []`, total 0,
last_page 1. Battery lists sort by internal ID ascending. Event history sorts by
observed time descending, then internal ID descending for stable ties. It is
page-based browsing, not a guaranteed immutable snapshot under concurrent inserts.

## Responses and retries

Successful POSTs return HTTP 200 with stable outcome and input `message_id`:

```json
{
  "result": "accepted",
  "message_id": "53494D0000000001:15f75ec4-29ab-48ab-93be-81d3e0708a68:summary:121"
}
```

Identical replay returns `result: duplicate`; valid older current-state data
returns `result: ignored_stale` with a reason such as `superseded_sequence` or
`superseded_session`. Neither outcome is retried. A stale snapshot must not replace
current state or refresh freshness. Successful event `accepted`/`duplicate`
allows its adapter queue entry to be retired. Never infer success from an empty
response, malformed body or an unrecognized result.

| HTTP    | Body code/result                                              | Adapter behavior                                              |
| ------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| 200     | `accepted`, `duplicate`, `ignored_stale`                      | Acknowledge validated response for the matching ID            |
| 401     | `invalid_credentials`                                         | Visible configuration failure; pause delivery until corrected |
| 403     | `plugin_disabled`, `forbidden_adapter`, `forbidden`           | Visible configuration/authorization failure                   |
| 404     | `battery_not_provisioned`, `not_found`                        | Quarantine ingest; reads disclose no other company's record   |
| 409     | `id_conflict`, `session_conflict`, `status_revision_conflict` | Quarantine; require reconciliation                            |
| 413     | `payload_too_large`                                           | Quarantine                                                    |
| 415     | `unsupported_media_type`                                      | Configuration/payload failure                                 |
| 422     | `invalid_payload`, `invalid_pagination`                       | Quarantine ingest; field paths and reason codes               |
| 429     | `rate_limited`                                                | Retry with bounded backoff/jitter; honor `Retry-After`        |
| 500–599 | `server_error` where possible                                 | Retry with bounded backoff/jitter                             |

Error bodies use `{"result":"rejected","code":"..."}` with `message_id`
when it was safely parsed. A 422 may include `errors: [{path, code}]`. Do not
echo credentials or whole rejected payloads. Handle HTTP errors even when a proxy
returns HTML. Network failures and lost responses are retried with unchanged
payloads. Semantic duplicate comparison ignores object-key order and JSON number
spelling (5 and 5.0), preserves array order, and includes all supplied fields,
including first publication time. The PHP and TypeScript sides must agree before
introducing a content hash. No wire hash algorithm is defined in this draft.

## Ordering, duplicates and sessions

Deduplicate within tenant and node by message ID; the same ID and same normalized
JSON is a duplicate, different content is 409. Events use their `event_id` and
must retain a unique database constraint. Transactions protect checking the
watermark, deduplication and applying effects under simultaneous retries.

Maintain separate current-state watermarks for summaries and attributes. Within
one producer session, a lower sequence is ignored as stale; the same sequence
with conflicting content is 409. A higher sequence must not regress observation
time. The producer's global sequence does not let an attributes/event request
advance the summary watermark. Event history accepts valid previously unseen
older events, including superseded-session events, without overwriting current
metrics; event arrival order is not the current-state order.

The first authenticated session may establish last known state even if its
observation is old, but must be labeled old and cannot imply source freshness.
Promotion to a different session requires a plausible observation newer than the
current snapshot and within a proposed 150-second receipt-age window, with at
most 5 seconds future clock skew. Record the session transition and retire the
previous session. Delayed retired-session snapshots are ignored. Unknown sessions
that cannot meet these conditions yield `session_conflict` rather than guessed
UUID ordering. Promotion locks/checks shared node session state atomically;
metadata alone cannot authenticate a live new session. These clock limits and
the provisioning/reconciliation mechanism require member 3's review. Until a
safe promotion can be proven, retain current data and expose the conflict.

## Status ordering and freshness

Status contains its own `adapter_id`, durable safe-integer `status_revision`,
`message_id`, `source_status`, `last_source_observed_at` and `status_checked_at`.
It never contains measurement `sequence` or metrics. Accept revisions only from
the provisioned adapter identity; changing the adapter requires explicit binding
and counter reconciliation. Lower revisions are ignored; equal identical content
is a duplicate; equal conflicting content is 409. Higher revisions cannot regress
check time. Persist this watermark across backend and adapter restarts.

`source_status` is `unknown`, `fresh`, `stale` or `disconnected`. Fresh requires
a non-null source observation. The original check and observation times never
change on retries. The backend separately records `status_received_at`. A delayed
old check does not become recent just because its HTTP delivery arrives now.

Derive integration freshness from the accepted original check time, after skew
validation; receipt time can show delivery lag. If no trustworthy check exists or
its age reaches 150 seconds, expose `integration_status: stale` and “No recent
integration update.” A recent check gives `integration_status: recent`; its source
status can still be stale/disconnected. Heartbeats are every 60 seconds, with
prompt status changes after 15 seconds of source silence or a disconnect.
An adapter restarts at unknown until genuinely new telemetry is observed.

Example: a summary measured 42 seconds ago plus a recent `source_status: fresh`
check shows “Battery online; displayed summary measured 42 seconds ago.” It must
not say disconnected because a 60-second metric row exceeded 15 seconds.
After adapter death, the UI independently ages the last check; no new status
write is needed to show stale integration. These timing behaviors need backend
and adapter tests using controlled clocks, not just schema fixture validation.

## PHP fixture synchronization and review

Copy `lib/contract/schema/` and `tests/fixtures/v1/` from one **published gateway
commit**. Record its full SHA and SHA-256 checksums of copied files in the MPM
test fixture provenance. Run the same valid/invalid cases in PHP; port semantic
rules as well as the schemas. Confirm that the selected PHP validator supports
Draft 2020-12 and asserts formats. Do not maintain independently edited payloads.
Updating a PHP copy requires a reviewed gateway commit and new provenance.

Member 3 must prove tenant isolation with two companies sharing the same node
string, route resolver behavior, provisioning, concurrent duplicates/conflicts,
ordering and status-check ageing. Member 4 reviews read examples and wording.
The pending decisions and fallbacks are in
[the contract decision record](decisions/0002-message-contract-v1.md).
