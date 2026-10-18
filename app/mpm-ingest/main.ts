import { connect } from "mqtt";
import { Adapter } from "./adapter.js";
import { readConfig } from "./config.js";
import { MpmClient } from "./http.js";
import { DeliveryStore } from "./store.js";
import { ReliableDelivery } from "./delivery.js";

function log(result: object): void {
  console.log(JSON.stringify(result));
}

let configurationLoaded = false;
try {
  const config = readConfig(process.env);
  configurationLoaded = true;
  const store = await DeliveryStore.open(
    config.statePath,
    JSON.stringify({
      company: config.companyBinding,
      endpoint: config.mpmBaseUrl,
      adapter: config.adapterId,
      source: config.source,
      nodes: [...config.nodeIds].sort(),
    }),
  );
  const client = connect(config.mqttUrl, {
    username: config.mqttUsername,
    password: config.mqttPassword,
    clientId: `mpm-${config.adapterId}`,
    clean: true,
    reconnectPeriod: config.mqttReconnectMs,
    connectTimeout: 10000,
    resubscribe: false,
    queueQoSZero: false,
  });
  const delivery = new ReliableDelivery(
    config,
    store,
    new MpmClient(config),
    async (receipt) => {
      if (!client.connected) throw new Error("Broker disconnected");
      await client.publishAsync(
        `libresolar/bms/v1/${receipt.node_id}/receipts/mpm`,
        JSON.stringify(receipt),
        { qos: 1, retain: false },
      );
    },
    log,
  );
  const adapter = new Adapter(config, delivery);
  let stopping = false;
  let ticking = false;
  let statusTask: Promise<void> | undefined;
  const timer = setInterval(() => void tick(), 1000);
  async function tick(): Promise<void> {
    if (stopping || ticking) return;
    ticking = true;
    try {
      statusTask = delivery.checkStatus();
      await statusTask;
      void delivery.flush().catch(() => {
        log({
          result: "storage_failed",
          code: "preserve_state_and_check_disk",
        });
        process.exitCode = 1;
        void stop();
      });
    } catch {
      log({ result: "storage_failed", code: "preserve_state_and_check_disk" });
      process.exitCode = 1;
      void stop();
    } finally {
      ticking = false;
    }
  }
  client.on("connect", () => {
    delivery.setConnected(true);
    const topics = config.nodeIds.flatMap((node) =>
      ["summary", "events", "attributes", "availability", "telemetry"].map(
        (suffix) => `libresolar/bms/v1/${node}/${suffix}`,
      ),
    );
    client.subscribe(topics, { qos: 1 }, (error, grants) => {
      if (error || grants?.some((grant) => grant.qos === 128)) {
        log({ result: "subscription_failed" });
        process.exitCode = 1;
        void stop();
        return;
      }
      log({
        result: "subscribed",
        companyBinding: config.companyBinding,
        adapterId: config.adapterId,
        nodeIds: config.nodeIds,
      });
    });
  });
  // MQTT.js invokes this hook before sending PUBACK, so a disk failure cannot
  // acknowledge a write that the adapter has not durably accepted.
  client.handleMessage = (packet, callback) => {
    if (stopping) return callback(new Error("Stopping"));
    void adapter
      .handle(packet.topic, Buffer.from(packet.payload), packet.retain)
      .then((outcome) => {
        if (outcome.result !== "observed") log(outcome);
        callback();
        void tick();
      })
      .catch(() => {
        log({
          result: "storage_failed",
          code: "preserve_state_and_check_disk",
        });
        process.exitCode = 1;
        callback(new Error("Durable storage failed"));
        void stop();
      });
  };
  client.on("error", () =>
    log({
      result: "mqtt_error",
      code: "check_broker_connection_and_credentials",
    }),
  );
  client.on("offline", () => {
    delivery.setConnected(false);
    log({ result: "mqtt_offline" });
    void tick();
  });

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    delivery.stop();
    // Disconnect first so shutdown does not keep accepting work from the broker.
    client.end(true);
    await statusTask?.catch(() => undefined);
    await adapter.drain().catch(() => undefined);
    await delivery.flush().catch(() => undefined);
    store.close();
    log({ result: "stopped" });
  }
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
} catch (error) {
  // Config errors contain setting names, never their values.
  log({
    result: "startup_failed",
    code:
      !configurationLoaded && error instanceof Error
        ? error.message
        : "client_startup_error",
  });
  process.exitCode = 1;
}
