import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freeProvider } from "../../src/llm/free.js";
import {
  displayReasoningEfforts,
  effectiveThinkingEffort,
  registerRouteAcceptedEfforts,
  resetReasoningKnowledge,
} from "../../src/llm/capabilities.js";
import { ingestModelCatalogEntries } from "../../src/llm/wire/model-catalog.js";

const messages = [{ role: "user" as const, content: "hi" }];

function responsesMock() {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        status: "completed",
        output: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "pondering" }],
          },
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

async function kiloResponsesEffort(model: string, effort: "xhigh" | "max") {
  const fetchMock = responsesMock();
  vi.stubGlobal("fetch", fetchMock);
  await freeProvider.complete(
    { model, messages, thinking: { enabled: true, effort } },
    {},
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

describe("MiniMax M3 documented effort contract", () => {
  it("caps the free-gateway M3 vocabulary at the documented high", () => {
    expect(displayReasoningEfforts("free", "minimax/minimax-m3:free")).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(
      effectiveThinkingEffort("free", "minimax/minimax-m3:free", {
        enabled: true,
        effort: "xhigh",
      }),
    ).toBe("high");
  });

  it("keeps the broad gateway vocabulary for non-M3 free models", () => {
    const efforts = displayReasoningEfforts("free", "openrouter/free");
    expect(efforts).toContain("xhigh");
    expect(
      effectiveThinkingEffort("free", "openrouter/free", {
        enabled: true,
        effort: "xhigh",
      }),
    ).toBe("xhigh");
  });

  it("lets learned route efforts override the documented contract", () => {
    registerRouteAcceptedEfforts("free", "minimax/minimax-m3:free", [
      "low",
      "medium",
    ]);
    expect(displayReasoningEfforts("free", "minimax/minimax-m3:free")).toEqual([
      "low",
      "medium",
    ]);
  });

  it("lets catalog-advertised efforts override the documented contract", async () => {
    ingestModelCatalogEntries("free", [
      {
        id: "minimax/minimax-m3:free",
        reasoning: {
          supported: true,
          supported_efforts: ["low", "medium", "high", "xhigh"],
        },
      },
    ]);
    expect(displayReasoningEfforts("free", "minimax/minimax-m3:free")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    const body = await kiloResponsesEffort(
      "free-2/minimax/minimax-m3:free",
      "xhigh",
    );
    expect(body.reasoning?.effort).toBe("xhigh");
  });

  it("sends high on the Kilo Responses wire when xhigh is requested", async () => {
    const body = await kiloResponsesEffort(
      "free-2/minimax/minimax-m3:free",
      "xhigh",
    );
    expect(body.reasoning?.effort).toBe("high");
    expect(body.reasoning?.summary).toBe("detailed");
  });

  it("sends high on the Kilo Responses wire when max is requested", async () => {
    const body = await kiloResponsesEffort(
      "free-2/minimax/minimax-m3:free",
      "max",
    );
    expect(body.reasoning?.effort).toBe("high");
  });

  it("still forwards xhigh for free models outside the M3 contract", async () => {
    const body = await kiloResponsesEffort("free-2/openrouter/free", "xhigh");
    expect(body.reasoning?.effort).toBe("xhigh");
  });
});
