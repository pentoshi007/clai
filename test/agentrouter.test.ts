import { describe, expect, it } from "vitest";
import { agentrouterProvider } from "../src/llm/agentrouter.js";
import { providers } from "../src/llm/router.js";
import { providerCategory } from "../src/store/config.js";
import {
  defaultModels,
  envVars,
  normalizeProvider,
} from "../src/llm/provider.js";
import { providerIds } from "../src/types.js";
import { modelSupportsThinking } from "../src/llm/capabilities.js";

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

  it("uses claude-haiku-4-5 as the default model", () => {
    expect(defaultModels.agentrouter).toBe("claude-haiku-4-5-20251001");
    expect(agentrouterProvider.defaultModel).toBe("claude-haiku-4-5-20251001");
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
});
