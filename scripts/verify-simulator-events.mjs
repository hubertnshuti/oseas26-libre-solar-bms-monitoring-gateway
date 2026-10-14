import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { connectAsync } from "mqtt";
import { validateMessage } from "../lib/contract/validate.ts";

const exec = promisify(execFile);
const image =
  "eclipse-mosquitto@sha256:38c0da4f2ef84284d47b3b3eeea1cb3bdeabe81ee10caf0cd5c5ff61ee3ea408";
const nodeA = "53494D0000000001";
const nodeB = "53494D0000000002";
const nodeC = "53494D0000000003";
const topic = (node, suffix) => `libresolar/bms/v1/${node}/${suffix}`;
const dir = await mkdtemp(join(tmpdir(), "bms-b04-broker-"));
const container = `bms-b04-${process.pid}-${Date.now()}`;
const children = new Set();
const clients = new Set();
const messages = [];
const violations = [];
let brokerStarted = false;
let mqttUrl;
let observer;

async function docker(...args) {
  const { stdout } = await exec("docker", args, {
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function until(predicate, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${description}`);
}

function startChild(args, label, extraEnv = {}) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "app/simulator/main.ts", ...args],
    {
      cwd: new URL("../", import.meta.url),
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.label = label;
  child.stdoutText = "";
  child.stderrText = "";
  child.stdout.on("data", (chunk) => (child.stdoutText += chunk.toString()));
  child.stderr.on("data", (chunk) => (child.stderrText += chunk.toString()));
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}

async function stopChild(child, signal = "SIGTERM", expectedCode = 0) {
  if (child.exitCode === null && child.signalCode === null) {
    const closed = once(child, "close");
    child.kill(signal);
    const [code] = await closed;
    if (expectedCode !== null) assert.equal(code, expectedCode, child.label);
  }
}

async function connectClient(identity, username, reconnectPeriod = 0) {
  const client = await connectAsync(mqttUrl, {
    clientId: `${identity}-${process.pid}-${Date.now()}-${clients.size}`,
    username,
    password: "b04-local-test-only",
    clean: true,
    reconnectPeriod,
    connectTimeout: 5000,
  });
  clients.add(client);
  return client;
}

function capture(topicName, payload, packet) {
  const suffix = topicName.endsWith("/receipts/mpm")
    ? "receipts/mpm"
    : topicName.split("/").at(-1);
  const node = topicName.split("/")[3];
  let value;
  if (suffix === "availability") {
    value = payload.toString();
    if (!new Set(["online", "offline"]).has(value))
      violations.push(`invalid availability ${topicName}`);
  } else if (suffix === "receipts/mpm") {
    try {
      value = JSON.parse(payload.toString());
      const checked = validateMessage("event-receipt", value, {
        topic: topicName,
      });
      if (!checked.valid) violations.push(`invalid receipt ${topicName}`);
    } catch {
      violations.push(`bad receipt JSON ${topicName}`);
    }
  } else {
    try {
      value = JSON.parse(payload.toString());
      const kind = suffix === "events" ? "event" : suffix;
      const checked = validateMessage(kind, value, { topic: topicName });
      if (!checked.valid) violations.push(`invalid ${kind} ${topicName}`);
      if (value.node_id !== node)
        violations.push(`node/topic mismatch ${topicName}`);
    } catch {
      violations.push(`bad JSON ${topicName}`);
    }
  }
  messages.push({
    topic: topicName,
    node,
    suffix,
    payload: value,
    text: payload.toString(),
    qos: packet.qos,
    retain: packet.retain,
  });
}

async function startObserver() {
  observer = await connectClient("observer", "observer", 500);
  observer.on("message", capture);
  await observer.subscribeAsync("libresolar/bms/v1/#", { qos: 1 });
}

function simArgs(node, scenario, outboxPath, options = {}) {
  return [
    "--profile",
    "demo-lfp-4s-v1",
    "--scenario",
    scenario,
    "--seed",
    "44",
    "--node-id",
    node,
    "--broker-url",
    mqttUrl,
    "--outbox-path",
    outboxPath,
    "--outbox-capacity",
    String(options.capacity ?? 8),
    "--consumer-id",
    "mpm-demo",
    "--gap-ms",
    String(options.gapMs ?? 15_000),
  ];
}

async function durableStore(storePath, event) {
  const validation = validateMessage("event", event, {
    topic: topic(event.node_id, "events"),
  });
  assert(validation.valid, "test adapter only stores contract-valid events");
  let store = [];
  try {
    store = JSON.parse(await readFile(storePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const duplicate = store.some((item) => item.event_id === event.event_id);
  if (!duplicate) {
    store.push(event);
    const temporary = `${storePath}.tmp`;
    const file = await import("node:fs/promises").then(({ open }) =>
      open(temporary, "w", 0o600),
    );
    await file.writeFile(`${JSON.stringify(store, null, 2)}\n`);
    await file.sync();
    await file.close();
    await rename(temporary, storePath);
    const directory = await import("node:fs/promises").then(({ open }) =>
      open(dir, "r"),
    );
    await directory.sync();
    await directory.close();
  }
  return { duplicate, count: store.length };
}

async function startReceiptAdapter(storePath, behavior) {
  const client = await connectClient("adapter", "adapter", 0);
  await client.subscribeAsync(topic(nodeA, "events"), { qos: 1 });
  const received = [];
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("adapter event timeout")),
      12_000,
    );
    client.on("message", async (topicName, raw) => {
      if (topicName !== topic(nodeA, "events")) return;
      const event = JSON.parse(raw.toString());
      received.push(event);
      if (behavior === "crash-before-store") {
        clearTimeout(timeout);
        resolve({ event, stored: { duplicate: false, count: 0 }, received });
        client.end(true);
        return;
      }
      const stored = await durableStore(storePath, event);
      if (behavior === "store-and-withhold") {
        if (!stored.duplicate) {
          clearTimeout(timeout);
          resolve({ event, stored, received });
        }
        return;
      }
      const receipt = {
        schema_version: 1,
        node_id: event.node_id,
        source: event.source,
        event_id: event.event_id,
        consumer_id: "mpm-demo",
        message_id: `${event.event_id}:receipt:mpm-demo`,
        status: "stored",
      };
      assert(
        validateMessage("event-receipt", receipt, {
          topic: topic(nodeA, "receipts/mpm"),
        }).valid,
        "test adapter receipt follows the shared schema",
      );
      await client.publishAsync(
        topic(nodeA, "receipts/mpm"),
        JSON.stringify(receipt),
        { qos: 1, retain: false },
      );
      if (behavior === "ack-on-duplicate" && stored.duplicate) {
        clearTimeout(timeout);
        resolve({ event, stored, received });
      }
    });
  });
  return { client, received, ready };
}

try {
  await chmod(dir, 0o755);
  await mkdir(join(dir, "data"), { recursive: true });
  await chmod(join(dir, "data"), 0o777);
  await writeFile(
    join(dir, "passwords"),
    [
      "producer:b04-local-test-only",
      "adapter:b04-local-test-only",
      "observer:b04-local-test-only",
    ].join("\n") + "\n",
  );
  await docker(
    "run",
    "--rm",
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--volume",
    `${dir}:/config`,
    image,
    "mosquitto_passwd",
    "-U",
    "/config/passwords",
  );
  await chmod(join(dir, "passwords"), 0o644);
  await writeFile(
    join(dir, "acl"),
    [
      "user producer",
      "topic write libresolar/bms/v1/+/telemetry",
      "topic write libresolar/bms/v1/+/summary",
      "topic write libresolar/bms/v1/+/attributes",
      "topic write libresolar/bms/v1/+/availability",
      "topic write libresolar/bms/v1/+/events",
      "topic read libresolar/bms/v1/+/receipts/mpm",
      "user adapter",
      "topic read libresolar/bms/v1/+/events",
      "topic write libresolar/bms/v1/+/receipts/mpm",
      "user observer",
      "topic read libresolar/bms/v1/#",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(dir, "mosquitto.conf"),
    [
      "listener 1883",
      "allow_anonymous false",
      "password_file /mosquitto/config/passwords",
      "acl_file /mosquitto/config/acl",
      "persistence true",
      "persistence_location /mosquitto/data/",
      "autosave_interval 1",
      "log_type all",
      "log_dest stdout",
      "",
    ].join("\n"),
  );
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise((resolve) => reservation.close(resolve));
  await docker(
    "run",
    "--detach",
    "--rm",
    "--name",
    container,
    "--publish",
    `127.0.0.1:${port}:1883`,
    "--volume",
    `${dir}:/mosquitto/config`,
    image,
  );
  brokerStarted = true;
  mqttUrl = `mqtt://127.0.0.1:${port}`;
  await startObserver();

  const receiptTopic = topic(nodeA, "receipts/mpm");
  const aclReceipt = {
    schema_version: 1,
    node_id: nodeA,
    source: "simulator",
    event_id: `${nodeA}:15f75ec4-29ab-48ab-93be-81d3e0708a68:events:5`,
    consumer_id: "mpm-demo",
    message_id: `${nodeA}:15f75ec4-29ab-48ab-93be-81d3e0708a68:events:5:receipt:mpm-demo`,
    status: "stored",
  };
  const receiptsBeforeAclProbe = messages.filter(
    (message) => message.topic === receiptTopic,
  ).length;
  try {
    await docker(
      "exec",
      container,
      "mosquitto_pub",
      "-h",
      "127.0.0.1",
      "-u",
      "producer",
      "-P",
      "b04-local-test-only",
      "-q",
      "1",
      "-t",
      receiptTopic,
      "-m",
      JSON.stringify(aclReceipt),
    );
  } catch {
    // MQTT v3 brokers may PUBACK a denied write; broker ACL log and observer are authoritative.
  }
  await delay(100);
  const aclLog = await docker("logs", container);
  assert.match(
    aclLog,
    /Denied PUBLISH from .*'libresolar\/bms\/v1\/53494D0000000001\/receipts\/mpm'/,
  );
  assert.equal(
    messages.filter((message) => message.topic === receiptTopic).length,
    receiptsBeforeAclProbe,
    "producer ACL must prevent receipt delivery",
  );
  let anonymousDenied = false;
  try {
    await docker(
      "exec",
      container,
      "mosquitto_pub",
      "-h",
      "127.0.0.1",
      "-q",
      "1",
      "-t",
      receiptTopic,
      "-m",
      JSON.stringify(aclReceipt),
    );
  } catch {
    anonymousDenied = true;
  }
  assert(anonymousDenied, "anonymous receipt publication must be denied");

  const outboxPath = join(dir, "producer-outbox.json");
  let producer = startChild(
    simArgs(nodeA, "cell-overvoltage", outboxPath),
    "producer-before-adapter",
    { MQTT_USERNAME: "producer", MQTT_PASSWORD: "b04-local-test-only" },
  );
  await until(
    () =>
      messages.some(
        (message) => message.node === nodeA && message.suffix === "events",
      ),
    "producer persists and publishes first fault event before adapter start",
  );
  const firstEvent = messages.find(
    (message) => message.node === nodeA && message.suffix === "events",
  );
  assert.equal(firstEvent?.qos, 1);
  assert.equal(firstEvent?.retain, false);
  assert.equal(firstEvent?.payload.kind, "fault_changed");
  const firstDiskState = JSON.parse(await readFile(outboxPath, "utf8"));
  assert.equal(
    firstDiskState.pending[0].event_id,
    firstEvent?.payload.event_id,
  );
  assert.equal(
    firstDiskState.pending[0].observed_at,
    firstEvent?.payload.observed_at,
  );

  const telemetryBeforeRestart = messages.find(
    (message) => message.node === nodeA && message.suffix === "telemetry",
  );
  const sessionBeforeRestart = telemetryBeforeRestart?.payload.session_id;
  const messageIndexBeforeRestart = messages.length;
  await docker("restart", container);
  await until(
    () =>
      messages
        .slice(messageIndexBeforeRestart)
        .some(
          (message) =>
            message.node === nodeA &&
            message.suffix === "telemetry" &&
            message.payload.session_id === sessionBeforeRestart,
        ),
    "same process reconnects after broker restart without session reset",
    35_000,
  );
  await until(
    () =>
      messages
        .slice(messageIndexBeforeRestart)
        .some(
          (message) =>
            message.node === nodeA &&
            message.suffix === "events" &&
            message.payload.event_id === firstEvent?.payload.event_id,
        ),
    "unacknowledged event retries after broker restart",
  );

  await stopChild(producer, "SIGKILL", null);
  producer = startChild(
    simArgs(nodeA, "normal-charge", outboxPath),
    "producer-restart",
    { MQTT_USERNAME: "producer", MQTT_PASSWORD: "b04-local-test-only" },
  );
  await until(
    () =>
      messages.some(
        (message) =>
          message.node === nodeA &&
          message.suffix === "events" &&
          message.payload.event_id === firstEvent?.payload.event_id,
      ),
    "new producer process reloads and republishes the original pending event",
  );
  const replay = messages.find(
    (message) =>
      message.node === nodeA &&
      message.suffix === "events" &&
      message.payload.event_id === firstEvent?.payload.event_id,
  );
  assert.equal(replay?.payload.observed_at, firstEvent?.payload.observed_at);
  assert.equal(replay?.payload.session_id, firstEvent?.payload.session_id);
  await until(
    () =>
      messages.some(
        (message) =>
          message.node === nodeA &&
          message.suffix === "telemetry" &&
          message.payload.session_id !== sessionBeforeRestart,
      ),
    "new producer process receives a new process session",
  );

  const adapterStore = join(dir, "adapter-durable-test-double.json");
  const crashAdapter = await startReceiptAdapter(
    adapterStore,
    "crash-before-store",
  );
  const crashed = await crashAdapter.ready;
  assert.equal(crashed.stored.count, 0);
  let storeCreatedBeforeCrash = false;
  try {
    await readFile(adapterStore, "utf8");
    storeCreatedBeforeCrash = true;
  } catch (error) {
    assert.equal(error.code, "ENOENT");
  }
  assert.equal(storeCreatedBeforeCrash, false);
  clients.delete(crashAdapter.client);

  const withholdingAdapter = await startReceiptAdapter(
    adapterStore,
    "store-and-withhold",
  );
  const storedWithoutReceipt = await withholdingAdapter.ready;
  assert.equal(storedWithoutReceipt.stored.duplicate, false);
  const forgedReceipt = {
    schema_version: 1,
    node_id: nodeA,
    source: "simulator",
    event_id: firstEvent.payload.event_id,
    consumer_id: "forged-consumer",
    message_id: `${firstEvent.payload.event_id}:receipt:forged-consumer`,
    status: "stored",
  };
  await withholdingAdapter.client.publishAsync(
    receiptTopic,
    JSON.stringify(forgedReceipt),
    { qos: 1, retain: false },
  );
  await until(
    () => producer.stderrText.includes("receipt_identity_mismatch"),
    "producer rejects a schema-valid receipt from an unconfigured consumer",
  );
  assert.equal(
    JSON.parse(await readFile(outboxPath, "utf8")).pending.length,
    1,
  );
  const duplicateArrival = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("event retry timeout")),
      12_000,
    );
    const onMessage = async (topicName, raw) => {
      if (topicName !== topic(nodeA, "events")) return;
      const event = JSON.parse(raw.toString());
      if (event.event_id !== firstEvent?.payload.event_id) return;
      clearTimeout(timeout);
      withholdingAdapter.client.off("message", onMessage);
      resolve(event);
    };
    withholdingAdapter.client.on("message", onMessage);
  });
  const retriedEvent = await duplicateArrival;
  assert.equal(retriedEvent.event_id, firstEvent?.payload.event_id);
  assert.equal(retriedEvent.observed_at, firstEvent?.payload.observed_at);
  withholdingAdapter.client.end(true);
  clients.delete(withholdingAdapter.client);

  const acknowledgingAdapter = await startReceiptAdapter(
    adapterStore,
    "ack-on-duplicate",
  );
  const acknowledgedDuplicate = await acknowledgingAdapter.ready;
  assert.equal(acknowledgedDuplicate.stored.duplicate, true);
  await until(async () => {
    const value = JSON.parse(await readFile(outboxPath, "utf8"));
    return value.pending.length === 0;
  }, "outbox clears only after authorized stored receipt");
  const uniqueEvents = JSON.parse(await readFile(adapterStore, "utf8"));
  assert.equal(
    uniqueEvents.filter(
      (item) => item.event_id === firstEvent?.payload.event_id,
    ).length,
    1,
  );

  const replayProducer = await connectClient("replay-producer", "producer");
  const receiptCountBefore = messages.filter(
    (message) =>
      message.suffix === "receipts/mpm" &&
      message.payload?.event_id === firstEvent?.payload.event_id,
  ).length;
  await replayProducer.publishAsync(topic(nodeA, "events"), firstEvent.text, {
    qos: 1,
    retain: false,
  });
  await until(
    () =>
      messages.filter(
        (message) =>
          message.suffix === "receipts/mpm" &&
          message.payload?.event_id === firstEvent?.payload.event_id,
      ).length > receiptCountBefore,
    "duplicate replay receives idempotent stored receipt",
  );
  assert.equal(
    JSON.parse(await readFile(adapterStore, "utf8")).filter(
      (item) => item.event_id === firstEvent?.payload.event_id,
    ).length,
    1,
  );

  await acknowledgingAdapter.client.endAsync();
  clients.delete(acknowledgingAdapter.client);
  await stopChild(producer, "SIGTERM", 0);

  const capacityPath = join(dir, "capacity-outbox.json");
  const capacityProducer = startChild(
    simArgs(nodeB, "recovery", capacityPath, { capacity: 1 }),
    "capacity-producer",
    { MQTT_USERNAME: "producer", MQTT_PASSWORD: "b04-local-test-only" },
  );
  await until(
    () => capacityProducer.exitCode !== null,
    "outbox overflow terminates visibly instead of dropping pending events",
    15_000,
  );
  assert.equal(capacityProducer.exitCode, 1);
  assert.match(capacityProducer.stderrText, /outbox_capacity_exceeded/);
  const capacityState = JSON.parse(await readFile(capacityPath, "utf8"));
  assert.equal(capacityState.pending.length, 1);

  const gapPath = join(dir, "gap-outbox.json");
  const gapProducer = startChild(
    simArgs(nodeC, "connected-but-silent", gapPath, { gapMs: 1000 }),
    "gap-producer",
    { MQTT_USERNAME: "producer", MQTT_PASSWORD: "b04-local-test-only" },
  );
  await until(
    () =>
      messages.some(
        (message) =>
          message.node === nodeC &&
          message.suffix === "events" &&
          message.payload.kind === "observation_gap",
      ),
    "connected silent source resumes with an observation_gap event",
    15_000,
  );
  await stopChild(gapProducer);
  assert.deepEqual(violations, []);

  const log = await docker("logs", container);
  assert.match(
    log,
    /Denied PUBLISH from .*'libresolar\/bms\/v1\/53494D0000000001\/receipts\/mpm'/,
  );
  assert.match(log, /not authorised|not authorized/i);
  const storedReceipt = messages.find(
    (message) =>
      message.suffix === "receipts/mpm" &&
      message.payload?.event_id === firstEvent?.payload.event_id &&
      message.payload?.consumer_id === "mpm-demo" &&
      message.payload?.status === "stored",
  );
  assert(storedReceipt, "captured a real broker receipt publication");
  const evidence = {
    broker: "Eclipse Mosquitto 2.1.2",
    event_topic: topic(nodeA, "events"),
    event_qos: firstEvent.qos,
    event_retain: firstEvent.retain,
    event: firstEvent.payload,
    receipt_topic: storedReceipt.topic,
    receipt_qos: storedReceipt.qos,
    receipt_retain: storedReceipt.retain,
    receipt: storedReceipt.payload,
    receiver: "faithful durable MQTT test double, not the actual A04 adapter",
  };
  await writeFile(
    new URL("../docs/evidence/simulator-events.json", import.meta.url),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      result: "passed",
      broker: "Eclipse Mosquitto 2.1.2",
      image,
      assertions: [
        "event payloads validated from real broker at QoS 1, retain false",
        "producer started before adapter and retained event durably",
        "broker restart retried same pending event without resetting live session",
        "producer restart replayed exact event ID and original observation time",
        "adapter crash before durable store left producer outbox pending",
        "lost receipt caused duplicate delivery; faithful adapter test double deduplicated and acknowledged stored event",
        "producer outbox removed item only after validated stored receipt",
        "schema-valid receipt from wrong consumer rejected over actual MQTT",
        "receipt ACL authorized adapter and denied producer and anonymous publisher",
        "manual duplicate replay produced one durable test-double event record",
        "capacity overflow was logged and existing event remained persisted",
        "connected-but-silent recovery emitted schema-valid observation_gap",
      ],
      adapter:
        "faithful MQTT/durable-file test double; actual A04 adapter currently publishes no receipts",
      durableTestDoubleUniqueEvents: uniqueEvents.length,
    })}\n`,
  );
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "close"), delay(1000)]);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  }
  for (const client of clients) {
    try {
      await client.endAsync();
    } catch {
      // Connection may already have been closed during a simulated crash.
    }
  }
  if (brokerStarted) {
    try {
      await docker("rm", "--force", container);
    } catch {
      // Task-scoped container may already have exited.
    }
  }
  await rm(dir, { recursive: true, force: true });
}
