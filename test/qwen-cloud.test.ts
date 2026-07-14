import { afterEach, describe, expect, it, vi } from "vitest";
import { qwenCloudProvider } from "../src/llm/qwen-cloud.js";

describe("Qwen Cloud provider", () => {
  afterEach(() => vi.restoreAllMocks());

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
});
