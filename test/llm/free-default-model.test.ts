import { describe, expect, it } from "vitest";
import {
  pickFreeModel,
  resolveFreeDefaultModel,
} from "../../src/llm/free-default-model.js";
import { defaultModels } from "../../src/llm/provider.js";

describe("dynamic free default model", () => {
  it("prefers the canonical free default when the catalog offers it", () => {
    expect(
      pickFreeModel(["free-1/mimo-v2.5-free", defaultModels.free, "free-2/other:free"]),
    ).toBe(defaultModels.free);
  });

  it("falls back to a kilo-gateway model before an opencode-zen one", () => {
    expect(
      pickFreeModel(["free-1/mimo-v2.5-free", "free-2/stepfun/step-3.7-flash:free"]),
    ).toBe("free-2/stepfun/step-3.7-flash:free");
  });

  it("uses an opencode-zen model when the kilo gateway offers nothing", () => {
    expect(pickFreeModel(["free-1/mimo-v2.5-free"])).toBe("free-1/mimo-v2.5-free");
  });

  it("returns the built-in default for an empty or blank catalog", () => {
    expect(pickFreeModel([])).toBe(defaultModels.free);
    expect(pickFreeModel(["", "   "])).toBe(defaultModels.free);
  });

  it("always yields a prefixed free id that names a free source", async () => {
    const picked = await resolveFreeDefaultModel({
      listModels: async () => ["free-1/mimo-v2.5-free"],
    });
    expect(picked.startsWith("free-1/") || picked.startsWith("free-2/")).toBe(true);
  });

  it("never hangs when the catalog stalls", async () => {
    const picked = await resolveFreeDefaultModel({
      listModels: () => new Promise<string[]>(() => undefined),
      timeoutMs: 25,
    });
    expect(picked).toBe(defaultModels.free);
  });

  it("survives a catalog error without throwing", async () => {
    const picked = await resolveFreeDefaultModel({
      listModels: async () => {
        throw new Error("network down");
      },
    });
    expect(picked).toBe(defaultModels.free);
  });
});
