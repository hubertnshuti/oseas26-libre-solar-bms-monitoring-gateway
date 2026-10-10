# Contract fixtures v1

These examples are constructed software data, not hardware captures. The pinned
firmware is a mapping reference; raw ThingSet reporting precision and transport
fidelity are not claimed for these normalized payloads.

`valid/` covers normal, fault, cleared fault, missing values, unsupported fields,
unknown state, bit 31, a zero cell reading, summaries, event kinds, attributes,
source status and durable receipt shape. `invalid/` contains intentional type,
ID, date, version, bounds, quality, profile and transition errors. Do not use it
as ordinary simulator output. `manifest.json` lists every payload fixture.

`delivery-cases.json` defines duplicate, out-of-order and retained-old inputs with
expected future consumer outcomes. Local tests prove these inputs are valid
payloads; they do not claim to test an ordering engine, broker retention or
freshness timers. MQTT retained metadata belongs to the envelope/transport test,
not a new JSON field. Observation and publication timestamps remain unchanged.

`api/` contains proposed response examples. Their HTTP status and behavior are
documented in `docs/api-contract.md`. The backend has not been implemented or
tested by this fixture change.

MPM PHP tests must copy this entire versioned fixture directory and the schema
directory from one published gateway commit, record its full SHA and SHA-256
file checksums, and use the same valid/invalid cases plus semantic assertions.
Do not silently edit copies. Refresh from a reviewed gateway commit and record
new provenance whenever the agreement changes.
