import { describe, expect, it } from "vitest";
import type { ProfileCapabilities } from "../../lib/contract/types.js";
import {
  createHomeAssistantDiscovery,
  HOME_ASSISTANT_STATUS_TOPIC,
  HomeAssistantDiscoveryPublisher,
  TELEMETRY_EXPIRY_SECONDS,
} from "../../lib/publisher/discovery.js";

const profile: ProfileCapabilities = {
  source: "simulator",
  cell_count: 4,
  cell_channels: [0, 1, 2, 3],
  temperature_sensor_count: 2,
  temperature_sensor_channels: [0, 1],
  supported_fields: [
    "balancing_mask",
    "bms_state",
    "bms_state_code",
    "cell_temperature_max",
    "cell_temperatures",
    "cell_voltage_avg_reported",
    "cell_voltage_delta",
    "cell_voltage_max_reported",
    "cell_voltage_min_reported",
    "cell_voltages",
    "component_temperature_max",
    "error_flags",
    "faults",
    "ic_temperature",
    "mosfet_temperature",
    "pack_current",
    "pack_voltage_reported",
    "soc",
    "stack_voltage_reported",
  ],
};

class FakeDiscoveryTransport {
  connected = true;
  subscriptions: Array<{ topic: string; options: { qos: 1 } }> = [];
  publications: Array<{
    topic: string;
    payload: string;
    options: { qos: 1; retain: true };
  }> = [];
  listener?: (topic: string, payload: Buffer) => void;

  async subscribeAsync(topic: string, options: { qos: 1 }) {
    this.subscriptions.push({ topic, options });
    return { granted: [{ qos: 1 }] };
  }

  async publishAsync(
    topic: string,
    payload: string,
    options: { qos: 1; retain: true },
  ) {
    this.publications.push({ topic, payload, options });
  }

  on(event: "message", listener: (topic: string, payload: Buffer) => void) {
    expect(event).toBe("message");
    this.listener = listener;
  }

  message(topic: string, payload: string) {
    this.listener?.(topic, Buffer.from(payload));
  }
}

describe("Home Assistant MQTT device discovery", () => {
  it("uses the contract discovery topic and required root metadata", () => {
    const result = createHomeAssistantDiscovery(profileNode, profile);
    expect(result.topic).toBe(`homeassistant/device/${profileNode}/config`);
    expect(result.payload).toMatchObject({
      device: {
        identifiers: [`libre_solar_bms_${profileNode}`],
        name: `Libre Solar BMS (simulated) ${profileNode}`,
        manufacturer: "Simulator",
        model: "Battery Management System",
        serial_number: profileNode,
      },
      origin: {
        name: "Libre Solar BMS Monitoring Gateway",
        sw_version: "0.1.0",
      },
      state_topic: `libresolar/bms/v1/${profileNode}/telemetry`,
      qos: 0,
      availability: [
        {
          topic: `libresolar/bms/v1/${profileNode}/availability`,
          payload_available: "online",
          payload_not_available: "offline",
        },
      ],
    });
  });

  it("distinguishes simulated and hardware devices without changing identity", () => {
    const simulated = createHomeAssistantDiscovery(profileNode, profile);
    const hardware = createHomeAssistantDiscovery(profileNode, {
      ...profile,
      source: "hardware",
    });
    expect(hardware.payload.device).toMatchObject({
      name: `Libre Solar BMS ${profileNode}`,
      manufacturer: "Libre Solar",
      identifiers: [`libre_solar_bms_${profileNode}`],
    });
    expect(hardware.topic).toBe(simulated.topic);
    expect(Object.keys(hardware.payload.components as object)).toEqual(
      Object.keys(simulated.payload.components as object),
    );
  });

  it("creates stable unique components for each configured demo measurement", () => {
    const first = createHomeAssistantDiscovery(profileNode, profile);
    const afterRestart = createHomeAssistantDiscovery(profileNode, profile);
    expect(first).toEqual(afterRestart);
    const components = first.payload.components as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(components)).toHaveLength(16);
    expect(
      new Set(Object.values(components).map((item) => item.unique_id)).size,
    ).toBe(16);
    expect(components.state_of_charge).toMatchObject({
      p: "sensor",
      unique_id: `libre_solar_bms_${profileNode.toLowerCase()}_state_of_charge`,
      default_entity_id: `sensor.libre_solar_bms_${profileNode.toLowerCase()}_state_of_charge`,
      name: "State of Charge",
      device_class: "battery",
      state_class: "measurement",
      unit_of_measurement: "%",
    });
    expect(components.pack_voltage_reported).toMatchObject({
      name: "Pack Voltage (Reported)",
      device_class: "voltage",
      unit_of_measurement: "V",
    });
    expect(components.stack_voltage_reported).toMatchObject({
      name: "Stack Voltage (Reported)",
      device_class: "voltage",
      unit_of_measurement: "V",
    });
    expect(components.pack_current!.value_template).toBe(
      "{{ value_json.pack_current }}",
    );
  });

  it("maps cell and battery temperature logical indices through profile channels", () => {
    const components = createHomeAssistantDiscovery(profileNode, profile)
      .payload.components as Record<string, Record<string, unknown>>;
    expect(components.cell_voltage_1).toMatchObject({
      name: "Cell Voltage 1 (channel 0)",
      value_template: "{{ value_json.cell_voltages[0] }}",
      device_class: "voltage",
      unit_of_measurement: "V",
    });
    expect(components.cell_voltage_4).toMatchObject({
      name: "Cell Voltage 4 (channel 3)",
      value_template: "{{ value_json.cell_voltages[3] }}",
    });
    expect(components.battery_temperature_2).toMatchObject({
      name: "Battery Temperature 2 (channel 1)",
      value_template: "{{ value_json.cell_temperatures[1] }}",
      device_class: "temperature",
      unit_of_measurement: "°C",
    });
    expect(components.ic_temperature!.name).toBe("IC Temperature");
    expect(components.mosfet_temperature!.name).toBe("MOSFET Temperature");
    expect(components.cell_voltage_imbalance).toMatchObject({
      name: "Cell Voltage Imbalance",
      value_template: "{{ value_json.cell_voltage_delta }}",
      unit_of_measurement: "V",
      state_class: "measurement",
    });
  });

  it("expires every telemetry entity and leaves nulls unknown, not numeric zero", () => {
    const components = createHomeAssistantDiscovery(profileNode, profile)
      .payload.components as Record<string, Record<string, unknown>>;
    expect(TELEMETRY_EXPIRY_SECONDS).toBe(15);
    for (const component of Object.values(components))
      expect(component.expire_after).toBe(15);
    expect(components.cell_voltage_1!.value_template).toContain(
      "value_json.cell_voltages[0]",
    );
    expect(components.cell_voltage_1!.value_template).not.toContain("default");
    expect(components.battery_temperature_1!.value_template).toContain(
      "value_json.cell_temperatures[0]",
    );
    expect(components.bms_state!.value_template).toContain("'None'");
    expect(components.active_faults!.value_template).toContain(
      "value_json.faults is none",
    );
  });

  it("maps active, clear and unavailable fault masks to on, off and unknown", () => {
    const components = createHomeAssistantDiscovery(profileNode, profile)
      .payload.components as Record<string, Record<string, unknown>>;
    const status = components.problem_status!;
    expect(status).toMatchObject({
      p: "binary_sensor",
      device_class: "problem",
      payload_on: "ON",
      payload_off: "OFF",
      expire_after: 15,
    });
    const template = String(status.value_template);
    expect(template).toContain("value_json.error_flags != 0");
    expect(template).toContain("value_json.error_flags == 0");
    expect(template).toContain("'None'");
    expect(components.active_faults!.value_template).toContain("join(', ')");
  });

  it("omits unsupported values and sizes arrays for the active profile", () => {
    const limited: ProfileCapabilities = {
      ...profile,
      cell_count: 2,
      cell_channels: [4, 1],
      temperature_sensor_count: 0,
      temperature_sensor_channels: [],
      supported_fields: ["cell_voltages", "pack_current"],
    };
    const components = createHomeAssistantDiscovery(profileNode, limited)
      .payload.components as Record<string, Record<string, unknown>>;
    expect(Object.keys(components).sort()).toEqual([
      "cell_voltage_1",
      "cell_voltage_2",
      "pack_current",
    ]);
    expect(components.cell_voltage_1!.name).toContain("channel 4");
    expect(components.cell_voltage_2!.value_template).toBe(
      "{{ value_json.cell_voltages[1] }}",
    );
    expect(JSON.stringify(components)).not.toMatch(
      /MCU|SoH|cycle_count|shunt/i,
    );
  });

  it("publishes read-only sensor platforms only with no command topics", () => {
    const document = createHomeAssistantDiscovery(profileNode, profile);
    const wire = JSON.stringify(document.payload);
    const components = document.payload.components as Record<
      string,
      Record<string, unknown>
    >;
    expect(
      Object.values(components).every((item) =>
        ["sensor", "binary_sensor"].includes(String(item.p)),
      ),
    ).toBe(true);
    expect(wire).not.toMatch(
      /command_topic|cmd_t|\/set|platform":"switch|platform":"button|platform":"number|platform":"select/i,
    );
  });

  it("publishes retained discovery and republishes after HA birth and reconnect", async () => {
    const transport = new FakeDiscoveryTransport();
    const document = createHomeAssistantDiscovery(profileNode, profile);
    const publisher = new HomeAssistantDiscoveryPublisher(transport, document);
    await publisher.onConnect();
    expect(transport.subscriptions).toEqual([
      { topic: HOME_ASSISTANT_STATUS_TOPIC, options: { qos: 1 } },
    ]);
    expect(transport.publications).toHaveLength(1);
    expect(transport.publications[0]).toMatchObject({
      topic: document.topic,
      options: { qos: 1, retain: true },
    });
    transport.message(HOME_ASSISTANT_STATUS_TOPIC, "offline");
    await Promise.resolve();
    expect(transport.publications).toHaveLength(1);
    transport.message(HOME_ASSISTANT_STATUS_TOPIC, "online");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.publications).toHaveLength(2);
    expect(JSON.parse(transport.publications[1]!.payload)).toEqual(
      document.payload,
    );
    transport.connected = false;
    transport.connected = true;
    await publisher.onConnect();
    expect(transport.subscriptions).toHaveLength(2);
    expect(transport.publications).toHaveLength(3);
    expect(transport.publications.map((item) => item.topic)).toEqual([
      document.topic,
      document.topic,
      document.topic,
    ]);
  });

  it("separates device and entity identities by node and removes unsupported channels", () => {
    const otherNode = createHomeAssistantDiscovery("53494D0000000002", profile);
    const original = createHomeAssistantDiscovery(profileNode, profile);
    expect(otherNode.topic).not.toBe(original.topic);
    expect(otherNode.payload.device).not.toEqual(original.payload.device);
    const smallerProfile = createHomeAssistantDiscovery(profileNode, {
      ...profile,
      cell_count: 1,
      cell_channels: [0],
      temperature_sensor_count: 1,
      temperature_sensor_channels: [1],
    });
    const smaller = smallerProfile.payload.components as Record<
      string,
      Record<string, unknown>
    >;
    expect(smaller.cell_voltage_1).toBeDefined();
    expect(smaller.cell_voltage_2).toBeUndefined();
    expect(smaller.battery_temperature_1!.name).toContain("channel 1");
  });

  it("rejects invalid discovery identities and layouts", () => {
    expect(() => createHomeAssistantDiscovery("bad-node", profile)).toThrow(
      /node ID/,
    );
    expect(() =>
      createHomeAssistantDiscovery(profileNode, {
        ...profile,
        cell_channels: [0],
      }),
    ).toThrow(/profile layout/);
    expect(() =>
      createHomeAssistantDiscovery(profileNode, {
        ...profile,
        supported_fields: [],
      }),
    ).toThrow(/no supported/);
  });
});

const profileNode = "53494D0000000001";
