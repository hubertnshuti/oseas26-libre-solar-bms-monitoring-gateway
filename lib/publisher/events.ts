import { decodeFaults } from "../libresolar/index.js";
import type { Telemetry } from "../contract/types.js";
import type { FaultEventTransition } from "./client.js";

export class FaultEventDetector {
  private lastObservedAt?: number;
  private lastKnownMask: number | null = null;

  constructor(private readonly gapMs = 15_000) {
    if (!Number.isSafeInteger(gapMs) || gapMs < 1)
      throw new Error("gapMs must be a positive safe integer");
  }

  observe(telemetry: Telemetry): FaultEventTransition | undefined {
    const observed = Date.parse(telemetry.observed_at);
    if (!Number.isFinite(observed)) throw new Error("Invalid telemetry time");
    const gap =
      this.lastObservedAt !== undefined &&
      observed - this.lastObservedAt > this.gapMs;
    this.lastObservedAt = observed;
    const current = telemetry.error_flags;
    const faults = current === null ? null : decodeFaults(current);

    if (gap) {
      this.lastKnownMask = current;
      return {
        kind: "observation_gap",
        previousErrorFlags: null,
        currentErrorFlags: current,
        faults,
        addedFaults: [],
        clearedFaults: [],
      };
    }
    if (current === null) {
      // Unavailable is unknown; the next known value is a first observation.
      this.lastKnownMask = null;
      return undefined;
    }
    if (this.lastKnownMask === null) {
      this.lastKnownMask = current;
      if (current === 0) return undefined;
      return {
        kind: "fault_observed",
        previousErrorFlags: null,
        currentErrorFlags: current,
        faults,
        addedFaults: faults ?? [],
        clearedFaults: [],
      };
    }
    const previous = this.lastKnownMask;
    this.lastKnownMask = current;
    if (previous === current) return undefined;
    const previousFaults = decodeFaults(previous) ?? [];
    const currentFaults = faults ?? [];
    return {
      kind: "fault_changed",
      previousErrorFlags: previous,
      currentErrorFlags: current,
      faults,
      addedFaults: currentFaults.filter(
        (fault) => !previousFaults.includes(fault),
      ),
      clearedFaults: previousFaults.filter(
        (fault) => !currentFaults.includes(fault),
      ),
    };
  }
}
