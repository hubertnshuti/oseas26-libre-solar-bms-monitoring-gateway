import { describe, expect, it } from "vitest";
import { readConfig } from "../../app/mpm-ingest/config.js";

const settings = {
  MQTT_URL: "mqtt://127.0.0.1:1883",
  MQTT_USERNAME: "demo",
  MQTT_PASSWORD: "test-password",
  MPM_BASE_URL: "http://127.0.0.1:8000",
  MPM_API_KEY: "test-key",
  MPM_COMPANY_BINDING: "demo-company",
  BMS_ADAPTER_ID: "demo-adapter",
  BMS_NODE_IDS: "53494D0000000001",
};

describe("adapter configuration", () => {
  it("loads one explicit company binding with safe defaults", () => {
    expect(readConfig(settings)).toMatchObject({
      companyBinding: "demo-company",
      nodeIds: ["53494D0000000001"],
      httpTimeoutMs: 10000,
      maxPendingMessages: 100,
    });
  });
  for (const name of Object.keys(settings)) {
    it(`fails clearly when ${name} is absent`, () => {
      expect(() => readConfig({ ...settings, [name]: "" })).toThrow(name);
    });
  }
  it.each([
    ["BMS_NODE_IDS", "lowercase"],
    ["BMS_NODE_IDS", "53494D0000000001,53494D0000000001"],
    ["MPM_HTTP_TIMEOUT_MS", "0"],
    ["MPM_HTTP_TIMEOUT_MS", "Infinity"],
    ["BMS_MAX_PENDING_MESSAGES", "10001"],
    ["MPM_BASE_URL", "http://user:secret@localhost"],
    ["MPM_BASE_URL", "http://localhost/api"],
    ["MQTT_URL", "https://localhost"],
    ["BMS_ADAPTER_ID", "../../private"],
    ["MPM_API_KEY", "secret\r\nheader"],
  ])("rejects unsafe %s without echoing its value", (name, value) => {
    try {
      readConfig({ ...settings, [name]: value });
      throw new Error("Unexpected acceptance");
    } catch (error) {
      expect((error as Error).message).toContain(name);
      expect((error as Error).message).not.toContain(value);
    }
  });
});
