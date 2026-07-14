import { describe, expect, it } from "vitest";
import { inferProviderForModel } from "../src/repl/slash-commands.js";

describe("inferProviderForModel", () => {
  it("maps minimaxai/minimax-m3 to nvidia", () => {
    expect(inferProviderForModel("minimaxai/minimax-m3")).toBe("nvidia");
  });

  it("maps minimaxai/minimax-m2.7 to nvidia", () => {
    expect(inferProviderForModel("minimaxai/minimax-m2.7")).toBe("nvidia");
  });

  it("maps a gemini model to gemini", () => {
    expect(inferProviderForModel("gemini-3.5-flash")).toBe("gemini");
  });

  it("maps a groq model to groq", () => {
    expect(inferProviderForModel("llama-3.3-70b-versatile")).toBe("groq");
  });

  it("maps a kimchi model to kimchi", () => {
    expect(inferProviderForModel("kimi-k2.6")).toBe("kimchi");
  });

  it("maps a bynara model to bynara", () => {
    expect(inferProviderForModel("minimax-m3")).toBe("bynara");
  });

  it("returns undefined for an unknown model", () => {
    expect(inferProviderForModel("some-unknown-model-xyz")).toBeUndefined();
  });

  it("is case-insensitive", () => {
    expect(inferProviderForModel("MINIMAXAI/MINIMAX-M3")).toBe("nvidia");
  });
});
