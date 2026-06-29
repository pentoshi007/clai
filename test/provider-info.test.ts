import { describe, expect, it } from "vitest";
import { getProviderInfoText } from "../src/llm/provider.js";

describe("provider info command helper", () => {
  it("returns correct info for bynara", () => {
    const info = getProviderInfoText("bynara");
    expect(info).toContain("Current Plan");
    expect(info).toContain("Free");
    expect(info).toContain("7,000,000 remaining");
    expect(info).toContain("10 req/min");
  });

  it("returns 'no info available' when provider has no info set", () => {
    expect(getProviderInfoText("gemini")).toBe("no info available");
    expect(getProviderInfoText("openai")).toBe("no info available");
    expect(getProviderInfoText("ollama")).toBe("no info available");
  });

  it("is case insensitive", () => {
    const info1 = getProviderInfoText("ByNaRa");
    expect(info1).toContain("Current Plan");
  });
});
