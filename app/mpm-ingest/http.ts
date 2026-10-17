import type {
  Attributes,
  FaultEvent,
  Summary,
} from "../../lib/contract/index.js";
import type { AdapterConfig } from "./config.js";

export type DeliveryKind = "summary" | "event" | "attributes";
export type DeliveryPayload = Summary | FaultEvent | Attributes;
export type DeliveryOutcome = {
  result:
    | "accepted"
    | "duplicate"
    | "ignored_stale"
    | "configuration_error"
    | "quarantine_required"
    | "delivery_failed";
  code?: string;
  httpStatus?: number;
};
const routes: Record<DeliveryKind, string> = {
  summary: "summaries",
  event: "events",
  attributes: "attributes",
};

export class MpmClient {
  constructor(
    private readonly config: Pick<
      AdapterConfig,
      "mpmBaseUrl" | "mpmApiKey" | "httpTimeoutMs"
    >,
  ) {}

  async deliver(
    kind: DeliveryKind,
    payload: DeliveryPayload,
  ): Promise<DeliveryOutcome> {
    try {
      const response = await fetch(
        `${this.config.mpmBaseUrl}/api/libre-solar-bms/ingest/${routes[kind]}`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${this.config.mpmApiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.config.httpTimeoutMs),
        },
      );
      if (response.status !== 200) {
        await response.body?.cancel();
        const result = [401, 403, 415].includes(response.status)
          ? "configuration_error"
          : [404, 409, 413, 422].includes(response.status)
            ? "quarantine_required"
            : "delivery_failed";
        return {
          result,
          httpStatus: response.status,
          code: `http_${response.status}`,
        };
      }
      if (
        !/^application\/json(?:\s*;|\s*$)/i.test(
          response.headers.get("content-type") ?? "",
        )
      ) {
        await response.body?.cancel();
        return { result: "delivery_failed", code: "invalid_response" };
      }
      const reader = response.body?.getReader();
      if (!reader)
        return { result: "delivery_failed", code: "invalid_response" };
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 32768) {
          await reader.cancel();
          return { result: "delivery_failed", code: "oversized_response" };
        }
        chunks.push(chunk.value);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        typeof body !== "object" ||
        body === null ||
        !("message_id" in body) ||
        body.message_id !== payload.message_id ||
        !("result" in body)
      )
        return { result: "delivery_failed", code: "invalid_response" };
      if (body.result === "accepted" || body.result === "duplicate")
        return { result: body.result };
      if (body.result === "ignored_stale" && kind !== "event")
        return { result: "ignored_stale" };
      return { result: "delivery_failed", code: "invalid_response" };
    } catch {
      // Never emit fetch errors: their URLs or server text can contain secrets.
      return { result: "delivery_failed", code: "network_or_response_error" };
    }
  }
}
