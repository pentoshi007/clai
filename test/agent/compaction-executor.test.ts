import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stream = vi.fn();
const complete = vi.fn();

vi.mock("../../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/llm/router.js")>();
  return {
    ...actual,
    streamWithProvider: (
      req: unknown,
      onToken: (t: string) => void,
      options?: { onStatus?: (message: string) => void },
    ) => stream(req, onToken, options),
    completeWithProvider: (req: unknown, options?: unknown) =>
      complete(req, options),
  };
});

const { executeCompactionSummary, planCompactionReplay, CompactionOverLimitError } = await import(
  "../../src/agent/compaction-executor.js"
);

const SYSTEM = "summarize the session";

function baseExecution(
  overrides: Partial<Parameters<typeof executeCompactionSummary>[0]> = {},
) {
  return {
    provider: "nvidia" as const,
    model: "test-model",
    systemContent: SYSTEM,
    prompt: "summarize this history",
    maxTokens: 4096,
    stream: false,
    ...overrides,
  };
}

function completion(text: string, finishReason = "stop") {
  return {
    text,
    provider: "nvidia",
    model: "test-model",
    finishReason,
    usage: {
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      exact: true,
    },
  };
}

function badRequest(message: string, body = message) {
  return Object.assign(new Error(message), { status: 400, body });
}

beforeEach(() => {
  stream.mockReset();
  complete.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shared compaction executor", () => {
  it("dispatches one complete-mode request with the compaction contract", async () => {
    complete.mockResolvedValueOnce(completion("## Work\nDone.\n## Remaining\nMore."));

    const visible = await executeCompactionSummary(baseExecution());

    expect(visible).toBe("## Work\nDone.\n## Remaining\nMore.");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]![1]).toEqual({
      maxRetries: 0,
      singleDispatch: true,
    });
    expect(complete.mock.calls[0]![0]).toMatchObject({
      provider: "nvidia",
      model: "test-model",
      temperature: 0.1,
      maxTokens: 4096,
      thinking: { enabled: false, effort: "low" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: "summarize this history" },
      ],
    });
    expect(stream).not.toHaveBeenCalled();
  });

  it("streams with delta plumbing and replaces the card on a quality retry", async () => {
    stream
      .mockResolvedValueOnce(completion("", "length"))
      .mockResolvedValueOnce(completion("## Work\nFixed.\n## Remaining\nMore."));

    const tokens: Array<{ text: string; replace?: boolean }> = [];
    const visible = await executeCompactionSummary(
      baseExecution({
        stream: true,
        onToken: (text, replace) => tokens.push({ text, replace }),
      }),
    );

    expect(visible).toBe("## Work\nFixed.\n## Remaining\nMore.");
    expect(stream).toHaveBeenCalledTimes(2);
    const retryRequest = stream.mock.calls[1]![0] as {
      temperature: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(retryRequest.temperature).toBe(0);
    expect(retryRequest.messages[0]).toMatchObject({
      role: "system",
      content: `${SYSTEM}\nReturn only a complete continuation-memory summary. Do not include analysis, reasoning, or <think> tags.`,
    });
    expect(retryRequest.messages[1]!.content).toContain(
      "The previous draft hit its output limit.",
    );
    expect(retryRequest.messages[1]!.content).toContain("QUALITY RETRY");
    expect(tokens.some((entry) => entry.replace === true)).toBe(true);
  });

  it("fails closed after a second truncated summary", async () => {
    complete.mockResolvedValue(completion("", "length"));

    await expect(
      executeCompactionSummary(baseExecution()),
    ).rejects.toThrow(/summary output limit twice/i);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx once only when server-error retry is enabled", async () => {
    const serverError = Object.assign(new Error("upstream is down"), {
      status: 503,
    });

    complete.mockRejectedValueOnce(serverError).mockResolvedValueOnce(
      completion("## Work\nDone.\n## Remaining\nMore."),
    );
    await executeCompactionSummary(baseExecution({ retryOnServerError: true }));
    expect(complete).toHaveBeenCalledTimes(2);

    complete.mockReset();
    complete.mockRejectedValueOnce(serverError).mockResolvedValueOnce(
      completion("## Work\nDone.\n## Remaining\nMore."),
    );
    await expect(
      executeCompactionSummary(baseExecution({ retryOnServerError: false })),
    ).rejects.toThrow("upstream is down");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("never mutates the caller's source messages", async () => {
    const sourceMessages = [
      { role: "user" as const, content: "earlier turn" },
      { role: "assistant" as const, content: "earlier answer" },
    ];
    const snapshot = JSON.stringify(sourceMessages);
    complete.mockResolvedValueOnce(completion("", "length"));
    complete.mockResolvedValueOnce(completion("## Work\nDone.\n## Remaining\nMore."));

    await executeCompactionSummary(
      baseExecution({
        sourceMessages,
        allowModelFallback: true,
        tools: [
          {
            name: "fs.read",
            description: "read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        ],
      }),
    );

    expect(JSON.stringify(sourceMessages)).toBe(snapshot);
    const firstRequest = complete.mock.calls[0]![0] as {
      allowModelFallback?: boolean;
      toolChoice?: string;
      messages: unknown[];
    };
    expect(firstRequest.allowModelFallback).toBe(true);
    expect(firstRequest.toolChoice).toBe("none");
    expect(firstRequest.messages).toHaveLength(3);
    expect(firstRequest.messages.at(-1)).toMatchObject({
      role: "user",
      content: "summarize this history",
    });
  });

  it("keeps text compaction free of image payloads", async () => {
    const sourceMessages = [
      {
        role: "user" as const,
        content: "an attached screenshot was discussed",
        images: [
          {
            mediaType: "image/png",
            dataBase64: "c2VjcmV0LWltYWdlLWJ5dGVz",
            path: "/tmp/screenshot.png",
          },
        ],
      },
      { role: "assistant" as const, content: "the screenshot showed an error" },
    ];
    const original = structuredClone(sourceMessages);
    complete.mockResolvedValueOnce(completion("## Work\nDone.\n## Remaining\nMore."));

    await executeCompactionSummary(
      baseExecution({ sourceMessages, maxTokens: 12_288 }),
    );

    const sent = complete.mock.calls[0]![0] as {
      messages: Array<{ images?: unknown[] }>;
    };
    expect(sent.messages.every((message) => message.images === undefined)).toBe(true);
    expect(sourceMessages).toEqual(original);
  });

  it("changes the rejected request shape once for an opaque Bynara 400", async () => {
    const generic =
      "The model rejected this request. It may not support the input you sent (e.g. images on a text-only model) or a parameter is invalid.";
    complete
      .mockRejectedValueOnce(badRequest(`Bynara stream error: ${generic}`))
      .mockResolvedValueOnce(completion("## Work\nRecovered.\n## Remaining\nContinue."));

    const visible = await executeCompactionSummary(
      baseExecution({
        maxTokens: 12_288,
        sourceMessages: [
          {
            role: "assistant",
            content: "prior answer",
            reasoningBlock: { text: "private reasoning" },
          },
          {
            role: "user",
            content: "look at this image",
            images: [{ mediaType: "image/png", dataBase64: "aW1hZ2U=" }],
          },
        ],
        tools: [
          {
            name: "fs.read",
            wireName: "fs_read",
            description: "read a file",
            parameters: { type: "object", properties: {} },
          },
        ],
      }),
    );

    expect(visible).toContain("Recovered.");
    expect(complete).toHaveBeenCalledTimes(2);
    const first = complete.mock.calls[0]![0] as Record<string, any>;
    const second = complete.mock.calls[1]![0] as Record<string, any>;
    expect(first.messages.every((message: any) => message.images === undefined)).toBe(true);
    expect(first).toMatchObject({
      maxTokens: 12_288,
      thinking: { enabled: false, effort: "low" },
      toolChoice: "none",
    });
    expect(first.tools).toHaveLength(1);
    expect(second.messages.every((message: any) =>
      message.images === undefined &&
      message.reasoningBlock === undefined &&
      message.reasoningArtifacts === undefined,
    )).toBe(true);
    expect(second.maxTokens).toBe(12_288);
    expect(second.thinking).toBeUndefined();
    expect(second.tools).toBeUndefined();
    expect(second.toolChoice).toBeUndefined();
    expect(second.temperature).toBe(0.1);
    expect(second).not.toEqual(first);
  });

  it("reports opaque rejection without blaming images and allows a later compaction", async () => {
    const generic =
      "The model rejected this request. It may not support the input you sent (e.g. images on a text-only model) or a parameter is invalid.";
    complete.mockRejectedValue(badRequest(`Bynara stream error: ${generic}`));

    await expect(
      executeCompactionSummary(baseExecution({ maxTokens: 12_288 })),
    ).rejects.toThrow(
      /No image payload was sent.*image example.*not evidence/i,
    );
    expect(complete).toHaveBeenCalledTimes(2);

    complete.mockReset();
    complete.mockResolvedValueOnce(
      completion("## Work\nRecovered later.\n## Remaining\nContinue."),
    );
    await expect(
      executeCompactionSummary(baseExecution({ maxTokens: 12_288 })),
    ).resolves.toContain("Recovered later.");
  });

  it("names an explicitly rejected field after the compatibility retry", async () => {
    complete
      .mockRejectedValueOnce(badRequest("provider rejected the request body"))
      .mockRejectedValueOnce(
        badRequest(
          "Extra inputs are not permitted: max_tokens is invalid",
        ),
      );

    await expect(
      executeCompactionSummary(baseExecution({ maxTokens: 12_288 })),
    ).rejects.toThrow(/identified `max_tokens` as the rejected field/i);
  });
});

describe("cache-preserving snapshot replay", () => {
  const baseRequest = {
    provider: "nvidia" as const,
    model: "test-model",
    temperature: 0.6,
    thinking: { enabled: true, effort: "high" as const },
    toolChoice: "auto" as const,
    parallelToolCalls: true,
    tools: [
      {
        name: "fs.read",
        description: "read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ],
    messages: [
      { role: "system" as const, content: "stable constitution" },
      { role: "user" as const, content: "first user turn" },
      { role: "assistant" as const, content: "first answer" },
      { role: "user" as const, content: "second user turn" },
    ],
  };

  it("replays the captured text timeline with cache-identical controls", async () => {
    complete.mockResolvedValueOnce(completion("## Work\nDone.\n## Remaining\nMore."));

    await executeCompactionSummary(
      baseExecution({
        baseRequest,
        history: [
          ...baseRequest.messages,
          { role: "assistant" as const, content: "second answer" },
        ],
      }),
    );

    const sent = complete.mock.calls[0]![0] as {
      provider: string;
      model: string;
      temperature?: number;
      thinking?: unknown;
      toolChoice?: string;
      parallelToolCalls?: boolean;
      tools?: unknown[];
      messages: Array<{ role: string; content: string }>;
    };
    // The whole prior prompt is a strict prefix of the compaction request, so
    // prefix-caching providers serve it entirely from cache.
    expect(sent.messages.slice(0, baseRequest.messages.length)).toEqual(
      baseRequest.messages,
    );
    expect(sent.messages.at(-2)).toEqual({
      role: "assistant",
      content: "second answer",
    });
    expect(sent.messages.at(-1)).toEqual({
      role: "user",
      content: "summarize this history",
    });
    expect(sent.provider).toBe("nvidia");
    expect(sent.model).toBe("test-model");
    expect(sent.temperature).toBe(0.6);
    expect(sent.thinking).toEqual({ enabled: true, effort: "high" });
    expect(sent.toolChoice).toBe("auto");
    expect(sent.parallelToolCalls).toBe(true);
    expect(sent.tools).toHaveLength(1);
  });

  it("fails closed with CompactionOverLimitError when the replay cannot fit", async () => {
    await expect(
      executeCompactionSummary(
        baseExecution({
          baseRequest,
          history: baseRequest.messages,
          contextLimitTokens: 8,
        }),
      ),
    ).rejects.toBeInstanceOf(CompactionOverLimitError);
    expect(complete).not.toHaveBeenCalled();
  });

  it("plans the replay and reports fit against the effective safe limit", () => {
    const plan = planCompactionReplay({
      baseRequest,
      history: [
        ...baseRequest.messages,
        { role: "assistant" as const, content: "second answer" },
      ],
      prompt: "summarize this history",
      maxTokens: 4096,
      contextLimitTokens: 1_000_000,
    });
    expect(plan).toBeDefined();
    expect(plan!.accounting.overLimit).toBe(false);
    expect(plan!.messages.slice(0, baseRequest.messages.length)).toEqual(
      baseRequest.messages,
    );
    expect(plan!.messages.at(-1)).toEqual({
      role: "user",
      content: "summarize this history",
    });

    const tight = planCompactionReplay({
      baseRequest,
      history: baseRequest.messages,
      prompt: "summarize this history",
      maxTokens: 4096,
      contextLimitTokens: 8,
    });
    expect(tight!.accounting.overLimit).toBe(true);

    // A snapshot whose head no longer matches the live history is not a
    // usable prefix base (provider/model switch, restore, prompt change).
    const mismatched = planCompactionReplay({
      baseRequest,
      history: [
        { role: "system" as const, content: "a different constitution" },
        ...baseRequest.messages.slice(1),
      ],
      prompt: "summarize this history",
      maxTokens: 4096,
    });
    expect(mismatched).toBeUndefined();
  });
});

describe("transient-error retry", () => {
  const retryableCases: Array<[string, unknown]> = [
    ["500 server error", Object.assign(new Error("upstream 500"), { status: 500 })],
    ["429 rate limit", Object.assign(new Error("rate limited"), { status: 429 })],
    // A gateway that returned HTTP 200 and then failed upstream mid-handoff.
    ["200 upstream error", Object.assign(new Error("Upstream error"), { status: 200 })],
    ["network reset", new Error("fetch failed: socket hang up")],
  ];

  it.each(retryableCases)("retries once on %s", async (_label, failure) => {
    complete
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(completion("## Work\nDone.\n## Remaining\nMore."));

    const visible = await executeCompactionSummary(
      baseExecution({ retryOnServerError: true, retryDelayMs: 0 }),
    );

    expect(visible).toContain("Done.");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["401 auth failure", Object.assign(new Error("auth failed"), { status: 401 })],
    ["403 forbidden", Object.assign(new Error("forbidden"), { status: 403 })],
  ])("does not retry %s", async (_label, failure) => {
    complete.mockRejectedValueOnce(failure);

    await expect(
      executeCompactionSummary(
        baseExecution({ retryOnServerError: true, retryDelayMs: 0 }),
      ),
    ).rejects.toThrow();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("does not retry the deterministic over-limit failure", async () => {
    await expect(
      executeCompactionSummary(
        baseExecution({
          retryOnServerError: true,
          retryDelayMs: 0,
          baseRequest: {
            provider: "nvidia",
            model: "test-model",
            messages: [
              { role: "system" as const, content: "stable constitution" },
              { role: "user" as const, content: "first user turn" },
            ],
          },
          history: [
            { role: "system" as const, content: "stable constitution" },
            { role: "user" as const, content: "first user turn" },
          ],
          contextLimitTokens: 8,
        }),
      ),
    ).rejects.toBeInstanceOf(CompactionOverLimitError);
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not retry aborts", async () => {
    const aborted = Object.assign(new Error("Aborted"), { name: "AbortError" });
    complete.mockRejectedValueOnce(aborted);

    await expect(
      executeCompactionSummary(
        baseExecution({ retryOnServerError: true, retryDelayMs: 0 }),
      ),
    ).rejects.toThrow(/aborted/i);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
