import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  validateMessage,
  type Telemetry,
  type Attributes,
} from "../../lib/contract/index.js";
import type { DeliveryKind, DeliveryPayload } from "./http.js";

export interface RecordEntry {
  kind: DeliveryKind;
  payload: DeliveryPayload;
  state: "pending" | "quarantined" | "completed";
  attempts: number;
  nextAttempt: number;
  code?: string;
}
export interface StoredState {
  version: 1;
  binding: string;
  entries: RecordEntry[];
  sessions: Record<string, string>;
  revisions: Record<string, number>;
  checkedAt: Record<string, string>;
  profiles: Record<string, Attributes>;
  observations: Record<
    string,
    Pick<Telemetry, "session_id" | "sequence" | "observed_at">
  >;
}

// Sort object keys, preserving arrays, so MQTT JSON key order cannot create a conflict.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export class DeliveryStore {
  private constructor(
    readonly path: string,
    private database: DatabaseSync,
    private binding: string,
  ) {}

  static async open(path: string, binding: string): Promise<DeliveryStore> {
    path = resolve(path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(path);
    try {
      database.exec(
        "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
      );
      database.exec(
        "CREATE TABLE IF NOT EXISTS delivery_state (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL)",
      );
      database
        .prepare(
          "INSERT OR IGNORE INTO delivery_state (id, data) VALUES (1, ?)",
        )
        .run(
          JSON.stringify({
            version: 1,
            binding,
            entries: [],
            sessions: {},
            revisions: {},
            checkedAt: {},
            profiles: {},
            observations: {},
          }),
        );
      const store = new DeliveryStore(path, database, binding);
      store.snapshot();
      return store;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  snapshot(): StoredState {
    const row = this.database
      .prepare("SELECT data FROM delivery_state WHERE id = 1")
      .get();
    const state = JSON.parse(row!.data as string) as StoredState;
    this.validate(state);
    return state;
  }

  private validate(state: StoredState): void {
    if (
      !state ||
      typeof state !== "object" ||
      state.version !== 1 ||
      state.binding !== this.binding ||
      !Array.isArray(state.entries) ||
      !state.sessions ||
      !state.revisions ||
      !state.observations ||
      !state.profiles ||
      !state.checkedAt ||
      Object.values(state.checkedAt).some(
        (value) => !Number.isFinite(Date.parse(value)),
      ) ||
      Object.values(state.revisions).some(
        (value) => !Number.isSafeInteger(value) || value < 0,
      ) ||
      Object.entries(state.profiles).some(
        ([key, value]) =>
          !validateMessage("attributes", value).valid ||
          key !== `${value.node_id}:${value.session_id}`,
      ) ||
      state.entries.some(
        (entry) =>
          !["summary", "event", "attributes", "status"].includes(entry.kind) ||
          !validateMessage(entry.kind, entry.payload).valid ||
          !["pending", "quarantined", "completed"].includes(entry.state) ||
          !Number.isSafeInteger(entry.attempts) ||
          entry.attempts < 0 ||
          !Number.isFinite(entry.nextAttempt),
      )
    ) {
      throw new Error(
        "Invalid delivery store or changed binding; preserve the file and reconcile configuration",
      );
    }
  }

  async transaction<T>(change: (state: StoredState) => T): Promise<T> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const next = this.snapshot();
      const result = change(next);
      this.validate(next);
      this.database
        .prepare("UPDATE delivery_state SET data = ? WHERE id = 1")
        .run(JSON.stringify(next));
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}
