export type MessageKind =
  "telemetry" | "summary" | "event" | "attributes" | "status" | "event-receipt";
export type Source = "simulator" | "hardware";
export type QualityReason =
  | "unsupported"
  | "not_reported"
  | "invalid_type"
  | "non_finite"
  | "incomplete"
  | "source_error";
export type Quality = Record<string, QualityReason>;

export interface ProducerEnvelope {
  schema_version: 1;
  node_id: string;
  source: Source;
  session_id: string;
  sequence: number;
  message_id: string;
  observed_at: string;
  published_at: string;
  clock_source: "simulator_host" | "gateway_host" | "device";
}

export interface Metrics {
  soc: number | null;
  soh: null;
  cycle_count: null;
  cell_voltage_delta: number | null;
  cell_temperature_max: number | null;
  component_temperature_max: number | null;
  bms_state_code: number | null;
  bms_state: "OFF" | "CHG" | "DIS" | "NORMAL" | "SHUTDOWN" | "unknown" | null;
  error_flags: number | null;
  faults: string[] | null;
  quality: Quality;
}

export interface Telemetry extends ProducerEnvelope, Metrics {
  pack_voltage_reported: number | null;
  stack_voltage_reported: number | null;
  pack_current: number | null;
  cell_voltage_min_reported: number | null;
  cell_voltage_max_reported: number | null;
  cell_voltage_avg_reported: number | null;
  cell_voltages: (number | null)[];
  cell_temperatures: (number | null)[];
  ic_temperature: number | null;
  mosfet_temperature: number | null;
  shunt_temperature: number | null;
  balancing_mask: number | null;
}

export interface Summary extends ProducerEnvelope, Metrics {
  telemetry_message_id: string;
  last_source_observed_at: string;
}

export interface FaultEvent extends ProducerEnvelope {
  event_id: string;
  telemetry_message_id: string;
  kind: "fault_observed" | "fault_changed" | "observation_gap";
  previous_error_flags: number | null;
  current_error_flags: number | null;
  faults: string[] | null;
  added_faults: string[];
  cleared_faults: string[];
}

export interface Attributes extends ProducerEnvelope {
  manufacturer: string;
  device_type: string;
  hardware_version: string;
  firmware_version: string;
  firmware_reference: string;
  profile_id: string;
  chemistry: string;
  capacity_ah: number;
  cell_count: number;
  cell_channels: number[];
  temperature_sensor_count: number;
  temperature_sensor_channels: number[];
  supported_fields: string[];
  simulation_time_factor: number | null;
}

export interface SourceStatus {
  schema_version: 1;
  node_id: string;
  source: Source;
  message_id: string;
  adapter_id: string;
  status_revision: number;
  source_status: "unknown" | "fresh" | "stale" | "disconnected";
  last_source_observed_at: string | null;
  status_checked_at: string;
}

export interface EventReceipt {
  schema_version: 1;
  node_id: string;
  source: Source;
  message_id: string;
  event_id: string;
  consumer_id: string;
  status: "stored";
}

export interface Payloads {
  telemetry: Telemetry;
  summary: Summary;
  event: FaultEvent;
  attributes: Attributes;
  status: SourceStatus;
  "event-receipt": EventReceipt;
}

/** Capabilities must come from a reviewed profile or validated attributes. */
export interface ProfileCapabilities {
  source: Source;
  cell_count: number;
  cell_channels: number[];
  temperature_sensor_count: number;
  temperature_sensor_channels: number[];
  supported_fields: string[];
}
