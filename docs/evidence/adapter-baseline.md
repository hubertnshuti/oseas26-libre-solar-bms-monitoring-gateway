# MQTT-to-MPM adapter verification

Historical checks performed on 12 October 2026 for the initial adapter implementation.
The working branch was based on gateway `0373de9062c6d905424aa1c97d947739eac72f3b`; implementation changes were present during testing.
Runtime: Node `24.21.0`, npm `11.19.0`.

## Automated checks

| Check                         | Recorded result                    |
| ----------------------------- | ---------------------------------- |
| Clean dependency installation | Passed, 90 packages installed      |
| `npm run typecheck`           | Passed                             |
| `npm run format:check`        | Passed                             |
| `npm test`                    | 151 tests across four files passed |
| `git diff --check`            | Passed                             |

HTTP tests use a local fake MPM server and preserve request bodies, identities, authentication headers, and observation times.
They cover invalid input, node binding, malformed responses, redirects, timeouts, configuration failures, permanent/transient outcomes, and bounded pending work.
The executable test uses a limited MQTT protocol peer; it is separate from real-broker verification.
Local socket access is required by these tests.

## Real-broker verification

Command from the gateway root:

```bash
npm run test:mpm-ingest:broker
```

The recorded run used Eclipse Mosquitto `2.1.2`, pinned to digest `sha256:38c0da4f2ef84284d47b3b3eeea1cb3bdeabe81ee10caf0cd5c5ff61ee3ea408`.
The harness creates its own authenticated broker, node-scoped ACL, temporary credentials, and fake MPM HTTP destination.

All eight checks passed, with exactly two summary HTTP writes:

- Wrong broker credentials were rejected.
- Retained summary delivery preserved payload identity and original source times.
- Twenty telemetry packets, malformed/type-invalid summaries, and an unbound topic added no HTTP writes.
- After broker restart, the adapter reconnected, resubscribed, and delivered another summary.
- Shutdown was clean; captured logs contained neither the test password nor the company key.

The harness uses a fixed available loopback port because a random published port can change on broker restart.
It removes only its own container and temporary files.

## Scope

These checks establish adapter validation and broker-to-HTTP delivery against a test destination.
They do not prove MPM storage, company isolation, durable retries, or receipts.
Later actual MPM integration is recorded in [delivery verification](delivery.md) and [the API capture](delivery-api.json).
