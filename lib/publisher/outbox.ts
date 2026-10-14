import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { validateMessage } from "../contract/validate.js";
import type { FaultEvent, ProfileCapabilities } from "../contract/types.js";

interface PersistedOutbox {
  version: 1;
  node_id: string;
  pending: FaultEvent[];
}

export class OutboxCapacityError extends Error {
  constructor(readonly capacity: number) {
    super(`Fault event outbox is full (capacity ${capacity})`);
    this.name = "OutboxCapacityError";
  }
}

export class DurableEventOutbox {
  readonly path: string;
  private pendingEvents: FaultEvent[] = [];
  private writeTail: Promise<void> = Promise.resolve();
  private readonly capacity: number;

  private constructor(
    path: string,
    private readonly nodeId: string,
    capacity: number,
    private readonly profile: ProfileCapabilities,
  ) {
    this.path = resolve(path);
    this.capacity = capacity;
  }

  static async open(options: {
    path: string;
    nodeId: string;
    capacity: number;
    profile: ProfileCapabilities;
  }): Promise<DurableEventOutbox> {
    if (!Number.isSafeInteger(options.capacity) || options.capacity < 1)
      throw new Error("Outbox capacity must be a positive safe integer");
    const outbox = new DurableEventOutbox(
      options.path,
      options.nodeId,
      options.capacity,
      options.profile,
    );
    let content: string;
    try {
      content = await readFile(outbox.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await outbox.persist([]);
      return outbox;
    }
    let state: unknown;
    try {
      state = JSON.parse(content);
    } catch {
      throw new Error(`Outbox file is corrupt; preserved at ${outbox.path}`);
    }
    if (!isPersistedOutbox(state) || state.node_id !== options.nodeId) {
      throw new Error(
        `Outbox file has invalid or mismatched identity: ${outbox.path}`,
      );
    }
    if (state.pending.length > options.capacity)
      throw new Error(
        `Outbox contains more events than configured capacity: ${outbox.path}`,
      );
    const ids = new Set<string>();
    for (const event of state.pending) {
      const checked = validateMessage("event", event, {
        topic: `libresolar/bms/v1/${options.nodeId}/events`,
        profile: options.profile,
      });
      if (!checked.valid || ids.has(event.event_id))
        throw new Error(
          `Outbox contains invalid or duplicate event: ${outbox.path}`,
        );
      ids.add(event.event_id);
    }
    outbox.pendingEvents = state.pending;
    return outbox;
  }

  list(): readonly FaultEvent[] {
    return this.pendingEvents.map((event) => structuredClone(event));
  }

  async enqueue(event: FaultEvent): Promise<void> {
    return this.serialize(async () => {
      const checked = validateMessage("event", event, {
        topic: `libresolar/bms/v1/${this.nodeId}/events`,
        profile: this.profile,
      });
      if (!checked.valid || event.node_id !== this.nodeId)
        throw new Error("Refusing invalid or cross-node event in outbox");
      const sameId = this.pendingEvents.find(
        (pending) => pending.event_id === event.event_id,
      );
      if (sameId) {
        if (JSON.stringify(sameId) !== JSON.stringify(event))
          throw new Error("Event ID conflict in outbox");
        return;
      }
      if (this.pendingEvents.length >= this.capacity)
        throw new OutboxCapacityError(this.capacity);
      const next = [...this.pendingEvents, structuredClone(event)];
      await this.persist(next);
      this.pendingEvents = next;
    });
  }

  async acknowledge(eventId: string): Promise<boolean> {
    return this.serialize(async () => {
      const index = this.pendingEvents.findIndex(
        (event) => event.event_id === eventId,
      );
      if (index < 0) return false;
      const next = this.pendingEvents.filter(
        (event) => event.event_id !== eventId,
      );
      await this.persist(next);
      this.pendingEvents = next;
      return true;
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(operation);
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async persist(pending: FaultEvent[]): Promise<void> {
    const directory = dirname(this.path);
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const state: PersistedOutbox = {
      version: 1,
      node_id: this.nodeId,
      pending,
    };
    let handle;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.path);
      const dir = await open(directory, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new Error(
        `Could not durably write event outbox ${this.path}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
}

function isPersistedOutbox(value: unknown): value is PersistedOutbox {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as PersistedOutbox).version === 1 &&
    typeof (value as PersistedOutbox).node_id === "string" &&
    Array.isArray((value as PersistedOutbox).pending)
  );
}
