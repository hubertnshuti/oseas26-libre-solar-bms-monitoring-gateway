import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const gateway = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backend = resolve(
  process.env.BMS_TEST_BACKEND ??
    join(gateway, "external/micropowermanager/src/backend"),
);
assert(
  existsSync(join(backend, "vendor/autoload.php")),
  "Install the pinned MPM backend dependencies before this check",
);
assert(
  existsSync(join(backend, ".env.testing")),
  "MPM .env.testing is required; no demonstration database is used",
);
await mkdir(join(gateway, ".local"), { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "bms-real-recovery-"));
const statePath = join(directory, "tenant.json");
const helper = join(gateway, "scripts/testing/mpm-recovery.php");
const environment = {
  ...process.env,
  APP_ENV: "testing",
  BMS_TEST_BACKEND: backend,
  BMS_TEST_STATE: statePath,
};
let php;
let output = "";

async function command(mode) {
  const result = await exec("php", [helper, mode], {
    cwd: backend,
    env: environment,
    timeout: 60000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(result.stdout.trim());
}
try {
  await command("setup");
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve) => reservation.close(resolve));
  const origin = `http://127.0.0.1:${address.port}`;
  php = spawn("php", ["-S", `127.0.0.1:${address.port}`, helper], {
    cwd: backend,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  php.stdout.on("data", (chunk) => {
    output += chunk;
  });
  php.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      ready = (
        await fetch(`${origin}/up`, { signal: AbortSignal.timeout(5000) })
      ).ok;
    } catch {
      /* The server is still booting. */
    }
    if (ready) break;
    if (php.exitCode !== null)
      throw new Error(
        "Isolated PHP server exited before readiness; inspect private test logs",
      );
    await delay(200);
  }
  assert(ready, "Isolated PHP server did not become ready");
  const result = await exec(
    process.execPath,
    [join(gateway, "scripts/verify-mpm-ingest-broker.mjs")],
    {
      cwd: gateway,
      env: {
        ...environment,
        BMS_TEST_MPM_ORIGIN: origin,
        BMS_TEST_MPM_STATE: statePath,
      },
      timeout: 180000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const evidence = JSON.parse(result.stdout.trim());
  assert.equal(evidence.result, "passed");
  assert.equal(evidence.droppedResponses, 1);
  const stored = await command("inspect");
  const event = JSON.parse(
    await readFile(
      join(gateway, "tests/fixtures/v1/valid/fault.event.json"),
      "utf8",
    ),
  );
  assert.deepEqual(
    stored.events,
    [event],
    "Backend must store the original event exactly once after replay",
  );
  assert.equal(
    stored.event_receipts,
    1,
    "Lost HTTP response must not duplicate backend identity receipts",
  );
  assert.equal(stored.attributes.profile_id, "demo-lfp-4s-v1");
  assert.equal(
    stored.attributes.session_id,
    stored.summary.session_id,
    "Metadata must recover for the promoted session",
  );
  assert.equal(stored.status.source_status, "stale");
  assert(stored.status.status_revision > 1);
  if (process.env.BMS_RECOVERY_EVIDENCE) {
    await writeFile(
      process.env.BMS_RECOVERY_EVIDENCE,
      JSON.stringify(
        { ...evidence, checked_at: new Date().toISOString(), stored },
        null,
        2,
      ) + "\n",
    );
  }
  console.log(
    JSON.stringify(
      {
        ...evidence,
        storedEvents: stored.events.length,
        storedEventReceipts: stored.event_receipts,
        metadataRecovered: true,
        sourceStatus: stored.status.source_status,
      },
      null,
      2,
    ),
  );
} finally {
  if (php && php.exitCode === null) {
    const closed = once(php, "close");
    php.kill("SIGTERM");
    const kill = setTimeout(() => php.kill("SIGKILL"), 5000);
    await closed;
    clearTimeout(kill);
  }
  try {
    if (existsSync(statePath)) await command("cleanup");
  } finally {
    // Logs can contain database diagnostics; keep them private and out of shared output.
    if (output)
      await writeFile(join(gateway, ".local/mpm-recovery-server.log"), output, {
        mode: 0o600,
      });
    await rm(directory, { recursive: true, force: true });
  }
}
