import { afterEach, describe, expect, it, vi } from "vitest";
import { clineProvider } from "../../src/llm/cline.js";
import { tokenharborProvider } from "../../src/llm/tokenharbor.js";
import { withSessionAffinity } from "../../src/llm/session-affinity.js";
import type { ChatMessage, ToolDefinition } from "../../src/types.js";

type WireMessage = Record<string, unknown>;
interface WireBody {
  messages: WireMessage[];
  tools: unknown[];
  cache_control?: unknown;
  session_id?: string;
}

const routes = [
  [clineProvider, "anthropic/claude-sonnet-4.6"],
  [clineProvider, "qwen/qwen3-coder"],
  [clineProvider, "cline-free/deepseek-v4.1-flash"],
  [tokenharborProvider, "claude-sonnet-5.5"],
  [tokenharborProvider, "kimi-k3"],
] as const;
const tools: ToolDefinition[] = [{
  name: "mcp.call",
  wireName: "mcp_call",
  description: "Call an enabled MCP tool using its discovered name and argument schema.",
  parameters: {
    type: "object",
    properties: { name: { type: "string" }, arguments: { type: "object" } },
    required: ["name", "arguments"],
  },
}];
const initial: ChatMessage[] = [
  { role: "system", content: "Stable tool instructions.\n".repeat(400) },
  { role: "user", content: "Read and summarize the Notion notes." },
];
const cachedUsage = { prompt_tokens: 15_000, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 14_000, cache_write_tokens: 500 } };

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "cache_control")
    .map(([key, entry]) => [key, withoutCacheControl(entry)]));
}

function canonicalMessage(message: WireMessage): unknown {
  const clean = withoutCacheControl(message) as WireMessage;
  const content = clean.content;
  if (Array.isArray(content) && content.length === 1 && content[0]?.type === "text") {
    clean.content = content[0].text;
  }
  return clean;
}

function blocks(body: WireBody): Array<{ cache_control?: unknown }> {
  return body.messages.flatMap((message) => [
    ...(Array.isArray(message.content) ? message.content
      : typeof message.content === "string" && message.content.trim() ? [{}] : []),
    ...(Array.isArray(message.tool_calls) ? message.tool_calls.map(() => ({})) : []),
  ]);
}

function expectReachablePrefix(previous: WireBody, next: WireBody): void {
  const previousEnd = blocks(previous).length - 1;
  expect(blocks(next).some((block, index) =>
    block.cache_control && index >= previousEnd && index - previousEnd < 20,
  )).toBe(true);
}

afterEach(() => vi.unstubAllGlobals());

describe.each(routes)("%s/%s gateway cache continuity", (provider, model) => {
  async function send(messages: ChatMessage[], stream: boolean, usage: Record<string, unknown> = cachedUsage): Promise<WireBody> {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const result = { choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage };
      return body.stream
        ? new Response(`data: ${JSON.stringify({ ...result, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
        : new Response(JSON.stringify(provider.id === "cline" ? { data: result } : result), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const before = structuredClone(messages);
    const request = { provider: provider.id, model, messages, tools };
    const auth = { apiKey: provider.id === "cline" ? "workos:offline-cache-credential" : `thk_live_${"a1B2c3D4".repeat(8)}` };
    const result = await withSessionAffinity("gateway-cache-session", () => stream
      ? provider.stream!(request, auth, () => {})
      : provider.complete(request, auth));
    expect(result.usage?.cachedPromptTokens).toBe(14_000);
    expect(result.usage?.cacheCreationTokens).toBe(500);
    expect(result.usage?.promptTokens).toBe(15_000);
    expect(messages).toEqual(before);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as WireBody;
    if (provider.id === "cline") {
      expect(new Headers(init.headers).get("x-task-id")).toBe("gateway-cache-session");
      expect(body.session_id).toMatch(/^clai-[0-9a-f]{40}$/);
      expect(body.messages.every((message) => !("cache_control" in message))).toBe(true);
      expect(body.cache_control).toEqual(/claude|qwen/.test(model) ? { type: "ephemeral" } : undefined);
    } else {
      expect(new Headers(init.headers).get("x-th-cache-control")).toBe("bypass");
      expect(body).not.toHaveProperty("prompt_cache_key");
      const marked = blocks(body).filter((block) => block.cache_control);
      expect(marked.length).toBeLessThanOrEqual(4);
      if (!model.includes("claude")) expect(marked).toHaveLength(0);
    }
    return body;
  }

  function expectPrefix(previous: WireBody, next: WireBody): void {
    expect(next.tools).toEqual(previous.tools);
    expect(next.session_id).toBe(previous.session_id);
    const shared = next.messages.slice(0, previous.messages.length);
    if (provider.id === "tokenharbor" && model.includes("claude")) {
      expect(shared.map(canonicalMessage)).toEqual(previous.messages.map(canonicalMessage));
      expectReachablePrefix(previous, next);
    } else {
      expect(shared).toEqual(previous.messages);
    }
  }

  it.each([false, true])("retains the prefix across 100 MCP tool results and 25 images (stream %s)", async (stream) => {
    const calls = Array.from({ length: 100 }, (_, index) => ({
      id: `call-${index}`, name: "mcp.call", args: { name: "mcp.notion.notion-fetch", arguments: { id: `page-${index}` } },
    }));
    const batch: ChatMessage[] = [
      ...initial,
      { role: "assistant", content: "Fetching the notes.", toolCalls: calls },
      ...calls.map((call): ChatMessage => ({ role: "tool", toolCallId: call.id, content: `notes for ${call.id}`, ok: true })),
    ];
    const revision: ChatMessage[] = [
      ...batch,
      { role: "assistant", content: "The notes are ready." },
      {
        role: "user", content: "Include these screenshots.",
        images: Array.from({ length: 25 }, (_, index) => ({ mediaType: "image/png" as const, dataBase64: Buffer.from(`image ${index}`).toString("base64") })),
      },
      { role: "system", content: "SESSION STATE / WORKING MEMORY\nMCP server notion remains enabled." },
    ];
    const first = await send(initial, stream);
    const second = await send(batch, stream);
    const third = await send(revision, stream);
    expectPrefix(first, second);
    expectPrefix(second, third);
    expect(second.messages.filter((message) => message.role === "tool")).toHaveLength(calls.length);
    expect(third.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((part) => part.type === "image_url")).toHaveLength(25);
  });

  it("keeps the latest nonempty context cacheable behind empty assistant tails", async () => {
    const messages: ChatMessage[] = [
      ...initial,
      { role: "assistant", content: "", toolCalls: [{ id: "last-call", name: "mcp.call", args: { name: "mcp.notion.notion-fetch", arguments: { id: "last-page" } } }] },
      { role: "tool", toolCallId: "last-call", content: "Retained MCP findings.", ok: true },
      { role: "assistant", content: "" },
      { role: "assistant", content: "" },
    ];
    const first = await send(initial, false);
    const next = await send(messages, false);
    expectPrefix(first, next);
    if (provider.id === "tokenharbor" && model.includes("claude")) {
      const tool = next.messages.find((message) => message.tool_call_id === "last-call")!;
      expect((tool.content as Array<Record<string, unknown>>).at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    }
  });

  it.each([false, true])("accounts for Anthropic-shaped cache reads and writes (stream %s)", async (stream) => {
    await send(initial, stream, {
      input_tokens: 500, output_tokens: 3, cache_read_input_tokens: 14_000, cache_creation_input_tokens: 500,
    });
  });
});
