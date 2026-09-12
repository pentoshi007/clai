import { afterEach, describe, expect, it, vi } from "vitest";
import { agentrouterProvider } from "../../src/llm/agentrouter.js";
import type { LlmProvider } from "../../src/llm/provider.js";
import {
  clearLearnedVisionCapabilities,
  modelVisionSupport,
  registerModelVisionCapability,
  resetReasoningKnowledge,
} from "../../src/llm/capabilities.js";
import { ProviderError, toOpenAiMessages } from "../../src/llm/http.js";
import { requestForRoute } from "../../src/llm/routing/attempt-request.js";
import { tryCompleteOnce } from "../../src/llm/routing/attempt-complete.js";
import { tryStreamOnce } from "../../src/llm/routing/attempt-stream.js";
import { resetResponsesWireStatesForTesting } from "../../src/llm/wire/responses-first.js";
import {
  isImageInputUnsupportedError,
  stripImagesFromMessages,
} from "../../src/llm/wire/capability-errors.js";
import type { CompletionRequest, SuccessfulRequestSnapshot } from "../../src/types.js";
import { installTransport } from "../conformance/fake-transport.js";
import { buildWireResponse, jsonResponse } from "../conformance/wire-fixtures.js";

const model = "glm-5.3";
const rejection = "***.***.type 参数非法, 取值范围 ['text'] [trace_id=test]";
const request: CompletionRequest = {
  model,
  messages: [
    { role: "system", content: "Help with the project." },
    { role: "user", content: "Inspect the logo", images: [{ mediaType: "image/png", dataBase64: "aGVsbG8=" }] },
  ],
  thinking: { enabled: true, effort: "max" },
  tools: [
    { name: "image.view", wireName: "image_view", description: "View an image", parameters: { type: "object", properties: {} } },
    { name: "fs.read", wireName: "fs_read", description: "Read a file", parameters: { type: "object", properties: {} } },
  ],
  toolChoice: { type: "function", name: "image.view" },
};

async function establishChatRoute(): Promise<void> {
  installTransport(({ url }) => url.endsWith("/responses")
    ? jsonResponse({ error: { message: "not found" } }, 404)
    : buildWireResponse("chat_completions", "complete", "answer", model));
  await agentrouterProvider.complete({ model, messages: [{ role: "user", content: "hello" }] }, { apiKey: "test-key" });
}

afterEach(() => {
  clearLearnedVisionCapabilities();
  resetReasoningKnowledge();
  resetResponsesWireStatesForTesting();
  vi.unstubAllGlobals();
});

describe("image route compatibility", () => {
  it.each(["agentrouter", "aws-mantle", "explabs"] as const)("does not assume GLM-5 is multimodal on %s", (provider) => {
    expect(modelVisionSupport(provider, model)).toBe("no");
    expect(modelVisionSupport(provider, "glm-5.3-vision-exp")).toBe("yes");
    registerModelVisionCapability({ provider, model, vision: true });
    expect(modelVisionSupport(provider, model)).toBe("yes");
  });

  it.each(["glm-5p1", "glm-5p1-fast", "accounts/fireworks/models/glm-5p2"])("recognizes the text-only alias %s", (alias) => {
    expect(modelVisionSupport("fireworks", alias)).toBe("no");
  });

  it("projects old image history for a text route without destroying the original", () => {
    const original = structuredClone(request);
    const projected = requestForRoute(request, "agentrouter", model);
    expect(projected.messages[1]?.images).toBeUndefined();
    expect(projected.messages[1]?.content).toContain("Image input unavailable");
    expect(projected.tools?.map((tool) => tool.name)).toEqual(["fs.read"]);
    expect(projected.toolChoice).toBe("auto");
    expect(stripImagesFromMessages(projected.messages)).toEqual(projected.messages);
    expect(request).toEqual(original);
    expect(requestForRoute(request, "openai", "gpt-4o").messages[1]?.images).toEqual(original.messages[1]?.images);
    expect(toOpenAiMessages(request.messages, false)[1]?.content).toContain("Do not infer their contents");
  });

  it.each([400, 415, 422])("recognizes the AgentRouter text-only schema at HTTP %i", (status) => {
    expect(isImageInputUnsupportedError(new ProviderError("request failed", status, rejection))).toBe(true);
  });

  it.each([
    [500, rejection],
    [400, "Invalid tools[0].type: expected ['function']"],
    [400, "response_format.type must be one of ['text']"],
    [400, "Invalid parameter"],
  ])("does not misattribute unrelated failures: %i %s", (status, body) => {
    expect(isImageInputUnsupportedError(new ProviderError("request failed", Number(status), String(body)))).toBe(false);
  });

  it.each(["complete", "stream"] as const)("recovers the exact AgentRouter rejection once in %s mode without changing effort", async (mode) => {
    await establishChatRoute();
    registerModelVisionCapability({ provider: "agentrouter", model, vision: true });
    const original = structuredClone(request);
    const status = vi.fn();
    const snapshots: SuccessfulRequestSnapshot[] = [];
    const transport = installTransport(({ body }) => {
      if (JSON.stringify(body).includes("image_url")) {
        return jsonResponse({ error: { message: rejection, type: "invalid_request_error", param: "", code: null } }, 400);
      }
      return buildWireResponse("chat_completions", mode, "answer", model);
    });
    const run = (candidate: CompletionRequest, singleDispatch = false) => mode === "complete"
      ? tryCompleteOnce(agentrouterProvider, "agentrouter", candidate, model, { apiKey: "test-key" }, "initial", status, singleDispatch)
      : tryStreamOnce(agentrouterProvider, "agentrouter", candidate, model, { apiKey: "test-key" }, vi.fn(), status, "initial", singleDispatch, (snapshot) => snapshots.push(snapshot));

    const result = await run(request);
    expect(result.text).toBe("conformance answer");
    expect(transport.generations).toHaveLength(2);
    const first = transport.generations[0]?.body as Record<string, unknown>;
    const second = transport.generations[1]?.body as Record<string, unknown>;
    expect(transport.generations.every((generation) => generation.url.endsWith("/chat/completions"))).toBe(true);
    expect(JSON.stringify(first)).toContain("image_url");
    expect(JSON.stringify(second)).not.toContain("image_url");
    expect(JSON.stringify(second)).not.toContain('"name":"image_view"');
    expect(JSON.stringify(second)).toContain("Image input unavailable");
    for (const key of ["reasoning_effort", "thinking", "reasoning", "chat_template_kwargs"]) {
      expect(second[key]).toEqual(first[key]);
    }
    expect(status).toHaveBeenCalledOnce();
    expect(status.mock.calls[0]?.[0]).toContain("rejected image input");
    expect(modelVisionSupport("agentrouter", model)).toBe("no");
    expect(request).toEqual(original);
    if (mode === "stream") expect(snapshots[0]?.messages[1]?.images).toBeUndefined();

    await run(request);
    expect(transport.generations).toHaveLength(3);
    expect(modelVisionSupport("agentrouter", model)).toBe("no");
  });

  it.each(["complete", "stream"] as const)("respects single-dispatch policy on image rejection in %s", async (mode) => {
    await establishChatRoute();
    registerModelVisionCapability({ provider: "agentrouter", model, vision: true });
    const transport = installTransport(() => jsonResponse({ error: { message: rejection } }, 400));
    const pending = mode === "complete"
      ? tryCompleteOnce(agentrouterProvider, "agentrouter", request, model, { apiKey: "test-key" }, "initial", vi.fn(), true)
      : tryStreamOnce(agentrouterProvider, "agentrouter", request, model, { apiKey: "test-key" }, vi.fn(), vi.fn(), "initial", true);
    await expect(pending).rejects.toThrow(/取值范围/);
    expect(transport.generations).toHaveLength(1);
    expect(modelVisionSupport("agentrouter", model)).toBe("no");
  });

  it("never retries or changes capability after a stream already emitted output", async () => {
    registerModelVisionCapability({ provider: "agentrouter", model, vision: true });
    const failure = new ProviderError("request failed", 400, rejection);
    const stream = vi.fn<NonNullable<LlmProvider["stream"]>>(async (_request, _auth, emit) => {
      emit("partial answer");
      throw failure;
    });
    const status = vi.fn();
    await expect(tryStreamOnce(
      { ...agentrouterProvider, stream }, "agentrouter", request, model,
      { apiKey: "test-key" }, vi.fn(), status, "initial",
    )).rejects.toThrow(failure);
    expect(stream).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
    expect(modelVisionSupport("agentrouter", model)).toBe("yes");
  });
});
