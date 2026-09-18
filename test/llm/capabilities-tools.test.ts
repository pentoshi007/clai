import { describe, expect, it } from "vitest";
import {
  clearModelCatalogFacts,
  modelSupportsNativeTools,
  registerModelCatalogFacts,
  resolveToolDialect,
} from "../../src/llm/capabilities.js";
import { clearTextOnlyModels, markTextOnlyModel } from "../../src/llm/tool-protocol.js";

describe("resolveToolDialect", () => {
  it("maps providers to dialects", () => {
    expect(resolveToolDialect("openai", "gpt-4o", "auto")).toBe("openai");
    expect(resolveToolDialect("anthropic", "claude-3-5-haiku", "auto")).toBe(
      "anthropic",
    );
    expect(resolveToolDialect("gemini", "gemini-2.5-flash", "auto")).toBe(
      "gemini",
    );
    expect(resolveToolDialect("ollama", "llama3.1:8b", "auto")).toBe("ollama");
  });

  it("aws-mantle picks anthropic for claude models", () => {
    expect(
      resolveToolDialect("aws-mantle", "anthropic.claude-haiku-4-5", "auto"),
    ).toBe("anthropic");
    expect(resolveToolDialect("aws-mantle", "openai/gpt-oss-20b", "auto")).toBe(
      "openai",
    );
  });

  it("toolCalling text forces none", () => {
    expect(resolveToolDialect("openai", "gpt-4o", "text")).toBe("none");
  });

  it("sticky text-only disables native", () => {
    clearTextOnlyModels();
    markTextOnlyModel("nvidia", "some-model");
    expect(modelSupportsNativeTools("nvidia", "some-model", "auto")).toBe(false);
    clearTextOnlyModels();
  });

  it("resolves to none when model catalog facts omit tools parameter", () => {
    registerModelCatalogFacts("openrouter", {
      id: "z-ai/glm-5.2:free",
      acceptedParameters: ["temperature", "top_p"],
    });
    expect(resolveToolDialect("openrouter", "z-ai/glm-5.2:free", "auto")).toBe("none");
    expect(modelSupportsNativeTools("openrouter", "z-ai/glm-5.2:free", "auto")).toBe(false);

    registerModelCatalogFacts("openrouter", {
      id: "openai/gpt-4o",
      acceptedParameters: ["temperature", "tools", "tool_choice"],
    });
    expect(resolveToolDialect("openrouter", "openai/gpt-4o", "auto")).toBe("openai");
    clearModelCatalogFacts();
  });

  it("does not gate non-openrouter models by acceptedParameters", () => {
    registerModelCatalogFacts("explabs", {
      id: "gpt-5.6-luna",
      acceptedParameters: ["reasoning_effort", "reasoning"],
    });
    expect(resolveToolDialect("explabs", "gpt-5.6-luna", "auto")).toBe("openai");
    expect(modelSupportsNativeTools("explabs", "gpt-5.6-luna", "auto")).toBe(true);
    clearModelCatalogFacts();
  });
});
