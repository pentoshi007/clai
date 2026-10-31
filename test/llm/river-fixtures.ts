import { vi } from "vitest";
import type { CompletionRequest, ToolDefinition } from "../../src/types.js";
import { RIVER_DEFAULT_MODEL } from "../../src/llm/river-models.js";
import { resetRiverDocFacts } from "../../src/llm/river-docs.js";

export const TOOL: ToolDefinition = {
  name: "fs.read",
  wireName: "fs_read",
  description: "Read a file",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};
export const REQUEST: CompletionRequest = {
  model: RIVER_DEFAULT_MODEL,
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
};

export function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function completion(): Response {
  return json({
    choices: [{
      message: { role: "assistant", content: "Answer", reasoning_content: "Consider the evidence" },
      finish_reason: "stop",
    }],
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
      for (let offset = 0; offset < bytes.length; offset += size)
        controller.enqueue(bytes.slice(offset, offset + size));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

export const RIVER_DOCS_ORIGIN = "https://docs.river.ai/";

export function stubRiverFetch(apiFetch: typeof fetch, docs?: (url: string) => Response) {
  resetRiverDocFacts();
  const docsFetch = vi.fn(async (input: string | URL | Request) =>
    docs?.(String(input)) ?? new Response("", { status: 404 }));
  vi.stubGlobal("fetch", ((input: string | URL | Request, init?: RequestInit) =>
    String(input).startsWith(RIVER_DOCS_ORIGIN)
      ? docsFetch(input)
      : apiFetch(input, init)) as typeof fetch);
  return { docsFetch };
}

export function transport(
  reply: () => Response = completion,
  catalog: () => Response = () => json({ data: [{ id: RIVER_DEFAULT_MODEL }] }),
  docs?: (url: string) => Response,
) {
  const generations: { url: string; body: string; headers: Headers; signal?: AbortSignal | null }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models")) return catalog();
    if (typeof init?.body !== "string") throw new Error("Expected serialized JSON request");
    generations.push({ url, body: init.body, headers: new Headers(init.headers), signal: init.signal });
    return reply();
  });
  const { docsFetch } = stubRiverFetch(fetchMock as unknown as typeof fetch, docs);
  return { generations, fetchMock, docsFetch };
}
