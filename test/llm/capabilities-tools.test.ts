import { describe, expect, it } from "vitest";
import {
  modelSupportsNativeTools,
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
});
