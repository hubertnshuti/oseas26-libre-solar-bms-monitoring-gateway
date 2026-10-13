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
import { validateMessage } from "../lib/contract/validate.ts";

const exec = promisify(execFile);
const root = new URL("../", import.meta.url);
const image =
  "eclipse-mosquitto@sha256:38c0da4f2ef84284d47b3b3eeea1cb3bdeabe81ee10caf0cd5c5ff61ee3ea408";
const nodeA = "53494D0000000001";
const nodeB = "53494D0000000002";
const prefix = (node) => `libresolar/bms/v1/${node}`;
const profile = JSON.parse(
  await readFile(
    new URL("lib/contract/profiles/demo-lfp-4s-v1.json", root),
    "utf8",
  ),
);
const capabilities = {
  source: profile.source,
  cell_count: profile.cell_count,
  cell_channels: profile.cell_channels,
  temperature_sensor_count: profile.temperature_sensor_count,
  temperature_sensor_channels: profile.temperature_sensor_channels,
  supported_fields: profile.supported_fields,
};
const directory = await mkdtemp(join(tmpdir(), "bms-b03-broker-"));
const brokerName = `bms-b03-${process.pid}-${Date.now()}`;
const messages = [];
const violations = [];
const children = new Set();
const mqttClients = [];
let subscriber;
let adapter;
let brokerStarted = false;
let brokerUrl;
let mpmServer;
let capturedSummary;
const mpmRequests = [];

async function docker(...args) {
  const { stdout } = await exec("docker", args, {
    timeout: 180000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function until(predicate, description, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${description}`);
}

function recordMessage(topic, payload, packet) {
  const suffix = topic.split("/").at(-1);
  const nodeId = topic.split("/")[3];
  const entry = {
    topic,
    nodeId,
    suffix,
    payloadText: payload.toString(),
    payload: undefined,
    qos: packet.qos,
    retain: packet.retain,
  };
  if (suffix === "availability") {
    if (!["online", "offline"].includes(entry.payloadText)) {
      violations.push(`invalid availability payload on ${topic}`);
    }
  } else {
    try {
      entry.payload = JSON.parse(entry.payloadText);
      const kind = suffix;
      const checked = validateMessage(kind, entry.payload, {
        topic,
        profile: capabilities,
      });
      if (!checked.valid) {
        violations.push(
          `invalid ${kind} on ${topic}: ${checked.issues.map((issue) => `${issue.path}:${issue.code}`).join(",")}`,
        );
      }
      if (entry.payload.node_id !== nodeId) {
        violations.push(`topic/payload node mismatch on ${topic}`);
      }
      if (kind === "summary" && nodeId === nodeA && !capturedSummary) {
        capturedSummary = entry.payload;
      }
    } catch (error) {
      violations.push(`invalid JSON on ${topic}: ${error.message}`);
    }
  }
  messages.push(entry);
}

function startChild(command, args, label, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.label = label;
  child.stdoutText = "";
  child.stderrText = "";
  child.stdout.on("data", (chunk) => {
    child.stdoutText += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    child.stderrText += chunk.toString();
  });
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}

function launchSimulator(nodeId, seed) {
  return startChild(
    process.execPath,
    [
      "--import",
      "tsx",
      "app/simulator/main.ts",
      "--profile",
      "demo-lfp-4s-v1",
      "--scenario",
      "normal-cycle",
      "--seed",
      String(seed),
      "--node-id",
      nodeId,
      "--broker-url",
      brokerUrl,
    ],
    `simulator-${nodeId}`,
  );
}

async function stopChild(child, signal = "SIGTERM", expectedCode = 0) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill(signal);
  const [code, closeSignal] = await closed;
  if (expectedCode !== null)
    assert.equal(code, expectedCode, `${child.label} exit code`);
  return { code, signal: closeSignal };
}

async function lateSubscriber() {
  const client = await connectAsync(brokerUrl, {
    clientId: `b03-late-${Date.now()}-${mqttClients.length}`,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 5000,
  });
  const deliveries = [];
  client.on("message", (topic, payload, packet) => {
    deliveries.push({
      topic,
      payload: payload.toString(),
      qos: packet.qos,
      retain: packet.retain,
    });
  });
  mqttClients.push(client);
  return { client, deliveries };
}

try {
  await chmod(directory, 0o755);
  await writeFile(join(directory, "passwords"), "adapter:local-broker-test\n");
  await docker(
    "run",
    "--rm",
    "--volume",
    `${directory}:/mosquitto/config`,
    image,
    "mosquitto_passwd",
    "-U",
    "/mosquitto/config/passwords",
  );
  await chmod(join(directory, "passwords"), 0o644);
  await writeFile(
    join(directory, "mosquitto.conf"),
    "listener 1883\nallow_anonymous true\npassword_file /mosquitto/config/passwords\npersistence false\n",
    { mode: 0o644 },
  );
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  assert(address && typeof address !== "string");
  const brokerPort = address.port;
  await new Promise((resolve) => reservation.close(resolve));
  await docker(
    "run",
    "--detach",
    "--rm",
    "--name",
    brokerName,
    "--publish",
    `127.0.0.1:${brokerPort}:1883`,
    "--volume",
    `${directory}:/mosquitto/config:ro`,
    image,
  );
  brokerStarted = true;
  brokerUrl = `mqtt://127.0.0.1:${brokerPort}`;
  subscriber = await connectAsync(brokerUrl, {
    clientId: `b03-observer-${process.pid}`,
    clean: true,
    reconnectPeriod: 500,
    connectTimeout: 5000,
  });
  subscriber.on("message", (topic, payload, packet) =>
    recordMessage(topic, payload, packet),
  );
  mqttClients.push(subscriber);
  await subscriber.subscribeAsync("libresolar/bms/v1/+/+", { qos: 1 });
  const authProbe = await connectAsync(brokerUrl, {
    username: "adapter",
    password: "local-broker-test",
    reconnectPeriod: 0,
    connectTimeout: 5000,
  });
  await authProbe.endAsync();

  const simA = launchSimulator(nodeA, 1001);
  const simB = launchSimulator(nodeB, 2002);
  await until(
    () =>
      [nodeA, nodeB].every((node) =>
        ["telemetry", "summary", "attributes", "availability"].every((kind) =>
          messages.some(
            (message) => message.nodeId === node && message.suffix === kind,
          ),
        ),
      ),
    "both simulated nodes publish all startup message kinds",
  );
  assert.deepEqual(violations, []);

  const initialTelemetry = messages.find(
    (message) => message.nodeId === nodeA && message.suffix === "telemetry",
  );
  const initialSummaryDelivery = messages.find(
    (message) => message.nodeId === nodeA && message.suffix === "summary",
  );
  assert(initialTelemetry && initialSummaryDelivery && capturedSummary);
  assert.equal(initialTelemetry.qos, 0);
  assert.equal(initialTelemetry.retain, false);
  assert.equal(initialSummaryDelivery.qos, 1);
  assert.equal(initialSummaryDelivery.retain, false);

  // A new subscriber sees retained metadata/summary/status; telemetry has no retained copy.
  const retainedCheck = await lateSubscriber();
  await retainedCheck.client.subscribeAsync(
    [
      `${prefix(nodeA)}/summary`,
      `${prefix(nodeA)}/attributes`,
      `${prefix(nodeA)}/availability`,
    ],
    { qos: 1 },
  );
  await until(
    () =>
      ["summary", "attributes", "availability"].every((kind) =>
        retainedCheck.deliveries.some(
          (item) => item.topic === `${prefix(nodeA)}/${kind}`,
        ),
      ),
    "retained summary, attributes and online availability",
  );
  for (const item of retainedCheck.deliveries) {
    assert.equal(item.retain, true);
    assert.equal(item.qos, 1);
  }
  const retainedSummary = retainedCheck.deliveries.find((item) =>
    item.topic.endsWith("/summary"),
  );
  assert.deepEqual(JSON.parse(retainedSummary.payload), capturedSummary);
  assert.equal(
    JSON.parse(retainedSummary.payload).last_source_observed_at,
    capturedSummary.observed_at,
  );

  // The actual adapter subscribes to the retained summary and posts it to a local HTTP sink.
  mpmServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    mpmRequests.push({
      route: request.url,
      authorization: request.headers.authorization,
      body,
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({ result: "accepted", message_id: body.message_id }),
    );
  });
  await new Promise((resolve, reject) => {
    mpmServer.once("error", reject);
    mpmServer.listen(0, "127.0.0.1", resolve);
  });
  const mpmAddress = mpmServer.address();
  assert(mpmAddress && typeof mpmAddress !== "string");
  adapter = startChild(
    process.execPath,
    ["--import", "tsx", "app/mpm-ingest/main.ts"],
    "mpm-adapter",
    {
      MQTT_URL: brokerUrl,
      MQTT_USERNAME: "adapter",
      MQTT_PASSWORD: "local-broker-test",
      MPM_BASE_URL: `http://127.0.0.1:${mpmAddress.port}`,
      MPM_API_KEY: "local-test-key",
      MPM_COMPANY_BINDING: "demo-company",
      BMS_ADAPTER_ID: "b03-verification",
      BMS_NODE_IDS: nodeA,
      MQTT_RECONNECT_MS: "500",
    },
  );
  try {
    await until(
      () => mpmRequests.length > 0,
      "actual adapter posts retained simulator summary",
    );
  } catch (error) {
    throw new Error(
      `${error.message}\nAdapter stdout: ${adapter.stdoutText}\nAdapter stderr: ${adapter.stderrText}\nObserved MPM requests: ${JSON.stringify(mpmRequests)}\nValidation violations: ${JSON.stringify(violations)}`,
    );
  }
  assert.equal(mpmRequests[0].route, "/api/libre-solar-bms/ingest/summaries");
  assert.equal(mpmRequests[0].authorization, "Bearer local-test-key");
  assert.deepEqual(mpmRequests[0].body, capturedSummary);

  const beforeReconnect = messages.findLast(
    (message) => message.nodeId === nodeB && message.suffix === "telemetry",
  );
  const originalSession = beforeReconnect.payload.session_id;
  const portBefore = await docker("port", brokerName, "1883/tcp");
  await docker("restart", brokerName);
  assert.equal(await docker("port", brokerName, "1883/tcp"), portBefore);
  await until(
    () =>
      messages.some(
        (message) =>
          message.nodeId === nodeB &&
          message.suffix === "telemetry" &&
          message.payload.session_id === originalSession &&
          message.payload.sequence > beforeReconnect.payload.sequence,
      ),
    "same simulator session resumes publishing after broker restart",
  );
  await until(
    () =>
      messages.some(
        (message) =>
          message.nodeId === nodeB &&
          message.suffix === "summary" &&
          message.retain === false &&
          message.payload.sequence > beforeReconnect.payload.sequence,
      ),
    "fresh retained summary is republished after broker restart",
  );
  assert.deepEqual(violations, []);

  // Graceful stop publishes a retained offline state; no telemetry remains retained.
  await stopChild(simA, "SIGTERM", 0);
  await until(
    () =>
      messages.some(
        (message) =>
          message.nodeId === nodeA &&
          message.suffix === "availability" &&
          message.payloadText === "offline",
      ),
    "clean offline availability",
  );
  const afterStop = await lateSubscriber();
  await afterStop.client.subscribeAsync(
    [`${prefix(nodeA)}/availability`, `${prefix(nodeA)}/telemetry`],
    { qos: 1 },
  );
  await until(
    () =>
      afterStop.deliveries.some((item) => item.topic.endsWith("/availability")),
    "retained offline availability after clean stop",
  );
  await delay(300);
  assert.equal(
    afterStop.deliveries.find((item) => item.topic.endsWith("/availability"))
      .payload,
    "offline",
  );
  assert.equal(
    afterStop.deliveries.find((item) => item.topic.endsWith("/availability"))
      .retain,
    true,
  );
  assert.equal(
    afterStop.deliveries.some((item) => item.topic.endsWith("/telemetry")),
    false,
  );

  const replacement = launchSimulator(nodeA, 3003);
  await until(
    () =>
      messages.some(
        (message) =>
          message.nodeId === nodeA &&
          message.suffix === "telemetry" &&
          message.payload.session_id !== initialTelemetry.payload.session_id,
      ),
    "new process uses a new producer session",
  );
  const offlineCountBeforeLwt = messages.filter(
    (message) =>
      message.nodeId === nodeA &&
      message.suffix === "availability" &&
      message.payloadText === "offline",
  ).length;
  await stopChild(replacement, "SIGKILL", null);
  await until(
    () =>
      messages.filter(
        (message) =>
          message.nodeId === nodeA &&
          message.suffix === "availability" &&
          message.payloadText === "offline",
      ).length > offlineCountBeforeLwt,
    "broker LWT marks unexpectedly terminated producer offline",
  );
  const lwtCheck = await lateSubscriber();
  await lwtCheck.client.subscribeAsync(`${prefix(nodeA)}/availability`, {
    qos: 1,
  });
  await until(
    () => lwtCheck.deliveries.length > 0,
    "retained LWT offline message",
  );
  assert.equal(lwtCheck.deliveries[0].payload, "offline");
  assert.equal(lwtCheck.deliveries[0].retain, true);
  assert.equal(lwtCheck.deliveries[0].qos, 1);

  // Save one real MQTT-delivered summary as the B03 integration handoff fixture.
  const evidence = {
    node_id: nodeA,
    topic: `${prefix(nodeA)}/summary`,
    qos: 1,
    retain: true,
    delivery: "retained message received by a late subscriber",
    payload: capturedSummary,
  };
  await writeFile(
    new URL("../docs/evidence/simulator-mqtt-summary.json", import.meta.url),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      result: "passed",
      broker: "Eclipse Mosquitto 2.1.2",
      image,
      assertions: [
        "contract-valid telemetry/summary/attributes",
        "telemetry QoS 0 and not retained",
        "summary and attributes retained at QoS 1",
        "availability online/offline retained",
        "broker LWT after SIGKILL",
        "same session after broker restart",
        "two node IDs isolated by topic",
        "retained summary accepted by actual MPM adapter with HTTP test sink",
      ],
      mpmRequests: mpmRequests.length,
      summary: evidence,
    })}\n`,
  );
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "close"), delay(1500)]);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  }
  if (adapter && adapter.exitCode === null && adapter.signalCode === null) {
    const closed = once(adapter, "close");
    adapter.kill("SIGTERM");
    await Promise.race([closed, delay(1500)]);
  }
  await Promise.all(mqttClients.map((client) => client.endAsync()));
  if (mpmServer) await new Promise((resolve) => mpmServer.close(resolve));
  if (brokerStarted) {
    try {
      await docker("rm", "--force", brokerName);
    } catch {
      // The container is task-scoped and may already have exited.
    }
  }
  await rm(directory, { recursive: true, force: true });
}
