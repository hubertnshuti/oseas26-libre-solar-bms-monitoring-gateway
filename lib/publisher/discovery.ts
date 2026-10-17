import type { ProfileCapabilities } from "../contract/types.js";
import { availabilityTopic, producerTopic } from "./topics.js";

export const HOME_ASSISTANT_STATUS_TOPIC = "homeassistant/status";
export const TELEMETRY_EXPIRY_SECONDS = 15;

export interface HomeAssistantDiscoveryDocument {
  topic: string;
  payload: Record<string, unknown>;
}

export interface HomeAssistantDiscoveryTransport {
  readonly connected: boolean;
  publishAsync(
    topic: string,
    payload: string,
    options: { qos: 1; retain: true },
  ): Promise<unknown>;
  subscribeAsync(topic: string, options: { qos: 1 }): Promise<unknown>;
  on(
    event: "message",
    listener: (topic: string, payload: Buffer) => void,
  ): unknown;
}

type Component = Record<string, unknown> & {
  p: "sensor" | "binary_sensor";
  unique_id: string;
  name: string;
};

export function createHomeAssistantDiscovery(
  nodeId: string,
  profile: ProfileCapabilities,
  options: { softwareVersion?: string } = {},
): HomeAssistantDiscoveryDocument {
  if (!/^[0-9A-F]{16}$/.test(nodeId))
    throw new Error("Invalid node ID for Home Assistant discovery");
  if (
    profile.cell_count < 0 ||
    profile.temperature_sensor_count < 0 ||
    profile.cell_channels.length !== profile.cell_count ||
    profile.temperature_sensor_channels.length !==
      profile.temperature_sensor_count
  )
    throw new Error("Invalid profile layout for Home Assistant discovery");

  const prefix = `libresolar/bms/v1/${nodeId}`;
  const nodeKey = nodeId.toLowerCase();
  const components: Record<string, Component> = {};
  const fields = new Set(profile.supported_fields);
  const addNumeric = (
    id: string,
    name: string,
    template: string,
    unit: string,
    deviceClass: string,
    precision = 2,
  ) => {
    components[id] = {
      p: "sensor",
      unique_id: `libre_solar_bms_${nodeKey}_${id}`,
      default_entity_id: `sensor.libre_solar_bms_${nodeKey}_${id}`,
      name,
      value_template: template,
      device_class: deviceClass,
      state_class: "measurement",
      unit_of_measurement: unit,
      suggested_display_precision: precision,
      expire_after: TELEMETRY_EXPIRY_SECONDS,
    };
  };
  const addText = (id: string, name: string, template: string) => {
    components[id] = {
      p: "sensor",
      unique_id: `libre_solar_bms_${nodeKey}_${id}`,
      default_entity_id: `sensor.libre_solar_bms_${nodeKey}_${id}`,
      name,
      value_template: template,
      expire_after: TELEMETRY_EXPIRY_SECONDS,
    };
  };

  if (fields.has("soc"))
    addNumeric(
      "state_of_charge",
      "State of Charge",
      "{{ value_json.soc }}",
      "%",
      "battery",
      1,
    );
  if (fields.has("pack_voltage_reported"))
    addNumeric(
      "pack_voltage_reported",
      "Pack Voltage (Reported)",
      "{{ value_json.pack_voltage_reported }}",
      "V",
      "voltage",
      2,
    );
  if (fields.has("stack_voltage_reported"))
    addNumeric(
      "stack_voltage_reported",
      "Stack Voltage (Reported)",
      "{{ value_json.stack_voltage_reported }}",
      "V",
      "voltage",
      2,
    );
  if (fields.has("pack_current"))
    addNumeric(
      "pack_current",
      "Pack Current",
      "{{ value_json.pack_current }}",
      "A",
      "current",
      2,
    );
  if (fields.has("cell_voltages"))
    profile.cell_channels.forEach((channel, index) =>
      addNumeric(
        `cell_voltage_${index + 1}`,
        `Cell Voltage ${index + 1} (channel ${channel})`,
        `{{ value_json.cell_voltages[${index}] }}`,
        "V",
        "voltage",
        3,
      ),
    );
  if (fields.has("cell_temperatures"))
    profile.temperature_sensor_channels.forEach((channel, index) =>
      addNumeric(
        `battery_temperature_${index + 1}`,
        `Battery Temperature ${index + 1} (channel ${channel})`,
        `{{ value_json.cell_temperatures[${index}] }}`,
        "°C",
        "temperature",
        1,
      ),
    );
  if (fields.has("ic_temperature"))
    addNumeric(
      "ic_temperature",
      "IC Temperature",
      "{{ value_json.ic_temperature }}",
      "°C",
      "temperature",
      1,
    );
  if (fields.has("mosfet_temperature"))
    addNumeric(
      "mosfet_temperature",
      "MOSFET Temperature",
      "{{ value_json.mosfet_temperature }}",
      "°C",
      "temperature",
      1,
    );
  if (fields.has("cell_voltage_delta"))
    addNumeric(
      "cell_voltage_imbalance",
      "Cell Voltage Imbalance",
      "{{ value_json.cell_voltage_delta }}",
      "V",
      "voltage",
      3,
    );
  if (fields.has("bms_state"))
    addText(
      "bms_state",
      "BMS State",
      "{{ value_json.bms_state if value_json.bms_state is not none else 'None' }}",
    );
  if (fields.has("faults"))
    addText(
      "active_faults",
      "Active Faults",
      "{{ 'None' if value_json.faults is none else ('No active faults' if value_json.faults | length == 0 else value_json.faults | join(', ')) }}",
    );
  if (fields.has("error_flags"))
    components.problem_status = {
      p: "binary_sensor",
      unique_id: `libre_solar_bms_${nodeKey}_problem_status`,
      default_entity_id: `binary_sensor.libre_solar_bms_${nodeKey}_problem_status`,
      name: "Problem Status",
      device_class: "problem",
      payload_on: "ON",
      payload_off: "OFF",
      value_template:
        "{{ 'ON' if value_json.error_flags is not none and value_json.error_flags != 0 else 'OFF' if value_json.error_flags == 0 else 'None' }}",
      expire_after: TELEMETRY_EXPIRY_SECONDS,
    };

  if (Object.keys(components).length === 0)
    throw new Error("Profile has no supported Home Assistant entities");

  return {
    topic: `homeassistant/device/${nodeId}/config`,
    payload: {
      device: {
        identifiers: [`libre_solar_bms_${nodeId}`],
        name: `Libre Solar BMS ${profile.source === "simulator" ? "(simulated) " : ""}${nodeId}`,
        manufacturer:
          profile.source === "simulator" ? "Simulator" : "Libre Solar",
        model: "Battery Management System",
        serial_number: nodeId,
      },
      origin: {
        name: "Libre Solar BMS Monitoring Gateway",
        sw_version: options.softwareVersion ?? "0.1.0",
      },
      state_topic: producerTopic(nodeId, "telemetry"),
      qos: 0,
      availability: [
        {
          topic: availabilityTopic(nodeId),
          payload_available: "online",
          payload_not_available: "offline",
        },
      ],
      components,
    },
  };
}

export class HomeAssistantDiscoveryPublisher {
  private subscribed = false;
  private publishing: Promise<void> = Promise.resolve();

  constructor(
    private readonly transport: HomeAssistantDiscoveryTransport,
    private readonly document: HomeAssistantDiscoveryDocument,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {
    this.transport.on("message", (topic, payload) => {
      if (
        topic === HOME_ASSISTANT_STATUS_TOPIC &&
        payload.toString("utf8").trim() === "online"
      ) {
        void this.publish().catch(this.onError);
      }
    });
  }

  async onConnect(): Promise<void> {
    const result = await this.transport.subscribeAsync(
      HOME_ASSISTANT_STATUS_TOPIC,
      { qos: 1 },
    );
    const grants = (result as { granted?: Array<{ qos: number }> })?.granted;
    if (grants?.some((grant) => grant.qos === 128))
      throw new Error("Broker denied the Home Assistant status subscription");
    this.subscribed = true;
    await this.publish();
  }

  async publish(): Promise<void> {
    const next = this.publishing.then(async () => {
      if (!this.transport.connected)
        throw new Error("Cannot publish discovery while MQTT is disconnected");
      await this.transport.publishAsync(
        this.document.topic,
        JSON.stringify(this.document.payload),
        { qos: 1, retain: true },
      );
    });
    this.publishing = next.catch(() => undefined);
    return next;
  }

  get isSubscribed(): boolean {
    return this.subscribed;
  }
}
