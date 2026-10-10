# Contract validation evidence

Date: 2026-10-10. Starting gateway commit:
`fb2428088225a5c45719d75ad66e0e00c49c64ed`. Branch: `feat/message-contract`.

Verified in an isolated Linux development workspace with Node **24.21.0**,
npm **11.9.0**, Ajv **8.20.0**, ajv-formats **3.0.1** and Vitest **5.0.3**:

| Check                  | Result                                  |
| ---------------------- | --------------------------------------- |
| `npm ci`               | Clean dependency installation succeeded |
| `npm run typecheck`    | Passed                                  |
| `npm run format:check` | Passed                                  |
| `npm test`             | 1 test file, 99 tests passed            |
| `git diff --check`     | Passed                                  |

The test suite covers the six JSON message kinds, valid/invalid fixture files,
null/quality and profile rules, finite numbers, byte/array limits, identifiers,
calendar dates, reported versus derived aggregates, every fault bit including
bit 31, event transitions and topic-node consistency. API detail examples use
the same nested payloads. Delivery-case tests check input validity only.

Not verified here: Hubert's WSL setup, component-owner agreement, PHP validation,
MPM HTTP endpoints, MQTT publishing/retention, durable queues, delivery ordering,
freshness timers, Home Assistant, physical hardware or a battery integration.
Record the eventual published contract commit and actual team review outcomes
when they exist; they are not inferred from these local checks.
