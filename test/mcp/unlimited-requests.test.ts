import { afterEach, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { McpClient } from "../../src/mcp/client.js";
import { createRequest, parseMessage } from "../../src/mcp/jsonrpc.js";
import { LegacySseTransport, StreamableHttpTransport } from "../../src/mcp/transport-http.js";
import { StdioTransport } from "../../src/mcp/transport-stdio.js";
import type { McpTransport } from "../../src/mcp/transport.js";
import type { McpHttpConfig } from "../../src/mcp/types.js";

const active: McpTransport[] = [];
const config: McpHttpConfig = { transport: "http", url: "https://example.com/mcp", headers: {} };
const encoder = new TextEncoder();

afterEach(async () => {
  vi.useRealTimers();
  for (const transport of active.splice(0)) await transport.close();
});

it("keeps a silent stdio tool pending past an hour until manually cancelled", async () => {
  const transport = new StdioTransport({
    transport: "stdio",
    command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/mock-stdio-server.mjs", import.meta.url))],
    env: {},
  });
  active.push(transport);
  const client = new McpClient(transport);
  await client.initialize();
  const cancellations = (await client.callTool("cancelled_request", {})).text;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const controller = new AbortController();
  const pending = client.callTool("slow", {}, { signal: controller.signal });
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await client.ping();
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(settled).toBe(false);
  expect((await client.callTool("cancelled_request", {})).text).toBe(cancellations);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
  expect(Number((await client.callTool("cancelled_request", {})).text)).toBeGreaterThan(0);
  expect((await client.callTool("echo", { text: "still connected" })).text).toBe("echo: still connected");
});

it("accepts an HTTP tool response after an hour without a default deadline", async () => {
  let finish: () => void = () => {};
  let signal: AbortSignal | null | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    const message = parseMessage(String(init?.body));
    if (!message || !("id" in message)) return new Response(null, { status: 202 });
    signal = init?.signal;
    return new Promise<Response>((resolve, reject) => {
      finish = () => resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })));
      signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
    });
  };
  const transport = new StreamableHttpTransport(config, { fetchImpl });
  active.push(transport);
  vi.useFakeTimers();
  const pending = transport.request(createRequest(0, "tools/call", { name: "search_procedures" }));
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(signal).toBeDefined();
  expect(signal?.aborted).toBe(false);
  expect(settled).toBe(false);
  finish();
  await expect(pending).resolves.toMatchObject({ result: {} });
});

it("accepts a legacy SSE tool response after an hour without a default deadline", async () => {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let finish: () => void = () => {};
  let signal: AbortSignal | null | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    if (init?.method === "GET") {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
        },
      }));
    }
    const message = parseMessage(String(init?.body));
    if (message && "id" in message) {
      signal = init?.signal;
      finish = () => stream?.enqueue(encoder.encode(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n\n`,
      ));
    }
    return new Response(null, { status: 202 });
  };
  const transport = new LegacySseTransport({ ...config, transport: "sse" }, { fetchImpl });
  active.push(transport);
  await transport.start();
  vi.useFakeTimers();
  try {
    const pending = transport.request(createRequest(0, "tools/call", { name: "search_procedures" }));
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
    expect(settled).toBe(false);
    finish();
    await expect(pending).resolves.toMatchObject({ result: {} });
  } finally {
    stream?.close();
  }
});
