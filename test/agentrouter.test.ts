import { describe, expect, it, vi, afterEach } from "vitest";
import {
  agentrouterProvider,
  responsesFirstForModel,
} from "../src/llm/agentrouter.js";
import { installTransport } from "./conformance/fake-transport.js";
import { jsonResponse } from "./conformance/wire-fixtures.js";
import { providers } from "../src/llm/router.js";
import { providerCategory } from "../src/store/config.js";
import {
  defaultModels,
  envVars,
  normalizeProvider,
} from "../src/llm/provider.js";
import { providerIds } from "../src/types.js";
import { modelSupportsThinking } from "../src/llm/capabilities.js";
import {
  createReasoningArtifact,
  createReasoningArtifactProvenance,
} from "../src/llm/reasoning-artifacts.js";

describe("agentrouter provider", () => {
  it("is registered as a known provider id", () => {
    expect(providerIds).toContain("agentrouter");
    expect(providers.agentrouter).toBe(agentrouterProvider);
  });

  it("normalizes friendly aliases to the canonical id", () => {
    expect(normalizeProvider("agentrouter")).toBe("agentrouter");
    expect(normalizeProvider("agent-router")).toBe("agentrouter");
    expect(normalizeProvider("router")).toBe("agentrouter");
  });

  it("uses claude-opus-4-6 as the default model", () => {
    expect(defaultModels.agentrouter).toBe("claude-opus-4-6");
    expect(agentrouterProvider.defaultModel).toBe("claude-opus-4-6");
  });

  it("reads AGENTROUTER_API_KEY from the environment", () => {
    expect(envVars.agentrouter).toBe("AGENTROUTER_API_KEY");
    expect(agentrouterProvider.envVar).toBe("AGENTROUTER_API_KEY");
  });

  it("validates sk- shaped tokens issued by the AgentRouter console", () => {
    expect(agentrouterProvider.validateKey("sk-abcdef1234567890")).toBe(true);
    expect(agentrouterProvider.validateKey("nvapi-abcdef1234567890")).toBe(false);
    expect(agentrouterProvider.validateKey("sk")).toBe(false);
  });

  it("is classified as a paid-cloud provider so freeOnly mode skips it", () => {
    expect(providerCategory.agentrouter).toBe("paid-cloud");
  });

  it("flags reasoning capability for the routed frontier models", () => {
    expect(modelSupportsThinking("agentrouter", "gpt-5")).toBe(true);
    expect(modelSupportsThinking("agentrouter", "claude-opus-4-6")).toBe(true);
    expect(modelSupportsThinking("agentrouter", "deepseek-v4-pro")).toBe(true);
    expect(modelSupportsThinking("agentrouter", "glm-4.6")).toBe(true);
  });

  it("routes chat-native reasoning families to chat-completions, gpt-5/o-series to responses", () => {
    expect(responsesFirstForModel("deepseek-v4-flash")).toBe(false);
    expect(responsesFirstForModel("deepseek-v4-pro")).toBe(false);
    expect(responsesFirstForModel("glm-4.6")).toBe(false);
    expect(responsesFirstForModel("glm-5.3")).toBe(false);
    expect(responsesFirstForModel("claude-opus-4-6")).toBe(false);
    expect(responsesFirstForModel("gpt-5")).toBe(true);
    expect(responsesFirstForModel("gpt-5.1")).toBe(true);
    expect(responsesFirstForModel("o3")).toBe(true);
    expect(responsesFirstForModel("agentrouter/gpt-5")).toBe(true);
  });

  describe("wire routing", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const chatChunk = (content: string): string =>
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join("");

    function sse(text: string): Response {
      return new Response(text, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }

    it("streams deepseek over chat-completions, not responses", async () => {
      const transport = installTransport(() => sse(chatChunk("ok")));

      await agentrouterProvider.stream!(
        {
          model: "deepseek-v4-flash",
          messages: [{ role: "user", content: "hi" }],
          thinking: { enabled: true, effort: "high" },
        },
        { apiKey: "sk-testkey000000000000" },
        () => {},
      );

      const urls = transport.generations.map((request) => request.url);
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.every((url) => url.includes("/chat/completions"))).toBe(true);
      expect(urls.some((url) => url.includes("/responses"))).toBe(false);
    });

    it("streams glm over chat-completions, not responses", async () => {
      const transport = installTransport(() => sse(chatChunk("ok")));

      await agentrouterProvider.stream!(
        {
          model: "glm-5.3",
          messages: [{ role: "user", content: "hi" }],
          thinking: { enabled: true, effort: "high" },
        },
        { apiKey: "sk-testkey000000000000" },
        () => {},
      );

      const urls = transport.generations.map((request) => request.url);
      expect(urls.every((url) => url.includes("/chat/completions"))).toBe(true);
    });

    it("echoes prior reasoning_content on a deepseek tool turn", async () => {
      const provenance = createReasoningArtifactProvenance({
        provider: "agentrouter",
        model: "deepseek-v4-flash",
        dialect: "openai-compatible",
        endpoint: "https://agentrouter.org/v1",
      });
      const transport = installTransport(() =>
        jsonResponse({
          choices: [{ message: { content: "summary" }, finish_reason: "stop" }],
        }),
      );

      await agentrouterProvider.complete(
        {
          model: "deepseek-v4-flash",
          thinking: { enabled: true, effort: "high" },
          tools: [
            { name: "fs.read", wireName: "fs_read", description: "Read a file", parameters: { type: "object", properties: {} } },
          ],
          messages: [
            { role: "user", content: "read the file" },
            {
              role: "assistant",
              content: "",
              toolCalls: [
                { id: "call_1", name: "fs.read", arguments: { path: "a.txt" } },
              ],
              reasoningArtifacts: [
                createReasoningArtifact({
                  kind: "plaintext",
                  raw: "hidden chain of thought",
                  displaySummary: "hidden chain of thought",
                  provenance,
                  replay: { scope: "tool-turn", persistence: "tool-turn" },
                  position: { sequence: 1, placement: "before-tool-call", toolCallIndex: 0 },
                }),
              ],
            },
            { role: "tool", toolCallId: "call_1", name: "fs.read", content: "contents" },
            { role: "user", content: "now summarize it" },
          ],
        },
        { apiKey: "sk-test-key-1234" },
      );

      const body = transport.generations[0]!.body as Record<string, unknown>;
      const wire = body["messages"] as Array<Record<string, unknown>>;
      const assistant = wire.find(
        (entry) => entry["role"] === "assistant" && entry["tool_calls"] !== undefined,
      );
      expect(assistant).toHaveProperty("reasoning_content", "hidden chain of thought");
    });
  });
});
