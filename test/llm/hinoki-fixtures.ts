import { vi } from "vitest";
import type { CompletionRequest, ToolDefinition } from "../../src/types.js";
import { HINOKI_DEFAULT_MODEL } from "../../src/llm/hinoki-models.js";

export const AUTH = { apiKey: "hinoki-fixture-credential" };
export const MODEL = HINOKI_DEFAULT_MODEL;
export const TOOL: ToolDefinition = {
  name: "fs.read",
  wireName: "fs_read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
export const REQUEST: CompletionRequest = {
  provider: "hinoki",
  model: MODEL,
  messages: [
    { role: "system", content: "Stable instructions" },
    { role: "user", content: "Inspect the file" },
  ],
};
export const USAGE = {
  prompt_tokens: 120,
  completion_tokens: 30,
  total_tokens: 150,
  prompt_tokens_details: { cached_tokens: 80 },
  completion_tokens_details: { reasoning_tokens: 10 },
  cache_creation_input_tokens: 12,
};
export const ENTRY = { id: MODEL, object: "model", type: "model", context_window: 1_048_576 };

export function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status });
}

export function completion(): Response {
  return json({
    choices: [{ message: { role: "assistant", content: "Answer", reasoning_content: "Consider the evidence" }, finish_reason: "stop" }],
    usage: USAGE,
  });
}

export function sse(frames: readonly unknown[], done = true, fragmented = false): Response {
  const wire = frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join("") +
    (done ? "data: [DONE]\r\n\r\n" : "");
  const bytes = new TextEncoder().encode(wire);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const size = fragmented ? 3 : bytes.length;
      for (let offset = 0; offset < bytes.length; offset += size) controller.enqueue(bytes.slice(offset, offset + size));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

export interface SentRequest {
  url: string;
  body: string;
  headers: Headers;
  signal?: AbortSignal | null | undefined;
}

export function transport(
  reply: (request: SentRequest) => Response | Promise<Response> = completion,
  catalog: () => Response | Promise<Response> = () => json({ data: [ENTRY] }),
) {
  const generations: SentRequest[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models")) return catalog();
    if (typeof init?.body !== "string") throw new Error("Expected serialized JSON request");
    const request = { url, body: init.body, headers: new Headers(init.headers), signal: init.signal };
    generations.push(request);
    return reply(request);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { generations, fetchMock };
}
