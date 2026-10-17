import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [configDirectory, nodeId] = process.argv.slice(2);
if (!configDirectory || !/^[0-9A-F]{16}$/.test(nodeId ?? "")) {
  process.stderr.write(
    "Usage: node scripts/check-home-assistant-registry.mjs <ha-config-directory> <16-character-node-id>\n",
  );
  process.exit(2);
}

async function readRegistry(name) {
  const file = resolve(configDirectory, ".storage", name);
  const parsed = JSON.parse(await readFile(file, "utf8"));
  if (parsed?.data === undefined)
    throw new Error(`Invalid Home Assistant registry ${name}`);
  return parsed.data;
}

const nodeKey = nodeId.toLowerCase();
const [entities, devices] = await Promise.all([
  readRegistry("core.entity_registry"),
  readRegistry("core.device_registry"),
]);
const uniquePrefix = `libre_solar_bms_${nodeKey}_`;
const matchingEntities = entities.entities.filter((entity) =>
  entity.unique_id?.startsWith(uniquePrefix),
);
const matchingDevices = devices.devices.filter((device) =>
  (device.identifiers ?? []).some((identifier) =>
    Array.isArray(identifier)
      ? identifier.includes(`libre_solar_bms_${nodeId}`)
      : identifier === `libre_solar_bms_${nodeId}`,
  ),
);
const uniqueIds = matchingEntities.map((entity) => entity.unique_id);
const domains = [
  ...new Set(matchingEntities.map((entity) => entity.entity_id.split(".")[0])),
].sort();
const controls = matchingEntities.filter((entity) =>
  ["button", "number", "select", "switch"].includes(
    entity.entity_id.split(".")[0],
  ),
);
const result = {
  result:
    matchingDevices.length === 1 &&
    new Set(uniqueIds).size === uniqueIds.length &&
    controls.length === 0
      ? "passed"
      : "failed",
  node_id: nodeId,
  device_count: matchingDevices.length,
  entity_count: matchingEntities.length,
  unique_id_count: new Set(uniqueIds).size,
  domains,
  control_entity_count: controls.length,
  unique_ids: uniqueIds.sort(),
};
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.result !== "passed") process.exitCode = 1;
