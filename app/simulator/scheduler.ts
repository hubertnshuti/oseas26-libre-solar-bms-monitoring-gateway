export const TELEMETRY_INTERVAL_MS = 1000;

export interface TelemetryScheduler {
  every(callback: () => void, intervalMs: number): () => void;
}

const systemScheduler: TelemetryScheduler = {
  every(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs);
    return () => clearInterval(timer);
  },
};

export function startTelemetrySchedule(
  tick: () => void,
  scheduler: TelemetryScheduler = systemScheduler,
): () => void {
  return scheduler.every(tick, TELEMETRY_INTERVAL_MS);
}
