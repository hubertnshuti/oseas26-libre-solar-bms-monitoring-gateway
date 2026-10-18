export interface AdapterConfig {
  mqttUrl: string;
  mqttUsername: string;
  mqttPassword: string;
  mpmBaseUrl: string;
  mpmApiKey: string;
  companyBinding: string;
  adapterId: string;
  nodeIds: string[];
  httpTimeoutMs: number;
  mqttReconnectMs: number;
  maxPendingMessages: number;
  statePath: string;
  source: "simulator" | "hardware";
}

export function readConfig(env: NodeJS.ProcessEnv): AdapterConfig {
  function required(name: string): string {
    const value = env[name];
    if (!value?.trim()) throw new Error(`Missing required setting: ${name}`);
    return value;
  }
  function url(name: string, protocols: string[]): string {
    const value = required(name);
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`Invalid URL setting: ${name}`);
    }
    if (
      !protocols.includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== "" && parsed.pathname !== "/")
    )
      throw new Error(
        `Invalid URL setting: ${name}; use a server origin without credentials or paths`,
      );
    return value.replace(/\/$/, "");
  }
  function integer(name: string, fallback: number, maximum: number): number {
    const value = env[name] ?? String(fallback);
    if (!/^[1-9]\d*$/.test(value) || Number(value) > maximum)
      throw new Error(`Invalid positive integer setting: ${name}`);
    return Number(value);
  }
  const nodeIds = required("BMS_NODE_IDS")
    .split(",")
    .map((node) => node.trim());
  if (
    nodeIds.length > 100 ||
    new Set(nodeIds).size !== nodeIds.length ||
    nodeIds.some((node) => !/^[0-9A-F]{16}$/.test(node))
  )
    throw new Error(
      "Invalid BMS_NODE_IDS; use unique uppercase 16-digit hexadecimal IDs (maximum 100)",
    );
  const adapterId = required("BMS_ADAPTER_ID");
  const companyBinding = required("MPM_COMPANY_BINDING");
  for (const [name, value] of [
    ["BMS_ADAPTER_ID", adapterId],
    ["MPM_COMPANY_BINDING", companyBinding],
  ]) {
    if (!value || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value))
      throw new Error(`Invalid identity setting: ${name}`);
  }
  const mqttUsername = required("MQTT_USERNAME");
  const mqttPassword = required("MQTT_PASSWORD");
  const mpmApiKey = required("MPM_API_KEY");
  if (/[\r\n]/.test(mpmApiKey)) throw new Error("Invalid MPM_API_KEY");
  const source = env.BMS_SOURCE ?? "simulator";
  if (source !== "simulator" && source !== "hardware")
    throw new Error("Invalid BMS_SOURCE");
  const statePath = env.BMS_STATE_PATH ?? ".local/mpm-ingest.sqlite";
  if (!statePath.trim()) throw new Error("Invalid BMS_STATE_PATH");
  return {
    source,
    statePath,
    mqttUrl: url("MQTT_URL", ["mqtt:", "mqtts:"]),
    mqttUsername,
    mqttPassword,
    mpmBaseUrl: url("MPM_BASE_URL", ["http:", "https:"]),
    mpmApiKey,
    companyBinding,
    adapterId,
    nodeIds,
    httpTimeoutMs: integer("MPM_HTTP_TIMEOUT_MS", 10000, 60000),
    mqttReconnectMs: integer("MQTT_RECONNECT_MS", 1000, 60000),
    maxPendingMessages: integer("BMS_MAX_PENDING_MESSAGES", 100, 10000),
  };
}
