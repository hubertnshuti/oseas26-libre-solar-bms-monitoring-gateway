# 0001: Message contract v1

Date: 2026-10-10. Status: proposed; owner reviews pending.

## Basis and boundary

The supplied project reference v0.1, sections 6–8 and 10, is the requirements
basis. Firmware reference: `779d20199bff2666e01371ce2f562dcda4d6bda3`.
MPM research baseline: `8cabe6e3f2957b2274aff3fa09c48d3e5ec30533`.
Gateway starting team commit: `fb2428088225a5c45719d75ad66e0e00c49c64ed`.
Pinned source mappings are distinct from our proposed message names, timing,
routes, limits and demo thresholds.

Use Draft 2020-12 schemas, strict Ajv 8.20.0 and ajv-formats 3.0.1 without
coercion. The official [Ajv schema guide](https://ajv.js.org/json-schema.html)
documents the separate 2020-12 class; the
[formats documentation](https://ajv.js.org/packages/ajv-formats.html) describes
format validation. Semantic checks supplement schemas for identity, null/quality,
decoded masks, profile layout and derived values. The runtime dependencies are
exact versions and included in package-lock.json.

This change establishes reviewable contracts and tests. It does not implement a
simulator, API, MQTT delivery, durable queues or source-freshness engine.
Do not mark the boundary agreed merely because these files pass local tests.

## Pending owner decisions

| Question                                                                | Reviewer/owner                      | Existing fallback in this draft                                        |
| ----------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------- |
| Is the four-cell LFP/100 Ah/two-sensor profile and mapping suitable?    | Simulator/publisher owner           | Explicit constructed profile; no hardware wiring claim                 |
| Are demo thresholds and unavailable-value rules usable?                 | Simulator/publisher owner           | Values remain labeled demo-only; preserve null and quality             |
| Are receipt and event shapes implementable with the durable outbox?     | Publisher and adapter owners        | Application receipt only after durable adapter storage                 |
| Are routes/header, provisioning, limits and response outcomes suitable? | MPM backend owner                   | Proposed company-key boundary; fail closed for unknown batteries       |
| Can PHP assert Draft 2020-12 formats and semantic rules?                | MPM backend owner                   | Select/review validator; same versioned fixtures with source SHA       |
| Are session promotion limits and reconciliation suitable?               | Adapter and backend owners          | Keep current state and expose conflict when ordering cannot be trusted |
| Are the list/detail/event examples and freshness labels clear?          | MPM screens owner                   | Separate measurement age, source status and integration age            |
| May SoH/cycles remain unavailable?                                      | Challenge owner                     | Explicit null/unsupported, never an invented estimate                  |
| Should the battery be standalone or linked to an existing device?       | Challenge owner and MPM owners      | Battery list/detail; ownership link only through provisioning          |
| How should pack/stack voltage ambiguity be resolved?                    | Challenge owner/firmware maintainer | Preserve reported names/values; no terminal power estimate             |
| Is a separate official MPM PR required?                                 | Challenge owner                     | Pending; published fork with exact submodule remains planned           |

## Freeze procedure

All three component reviewers examine schemas, fixture paths, profile and API
examples. Record actual review dates and resolutions here, then change the status
to accepted for the first slice. No reviews have been recorded yet. Record any
remaining owner question explicitly, with its agreed fallback. Later semantic or
unit changes require a reviewed decision and fixture updates; a breaking change
requires a new major topic version.
