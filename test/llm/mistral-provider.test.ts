import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatMessage,
  CompletionRequest,
  ToolDefinition,
} from "../../src/types.js";
import {
  clearModelCatalogFacts,
  resetReasoningKnowledge,
} from "../../src/llm/capabilities.js";
import { mistralProvider } from "../../src/llm/mistral.js";
import { ProviderError } from "../../src/llm/http.js";
import { sessionCacheAffinityKey } from "../../src/llm/cache-affinity.js";
import { withSessionAffinity } from "../../src/llm/session-affinity.js";
import {
  createReasoningArtifactProvenance,
  reasoningArtifactsForPersistence,
} from "../../src/llm/reasoning-artifacts.js";
import { tryCompleteOnce } from "../../src/llm/routing/attempt-complete.js";
import { tryStreamOnce } from "../../src/llm/routing/attempt-stream.js";
import {
  getHistoryPath,
  getSession,
  upsertSession,
} from "../../src/store/history.js";
import { toMistralMessages } from "../../src/llm/adapters/mistral-messages.js";

const TOOL: ToolDefinition = {
  name: "fs.read",
  wireName: "fs_read",
  description: "Read a file",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};
const MODEL = "mistral-small-latest";
const REQUEST: CompletionRequest = {
  model: MODEL,
  messages: [
    { role: "system", content: "stable instructions" },
    { role: "user", content: "inspect the file" },
  ],
};
const CATALOG = {
  data: [
    {
      id: MODEL,
      max_context_length: 262_144,
      capabilities: {
        completion_chat: true,
        function_calling: true,
        vision: true,
        reasoning: true,
      },
      default_model_temperature: 0.7,
    },
  ],
};
const THINKING = {
  type: "thinking",
  thinking: [{ type: "text", text: "Check the file first." }],
  signature: "opaque-signature",
  closed: true,
};
const CONTENT = [THINKING, { type: "text", text: "Final answer." }];
const USAGE = {
  prompt_tokens: 128,
  completion_tokens: 25,
  total_tokens: 153,
  prompt_tokens_details: { cached_tokens: 64 },
  completion_tokens_details: { reasoning_tokens: 10 },
};
let apiKey: string;
let keyIndex = 0;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function completion(
  content: unknown = CONTENT,
  extra: Record<string, unknown> = {},
): Response {
  return json({
    choices: [
      {
        message: { role: "assistant", content, ...extra },
        finish_reason: "stop",
      },
    ],
    usage: USAGE,
  });
}

function transport(reply: () => Response, catalog: unknown = CATALOG) {
  const generations: Array<{
    url: string;
    body: Record<string, any>;
    signal?: AbortSignal | null;
  }> = [];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models")) return json(catalog);
    generations.push({
      url,
      body: JSON.parse(init!.body as string),
      signal: init?.signal,
    });
    return reply();
  });
  vi.stubGlobal("fetch", fetchMock);
  return { generations, fetchMock };
}

function sse(frames: unknown[], fragmented = false, done = true): Response {
  const wire =
    frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join("") +
    (done ? "data: [DONE]" : "");
  const bytes = new TextEncoder().encode(wire);
  return new Response(
    new ReadableStream({
      start(controller) {
        if (fragmented)
          for (let offset = 0; offset < bytes.length; offset += 3)
            controller.enqueue(bytes.slice(offset, offset + 3));
        else controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function delta(content: unknown, extra: Record<string, unknown> = {}): unknown {
  return { choices: [{ index: 0, delta: { content, ...extra } }] };
}

beforeEach(() => {
  apiKey = `mistral-wire-test-${++keyIndex}`;
  clearModelCatalogFacts();
  resetReasoningKnowledge();
  vi.stubEnv("MISTRAL_BASE_URL", "https://api.mistral.ai/v1");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("Mistral native requests", () => {
  it("parses native thinking separately and captures the exact content and signature", async () => {
    const { generations } = transport(() => completion());
    const result = await mistralProvider.complete(REQUEST, { apiKey });
    expect(result).toMatchObject({
      provider: "mistral",
      model: MODEL,
      api: "chat-completions",
      text: "Final answer.",
      reasoningBlock: { text: "Check the file first." },
      usage: {
        promptTokens: 128,
        cachedPromptTokens: 64,
        completionTokens: 25,
        reasoningTokens: 10,
        reasoningObserved: true,
      },
    });
    expect(result.reasoningArtifacts?.[0]).toMatchObject({
      raw: CONTENT,
      provenance: { provider: "mistral", dialect: "mistral-chat" },
      replay: { scope: "all-history", persistence: "all-turns" },
    });
    expect(
      reasoningArtifactsForPersistence({
        artifacts: result.reasoningArtifacts,
        hasToolCalls: false,
      }),
    ).toEqual(result.reasoningArtifacts);
    expect(generations).toHaveLength(1);
    expect(generations[0]!.body).toMatchObject({
      temperature: 0.7,
      reasoning_effort: "none",
      model: MODEL,
    });
    expect(generations[0]!.body).not.toHaveProperty("stream_options");
  });

  it.each([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ] as const)("maps %s to a supported native effort", async (effort) => {
    const { generations } = transport(() => completion());
    await mistralProvider.complete(
      { ...REQUEST, thinking: { enabled: effort !== "none", effort } },
      { apiKey },
    );
    expect(generations[0]!.body.reasoning_effort).toBe(
      effort === "none" ? "none" : "high",
    );
    expect(generations[0]!.body).not.toHaveProperty("thinking");
    expect(generations[0]!.body).not.toHaveProperty("reasoning");
  });

  it("supports always-on GLM effort and never sends an unsupported disable", async () => {
    const catalog = {
      data: [
        {
          ...CATALOG.data[0],
          id: "zai-glm-5-3",
          capabilities: { ...CATALOG.data[0]!.capabilities, vision: false },
        },
      ],
    };
    const { generations } = transport(() => completion(), catalog);
    await mistralProvider.complete(
      {
        ...REQUEST,
        model: "zai-glm-5-3",
        thinking: { enabled: false, effort: "none" },
      },
      { apiKey },
    );
    expect(generations[0]!.body.reasoning_effort).toBe("low");
  });

  it("sends native function definitions, tool selection, parallel calls, and images", async () => {
    const { generations } = transport(() =>
      completion("", {
        tool_calls: [
          {
            id: "AbCd12345",
            type: "function",
            function: { name: "fs_read", arguments: '{"path":"README.md"}' },
          },
        ],
      }),
    );
    const result = await mistralProvider.complete(
      {
        ...REQUEST,
        messages: [
          ...REQUEST.messages,
          {
            role: "user",
            content: "read this",
            images: [{ mediaType: "image/png", dataBase64: "aW1hZ2U=" }],
          },
        ],
        tools: [TOOL],
        toolChoice: { type: "function", name: "fs.read" },
        parallelToolCalls: true,
      },
      { apiKey },
    );
    expect(result.toolCalls?.[0]).toMatchObject({
      id: "AbCd12345",
      name: "fs.read",
      args: { path: "README.md" },
    });
    expect(generations[0]!.body).toMatchObject({
      tools: [
        {
          type: "function",
          function: { name: "fs_read", parameters: TOOL.parameters },
        },
      ],
      tool_choice: { type: "function", function: { name: "fs_read" } },
      parallel_tool_calls: true,
    });
    expect(generations[0]!.body.messages.at(-1).content).toContainEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,aW1hZ2U=", detail: "high" },
    });
  });

  it.each(["complete", "stream"] as const)(
    "accepts native object tool arguments in %s JSON responses",
    async (mode) => {
      transport(() =>
        completion("", {
          tool_calls: [
            {
              id: "AbCd12345",
              type: "function",
              function: { name: "fs_read", arguments: { path: "README.md" } },
            },
          ],
        }),
      );
      const request = { ...REQUEST, tools: [TOOL] };
      const result =
        mode === "complete"
          ? await mistralProvider.complete(request, { apiKey })
          : await mistralProvider.stream!(request, { apiKey }, () => {});
      expect(result.toolCalls?.[0]).toMatchObject({
        id: "AbCd12345",
        name: "fs.read",
        args: { path: "README.md" },
        rawArguments: '{"path":"README.md"}',
      });
    },
  );

  it("omits capabilities explicitly denied by the selected model", async () => {
    const { generations } = transport(() => completion("answer"), {
      data: [
        {
          ...CATALOG.data[0],
          capabilities: {
            completion_chat: true,
            reasoning: false,
            vision: false,
            function_calling: false,
          },
        },
      ],
    });
    await mistralProvider.complete(
      {
        ...REQUEST,
        tools: [TOOL],
        thinking: { enabled: true, effort: "high" },
        messages: [
          {
            role: "user",
            content: "read this",
            images: [{ mediaType: "image/png", dataBase64: "aW1hZ2U=" }],
          },
        ],
      },
      { apiKey },
    );
    expect(generations[0]!.body).not.toHaveProperty("tools");
    expect(generations[0]!.body).not.toHaveProperty("reasoning_effort");
    expect(JSON.stringify(generations[0]!.body.messages)).not.toContain(
      "image_url",
    );
  });

  it("keeps cache affinity stable across appended turns and compaction", async () => {
    const { generations } = transport(() => completion());
    await withSessionAffinity("mistral-session-secret-free", async () => {
      await mistralProvider.complete(REQUEST, { apiKey });
      await mistralProvider.complete(
        {
          ...REQUEST,
          messages: [
            ...REQUEST.messages,
            { role: "assistant", content: "previous answer" },
            { role: "user", content: "follow-up" },
          ],
        },
        { apiKey },
      );
      await mistralProvider.complete(
        {
          ...REQUEST,
          messages: [
            { role: "system", content: "stable instructions" },
            { role: "user", content: "compacted context" },
          ],
        },
        { apiKey },
      );
    });
    expect(generations.map(({ body }) => body.prompt_cache_key)).toEqual(
      Array(3).fill(sessionCacheAffinityKey("mistral-session-secret-free")),
    );
    expect(generations[1]!.body.messages.slice(0, 2)).toEqual(
      generations[0]!.body.messages,
    );
    expect(generations[0]!.body.prompt_cache_key).not.toContain(
      "mistral-session-secret-free",
    );
  });

  it("isolates parent, child, and auxiliary cache affinity", async () => {
    const { generations } = transport(() => completion());
    for (const session of ["parent", "parent:child-one", "parent:auxiliary"]) {
      await withSessionAffinity(session, () =>
        mistralProvider.complete(REQUEST, { apiKey }),
      );
    }
    expect(
      new Set(generations.map(({ body }) => body.prompt_cache_key)).size,
    ).toBe(3);
  });

  it("keeps simultaneous endpoint metadata independent", async () => {
    const bodies: Record<string, any>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/models"))
          return json({
            data: [
              {
                ...CATALOG.data[0],
                default_model_temperature: url.includes("api.eu.") ? 0.5 : 0.9,
                capabilities: {
                  ...CATALOG.data[0]!.capabilities,
                  function_calling: url.includes("api.eu."),
                },
              },
            ],
          });
        bodies.push(JSON.parse(init.body as string));
        return completion();
      }),
    );
    await Promise.all([
      mistralProvider.complete(
        { ...REQUEST, tools: [TOOL] },
        { apiKey, baseUrl: "https://api.eu.mistral.ai/v1" },
      ),
      mistralProvider.complete(
        { ...REQUEST, tools: [TOOL] },
        { apiKey, baseUrl: "https://api.us.mistral.ai/v1" },
      ),
    ]);
    expect(bodies.find((body) => body.temperature === 0.5)?.tools).toHaveLength(
      1,
    );
    expect(bodies.find((body) => body.temperature === 0.9)).not.toHaveProperty(
      "tools",
    );
  });

  it("persists and replays full thinking chunks through history.jsonl", async () => {
    const { generations } = transport(() => completion());
    const first = await mistralProvider.complete(REQUEST, { apiKey });
    const messages: ChatMessage[] = [
      ...REQUEST.messages,
      {
        role: "assistant",
        content: first.text,
        reasoningArtifacts: first.reasoningArtifacts,
        reasoningBlock: first.reasoningBlock,
      },
      { role: "user", content: "continue" },
    ];
    await upsertSession("mistral-persisted-history", messages);
    const serialized = readFileSync(getHistoryPath(), "utf8");
    expect(serialized).toContain("opaque-signature");
    const restored = await getSession("mistral-persisted-history");
    expect(restored?.messages[2]?.reasoningArtifacts?.[0]?.raw).toEqual(
      CONTENT,
    );
    await mistralProvider.complete(
      { ...REQUEST, messages: restored!.messages },
      { apiKey },
    );
    expect(generations[1]!.body.messages[2].content).toEqual(CONTENT);
    expect(generations[1]!.body.messages[2]).not.toHaveProperty(
      "reasoning_details",
    );
    expect(generations[1]!.body.messages[2]).not.toHaveProperty(
      "reasoning_content",
    );
  });

  it("omits incompatible native thinking when switching endpoints or models", async () => {
    const { generations } = transport(() => completion());
    const first = await mistralProvider.complete(REQUEST, { apiKey });
    const messages: ChatMessage[] = [
      ...REQUEST.messages,
      {
        role: "assistant",
        content: first.text,
        reasoningArtifacts: first.reasoningArtifacts,
      },
      { role: "user", content: "continue" },
    ];
    await mistralProvider.complete(
      { ...REQUEST, messages },
      { apiKey, baseUrl: "https://api.eu.mistral.ai/v1" },
    );
    expect(generations[1]!.body.messages[2].content).toBe("Final answer.");
    await mistralProvider.complete(
      { ...REQUEST, messages, model: "mistral-medium-3-5" },
      { apiKey },
    );
    expect(generations[2]!.body.messages[2].content).toBe("Final answer.");
  });

  it("replays reasoning across aliases only while they resolve to the same model", async () => {
    vi.useFakeTimers();
    let version = "mistral-small-2603";
    const generations: Record<string, any>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/models"))
          return json({
            data: [{ ...CATALOG.data[0], id: version, aliases: [MODEL] }],
          });
        generations.push(JSON.parse(init.body as string));
        return completion();
      }),
    );
    const first = await mistralProvider.complete(REQUEST, { apiKey });
    expect(first.reasoningArtifacts?.[0]?.provenance.model).toBe(version);
    const messages: ChatMessage[] = [
      ...REQUEST.messages,
      {
        role: "assistant",
        content: first.text,
        reasoningArtifacts: first.reasoningArtifacts,
      },
      { role: "user", content: "continue" },
    ];
    await mistralProvider.complete(
      { ...REQUEST, model: version, messages },
      { apiKey },
    );
    await mistralProvider.complete({ ...REQUEST, messages }, { apiKey });
    expect(generations[1]!.messages[2].content).toEqual(CONTENT);
    expect(generations[2]!.messages[2].content).toEqual(CONTENT);
    version = "mistral-small-next";
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    await mistralProvider.complete({ ...REQUEST, messages }, { apiKey });
    expect(generations[3]!.messages[2].content).toBe("Final answer.");
  });

  it.each(["complete", "stream"] as const)(
    "retires rejected alias reasoning once in %s and preserves foreign history",
    async (mode) => {
      let rejected = false;
      const { generations } = transport(
        () => {
          if (generations.length === 2) {
            rejected = true;
            return json({ message: "Invalid thinking signature" }, 400);
          }
          return completion(generations.length === 1 ? CONTENT : "Recovered.");
        },
        {
          data: [
            { ...CATALOG.data[0], id: "mistral-small-2603", aliases: [MODEL] },
          ],
        },
      );
      const first = await mistralProvider.complete(REQUEST, { apiKey });
      const current = first.reasoningArtifacts![0]!;
      const foreign = {
        ...current,
        provenance: createReasoningArtifactProvenance({
          provider: "mistral",
          model: "mistral-small-2603",
          dialect: "mistral-chat",
          endpoint: "https://api.eu.mistral.ai/v1",
        }),
      };
      const messages: ChatMessage[] = [
        ...REQUEST.messages,
        {
          role: "assistant",
          content: first.text,
          reasoningArtifacts: [current, foreign],
        },
        { role: "user", content: "continue" },
      ];
      const statuses: string[] = [];
      const observer = vi.fn();
      const run = () => {
        const request = {
          ...REQUEST,
          provider: "mistral" as const,
          messages,
          onReasoningArtifactReplayDecision: observer,
        };
        return mode === "complete"
          ? tryCompleteOnce(
              mistralProvider,
              "mistral",
              request,
              MODEL,
              { apiKey },
              "initial",
              (text) => statuses.push(text),
            )
          : tryStreamOnce(
              mistralProvider,
              "mistral",
              request,
              MODEL,
              { apiKey },
              () => {},
              (text) => statuses.push(text),
              "initial",
            );
      };
      await run();
      await run();
      expect(rejected).toBe(true);
      expect(generations).toHaveLength(4);
      expect(generations[1]!.body.messages[2].content).toEqual(CONTENT);
      expect(generations[2]!.body.messages[2].content).toBe("Final answer.");
      expect(generations[3]!.body.messages[2].content).toBe("Final answer.");
      expect(messages[2]!.reasoningArtifacts).toEqual([foreign]);
      expect(messages[2]!.content).toBe("Final answer.");
      expect(
        statuses.filter((text) => text.includes("rejected replayed reasoning")),
      ).toHaveLength(1);
      expect(observer).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "replayed",
          source: current.provenance,
        }),
      );
    },
  );

  it("retains reasoning when a nonstreaming response exhausts its token budget", async () => {
    transport(() =>
      json({
        choices: [
          { message: { content: [THINKING] }, finish_reason: "length" },
        ],
      }),
    );
    const result = await mistralProvider.complete(REQUEST, { apiKey });
    expect(result.text).toBe("");
    expect(result.finishReason).toBe("length");
    expect(result.reasoningBlock?.text).toBe("Check the file first.");
    expect(result.reasoningArtifacts?.[0]?.raw).toEqual([THINKING]);
  });

  it("normalizes historical tool IDs consistently without changing the transcript", () => {
    const originals = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_shared_prefix_one",
            type: "function",
            function: { name: "fs_read", arguments: "{}" },
          },
          {
            id: "call_shared_prefix_two",
            type: "function",
            function: { name: "fs_read", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        content: "first",
        tool_call_id: "call_shared_prefix_one",
      },
      {
        role: "tool",
        content: "second",
        tool_call_id: "call_shared_prefix_two",
      },
    ];
    const wire = toMistralMessages(originals);
    const calls = wire[0]!.tool_calls as Array<{ id: string }>;
    expect(calls[0]!.id).toMatch(/^[A-Za-z0-9]{9}$/);
    expect(calls[1]!.id).not.toBe(calls[0]!.id);
    expect(wire[1]!.tool_call_id).toBe(calls[0]!.id);
    expect(wire[2]!.tool_call_id).toBe(calls[1]!.id);
    expect(
      toMistralMessages([
        ...originals,
        { role: "user", content: "next" },
      ]).slice(0, 3),
    ).toEqual(wire);
    expect(originals[0]!.tool_calls?.[0]?.id).toBe("call_shared_prefix_one");
  });
});

describe("Mistral native streaming", () => {
  it("handles fragmented UTF-8, CRLF, thinking transitions, signatures, and final usage", async () => {
    transport(() =>
      sse(
        [
          delta([
            {
              type: "thinking",
              thinking: [{ type: "text", text: "Inspect café " }],
              closed: false,
            },
          ]),
          delta([
            {
              type: "thinking",
              thinking: [{ type: "text", text: "日本語." }],
              signature: "native-signature",
              closed: true,
            },
            { type: "text", text: "The answer " },
          ]),
          delta("is ready."),
          { choices: [{ delta: {}, finish_reason: "stop" }], usage: USAGE },
        ],
        true,
      ),
    );
    const events: unknown[] = [];
    const tokens: string[] = [];
    const result = await mistralProvider.stream!(
      {
        ...REQUEST,
        onStreamEvent: (event) => events.push(event),
        thinking: { enabled: true, effort: "high" },
      },
      { apiKey },
      (token) => tokens.push(token),
    );
    expect(tokens.join("")).toBe("The answer is ready.");
    expect(result.reasoningBlock?.text).toBe("Inspect café 日本語.");
    expect(events).toContainEqual({
      type: "reasoning_delta",
      text: "Inspect café ",
    });
    expect(events).toContainEqual({ type: "reasoning_delta", text: "日本語." });
    expect(result.reasoningArtifacts?.[0]?.raw).toEqual([
      {
        type: "thinking",
        thinking: [{ type: "text", text: "Inspect café 日本語." }],
        closed: true,
        signature: "native-signature",
      },
      { type: "text", text: "The answer is ready." },
    ]);
    expect(result.usage).toMatchObject({
      cachedPromptTokens: 64,
      reasoningTokens: 10,
      reasoningObserved: true,
    });
  });

  it("merges thinking deltas with default closed flags and preserves references and signatures", async () => {
    const reference = { type: "reference", reference_ids: ["document-1"] };
    transport(() =>
      sse([
        delta([
          {
            type: "thinking",
            thinking: [{ type: "text", text: "First " }],
            closed: true,
          },
        ]),
        delta([
          {
            type: "thinking",
            thinking: [reference, { type: "text", text: "second." }],
            closed: true,
          },
        ]),
        delta([
          {
            type: "thinking",
            thinking: [],
            signature: "complete-signature",
            closed: true,
          },
          { type: "text", text: "Answer." },
        ]),
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );
    const result = await mistralProvider.stream!(REQUEST, { apiKey }, () => {});
    expect(result.reasoningBlock?.text).toBe("First second.");
    expect(result.reasoningArtifacts?.[0]?.raw).toEqual([
      {
        type: "thinking",
        thinking: [
          { type: "text", text: "First " },
          reference,
          { type: "text", text: "second." },
        ],
        closed: true,
        signature: "complete-signature",
      },
      { type: "text", text: "Answer." },
    ]);
  });

  it("preserves separately signed native thinking blocks", async () => {
    const other = { ...THINKING, signature: "other-signature" };
    transport(() =>
      sse([
        delta([THINKING, other]),
        delta("answer"),
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );
    const result = await mistralProvider.stream!(REQUEST, { apiKey }, () => {});
    expect(result.reasoningArtifacts?.[0]?.raw).toEqual([
      THINKING,
      other,
      { type: "text", text: "answer" },
    ]);
  });

  it("accumulates parallel tool argument fragments and reports progress", async () => {
    transport(() =>
      sse([
        delta([
          {
            type: "thinking",
            thinking: [{ type: "text", text: "Read both." }],
            closed: true,
          },
        ]),
        delta(null, {
          tool_calls: [
            {
              index: 0,
              id: "AaBb12345",
              function: { name: "fs_read", arguments: '{"path":"' },
            },
            {
              index: 1,
              id: "CcDd12345",
              function: { name: "fs_read", arguments: '{"path":"other' },
            },
          ],
        }),
        delta(null, {
          tool_calls: [
            { index: 0, function: { arguments: 'README.md"}' } },
            { index: 1, function: { arguments: '.md"}' } },
          ],
        }),
        { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: USAGE },
      ]),
    );
    const progress = vi.fn();
    const result = await mistralProvider.stream!(
      { ...REQUEST, tools: [TOOL], onToolCallDelta: progress },
      { apiKey },
      () => {},
    );
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        id: "AaBb12345",
        name: "fs.read",
        args: { path: "README.md" },
      }),
      expect.objectContaining({
        id: "CcDd12345",
        name: "fs.read",
        args: { path: "other.md" },
      }),
    ]);
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ index: 0, name: "fs.read" }),
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ index: 1, name: "fs.read" }),
    );
  });

  it("preserves deliberate repetition without snapshot or reasoning-echo heuristics", async () => {
    const text = "a".repeat(80);
    transport(() =>
      sse([
        delta([{ type: "thinking", thinking: [{ type: "text", text }] }]),
        delta(text),
        delta(text),
      ]),
    );
    const tokens: string[] = [];
    const result = await mistralProvider.stream!(REQUEST, { apiKey }, (token) =>
      tokens.push(token),
    );
    expect(tokens.join("")).toBe(text + text);
    expect(result.text).toBe(text + text);
  });

  it("accepts a finish frame without a DONE sentinel and keeps truncated thinking", async () => {
    transport(() =>
      sse(
        [
          delta([THINKING]),
          { choices: [{ delta: {}, finish_reason: "length" }], usage: USAGE },
        ],
        false,
        false,
      ),
    );
    const result = await mistralProvider.stream!(REQUEST, { apiKey }, () => {});
    expect(result.finishReason).toBe("length");
    expect(result.reasoningBlock?.text).toBe("Check the file first.");
    expect(result.reasoningArtifacts).toHaveLength(1);
  });

  it("rejects EOF without a provider completion signal", async () => {
    transport(() => sse([delta("partial answer")], false, false));
    await expect(
      mistralProvider.stream!(REQUEST, { apiKey }, () => {}),
    ).rejects.toThrow(/without terminal proof/);
  });

  it("propagates native in-band errors", async () => {
    transport(() =>
      sse([
        {
          object: "error",
          type: "invalid_function_call",
          message: "Invalid tool arguments",
        },
      ]),
    );
    await expect(
      mistralProvider.stream!(REQUEST, { apiKey }, () => {}),
    ).rejects.toThrow("Invalid tool arguments");
  });

  it("handles native JSON responses to streaming requests", async () => {
    transport(() => completion());
    const events: unknown[] = [];
    const token = vi.fn();
    const result = await mistralProvider.stream!(
      { ...REQUEST, onStreamEvent: (event) => events.push(event) },
      { apiKey },
      token,
    );
    expect(token).toHaveBeenCalledWith("Final answer.");
    expect(events).toContainEqual({
      type: "reasoning_delta",
      text: "Check the file first.",
    });
    expect(result.reasoningArtifacts?.[0]?.raw).toEqual(CONTENT);
  });

  it("propagates callback failures and closes the stream", async () => {
    const cancel = vi.fn();
    transport(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify(delta("answer"))}\n\n`,
                ),
              );
            },
            cancel,
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    await expect(
      mistralProvider.stream!(REQUEST, { apiKey }, () => {
        throw new Error("consumer failed");
      }),
    ).rejects.toThrow("consumer failed");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("propagates a stream read failure after displaying partial output", async () => {
    let read = false;
    transport(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (read) controller.error(new Error("connection lost"));
              else {
                read = true;
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify(delta("partial answer"))}\n\n`,
                  ),
                );
              }
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const token = vi.fn();
    await expect(
      mistralProvider.stream!(REQUEST, { apiKey }, token),
    ).rejects.toThrow("connection lost");
    expect(token).toHaveBeenCalledWith("partial answer");
  });

  it("cancels an active stream and releases its reader", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    transport(
      () =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify(delta("answer"))}\n\n`,
                ),
              );
            },
            cancel,
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    await expect(
      mistralProvider.stream!(
        { ...REQUEST, signal: controller.signal },
        { apiKey },
        () => controller.abort(),
      ),
    ).rejects.toThrow(/abort/i);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels while discovery is in progress without starting a generation", async () => {
    const controller = new AbortController();
    let finish: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const pending = mistralProvider.stream!(
      { ...REQUEST, signal: controller.signal },
      { apiKey },
      () => {},
    );
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toThrow("cancelled");
    finish?.(json(CATALOG));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects authentication errors and preserves retry-after metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ message: "Invalid API key" }, 401)),
    );
    await expect(
      mistralProvider.complete(REQUEST, { apiKey }),
    ).rejects.toMatchObject({ status: 401 });
    transport(
      () =>
        new Response(JSON.stringify({ message: "rate limited" }), {
          status: 429,
          headers: { "retry-after": "4" },
        }),
    );
    const error = await mistralProvider.stream!(
      REQUEST,
      { apiKey: `${apiKey}-retry` },
      () => {},
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ status: 429, retryAfterSeconds: 4 });
  });
});
