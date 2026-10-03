import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionRequest, ReasoningEffort } from "../../src/types.js";
import { codexProvider, resetCodexModelCache } from "../../src/llm/codex.js";
import { CODEX_API_BASE_URL, encodeCodexKey } from "../../src/llm/codex-auth.js";
import { isReasoningUnsupported, markReasoningUnsupported, registerWireRejectionEfforts, resetReasoningKnowledge } from "../../src/llm/capabilities.js";
import { tryCompleteOnce } from "../../src/llm/routing/attempt-complete.js";
import { tryStreamOnce } from "../../src/llm/routing/attempt-stream.js";
import { resolveBuiltInProfile } from "../../src/llm/provider-profiles.js";
import { completeWithProvider, streamWithProvider } from "../../src/llm/router.js";

vi.mock("../../src/store/keys.js", async (importActual) => ({
  ...await importActual<typeof import("../../src/store/keys.js")>(),
  getProviderKeys: async (provider: string) => ({
    keys: provider === "codex" ? [{ id: "fixture", value: auth.apiKey, createdAt: 0 }] : [],
    activeIndex: 0, source: "env" as const,
  }),
}));

const model = "gpt-6.1-sol";
const auth = { apiKey: encodeCodexKey({ accessToken: "fixture-token", accountId: "fixture-account" }) };
const supported: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
const modes = ["complete", "stream"] as const;
type Mode = typeof modes[number];
const output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] }];
let catalog: Record<string, unknown>;
let bodies: Record<string, unknown>[];
let response: (() => Response) | undefined;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function request(effort: ReasoningEffort = "high"): CompletionRequest {
  return {
    provider: "codex", model, purpose: "agent",
    messages: [{ role: "user", content: "Review the evidence." }],
    thinking: { enabled: true, effort },
  };
}

function dispatch(mode: Mode, input = request(), singleDispatch = false) {
  return mode === "complete"
    ? tryCompleteOnce(codexProvider, "codex", input, input.model!, auth, "initial", undefined, singleDispatch)
    : tryStreamOnce(codexProvider, "codex", input, input.model!, auth, () => {}, undefined, "initial", singleDispatch);
}

beforeEach(async () => {
  resetCodexModelCache();
  resetReasoningKnowledge();
  catalog = {
    slug: model, supported_reasoning_levels: supported.map((effort) => ({ effort })),
    default_reasoning_level: "low", default_reasoning_summary: "none",
    supports_reasoning_summary_parameter: true,
  };
  bodies = [];
  response = undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("/models?")) return json({ models: [catalog] });
    expect(String(url)).toBe(`${CODEX_API_BASE_URL}/responses`);
    expect(init?.method).toBe("POST");
    bodies.push(JSON.parse(String(init?.body)));
    return response?.() ?? json({ status: "completed", output });
  }));
  await codexProvider.listModels!(auth);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetCodexModelCache();
  resetReasoningKnowledge();
});

describe.each(modes)("ChatGPT %s effort on the HTTP wire", (mode) => {
  it("keeps high through the public router and HTTP transport", async () => {
    const options = { maxRetries: 0, allowProviderFallback: false, adoptFallback: false };
    const result = mode === "complete"
      ? await completeWithProvider(request(), options)
      : await streamWithProvider(request(), () => {}, options);
    expect(result.text).toBe("Done.");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  it("keeps high through a public-router server retry", async () => {
    response = () => bodies.length === 1 ? new Response(JSON.stringify({ error: {
      message: "Server error while processing reasoning",
    } }), { status: 503, headers: { "content-type": "application/json", "retry-after": "0.001" } })
      : json({ status: "completed", output });
    const options = { maxRetries: 1, allowProviderFallback: false, adoptFallback: false };
    const result = mode === "complete"
      ? await completeWithProvider(request(), options)
      : await streamWithProvider(request(), () => {}, options);
    expect(result.text).toBe("Done.");
    expect(bodies.map((body) => body.reasoning)).toEqual([
      { effort: "high", summary: "auto" }, { effort: "high", summary: "auto" },
    ]);
  });

  it.each(supported)("serializes supported %s literally using the Responses schema", async (effort) => {
    expect((await dispatch(mode, request(effort))).text).toBe("Done.");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.reasoning).toEqual({ effort, summary: "auto" });
    expect(bodies[0]?.stream).toBe(true);
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
    expect(bodies[0]).not.toHaveProperty("thinking");
    expect(bodies[0]).not.toHaveProperty("temperature");
    expect(bodies[0]).not.toHaveProperty("max_output_tokens");
  });

  it.each([false, true])("keeps high for compaction with Responses Lite=%s", async (lite) => {
    catalog.use_responses_lite = lite;
    resetCodexModelCache();
    await codexProvider.listModels!(auth);
    expect((await dispatch(mode, { ...request(), purpose: "compaction" }, true)).text).toBe("Done.");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.reasoning).toEqual({ effort: "high", summary: "auto", ...(lite ? { context: "all_turns" } : {}) });
  });

  it("keeps high when the model rejects summary parameters in its catalog", async () => {
    catalog.supports_reasoning_summary_parameter = false;
    resetCodexModelCache();
    await codexProvider.listModels!(auth);
    await dispatch(mode);
    expect(bodies[0]?.reasoning).toEqual({ effort: "high" });
  });

  it("sends only the selected effort before discovering a new model's catalog", async () => {
    catalog.slug = "new-chatgpt-model";
    catalog.supported_reasoning_levels = supported;
    resetCodexModelCache();
    resetReasoningKnowledge();
    await dispatch(mode, { ...request(), model: "new-chatgpt-model" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.model).toBe("new-chatgpt-model");
    expect(bodies[0]?.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  it("uses the current account catalog despite previously learned control rejections", async () => {
    markReasoningUnsupported("codex", model);
    registerWireRejectionEfforts("codex", model, ["low", "medium"]);
    await dispatch(mode);
    expect(bodies[0]?.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  it.each([
    { status: 400, message: "Unsupported parameter: reasoning.summary" },
    { status: 400, message: "Unknown parameter: reasoning" },
    { status: 422, message: "Invalid request body" },
    { status: 500, message: "Server error while processing reasoning" },
  ])("preserves high when a request fails: $status/$message", async ({ status, message }) => {
    response = () => bodies.length === 1 ? json({ error: { message } }, status) : json({ status: "completed", output });
    await expect(dispatch(mode)).rejects.toMatchObject({ status });
    expect(bodies).toHaveLength(1);
    expect(isReasoningUnsupported("codex", model)).toBe(false);
    await dispatch(mode);
    expect(bodies.map((body) => body.reasoning)).toEqual([
      { effort: "high", summary: "auto" }, { effort: "high", summary: "auto" },
    ]);
  });

  it("retains high after a single-dispatch compaction rejection", async () => {
    response = () => bodies.length === 1
      ? json({ error: { message: "Unsupported parameter: reasoning.summary" } }, 400)
      : json({ status: "completed", output });
    await expect(dispatch(mode, { ...request(), purpose: "compaction" }, true)).rejects.toMatchObject({ status: 400 });
    expect(isReasoningUnsupported("codex", model)).toBe(false);
    await dispatch(mode);
    expect(bodies.map((body) => body.reasoning)).toEqual([
      { effort: "high", summary: "auto" }, { effort: "high", summary: "auto" },
    ]);
  });

  it("retains high during recovery from rejected encrypted reasoning", async () => {
    response = () => bodies.length === 1 ? json({ error: {
      code: "invalid_encrypted_content", message: "Encrypted content could not be verified",
    } }, 400) : json({ status: "completed", output });
    await dispatch(mode);
    expect(bodies).toHaveLength(2);
    expect(bodies.map((body) => body.reasoning)).toEqual([
      { effort: "high", summary: "auto" }, { effort: "high", summary: "auto" },
    ]);
  });

  it("retains high when reasoning replay is still rejected", async () => {
    response = () => json({ error: { message: "Missing reasoning_content must be sent back" } }, 400);
    await expect(dispatch(mode)).rejects.toMatchObject({ status: 400 });
    expect(bodies).toHaveLength(2);
    expect(bodies.map((body) => body.reasoning)).toEqual([
      { effort: "high", summary: "auto" }, { effort: "high", summary: "auto" },
    ]);
  });
});

it("declares the same nested reasoning dialect used on the Codex wire", () => {
  expect(resolveBuiltInProfile({ provider: "codex", model }).reasoning.control.dialect).toBe("openai-nested-reasoning");
});
