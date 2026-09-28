import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metaProvider } from "../../src/llm/meta.js";
import {
  metaAcceptedEfforts,
  metaReasoningEffort,
  metaSupportsMaxEffort,
} from "../../src/llm/meta-effort.js";
import { resetReasoningKnowledge } from "../../src/llm/capabilities.js";

const messages = [{ role: "user" as const, content: "hi" }];

function responsesMock() {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hi there" }],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

async function metaWireEffort(model: string, effort: string) {
  const fetchMock = responsesMock();
  vi.stubGlobal("fetch", fetchMock);
  await metaProvider.complete(
    { model, messages, thinking: { enabled: true, effort: effort as never } },
    { apiKey: "test-key-12345" },
  );
  const request = fetchMock.mock.calls[0]![1] as RequestInit;
  return JSON.parse(String(request.body)) as {
    reasoning?: { effort?: string; summary?: string };
  };
}

beforeEach(() => {
  resetReasoningKnowledge();
});

afterEach(() => {
  resetReasoningKnowledge();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Meta reasoning effort mapping (docs: dev.meta.ai/docs/reasoning)", () => {
  it("passes max through unchanged on Standard-tier muse-spark-1.3", () => {
    expect(metaReasoningEffort("max", "muse-spark-1.3")).toBe("max");
    expect(metaSupportsMaxEffort("muse-spark-1.3")).toBe(true);
  });

  it("clamps max to xhigh on Contributor-tier and older models", () => {
    expect(metaReasoningEffort("max", "muse-spark-1.3-contributor")).toBe("xhigh");
    expect(metaReasoningEffort("max", "muse-spark-1.2")).toBe("xhigh");
    expect(metaReasoningEffort("max", "muse-spark-1.1")).toBe("xhigh");
    expect(metaSupportsMaxEffort("muse-spark-1.3-contributor")).toBe(false);
  });

  it("maps none to minimal (Muse Spark rejects none) and preserves the rest", () => {
    expect(metaReasoningEffort("none", "muse-spark-1.3")).toBe("minimal");
    for (const effort of ["minimal", "low", "medium", "high", "xhigh"]) {
      expect(metaReasoningEffort(effort, "muse-spark-1.3")).toBe(effort);
    }
  });

  it("advertises max only where the API accepts it", () => {
    expect(metaAcceptedEfforts("muse-spark-1.3")).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(metaAcceptedEfforts("muse-spark-1.3-contributor")).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("sends effort:max on the wire for Standard-tier muse-spark-1.3", async () => {
    const body = await metaWireEffort("muse-spark-1.3", "max");
    expect(body.reasoning?.effort).toBe("max");
    expect(body.reasoning?.summary).toBe("detailed");
  });

  it("sends effort:xhigh on the wire for Contributor-tier max", async () => {
    const body = await metaWireEffort("muse-spark-1.3-contributor", "max");
    expect(body.reasoning?.effort).toBe("xhigh");
  });
});
