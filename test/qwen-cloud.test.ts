import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelContextWindow, modelMaxOutputTokens } from "../src/llm/context-windows.js";
import {
  qwenCloudProvider,
  resetQwenCloudModelCatalogCache,
} from "../src/llm/qwen-cloud.js";
import { fetchDashScopeModelCatalog } from "../src/llm/wire/dashscope-model-catalog.js";

describe("Qwen Cloud provider", () => {
  beforeEach(() => resetQwenCloudModelCatalogCache());
  afterEach(() => {
    vi.restoreAllMocks();
    resetQwenCloudModelCatalogCache();
  });

  it("accepts Qwen Cloud API keys", () => {
    expect(qwenCloudProvider.validateKey("sk-ws-H.XHHPXR.testkey123")).toBe(true);
    expect(qwenCloudProvider.validateKey("qwen-testkey123")).toBe(false);
  });

  it("discovers models from the OpenAI-compatible models endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: "qwen3.7-plus" }, { id: "qwen3.6-flash" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      qwenCloudProvider.listModels?.({ apiKey: "sk-qwen-testkey123" }),
    ).resolves.toEqual(["qwen3.6-flash", "qwen3.7-plus"]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
    );
  });

  it("ingests official context limits from the paginated DashScope model catalog", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ data: [{ id: "qwen3.8-max-test" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          output: {
            total: 1,
            page_no: 1,
            page_size: 100,
            models: [{
              model: "qwen3.8-max-test",
              model_info: {
                context_window: 1_048_576,
                max_input_tokens: 1_032_192,
                max_output_tokens: 65_536,
              },
            }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));

    await qwenCloudProvider.listModels?.({ apiKey: "sk-qwen-testkey123" });

    expect(modelContextWindow("qwen3.8-max-test", "qwen-cloud")).toBe(1_048_576);
    expect(modelMaxOutputTokens("qwen-cloud", "qwen3.8-max-test")).toBe(65_536);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/api/v1/models");
  });

  it("paginates the DashScope metadata endpoint by page number", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      model: `dashscope-page-one-${index}`,
      model_info: { context_window: 128_000 },
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: { total: 101, page_no: 1, page_size: 100, models: firstPage },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: {
          total: 101,
          page_no: 2,
          page_size: 100,
          models: [{ model: "dashscope-page-two", model_info: { context_window: 256_000 } }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } }));

    const entries = await fetchDashScopeModelCatalog("sk-qwen-testkey123");

    expect(entries).toHaveLength(101);
    expect(entries[100]?.context_window).toBe(256_000);
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get("page_no")).toBe("2");
  });
});
