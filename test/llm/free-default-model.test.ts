import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pickFreeModel,
  resetFreeDefaultModelCache,
  resolveFreeDefaultModel,
} from "../../src/llm/free-default-model.js";
import { defaultModels } from "../../src/llm/provider.js";

describe("dynamic free default model", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetFreeDefaultModelCache();
  });

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

  it("re-resolves the remembered pick once it is older than 30 minutes", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("kilo.ai")) {
        return new Response(
          JSON.stringify({ data: [{ id: "stepfun/step-3.7-flash:free", isFree: true }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const time = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(time);
    const first = await resolveFreeDefaultModel();
    expect(first).toBe("free-2/stepfun/step-3.7-flash:free");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.spyOn(Date, "now").mockReturnValue(time + 10 * 60 * 1000);
    expect(await resolveFreeDefaultModel()).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.spyOn(Date, "now").mockReturnValue(time + 31 * 60 * 1000);
    expect(await resolveFreeDefaultModel()).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
