import { describe, expect, it } from "vitest";
import { getDefaultModel, normalizeProvider } from "../src/llm/provider.js";
import { providers } from "../src/llm/routing/provider-selection.js";
import { resolveProviderCategory } from "../src/store/config.js";
import { modelContextWindow } from "../src/llm/context-windows.js";

describe("Omnirush provider registration", () => {
  it("is a first-class provider in the registry", () => {
    expect(providers.omnirush).toBeDefined();
    expect(providers.omnirush.id).toBe("omnirush");
    expect(providers.omnirush.displayName).toBe("Omnirush");
  });

  it("resolves canonical id and aliases", () => {
    expect(normalizeProvider("omnirush")).toBe("omnirush");
    expect(normalizeProvider("OMNI")).toBe("omnirush");
    expect(normalizeProvider("omnirush-ai")).toBe("omnirush");
    expect(normalizeProvider("omni-rush")).toBe("omnirush");
  });

  it("defaults to gpt-6-astra and is classed free-cloud", () => {
    expect(getDefaultModel("omnirush")).toBe("gpt-6-astra");
    expect(resolveProviderCategory("omnirush")).toBe("free-cloud");
  });

  it("resolves a 400k context window for gpt-6 models", () => {
    expect(modelContextWindow("gpt-6-astra", "omnirush")).toBe(400_000);
    expect(modelContextWindow("gpt-6-sol", "omnirush")).toBe(400_000);
  });
});
