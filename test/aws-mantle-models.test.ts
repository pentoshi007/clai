import { afterEach, describe, expect, it, vi } from "vitest";
import { mantleProvider } from "../src/llm/aws-mantle.js";

describe("AWS Mantle model discovery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts the models response shape used by Mantle deployments", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      models: [{ id: "anthropic.claude-sonnet-4-6" }, "anthropic.claude-haiku-4-5"],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(mantleProvider.listModels?.({ apiKey: "test-key" })).resolves.toEqual([
      "anthropic.claude-haiku-4-5",
      "anthropic.claude-sonnet-4-6",
    ]);
  });
});
