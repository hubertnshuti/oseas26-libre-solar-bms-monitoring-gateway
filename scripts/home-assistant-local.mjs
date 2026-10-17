import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const network = "b05-ha-discovery";
const brokerContainer = "b05-ha-mosquitto";
const homeAssistantContainer = "b05-home-assistant";
const mosquittoImage =
  "eclipse-mosquitto@sha256:38c0da4f2ef84284d47b3b3eeea1cb3bdeabe81ee10caf0cd5c5ff61ee3ea408";
const homeAssistantImage =
  "ghcr.io/home-assistant/home-assistant@sha256:130241f28d01fa80dfa3b44f7d89781c188d8642ecab9024f079f19f9f82baa0";
const mqttPort = port("B05_MQTT_PORT", "1885");
const homeAssistantPort = port("B05_HOME_ASSISTANT_PORT", "8124");

function docker(...args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || `docker ${args[0]} failed`);
  return result.stdout.trim();
}

function port(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1024 || value > 65535)
    throw new Error(`${name} must be an unused TCP port from 1024 to 65535`);
  return value;
}

function containerExists(name) {
  return Boolean(docker("ps", "-aq", "--filter", `name=^${name}$`));
}

function inspectContainer(name) {
  if (!containerExists(name)) return undefined;
  return docker(
    "inspect",
    "-f",
    '{{ index .Config.Labels "com.libresolar.b05" }}',
    name,
  );
}

async function start() {
  for (const name of [brokerContainer, homeAssistantContainer]) {
    if (containerExists(name)) {
      const label = inspectContainer(name);
      throw new Error(
        `${name} already exists${label === "true" ? " from a prior B05 run" : " and is not owned by this B05 helper"}; stop it deliberately before retrying`,
      );
    }
  }
  const existingNetwork = docker(
    "network",
    "ls",
    "-q",
    "--filter",
    `name=^${network}$`,
  );
  if (existingNetwork)
    throw new Error(`${network} already exists; inspect it before retrying`);
  const support = await mkdtemp(join(tmpdir(), "libre-solar-b05-ha-"));
  const config = resolve(
    process.env.B05_HOME_ASSISTANT_CONFIG ?? join(support, "home-assistant"),
  );
  const mosquittoConfig = fileURLToPath(
    new URL(
      "../docs/examples/mosquitto.home-assistant-test.conf",
      import.meta.url,
    ),
  );
  await mkdir(config, { recursive: true, mode: 0o700 });
  docker("network", "create", network);
  docker(
    "run",
    "--detach",
    "--name",
    brokerContainer,
    "--label",
    "com.libresolar.b05=true",
    "--network",
    network,
    "--publish",
    `127.0.0.1:${mqttPort}:1883`,
    "--mount",
    `type=bind,src=${mosquittoConfig},dst=/mosquitto/config/mosquitto.conf,readonly`,
    mosquittoImage,
  );
  docker(
    "run",
    "--detach",
    "--name",
    homeAssistantContainer,
    "--label",
    "com.libresolar.b05=true",
    "--network",
    network,
    "--hostname",
    "homeassistant",
    "--publish",
    `127.0.0.1:${homeAssistantPort}:8123`,
    "--mount",
    `type=bind,src=${config},dst=/config`,
    "--env",
    "TZ=Africa/Johannesburg",
    homeAssistantImage,
  );
  process.stdout.write(
    `${JSON.stringify({
      result: "started",
      home_assistant_image: homeAssistantImage,
      mosquitto_image: mosquittoImage,
      home_assistant_url: `http://127.0.0.1:${homeAssistantPort}`,
      config_directory: config,
      test_support_directory: support,
      broker_container_hostname: brokerContainer,
      broker_container_port: 1883,
      broker_host_url: `mqtt://127.0.0.1:${mqttPort}`,
      network,
      security:
        "isolated Docker network; unauthenticated listener mapped to host loopback only",
    })}\n`,
  );
}

function stop() {
  for (const name of [homeAssistantContainer, brokerContainer]) {
    if (!containerExists(name)) continue;
    if (inspectContainer(name) !== "true")
      throw new Error(`Refusing to stop unowned container ${name}`);
    docker("stop", name);
    docker("rm", name);
  }
  const networkExists = Boolean(
    docker("network", "ls", "-q", "--filter", `name=^${network}$`),
  );
  if (networkExists) docker("network", "rm", network);
  process.stdout.write(
    `${JSON.stringify({
      result: "stopped",
      network,
      note: "the Home Assistant configuration directory was preserved",
    })}\n`,
  );
}

try {
  if (process.argv[2] === "start") await start();
  else if (process.argv[2] === "stop") stop();
  else
    throw new Error("Usage: node scripts/home-assistant-local.mjs start|stop");
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ result: "failed", message: error.message })}\n`,
  );
  process.exitCode = 1;
}
