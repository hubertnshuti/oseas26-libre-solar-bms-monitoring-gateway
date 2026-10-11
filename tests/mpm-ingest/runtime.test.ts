import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

function frame(header: number, body: Buffer): Buffer {
  const length: number[] = [];
  let remaining = body.length;
  do {
    const digit = remaining % 128;
    remaining = Math.floor(remaining / 128);
    length.push(digit | (remaining ? 128 : 0));
  } while (remaining);
  return Buffer.concat([Buffer.from([header, ...length]), body]);
}

it("runs the executable from a limited MQTT protocol peer through a fake MPM HTTP endpoint", async () => {
  const nodeId = "53494D0000000001";
  const raw = readFileSync(
    new URL("../fixtures/v1/valid/normal.summary.json", import.meta.url),
  );
  const payload = JSON.parse(raw.toString());
  const received: unknown[] = [];
  const topics: string[] = [];
  const sockets = new Set<Socket>();
  const http = createHttpServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({
      route: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({ result: "accepted", message_id: payload.message_id }),
    );
  });
  // This peer handles only CONNECT, SUBSCRIBE and one PUBLISH; it is not Mosquitto.
  const mqtt = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let pending: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        let length = 0;
        let multiplier = 1;
        let offset = 1;
        let digit: number;
        do {
          if (offset >= pending.length) return;
          digit = pending[offset++]!;
          length += (digit & 127) * multiplier;
          multiplier *= 128;
        } while (digit & 128);
        if (pending.length < offset + length) return;
        const kind = pending[0]! >> 4;
        const body = pending.subarray(offset, offset + length);
        pending = pending.subarray(offset + length);
        if (kind === 1) socket.write(Buffer.from([0x20, 2, 0, 0]));
        if (kind === 8) {
          let cursor = 2;
          while (cursor < body.length) {
            const count = body.readUInt16BE(cursor);
            cursor += 2;
            topics.push(body.subarray(cursor, cursor + count).toString());
            cursor += count + 1;
          }
          socket.write(
            frame(
              0x90,
              Buffer.concat([
                body.subarray(0, 2),
                Buffer.alloc(topics.length, 1),
              ]),
            ),
          );
          const topic = Buffer.from(`libresolar/bms/v1/${nodeId}/summary`);
          const topicLength = Buffer.alloc(2);
          topicLength.writeUInt16BE(topic.length);
          socket.write(
            frame(
              0x32,
              Buffer.concat([topicLength, topic, Buffer.from([0, 1]), raw]),
            ),
          );
        }
      }
    });
  });
  let child: ReturnType<typeof spawn> | undefined;
  let output = "";
  try {
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        http.once("error", reject);
        http.listen(0, "127.0.0.1", resolve);
      }),
      new Promise<void>((resolve, reject) => {
        mqtt.once("error", reject);
        mqtt.listen(0, "127.0.0.1", resolve);
      }),
    ]);
    const httpAddress = http.address();
    const mqttAddress = mqtt.address();
    if (
      !httpAddress ||
      typeof httpAddress === "string" ||
      !mqttAddress ||
      typeof mqttAddress === "string"
    )
      throw new Error("Missing test port");
    child = spawn(
      process.execPath,
      ["--import", "tsx", "app/mpm-ingest/main.ts"],
      {
        cwd: new URL("../../", import.meta.url),
        env: {
          ...process.env,
          MQTT_URL: `mqtt://127.0.0.1:${mqttAddress.port}`,
          MQTT_USERNAME: "test-user",
          MQTT_PASSWORD: "runtime-test-password",
          MPM_BASE_URL: `http://127.0.0.1:${httpAddress.port}`,
          MPM_API_KEY: "runtime-test-key",
          MPM_COMPANY_BINDING: "demo-company",
          BMS_ADAPTER_ID: "demo-adapter",
          BMS_NODE_IDS: nodeId,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Adapter did not deliver: ${output}`)),
        8000,
      );
      child!.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child!.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error(`Adapter exited: ${output}`));
      });
      child!.stdout!.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes('"result":"accepted"')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child!.stderr!.on("data", (chunk) => {
        output += chunk.toString();
      });
    });
    expect(topics).toEqual(
      ["summary", "events", "attributes", "availability", "telemetry"].map(
        (suffix) => `libresolar/bms/v1/${nodeId}/${suffix}`,
      ),
    );
    expect(received).toEqual([
      {
        route: "/api/libre-solar-bms/ingest/summaries",
        authorization: "Bearer runtime-test-key",
        body: payload,
      },
    ]);
    const closed = once(child, "close");
    child.kill("SIGTERM");
    expect((await closed)[0]).toBe(0);
    expect(output).toContain('"result":"stopped"');
    expect(output).not.toContain("runtime-test-key");
    expect(output).not.toContain("runtime-test-password");
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    for (const socket of sockets) socket.destroy();
    http.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => http.close(() => resolve())),
      new Promise<void>((resolve) => mqtt.close(() => resolve())),
    ]);
  }
}, 12000);
