import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { connectAsync } from "mqtt";

const exec = promisify(execFile);
const image =
  "eclipse-mosquitto@sha256:38c0da4f2ef84284d47b3b3eeea1cb3bdeabe81ee10caf0cd5c5ff61ee3ea408";
const node = "53494D0000000001";
const topic = (suffix) => `libresolar/bms/v1/${node}/${suffix}`;
const fixtures = new URL("../tests/fixtures/v1/", import.meta.url);
const summary = JSON.parse(
  await readFile(new URL("valid/normal.summary.json", fixtures), "utf8"),
);
const telemetry = await readFile(
  new URL("valid/normal.telemetry.json", fixtures),
);
const directory = await mkdtemp(join(tmpdir(), "bms-a03-broker-"));
const name = `bms-a03-verification-${process.pid}`;
const requests = [];
const logs = [];
let stderr = "";
let child;
let publisher;
let containerStarted = false;

async function docker(...args) {
  const { stdout } = await exec("docker", args, {
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}
async function until(predicate, description) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${description}`);
}
const http = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push({
    route: request.url,
    authorization: request.headers.authorization,
    body,
  });
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({ result: "accepted", message_id: body.message_id }),
  );
});

try {
  await chmod(directory, 0o755);
  await writeFile(
    join(directory, "passwords"),
    "adapter:local-broker-test\npublisher:local-broker-test\n",
  );
  await writeFile(
    join(directory, "acl"),
    `user adapter\ntopic read libresolar/bms/v1/${node}/+\nuser publisher\ntopic readwrite libresolar/bms/v1/+/+\n`,
  );
  await writeFile(
    join(directory, "mosquitto.conf"),
    "listener 1883\nallow_anonymous false\npassword_file /mosquitto/config/passwords\nacl_file /mosquitto/config/acl\npersistence false\n",
  );
  await docker(
    "run",
    "--rm",
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--volume",
    `${directory}:/config`,
    image,
    "mosquitto_passwd",
    "-U",
    "/config/passwords",
  );
  for (const file of ["passwords", "acl", "mosquitto.conf"])
    await chmod(join(directory, file), 0o644);
  // Docker can reassign an unspecified host port on restart; keep the endpoint fixed.
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const reservedAddress = reservation.address();
  assert(reservedAddress && typeof reservedAddress !== "string");
  const brokerPort = reservedAddress.port;
  await new Promise((resolve) => reservation.close(resolve));
  await docker(
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--publish",
    `127.0.0.1:${brokerPort}:1883`,
    "--volume",
    `${directory}:/mosquitto/config:ro`,
    image,
  );
  containerStarted = true;
  const port = await docker("port", name, "1883/tcp");
  const mqttUrl = `mqtt://${port}`;
  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  assert(address && typeof address !== "string");
  publisher = await connectAsync(mqttUrl, {
    username: "publisher",
    password: "local-broker-test",
    reconnectPeriod: 500,
    connectTimeout: 5000,
  });
  await assert.rejects(
    connectAsync(mqttUrl, {
      username: "adapter",
      password: "wrong-test-password",
      reconnectPeriod: 0,
      connectTimeout: 5000,
    }),
    /not authorized/i,
  );
  // A retained fixture deliberately keeps its historical source time on delivery.
  await publisher.publishAsync(topic("summary"), JSON.stringify(summary), {
    qos: 1,
    retain: true,
  });
  await writeFile(
    join(directory, "adapter.env"),
    [
      `MQTT_URL=${mqttUrl}`,
      "MQTT_USERNAME=adapter",
      "MQTT_PASSWORD=local-broker-test",
      `MPM_BASE_URL=http://127.0.0.1:${address.port}`,
      "MPM_API_KEY=local-http-test-key",
      "MPM_COMPANY_BINDING=demo-company",
      "BMS_ADAPTER_ID=broker-verification",
      `BMS_NODE_IDS=${node}`,
      "MQTT_RECONNECT_MS=500",
    ].join("\n"),
    { mode: 0o600 },
  );
  child = spawn(
    process.execPath,
    [
      new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url).pathname,
      `--env-file=${join(directory, "adapter.env")}`,
      "app/mpm-ingest/main.ts",
    ],
    { cwd: new URL("../", import.meta.url), stdio: ["ignore", "pipe", "pipe"] },
  );
  let pending = "";
  child.stdout.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) if (line) logs.push(JSON.parse(line));
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  await until(
    () => logs.some((entry) => entry.result === "accepted"),
    "retained summary delivery",
  );
  assert.deepEqual(requests, [
    {
      route: "/api/libre-solar-bms/ingest/summaries",
      authorization: "Bearer local-http-test-key",
      body: summary,
    },
  ]);
  const delivered = requests.length;
  for (let count = 0; count < 20; count++)
    await publisher.publishAsync(topic("telemetry"), telemetry, { qos: 0 });
  await publisher.publishAsync(topic("summary"), "{", { qos: 1 });
  await publisher.publishAsync(
    topic("summary"),
    JSON.stringify({ ...summary, soc: "74.2" }),
    { qos: 1 },
  );
  await publisher.publishAsync(
    "libresolar/bms/v1/53494D0000000002/summary",
    JSON.stringify(summary),
    { qos: 1 },
  );
  await until(
    () => logs.filter((entry) => entry.code === "invalid_payload").length === 2,
    "invalid message rejection",
  );
  await delay(300);
  assert.equal(requests.length, delivered);
  const subscriptions = logs.filter(
    (entry) => entry.result === "subscribed",
  ).length;
  await docker("restart", name);
  assert.equal(
    await docker("port", name, "1883/tcp"),
    port,
    "The broker's host port changed on Docker restart",
  );
  await until(
    () =>
      logs.filter((entry) => entry.result === "subscribed").length >
      subscriptions,
    "broker reconnect and resubscription",
  );
  await until(() => publisher.connected, "publisher reconnect");
  await publisher.publishAsync(topic("summary"), JSON.stringify(summary), {
    qos: 1,
  });
  await until(
    () =>
      requests.length === delivered + 1 &&
      logs.filter((entry) => entry.result === "accepted").length ===
        delivered + 1,
    "summary delivery after restart",
  );
  assert.deepEqual(requests[delivered].body, summary);
  const closed = once(child, "close");
  child.kill("SIGTERM");
  assert.equal((await closed)[0], 0);
  assert(logs.some((entry) => entry.result === "stopped"));
  const output = JSON.stringify(logs) + stderr;
  assert(!output.includes("local-broker-test"));
  assert(!output.includes("local-http-test-key"));
  console.log(
    JSON.stringify(
      {
        result: "passed",
        image,
        endpoint: "fake MPM HTTP server",
        checks: [
          "broker rejects wrong credentials",
          "retained summary preserves payload/timestamps",
          "20 telemetry packets produce no HTTP writes",
          "malformed/type-invalid summaries rejected",
          "unbound topic excluded",
          "broker restart/reconnect/resubscription",
          "summary delivered after restart",
          "clean shutdown and no secret logs",
        ],
        httpWrites: requests.length,
      },
      null,
      2,
    ),
  );
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  if (publisher) await publisher.endAsync(true);
  http.closeAllConnections();
  await new Promise((resolve) => http.close(() => resolve()));
  if (containerStarted) await docker("stop", name);
  await rm(directory, { recursive: true, force: true });
}
