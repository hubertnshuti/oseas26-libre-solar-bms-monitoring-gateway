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
const backendOrigin = process.env.BMS_TEST_MPM_ORIGIN;
const backendKey = backendOrigin
  ? JSON.parse(await readFile(process.env.BMS_TEST_MPM_STATE, "utf8")).token
  : "local-http-test-key";
const adapterId = backendOrigin ? "mpm-recovery" : "broker-verification";
let dropEventResponse = Boolean(backendOrigin);
let droppedResponses = 0;
const requests = [];
const receipts = [];
let responseStatus = 200;
const event = JSON.parse(
  await readFile(new URL("valid/fault.event.json", fixtures), "utf8"),
);
const summaries = () =>
  requests.filter((entry) => entry.route.endsWith("/summaries"));
const events = () =>
  requests.filter((entry) => entry.route.endsWith("/events"));
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
  const deadline = Date.now() + 30000;
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
  if (backendOrigin && responseStatus === 200) {
    try {
      const upstream = await fetch(`${backendOrigin}${request.url}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${backendKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      const reply = await upstream.text();
      if (
        request.url.endsWith("/events") &&
        dropEventResponse &&
        upstream.status === 200
      ) {
        dropEventResponse = false;
        droppedResponses++;
        response.destroy();
        return;
      }
      response.writeHead(upstream.status, {
        "Content-Type": "application/json",
      });
      response.end(reply);
    } catch {
      response.writeHead(503);
      response.end();
    }
    return;
  }
  response.writeHead(responseStatus, { "Content-Type": "application/json" });
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
    `user adapter\ntopic read libresolar/bms/v1/${node}/+\ntopic write libresolar/bms/v1/${node}/receipts/mpm\nuser publisher\ntopic readwrite libresolar/bms/v1/+/+\ntopic read libresolar/bms/v1/${node}/receipts/mpm\n`,
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
      `MPM_API_KEY=${backendKey}`,
      "MPM_COMPANY_BINDING=demo-company",
      `BMS_ADAPTER_ID=${adapterId}`,
      `BMS_NODE_IDS=${node}`,
      `BMS_STATE_PATH=${join(directory, "adapter.sqlite")}`,
      "MQTT_RECONNECT_MS=500",
    ].join("\n"),
    { mode: 0o600 },
  );
  await publisher.subscribeAsync(topic("receipts/mpm"), { qos: 1 });
  publisher.on("message", (receivedTopic, raw) => {
    if (receivedTopic === topic("receipts/mpm"))
      receipts.push(JSON.parse(raw.toString()));
  });
  function startAdapter() {
    child = spawn(
      process.execPath,
      [
        `--env-file=${join(directory, "adapter.env")}`,
        "--import",
        "tsx",
        "app/mpm-ingest/main.ts",
      ],
      {
        cwd: new URL("../", import.meta.url),
        stdio: ["ignore", "pipe", "pipe"],
      },
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
  }
  startAdapter();
  await until(
    () =>
      logs.some(
        (entry) =>
          ["accepted", "duplicate"].includes(entry.result) &&
          entry.messageId === summary.message_id,
      ),
    "retained summary delivery",
  );
  assert.deepEqual(summaries(), [
    {
      route: "/api/libre-solar-bms/ingest/summaries",
      authorization: `Bearer ${backendKey}`,
      body: summary,
    },
  ]);
  const delivered = summaries().length;
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
  assert.equal(summaries().length, delivered);
  assert(
    requests
      .filter((entry) => entry.route.endsWith("/status"))
      .every((entry) => entry.body.source_status === "unknown"),
  );
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
      summaries().length === delivered + 1 &&
      logs.filter(
        (entry) =>
          ["accepted", "duplicate"].includes(entry.result) &&
          entry.messageId === summary.message_id,
      ).length ===
        delivered + 1,
    "summary delivery after restart",
  );
  assert.deepEqual(summaries()[delivered].body, summary);
  responseStatus = 503;
  await publisher.publishAsync(topic("events"), JSON.stringify(event), {
    qos: 1,
  });
  await until(
    () => receipts.length === 1 && events().length > 0,
    "durable receipt during HTTP outage",
  );
  assert.equal(receipts[0].event_id, event.event_id);
  assert.equal(receipts[0].consumer_id, adapterId);
  const crashed = once(child, "close");
  child.kill("SIGKILL");
  await crashed;
  responseStatus = 200;
  startAdapter();
  await until(
    () =>
      logs.some(
        (entry) =>
          ["accepted", "duplicate"].includes(entry.result) &&
          entry.messageId === event.message_id,
      ),
    "restart recovery of queued event",
  );
  assert(
    events().every(
      (entry) => JSON.stringify(entry.body) === JSON.stringify(event),
    ),
  );
  await publisher.publishAsync(topic("events"), JSON.stringify(event), {
    qos: 1,
  });
  await until(() => receipts.length === 2, "duplicate receipt after recovery");
  assert.deepEqual(receipts[1], receipts[0]);
  const sessionId = "35f75ec4-29ab-48ab-93be-81d3e0708a68";
  const attributes = JSON.parse(
    await readFile(new URL("valid/demo.attributes.json", fixtures), "utf8"),
  );
  const observedAt = new Date().toISOString();
  Object.assign(attributes, {
    session_id: sessionId,
    message_id: `${node}:${sessionId}:attributes:0`,
    observed_at: observedAt,
    published_at: observedAt,
  });
  const metadataBefore = requests.filter((entry) =>
    entry.route.endsWith("/attributes"),
  ).length;
  await publisher.publishAsync(
    topic("attributes"),
    JSON.stringify(attributes),
    { qos: 1, retain: true },
  );
  await until(
    () =>
      logs.some(
        (entry) =>
          entry.result === "queued" &&
          entry.messageId === attributes.message_id,
      ),
    "new-session metadata stored",
  );
  await delay(300);
  assert.equal(
    requests.filter((entry) => entry.route.endsWith("/attributes")).length,
    metadataBefore,
  );
  const promoted = {
    ...summary,
    session_id: sessionId,
    message_id: `${node}:${sessionId}:summary:121`,
    telemetry_message_id: `${node}:${sessionId}:telemetry:120`,
    observed_at: observedAt,
    published_at: observedAt,
    last_source_observed_at: observedAt,
  };
  await publisher.publishAsync(topic("summary"), JSON.stringify(promoted), {
    qos: 1,
    retain: true,
  });
  await until(
    () =>
      logs.some(
        (entry) =>
          entry.result === "accepted" &&
          entry.messageId === attributes.message_id,
      ),
    "metadata after summary session promotion",
  );
  const live = {
    ...JSON.parse(telemetry.toString()),
    session_id: sessionId,
    message_id: `${node}:${sessionId}:telemetry:120`,
    observed_at: new Date().toISOString(),
    published_at: new Date().toISOString(),
  };
  await publisher.publishAsync(topic("telemetry"), JSON.stringify(live), {
    qos: 0,
  });
  await until(
    () => requests.some((entry) => entry.body.source_status === "fresh"),
    "live telemetry status",
  );
  await until(
    () => requests.some((entry) => entry.body.source_status === "stale"),
    "connected but silent status",
  );
  const closed = once(child, "close");
  child.kill("SIGTERM");
  assert.equal((await closed)[0], 0);
  assert(logs.some((entry) => entry.result === "stopped"));
  const output = JSON.stringify(logs) + stderr;
  assert(!output.includes("local-broker-test"));
  assert(!output.includes(backendKey));
  console.log(
    JSON.stringify(
      {
        result: "passed",
        image,
        endpoint: backendOrigin
          ? "real MPM HTTP kernel with isolated testing database"
          : "fake MPM HTTP server",
        droppedResponses,
        checks: [
          "broker rejects wrong credentials",
          "retained summary preserves payload/timestamps",
          "historical telemetry never establishes freshness or writes metrics",
          "malformed/type-invalid summaries rejected",
          "unbound topic excluded",
          "broker restart/reconnect/resubscription",
          "summary delivered after restart",
          "durable event receipt while HTTP unavailable",
          "SIGKILL/restart recovers original event identity and times",
          "identical receipt for duplicate event after recovery",
          "new-session metadata waits for summary promotion",
          ...(backendOrigin
            ? ["backend commit followed by lost response replays safely"]
            : []),
          "new telemetry establishes fresh status and silence becomes stale",
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
