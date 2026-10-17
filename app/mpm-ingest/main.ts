import { connect } from "mqtt";
import { Adapter } from "./adapter.js";
import { readConfig } from "./config.js";
import { MpmClient } from "./http.js";

function log(result: object): void {
  console.log(JSON.stringify(result));
}

let configurationLoaded = false;
try {
  const config = readConfig(process.env);
  configurationLoaded = true;
  const adapter = new Adapter(config, new MpmClient(config));
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
  let stopping = false;
  client.on("connect", () => {
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
  client.on("message", (topic, payload) => {
    if (stopping) return;
    void adapter.handle(topic, payload).then((outcome) => {
      if (outcome.result !== "observed") log(outcome);
    });
  });
  client.on("error", () =>
    log({
      result: "mqtt_error",
      code: "check_broker_connection_and_credentials",
    }),
  );
  client.on("offline", () => log({ result: "mqtt_offline" }));

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    // Disconnect first so shutdown does not keep accepting work from the broker.
    client.end(true);
    await adapter.drain();
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
