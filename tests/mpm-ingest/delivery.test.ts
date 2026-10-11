import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Adapter } from "../../app/mpm-ingest/adapter.js";
import { MpmClient } from "../../app/mpm-ingest/http.js";

function fixture(name: string): Buffer {
  return readFileSync(new URL(`../fixtures/v1/${name}`, import.meta.url));
}
const summary = fixture("valid/normal.summary.json");
const nodeId = "53494D0000000001";
const topic = (suffix: string) => `libresolar/bms/v1/${nodeId}/${suffix}`;
const summaryId = JSON.parse(summary.toString()).message_id;

describe("validated adapter delivery to a local fake MPM HTTP server", () => {
  let server: Server;
  let adapter: Adapter;
  let status: number;
  let reply: string;
  let contentType: string;
  let requests: {
    url: string;
    authorization?: string;
    accept?: string;
    contentType?: string;
    body: unknown;
  }[];

  beforeEach(async () => {
    status = 200;
    reply = fixture("api/accepted.json").toString();
    contentType = "application/json";
    requests = [];
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({
        url: request.url!,
        authorization: request.headers.authorization,
        accept: request.headers.accept,
        contentType: request.headers["content-type"],
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      response.writeHead(status, { "Content-Type": contentType });
      response.end(reply);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No server port");
    adapter = new Adapter(
      { nodeIds: [nodeId], maxPendingMessages: 2 },
      new MpmClient({
        mpmBaseUrl: `http://127.0.0.1:${address.port}`,
        mpmApiKey: "local-test-key",
        httpTimeoutMs: 500,
      }),
    );
  });
  afterEach(async () => {
    await adapter?.drain();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("posts the exact summary, route and authentication headers", async () => {
    expect(await adapter.handle(topic("summary"), summary)).toEqual({
      result: "accepted",
      nodeId,
      messageId: summaryId,
    });
    expect(requests).toEqual([
      {
        url: "/api/libre-solar-bms/ingest/summaries",
        authorization: "Bearer local-test-key",
        accept: "application/json",
        contentType: "application/json",
        body: JSON.parse(summary.toString()),
      },
    ]);
    expect(requests[0]!.body).not.toHaveProperty("company_id");
  });
  it.each([
    [topic("summary"), Buffer.from("{")],
    [
      topic("summary"),
      Buffer.from(
        JSON.stringify({ ...JSON.parse(summary.toString()), soc: "74.2" }),
      ),
    ],
    ["libresolar/bms/v1/53494D0000000002/summary", summary],
    [topic("summary"), Buffer.alloc(32769)],
    [topic("status"), fixture("valid/fresh.status.json")],
  ])("does not write rejected input %s", async (incomingTopic, raw) => {
    expect((await adapter.handle(incomingTopic, raw)).result).toBe("rejected");
    expect(requests).toHaveLength(0);
  });
  it("rejects topic/payload mismatch even when both nodes are allowed", async () => {
    const other = new Adapter(
      { nodeIds: [nodeId, "53494D0000000002"], maxPendingMessages: 2 },
      {
        deliver: async () => {
          throw new Error("Must not send");
        },
      },
    );
    expect(
      await other.handle("libresolar/bms/v1/53494D0000000002/summary", summary),
    ).toMatchObject({ result: "rejected", code: "invalid_payload" });
  });
  it("observes telemetry and availability without HTTP writes", async () => {
    for (let sample = 0; sample < 20; sample++)
      expect(
        (
          await adapter.handle(
            topic("telemetry"),
            fixture("valid/normal.telemetry.json"),
          )
        ).result,
      ).toBe("observed");
    expect(
      (await adapter.handle(topic("availability"), Buffer.from("offline")))
        .result,
    ).toBe("observed");
    expect(
      (await adapter.handle(topic("availability"), Buffer.from("unknown")))
        .result,
    ).toBe("rejected");
    expect(requests).toHaveLength(0);
  });
  it("accepts identical-event duplicate outcome using the shared response fixture", async () => {
    reply = fixture("api/duplicate.json").toString();
    expect(
      (await adapter.handle(topic("events"), fixture("valid/fault.event.json")))
        .result,
    ).toBe("duplicate");
    expect(requests[0]!.url).toBe("/api/libre-solar-bms/ingest/events");
  });
  it("posts attributes without creating ownership fields", async () => {
    const raw = fixture("valid/demo.attributes.json");
    reply = JSON.stringify({
      result: "accepted",
      message_id: JSON.parse(raw.toString()).message_id,
    });
    expect((await adapter.handle(topic("attributes"), raw)).result).toBe(
      "accepted",
    );
    expect(requests[0]!.url).toBe("/api/libre-solar-bms/ingest/attributes");
    expect(requests[0]!.body).toEqual(JSON.parse(raw.toString()));
  });
  it("accepts a stale summary without changing its observation time", async () => {
    reply = fixture("api/stale.json").toString();
    expect((await adapter.handle(topic("summary"), summary)).result).toBe(
      "ignored_stale",
    );
    expect(requests[0]!.body).toEqual(JSON.parse(summary.toString()));
  });
  it("does not roll back current profile capabilities on an old attributes duplicate", async () => {
    const current = JSON.parse(
      fixture("valid/demo.attributes.json").toString(),
    );
    current.sequence = 10;
    current.message_id = `${nodeId}:${current.session_id}:attributes:10`;
    reply = JSON.stringify({
      result: "accepted",
      message_id: current.message_id,
    });
    expect(
      (
        await adapter.handle(
          topic("attributes"),
          Buffer.from(JSON.stringify(current)),
        )
      ).result,
    ).toBe("accepted");
    const older = JSON.parse(fixture("valid/demo.attributes.json").toString());
    older.cell_count = 2;
    older.cell_channels = [0, 1];
    reply = JSON.stringify({
      result: "duplicate",
      message_id: older.message_id,
    });
    expect(
      (
        await adapter.handle(
          topic("attributes"),
          Buffer.from(JSON.stringify(older)),
        )
      ).result,
    ).toBe("duplicate");
    expect(
      (
        await adapter.handle(
          topic("telemetry"),
          fixture("valid/normal.telemetry.json"),
        )
      ).result,
    ).toBe("observed");
    expect(requests).toHaveLength(2);
  });
  it.each([
    "{}",
    "not json",
    JSON.stringify({ result: "accepted", message_id: "wrong-id" }),
    JSON.stringify({ result: "unexpected", message_id: summaryId }),
    "x".repeat(32769),
  ])("never treats malformed success as accepted", async (body) => {
    reply = body;
    expect((await adapter.handle(topic("summary"), summary)).result).toBe(
      "delivery_failed",
    );
  });
  it("rejects a proxy HTML success", async () => {
    contentType = "text/html";
    reply = "<html>ok</html>";
    expect((await adapter.handle(topic("summary"), summary)).result).toBe(
      "delivery_failed",
    );
  });
  it("does not forward the company key across HTTP redirects", async () => {
    server.removeAllListeners("request");
    server.on("request", (_request, response) => {
      response.writeHead(302, { Location: "http://127.0.0.1:1/other" });
      response.end();
    });
    expect((await adapter.handle(topic("summary"), summary)).result).toBe(
      "delivery_failed",
    );
  });
  it("ends a stalled HTTP request at the configured timeout", async () => {
    server.removeAllListeners("request");
    server.on("request", () => {});
    expect(await adapter.handle(topic("summary"), summary)).toMatchObject({
      result: "delivery_failed",
      code: "network_or_response_error",
    });
  });
  it.each([401, 403, 415])(
    "pauses writes on configuration failure %i",
    async (code) => {
      status = code;
      reply = "secret-server-text";
      expect(await adapter.handle(topic("summary"), summary)).toMatchObject({
        result: "configuration_error",
        httpStatus: code,
      });
      expect((await adapter.handle(topic("summary"), summary)).result).toBe(
        "paused",
      );
      expect(requests).toHaveLength(1);
    },
  );
  it.each([404, 409, 413, 422])(
    "reports quarantine-required %i",
    async (code) => {
      status = code;
      expect((await adapter.handle(topic("summary"), summary)).result).toBe(
        "quarantine_required",
      );
    },
  );
  it.each([429, 500, 503])(
    "reports transient failure %i without claiming delivery",
    async (code) => {
      status = code;
      expect((await adapter.handle(topic("summary"), summary)).result).toBe(
        "delivery_failed",
      );
      expect(requests).toHaveLength(1);
    },
  );
  it("reports a lost connection without leaking the key", async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const outcome = await adapter.handle(topic("summary"), summary);
    expect(outcome).toMatchObject({
      result: "delivery_failed",
      code: "network_or_response_error",
    });
    expect(JSON.stringify(outcome)).not.toContain("local-test-key");
  });
  it("bounds pending deliveries rather than accumulating unlimited work", async () => {
    const outcomes = await Promise.all([
      adapter.handle(topic("summary"), summary),
      adapter.handle(topic("summary"), summary),
      adapter.handle(topic("summary"), summary),
    ]);
    expect(outcomes[2]).toMatchObject({
      result: "rejected",
      code: "capacity_exceeded",
    });
    expect(requests).toHaveLength(2);
  });
});
