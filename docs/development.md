# Gateway development

Use the Node version recorded in `.nvmrc`.

Install the recorded dependencies with `npm ci`.
Run `npm run typecheck` and `npm run format:check` before submitting changes.
Run `npm test` when contract tests have been added.

This initial setup checks the TypeScript configuration. Application code
and contract tests will be added in subsequent changes. An empty test
suite is not counted as a successful test run.

Gateway tooling starts from team commit `aedc513`.
The MPM research baseline is `8cabe6e3f2957b2274aff3fa09c48d3e5ec30533`.
MPM PHP and Vue development remains in the separate MPM repository.

Create task branches from the latest `team/bms-monitoring` branch.
Submit internal pull requests back to that branch.
